import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 作者名だけの検索（/api/search?by=creator、src/search.ts searchByCreator）。
// 書名を一切見ないこと、段（まるごと一致 → 前方一致 → 部分一致）と巻数の並び、
// シリーズに属さない巻も作者名で拾えることを見る。
//
// 種はユーザの例に合わせて「ヤマダ」。書名にだけ「ヤマダ」が入る作品（別人の作）を囮に置いて、
// 作品名の検索には出るが作者名の検索には出ないことを確かめる。

const Q = "ヤマダ";

interface Seed {
  id: string;
  name: string;
  creator: string;      // 表示用の代表作者
  creators_norm: string; // 検索用（取り込みが「|」でつないだ全作者名）
  vols: number;
}

const seeds: Seed[] = [
  // 作者名がまるごと一致（mt=3）。共著の 2 人目でも同じ段に入る。巻数の多い方が先。
  { id: "CR_CO", name: "キョウチョサクヒン", creator: "ハラサクシャ", creators_norm: "ハラサクシャ|ヤマダ", vols: 5 },
  { id: "CR_EXACT", name: "タンドクサクヒン", creator: "ヤマダ", creators_norm: "ヤマダ", vols: 3 },
  // 作者名が検索語で始まる（mt=2）
  { id: "CR_PREFIX", name: "ゼンポウイッチ", creator: "ヤマダレイジ", creators_norm: "ヤマダレイジ", vols: 2 },
  // 名前の途中に含む（mt=1）
  { id: "CR_SUB", name: "チュウカンイッチ", creator: "オオヤマダイゴ", creators_norm: "オオヤマダイゴ", vols: 4 },
  // 囮: 書名にだけ「ヤマダ」が入る別人の作品。作者名の検索には出てはいけない。
  { id: "CR_TITLE", name: "ヤマダタンテイジムショ", creator: "ベツノヒト", creators_norm: "ベツノヒト", vols: 9 },
];

// シリーズに属さない巻（series_id IS NULL）。作者名で拾って G-id のカードになる。
const LOOSE_TITLE = "マイゴノマキ";
const LOOSE_ISBN = makeIsbns(1, 770000)[0];

async function search(by: "title" | "creator") {
  const res = await SELF.fetch(
    `https://example.com/api/search?q=${encodeURIComponent(Q)}${by === "creator" ? "&by=creator" : ""}`,
    { headers: { "user-agent": BROWSER_UA } }
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { results: { series_id: string; title: string; creator: string }[] };
  return data.results;
}

beforeAll(async () => {
  const stmts = [];
  let isbnAt = 0;
  for (const s of seeds) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, creators_norm, num_items)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(s.id, s.name, s.name, s.name, s.creator, s.creators_norm, s.vols)
    );
    makeIsbns(s.vols, 700000 + isbnAt).forEach((isbn, k) => {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, creators_norm)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(isbn, s.id, String(k + 1), k + 1, s.name, s.name, s.creator, s.creators_norm)
      );
    });
    isbnAt += s.vols;
  }
  stmts.push(
    env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, creators_norm)
       VALUES (?, NULL, '1', 1, ?, ?, 'ヤマダ', 'ヤマダ')`
    ).bind(LOOSE_ISBN, LOOSE_TITLE, LOOSE_TITLE)
  );
  await env.DB.batch(stmts);
});

describe("GET /api/search?by=creator（作者名だけ）", () => {
  it("書名にしか当たらない作品は出ない（作品名の検索には出る）", async () => {
    expect((await search("title")).map((r) => r.series_id)).toContain("CR_TITLE");
    expect((await search("creator")).map((r) => r.series_id)).not.toContain("CR_TITLE");
  });

  it("まるごと一致 → 前方一致 → 部分一致の順、同じ段では巻数の多い順", async () => {
    const ids = (await search("creator")).map((r) => r.series_id);
    expect(ids.filter((id) => id.startsWith("CR_"))).toEqual(["CR_CO", "CR_EXACT", "CR_PREFIX", "CR_SUB"]);
  });

  it("共著の 2 人目の作者でも当たる", async () => {
    const hit = (await search("creator")).find((r) => r.series_id === "CR_CO");
    expect(hit?.title).toBe("キョウチョサクヒン");
  });

  it("シリーズに属さない巻も作者名で拾う", async () => {
    const titles = (await search("creator")).map((r) => r.title);
    expect(titles).toContain(LOOSE_TITLE);
  });
});
