import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleSortKeys, isoPubdate } from "../src/book";
import type { Env } from "../src/types";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 編集中リストの並べ替え（出版日順・作者順）が使う ISBN → 発行日/作者（POST /api/sort-keys）。
// リストの項目は発行日を持たないので、押されたときだけここで引く。出所はマスタ（volumes）→
// book_meta のキャッシュ → ライブ補完（series_supplement）→ それでも分からなければ楽天の
// exact-ISBN（詳細ポップアップと同じ）の順。

const [MASTER, META_ONLY, SUPP, UNKNOWN, LIVE, LIVE_NONE, NO_DATE] = makeIsbns(7, 930000);
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
  // 発行日だけ分からない巻（並べ替えの向きで楽天に回すかどうかが変わる）。
  await env.DB.prepare(
    `INSERT OR REPLACE INTO book_meta (isbn, authors, publisher, pubdate, caption, checked_at)
     VALUES (?, '作者だけ', '試験社', '', '', 0)`
  )
    .bind(NO_DATE)
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

// --- D1 のどこにも無い巻を楽天から引く（ISBN 検索から足した本など） ---
// SELF.fetch の env には楽天の鍵が入っていない（＝外部は叩かない）ので、鍵を足した env で
// ハンドラを直に呼ぶ。gapFill.test.ts と同じやり方。
const liveEnv = { ...env, RAKUTEN_APP_ID: "test-app", RAKUTEN_ACCESS_KEY: "test-key" } as unknown as Env;

function mockRakuten(): { calls: () => number } {
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("openapi.rakuten.co.jp")) throw new Error(`unexpected fetch: ${url}`);
    calls++;
    const isbn = new URL(url).searchParams.get("isbn");
    const Items =
      isbn === LIVE
        ? [{ Item: { isbn: LIVE, title: "楽天だけの巻 1", author: "原作者/作画者", publisherName: "試験社", salesDate: "2009年12月", itemCaption: "", largeImageUrl: "" } }]
        : [];
    return new Response(JSON.stringify({ Items }), { headers: { "content-type": "application/json" } });
  });
  return { calls: () => calls };
}

async function sortKeysLive(isbns: string[], field?: string) {
  const res = await handleSortKeys(
    new Request("https://example.com/api/sort-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns, ...(field ? { field } : {}) }),
    }),
    liveEnv
  );
  expect(res.status).toBe(200);
  return (await res.json<{ keys: Record<string, { date: string; author: string }> }>()).keys;
}

describe("POST /api/sort-keys（楽天への引き直し）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("マスタにも book_meta にも無い巻は楽天から引き、book_meta に残す", async () => {
    const rakuten = mockRakuten();
    expect(await sortKeysLive([LIVE])).toEqual({ [LIVE]: { date: "2009-12", author: "原作者、作画者" } });
    expect(rakuten.calls()).toBe(1);

    // 2 回目は book_meta のキャッシュで足りる（楽天を叩き直さない）。
    const again = mockRakuten();
    expect((await sortKeysLive([LIVE]))[LIVE]).toEqual({ date: "2009-12", author: "原作者、作画者" });
    expect(again.calls()).toBe(0);
  });

  it("既に分かっている巻は楽天を叩かない", async () => {
    const rakuten = mockRakuten();
    await sortKeysLive([MASTER, META_ONLY, SUPP]);
    expect(rakuten.calls()).toBe(0);
  });

  it("楽天にも無い巻は返さず、book_meta に空の行も作らない", async () => {
    mockRakuten();
    expect(await sortKeysLive([LIVE_NONE])).toEqual({});
    const row = await env.DB.prepare(`SELECT isbn FROM book_meta WHERE isbn = ?`).bind(LIVE_NONE).first();
    expect(row).toBeNull();
  });

  it("作者順では作者が分かっている巻を楽天に回さない", async () => {
    // 作者は分かるが発行日が無い巻（NO_DATE）。発行日順なら引き直すが、作者順では要らない。
    const rakuten = mockRakuten();
    expect((await sortKeysLive([NO_DATE], "author"))[NO_DATE].author).toBe("作者だけ");
    expect(rakuten.calls()).toBe(0);
    // 発行日順なら同じ巻でも引きに行く（楽天にも無いので分からないまま）。
    await sortKeysLive([NO_DATE], "date");
    expect(rakuten.calls()).toBe(1);
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
