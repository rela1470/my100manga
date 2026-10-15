import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { computeSeriesStats } from "../src/seriesStats";
import { runSeriesStatsBatch, readStatsPass } from "../src/seriesList";
import { bumpViewEpoch } from "../src/viewSnapshot";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 巻数の集計（series_stats）: 巻一覧と同じ数え方の巻数を持ち、検索カード・シリーズ一覧
// （/series）・おまかせ埋めが読む。src/seriesStats.ts / src/seriesList.ts

const LOOSE = "C830001"; // 1・2 巻はひも付きあり、3 巻は series_id の無い迷子巻（巻一覧は書名で寄せる）
const BIG = "C830002"; // 5 巻（1〜5）
const GAP = "C830003"; // 1・2・4 巻（欠けあり）
const TIE = "C830004"; // 3 巻（LOOSE と同じ巻数）
const ABSORBED = "C830005"; // BIG に結合された側
const ISBNS = makeIsbns(20, 320000);

async function seedSeries(id: string, name: string, numItems: number) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, num_items) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, name, name, "作者", numItems)
    .run();
}
async function seedVolume(isbn: string, seriesId: string | null, vol: number, title: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, pubdate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, String(vol), vol, title, title, "作者", `20${10 + vol}-01`)
    .run();
}
async function get(path: string) {
  const res = await SELF.fetch(`https://example.com${path}`, { headers: { "user-agent": BROWSER_UA } });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}
async function statsRow(id: string) {
  return await env.DB.prepare(`SELECT * FROM series_stats WHERE series_id = ?`).bind(id).first<any>();
}

beforeAll(async () => {
  await seedSeries(LOOSE, "まいごしゅうけい", 2);
  await seedVolume(ISBNS[0], LOOSE, 1, "まいごしゅうけい");
  await seedVolume(ISBNS[1], LOOSE, 2, "まいごしゅうけい");
  await seedVolume(ISBNS[2], null, 3, "まいごしゅうけい");
  await seedSeries(BIG, "おおきいしゅうけい", 5);
  for (let i = 1; i <= 5; i++) await seedVolume(ISBNS[2 + i], BIG, i, "おおきいしゅうけい");
  await seedSeries(GAP, "かけしゅうけい", 3);
  for (const [i, v] of [[8, 1], [9, 2], [10, 4]]) await seedVolume(ISBNS[i], GAP, v, "かけしゅうけい");
  await seedSeries(TIE, "おなじしゅうけい", 3);
  for (let i = 1; i <= 3; i++) await seedVolume(ISBNS[10 + i], TIE, i, "おなじしゅうけい");
  await seedSeries(ABSORBED, "すわれしゅうけい", 2);
  for (let i = 1; i <= 2; i++) await seedVolume(ISBNS[13 + i], ABSORBED, i, "すわれしゅうけい");
  await env.DB.prepare(`INSERT OR REPLACE INTO series_merge (absorbed_id, target_id, created_at) VALUES (?, ?, ?)`)
    .bind(ABSORBED, BIG, Date.now())
    .run();
});

describe("computeSeriesStats", () => {
  it("巻数・1..n のそろい・先頭の巻・最新の発売日", () => {
    const s = computeSeriesStats([
      { isbn: "a", volume_number: "1", pubdate: "2020-01" },
      { isbn: "b", volume_number: "2", pubdate: "2021-05" },
    ]);
    expect(s).toEqual({ vol_count: 2, complete_run: 2, first_isbn: "a", last_pubdate: "2021-05" });
    expect(computeSeriesStats([{ isbn: "a", volume_number: "2" }]).complete_run).toBe(0);
  });
});

describe("巻一覧を開くと書かれ、検索カードの巻数がそれに揃う", () => {
  it("迷子巻を寄せた巻数（3）が、検索カードにも出る", async () => {
    // 集計が無い間は volumes 表だけを数える（2）。
    const before = await get(`/api/search?q=${encodeURIComponent("まいごしゅうけい")}`);
    expect(before.results.find((r: any) => r.series_id === LOOSE)?.volume_count).toBe(2);

    const vols = await get(`/api/series/${LOOSE}/volumes`);
    expect(vols.volumes).toHaveLength(3);
    const row = await statsRow(LOOSE);
    expect(row).toMatchObject({ vol_count: 3, complete_run: 3, first_isbn: ISBNS[0] });

    await bumpViewEpoch(env); // 検索結果のエッジキャッシュの鍵を替える
    const after = await get(`/api/search?q=${encodeURIComponent("まいごしゅうけい")}`);
    expect(after.results.find((r: any) => r.series_id === LOOSE)?.volume_count).toBe(3);
  });

  it("取り込み（imported_at）より古い集計は検索で使わない", async () => {
    await env.DB.prepare(`UPDATE series_stats SET computed_at = 1 WHERE series_id = ?`).bind(LOOSE).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_at', ?)`).bind(String(1000)).run();
    try {
      await bumpViewEpoch(env);
      const res = await get(`/api/search?q=${encodeURIComponent("まいごしゅうけい")}`);
      expect(res.results.find((r: any) => r.series_id === LOOSE)?.volume_count).toBe(2);
    } finally {
      await env.DB.prepare(`DELETE FROM meta WHERE key = 'imported_at'`).run();
    }
  });
});

describe("cron の数え直し（runSeriesStatsBatch）", () => {
  it("巻数の多いシリーズから順に埋め、1 周したら止まり、取り込み直しで頭からやり直す", async () => {
    const t0 = 10_000;
    let r = await runSeriesStatsBatch(env, t0, 2);
    expect(r).toMatchObject({ ran: 2, finished: false, idle: false });
    for (let i = 0; i < 10 && !r.finished; i++) r = await runSeriesStatsBatch(env, t0 + 1, 2);
    expect(r.finished).toBe(true);
    expect(await statsRow(BIG)).toMatchObject({ vol_count: 7 }); // 結合した側の 2 巻を含む
    expect(await statsRow(GAP)).toMatchObject({ vol_count: 3, complete_run: 0 });
    expect(await statsRow(ABSORBED)).toBeNull(); // 吸収された側には行を作らない

    expect(await runSeriesStatsBatch(env, t0 + 2, 2)).toMatchObject({ idle: true });

    await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_at', ?)`).bind(String(t0 + 5)).run();
    try {
      const again = await runSeriesStatsBatch(env, t0 + 10, 2);
      expect(again.idle).toBe(false);
      expect((await readStatsPass(env))?.started_at).toBe(t0 + 10);
    } finally {
      await env.DB.prepare(`DELETE FROM meta WHERE key = 'imported_at'`).run();
    }
  });
});

describe("GET /api/series-list", () => {
  it("巻数の多い順。同じ巻数は同じ順位、結合で吸収された側は出ない、続きは cursor で", async () => {
    const all: any[] = [];
    let cursor = "";
    for (let i = 0; i < 20; i++) {
      const page = await get(`/api/series-list${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      all.push(...page.entries);
      if (!page.next) break;
      cursor = page.next;
    }
    const mine = all.filter((e) => e.series_id.startsWith("C8300"));
    expect(mine.map((e) => e.series_id)).toEqual([BIG, LOOSE, GAP, TIE]); // 同じ巻数は id 順
    expect(mine.map((e) => e.vol_count)).toEqual([7, 3, 3, 3]);
    const rankOf = (id: string) => all.find((e) => e.series_id === id).rank;
    expect(rankOf(GAP)).toBe(rankOf(LOOSE));
    expect(rankOf(LOOSE)).toBe(rankOf(TIE));
    expect(all.find((e) => e.series_id === ABSORBED)).toBeUndefined();
    expect(mine.find((e) => e.series_id === LOOSE).complete).toBe(true);
    expect(mine.find((e) => e.series_id === GAP).complete).toBe(false);
  });
});
