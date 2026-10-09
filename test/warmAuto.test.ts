import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readAutoWarmState, runWarmStep, startAutoWarm, type WarmJob } from "../src/warmAuto";
import { refreshCirculation } from "../src/circulation";
import { normTitle } from "../src/util";
import type { Env } from "../src/types";
import { makeIsbns } from "./helpers";

// ランキング集計のあとの自動暖機（src/warmAuto.ts）。キューは偽物に差し替えて、積まれた
// メッセージを手で 1 歩ずつ流す（本物の consumer は走らせない）。外部 API は叩かない:
// resolveCovers は取得元が無いので即「表紙なし」で確定する（test/circulation.test.ts と同じ）。

let sent: Array<{ body: WarmJob; delaySeconds?: number }> = [];
const fakeQueue = {
  async send(body: WarmJob, opts?: { delaySeconds?: number }) {
    sent.push({ body, delaySeconds: opts?.delaySeconds });
  },
} as unknown as Queue<WarmJob>;
const testEnv = (): Env => Object.assign(Object.create(env), { WARM_QUEUE: fakeQueue }) as Env;

async function seedSeries(id: string, name: string, volumes: number, base: number): Promise<string[]> {
  const isbns = makeIsbns(volumes, base);
  await env.DB.prepare(
    `INSERT INTO series (id, name, name_norm, creator, publisher, num_items) VALUES (?, ?, ?, '作者', '出版社', ?)`
  )
    .bind(id, name, normTitle(name), volumes)
    .run();
  await env.DB.batch(
    isbns.map((isbn, i) =>
      env.DB.prepare(
        `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title, creator, publisher)
         VALUES (?, ?, ?, ?, ?, '作者', '出版社')`
      ).bind(isbn, id, String(i + 1), i + 1, name)
    )
  );
  return isbns;
}

/** 積まれた歩を、無くなるまで（最大 n 歩）流す。 */
async function drain(e: Env, n = 50): Promise<number> {
  let steps = 0;
  while (sent.length && steps < n) {
    const { body } = sent.shift()!;
    await runWarmStep(e, body);
    steps++;
  }
  return steps;
}

beforeEach(async () => {
  sent = [];
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM circulation`),
    env.DB.prepare(`DELETE FROM circulation_link`),
    env.DB.prepare(`DELETE FROM volumes`),
    env.DB.prepare(`DELETE FROM series`),
    env.DB.prepare(`DELETE FROM covers`),
    env.DB.prepare(`DELETE FROM meta`),
  ]);
});

describe("自動暖機", () => {
  it("キューが無い環境では起動しない", async () => {
    const e = Object.assign(Object.create(env), { WARM_QUEUE: undefined }) as Env;
    expect(await startAutoWarm(e, "test")).toBe(false);
    expect(await readAutoWarmState(e)).toBeNull();
  });

  it("起動すると売上 → 発行部数の順に温め、終わったら完了にする", async () => {
    const isbns = await seedSeries("C1", "テスト作品A", 3, 1000);
    await env.DB.prepare(
      `INSERT INTO circulation (article, title_ja, title_en, author, publisher, copies, as_of, updated_at)
       VALUES ('a', 'テスト作品A', 'A', 'Author', 'Publisher', 100000000, '2026-01', 1)`
    ).run();
    await refreshCirculation(env as Env);

    const e = testEnv();
    expect(await startAutoWarm(e, "test")).toBe(true);
    expect(sent).toHaveLength(1);
    await drain(e);

    const state = await readAutoWarmState(e);
    expect(state?.state).toBe("done");
    expect(state?.cached).toBe(3);
    const warmed = await env.DB.prepare(`SELECT isbn FROM covers ORDER BY isbn`).all<{ isbn: string }>();
    expect(warmed.results?.map((x) => x.isbn)).toEqual([...isbns].sort());
  });

  it("起動し直すと、古い連鎖の歩は何もせずに止まる", async () => {
    await seedSeries("C1", "テスト作品A", 3, 2000);
    const e = testEnv();
    await startAutoWarm(e, "first");
    const stale = sent.shift()!.body;
    await startAutoWarm(e, "second");
    sent = [];

    await runWarmStep(e, stale);
    expect(sent).toHaveLength(0); // 次の歩を積まない
    expect((await readAutoWarmState(e))?.trigger).toBe("second");
  });
});
