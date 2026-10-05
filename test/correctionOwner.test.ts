import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ownersOfOtherSeries } from "../src/corrections";
import type { Env } from "../src/types";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 手動追加（POST /api/series/:id/corrections）の MASTER-KNOWN 規則。既に別のシリーズの巻として
// 登録されている ISBN は入れない（src/corrections.ts ownersOfOtherSeries）。
//
// 穴埋め（src/gapFill.ts）には前からある規則で、同じ出版社の別版は ISBN 接頭辞が共通のため
// 「その ISBN が既に別シリーズの巻か」が実質唯一の確実な判別になる。手動追加にだけ無かったので、
// C326076『釣りキチ三平』(講談社コミックス) の 12〜25 巻に KCスペシャル版（別シリーズ）の ISBN が
// 13 件入っていた。

const MINE = "C910001"; // 追加しようとしているシリーズ
const OTHER = "C910002"; // 別の版（別シリーズ）
const ABSORBED = "C910003"; // MINE に結合済み ＝ MINE と同じ単位
const SUPPLEMENTED = "C910004"; // 補完（series_supplement）でだけ巻を持つシリーズ

const [MINE_V1, MINE_NONUM, OTHER_V2, ABSORBED_V3, SUP_V4, FREE] = makeIsbns(6, 320000);

async function addVolume(isbn: string, seriesId: string, volume: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, volume, volume ? Number(volume) : 0, "規則試験", "規則試験", "作者")
    .run();
}

async function addCorrection(seriesId: string, isbn: string, volume: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/series/${seriesId}/corrections`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify({ isbn, volume_number: volume }),
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

beforeAll(async () => {
  for (const [id, name] of [
    [MINE, "規則試験"],
    [OTHER, "規則試験 文庫版"],
    [ABSORBED, "規則試験"],
    [SUPPLEMENTED, "規則試験 愛蔵版"],
  ]) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(id, name, name, name, "作者")
      .run();
  }
  await addVolume(MINE_V1, MINE, "1");
  // 巻番号の付いていない巻。抜け巻の導線はこれに番号を付ける追加を受け付ける（弾いてはいけない）。
  await addVolume(MINE_NONUM, MINE, null);
  await addVolume(OTHER_V2, OTHER, "2");
  await addVolume(ABSORBED_V3, ABSORBED, "3");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_merge (absorbed_id, target_id, created_at) VALUES (?, ?, ?)`
  )
    .bind(ABSORBED, MINE, Date.now())
    .run();
  // 補完は series_supplement に書くと トリガが series_supplement_isbn を作る（db/schema.sql）。
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_supplement (series_id, volumes_json, checked_at) VALUES (?, ?, ?)`
  )
    .bind(
      SUPPLEMENTED,
      JSON.stringify([{ isbn: SUP_V4, isbns: [SUP_V4], volume_number: "4", vol_sort: 4 }]),
      Date.now()
    )
    .run();
  // 書影が無い ISBN は手前で弾かれるので、通る側のテストのために表紙を入れておく
  // （テスト環境は外部 API の鍵を持たない）。
  for (const isbn of [MINE_NONUM, FREE]) {
    await env.DB.prepare(`INSERT OR REPLACE INTO covers (isbn, cover_url, checked_at) VALUES (?, ?, ?)`)
      .bind(isbn, "https://books.google.com/books/content?id=x", Date.now())
      .run();
  }
});

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM series_correction WHERE series_id = ?`).bind(MINE).run();
});

describe("手動追加は別シリーズの巻の ISBN を入れない", () => {
  it("別シリーズの master の巻は弾き、相手のシリーズ名を出す", async () => {
    const res = await addCorrection(MINE, OTHER_V2, "2");
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error).toContain("別のシリーズ");
    expect(error).toContain("規則試験 文庫版");
    const row = await env.DB.prepare(`SELECT 1 FROM series_correction WHERE isbn = ?`).bind(OTHER_V2).first();
    expect(row).toBeNull();
  });

  it("別シリーズの補完が握っている ISBN も弾く", async () => {
    const res = await addCorrection(MINE, SUP_V4, "4");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("規則試験 愛蔵版");
  });

  it("どのシリーズにも属さない ISBN は通す", async () => {
    // 書影が無ければ別の理由で弾かれるので、表紙を入れてある FREE で見る。
    expect((await addCorrection(MINE, FREE, "9")).status).toBe(200);
  });

  it("このシリーズに巻番号なしで在る ISBN は通す（抜け巻の導線を壊さない）", async () => {
    expect((await addCorrection(MINE, MINE_NONUM, "5")).status).toBe(200);
  });

  it("結合済みのシリーズは 1 つの単位として見る", async () => {
    // 吸収された側（C910003）の巻なので「別のシリーズ」ではない。書影が無いので 200 にはならないが、
    // 弾かれる理由がこの規則でないことを見る。
    const error = await errorOf(await addCorrection(MINE, ABSORBED_V3, "3"));
    expect(error).not.toContain("別のシリーズ");
    expect(error).toContain("書影");
  });
});

// 候補ピッカーの絞り込み（src/candidates.ts volumeCandidates）も同じ関数を使うので、まとめて
// 引いたときの形を直接見ておく。
describe("ownersOfOtherSeries（候補ピッカーと門番で共有する規則）", () => {
  it("別シリーズのぶんだけを相手のシリーズ名に対応付けて返す", async () => {
    const owners = await ownersOfOtherSeries(env as unknown as Env, MINE, [
      OTHER_V2,
      SUP_V4,
      MINE_V1,
      MINE_NONUM,
      ABSORBED_V3,
      FREE,
    ]);
    expect([...owners.keys()].sort()).toEqual([OTHER_V2, SUP_V4].sort());
    expect(owners.get(OTHER_V2)).toBe("規則試験 文庫版");
    expect(owners.get(SUP_V4)).toBe("規則試験 愛蔵版");
  });

  it("空の入力は引かない", async () => {
    expect((await ownersOfOtherSeries(env as unknown as Env, MINE, [])).size).toBe(0);
  });
});
