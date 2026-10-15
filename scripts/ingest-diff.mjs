// 差分取り込み（scripts/ingest.mjs --diff）の部品。node: の import を持たないので、
// test/ingestDiff.test.ts から Workers ランタイムでも読める。
//
// 全件の取り込みは series / volumes を影の表へ全行書き直して入れ替えるので、中身が変わらない
// 行も D1 の書き込み行数に数えられる（本家で 1 回約 143 万行、R18 で約 250 万行）。差分取り込みは
// 取り込み直前の D1 の中身を読み出し（読み取りは書き込みより桁違いに安い）、MADB から作った行と
// 比べて、変わった行・増えた行だけを upsert、消えた行だけを DELETE する。
//
// 比べる相手は「前回の取り込み結果」ではなく今の D1 の中身そのもの。手元に控えを持たないので
// CI からでも走り、どこかでずれても次の差分取り込みで MADB 側の値に寄る。今の中身には取り込みの
// 後に重ねる管理データ（APPLY_LINKS_SQL の独自シリーズ・巻の付け替え、APPLY_MASTER_FIX_SQL の
// マスタ行の差し替え）が載っているので、
//   ・それらの行は毎回「変わった」と判定されて MADB の値で書き戻され、直後の重ね直しで元に戻る
//     （数百行程度。取り込みの後にこれらを流すのは全件の取り込みと同じ）
//   ・MADB に無い独自シリーズ（custom_series）・差し替えで足した巻（volume_master_fix）は
//     消さない（呼び出し側が keep に渡す）

// D1 から読んだ値を、取り込みが書く SQL リテラルと同じ形にする（ingest.mjs の sqlStr / sqlInt と
// 揃える。空文字は NULL として書いているので、読んだ側でも NULL に寄せる）。
export function sqlStr(s) {
  if (s == null || s === "") return "NULL";
  return "'" + String(s).replace(/'/g, "''") + "'";
}
export function sqlInt(n) {
  return n == null || Number.isNaN(n) ? "NULL" : String(n);
}

// D1 の 1 行（{列名: 値}）を、取り込みの行（SQL リテラルの配列）と比べられる文字列にする。
// intCols は INTEGER 列の名前の集合。
export function liveRowKey(row, cols, intCols) {
  return cols.map((c) => (intCols.has(c) ? sqlInt(row[c]) : sqlStr(row[c]))).join(",");
}

// next: Map<主キー, SQL リテラルの配列>（MADB から作った行）
// live: Map<主キー, liveRowKey の文字列>（今の D1 の行）
// keep: 主キー → true なら、MADB に無くても消さない
// 戻り値: upserts = 書き込む行（リテラルの配列）、deletes = 消す主キー
export function diffRows(next, live, keep = () => false) {
  const upserts = [];
  const deletes = [];
  for (const [pk, tuple] of next) {
    if (live.get(pk) !== tuple.join(",")) upserts.push(tuple);
  }
  for (const pk of live.keys()) {
    if (!next.has(pk) && !keep(pk)) deletes.push(pk);
  }
  return { upserts, deletes };
}

// 変わった行の書き戻しは INSERT OR REPLACE ではなく upsert にする。REPLACE は行を消して入れ直す
// ので、値の変わらない列の索引まで書き直しになり、D1 の書き込み行数に数えられる。
export function upsertClause(cols, pk) {
  return ` ON CONFLICT(${pk}) DO UPDATE SET ${cols.filter((c) => c !== pk).map((c) => `${c} = excluded.${c}`).join(", ")}`;
}

export function deleteStatements(table, pk, keys, per = 500) {
  const out = [];
  for (let i = 0; i < keys.length; i += per) {
    out.push(`DELETE FROM ${table} WHERE ${pk} IN (${keys.slice(i, i + per).map(sqlStr).join(",")});\n`);
  }
  return out;
}

// サジェストの前方一致索引（series_suggest）を、作り直さずに差分で合わせる SQL。
// 全件の取り込みは series_suggest_new に約 24.5 万行を書いて入れ替えるが、ここでは同じ SELECT
// （ingest.mjs SUGGEST_SQL の INSERT 文から取り出すので、3 か所を揃えるテストの対象がそのまま
// 効く）を読むだけにして、無くなった行を消し、増えた・変わった行だけを書く。
// 同じ (key, series_id) が複数の SELECT から出ることはあるが、どれも同じ名前・巻数・印なので
// （書名と読みが同じ綴りのとき等）、EXCEPT で 1 行に畳まれても全件の作り直しと結果は変わらない。
const SUGGEST_INSERT_PREFIX =
  "INSERT OR REPLACE INTO series_suggest_new (key, series_id, name, name_key, weight, is_adult) ";

export function suggestDiffSql(suggestSql) {
  const selects = suggestSql
    .filter((s) => s.startsWith(SUGGEST_INSERT_PREFIX))
    .map((s) => s.slice(SUGGEST_INSERT_PREFIX.length).replace(/;\s*$/, ""));
  const create = suggestSql.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS series_suggest "));
  if (selects.length !== 3 || !create) {
    throw new Error("SUGGEST_SQL の形が変わった: suggestDiffSql を合わせる");
  }
  const cte =
    "WITH n(key, series_id, name, name_key, weight, is_adult) AS (" +
    selects.map((s) => `SELECT * FROM (${s})`).join(" UNION ALL ") +
    ") ";
  return [
    create,
    cte + "DELETE FROM series_suggest WHERE (key, series_id) NOT IN (SELECT key, series_id FROM n);",
    cte +
      "INSERT OR REPLACE INTO series_suggest (key, series_id, name, name_key, weight, is_adult) " +
      "SELECT * FROM n EXCEPT SELECT key, series_id, name, name_key, weight, is_adult FROM series_suggest;",
  ];
}
