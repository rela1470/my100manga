// R18版の収録補完（scripts/import-extra-volumes.mjs）の SQL を組む部品。node: の import を持たないので、
// テスト（Workers 上の vitest）からも読める。正規化の関数（normTitle / searchKey / volSort）は
// 呼び手が渡す: CLI は scripts/ingest.mjs のもの、テストは src/util.ts のもの（同じ結果になることを
// テストで確かめる）。
//
// 入力は r18-bookdb の scripts/export-missing.mjs の出力（MADB に無い成年コミックの巻を、書名＋作者＋
// レーベルでシリーズにまとめたもの）:
//   { items: [{ name, author, label, publisher, volumes: [{ isbn, volume_number, subtitle, pubdate }] }] }
//
// 管理画面の「シリーズとして登録」（src/seriesRegister.ts）と同じ形で書く:
//   custom_series … シリーズ 1 つにつき独自シリーズ（U-id）1 行
//   volume_master_fix … 巻 1 冊につき 1 行。prev_json = NULL（上流に無い巻を足した）、is_adult = 1、
//                       note は IMPORTED_FIX_NOTE_PREFIX で始める（上流が同じ ISBN を持ったら、
//                       全件の取り込み直しが外す。scripts/ingest.mjs CLEANUP_IMPORTED_FIX_SQL）
// どちらも月次の取り込みの後に載せ直されるので消えない（APPLY_LINKS_SQL / APPLY_MASTER_FIX_SQL）。

import { sqlInt, sqlStr } from "./ingest-diff.mjs";

export const IMPORTED_FIX_NOTE_PREFIX = "r18-bookdb:";

// 一括投入の独自シリーズは U500001 から振る。管理画面の結合・登録が作る独自シリーズ（U000001〜）は
// 本家で作ったものを結合データ（db/series-merge-data.sql）ごと R18版にも流すことがあり、同じ番号帯だと
// R18版で入れたシリーズを上書きしてしまうため。
export const IMPORT_ID_FLOOR = 500001;

// 成年向けの巻を持つシリーズに成年向けの印を付ける。MADB のシリーズは取り込み（--include-adult）が
// series_new に付けるが、独自シリーズ（U-id）の巻は volume_master_fix から当たるので、その後に付け直す。
// scripts/ingest.mjs の POST_LOAD_SQL が APPLY_MASTER_FIX_SQL の後に流す。本家は成年向けの巻が無いので何もしない。
export const SERIES_ADULT_SQL =
  "UPDATE series SET is_adult = 1 WHERE is_adult = 0 AND id IN (SELECT series_id FROM volumes WHERE is_adult = 1 AND series_id IS NOT NULL);";

// この仕組みで足した巻のうち、上流（MADB）が同じ ISBN を持つようになったものの差し替え行を外す
// （上流の行と、上流のシリーズを優先する）。note の接頭辞で、管理者が手で直した行と見分ける。
// 上流の行だけが volumes にある全件の入れ替え直後（scripts/ingest.mjs SWAP_SQL）にだけ流す。差分取り込み
// （--diff）では volumes に前回当てた差し替え行が残っていて上流の行と見分けられないので流さない。
// 外した巻の独自シリーズは、巻が無くなれば検索にも補完にも出ない（どちらも巻のあるシリーズだけを
// 拾う）ので、custom_series の行は残してよい。
export const CLEANUP_IMPORTED_FIX_SQL =
  `DELETE FROM volume_master_fix WHERE note LIKE '${IMPORTED_FIX_NOTE_PREFIX}%' AND prev_json IS NULL ` +
  "AND isbn IN (SELECT isbn FROM volumes);";

/** 表示用の作者欄から検索用の creators_norm を作る。src/masterFix.ts creatorsNormOf と同じ
 *  （揃えること。test/importExtraVolumes.test.ts が同じ結果になるかを見る）。 */
export function creatorsNormOf(creators, normTitle) {
  if (!creators) return null;
  const names = String(creators)
    .split(/[、,，／/・]/)
    .map((part) => normTitle(part.replace(/^[^：:]{1,10}[：:]/, "")))
    .filter(Boolean);
  const uniq = [...new Set(names)];
  return uniq.length ? uniq.join("|") : null;
}

const FIX_COLS =
  "isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, creator, creators, creators_norm, " +
  "publisher, label, pubdate, is_adult, note, created_at, prev_json";
const ROWS_PER_INSERT = 100;

function uId(n) {
  return "U" + String(n).padStart(6, "0");
}

/**
 * @param {{ items: any[] }} input  export-missing.mjs の出力
 * @param {object} o
 * @param {number} o.nextId       次に振る U-id の番号（今の custom_series の最大 + 1）
 * @param {Set<string>} o.existing  既に volumes / volume_master_fix にある ISBN（入れない）
 * @param {string} o.note         note（IMPORTED_FIX_NOTE_PREFIX で始まること）
 * @param {number} o.now          created_at（epoch ms）
 * @param {(s: string) => string} o.normTitle
 * @param {(s: string) => string} o.searchKey
 * @param {(s: string) => number} o.volSort
 * @returns {{ sql: string[], series: number, volumes: number, skipped: number, ids: [string, string] | null }}
 */
export function buildImportSql(input, o) {
  if (!o.note.startsWith(IMPORTED_FIX_NOTE_PREFIX)) throw new Error(`note must start with ${IMPORTED_FIX_NOTE_PREFIX}`);
  const seriesRows = [];
  const fixRows = [];
  const seen = new Set();
  let skipped = 0;
  let n = o.nextId;
  for (const it of input.items ?? []) {
    const name = String(it.name ?? "").trim();
    if (!name) continue;
    const vols = (it.volumes ?? []).filter((v) => {
      const ok = /^97[89]\d{10}$/.test(v.isbn) && !o.existing.has(v.isbn) && !seen.has(v.isbn);
      if (!ok) skipped++;
      seen.add(v.isbn);
      return ok;
    });
    if (!vols.length) continue; // 巻が全部入っていれば、シリーズも作らない（空の独自シリーズを残さない）
    const id = uId(n++);
    const author = it.author ? String(it.author).trim() : "";
    seriesRows.push(
      [sqlStr(id), sqlStr(name), sqlStr(o.normTitle(name)), sqlStr(author), sqlStr(it.publisher), sqlStr(it.label), sqlInt(o.now)].join(", ")
    );
    for (const v of vols) {
      const volume = v.volume_number == null ? "" : String(v.volume_number);
      fixRows.push(
        [
          sqlStr(v.isbn),
          sqlStr(id),
          sqlStr(volume),
          sqlInt(o.volSort(volume)),
          sqlStr(name),
          sqlStr(v.subtitle),
          sqlStr(o.searchKey(name)),
          sqlStr(author),
          sqlStr(author),
          sqlStr(creatorsNormOf(author, o.normTitle)),
          sqlStr(it.publisher),
          sqlStr(it.label),
          sqlStr(v.pubdate),
          "1",
          sqlStr(o.note),
          sqlInt(o.now),
          "NULL",
        ].join(", ")
      );
    }
  }

  const sql = [];
  for (let i = 0; i < seriesRows.length; i += ROWS_PER_INSERT) {
    sql.push(
      "INSERT INTO custom_series (id, name, name_norm, creator, publisher, label, created_at) VALUES\n  (" +
        seriesRows.slice(i, i + ROWS_PER_INSERT).join("),\n  (") +
        ");"
    );
  }
  for (let i = 0; i < fixRows.length; i += ROWS_PER_INSERT) {
    // OR IGNORE: 管理者が既に直した行（同じ ISBN の差し替え）があれば、そちらを残す。
    sql.push(`INSERT OR IGNORE INTO volume_master_fix (${FIX_COLS}) VALUES\n  (` + fixRows.slice(i, i + ROWS_PER_INSERT).join("),\n  (") + ");");
  }
  return { sql, series: seriesRows.length, volumes: fixRows.length, skipped, ids: seriesRows.length ? [uId(o.nextId), uId(n - 1)] : null };
}

/** 入れた行を series / volumes へ当てる文（取り込み直後と同じ順）。この投入の行だけを当てる。
 *  volumes は OR IGNORE: 投入の直前に上流（の取り込み）が同じ ISBN を入れていたら上流を残す
 *  （差し替え行は次の全件の取り込み直しで外れる）。 */
export function applySql(note, ids, { APPLY_LINKS_SQL, SERIES_ADULT_SQL }) {
  const out = [
    "INSERT OR IGNORE INTO volumes (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
      "creator, creators, creators_norm, publisher, label, pubdate, is_adult) " +
      "SELECT isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
      `creator, creators, creators_norm, publisher, label, pubdate, is_adult FROM volume_master_fix WHERE note = ${sqlStr(note)};`,
  ];
  // 独自シリーズを series へ（is_adult は巻から。全独自シリーズを載せ直すのは取り込み直後と同じで冪等）。
  out.push(APPLY_LINKS_SQL.find((s) => s.startsWith("INSERT OR REPLACE INTO series")));
  out.push(SERIES_ADULT_SQL);
  if (ids) out.push(`-- この投入の独自シリーズ: ${ids[0]} 〜 ${ids[1]}`);
  return out;
}

/** 成年向けとして入れたが、実は一般向けだった巻（r18-bookdb の export-missing.mjs --non-adult）を
 *  全年齢に直す文。この仕組みで入れた差し替え行だけを直す（管理者が手で直した行・上流の行は触らない）。
 *  シリーズは成年向けの巻が残っていなければ全年齢に戻す（独自シリーズの番号帯だけ）。
 *  巻の行は月次の取り込み直しで volume_master_fix から当て直されるので、そちらも直す。 */
export function unadultSql(isbns) {
  const out = [];
  const imported = `SELECT isbn FROM volume_master_fix WHERE note LIKE '${IMPORTED_FIX_NOTE_PREFIX}%' AND prev_json IS NULL`;
  for (let i = 0; i < isbns.length; i += 400) {
    const list = isbns
      .slice(i, i + 400)
      .filter((s) => /^97[89]\d{10}$/.test(s))
      .map((s) => `'${s}'`)
      .join(",");
    if (!list) continue;
    out.push(`UPDATE volumes SET is_adult = 0 WHERE is_adult = 1 AND isbn IN (${list}) AND isbn IN (${imported});`);
    out.push(
      `UPDATE volume_master_fix SET is_adult = 0 WHERE is_adult = 1 AND note LIKE '${IMPORTED_FIX_NOTE_PREFIX}%' AND prev_json IS NULL AND isbn IN (${list});`
    );
  }
  out.push(
    `UPDATE series SET is_adult = 0 WHERE is_adult = 1 AND id >= 'U${IMPORT_ID_FLOOR}' AND id GLOB 'U[0-9]*' ` +
      "AND id NOT IN (SELECT series_id FROM volumes WHERE is_adult = 1 AND series_id IS NOT NULL);"
  );
  return out;
}

/** 表示データの世代（src/viewSnapshot.ts の meta.view_epoch）を進める文。検索・おまかせ埋めの応答は
 *  世代を鍵に混ぜて最大 1 時間エッジキャッシュされる（src/search.ts SEARCH_CACHE_SEC）。管理画面の更新は
 *  API が世代を上げるが、この SQL は D1 に直接書くので、流した後も古い検索結果が残ってしまう。
 *  値は bumpViewEpoch と同じ形（epoch ms の文字列）。 */
export function bumpViewEpochSql(now) {
  return `INSERT INTO meta (key, value) VALUES ('view_epoch', '${Number(now)}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;`;
}
