import { Env } from "./types";
import { json, normTitle, searchKey, hiraToKata, vuFold } from "./util";
import { adultOnlySearch } from "./site";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";
import { getViewEpoch } from "./viewSnapshot";

// 検索欄の入力補完（サジェスト）。打鍵のたびに呼ばれるので、キーワード検索（src/search.ts）の
// ような '%q%' の全表走査は使えない。前方一致だけを引く専用表 series_suggest を置き、
// (key, series_id) の主キーをレンジで引く:
//
//   series_suggest … シリーズ 1 件につき「引ける綴り」1 つで 1 行。綴りは
//     ・name_norm      … normTitle(シリーズ名)
//     ・name_search    … searchKey(シリーズ名)（記号・全角半角を無視した綴り）
//     ・name_kana_norm … MADB の読み。複数の読みが "|" 繋ぎで入っているので 1 つずつ行に開く
//     ・管理者が直した名前（series_name_override）の name_norm / name_search
//   の重複を除いたもの。実データで 13.4 万シリーズ → 24.5 万行。
//
// LIKE 'q%' ではなく key >= q AND key < q+(最大符号位置) で引く: SQLite の LIKE 最適化は
// ASCII の綴りにしか効かず、「ドラゴ%」では索引が使われず全表走査になる（実測）。レンジなら
// 必ず主キーを辿るので、2 文字の綴りで一番多い「アイ」でも読むのは 1,539 行。
//
// 表の中身は月次の取り込み（scripts/ingest.mjs）が作り直す。管理者の結合・名前修正のあとは
// 管理画面の「サジェスト索引の再構築」（/api/admin/suggest/rebuild）で作り直す。

/** サジェストを出し始める最短の語長。キーワード検索（2 文字以上）と揃える。 */
export const SUGGEST_MIN = 2;
/** 返す候補の数。縦に並べて画面を埋めない程度。 */
const SUGGEST_LIMIT = 8;
/** 受け付ける検索語の長さの上限（これより長い入力は切って引く）。コードポイントで数える
 *  （String#slice だとサロゲートペアの片割れだけが残り、どの綴りにも当たらない語になる）。 */
const Q_MAX = 40;
// 候補はマスタの作り直しか管理者の再構築でしか変わらないので、検索（1 時間）と同じだけ持たせる。
// 鍵に表示データの世代（src/viewSnapshot.ts）を混ぜてあるので、管理者の操作のあとは鍵が変わる。
const SUGGEST_CACHE_SEC = 3600;
// レンジの上限に使う、Unicode の最大符号位置。key がこの文字で始まることはないので、
// 「q で始まる綴り」を漏れなく・余さず囲める。
const KEY_MAX = "\u{10FFFF}";

/** 候補のまとめ方（表示名の揺れを 1 つに畳むキー）。normTitle 相当を SQL で書いたもの:
 *  「ONE PIECE」と「One piece」を別の候補として並べない。正規化を揃えるためだけの列なので、
 *  normTitle の \s（タブ等）までは見ない。 */
function nameKeySql(expr: string): string {
  return `LOWER(REPLACE(REPLACE(${expr}, ' ', ''), '　', ''))`;
}

// 並び順に使う巻数。シリーズに属する巻を数え、結合（series_merge）で吸収された側の巻は
// 吸収先の数に足す。カード（src/search.ts VOL_COUNT）のような副題・補完まで見た数え方は
// しない — ここは並び順を決めるだけで、画面には出さないため。
const VOL_COUNT_SQL = `SELECT COALESCE(m.target_id, v.series_id) AS sid, COUNT(*) AS n
         FROM volumes v LEFT JOIN series_merge m ON m.absorbed_id = v.series_id
        WHERE v.series_id IS NOT NULL
        GROUP BY sid`;

/** series_suggest の列（db/schema.sql と揃える）。 */
const SUGGEST_COLS = `key       TEXT NOT NULL,
     series_id TEXT NOT NULL,
     name      TEXT NOT NULL,
     name_key  TEXT NOT NULL,
     weight    INTEGER NOT NULL,
     is_adult  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (key, series_id)`;

/** series_suggest を今の series / volumes / series_name_override / series_merge から作り直す SQL。
 *  db/add-series-suggest.sql と scripts/ingest.mjs の SUGGEST_SQL が同じものを持つ（3 か所を揃える。
 *  ずれたら test/suggest.test.ts が落ちる）。どの文も冪等（作り直しなので何度流しても同じ結果）。
 *
 *  いったん series_suggest_new に作ってから RENAME で今の表と入れ替える（取り込みの SWAP_SQL と
 *  同じ手）。DELETE してから入れ直す作りだと、途中で失敗したときに空の表が残って候補が無言で
 *  消える（public/suggest.js は失敗を握り潰すので画面には何も出ない）。WITHOUT ROWID の主キー
 *  しか持たない表なので、入れ替えのあとに張り直す索引は無い。 */
export const SUGGEST_BUILD_SQL: string[] = [
  `DROP TABLE IF EXISTS series_suggest_new;`,
  `CREATE TABLE series_suggest_new (${SUGGEST_COLS}) WITHOUT ROWID;`,
  // 書名の綴り（マスタの name_norm / name_search と、管理者が直した名前の同じ 2 つ）。
  // 1 行を 4 つの綴りに開くため、1..4 の小さな表と直積を取って CASE で選ぶ。
  // weight（並び順）は巻数。結合されたシリーズ（series_merge）の巻は吸収先に足して数え、
  // 吸収された側は候補から外す（検索結果に出ないものを候補に出さない）。
  // 4 つの綴りは同じになることがある（記号の無い書名では name_norm = name_search）ので OR REPLACE。
  `INSERT OR REPLACE INTO series_suggest_new (key, series_id, name, name_key, weight, is_adult)
   SELECT key, series_id, name, ${nameKeySql("name")}, weight, is_adult FROM (
     SELECT CASE t.i WHEN 1 THEN s.name_norm
                     WHEN 2 THEN s.name_search
                     WHEN 3 THEN NULLIF(o.name_norm, '')
                     WHEN 4 THEN NULLIF(o.name_search, '') END AS key,
            s.id AS series_id,
            COALESCE(o.name, s.name_display, s.name) AS name,
            vc.n AS weight,
            s.is_adult AS is_adult
       FROM series s
       JOIN (${VOL_COUNT_SQL}) vc ON vc.sid = s.id
       LEFT JOIN series_name_override o ON o.series_id = s.id
       JOIN (SELECT 1 AS i UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) t
      WHERE s.id NOT IN (SELECT absorbed_id FROM series_merge))
    WHERE key IS NOT NULL AND key <> '';`,
  // 読みの綴り。name_kana_norm は "onepiece|ワンピース" のように読みを "|" で繋いだ塊なので
  // （『ONE PIECE』はカナの読みが 2 つ目にある）、再帰 CTE で 1 つずつ行に開く。これをせずに
  // 塊のまま前方一致させると、ローマ字別名を先に持つ主要作がカナ入力で出てこない。
  `INSERT OR REPLACE INTO series_suggest_new (key, series_id, name, name_key, weight, is_adult)
   WITH RECURSIVE
     live AS (
       SELECT s.id, COALESCE(o.name, s.name_display, s.name) AS name, s.name_kana_norm AS kana, s.is_adult
         FROM series s LEFT JOIN series_name_override o ON o.series_id = s.id
        WHERE COALESCE(s.name_kana_norm, '') <> ''
          AND s.id NOT IN (SELECT absorbed_id FROM series_merge)),
     kana(id, rest, part) AS (
       SELECT id, kana || '|', '' FROM live
       UNION ALL
       SELECT id, substr(rest, instr(rest, '|') + 1), substr(rest, 1, instr(rest, '|') - 1)
         FROM kana WHERE rest <> ''),
     vc AS (${VOL_COUNT_SQL})
   SELECT k.part, l.id, l.name, ${nameKeySql("l.name")}, vc.n, l.is_adult
     FROM kana k JOIN live l ON l.id = k.id JOIN vc ON vc.sid = l.id
    WHERE k.part <> '';`,
  // シリーズ行を持たない上書き（まとまり G-id の名前修正。マスタが書名を壊していて、
  // 直した名前だけが手掛かりの作品 — 『Dr.スランプ』のジャンプ・コミックス版など）。
  // 巻数は数えようがないので weight = 1（候補の末尾）。成年向けの印は、まとまりの正規 ID が
  // 持つ ISBN の巻から引く（R18版の既定の絞り込みに使う）。
  `INSERT OR REPLACE INTO series_suggest_new (key, series_id, name, name_key, weight, is_adult)
   SELECT key, series_id, name, ${nameKeySql("name")}, 1,
          COALESCE((SELECT v.is_adult FROM volumes v WHERE v.isbn = substr(series_id, 2)), 0)
     FROM (
     SELECT CASE t.i WHEN 1 THEN NULLIF(o.name_norm, '') WHEN 2 THEN NULLIF(o.name_search, '') END AS key,
            o.series_id AS series_id, o.name AS name
       FROM series_name_override o
       JOIN (SELECT 1 AS i UNION ALL SELECT 2) t
      WHERE NOT EXISTS (SELECT 1 FROM series s WHERE s.id = o.series_id))
    WHERE key IS NOT NULL AND key <> '';`,
  // 入れ替え。ここまでに失敗していれば今の series_suggest はそのまま（候補は古いまま出続ける）。
  // 初回・まだ表が無い DB でも RENAME できるよう、空の表を作ってから入れ替える。
  `CREATE TABLE IF NOT EXISTS series_suggest (${SUGGEST_COLS}) WITHOUT ROWID;`,
  `DROP TABLE IF EXISTS series_suggest_old;`,
  `ALTER TABLE series_suggest RENAME TO series_suggest_old;`,
  `ALTER TABLE series_suggest_new RENAME TO series_suggest;`,
  `DROP TABLE series_suggest_old;`,
];

/** series_suggest を作り直す。管理画面の「サジェスト索引の再構築」から呼ぶ。 */
export async function rebuildSuggest(env: Env): Promise<number> {
  for (const sql of SUGGEST_BUILD_SQL) await env.DB.prepare(sql).run();
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM series_suggest`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** GET /api/suggest?q=…（R18版は all=1 で全年齢も含める）。候補の書名だけを返す。 */
export async function handleSuggest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = [...(url.searchParams.get("q") ?? "").trim()].slice(0, Q_MAX).join("");
  // 短すぎる語は候補を出さない（1 文字では当たりが数千件になり、絞り込みの役に立たない）。
  // 検索と違ってエラーにはしない: 入力の途中で毎回 400 を返しても意味が無いので空で返す。
  if (q.length < SUGGEST_MIN) return json({ q, suggestions: [] }, 200, { "cache-control": "no-store" });

  // R18版は既定で成年向けだけを出す（src/site.ts adultOnlySearch）。検索フォームの
  // 「全年齢の作品も含める」が all=1 を付けてきたら外す。本家は常に false。
  const adultOnly = adultOnlySearch(env) && url.searchParams.get("all") !== "1";

  // 鍵は正規化した語（照合に使う 3 つの綴りはどれも normTitle から決まる）と絞り込みの有無、
  // それに表示データの世代（管理者の操作で変わる）。検索と同じ考え方。
  return withEdgeCache(
    edgeCacheKey(env, "/api/suggest", {
      q: normTitle(q),
      a: adultOnly ? 1 : 0,
      e: await getViewEpoch(env),
    }),
    SUGGEST_CACHE_SEC,
    () => suggestNames(env, q, adultOnly)
  );
}

async function suggestNames(env: Env, q: string, adultOnly: boolean): Promise<Response> {
  const nq = normTitle(q);
  // 照合する綴りは 3 つ: そのまま（name_norm・ローマ字の読み）、記号を落としたもの
  // （name_search。「ぼっちざ」で「ぼっち・ざ・ろっく！」）、カナに寄せたもの（読み。
  // ひらがな入力「わんぴ」を読み「ワンピース」に当てる。ヴ→バ行も寄せる）。
  // 同じになるものは 1 本にまとめる（カナ入力なら 3 つとも同じ綴りになる）。
  const prefixes = [...new Set([nq, searchKey(q), vuFold(hiraToKata(nq))])].filter((p) => p.length >= SUGGEST_MIN);
  if (!prefixes.length) return suggestResponse(q, []);

  const where = prefixes.map(() => "(key >= ? AND key < ?)").join(" OR ");
  const res = await env.DB.prepare(
    `SELECT name, MAX(weight) AS w FROM series_suggest
      WHERE (${where}) ${adultOnly ? "AND is_adult = 1" : ""}
      GROUP BY name_key
      ORDER BY w DESC, name
      LIMIT ${SUGGEST_LIMIT}`
  )
    .bind(...prefixes.flatMap((p) => [p, p + KEY_MAX]))
    .all<{ name: string; w: number }>();

  return suggestResponse(q, res.results.map((r) => r.name));
}

function suggestResponse(q: string, suggestions: string[]): Response {
  // 候補は誰が引いても同じ公開データなので、ブラウザにも少し持たせる（打ち直し・後退で引き直さない）。
  // 応答に付く cf-cache-status: HIT は下の withEdgeCache（鍵に表示データの世代が入る）のもので、
  // 世代の入らない CDN の URL キャッシュではない（実測: 一度も叩いていない別 URL でも、
  // normTitle が同じなら HIT が返る）。索引を作り直せば世代が変わって確実に外れる。
  return json({ q, suggestions }, 200, { "cache-control": "public, max-age=600" });
}
