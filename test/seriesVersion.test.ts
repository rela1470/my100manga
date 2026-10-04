import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import { resolveBooks } from "../src/listItems";

// シリーズの版表示（series.version、MADB の schema:version）。MADB は同じ作品の版違いを
// 「同じ schema:name の別 C-id」として持つので（横山光輝「三国志」は潮出版社だけで 8 シリーズ）、
// 検索結果が同名のカードだらけになる。版表示を返し、版表示を持たない行のためにレーベルと
// 初版年（first_year）も返して、クライアントが同名のカードだけに添える。
// see src/search.ts SERIES_COLS / public/app.js ambiguousEditionKeys

const NAME = "バンヒョウジシケン";
const PLAIN = "CV001"; // 版表示なし・1974 年
const PLAIN2 = "CV002"; // 版表示なし・2007 年（PLAIN と書名も著者も同じ）
const WIDE = "CV003"; // 版表示「大判」
const [A, B, C] = makeIsbns(3, 910000);

async function addSeries(id: string, label: string | null, version: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher, label, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, NAME, NAME, NAME, "版表示作者", "版表示社", label, version)
    .run();
}

async function addVolume(seriesId: string, isbn: string, pubdate: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, pubdate)
     VALUES (?, ?, '1', 1, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, NAME, NAME, "版表示作者", pubdate)
    .run();
}

interface Card {
  series_id: string;
  title: string;
  version: string;
  label: string;
  first_year: string;
}

beforeAll(async () => {
  await addSeries(PLAIN, "希望コミックス", null);
  await addSeries(PLAIN2, null, null);
  await addSeries(WIDE, null, "大判");
  await addVolume(PLAIN, A, "1974-04");
  await addVolume(PLAIN2, B, "2007-03");
  await addVolume(WIDE, C, "2017-01");
});

async function cards(): Promise<Map<string, Card>> {
  const res = await SELF.fetch(`https://example.com/api/search?q=${encodeURIComponent(NAME)}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: Card[] };
  return new Map(body.results.map((r) => [r.series_id, r]));
}

describe("シリーズの版表示", () => {
  it("検索結果が版表示・レーベル・初版年を返す", async () => {
    const byId = await cards();
    expect(byId.get(WIDE)).toMatchObject({ title: NAME, version: "大判", first_year: "2017" });
    expect(byId.get(PLAIN)).toMatchObject({ version: "", label: "希望コミックス", first_year: "1974" });
    expect(byId.get(PLAIN2)).toMatchObject({ version: "", label: "", first_year: "2007" });
  });

  it("書名そのものは版表示で変えない（live 結果との突き合わせが書名で行われるため）", async () => {
    const byId = await cards();
    for (const id of [PLAIN, PLAIN2, WIDE]) expect(byId.get(id)!.title).toBe(NAME);
  });

  it("リスト表示の本のタイトルにも版表示が入る（版違いが同じ名前に潰れない）", async () => {
    // リストは ISBN しか持たず、表示名は読み出し時に引き直す（src/listItems.ts）。
    // 版表示が無いと「バンヒョウジシケン 1」が 3 つ並んでどれがどれか分からない。
    const books = await resolveBooks(env, [A, B, C]);
    expect(books.get(C)!.title).toBe(`${NAME}（大判） 1`);
    expect(books.get(C)!.series_title).toBe(`${NAME}（大判）`);
    expect(books.get(A)!.title).toBe(`${NAME} 1`);
  });

  it("シリーズ名が既にその版を名乗っていれば二重にしない", async () => {
    // 管理者がシリーズ名を「〜 大判」に直している場合（本番に 16 件あった）。
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_name_override (series_id, name, created_at) VALUES (?, ?, ?)`
    )
      .bind(WIDE, `${NAME} 大判`, Date.now())
      .run();
    try {
      const books = await resolveBooks(env, [C]);
      expect(books.get(C)!.series_title).toBe(`${NAME} 大判`);
    } finally {
      await env.DB.prepare(`DELETE FROM series_name_override WHERE series_id = ?`).bind(WIDE).run();
    }
  });

  it("巻一覧も版表示を返す（検索を経由せず直リンクで開ける）", async () => {
    const res = await SELF.fetch(`https://example.com/api/series/${WIDE}/volumes`, {
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; version: string };
    expect(body).toMatchObject({ title: NAME, version: "大判" });
  });
});
