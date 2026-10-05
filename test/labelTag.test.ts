import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import { adminListLabels, adminSetLabelTags } from "../src/labels";
import type { Env } from "../src/types";

// レーベルのタグ付け（廉価版・文庫版）。マスタにはこの区別が無いので、レーベル名を鍵にした
// label_tag に運営が付け、検索カード・巻一覧に印として出す。see src/labels.ts
//
// 検索と巻一覧はエッジキャッシュに乗る（鍵は表示データの世代）ので、表示の確認は
// beforeAll で付け終えた 1 つの状態に対してだけ行い、付け替えの確認は管理 API を
// 直接呼んで DB で見る。

const NAME = "テストレーベルサクヒン";
const CHEAP = "CL001"; // レーベル KPC（廉価版を付ける）
const BUNKO = "CL002"; // レーベル 講談社漫画文庫（文庫版を付ける）
const PLAIN = "CL003"; // レーベル テスト通常コミックス（タグなし）
const [A, B, C, LOOSE] = makeIsbns(4, 920000);
// どのシリーズにも属さない巻（series_id IS NULL）。シリーズ行が無いので検索・巻一覧の
// 本道（SERIES_COLS に畳み込んだ相関サブクエリ）では引けず、tagsForLabels を通る。
const LOOSE_NAME = "テストマイゴレーベルサクヒン";

const adminEnv = env as unknown as Env;

async function addSeries(id: string, label: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher, label, num_items)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(id, NAME, NAME, NAME, "レーベル作者", "レーベル社", label)
    .run();
}

async function addVolume(seriesId: string, isbn: string, label: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label)
     VALUES (?, ?, '1', 1, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, NAME, NAME, "レーベル作者", label)
    .run();
}

interface Card {
  series_id: string;
  label: string;
  label_tag: string;
}

async function listLabels(q = "", filter = "", era = "") {
  const res = await adminListLabels(adminEnv, q, filter, era);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    tags: string[];
    labels: { label: string; series_count: number; tag: string; samples: string }[];
    total: number;
    tagged: number;
    by_tag: Record<string, number>;
  };
}

async function setTags(body: Record<string, unknown>): Promise<Response> {
  return adminSetLabelTags(adminEnv, body);
}

async function tagOf(label: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT tag FROM label_tag WHERE label = ?`)
    .bind(label)
    .first<{ tag: string }>();
  return row?.tag ?? null;
}

async function addLooseVolume(isbn: string, label: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label)
     VALUES (?, NULL, '1', 1, ?, ?, ?, ?)`
  )
    .bind(isbn, LOOSE_NAME, LOOSE_NAME, "レーベル作者", label)
    .run();
}

beforeAll(async () => {
  await addSeries(CHEAP, "KPC");
  await addSeries(BUNKO, "講談社漫画文庫");
  await addSeries(PLAIN, "テスト通常コミックス");
  await addVolume(CHEAP, A, "KPC");
  await addVolume(BUNKO, B, "講談社漫画文庫");
  await addVolume(PLAIN, C, "テスト通常コミックス");
  await addLooseVolume(LOOSE, "KPC");
  await setTags({ labels: ["KPC", "講談社漫画文庫"], tag: "廉価版" });
  await setTags({ label: "講談社漫画文庫", tag: "文庫版" }); // 付け替え
});

describe("レーベルのタグが検索と巻一覧に出る", () => {
  it("検索カードがタグ付きのレーベルにだけ label_tag を返す", async () => {
    const res = await SELF.fetch(`https://example.com/api/search?q=${encodeURIComponent(NAME)}`, {
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Card[] };
    const byId = new Map(body.results.map((r) => [r.series_id, r]));
    expect(byId.get(CHEAP)).toMatchObject({ label: "KPC", label_tag: "廉価版" });
    expect(byId.get(BUNKO)).toMatchObject({ label: "講談社漫画文庫", label_tag: "文庫版" });
    expect(byId.get(PLAIN)).toMatchObject({ label: "テスト通常コミックス", label_tag: "" });
  });

  it("ISBN 検索のカードにも出る", async () => {
    const res = await SELF.fetch(`https://example.com/api/search?q=${A}`, {
      headers: { "user-agent": BROWSER_UA },
    });
    const body = (await res.json()) as { results: Card[] };
    expect(body.results[0]).toMatchObject({ series_id: CHEAP, label_tag: "廉価版" });
  });

  it("シリーズ無しの巻のまとまりにも出る（tagsForLabels 経由）", async () => {
    const res = await SELF.fetch(`https://example.com/api/search?q=${LOOSE}`, {
      headers: { "user-agent": BROWSER_UA },
    });
    const body = (await res.json()) as { results: (Card & { unlinked: boolean })[] };
    expect(body.results[0]).toMatchObject({
      series_id: `G${LOOSE}`,
      unlinked: true,
      label_tag: "廉価版",
    });
    // まとまりの巻一覧（G-id）でも同じ印が出る。
    const vols = await SELF.fetch(`https://example.com/api/series/G${LOOSE}/volumes`, {
      headers: { "user-agent": BROWSER_UA },
    });
    expect((await vols.json()) as { label_tag: string }).toMatchObject({ label_tag: "廉価版" });
  });

  it("巻一覧（検索を経由せず開いたとき）にも出る", async () => {
    const res = await SELF.fetch(`https://example.com/api/series/${BUNKO}/volumes`, {
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { label_tag: string }).toMatchObject({ label_tag: "文庫版" });
  });
});

describe("管理画面のレーベル一覧", () => {
  it("シリーズ数の多い順に、現在のタグと主な作品を返す", async () => {
    const data = await listLabels();
    expect(data.tags).toEqual(["廉価版", "文庫版", "傑作選"]);
    const byLabel = new Map(data.labels.map((l) => [l.label, l]));
    expect(byLabel.get("KPC")).toMatchObject({
      series_count: 1,
      tag: "廉価版",
      samples: NAME,
      publisher: "レーベル社",
      publisher_n: 1,
    });
    expect(byLabel.get("テスト通常コミックス")?.tag).toBe("");
    expect(data.total).toBe(3);
    expect(data.tagged).toBe(2);
    // 使っていないタグも 0 で返す（管理画面の内訳表示が欠けないように）。
    expect(data.by_tag).toEqual({ 廉価版: 1, 文庫版: 1, 傑作選: 0 });
  });

  it("?q= はレーベル名の部分一致", async () => {
    const data = await listLabels("文庫");
    expect(data.labels.map((l) => l.label)).toEqual(["講談社漫画文庫"]);
    expect(data.total).toBe(1);
  });

  it("?filter= で未設定・設定済み・タグ名に絞れる", async () => {
    expect((await listLabels("", "untagged")).labels.map((l) => l.label)).toEqual(["テスト通常コミックス"]);
    expect((await listLabels("", "tagged")).labels.map((l) => l.label).sort()).toEqual(
      ["KPC", "講談社漫画文庫"].sort()
    );
    expect((await listLabels("", "文庫版")).labels.map((l) => l.label)).toEqual(["講談社漫画文庫"]);
    // 知らない filter は絞り込み無し扱い（全件）。
    expect((await listLabels("", "でたらめ")).total).toBe(3);
  });

  it("シリーズを 1 つも持たないレーベルでも、タグが付いていれば一覧に出る（外せる）", async () => {
    await setTags({ label: "巻にしかないレーベル", tag: "廉価版" });
    const data = await listLabels("巻にしかない");
    expect(data.labels).toEqual([
      {
        label: "巻にしかないレーベル",
        series_count: 0,
        tag: "廉価版",
        samples: "",
        publisher: "",
        publisher_n: 0,
        year_from: "",
        year_to: "",
      },
    ]);
    await setTags({ label: "巻にしかないレーベル", tag: "" });
    expect((await listLabels("巻にしかない")).total).toBe(0);
  });
});

// 「文庫」で引くと、判型ではなく叢書の意味で「〜文庫」と名乗っていた昭和の貸本・児童書の
// 線（マスタに発行年が 1 つも無い）が混ざる。一括付与の前に外せるよう、発行年の範囲を列で
// 出し、?era= で絞れるようにしてある。
describe("発行年の範囲と ?era= の絞り込み", () => {
  const DATED = "試験文庫あり";
  const UNDATED = "試験文庫なし";

  beforeAll(async () => {
    await addSeries("CY001", DATED);
    await addSeries("CY002", UNDATED);
    const [d1, d2, u1] = makeIsbns(3, 930000);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label, pubdate)
       VALUES (?, 'CY001', '1', 1, ?, ?, '作者', ?, '1994-12')`
    ).bind(d1, NAME, NAME, DATED).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label, pubdate)
       VALUES (?, 'CY001', '2', 2, ?, ?, '作者', ?, '2018-03')`
    ).bind(d2, NAME, NAME, DATED).run();
    // 発行年が空の巻だけを持つ＝貸本・児童書の線の形。
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label, pubdate)
       VALUES (?, 'CY002', '1', 1, ?, ?, '作者', ?, '')`
    ).bind(u1, NAME, NAME, UNDATED).run();
  });

  it("発行年の最小・最大を年 4 桁で返す", async () => {
    const byLabel = new Map((await listLabels("試験文庫")).labels.map((l) => [l.label, l]));
    expect(byLabel.get(DATED)).toMatchObject({ year_from: "1994", year_to: "2018" });
    // 1 冊も日付が無ければ空（画面は「年なし」と出す）。
    expect(byLabel.get(UNDATED)).toMatchObject({ year_from: "", year_to: "" });
  });

  it("?era=dated / undated で分けられる", async () => {
    expect((await listLabels("試験文庫", "", "dated")).labels.map((l) => l.label)).toEqual([DATED]);
    expect((await listLabels("試験文庫", "", "undated")).labels.map((l) => l.label)).toEqual([UNDATED]);
    expect((await listLabels("試験文庫", "", "")).total).toBe(2);
    // 知らない era は絞り込み無し扱い。
    expect((await listLabels("試験文庫", "", "でたらめ")).total).toBe(2);
  });

  it("ページ送りはせず、該当を全部返す（truncated は偽）", async () => {
    const data = await listLabels();
    expect(data.labels.length).toBe(data.total);
    expect(data.truncated).toBe(false);
    expect(data.shown).toBe(data.total);
  });
});

describe("管理画面のタグ付け", () => {
  it("まとめて設定・解除できる", async () => {
    const res = await setTags({ labels: ["まとめA", "まとめB", "まとめA"], tag: "文庫版" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 2, tag: "文庫版" });
    expect(await tagOf("まとめA")).toBe("文庫版");
    expect(await tagOf("まとめB")).toBe("文庫版");

    await setTags({ labels: ["まとめA", "まとめB"], tag: "" });
    expect(await tagOf("まとめA")).toBeNull();
    expect(await tagOf("まとめB")).toBeNull();
  });

  it("レーベル名の前後の空白は落とす（マスタの値そのものが鍵）", async () => {
    await setTags({ label: "  空白つき  ", tag: "廉価版" });
    expect(await tagOf("空白つき")).toBe("廉価版");
    await setTags({ label: "空白つき", tag: "" });
  });

  it("傑作選も設定できる（LABEL_TAGS に足すだけで通る）", async () => {
    expect((await setTags({ label: "ジャンプコミックスセレクション", tag: "傑作選" })).status).toBe(200);
    expect(await tagOf("ジャンプコミックスセレクション")).toBe("傑作選");
    expect((await listLabels("", "傑作選")).labels.map((l) => l.label)).toEqual([
      "ジャンプコミックスセレクション",
    ]);
    await setTags({ label: "ジャンプコミックスセレクション", tag: "" });
  });

  it("不明なタグ・空のレーベルは 400", async () => {
    expect((await setTags({ label: "何か", tag: "新装版" })).status).toBe(400);
    expect((await setTags({ label: "   " })).status).toBe(400);
    expect((await setTags({ labels: [] , tag: "廉価版" })).status).toBe(400);
    expect(await tagOf("何か")).toBeNull();
  });

  // 上限は一覧が 1 回に返す件数（MAX_ROWS）と同じにしてある。画面に出ている分は
  // 必ず一度に設定できて、それ以上は弾く。
  it("一度に 1,000 件を超える指定は 400（1 件も書かない）", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `多すぎ${i}`);
    expect((await setTags({ labels: many, tag: "廉価版" })).status).toBe(400);
    expect(await tagOf("多すぎ0")).toBeNull();
  });

  it("1,000 件ちょうどは通る（D1 へは小分けに流す）", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `大量${i}`);
    const res = await setTags({ labels: many, tag: "文庫版" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1000 });
    expect(await tagOf("大量0")).toBe("文庫版");
    expect(await tagOf("大量999")).toBe("文庫版");
    await setTags({ labels: many, tag: "" });
    expect(await tagOf("大量0")).toBeNull();
  });
});
