import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { isoPubdate } from "../src/book";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 編集中リストの並べ替え（出版日順・作者順）が使う ISBN → 発行日/作者（POST /api/sort-keys）。
// リストの項目は発行日を持たないので、押されたときだけここで引く。出所はマスタ（volumes）→
// book_meta のキャッシュ → ライブ補完（series_supplement）の順。

const [MASTER, META_ONLY, SUPP, UNKNOWN] = makeIsbns(4, 930000);
const SUPP_SERIES = "C930001";

async function sortKeys(isbns: string[]): Promise<Record<string, { date: string; author: string }>> {
  const res = await SELF.fetch("https://example.com/api/sort-keys", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify({ isbns }),
  });
  expect(res.status).toBe(200);
  return (await res.json<{ keys: Record<string, { date: string; author: string }> }>()).keys;
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, pubdate)
     VALUES (?, 'C930000', '1', 1, '試験作品', '試験作品', 'マスタ作者', '2015-08-04')`
  )
    .bind(MASTER)
    .run();
  // マスタに無い巻（新刊など）は楽天由来のキャッシュ。日付は表示用に整形済み、作者は "/" つなぎ。
  await env.DB.prepare(
    `INSERT OR REPLACE INTO book_meta (isbn, authors, publisher, pubdate, caption, checked_at)
     VALUES (?, '原作者/作画者', '試験社', '2019年10月4日', '', 0)`
  )
    .bind(META_ONLY)
    .run();
  // 抜け巻のライブ補完（src/gapFill.ts）。series_supplement_isbn はトリガで埋まる。
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_supplement (series_id, volumes_json, checked_at)
     VALUES (?, ?, 0)`
  )
    .bind(SUPP_SERIES, JSON.stringify([{ isbns: [SUPP], title: "補完作品", author: "補完作者", pubdate: "2001-03-09" }]))
    .run();
});

describe("POST /api/sort-keys", () => {
  it("マスタの発行日と作者を返す", async () => {
    const keys = await sortKeys([MASTER]);
    expect(keys[MASTER]).toEqual({ date: "2015-08-04", author: "マスタ作者" });
  });

  it("マスタに無い巻は book_meta から引き、日付は比較できる形に戻す", async () => {
    const keys = await sortKeys([META_ONLY]);
    expect(keys[META_ONLY]).toEqual({ date: "2019-10-04", author: "原作者、作画者" });
  });

  it("ライブ補完の巻も引ける", async () => {
    const keys = await sortKeys([SUPP]);
    expect(keys[SUPP]).toEqual({ date: "2001-03-09", author: "補完作者" });
  });

  it("どこにも無い ISBN は返さない（呼び出し側が末尾に回す）", async () => {
    const keys = await sortKeys([UNKNOWN, MASTER]);
    expect(keys[UNKNOWN]).toBeUndefined();
    expect(keys[MASTER]).toBeTruthy();
  });

  it("ISBN が空・不正でも 200 で空を返す", async () => {
    expect(await sortKeys([])).toEqual({});
    expect(await sortKeys(["not-an-isbn", "9784000000001"])).toEqual({});
  });
});

describe("isoPubdate", () => {
  it("精度のまちまちな表記を比較できる形に揃える", () => {
    expect(isoPubdate("2015-08-04")).toBe("2015-08-04");
    expect(isoPubdate("2015年8月4日")).toBe("2015-08-04");
    expect(isoPubdate("2019年10月")).toBe("2019-10");
    expect(isoPubdate("2020")).toBe("2020");
    expect(isoPubdate("")).toBe("");
    expect(isoPubdate(null)).toBe("");
    expect(isoPubdate("発売日未定")).toBe("");
  });
});
