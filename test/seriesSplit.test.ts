import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import { adminSplitSeries, adminSplitSourceVolumes } from "../src/merge";
import type { Env } from "../src/types";

// シリーズの分離（「別の版が混ざっている？」の依頼と、管理者の分離）。巻一覧はマスタの巻に加えて
// シリーズ ID を失った迷子巻（series_id NULL）を書名で寄せて出すので、迷子巻も分離の対象にする。
// 実例: C302126 新仮面ライダーSPIRITS に寄っている「ロンリー仮面ライダー編 1」9784065429808 は
// series_id NULL で、依頼が「マスターの巻ではありません」で弾かれていた。

const SERIES = "C810001";
const NAME = "ブンリシケンサクヒン";
const [V1, V2, LOOSE] = makeIsbns(3, 810000);
const adminEnv = env as unknown as Env;

async function addVolume(isbn: string, seriesId: string | null, volumeNumber: string, sort: number) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label)
     VALUES (?, ?, ?, ?, ?, ?, '作者', '試験コミックス')`
  )
    .bind(isbn, seriesId, volumeNumber, sort, NAME, NAME)
    .run();
}

function splitRequest(isbns: string[]): Promise<Response> {
  return SELF.fetch(`https://example.com/api/series/${SERIES}/split-request`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify({ isbns }),
  });
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher, label, num_items)
     VALUES (?, ?, ?, ?, '作者', '出版社', '試験コミックス', 2)`
  )
    .bind(SERIES, NAME, NAME, NAME)
    .run();
  await addVolume(V1, SERIES, "1", 1);
  await addVolume(V2, SERIES, "2", 2);
  await addVolume(LOOSE, null, "別編 1", 1);
});

describe("シリーズの分離と迷子巻", () => {
  it("巻一覧が寄せている迷子巻を別の版として依頼できる", async () => {
    const vols = await SELF.fetch(`https://example.com/api/series/${SERIES}/volumes`, {
      headers: { "user-agent": BROWSER_UA },
    });
    const isbns = ((await vols.json()) as { volumes: { isbn: string }[] }).volumes.map((v) => v.isbn);
    expect(isbns).toContain(LOOSE);

    const res = await splitRequest([LOOSE]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, count: 1 });
    const row = await env.DB.prepare(`SELECT report_count FROM series_split_request WHERE series_id = ? AND isbn = ?`)
      .bind(SERIES, LOOSE)
      .first<{ report_count: number }>();
    expect(row?.report_count).toBe(1);
  });

  it("全巻（迷子巻を含む）を選んだ依頼は弾く", async () => {
    const res = await splitRequest([V1, V2, LOOSE]);
    expect(res.status).toBe(400);
  });

  it("分離の画面に迷子巻が series_id null で出て、分離すると独自シリーズへ移る", async () => {
    const src = (await (await adminSplitSourceVolumes(adminEnv, SERIES)).json()) as {
      volumes: { isbn: string; series_id: string | null; report_count: number }[];
    };
    expect(src.volumes.map((v) => v.isbn).sort()).toEqual([V1, V2, LOOSE].sort());
    expect(src.volumes.find((v) => v.isbn === LOOSE)).toMatchObject({ series_id: null, report_count: 1 });

    const res = await adminSplitSeries(
      new Request("https://example.com/api/admin/series-splits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source_id: SERIES, isbns: [LOOSE], name: `${NAME} 別編` }),
      }),
      adminEnv
    );
    expect(res.status).toBe(200);
    const { created_series } = (await res.json()) as { created_series: string };
    const vol = await env.DB.prepare(`SELECT series_id FROM volumes WHERE isbn = ?`).bind(LOOSE).first<{ series_id: string }>();
    expect(vol?.series_id).toBe(created_series);
    // シリーズ無しの巻の紐付けと同じ扱い（解除するとシリーズ無しに戻る）。
    const link = await env.DB.prepare(`SELECT series_id, from_series_id FROM volume_series_link WHERE isbn = ?`)
      .bind(LOOSE)
      .first<{ series_id: string; from_series_id: string | null }>();
    expect(link).toEqual({ series_id: created_series, from_series_id: null });
    // 移した巻への依頼は片付く。
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM series_split_request WHERE series_id = ?`)
      .bind(SERIES)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
