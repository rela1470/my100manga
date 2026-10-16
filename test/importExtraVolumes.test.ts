import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import {
  CLEANUP_IMPORTED_FIX_SQL,
  IMPORT_ID_FLOOR,
  IMPORTED_FIX_NOTE_PREFIX,
  SERIES_ADULT_SQL,
  applySql,
  buildImportSql,
  creatorsNormOf,
} from "../scripts/extra-volumes-sql.mjs";
import { APPLY_LINKS_SQL, nextCustomSeriesId } from "../src/groups";
import { creatorsNormOf as creatorsNormOfSrc } from "../src/masterFix";
import { normTitle, searchKey, volSort } from "../src/util";

// R18版の収録補完（scripts/import-extra-volumes.mjs）。MADB に無い成年コミックの巻を独自シリーズ＋
// 差し替え行として入れ、月次の取り込み直しでも成年向けのまま残り、上流が同じ ISBN を持ったら外れること。

// 月次取り込みのあとに載せ直す文（scripts/ingest.mjs。node 側にしか無く import できないので写す。
// test/seriesRegister.test.ts と同じ）。
const APPLY_MASTER_FIX_SQL =
  "INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult) " +
  "SELECT isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult FROM volume_master_fix";

const NOTE = `${IMPORTED_FIX_NOTE_PREFIX}test.json 20261016T1200`;
const A1 = "9784887740006"; // 気分(1)
const A2 = "9784887740013"; // SAMPLE
const B1 = "9784887741027"; // キミの名を呼べば
const UPSTREAM = "9784887741041"; // 既に上流にある巻（入れない）

const input = {
  items: [
    { name: "気分", author: "ぢたま某", label: "MUJIN C", publisher: "ティーアイネット", volumes: [{ isbn: A1, volume_number: "1", pubdate: "1999-10-01" }] },
    { name: "SAMPLE", author: "板場広し", label: "MUJIN C", publisher: "ティーアイネット", volumes: [{ isbn: A2, volume_number: null, pubdate: "1999-10-01" }] },
    {
      name: "キミの名を呼べば",
      author: "甘詰留太",
      label: "MUJIN C",
      publisher: "ティーアイネット",
      volumes: [{ isbn: B1, volume_number: null, pubdate: "2003-10-03" }, { isbn: UPSTREAM, volume_number: null }],
    },
    // 巻が全部既にあるシリーズは作らない
    { name: "女子校生", author: "誰か", label: "MUJIN C", publisher: "ティーアイネット", volumes: [{ isbn: UPSTREAM }] },
  ],
};

async function run(sqls: string[]) {
  for (const sql of sqls) if (!sql.startsWith("--")) await env.DB.prepare(sql).run();
}

describe("creatorsNormOf", () => {
  it("src/masterFix.ts と同じ結果になる", () => {
    for (const s of ["甘詰留太", "原作：A、作画：B", "A・浪漫・我慢", "x / y", ""]) {
      expect(creatorsNormOf(s, normTitle)).toBe(creatorsNormOfSrc(s, ""));
    }
  });
});

describe("buildImportSql / applySql", () => {
  let built: ReturnType<typeof buildImportSql>;

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, is_adult) VALUES (?, NULL, NULL, 0, '女子校生', 1)`
    )
      .bind(UPSTREAM)
      .run();
    built = buildImportSql(input, {
      nextId: IMPORT_ID_FLOOR,
      existing: new Set([UPSTREAM]),
      note: NOTE,
      now: 1,
      normTitle,
      searchKey,
      volSort,
    });
    await run(built.sql);
    await run(applySql(NOTE, built.ids, { APPLY_LINKS_SQL, SERIES_ADULT_SQL }));
  });

  it("シリーズ 3 つ・巻 3 冊を入れ、既にある巻は飛ばす", () => {
    expect(built).toMatchObject({ series: 3, volumes: 3, skipped: 2, ids: ["U500001", "U500003"] });
  });

  it("独自シリーズは成年向けで、巻は検索キー付きで入る", async () => {
    const s = await env.DB.prepare(`SELECT id, name, creator, is_adult FROM series WHERE id = 'U500003'`).first();
    expect(s).toMatchObject({ name: "キミの名を呼べば", creator: "甘詰留太", is_adult: 1 });
    const v = await env.DB.prepare(`SELECT series_id, title_search, creators_norm, is_adult, vol_sort FROM volumes WHERE isbn = ?`)
      .bind(A1)
      .first();
    expect(v).toMatchObject({ series_id: "U500001", title_search: searchKey("気分"), creators_norm: "ぢたま某", is_adult: 1, vol_sort: 1 });
  });

  it("月次の取り込み直し（series / volumes の作り直し）の後も、成年向けのまま戻る", async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM volumes WHERE isbn IN (?, ?, ?)`).bind(A1, A2, B1),
      env.DB.prepare(`DELETE FROM series WHERE id GLOB 'U*'`),
    ]);
    await run([...APPLY_LINKS_SQL, APPLY_MASTER_FIX_SQL, SERIES_ADULT_SQL]);
    const rows = await env.DB.prepare(`SELECT id, is_adult FROM series WHERE id IN ('U500001','U500002','U500003') ORDER BY id`).all();
    expect(rows.results).toEqual([
      { id: "U500001", is_adult: 1 },
      { id: "U500002", is_adult: 1 },
      { id: "U500003", is_adult: 1 },
    ]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM volumes WHERE isbn IN (?, ?, ?)`).bind(A1, A2, B1).first())?.n).toBe(3);
  });

  it("上流が同じ ISBN を持ったら、全件の入れ替え直後の掃除でこの仕組みの行だけ外れる", async () => {
    // 管理者が手で足した行（note が違う）は残る
    await env.DB.prepare(
      `INSERT OR REPLACE INTO volume_master_fix (isbn, series_id, title, is_adult, note, created_at, prev_json)
       VALUES ('9784000000994', NULL, '手で足した', 0, 'openBD', 1, NULL)`
    ).run();
    // 全件の入れ替え直後 = volumes は上流の行だけ。上流が A1 を持つようになった
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM volumes`),
      env.DB.prepare(`INSERT INTO volumes (isbn, series_id, title, is_adult) VALUES (?, 'C999999', '気分', 1)`).bind(A1),
      env.DB.prepare(`INSERT INTO volumes (isbn, series_id, title, is_adult) VALUES ('9784000000994', NULL, '上流', 0)`),
    ]);
    await env.DB.prepare(CLEANUP_IMPORTED_FIX_SQL).run();
    const left = await env.DB.prepare(`SELECT isbn FROM volume_master_fix WHERE isbn IN (?, ?, ?, '9784000000994') ORDER BY isbn`)
      .bind(A1, A2, B1)
      .all();
    expect(left.results.map((r) => r.isbn)).toEqual(["9784000000994", A2, B1].sort());
  });
});

describe("nextCustomSeriesId", () => {
  it("管理画面が振る独自シリーズの ID は、一括投入の番号帯（U500001〜）の下の続き", async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO custom_series (id, name, name_norm, created_at) VALUES ('U000007', 'x', 'x', 1)`).run();
    expect(await nextCustomSeriesId(env as unknown as Env)).toBe("U000008");
  });
});

