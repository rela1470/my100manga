import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bumpViewEpoch } from "../src/viewSnapshot";
import { purgeSeriesVolumesCache } from "../src/series";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 巻一覧（GET /api/series/:id/volumes）はエッジ（Cache API）に短く持つ。1 回で D1 を 10 本ほど
// 引く一番重い閲覧系で、検索結果から開くたびに走るため。キーは シリーズ id + 表示データの世代
// （view_epoch）で、利用者の手動追加・補完取得の直後はその colo の分を消す（src/series.ts）。

const SERIES = "C800001";
const [ISBN1, ISBN2, ISBN3] = makeIsbns(3, 300000);

async function volumes(id = SERIES) {
  const res = await SELF.fetch(`https://example.com/api/series/${id}/volumes`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  // ブラウザには持たせない（エッジにだけ置く）。
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as { series_id: string; volumes: { isbn: string }[] };
}

async function addVolume(isbn: string, volume: number): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, SERIES, String(volume), volume, "キャッシュ試験", "キャッシュ試験", "作者")
    .run();
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(SERIES, "キャッシュ試験", "キャッシュ試験", "キャッシュ試験", "作者")
    .run();
  await addVolume(ISBN1, 1);
  // 手動追加は実在する書影を求めるので、表紙キャッシュを先に入れて外部 API を使わせない。
  await env.DB.prepare(`INSERT OR REPLACE INTO covers (isbn, cover_url, checked_at) VALUES (?, ?, ?)`)
    .bind(ISBN3, "https://books.google.com/books/content?id=x", Date.now())
    .run();
});

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM volumes WHERE isbn = ?`).bind(ISBN2).run();
  await env.DB.prepare(`DELETE FROM series_correction WHERE series_id = ?`).bind(SERIES).run();
  await purgeSeriesVolumesCache(env, SERIES);
});

describe("GET /api/series/:id/volumes のエッジキャッシュ", () => {
  it("同じシリーズの続く要求はキャッシュから返る", async () => {
    expect((await volumes()).volumes).toHaveLength(1);
    // D1 を直接変えてもキャッシュが効いている間は結果が変わらない（＝引き直していない）。
    await addVolume(ISBN2, 2);
    expect((await volumes()).volumes).toHaveLength(1);
    await purgeSeriesVolumesCache(env, SERIES);
    expect((await volumes()).volumes).toHaveLength(2);
  });

  it("管理者の変更（表示データの世代）でキーが変わる", async () => {
    expect((await volumes()).volumes).toHaveLength(1);
    await addVolume(ISBN2, 2);
    await bumpViewEpoch(env);
    expect((await volumes()).volumes).toHaveLength(2);
  });

  it("手動追加の直後は同じ colo では新しい内容が返る", async () => {
    expect((await volumes()).volumes).toHaveLength(1);
    const res = await SELF.fetch(`https://example.com/api/series/${SERIES}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
      body: JSON.stringify({ isbn: ISBN3, volume_number: "2" }),
    });
    expect(res.status).toBe(200);
    expect((await volumes()).volumes.map((v) => v.isbn)).toEqual([ISBN1, ISBN3]);
  });

  it("存在しないシリーズの 404 はキャッシュしない", async () => {
    const miss = async () =>
      (await SELF.fetch("https://example.com/api/series/C999999/volumes", { headers: { "user-agent": BROWSER_UA } })).status;
    expect(await miss()).toBe(404);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
    )
      .bind("C999999", "あとから", "あとから", "あとから", "作者")
      .run();
    await addVolumeFor("C999999");
    expect(await miss()).toBe(200);
  });
});

async function addVolumeFor(seriesId: string): Promise<void> {
  const [isbn] = makeIsbns(1, 310000);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, "1", 1, "あとから", "あとから", "作者")
    .run();
}
