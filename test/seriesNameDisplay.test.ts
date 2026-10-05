import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import { normTitle, searchKey } from "../src/util";
import { adminListSeriesReports, adminListSupplements, adminListVolumeReports } from "../src/admin";
import type { Env } from "../src/types";
// 判定の SQL 本体をそのまま読んで流す（これが仕様。下の describe を参照）。
import MIGRATION from "../db/fix-series-name-display-variants.sql?raw";

// 表示用のシリーズ名（series.name_display）。MADB のシリーズ名だけでは同名シリーズを見分け
// られないので（「釣りキチ三平」は 6 件ある）、全ての巻が同じ副題を名乗るシリーズにはその副題を
// 足した名前を持たせる。埋めるのは取り込み（scripts/ingest.mjs）とバックフィル
// （db/add-series-name-display.sql）で、読み出しは src/util.ts seriesNameSql。
// see db/schema.sql series.name_display

const NAME = "ツリキチサンペイテスト";
const AMBIGUOUS = "CD001"; // 同名が他にあり、全巻が副題「作者自選集」を持つ
const SIBLING = "CD002"; // 同名。副題はばらばら
const OVERRIDDEN = "CD003"; // AMBIGUOUS と同じ形で、管理者の名前修正が載っているもの
const [A, B, C, D, E] = makeIsbns(5, 920000);

async function addSeries(id: string, name: string, display: string | null): Promise<void> {
  // name_search は取り込みと同じ searchKey（記号・全角半角を落とした検索の照合キー）。
  // 「同名」の判定がこの列を見るので、テストでも同じ値を入れる。
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher, label, name_display)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, normTitle(name), searchKey(name), "表示名作者", "表示名社", null, display)
    .run();
}

async function addVolume(
  seriesId: string,
  isbn: string,
  num: string,
  subtitle: string | null,
  name = NAME
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, creator, pubdate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1994-05')`
  )
    .bind(isbn, seriesId, num, Number(num), name, subtitle, name, "表示名作者")
    .run();
}

describe("表示用のシリーズ名を読む側", () => {
  beforeAll(async () => {
    await addSeries(AMBIGUOUS, NAME, `${NAME} 作者自選集`);
    await addSeries(SIBLING, NAME, null);
    await addVolume(AMBIGUOUS, A, "1", "作者自選集");
    await addVolume(AMBIGUOUS, B, "2", "作者自選集");
    await addVolume(SIBLING, C, "1", "アユ釣り編");
    await addVolume(SIBLING, D, "2", "アカメ釣り編");
    await addSeries(OVERRIDDEN, "ナオサレタナマエ", "ナオサレタナマエ 作者自選集");
    await addVolume(OVERRIDDEN, E, "1", "作者自選集", "ナオサレタナマエ");
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_name_override (series_id, name, created_at) VALUES (?, ?, ?)`
    )
      .bind(OVERRIDDEN, "管理者が直した名前", 1)
      .run();
  });

  it("検索カードの書名が name_display になる（持たないシリーズは素の名前のまま）", async () => {
    const res = await SELF.fetch(`https://example.com/api/search?q=${encodeURIComponent(NAME)}`, {
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { series_id: string; title: string }[] };
    const byId = new Map(body.results.map((r) => [r.series_id, r.title]));
    expect(byId.get(AMBIGUOUS)).toBe(`${NAME} 作者自選集`);
    expect(byId.get(SIBLING)).toBe(NAME);
  });

  it("巻一覧の title は name_display だが、巻のタイトルは素の名前のまま（副題が二重に付かない）", async () => {
    const res = await SELF.fetch(`https://example.com/api/series/${AMBIGUOUS}/volumes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; volumes: { title: string; subtitle: string }[] };
    expect(body.title).toBe(`${NAME} 作者自選集`);
    // 本の表示は「書名 + 巻 + 副題」なので（public/app.js bookTitle）、巻の title に副題入りの
    // 名前を入れると「… 作者自選集 1 作者自選集」になる。
    for (const v of body.volumes) {
      expect(v.title).toBe(NAME);
      expect(v.subtitle).toBe("作者自選集");
    }
  });

  it("管理者の名前修正（series_name_override）があればそちらが勝つ", async () => {
    const res = await SELF.fetch(`https://example.com/api/series/${OVERRIDDEN}/volumes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("管理者が直した名前");
  });
});

// name_display を決める規則そのもの。本番の 4 つの DB に流すのはこの SQL なので、ファイルを
// そのまま実行して確かめる。取り込み（scripts/ingest.mjs の「3.5」）は同じ判定を JS で持つ。
const BACKFILL = MIGRATION.slice(MIGRATION.indexOf("UPDATE series"));

describe("name_display を付ける条件（db/add-series-name-display.sql）", () => {
  // [id, シリーズ名, 巻の副題（1 巻ずつ）, 期待する name_display]
  const CASES: [string, string, (string | null)[], string | null][] = [
    ["CD101", "ドウメイアリ", ["作者自選集", "作者自選集"], "ドウメイアリ 作者自選集"],
    ["CD102", "ドウメイアリ", ["アユ釣り編", "アカメ釣り編"], null], // 同名の相手（副題はばらばら）
    ["CD103", "ドウメイナシ", ["作者自選集", "作者自選集"], null], // 同名が無ければ足さない
    ["CD104", "イチブダケ", ["作者自選集", null], null], // 副題の無い巻がある
    ["CD105", "イチブダケ", ["別の副題", "別の副題"], "イチブダケ 別の副題"], // CD104 の同名の相手
    ["CD106", "ゴウホン", ["甲：乙", "甲：乙"], null], // 合本の複数別名（取り込みが「：」で繋いだ印）
    ["CD107", "ゴウホン", ["単独の副題", "単独の副題"], "ゴウホン 単独の副題"], // CD106 の同名の相手
    ["CD108", "ナマエニフクム 全英オープン編", ["全英オープン編", "全英オープン編"], null], // 名前が既に含む
    ["CD109", "ナマエニフクム 全英オープン編", ["別編", "別編"], "ナマエニフクム 全英オープン編 別編"],
    // 「同名」は検索の照合キー（name_search）で見るので、中黒の有無だけが違う名前も同名に数える
    // （C294944「ブラックジャック」と C276567 ほか「ブラック・ジャック」）。
    ["CD111", "ヒョウキユレアリ", ["黒い医師", "黒い医師"], "ヒョウキユレアリ 黒い医師"],
    ["CD112", "ヒョウキ・ユレアリ", ["別の副題", "別の副題"], "ヒョウキ・ユレアリ 別の副題"],
  ];

  beforeAll(async () => {
    let n = 0;
    for (const [id, name, subs] of CASES) {
      await addSeries(id, name, null);
      for (const [i, sub] of subs.entries()) await addVolume(id, makeIsbns(1, 930000 + n++)[0], String(i + 1), sub, name);
    }
    // 巻を 1 冊も持たないシリーズは「同名の相手」に数えない（検索にも巻一覧にも出ないので）。
    await addSeries("CD110", "ドウメイナシ", null);
    for (const stmt of BACKFILL.split(";").map((x) => x.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
  });

  for (const [id, name, , expected] of CASES) {
    it(`${id} ${name}${expected ? ` → ${expected}` : " は据え置き"}`, async () => {
      const row = await env.DB.prepare(`SELECT name_display FROM series WHERE id = ?`)
        .bind(id)
        .first<{ name_display: string | null }>();
      expect(row?.name_display ?? null).toBe(expected);
    });
  }
});

// 管理画面も閲覧者と同じ名前を出す。マスタの素の name を出すと、通報者が見た名前
// （「釣りキチ三平 作者自選集」）と管理者が見る名前（「釣りキチ三平」）がずれる。
describe("管理画面に出るシリーズ名", () => {
  const adminEnv = env as unknown as Env;
  const page = { page: 1, per: 50, offset: 0 };
  const ADMIN = "CD201";
  const [F] = makeIsbns(1, 940500);

  beforeAll(async () => {
    await addSeries(ADMIN, "カンリガメンテスト", "カンリガメンテスト 黒い医師");
    await addVolume(ADMIN, F, "1", "黒い医師", "カンリガメンテスト");
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_report
         (series_id, reported_name, suggested_name, report_count, first_reported_at, last_reported_at)
       VALUES (?, ?, '', 1, 1, 1)`
    )
      .bind(ADMIN, "カンリガメンテスト 黒い医師")
      .run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volume_report
         (series_id, isbn, volume_number, report_count, first_reported_at, last_reported_at)
       VALUES (?, ?, '1', 1, 1, 1)`
    )
      .bind(ADMIN, F)
      .run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_supplement (series_id, volumes_json, checked_at) VALUES (?, '[]', 1)`
    )
      .bind(ADMIN)
      .run();
  });

  it("シリーズ名の通報一覧は、閲覧者に見えている名前とマスタの素の名前を両方返す", async () => {
    const body = (await (await adminListSeriesReports(adminEnv, page)).json()) as {
      reports: { series_id: string; display_name: string; current_name: string }[];
    };
    const row = body.reports.find((r) => r.series_id === ADMIN);
    expect(row?.display_name).toBe("カンリガメンテスト 黒い医師");
    expect(row?.current_name).toBe("カンリガメンテスト");
  });

  it("巻の通報一覧・補完キャッシュ一覧の所属シリーズ名も表示名になる", async () => {
    const reports = (await (await adminListVolumeReports(adminEnv, page)).json()) as {
      reports: { series_id: string; series_name: string }[];
    };
    expect(reports.reports.find((r) => r.series_id === ADMIN)?.series_name).toBe("カンリガメンテスト 黒い医師");

    const supplements = (await (await adminListSupplements(adminEnv, page)).json()) as {
      supplements: { series_id: string; series_name: string }[];
    };
    expect(supplements.supplements.find((r) => r.series_id === ADMIN)?.series_name).toBe(
      "カンリガメンテスト 黒い医師"
    );
  });
});
