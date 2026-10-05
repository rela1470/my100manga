import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findGapFillVolumes } from "../src/gapFill";
import { rakutenVolumeNumber } from "../src/rakuten";
import type { Env } from "../src/types";

// 抜け巻の穴埋め（src/gapFill.ts）。MADB に巻として載っているが schema:isbn が無いため
// 月次取り込みで落ちた巻を、楽天ブックスの書名検索で引き当てる経路。

describe("rakutenVolumeNumber", () => {
  it("楽天の書名表記から巻数を読む", () => {
    expect(rakutenVolumeNumber("三国志（11）")).toBe(11);
    expect(rakutenVolumeNumber("三国志（第27巻）")).toBe(27); // 26 巻までと 27 巻以降で表記が変わる
    expect(rakutenVolumeNumber("ゴルゴ13（222巻）")).toBe(222);
    expect(rakutenVolumeNumber("ONE PIECE 巻107")).toBe(107);
  });
  it("巻数が読めないものは null", () => {
    expect(rakutenVolumeNumber("三国志（全60巻セット）")).toBeNull();
    expect(rakutenVolumeNumber("改訂版　横山光輝「三国志」大百科")).toBeNull();
    expect(rakutenVolumeNumber("")).toBeNull();
  });
});

const SERIES = "C900001";
const OTHER = "C900002";
// 希望コミックス版の並び（既知 1〜3 巻 + 穴の 4 巻）。接頭辞が長く一致する。
const KNOWN = ["9784267901010", "9784267901027", "9784267901034"];
const RIGHT_V4 = "9784267901041";
// 同じ出版社の別版（文庫）。ISBN 接頭辞は 9784267 まで共通で、接頭辞だけでは分離できない。
const WRONG_V4 = "9784267014444";
// 5 巻の候補だが、master が既に別シリーズの巻として知っている ＝ 採ってはいけない。
const TAKEN_V5 = "9784267014451";

function rakutenItem(isbn: string, title: string, seriesName: string, salesDate: string) {
  return { Item: { isbn, title, seriesName, salesDate, publisherName: "潮出版社", largeImageUrl: "" } };
}

function mockUpstream() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/sparql")) {
      // MADB は 5 巻まで持っているが、4・5 巻には schema:isbn が無い。
      const bindings = [
        { vol: { value: "1" }, isbn: { value: KNOWN[0] }, date: { value: "1974-04" } },
        { vol: { value: "2" }, isbn: { value: KNOWN[1] }, date: { value: "1974-05" } },
        { vol: { value: "3" }, isbn: { value: KNOWN[2] }, date: { value: "1974-06" } },
        { vol: { value: "4" }, date: { value: "1974-07" } },
        { vol: { value: "5" }, date: { value: "1974-08" } },
      ];
      return new Response(JSON.stringify({ results: { bindings } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("openapi.rakuten.co.jp")) {
      return new Response(
        JSON.stringify({
          pageCount: 1,
          Items: [
            rakutenItem(WRONG_V4, "三国志（第4巻）", "潮漫画文庫", "1998年01月"),
            rakutenItem(RIGHT_V4, "三国志（4）", "希望コミックス　50", "1974年07月01日"),
            rakutenItem(TAKEN_V5, "三国志（5）", "潮漫画文庫", "1998年03月"),
          ],
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// 楽天の鍵が入っていない環境でも経路を通すため、鍵だけ差し替えた env を使う。
// RAKUTEN_LIMITER は無いので awaitSlot はそのまま通る（src/ratelimiter.ts）。
const testEnv = { ...env, RAKUTEN_APP_ID: "test-app", RAKUTEN_ACCESS_KEY: "test-key" } as unknown as Env;

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher, label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(SERIES, "三国志", "三国志", "三国志", "横山光輝", "潮出版社", "希望コミックス")
    .run();
  for (const [i, isbn] of KNOWN.entries()) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(isbn, SERIES, String(i + 1), i + 1, "三国志", "三国志", "横山光輝")
      .run();
  }
  // 別シリーズが既に握っている ISBN。
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(TAKEN_V5, OTHER, "5", 5, "三国志", "三国志", "横山光輝")
    .run();
});

afterEach(() => vi.restoreAllMocks());

function input() {
  return {
    seriesId: SERIES,
    name: "三国志",
    creator: "横山光輝",
    publisher: "潮出版社",
    label: "希望コミックス",
    knownIsbns: KNOWN,
    knownSorts: new Set([1, 2, 3]),
  };
}

describe("findGapFillVolumes", () => {
  it("ISBN の無い巻を楽天から引き当て、同じ版の候補を選ぶ", async () => {
    mockUpstream();
    const out = await findGapFillVolumes(testEnv, input());
    // 4 巻だけが埋まる。5 巻の候補は master が別シリーズの巻として知っているので落ちる。
    expect(out.filled.map((v) => v.vol_sort)).toEqual([4]);
    expect(out.filled[0].isbn).toBe(RIGHT_V4);
    expect(out.filled[0].volume_number).toBe("4");
  });

  it("master が既に持つ ISBN は、どのシリーズのものでも採らない", async () => {
    mockUpstream();
    const out = await findGapFillVolumes(testEnv, input());
    expect(out.filled.map((v) => v.isbn)).not.toContain(TAKEN_V5);
    // 文庫版は 4 巻の対抗馬として負ける
    expect(out.filled.map((v) => v.isbn)).not.toContain(WRONG_V4);
  });

  it("埋まらなかった穴は noIsbn で返す（追加ボタンを出さない根拠）", async () => {
    mockUpstream();
    const out = await findGapFillVolumes(testEnv, input());
    // 5 巻は MADB に在るが ISBN が無く、楽天の候補も採れなかった ＝ 足しようが無い。
    expect(out.noIsbn).toEqual([5]);
  });

  it("master に既にある巻は穴として扱わない", async () => {
    mockUpstream();
    const out = await findGapFillVolumes(testEnv, { ...input(), knownSorts: new Set([1, 2, 3, 4, 5]) });
    expect(out).toEqual({ filled: [], noIsbn: [] });
  });

  it("SPARQL が落ちたら何も返さない（既存の補完を壊さない）", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    // noIsbn は null ＝「判定できなかった」。[] （＝そんな巻は無い）と区別する: 呼び手が
    // 「ISBN が無いので追加できません」と誤って断定しないように。
    expect(await findGapFillVolumes(testEnv, input())).toEqual({ filled: [], noIsbn: null });
  });

  it("楽天の鍵が無ければ引き当てはしないが、ISBN の無い巻は返す（R18版）", async () => {
    // .dev.vars に鍵がある環境でも結果が変わらないよう、明示的に空にした env で見る。
    const noKeys = { ...env, RAKUTEN_APP_ID: "", RAKUTEN_ACCESS_KEY: "" } as unknown as Env;
    mockUpstream();
    const out = await findGapFillVolumes(noKeys, input());
    expect(out.filled).toEqual([]);
    expect(out.noIsbn).toEqual([4, 5]); // MADB だけで分かるので説明は出せる
    // 外部ストアの API は 1 回も叩かない（R18版の方針）。
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("openapi.rakuten.co.jp"))).toBe(false);
    expect(urls.some((u) => u.includes("/sparql"))).toBe(true);
  });
});
