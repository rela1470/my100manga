import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rebuildSuggest } from "../src/suggest";
import type { Env } from "../src/types";
// @ts-expect-error -- 型定義の無い .mjs（scripts/ingest.mjs --diff の部品）
import { deleteStatements, diffRows, liveRowKey, sqlInt, sqlStr, suggestDiffSql, upsertClause } from "../scripts/ingest-diff.mjs";

// 差分取り込み（scripts/ingest.mjs --diff）。全件の取り込みと同じ結果になることは、手元の
// MADB ダンプで全件と差分を両方流して表を突き合わせて確かめた（README「差分取り込み」）。ここでは
// 部品ごとに、比べ方の取り違え（NULL と空文字・数と文字列）と、サジェスト索引の差分が作り直しと
// 同じ結果になることを見る。

const testEnv = env as unknown as Env;

describe("diffRows", () => {
  const cols = ["isbn", "title", "vol_sort"];
  const ints = new Set(["vol_sort"]);
  const tuple = (isbn: string, title: string | null, sort: number | null) => [sqlStr(isbn), sqlStr(title), sqlInt(sort)];
  const live = (rows: Record<string, unknown>[]) =>
    new Map(rows.map((r) => [sqlStr(r.isbn as string), liveRowKey(r, cols, ints)]));

  it("変わった行・増えた行だけを書き、消えた行を消す", () => {
    const next = new Map([
      ["'1'", tuple("1", "同じ", 1)],
      ["'2'", tuple("2", "変わった", 2)],
      ["'3'", tuple("3", "増えた", 3)],
    ]);
    const { upserts, deletes } = diffRows(
      next,
      live([
        { isbn: "1", title: "同じ", vol_sort: 1 },
        { isbn: "2", title: "前の名前", vol_sort: 2 },
        { isbn: "4", title: "消えた", vol_sort: 4 },
      ])
    );
    expect(upserts.map((t: string[]) => t[0])).toEqual(["'2'", "'3'"]);
    expect(deletes).toEqual(["'4'"]);
  });

  it("D1 の NULL・空文字・数は、取り込みが書くリテラルと同じに扱う", () => {
    const next = new Map([["'1'", tuple("1", "", null)]]); // 空文字は NULL として書いている
    const { upserts } = diffRows(next, live([{ isbn: "1", title: null, vol_sort: null }]));
    expect(upserts).toEqual([]);
    const n = new Map([["'2'", tuple("2", "x", 10)]]);
    expect(diffRows(n, live([{ isbn: "2", title: "x", vol_sort: 10 }])).upserts).toEqual([]);
    expect(diffRows(n, live([{ isbn: "2", title: "x", vol_sort: 1 }])).upserts).toHaveLength(1);
  });

  it("keep が true の行は MADB に無くても消さない（独自シリーズ・差し替えで足した巻）", () => {
    const { deletes } = diffRows(new Map(), live([{ isbn: "U1", title: "独自", vol_sort: null }]), (k: string) => k === "'U1'");
    expect(deletes).toEqual([]);
  });

  it("書き戻しは upsert（主キー以外を excluded から取る）、削除は主キーの IN", () => {
    expect(upsertClause(cols, "isbn")).toBe(" ON CONFLICT(isbn) DO UPDATE SET title = excluded.title, vol_sort = excluded.vol_sort");
    expect(deleteStatements("volumes", "isbn", ["a'b", "c"])).toEqual(["DELETE FROM volumes WHERE isbn IN ('a''b','c');\n"]);
  });
});

describe("サジェスト索引の差分（suggestDiffSql）", () => {
  const seed = async () => {
    const stmts = [];
    for (const [id, name, kana, vols] of [
      ["CD001", "ディフテスト", "ディフテスト", 3],
      ["CD002", "ディフ消える", "ディフキエル", 1],
      ["CD003", "ディフ改名前", "ディフカイメイマエ", 2],
    ] as const) {
      stmts.push(
        testEnv.DB.prepare(
          `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, name_kana_norm, num_items) VALUES (?, ?, ?, ?, ?, 1)`
        ).bind(id, name, name, name, kana)
      );
      for (let i = 1; i <= vols; i++) {
        stmts.push(
          testEnv.DB.prepare(`INSERT OR REPLACE INTO volumes (isbn, series_id, title, vol_sort) VALUES (?, ?, ?, ?)`).bind(
            `978000${id.slice(2)}${i}`,
            id,
            name,
            i
          )
        );
      }
    }
    await testEnv.DB.batch(stmts);
  };
  const snapshot = async () =>
    (
      await testEnv.DB.prepare(
        `SELECT key, series_id, name, name_key, weight, is_adult FROM series_suggest ORDER BY key, series_id`
      ).all()
    ).results;

  it("master を変えたあと差分で合わせると、作り直したのと同じ中身になる", async () => {
    await seed();
    await rebuildSuggest(testEnv);
    // 改名・削除・追加・巻数の変化をまとめて起こす。
    await testEnv.DB.batch([
      testEnv.DB.prepare(`UPDATE series SET name = 'ディフ改名後', name_norm = 'ディフ改名後', name_search = 'ディフ改名後' WHERE id = 'CD003'`),
      testEnv.DB.prepare(`DELETE FROM volumes WHERE series_id = 'CD002'`),
      testEnv.DB.prepare(`DELETE FROM series WHERE id = 'CD002'`),
      testEnv.DB.prepare(
        `INSERT INTO series (id, name, name_norm, name_search, name_kana_norm) VALUES ('CD004', 'ディフ新顔', 'ディフ新顔', 'ディフ新顔', 'ディフシンガオ')`
      ),
      testEnv.DB.prepare(`INSERT INTO volumes (isbn, series_id, title, vol_sort) VALUES ('9780000041', 'CD004', 'ディフ新顔', 1)`),
      testEnv.DB.prepare(`INSERT INTO volumes (isbn, series_id, title, vol_sort) VALUES ('9780000014', 'CD001', 'ディフテスト', 4)`),
    ]);
    for (const sql of suggestDiffSql(env.TEST_SUGGEST_SQL_INGEST)) await testEnv.DB.prepare(sql).run();
    const viaDiff = await snapshot();
    expect(viaDiff.some((r) => r.series_id === "CD002")).toBe(false);
    expect(viaDiff.some((r) => r.name === "ディフ改名後")).toBe(true);
    await rebuildSuggest(testEnv);
    expect(await snapshot()).toEqual(viaDiff);
  });
});
