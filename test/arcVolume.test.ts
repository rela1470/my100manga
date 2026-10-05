import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminUpdateCorrection } from "../src/admin";
import { arcLabelTemplate, formatArcLabel, parseArcLabel, volSort } from "../src/util";
import type { Env } from "../src/types";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 部立ての巻ラベル（「第4部[9]」）の手動追加と、管理画面からの付け直し・移動。
//
// きっかけ: 『本好きの下剋上』第4部9巻（ISBN 9784867943816）が「9」として C365444 に入り、
// 第1部の巻（vol_sort 0〜1007）のあいだに並んだ。手動追加（src/corrections.ts normalizeVolume）が
// 「N」「巻N」しか受け付けず、部立てのシリーズに正しい巻番号で足す手段が画面に無かったため。
// 直すにも管理画面は確定/却下しかできず、本番で SQL を書く羽目になった
// （db/fix-honzuki-part4-volume.sql、db/MIGRATIONS.md 2026-10-05 の節）。

const ARC = "C920001"; // 部立てのシリーズ（結合先）
const ARC_ABSORBED = "C920002"; // ARC に結合済み。部立てのラベルはこちらに在る
const PLAIN = "C920003"; // 素の巻番号のシリーズ
const OTHER_ARC = "C920004"; // 移動先に使う別の部立てシリーズ

const [ARC_V1, ARC_V2, PLAIN_V1, FREE_A, FREE_B, FREE_C, FREE_D] = makeIsbns(7, 330000);

const adminEnv = env as unknown as Env;

async function addVolume(isbn: string, seriesId: string, volume: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, volume, volSort(volume), "部立て試験", "部立て試験", "作者")
    .run();
}

function post(seriesId: string, isbn: string, volume: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/series/${seriesId}/corrections`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify({ isbn, volume_number: volume }),
  });
}

function patch(seriesId: string, isbn: string, body: Record<string, unknown>): Promise<Response> {
  return adminUpdateCorrection(
    new Request("https://example.com/api/admin/corrections", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    adminEnv,
    seriesId,
    isbn
  );
}

async function correction(seriesId: string, isbn: string) {
  return env.DB.prepare(
    `SELECT series_id, volume_number, vol_sort, cover_url, created_at, reviewed_at
       FROM series_correction WHERE series_id = ? AND isbn = ?`
  )
    .bind(seriesId, isbn)
    .first<Record<string, unknown>>();
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

beforeAll(async () => {
  for (const id of [ARC, ARC_ABSORBED, PLAIN, OTHER_ARC]) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(id, "部立て試験", "部立て試験", "部立て試験", "作者")
      .run();
  }
  // 部立てのラベルは吸収された側に在る。手動追加は結合の全 member からラベルを集めないと
  // 「このシリーズは部立てだ」と判断できない（巻一覧 getSeriesVolumes と同じ単位で見る）。
  await addVolume(ARC_V1, ARC_ABSORBED, "第4部[1]");
  await addVolume(ARC_V2, ARC_ABSORBED, "第4部[2]");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_merge (absorbed_id, target_id, created_at) VALUES (?, ?, ?)`
  )
    .bind(ARC_ABSORBED, ARC, Date.now())
    .run();
  await addVolume(PLAIN_V1, PLAIN, "1");
  // 移動先は書式が違う（空白区切り）。移すと移動先の書式に揃うことを見る。
  await addVolume(makeIsbns(1, 339000)[0], OTHER_ARC, "第2部 1");

  // 書影が無い ISBN は手前で弾かれる（テスト環境は外部 API の鍵を持たない）。
  for (const isbn of [FREE_A, FREE_B, FREE_C, FREE_D]) {
    await env.DB.prepare(`INSERT OR REPLACE INTO covers (isbn, cover_url, checked_at) VALUES (?, ?, ?)`)
      .bind(isbn, "https://books.google.com/books/content?id=x", Date.now())
      .run();
  }
});

beforeEach(async () => {
  await env.DB.prepare(
    `DELETE FROM series_correction WHERE series_id IN (?, ?, ?, ?)`
  )
    .bind(ARC, ARC_ABSORBED, PLAIN, OTHER_ARC)
    .run();
});

describe("部立ての巻ラベルの読み書き（src/util.ts）", () => {
  it("部の番号・巻番号・書式に分解する", () => {
    expect(parseArcLabel("第4部[9]")).toMatchObject({ arc: 4, n: 9, unit: "部", template: "第{a}部[{n}]" });
    expect(parseArcLabel("第2部 4")).toMatchObject({ arc: 2, n: 4, unit: "部", template: "第{a}部 {n}" });
    expect(parseArcLabel("第2部1")).toMatchObject({ arc: 2, n: 1, template: "第{a}部{n}" });
    expect(parseArcLabel("第1幕 3")).toMatchObject({ arc: 1, n: 3, unit: "幕" });
  });

  it("部立てでないラベルは分解しない", () => {
    for (const l of ["9", "巻110", "第170巻", "[6]", "24億脱出編4", "第1部", ""]) {
      expect(parseArcLabel(l)).toBeNull();
    }
  });

  it("シリーズで最も多い書式を選び、当てはめ直せる", () => {
    const labels = ["第4部[1]", "第4部[2]", "第2部 9"];
    const t = arcLabelTemplate(labels);
    expect(t).toBe("第{a}部[{n}]");
    expect(formatArcLabel(t!, 4, 9)).toBe("第4部[9]");
    expect(arcLabelTemplate(["1", "2", "巻3"])).toBeNull();
  });

  it("vol_sort は部 ×1000 + 巻（既存の並びに挟まる）", () => {
    expect(volSort("第4部[9]")).toBe(4009);
    expect(volSort("第4部[8]")).toBe(4008);
    expect(volSort("第4部[10]")).toBe(4010);
    expect(volSort("第2部 4")).toBe(2004);
  });
});

describe("手動追加の巻番号（POST /api/series/:id/corrections）", () => {
  it("部立てのシリーズは部付きの巻番号を受け付け、書式をそのシリーズに揃える", async () => {
    const res = await post(ARC, FREE_A, "第4部9");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { volume: { volume_number: string; vol_sort: number } };
    expect(body.volume.volume_number).toBe("第4部[9]");
    expect(body.volume.vol_sort).toBe(4009);
    expect(await correction(ARC, FREE_A)).toMatchObject({ volume_number: "第4部[9]", vol_sort: 4009 });
  });

  it("部立てでないシリーズには部付きを入れない（並び順が他の巻と噛み合わない）", async () => {
    const res = await post(PLAIN, FREE_B, "第4部9");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("巻番号は");
    expect(await correction(PLAIN, FREE_B)).toBeNull();
  });

  it("素の巻番号は従来どおり通る", async () => {
    expect((await post(PLAIN, FREE_B, "2")).status).toBe(200);
    expect(await correction(PLAIN, FREE_B)).toMatchObject({ volume_number: "2", vol_sort: 2 });
  });

  it("数で置けない自由な部名は従来どおり拒否する", async () => {
    expect((await post(ARC, FREE_C, "24億脱出編4")).status).toBe(400);
  });

  it("形式を誤ったときの案内は、部立てのシリーズでだけ部付きの例を出す", async () => {
    expect(await errorOf(await post(ARC, FREE_C, "でたらめ"))).toContain("第4部[9]");
    expect(await errorOf(await post(PLAIN, FREE_C, "でたらめ"))).not.toContain("部");
  });
});

describe("管理画面からの手動追加の修正（PATCH /api/admin/corrections/:series/:isbn）", () => {
  it("巻番号を付け直す（取り違えたまま入った投稿の受け皿）", async () => {
    // 取り違えの再現: 第4部9巻が「9」で入り、vol_sort 9 ＝ 1巻台のあいだに並んでいる。
    await post(PLAIN, FREE_A, "9");
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_correction
         (series_id, isbn, volume_number, vol_sort, cover_url, created_at, reviewed_at)
       VALUES (?, ?, '9', 9, 'https://example.com/c.jpg', 111, 222)`
    )
      .bind(ARC, FREE_A)
      .run();

    const res = await patch(ARC, FREE_A, { volume_number: "第4部9" });
    expect(res.status).toBe(200);
    // 表紙・投稿日・確定状態は引き継ぐ（直したことで履歴が消えない）。
    expect(await correction(ARC, FREE_A)).toMatchObject({
      volume_number: "第4部[9]",
      vol_sort: 4009,
      cover_url: "https://example.com/c.jpg",
      created_at: 111,
      reviewed_at: 222,
    });
  });

  it("別のシリーズへ移すと、移動先の書式に揃う", async () => {
    await post(ARC, FREE_A, "第4部9");
    const res = await patch(ARC, FREE_A, { series_id: OTHER_ARC, volume_number: "第2部9" });
    expect(res.status).toBe(200);
    expect(await correction(ARC, FREE_A)).toBeNull();
    // 移動先は空白区切りの書式（"第2部 1"）なのでそれに合う。
    expect(await correction(OTHER_ARC, FREE_A)).toMatchObject({ volume_number: "第2部 9", vol_sort: 2009 });
  });

  it("移動先が存在しない・まとまり・既に同じ ISBN があるときは断る", async () => {
    await post(ARC, FREE_A, "第4部9");
    expect(await errorOf(await patch(ARC, FREE_A, { series_id: "C999999" }))).toContain("見つかりません");
    expect(await errorOf(await patch(ARC, FREE_A, { series_id: `G${FREE_B}` }))).toContain("まとまり");
    await post(OTHER_ARC, FREE_A, "第2部9");
    expect(await errorOf(await patch(ARC, FREE_A, { series_id: OTHER_ARC }))).toContain("既に同じ ISBN");
    // 断られたら元のままで、移動先も荒らされない。
    expect(await correction(ARC, FREE_A)).toMatchObject({ volume_number: "第4部[9]" });
  });

  it("移動先で受け付けられない巻番号は断る（素の巻番号のシリーズへ部付き）", async () => {
    await post(ARC, FREE_A, "第4部9");
    expect(await errorOf(await patch(ARC, FREE_A, { series_id: PLAIN }))).toContain("巻番号は");
    expect(await correction(ARC, FREE_A)).toMatchObject({ volume_number: "第4部[9]" });
    expect(await correction(PLAIN, FREE_A)).toBeNull();
  });

  it("まとまり（G-id）の投稿も巻番号だけなら直せる（素の巻番号のみ）", async () => {
    // まとまりはシリーズに属さない巻の集まりで volumes に G-id の行が無い。ラベルを引けないので
    // 部立ては受け付けず、素の巻番号の付け直しだけができる。
    const gid = `G${ARC_V1}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_correction
         (series_id, isbn, volume_number, vol_sort, cover_url, created_at, reviewed_at)
       VALUES (?, ?, '1', 1, '', 1, 0)`
    )
      .bind(gid, FREE_B)
      .run();
    expect((await patch(gid, FREE_B, { volume_number: "3" })).status).toBe(200);
    expect(await correction(gid, FREE_B)).toMatchObject({ volume_number: "3", vol_sort: 3 });
    expect(await errorOf(await patch(gid, FREE_B, { volume_number: "第4部9" }))).toContain("巻番号は");
    await env.DB.prepare(`DELETE FROM series_correction WHERE series_id = ?`).bind(gid).run();
  });

  it("無い行には 404、変化が無ければ書かない", async () => {
    expect((await patch(ARC, FREE_D, { volume_number: "第4部1" })).status).toBe(404);
    await post(ARC, FREE_A, "第4部9");
    const res = await patch(ARC, FREE_A, { volume_number: "第4部[9]" });
    expect(((await res.json()) as { changed: boolean }).changed).toBe(false);
  });
});
