import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { makeIsbns } from "./helpers";
import { resolveTargets, salesRankingCronEnabled, workKey, workVariants } from "../src/salesRanking";
import type { Env } from "../src/types";
import { normTitle } from "../src/util";

// 売上ランキングの作品（楽天の書名）→ 巻一覧を開く先（src/salesRanking.ts resolveTargets）。
// 楽天とマスタで書名の形が違って寄せられなかった実例を種にしている:
//   ・副題をダッシュで囲む（「ながたんと青とーいちかの料理帖ー」= マスタ「ながたんと青と : いちかの料理帖」）
//   ・マスタに無い外伝（「ホタルの嫁入り外伝」→ 本編「ホタルの嫁入り」）
//   ・マスタが英字・楽天がカタカナ（「BLACK LAGOON」↔「ブラック・ラグーン」）

const dbEnv = env as unknown as Env;
const isbns = makeIsbns(80, 960000);
let seq = 0;

async function seedSeries(
  id: string,
  name: string,
  creator: string,
  vols: number,
  kana = ""
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, name_kana_norm, creator, creators_norm, publisher, label, num_items)
     VALUES (?, ?, ?, ?, ?, ?, ?, '出版社', 'テストコミックス', ?)`
  )
    .bind(id, name, normTitle(name), normTitle(name), kana, creator, normTitle(creator), vols)
    .run();
  for (let i = 1; i <= vols; i++) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'テストコミックス')`
    )
      .bind(isbns[seq++], id, String(i), i, name, normTitle(name), creator)
      .run();
  }
}

/** 楽天の作品名 1 件を resolveTargets にかけ、寄せ先の ID（無ければ ""）を返す。 */
async function resolve(work: string, author: string): Promise<string> {
  const key = workKey(work);
  const got = await resolveTargets(dbEnv, [{ key, work, author, isbns: [] }]);
  return got.get(key) ?? "";
}

beforeAll(async () => {
  await seedSeries("CSR001", "ホタルの嫁入り", "橘オレコ", 12);
  await seedSeries("CSR002", "ながたんと青と : いちかの料理帖", "磯谷友紀", 6);
  await seedSeries("CSR003", "BLACK LAGOON", "広江礼威", 11, "blacklagoon|ブラックラグーン");
  // 読みは同じで著者が違う別作品（読みだけの一致で当ててはいけない）
  await seedSeries("CSR004", "ブラック・ラグーン写真集", "別府太郎", 3, "ブラックラグーン");
  // 記号しか違わない続編の本編（読みは同じ。「もやしもん」と「もやしもん＋」と同じ関係）
  await seedSeries("CSR007", "テスト毛玉堂", "試験次郎", 8, "テストケダマドウ");
  // 区切り記号（・）の有無だけが違う作品（記号を落とした一致でも同じ作品）
  await seedSeries("CSR008", "テスト・クロガネ", "試験三郎", 4, "テストクロガネ");
  // 外伝がマスタにある作品（本編より外伝が先に当たること）
  await seedSeries("CSR005", "テスト蛍商店", "試験花子", 5);
  await seedSeries("CSR006", "テスト蛍商店外伝", "試験花子", 2);
});

describe("resolveTargets（売上ランキングの寄せ先）", () => {
  it("ダッシュで囲んだ副題を落として寄せる", async () => {
    expect(await resolve("ながたんと青とーいちかの料理帖ー", "磯谷 友紀")).toBe("CSR002");
  });

  it("マスタに無い外伝は本編のシリーズに寄せる", async () => {
    expect(await resolve("ホタルの嫁入り外伝 -人斬りと幼童ー", "橘 オレコ")).toBe("CSR001");
  });

  it("外伝がマスタにあれば本編ではなく外伝に寄せる", async () => {
    expect(await resolve("テスト蛍商店外伝 -ためしがきー", "試験 花子")).toBe("CSR006");
    expect(await resolve("テスト蛍商店", "試験 花子")).toBe("CSR005");
  });

  it("マスタが英字の作品を読みで寄せる", async () => {
    expect(await resolve("ブラック・ラグーン", "広江 礼威")).toBe("CSR003");
  });

  it("読みが同じでも著者が合わなければ寄せない", async () => {
    expect(await resolve("ブラック・ラグーン", "無関係 作者")).toBe("");
  });

  it("記号しか違わない作品は読みが同じでも寄せない", async () => {
    expect(await resolve("テスト毛玉堂＋", "試験 次郎")).toBe("");
  });

  it("区切り記号の有無しか違わない作品は読みで寄せる", async () => {
    expect(await resolve("テストクロガネ", "試験 三郎")).toBe("CSR008");
  });

  it("寄せ先の無い作品は Map に入れない", async () => {
    expect(await resolve("テスト存在しない作品ー副題ー", "誰か")).toBe("");
  });
});

describe("workVariants", () => {
  it("ダッシュの副題と外伝を落とす", () => {
    expect(workVariants("ホタルの嫁入り外伝 -人斬りと幼童ー")).toEqual([
      "ホタルの嫁入り外伝 -人斬りと幼童ー",
      "ホタルの嫁入り外伝",
      "ホタルの嫁入り",
    ]);
    expect(workVariants("ながたんと青とーいちかの料理帖ー")).toEqual([
      "ながたんと青とーいちかの料理帖ー",
      "ながたんと青と",
    ]);
  });

  it("長音しか無い書名は切らない", () => {
    expect(workVariants("ワールドトリガー")).toEqual(["ワールドトリガー"]);
    expect(workVariants("名探偵コナン")).toEqual(["名探偵コナン"]);
  });
});

describe("salesRankingCronEnabled（日次 Cron で売上ランキングを取るか）", () => {
  it("SALES_RANKING_CRON=\"true\" の本家だけ取る", () => {
    expect(salesRankingCronEnabled({ SALES_RANKING_CRON: "true", SITE_VARIANT: "general" })).toBe(true);
    expect(salesRankingCronEnabled({ SALES_RANKING_CRON: "true" })).toBe(true);
    expect(salesRankingCronEnabled({ SITE_VARIANT: "general" })).toBe(false);
    expect(salesRankingCronEnabled({ SALES_RANKING_CRON: "false", SITE_VARIANT: "general" })).toBe(false);
  });

  it("R18版では設定を誤っても取らない", () => {
    expect(salesRankingCronEnabled({ SALES_RANKING_CRON: "true", SITE_VARIANT: "adult" })).toBe(false);
  });
});
