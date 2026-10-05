import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// 上流（MADB）が壊している巻のマスタ行を丸ごと差し替える volume_master_fix（db/schema.sql）と、
// 月次取り込みのあとにそれを載せ直す文（scripts/ingest.mjs の APPLY_MASTER_FIX_SQL）の取り決め。
// 載せ直しは node 側のスクリプトにしか無く import できないので、同じ文をここに写して検査する。
const APPLY_MASTER_FIX_SQL =
  "INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult) " +
  "SELECT isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult FROM volume_master_fix";

async function columns(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return res.results.map((r) => r.name);
}

describe("volume_master_fix（壊れたマスタ行の差し替え）", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM volume_master_fix`),
      env.DB.prepare(`DELETE FROM volumes`),
    ]);
  });

  it("列は volumes と同じ並びで、末尾に note / created_at が付くだけ", async () => {
    // volumes に列を足したのに volume_master_fix と載せ直しの文を直し忘れると、差し替えた行だけ
    // その列が空になる。並びごと揃えておけば SELECT の写し間違いにも気付ける。
    expect(await columns("volume_master_fix")).toEqual([...(await columns("volumes")), "note", "created_at"]);
  });

  it("壊れた行を差し替え、上流に無い ISBN は新しい行として入る", async () => {
    // 実例そのまま: MADB は Rave 9 巻の ISBN を『超感電少女モナ』の巻として持ち、モナの正しい
    // ISBN（9784063029505）はマスタに 1 行も無い。db/add-volume-master-fix.sql 参照。
    await env.DB.prepare(
      `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate)
       VALUES ('9784063129502', 'C279630', NULL, 0, '超感電少女モナ', '超感電少女モナ', '安野モヨコ', '講談社', '講談社コミックスフレンドB', '1994-04-13')`
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO volume_master_fix (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate, created_at)
         VALUES ('9784063129502', 'C325142', '9', 9, 'Rave', 'rave', '真島ヒロ', '講談社', '講談社コミックス', '2001-03', 1)`
      ),
      env.DB.prepare(
        `INSERT INTO volume_master_fix (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate, created_at)
         VALUES ('9784063029505', 'C279630', NULL, 0, '超感電少女モナ', '超感電少女モナ', '安野モヨコ', '講談社', '講談社コミックスフレンドB', '1994-04-13', 1)`
      ),
    ]);

    // 2 回流しても同じ（取り込みのたびに当たるので冪等であること）。
    await env.DB.prepare(APPLY_MASTER_FIX_SQL).run();
    await env.DB.prepare(APPLY_MASTER_FIX_SQL).run();

    const res = await env.DB.prepare(
      `SELECT isbn, series_id, volume_number, title, creator, pubdate FROM volumes ORDER BY isbn`
    ).all<{ isbn: string; series_id: string; volume_number: string | null; title: string; creator: string; pubdate: string }>();
    expect(res.results).toEqual([
      {
        isbn: "9784063029505",
        series_id: "C279630",
        volume_number: null,
        title: "超感電少女モナ",
        creator: "安野モヨコ",
        pubdate: "1994-04-13",
      },
      {
        isbn: "9784063129502",
        series_id: "C325142",
        volume_number: "9",
        title: "Rave",
        creator: "真島ヒロ",
        pubdate: "2001-03",
      },
    ]);
  });
});
