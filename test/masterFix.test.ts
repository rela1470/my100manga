import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adminDeleteMasterFix,
  adminListMasterFixes,
  adminLookupMasterFix,
  adminSaveMasterFix,
} from "../src/masterFix";
import type { Env } from "../src/types";

// 上流（MADB）が壊している巻のマスタ行を丸ごと差し替える volume_master_fix（db/schema.sql）と、
// 管理画面の API（src/masterFix.ts）、月次取り込みのあとに載せ直す文（scripts/ingest.mjs の
// APPLY_MASTER_FIX_SQL）の取り決め。載せ直しは node 側のスクリプトにしか無く import できないので、
// 同じ文をここに写して検査する。
const APPLY_MASTER_FIX_SQL =
  "INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult) " +
  "SELECT isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult FROM volume_master_fix";

const adminEnv = env as unknown as Env;
const page = { page: 1, per: 100, offset: 0 };

// 実例そのまま: MADB は Rave 9 巻の ISBN を『超感電少女モナ』の巻として持ち、モナの正しい
// ISBN（9784063029505）はマスタに 1 行も無い。db/add-volume-master-fix.sql 参照。
const RAVE9 = "9784063129502";
const MONA = "9784063029505";

async function columns(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return res.results.map((r) => r.name);
}

function saveRequest(body: Record<string, unknown>): Request {
  return new Request("https://example.com/api/admin/master-fixes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function lookupUrl(isbn: string, series?: string): URL {
  const u = new URL("https://example.com/api/admin/master-fixes/lookup");
  u.searchParams.set("isbn", isbn);
  if (series) u.searchParams.set("series", series);
  return u;
}

async function volume(isbn: string) {
  return env.DB.prepare(
    `SELECT series_id, volume_number, vol_sort, title, title_search, creator, creators_norm, publisher, label, pubdate
       FROM volumes WHERE isbn = ?`
  )
    .bind(isbn)
    .first<Record<string, unknown>>();
}

/** 壊れた上流の状態を作る: Rave は 9 巻が欠番で、その ISBN がモナの巻になっている。 */
async function seedBrokenMaster(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO series (id, name, name_norm, creator, publisher, label, num_items)
       VALUES ('C325142', 'Rave', 'rave', '真島ヒロ', '講談社', '講談社コミックス', 35),
              ('C279630', '超感電少女モナ', '超感電少女モナ', '安野モヨコ', '講談社', '講談社コミックスフレンドB', 1)`
    ),
    env.DB.prepare(
      `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate)
       VALUES ('9784063129250', 'C325142', '8', 8, 'Rave', 'rave', '真島ヒロ', '講談社', '講談社コミックス', '2001-01'),
              ('9784063129694', 'C325142', '10', 10, 'Rave', 'rave', '真島ヒロ', '講談社', '講談社コミックス', '2001-05'),
              (?, 'C279630', NULL, 0, '超感電少女モナ', '超感電少女モナ', '安野モヨコ', '講談社', '講談社コミックスフレンドB', '1994-04-13')`
    ).bind(RAVE9),
  ]);
}

/** 管理画面のフォームが送る形（src/masterFix.ts adminSaveMasterFix）。 */
function rave9Fix(extra: Record<string, unknown> = {}) {
  return {
    isbn: RAVE9,
    series_id: "C325142",
    volume_number: "9",
    title: "Rave",
    creator: "真島ヒロ",
    publisher: "講談社",
    label: "講談社コミックス",
    pubdate: "2001-03",
    note: "openBD で確認",
    ...extra,
  };
}

describe("volume_master_fix（壊れたマスタ行の差し替え）", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM volume_master_fix`),
      env.DB.prepare(`DELETE FROM volumes`),
      env.DB.prepare(`DELETE FROM series`),
    ]);
  });

  it("列は volumes と同じ並びで、末尾に note / created_at / prev_json が付くだけ", async () => {
    // volumes に列を足したのに volume_master_fix と載せ直しの文を直し忘れると、差し替えた行だけ
    // その列が空になる。並びごと揃えておけば SELECT の写し間違いにも気付ける。
    expect(await columns("volume_master_fix")).toEqual([
      ...(await columns("volumes")),
      "note",
      "created_at",
      "prev_json",
    ]);
  });

  it("保存するとマスタ行が差し替わり、検索キーも作り直される", async () => {
    await seedBrokenMaster();
    const res = await adminSaveMasterFix(saveRequest(rave9Fix()), adminEnv);
    expect(res.status).toBe(200);

    expect(await volume(RAVE9)).toMatchObject({
      series_id: "C325142",
      volume_number: "9",
      vol_sort: 9, // 巻番号から自動で付く
      title: "Rave",
      title_search: "rave", // searchKey(title) をサーバが入れ直す
      creator: "真島ヒロ",
      creators_norm: "真島ヒロ", // creators 未指定なら creator から作る
      pubdate: "2001-03",
    });
  });

  it("上流に無い ISBN は新しい行として入り、取り消すと消える", async () => {
    await seedBrokenMaster();
    const res = await adminSaveMasterFix(
      saveRequest({
        isbn: MONA,
        series_id: "C279630",
        title: "超感電少女モナ",
        creator: "安野モヨコ",
        publisher: "講談社",
        label: "講談社コミックスフレンドB",
        pubdate: "1994-04-13",
        note: "NDLサーチの 4-06-302950-6",
      }),
      adminEnv
    );
    expect(res.status).toBe(200);
    expect(await volume(MONA)).toMatchObject({ series_id: "C279630", title: "超感電少女モナ" });

    // 控え（prev_json）が無い＝足した巻なので、取り消しはマスタから消す。
    expect((await adminDeleteMasterFix(adminEnv, MONA)).status).toBe(200);
    expect(await volume(MONA)).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 FROM volume_master_fix WHERE isbn = ?`).bind(MONA).first()).toBeNull();
  });

  it("取り消すと差し替える前のマスタ行に戻る", async () => {
    await seedBrokenMaster();
    await adminSaveMasterFix(saveRequest(rave9Fix()), adminEnv);
    // 2 回目の保存では控えを取り直さない（自分が書いた値を控えにしてしまわない）。
    await adminSaveMasterFix(saveRequest(rave9Fix({ volume_number: "09" })), adminEnv);

    expect((await adminDeleteMasterFix(adminEnv, RAVE9)).status).toBe(200);
    expect(await volume(RAVE9)).toMatchObject({
      series_id: "C279630",
      title: "超感電少女モナ",
      creator: "安野モヨコ",
      pubdate: "1994-04-13",
    });
  });

  it("月次取り込みのあとも載せ直され、2 回流しても同じ（冪等）", async () => {
    await seedBrokenMaster();
    await adminSaveMasterFix(saveRequest(rave9Fix()), adminEnv);

    // 取り込みのやり直しを模す: volumes を上流の（壊れた）内容に戻す。
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM volumes`),
      env.DB.prepare(
        `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate)
         VALUES (?, 'C279630', NULL, 0, '超感電少女モナ', '超感電少女モナ', '安野モヨコ', '講談社', '講談社コミックスフレンドB', '1994-04-13')`
      ).bind(RAVE9),
    ]);
    await env.DB.prepare(APPLY_MASTER_FIX_SQL).run();
    await env.DB.prepare(APPLY_MASTER_FIX_SQL).run();

    expect(await volume(RAVE9)).toMatchObject({ series_id: "C325142", volume_number: "9", title: "Rave" });
  });

  it("一覧は反映状態を出し、取り消しの結末（戻す / 消す）を知らせる", async () => {
    await seedBrokenMaster();
    await adminSaveMasterFix(saveRequest(rave9Fix()), adminEnv);

    const body = (await (await adminListMasterFixes(adminEnv, page)).json()) as {
      total: number;
      fixes: { isbn: string; series_name: string; applied: boolean; restores: string }[];
    };
    expect(body.total).toBe(1);
    expect(body.fixes[0]).toMatchObject({
      isbn: RAVE9,
      series_name: "Rave",
      applied: true,
      restores: "restore",
    });

    // マスタだけ別の値に戻ると「未反映」になる（取り込みの載せ直しが抜けている合図）。
    await env.DB.prepare(`UPDATE volumes SET title = 'ずれた' WHERE isbn = ?`).bind(RAVE9).run();
    const after = (await (await adminListMasterFixes(adminEnv, page)).json()) as {
      fixes: { applied: boolean }[];
    };
    expect(after.fixes[0].applied).toBe(false);
  });

  it("下書きの材料に、今のマスタ行と指定シリーズの手本が入る", async () => {
    await seedBrokenMaster();
    const body = (await (await adminLookupMasterFix(adminEnv, lookupUrl(RAVE9, "C325142"))).json()) as {
      isbn: string;
      master: { title: string; series_id: string } | null;
      fix: unknown;
      series: { name: string; volume_count: number; common: { title: string; creator: string; label: string } } | null;
    };
    expect(body.isbn).toBe(RAVE9);
    // 今のマスタ行＝壊れている当人。これを下敷きにして壊れた欄だけ直す。
    expect(body.master).toMatchObject({ title: "超感電少女モナ", series_id: "C279630" });
    expect(body.fix).toBeNull();
    // シリーズの手本＝そのシリーズで最も多い（書名・著者・出版社・レーベル）の組。
    expect(body.series).toMatchObject({ name: "Rave", volume_count: 2 });
    expect(body.series?.common).toMatchObject({ title: "Rave", creator: "真島ヒロ", label: "講談社コミックス" });
  });

  it("ISBN・書名・シリーズ・発行日の形を検査する", async () => {
    await seedBrokenMaster();
    const bad = async (body: Record<string, unknown>) => (await adminSaveMasterFix(saveRequest(body), adminEnv)).status;
    expect(await bad(rave9Fix({ isbn: "123" }))).toBe(400);
    expect(await bad(rave9Fix({ title: "" }))).toBe(400);
    expect(await bad(rave9Fix({ series_id: "C999999" }))).toBe(400); // 無いシリーズ
    expect(await bad(rave9Fix({ series_id: "G9784063129250" }))).toBe(400); // まとまりは指定できない
    expect(await bad(rave9Fix({ pubdate: "2001年3月" }))).toBe(400);
    // 本家（SITE_VARIANT 既定）には成年向けの行を入れない。
    expect(await bad(rave9Fix({ is_adult: true }))).toBe(400);
  });

  it("無い修正の取り消しは 404", async () => {
    expect((await adminDeleteMasterFix(adminEnv, RAVE9)).status).toBe(404);
  });
});
