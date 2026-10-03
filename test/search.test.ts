import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";

// キーワード検索の並びとページ送り。クエリは「当たった行の段（mt）を数える → このページに
// かかる段の行だけ巻数を出して切り出す」の段階構成（src/search.ts）なので、段をまたぐ
// ページ境界で取りこぼし・重複が出ないことを見る。
//
// 種: 同じ段（前方一致 mt=5）の 40 件と、完全一致（mt=6）の 2 件。巻数・num_items・id を
// ばらして、並び順のキー（mt DESC, vol_count DESC, num_items DESC, id）を全部使わせる。

const NAME = "テストサクヒン";
const PREFIX_COUNT = 40;
const EXACT_COUNT = 2;

interface Seed {
  id: string;
  name: string;
  vols: number;
  num_items: number;
}

const seeds: Seed[] = [
  ...Array.from({ length: EXACT_COUNT }, (_, i) => ({
    id: `CX${String(i).padStart(3, "0")}`,
    name: NAME, // 完全一致（mt=6）。巻数は少なくても前方一致より前に出る。
    vols: 1,
    num_items: i,
  })),
  ...Array.from({ length: PREFIX_COUNT }, (_, i) => ({
    id: `CP${String(i).padStart(3, "0")}`,
    name: `${NAME}${String(i).padStart(2, "0")}`, // 前方一致（mt=5）
    vols: (i % 4) + 1, // 巻数は同点だらけにして num_items / id の tiebreak も通す
    num_items: i % 3,
  })),
];

/** 期待する並び: 完全一致の段が先。段の中は巻数・num_items・id の順。 */
const byKey = (a: Seed, b: Seed) => b.vols - a.vols || b.num_items - a.num_items || a.id.localeCompare(b.id);
const expected = [
  ...seeds.filter((s) => s.id.startsWith("CX")).sort(byKey),
  ...seeds.filter((s) => s.id.startsWith("CP")).sort(byKey),
].map((s) => s.id);

async function search(offset: number) {
  const res = await SELF.fetch(
    `https://example.com/api/search?q=${encodeURIComponent(NAME)}&offset=${offset}`,
    { headers: { "user-agent": BROWSER_UA } }
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { results: { series_id: string; volume_count: number }[]; next_offset: number | null };
  return data;
}

beforeAll(async () => {
  const stmts = [];
  let isbnAt = 0;
  for (const s of seeds) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, num_items) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(s.id, s.name, s.name, s.name, "テスト作者", s.num_items)
    );
    makeIsbns(s.vols, 100000 + isbnAt).forEach((isbn, k) => {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(isbn, s.id, String(k + 1), k + 1, s.name, s.name, "テスト作者")
      );
    });
    isbnAt += s.vols;
  }
  await env.DB.batch(stmts);
});

describe("GET /api/search（キーワード）", () => {
  it("1 ページ目は 30 件、完全一致・巻数の多い順", async () => {
    const data = await search(0);
    expect(data.results.map((r) => r.series_id)).toEqual(expected.slice(0, 30));
    expect(data.next_offset).toBe(30);
  });

  it("2 ページ目は段をまたいでも重複・取りこぼしなく続く", async () => {
    const data = await search(30);
    expect(data.results.map((r) => r.series_id)).toEqual(expected.slice(30));
    expect(data.next_offset).toBeNull();
    // 1 ページ目と合わせて、当たった 42 件がちょうど 1 回ずつ出る。
    const first = await search(0);
    const all = [...first.results, ...data.results].map((r) => r.series_id);
    expect(new Set(all).size).toBe(expected.length);
  });

  it("結果の件数より先の offset は空", async () => {
    const data = await search(60);
    expect(data.results).toEqual([]);
  });
});
