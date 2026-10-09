import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { adminSalesSnapshot, workKey } from "../src/salesRanking";
import { readLinkHealth, runLinkHealthStep, startLinkHealth, type LinkHealthJob } from "../src/salesLinkHealth";
import type { Env } from "../src/types";
import { normTitle } from "../src/util";
import { makeIsbns } from "./helpers";

// 売上ランキングのリンク先の点検（src/salesLinkHealth.ts）。楽天の書名の巻数と、寄せ先の巻一覧の
// 巻を突き合わせる。キューは偽物に差し替え、積まれた歩を手で流す（test/warmAuto.test.ts と同じ）。

let sent: LinkHealthJob[] = [];
const fakeQueue = {
  async send(body: LinkHealthJob) {
    sent.push(body);
  },
} as unknown as Queue<LinkHealthJob>;
const testEnv = (): Env => Object.assign(Object.create(env), { WARM_QUEUE: fakeQueue }) as Env;

let base = 970000;
async function seedSeries(id: string, name: string, vols: number[], label = (n: number) => String(n)): Promise<void> {
  const isbns = makeIsbns(vols.length, base);
  base += vols.length;
  await env.DB.prepare(
    `INSERT INTO series (id, name, name_norm, creator, publisher, label, num_items) VALUES (?, ?, ?, '作者', '出版社', 'テストコミックス', ?)`
  )
    .bind(id, name, normTitle(name), vols.length)
    .run();
  await env.DB.batch(
    vols.map((n, i) =>
      env.DB.prepare(
        `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title, creator, publisher, label)
         VALUES (?, ?, ?, ?, ?, '作者', '出版社', 'テストコミックス')`
      ).bind(isbns[i], id, label(n), n, name)
    )
  );
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

beforeAll(async () => {
  await seedSeries("CLH001", "テスト粘体転生", range(1, 32)); // 楽天 33 巻 → 32 巻あれば正常
  await seedSeries("CLH002", "テスト短足", range(1, 20)); // 楽天 33 巻 → 足りない
  await seedSeries("CLH003", "テスト虫食い", [...range(1, 4), ...range(10, 33)]); // 5〜9 巻が抜け
  await seedSeries("CLH004", "テスト単巻", [1]); // 巻数の無い書名
  // 素の巻番号でない表記（黒執事の「1　／　Ⅰ」）は並び順のキーで数える
  const roman = ["Ⅰ", "Ⅱ", "Ⅲ"];
  await seedSeries("CLH005", "テスト執事", range(1, 10), (n) => (n <= 3 ? `${n}　／　${roman[n - 1]}` : String(n)));
  await seedSeries("CLH006", "テスト両抜け", [...range(1, 3), ...range(6, 20)]); // 4・5 巻と 21 巻以降が抜け
  const titles = [
    "テスト粘体転生（33）",
    "テスト短足 33",
    "テスト虫食い 33",
    "テスト単巻",
    "テスト執事(10)",
    "テスト両抜け 30",
    "テスト粘体転生（32）",
  ];
  const isbns = makeIsbns(titles.length, 990000);
  await env.DB.batch(
    titles.map((t, i) => {
      const work = t.replace(/[\s（]+\d+）?$/, "");
      return env.DB.prepare(
        `INSERT INTO sales_snapshot (day, rank, isbn, title, work, work_norm, author, publisher)
         VALUES ('2026-10-09', ?, ?, ?, ?, ?, '作者', '出版社')`
      ).bind(i + 1, isbns[i], t, work, workKey(work));
    })
  );
  await adminSalesSnapshot(env as unknown as Env, true); // 集計を作る（寄せ先は作品名で決まる）
});

describe("salesLinkHealth", () => {
  it("楽天の巻数に足りないリンク先だけを問題にする", async () => {
    const e = testEnv();
    sent = [];
    const started = await startLinkHealth(e, "test", true);
    expect(started.targets.map((t) => t.series_id)).toEqual(["CLH001", "CLH002", "CLH003", "CLH004", "CLH005", "CLH006"]);
    for (let i = 0; i < 10 && sent.length; i++) {
      const job = sent.shift()!;
      await runLinkHealthStep(e, job.run, true);
    }
    const s = (await readLinkHealth(e))!;
    expect(s.state).toBe("done");
    expect(s.cursor).toBe(6);
    const byId = Object.fromEntries(s.problems.map((p) => [p.series_id, p]));
    expect(byId.CLH002).toMatchObject({ kind: "short", expected: 33, have: 20, max_vol: 20 });
    expect(byId.CLH003).toMatchObject({ kind: "gaps", expected: 33, have: 28, missing: [5, 6, 7, 8, 9] });
    // 途中の抜けがあれば、新しい巻も無くても「途中の巻が抜けている」に入れる
    expect(byId.CLH006).toMatchObject({ kind: "gaps", expected: 30, have: 18, max_vol: 20 });
    // 途中の抜け（順位順）→ 新しい巻が無いだけ、の順に並ぶ
    expect(s.problems.map((p) => p.series_id)).toEqual(["CLH003", "CLH006", "CLH002"]);
    expect(s.new_problems).toBe(3);
  });

  it("前回と同じ問題は新しい問題に数えない", async () => {
    const e = testEnv();
    sent = [];
    await startLinkHealth(e, "test", true);
    while (sent.length) await runLinkHealthStep(e, sent.shift()!.run, true);
    const s = (await readLinkHealth(e))!;
    expect(s.problems).toHaveLength(3);
    expect(s.new_problems).toBe(0);
  });

  it("起動し直されたら古い run の歩は何もしない", async () => {
    const e = testEnv();
    sent = [];
    const a = await startLinkHealth(e, "test", true);
    const b = await startLinkHealth(e, "test", true);
    await runLinkHealthStep(e, a.run, true);
    const s = (await readLinkHealth(e))!;
    expect(s.run).toBe(b.run);
    expect(s.state).toBe("running");
    expect(s.cursor).toBe(0);
  });
});
