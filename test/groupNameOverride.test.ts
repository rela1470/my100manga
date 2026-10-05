import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import { adminListNameOverrides, adminListSeriesReports, adminOverrideSeriesName } from "../src/admin";
import { bumpViewEpoch } from "../src/viewSnapshot";
import type { Env } from "../src/types";

// シリーズに属さない巻のまとまり（G-id, src/groups.ts）の名前の修正。まとまりの名前は巻の
// 書名そのものなので、マスタが書名を壊していると（「Dr.スランプ」が「Dr」）直す手段が無かった。
// シリーズ名の通報（collect-only）と管理者の「名前を修正」（series_name_override）を、series 行の
// 無いまとまりにも通し、まとまりの正規 ID（G + 最小 ISBN）で記録する。

const adminEnv = env as unknown as Env;
const page = { page: 1, per: 100, offset: 0 };

const CREATOR = "試験名前作者";
const LABEL = "試験ネームコミックス";
const BAD = "試験ドクタ"; // マスタが壊した書名 = まとまりの名前
const FIXED = "試験ドクターすらんぷ";
const [V1, V2, V3] = makeIsbns(3, 952000); // 正規 ID は最小の V1
const ID = "G" + V1;

async function addVolume(isbn: string, volume: string, title: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate)
     VALUES (?, NULL, ?, ?, ?, ?, ?, '試験社', ?, ?)`
  )
    .bind(isbn, volume, Number(volume), title, title, CREATOR, LABEL, "1980-0" + volume)
    .run();
}

function report(groupId: string, suggested?: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/series/${groupId}/report`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify(suggested === undefined ? {} : { suggested_name: suggested }),
  });
}

async function reportRow(id: string) {
  return env.DB.prepare(
    `SELECT reported_name, suggested_name, report_count FROM series_report WHERE series_id = ?`
  )
    .bind(id)
    .first<{ reported_name: string; suggested_name: string; report_count: number }>();
}

async function groupTitle(isbn: string): Promise<string> {
  const res = await SELF.fetch(`https://example.com/api/series/G${isbn}/volumes`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { title: string }).title;
}

function overrideRequest(name: string): Request {
  return new Request("https://example.com/api/admin/series-reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

beforeAll(async () => {
  await addVolume(V1, "1", BAD);
  await addVolume(V2, "2", BAD);
  await addVolume(V3, "3", BAD);
});

describe("まとまりのシリーズ名の通報と修正", () => {
  it("まとまりのどの巻の G-id から通報しても正規 ID に記録される", async () => {
    // 2 巻（正規 ID ではない）の G-id から通報する。
    const res = await report("G" + V2, FIXED);
    expect(res.status).toBe(200);
    const row = await reportRow(ID);
    expect(row?.reported_name).toBe(BAD); // 通報者に見えている名前（= まとまりの名前）
    expect(row?.suggested_name).toBe(FIXED);
    expect(row?.report_count).toBe(1);
    expect(await reportRow("G" + V2)).toBeNull();
  });

  it("管理画面の通報一覧に、まとまりの現在名とヒントが出る", async () => {
    const res = await adminListSeriesReports(adminEnv, page);
    const body = (await res.json()) as { reports: { series_id: string; current_name: string; display_name: string; vol_title: string }[] };
    const r = body.reports.find((x) => x.series_id === ID);
    // series 行が無いので、現在名・ヒントはまとまりの巻の書名で代用する（空にしない）。
    expect(r?.current_name).toBe(BAD);
    expect(r?.display_name).toBe(BAD);
    expect(r?.vol_title).toBe(BAD);
  });

  it("名前を修正すると全閲覧者の巻一覧・検索に反映され、通報は片付く", async () => {
    // 管理者は通報された ID（ここでは正規 ID ではない 2 巻の G-id）からでも直せる。
    const res = await adminOverrideSeriesName(overrideRequest(FIXED), adminEnv, "G" + V2);
    expect(res.status).toBe(200);
    expect((await res.json()) as { series_id: string }).toMatchObject({ series_id: ID });

    const o = await env.DB.prepare(`SELECT name FROM series_name_override WHERE series_id = ?`)
      .bind(ID)
      .first<{ name: string }>();
    expect(o?.name).toBe(FIXED);
    expect(await reportRow(ID)).toBeNull();

    await bumpViewEpoch(env); // 本番は admin の更新系 API 成功後に index.ts が上げる
    expect(await groupTitle(V1)).toBe(FIXED);
    expect(await groupTitle(V3)).toBe(FIXED); // どの巻の G-id で開いても同じ名前

    // 検索の結果カードにも出る。マスタの書名（壊れたまま）での検索は引き続き当たる。
    const s = await SELF.fetch(`https://example.com/api/search?q=${encodeURIComponent(BAD)}`, {
      headers: { "user-agent": BROWSER_UA },
    });
    const found = ((await s.json()) as { results: { series_id: string; title: string }[] }).results.find(
      (x) => x.series_id === ID
    );
    expect(found?.title).toBe(FIXED);
  });

  it("修正後の通報は、閲覧者に見えている修正後の名前を記録する", async () => {
    const res = await report(ID);
    expect(res.status).toBe(200);
    expect((await reportRow(ID))?.reported_name).toBe(FIXED);
    // 修正済みの名前と同じ提案は受け付けない（提案は任意なので空のままなら通る）。
    expect((await report(ID, FIXED)).status).toBe(400);
  });

  it("修正履歴に、まとまりの現在のマスタ名が出る", async () => {
    const res = await adminListNameOverrides(adminEnv, page);
    const body = (await res.json()) as { overrides: { series_id: string; name: string; current_name: string }[] };
    const o = body.overrides.find((x) => x.series_id === ID);
    expect(o?.name).toBe(FIXED);
    expect(o?.current_name).toBe(BAD);
  });
});
