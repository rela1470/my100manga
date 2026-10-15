import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { isCompleteRun, sizeOrder } from "../src/randomFill";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 残りの枠のおまかせ埋め（GET /api/random-fill, src/randomFill.ts）。1巻から最終巻まで欠けずに
// そろったシリーズだけを、合計がちょうど n 冊になるように選ぶ。

const FULL7 = "C810001"; // 1〜7 巻がそろっている
const GAP4 = "C810002"; // num_items は 4 だが 4 巻が無く 5 巻がある（欠けあり）
const FULL3 = "C810003"; // 1〜3 巻がそろっている
const FULL12 = "C810004"; // 1〜12 巻がそろっている（ちょうど 12 枠なら 1 本で埋まる）
const MISCOUNT = "C810005"; // 記録（num_items）は 9 だが、巻一覧は 1〜6 巻がそろっている（銀魂の 76 / 77 と同じ形）
const SINGLE = "C810006"; // 1 巻物（本番には 9 万本あり、組み合わせの最後は必ずこれで埋まる）
const ISBNS = makeIsbns(33, 310000);

async function seed(id: string, numItems: number, vols: number[], isbns: string[]) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, num_items) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, `おまかせ${id}`, `おまかせ${id}`, `おまかせ${id}`, "作者", numItems)
    .run();
  for (let i = 0; i < vols.length; i++) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(isbns[i], id, String(vols[i]), vols[i], `おまかせ${id}`, `おまかせ${id}`, "作者")
      .run();
  }
}

async function fill(query: string) {
  const res = await SELF.fetch(`https://example.com/api/random-fill?${query}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  await seed(FULL7, 7, [1, 2, 3, 4, 5, 6, 7], ISBNS.slice(0, 7));
  await seed(GAP4, 4, [1, 2, 3, 5], ISBNS.slice(7, 11));
  await seed(FULL3, 3, [1, 2, 3], ISBNS.slice(11, 14));
  await seed(FULL12, 12, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], ISBNS.slice(14, 26));
  await seed(MISCOUNT, 9, [1, 2, 3, 4, 5, 6], ISBNS.slice(26, 32));
  await seed(SINGLE, 1, [1], ISBNS.slice(32, 33));
});

describe("isCompleteRun", () => {
  const v = (...ns: string[]) => ns.map((n, i) => ({ volume_number: n, isbn: `x${i}` }));
  it("1..k が欠けなくそろっていれば true（表記ゆれも可）", () => {
    expect(isCompleteRun(v("1", "第2巻", "3"), 3)).toBe(true);
  });
  it("欠け・重複・巻数違いは false", () => {
    expect(isCompleteRun(v("1", "2", "4"), 3)).toBe(false);
    expect(isCompleteRun(v("1", "1", "2"), 3)).toBe(false);
    expect(isCompleteRun(v("1", "2"), 3)).toBe(false);
    expect(isCompleteRun(v("上", "下"), 2)).toBe(false);
  });
  it("1 巻物は巻番号が空でもよい", () => {
    expect(isCompleteRun(v(""), 1)).toBe(true);
    expect(isCompleteRun(v("2"), 1)).toBe(false);
  });
});

describe("sizeOrder", () => {
  it("大きい帯から並べ、1..rem-1 を 1 回ずつ含む", () => {
    const order = sizeOrder(12);
    expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(order.slice(0, 6).every((k) => k >= 6)).toBe(true);
    expect(order.slice(6, 8).every((k) => k >= 4 && k < 6)).toBe(true);
  });
});

describe("GET /api/random-fill", () => {
  it("1 本で埋まるシリーズがあればそれを選ぶ（組み合わせより優先）", async () => {
    // 12 = 7 + 3 + … の組み合わせでも埋まりうるが、1 本で埋まる FULL12 を必ず選ぶ。
    for (let i = 0; i < 5; i++) {
      const { body } = await fill("n=12");
      expect(body.series.map((s: any) => s.series_id)).toEqual([FULL12]);
    }
  });

  it("exclude で外したシリーズは選ばない（再抽選）", async () => {
    const { body } = await fill(`n=12&exclude=${FULL12}`);
    expect(body.series.map((s: any) => s.series_id)).not.toContain(FULL12);
  });

  it("巻数がちょうど n のシリーズがあれば 1 本で埋める", async () => {
    const { status, body } = await fill("n=7");
    expect(status).toBe(200);
    expect(body.filled).toBe(7);
    expect(body.series.map((s: any) => s.series_id)).toEqual([FULL7]);
    expect(body.series[0].volumes.map((x: any) => x.volume_number)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("無ければ複数のシリーズを足してちょうど n にする。欠けのあるシリーズは使わない", async () => {
    // 組み合わせは抽選しだい（7 + 3、6 + 3 + 1 …）なので、合計と「欠けのあるシリーズを使わない」だけを見る。
    for (let i = 0; i < 5; i++) {
      const { body } = await fill("n=10");
      expect(body.filled).toBe(10);
      expect(body.series.reduce((a: number, s: any) => a + s.volumes.length, 0)).toBe(10);
      expect(body.series.map((s: any) => s.series_id)).not.toContain(GAP4);
    }
  });

  it("リストに既にある本を含むシリーズは選ばない", async () => {
    const { body } = await fill(`n=7&have=${ISBNS[0]}`);
    expect(body.series.map((s: any) => s.series_id)).not.toContain(FULL7);
  });

  it("記録の巻数がずれていても、集計（series_stats）でそろっていると分かれば 1 本で埋める", async () => {
    // 集計が無い間は記録（9）でしか引けないので、ちょうど 6 の 1 本は見つからない（前のテストの
    // 抽選で巻一覧を開いていると集計が書かれているので、先に消す）。
    await env.DB.prepare(`DELETE FROM series_stats WHERE series_id = ?`).bind(MISCOUNT).run();
    // exclude を付けるのは、本棚が空の人向けのエッジ共有（下のテスト）を通さないため。
    expect((await fill("n=6&exclude=C000000")).body.series.map((s: any) => s.series_id)).not.toEqual([MISCOUNT]);
    // 巻一覧を開くと集計が書かれ（src/seriesStats.ts）、complete_run = 6 で引けるようになる。
    await SELF.fetch(`https://example.com/api/series/${MISCOUNT}/volumes`, { headers: { "user-agent": BROWSER_UA } });
    const { body } = await fill("n=6&exclude=C000000");
    expect(body.series.map((s: any) => s.series_id)).toEqual([MISCOUNT]);
  });

  it("本棚が空の人の抽選（have も exclude も無い）はエッジで共有し、同じ顔ぶれを返す", async () => {
    const a = await fill("n=10");
    const b = await fill("n=10");
    expect(b.body.series.map((s: any) => s.series_id)).toEqual(a.body.series.map((s: any) => s.series_id));
  });

  it("n は 1〜100", async () => {
    expect((await fill("n=0")).status).toBe(400);
    expect((await fill("n=101")).status).toBe(400);
  });
});
