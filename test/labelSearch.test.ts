import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { adminListLabels } from "../src/labels";
import type { Env } from "../src/types";

// 管理画面のレーベル一覧の検索（src/labels.ts searchTerms）。
// 同じレーベルがマスタ上で何通りにも表記されている（実データで「ジャンプ…セレクション」は
// 8 通り: 「ジャンプコミックスセレクション」「ジャンプ コミックス セレクション」
// 「ジャンプ・コミックス・セレクション」…）。1 本の LIKE だと「ジャンプ セレクション」が
// どれにも当たらないので、空白区切りの AND にしてある。表記ゆれをまとめて選んで
// 一括でタグを付けられるようにするのが狙い。
//
// 件数のアサーションがあるので、タグ付けの試験（test/labelTag.test.ts）とは DB を分ける
// （D1 はテストファイルごとに空で、同じファイル内のテストだけが共有する）。

const adminEnv = env as unknown as Env;

const VARIANTS = [
  "ジャンプコミックスセレクション",
  "ジャンプ コミックス セレクション",
  "ジャンプ・コミックス・セレクション",
];
const OTHERS = ["ジャンプ・コミックス", "Bamboo essay SELECTION", "講談社漫画文庫"];

async function labelsFor(q: string): Promise<string[]> {
  const res = await adminListLabels(adminEnv, q, "", "");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { labels: { label: string }[] };
  return body.labels.map((l) => l.label).sort();
}

beforeAll(async () => {
  let n = 0;
  for (const label of [...VARIANTS, ...OTHERS]) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, label)
       VALUES (?, '検索試験作品', '検索試験作品', '検索試験作品', '検索試験作者', ?)`
    )
      .bind(`CQ${n++}`, label)
      .run();
  }
});

describe("レーベル一覧の検索", () => {
  it("空白区切りは AND（語を全部含むレーベルだけ返す）", async () => {
    const got = await labelsFor("ジャンプ セレクション");
    expect(got).toEqual([...VARIANTS].sort());
    // 1 本の LIKE だった頃はこれが 0 件だった（語の間の空白がレーベル名に無いため）。
    expect(got).not.toContain("ジャンプ・コミックス");
  });

  it("全角の空白でも区切る", async () => {
    expect(await labelsFor("ジャンプ　セレクション")).toEqual([...VARIANTS].sort());
  });

  it("前後の空白・連続する空白は無視する", async () => {
    expect(await labelsFor("  ジャンプ   セレクション  ")).toEqual([...VARIANTS].sort());
  });

  it("1 語だけなら今までどおり部分一致", async () => {
    expect(await labelsFor("セレクション")).toEqual([...VARIANTS].sort());
  });

  it("英字は大文字小文字を区別しない（表記ゆれを 1 回で拾う）", async () => {
    expect(await labelsFor("bamboo selection")).toEqual(["Bamboo essay SELECTION"]);
  });

  it("空の検索語は絞り込まない", async () => {
    expect(await labelsFor("   ")).toEqual([...VARIANTS, ...OTHERS].sort());
  });

  it("どの語にも当たらなければ 0 件", async () => {
    expect(await labelsFor("ジャンプ 文庫")).toEqual([]);
  });

  it("LIKE のワイルドカードは文字として扱う", async () => {
    expect(await labelsFor("%")).toEqual([]);
  });
});
