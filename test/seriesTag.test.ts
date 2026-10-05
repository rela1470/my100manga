import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import {
  adminConfirmSeriesTagRequest,
  adminDismissSeriesTagRequest,
  adminListSeriesTagRequests,
  adminSetSeriesTag,
  adminSetLabelTags,
  effectiveTagSql,
} from "../src/labels";
import type { Env } from "../src/types";

// シリーズ個別のタグ（series_tag）と、その利用者申請（series_tag_request）。
// レーベル単位のタグ（label_tag）より優先し、tag = '' は「タグ無し」を明示する上書きで
// レーベル由来の印を打ち消す。申請は collect-only（件数を積むだけ、反映は管理者の確定後）。

const NAME = "テストコベツタグサクヒン";
const LABEL = "試験文庫"; // beforeAll で「文庫版」を付けるレーベル

const adminEnv = env as unknown as Env;
const page = { page: 1, per: 50, offset: 0 };

// 巻一覧と検索はエッジキャッシュに乗る（60 秒 / 1 時間、鍵は表示データの世代）。テストは
// 管理関数を直接呼ぶので世代が上がらず、同じシリーズを 2 回読むと前の応答が返ってしまう。
// ケースごとに新しいシリーズを作って、毎回「初めて読む ID」にする。
let seq = 0;
const isbns = makeIsbns(60, 940000);

async function newSeries(label = LABEL): Promise<string> {
  const id = `CT${String(++seq).padStart(3, "0")}`;
  const isbn = isbns[seq];
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher, label, num_items)
     VALUES (?, ?, ?, ?, '作者', '出版社', ?, 1)`
  ).bind(id, NAME, NAME, NAME, label).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label)
     VALUES (?, ?, '1', 1, ?, ?, '作者', ?)`
  ).bind(isbn, id, NAME, NAME, label).run();
  return id;
}

function request(seriesId: string, tag: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com/api/series/${seriesId}/tag-request`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify({ tag }),
  });
}

async function cardTag(seriesId: string): Promise<string> {
  const res = await SELF.fetch(`https://example.com/api/series/${seriesId}/volumes`, {
    headers: { "user-agent": BROWSER_UA },
  });
  return ((await res.json()) as { label_tag: string }).label_tag;
}

/** D1 から直接読む実効タグ（src/labels.ts effectiveTagSql と同じ優先順）。
 *  同じシリーズを 2 回読むケースで、エッジキャッシュを介さずに確かめるために使う。 */
async function effectiveTag(seriesId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT ${effectiveTagSql("s")} AS tag FROM series s WHERE s.id = ?`
  )
    .bind(seriesId)
    .first<{ tag: string | null }>();
  return row?.tag ?? "";
}

async function queue() {
  const res = await adminListSeriesTagRequests(adminEnv, page);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    tags: string[];
    requests: { series_id: string; tag: string; report_count: number; current_tag: string; current_from: string }[];
    total: number;
  };
}

beforeAll(async () => {
  await adminSetLabelTags(adminEnv, { label: LABEL, tag: "文庫版" });
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM series_tag`),
    env.DB.prepare(`DELETE FROM series_tag_request`),
  ]);
});

describe("レーベルより個別のタグが優先される", () => {
  it("個別の指定が無ければレーベルのタグが出る", async () => {
    expect(await cardTag(await newSeries())).toBe("文庫版");
    expect(await cardTag(await newSeries(""))).toBe("");
  });

  it("個別に別のタグを付けるとそちらが勝つ", async () => {
    const mine = await newSeries();
    const sibling = await newSeries(); // 同じレーベルの別シリーズ
    await adminSetSeriesTag(adminEnv, { series_id: mine, tag: "傑作選" });
    expect(await cardTag(mine)).toBe("傑作選");
    expect(await cardTag(sibling)).toBe("文庫版"); // 巻き込まれない
  });

  it("個別に「タグ無し」を指定するとレーベルの印を打ち消す", async () => {
    const mine = await newSeries();
    const sibling = await newSeries();
    await adminSetSeriesTag(adminEnv, { series_id: mine, tag: "" });
    expect(await cardTag(mine)).toBe("");
    expect(await cardTag(sibling)).toBe("文庫版");
  });

  it("レーベル無しのシリーズにも個別に付けられる", async () => {
    const id = await newSeries("");
    await adminSetSeriesTag(adminEnv, { series_id: id, tag: "廉価版" });
    expect(await cardTag(id)).toBe("廉価版");
  });

  it("個別指定を外すとレーベル由来に戻る", async () => {
    const id = await newSeries();
    await adminSetSeriesTag(adminEnv, { series_id: id, tag: "" });
    expect(await cardTag(id)).toBe("");
    await adminSetSeriesTag(adminEnv, { series_id: id }); // tag を省略 = 上書きを外す
    // 同じ ID の巻一覧はキャッシュに乗っているので、ここは D1 の実効値で見る。
    expect(await effectiveTag(id)).toBe("文庫版");
  });

  it("検索カードにも同じ優先順で出る", async () => {
    const PLAIN = await newSeries();
    const OTHER = await newSeries();
    const NOLABEL = await newSeries("");
    await adminSetSeriesTag(adminEnv, { series_id: OTHER, tag: "傑作選" });
    const res = await SELF.fetch(`https://example.com/api/search?q=${encodeURIComponent(NAME)}`, {
      headers: { "user-agent": BROWSER_UA },
    });
    const body = (await res.json()) as { results: { series_id: string; label_tag: string }[] };
    const byId = new Map(body.results.map((r) => [r.series_id, r.label_tag]));
    expect(byId.get(OTHER)).toBe("傑作選");
    expect(byId.get(PLAIN)).toBe("文庫版");
    expect(byId.get(NOLABEL)).toBe("");
  });
});

describe("利用者からの申請（collect-only）", () => {
  let PLAIN = "";
  beforeEach(async () => {
    PLAIN = await newSeries();
  });

  it("申請しても表示は変わらない。件数だけ積む", async () => {
    expect((await request(PLAIN, "廉価版")).status).toBe(200);
    expect((await request(PLAIN, "廉価版")).status).toBe(200);
    expect(await cardTag(PLAIN)).toBe("文庫版"); // 反映されていない

    const q = await queue();
    expect(q.total).toBe(1);
    expect(q.requests[0]).toMatchObject({
      series_id: PLAIN,
      tag: "廉価版",
      report_count: 2,
      current_tag: "文庫版",
      current_from: "label",
    });
  });

  it("同じシリーズに別のタグが申請されたら別の行になる", async () => {
    await request(PLAIN, "廉価版");
    await request(PLAIN, "傑作選");
    const q = await queue();
    expect(q.total).toBe(2);
    expect(q.requests.map((r) => r.tag).sort()).toEqual(["傑作選", "廉価版"]);
  });

  it("「ついている印を外して」も申請できる（tag = \"\"）", async () => {
    expect((await request(PLAIN, "")).status).toBe(200);
    expect((await queue()).requests[0]).toMatchObject({ tag: "", report_count: 1 });
  });

  it("知らないタグ・存在しないシリーズは弾く", async () => {
    expect((await request(PLAIN, "新装版")).status).toBe(400);
    expect((await request(PLAIN, 42)).status).toBe(400);
    expect((await request("CT999", "廉価版")).status).toBe(404);
    expect((await queue()).total).toBe(0);
  });
});

describe("管理者の確定と却下", () => {
  let PLAIN = "";
  beforeEach(async () => {
    PLAIN = await newSeries();
  });

  it("確定すると個別のタグが決まり、そのシリーズの申請は全部片付く", async () => {
    await request(PLAIN, "廉価版");
    await request(PLAIN, "傑作選");
    const res = await adminConfirmSeriesTagRequest(adminEnv, PLAIN, { tag: "廉価版" });
    expect(res.status).toBe(200);
    expect(await cardTag(PLAIN)).toBe("廉価版");
    expect((await queue()).total).toBe(0);
  });

  it("申請と違うタグでも確定できる（誤申請をその場で直す）", async () => {
    await request(PLAIN, "廉価版");
    await adminConfirmSeriesTagRequest(adminEnv, PLAIN, { tag: "傑作選" });
    expect(await cardTag(PLAIN)).toBe("傑作選");
  });

  it("却下は申請を消すだけで、表示は変えない", async () => {
    await request(PLAIN, "廉価版");
    const res = await adminDismissSeriesTagRequest(adminEnv, PLAIN);
    expect(res.status).toBe(200);
    expect(await cardTag(PLAIN)).toBe("文庫版");
    expect((await queue()).total).toBe(0);
  });

  it("確定のタグが不正なら 400（書き込まない）", async () => {
    await request(PLAIN, "廉価版");
    expect((await adminConfirmSeriesTagRequest(adminEnv, PLAIN, { tag: "新装版" })).status).toBe(400);
    expect(await cardTag(PLAIN)).toBe("文庫版");
    expect((await queue()).total).toBe(1);
  });

  it("直接設定は存在しないシリーズを弾く", async () => {
    expect((await adminSetSeriesTag(adminEnv, { series_id: "CT999", tag: "廉価版" })).status).toBe(404);
    expect((await adminSetSeriesTag(adminEnv, { series_id: "", tag: "廉価版" })).status).toBe(400);
  });
});
