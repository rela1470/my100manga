import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import { rebuildSuggest } from "../src/suggest";
import { bumpViewEpoch } from "../src/viewSnapshot";
import type { Env } from "../src/types";

// 検索欄の入力補完（/api/suggest, src/suggest.ts）。前方一致の専用表 series_suggest を
// master から作り直して、綴り（書名・記号無視の書名・読み・管理者が直した名前）のどれでも
// 引けること、並びが巻数順であること、検索に出ないもの（結合で吸収されたシリーズ）が候補にも
// 出ないことを見る。
//
// 種は『ONE PIECE』と同じ形を作る: 読み（name_kana_norm）が "ローマ字|カナ" の 2 つ入りで、
// カナが 2 つ目にある。塊のまま前方一致させるとカナ入力で当たらない形。

const suggestEnv = env as unknown as Env;

interface Seed {
  id: string;
  name: string;
  name_norm: string;
  name_search: string;
  kana: string;
  vols: number;
}

const seeds: Seed[] = [
  // 読みの 2 つ目がカナ。巻数が一番多いので候補の先頭に出るはず。
  { id: "CS001", name: "テストピース", name_norm: "てすとぴーす", name_search: "てすとぴーす", kana: "testpiece|テストピース", vols: 5 },
  // 同じ綴りで始まる小さいシリーズ（巻数で後ろに回る）。
  { id: "CS002", name: "テストピース外伝", name_norm: "てすとぴーす外伝", name_search: "てすとぴーす外伝", kana: "テストピースガイデン", vols: 2 },
  // 記号入り。name_search（記号を落とした綴り）でだけ当たる。
  { id: "CS003", name: "テスト・ざ・ロック!", name_norm: "テスト・ざ・ロック!", name_search: "テストざろっく", kana: "テストザロック", vols: 3 },
  // 表示名の揺れ（大文字小文字・空白だけ違う同名）。候補では 1 つに畳まれる。
  { id: "CS004", name: "TEST PIECE", name_norm: "testpiece", name_search: "testpiece", kana: "テストピース", vols: 4 },
  { id: "CS005", name: "Test piece", name_norm: "testpiece", name_search: "testpiece", kana: "テストピース", vols: 1 },
  // 結合で吸収される側（検索結果に出ないので候補にも出さない）。巻数は吸収先に足される。
  { id: "CS006", name: "テストピース新装版", name_norm: "てすとぴーす新装版", name_search: "てすとぴーす新装版", kana: "テストピースシンソウバン", vols: 3 },
  // 巻を 1 冊も持たないシリーズ（検索に出ないので候補にも出さない）。
  { id: "CS007", name: "テストピース幻", name_norm: "てすとぴーす幻", name_search: "てすとぴーす幻", kana: "テストピースマボロシ", vols: 0 },
];

async function suggest(q: string): Promise<string[]> {
  const res = await SELF.fetch(`https://example.com/api/suggest?q=${encodeURIComponent(q)}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { suggestions: string[] };
  return data.suggestions;
}

beforeAll(async () => {
  const stmts = [];
  let isbnAt = 0;
  for (const s of seeds) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, name_kana_norm, creator, num_items)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).bind(s.id, s.name, s.name_norm, s.name_search, s.kana, "テスト作者")
    );
    makeIsbns(s.vols, 870000 + isbnAt).forEach((isbn, k) => {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(isbn, s.id, String(k + 1), k + 1, s.name, s.name_search, "テスト作者")
      );
    });
    isbnAt += 100;
  }
  // CS006 を CS001 に結合する（吸収された側は候補から消え、巻数は吸収先に足される）。
  stmts.push(
    env.DB.prepare(`INSERT OR REPLACE INTO series_merge (absorbed_id, target_id, created_at) VALUES ('CS006', 'CS001', 1)`)
  );
  await env.DB.batch(stmts);
  await rebuildSuggest(suggestEnv);
});

describe("/api/suggest（検索欄の入力補完）", () => {
  it("書名の前方一致を巻数の多い順に返す", async () => {
    const names = await suggest("てすとぴ");
    // CS001（5 + 吸収した CS006 の 3 = 8 巻）が先頭。CS002（2 巻）も候補に入る。
    expect(names[0]).toBe("テストピース");
    expect(names).toContain("テストピース外伝");
  });

  it("ひらがなの入力がカナの読みに当たる（読みが複数あって 2 つ目がカナでも）", async () => {
    // "testpiece|テストピース" の 2 つ目の読み。塊のまま前方一致させると当たらない形。
    expect(await suggest("てすとぴーす")).toContain("テストピース");
  });

  it("記号を無視した綴りで当たる", async () => {
    expect(await suggest("てすとざろ")).toContain("テスト・ざ・ロック!");
  });

  it("大文字小文字・空白だけ違う同名は 1 つに畳む", async () => {
    const names = await suggest("testpi");
    // 巻数の多い「TEST PIECE」(4 巻) が残り、「Test piece」(1 巻) は出ない。
    expect(names).toContain("TEST PIECE");
    expect(names).not.toContain("Test piece");
  });

  it("結合で吸収されたシリーズと、巻の無いシリーズは候補に出ない", async () => {
    const names = await suggest("てすとぴ");
    expect(names).not.toContain("テストピース新装版");
    expect(names).not.toContain("テストピース幻");
  });

  it("1 文字では候補を出さない（エラーにはしない）", async () => {
    expect(await suggest("て")).toEqual([]);
  });

  it("どこにも当たらない語では空", async () => {
    expect(await suggest("ぜったいにあたらないであろうことば")).toEqual([]);
  });
});

describe("series_suggest の作り直し", () => {
  it("管理者が直したシリーズ名でも引ける", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_name_override (series_id, name, name_norm, name_search, created_at)
       VALUES ('CS002', 'テストナオシタナマエ', 'てすとなおしたなまえ', 'てすとなおしたなまえ', 1)`
    ).run();
    await rebuildSuggest(suggestEnv);
    // 管理者の更新系 API はどれも表示データの世代を上げる（src/viewSnapshot.ts bumpsViewEpoch）。
    // サジェストのエッジキャッシュの鍵にもその世代が入っているので、直した名前はすぐ候補に出る。
    await bumpViewEpoch(suggestEnv);
    expect(await suggest("てすとなおした")).toContain("テストナオシタナマエ");
    // 直した名前はマスタ名の代わりに出る（同じシリーズがマスタ名と直した名前で二重に並ばない）。
    const names = await suggest("てすとぴ");
    expect(names).not.toContain("テストピース外伝");
    expect(names).toContain("テストナオシタナマエ"); // マスタ名の綴り「てすとぴーす外伝」でも引ける
  });

  it("作り直しは何度流しても同じ（行数が増えない）", async () => {
    const rows = await rebuildSuggest(suggestEnv);
    expect(await rebuildSuggest(suggestEnv)).toBe(rows);
  });
});
