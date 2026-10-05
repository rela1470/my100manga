import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findGapFillVolumes } from "../src/gapFill";
import { getSeriesVolumes } from "../src/series";
import { rakutenVolumeNumber } from "../src/rakuten";
import { yahooNameIsVolume } from "../src/yahoo";
import type { Env } from "../src/types";

// 抜け巻の穴埋め（src/gapFill.ts）。MADB に巻として載っているが schema:isbn が無いため
// 月次取り込みで落ちた巻を、楽天ブックスの書名検索と Yahoo!ショッピングの商品名検索で
// 引き当てる経路。

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
// 5 巻の正解。楽天ブックス（新刊書店）には無く、Yahoo の中古出品にだけ JAN がある。
const RIGHT_V5 = "9784267901058";

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
    if (url.includes("shopping.yahooapis.jp")) {
      // 5 巻で引いたときだけ中古出品が 2 件。片方は別シリーズが握っている文庫版。
      const hits = new URL(url).searchParams.get("query") === "三国志 5"
        ? [
            { janCode: TAKEN_V5, name: "三国志 5／横山光輝" },
            { janCode: RIGHT_V5, name: "中古少年コミック 三国志(5) / 横山光輝" },
          ]
        : [];
      return new Response(JSON.stringify({ hits }), {
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
// Yahoo の鍵まで入れた env。楽天で埋まらなかった巻だけが Yahoo に回る。
const yahooEnv = { ...testEnv, YAHOO_APP_ID: "test-yahoo" } as unknown as Env;

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

  it("どちらのストアでも引けなかった穴は noIsbn で返す", async () => {
    mockUpstream();
    const out = await findGapFillVolumes(testEnv, input());
    // Yahoo の鍵が無い env なので 5 巻は埋まらない。「ISBN が存在しない」ではなく
    // 「見つけられなかった」の印として返す（public/app.js はこれで文言を変えるだけで、
    // ISBN の直接指定の導線は消さない）。
    expect(out.noIsbn).toEqual([5]);
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("shopping.yahooapis.jp"))).toBe(false);
  });

  it("楽天に無い巻を Yahoo の中古出品から引き当てる", async () => {
    mockUpstream();
    const out = await findGapFillVolumes(yahooEnv, input());
    expect(out.filled.map((v) => v.vol_sort)).toEqual([4, 5]);
    // 5 巻は Yahoo 由来。同じ巻に並んだ文庫版（master が別シリーズで握っている）は落ち、
    // master の ISBN と接頭辞が長く一致する希望コミックス版が残る。
    const v5 = out.filled.find((v) => v.vol_sort === 5)!;
    expect(v5.isbn).toBe(RIGHT_V5);
    expect(v5.volume_number).toBe("5");
    expect(v5.pubdate).toBe("1974-08"); // Yahoo は刊行日を持たないので MADB の日付
    expect(out.noIsbn).toEqual([]);
  });

  it("Yahoo で引くのは楽天で埋まらなかった巻だけ", async () => {
    mockUpstream();
    await findGapFillVolumes(yahooEnv, input());
    const queries = vi
      .mocked(globalThis.fetch)
      .mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("shopping.yahooapis.jp"));
    // 4 巻は楽天で埋まっているので投げない。
    expect(queries).toHaveLength(1);
    expect(new URL(queries[0]).searchParams.get("query")).toBe("三国志 5");
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
    const noKeys = { ...env, RAKUTEN_APP_ID: "", RAKUTEN_ACCESS_KEY: "", YAHOO_APP_ID: "" } as unknown as Env;
    mockUpstream();
    const out = await findGapFillVolumes(noKeys, input());
    expect(out.filled).toEqual([]);
    expect(out.noIsbn).toEqual([4, 5]); // MADB だけで分かるので説明は出せる
    // 外部ストアの API は 1 回も叩かない（R18版の方針）。
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("openapi.rakuten.co.jp"))).toBe(false);
    expect(urls.some((u) => u.includes("shopping.yahooapis.jp"))).toBe(false);
    expect(urls.some((u) => u.includes("/sparql"))).toBe(true);
  });
});

// Yahoo の商品名は出品者が書くので、巻を名乗っているかの判定が精度の要になる。
// 下の文字列は実際の出品名（「釣りキチ三平」を Yahoo!ショッピングで引いたときのもの）。
describe("yahooNameIsVolume", () => {
  it("シリーズ名の直後がその巻数なら通す", () => {
    expect(yahooNameIsVolume("釣りキチ三平 26／矢口高雄", "釣りキチ三平", 26)).toBe(true);
    expect(yahooNameIsVolume("中古少年コミック 釣りキチ三平(7)", "釣りキチ三平", 7)).toBe(true);
    expect(yahooNameIsVolume("中古少年コミック 釣りキチ三平(12) / 矢口高雄", "釣りキチ三平", 12)).toBe(true);
  });

  it("別の巻・別の作品は落とす", () => {
    expect(yahooNameIsVolume("釣りキチ三平 45／矢口高雄", "釣りキチ三平", 10)).toBe(false);
    expect(yahooNameIsVolume("バーサス魚紳さん！　　　１ / 立沢　克美　画", "釣りキチ三平", 1)).toBe(false);
  });

  it("別版・別編は巻数の前後に余計な語が付くので落とす", () => {
    expect(yahooNameIsVolume("釣りキチ三平 平成版 2／矢口高雄", "釣りキチ三平", 2)).toBe(false);
    expect(yahooNameIsVolume("釣りキチ三平 (3)−おもしろ釣り編− 1／矢口高雄", "釣りキチ三平", 3)).toBe(false);
    expect(yahooNameIsVolume("釣りキチ三平(スペシャル版)(14) KCスペシャル/矢口高雄", "釣りキチ三平", 14)).toBe(false);
    expect(yahooNameIsVolume("釣りキチ三平−海釣りselection− 5／矢口高雄", "釣りキチ三平", 5)).toBe(false);
    expect(yahooNameIsVolume("『釣りキチ三平生誕５０周年特別版　Ｏ池の滝太郎』矢口高雄", "釣りキチ三平", 50)).toBe(false);
  });

  it("全巻セット・まとめ売りは代表1冊の JAN しか無いので落とす", () => {
    expect(yahooNameIsVolume("[中古]釣りキチ三平 (1-39巻 全巻) 全巻セット", "釣りキチ三平", 1)).toBe(false);
    expect(yahooNameIsVolume("★釣りキチ三平/漫画全巻セット◆C≪全65巻（完結）≫", "釣りキチ三平", 65)).toBe(false);
  });
});

// 押すたびに積み上がること（src/series.ts の filledSorts）。Yahoo は 1 巻 1 リクエストで、
// 1 回の押下で引ける巻数には上限があるので、前回埋めた巻を穴から外さないと毎回同じ先頭の巻を
// 引き直して先へ進まない。実際に dev で 3・7・12・13 巻から先に進まなくなった。
describe("取得を押すたびに次の巻へ進む", () => {
  const ACC = "C900003";
  const V1 = "9784267902017"; // master が持つ 1 巻
  const V2 = "9784267902024"; // 1 回目の押下で Yahoo から埋まる 2 巻

  function mockForAcc(): string[] {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/sparql")) {
        // シリーズノードへの厳密結合（穴の確定）だけ答える。書名一致の補完は使わない。
        const bindings = decodeURIComponent(url).includes("isPartOf")
          ? [
              { vol: { value: "1" }, isbn: { value: V1 }, date: { value: "1974-04" } },
              { vol: { value: "2" }, date: { value: "1974-05" } },
              { vol: { value: "3" }, date: { value: "1974-06" } },
            ]
          : [];
        return new Response(JSON.stringify({ results: { bindings } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openapi.rakuten.co.jp")) {
        return new Response(JSON.stringify({ pageCount: 1, Items: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("shopping.yahooapis.jp")) {
        const q = new URL(url).searchParams.get("query")!;
        asked.push(q);
        // 2 巻にだけ中古出品がある。3 巻はどちらのストアにも無い。
        const hits = q.endsWith(" 2") ? [{ janCode: V2, name: `積み上げ試験 2／作者` }] : [];
        return new Response(JSON.stringify({ hits }), { headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    return asked;
  }

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(ACC, "積み上げ試験", "積み上げ試験", "積み上げ試験", "作者", "潮出版社")
      .run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(V1, ACC, "1", 1, "積み上げ試験", "積み上げ試験", "作者")
      .run();
  });

  it("前回埋めた巻は 2 回目の押下で引き直さない", async () => {
    const asked = mockForAcc();
    await getSeriesVolumes(yahooEnv, ACC, true);
    expect(asked).toEqual(["積み上げ試験 2", "積み上げ試験 3"]);

    asked.length = 0;
    const res = await getSeriesVolumes(yahooEnv, ACC, true);
    // 2 巻は前回の補完で埋まっている ＝ もう穴ではない。残り枠は 3 巻に回る。
    expect(asked).toEqual(["積み上げ試験 3"]);
    const body = (await res.json()) as { volumes: { isbn: string }[]; volumes_no_isbn: number[] };
    expect(body.volumes.map((v) => v.isbn)).toEqual([V1, V2]);
    // 埋まった 2 巻は「見つからなかった」側に残らない。
    expect(body.volumes_no_isbn).toEqual([3]);
  });
});
