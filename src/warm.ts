import { Env } from "./types";
import { isValidIsbn, json } from "./util";
import { resolveCovers } from "./covers";
import { circulationSeriesIds } from "./circulation";
import { salesSeriesIds } from "./salesRanking";

// 表紙・書誌キャッシュの暖機。公開前に、人気のある作品の巻から順に covers / book_meta を
// 埋めておき、最初の閲覧者が楽天の応答を待たされないようにする。
//
// 楽天 OpenAPI はアプリ ID ごとに約 1 req/s（src/ratelimiter.ts INTERVAL_MS = 1100）で、
// これは Worker 全体で共有する枠なので、どう並べても約 0.9 ISBN/秒が上限。1 要求で温められる
// のは resolveCovers の予算（RESOLVE_BUDGET_MS = 9 秒）ぶん＝ 8 件前後しかない。そこで
// 「次の数件を温めて、どこまで進んだかを返す」だけの API にして、繰り返しは
// scripts/warm-cache.mjs 側のループに任せる（止めても再開できる）。
//
// 温める順（scope）:
//   circulation … 発行部数ランキング（Wikipedia 由来）の寄せ先シリーズを部数の多い順
//   sales       … 売上ランキング（楽天の売れ筋スナップショット）の寄せ先シリーズを順位順
//   series      … 残り全部を巻数（series.num_items）の多い順
// 進捗は covers 表そのもの（温め済みの ISBN には行がある）で判断するので状態を持たない。
// 途中で止めても同じ cursor から続けられる。

export type WarmScope = "circulation" | "sales" | "series";
export const WARM_SCOPES: WarmScope[] = ["circulation", "sales", "series"];

export const isWarmScope = (s: string): s is WarmScope => (WARM_SCOPES as string[]).includes(s);

const DEFAULT_LIMIT = 8; // 1 要求で温める ISBN 数（約 0.9 req/s × 9 秒の予算に合わせる）
const MAX_LIMIT = 30;
const SERIES_CHUNK = 60; // 一度に見るシリーズ数（D1 の bind 上限 90 の内側）
const MAX_CHUNKS = 25; // 1 要求で読み飛ばしてよいチャンク数（温め済みのシリーズを飛ばす）
const CANDIDATE_FACTOR = 5; // 不正な ISBN で埋まらないよう limit より多めに候補を取る

/** scope ごとの「次に見るシリーズ」。cursor は scope ごとに意味が違う（下の説明を参照）。 */
interface SeriesPage {
  ids: string[];
  /** 次の要求に渡す cursor。これ以上無ければ null。 */
  next: string | null;
}

/** circulation / sales は materialize 済みの集計の並び順そのもの。cursor は読んだ件数。 */
function pageFromList(ids: string[], cursor: string, count: number): SeriesPage {
  const from = Number(cursor) || 0;
  const slice = ids.slice(from, from + count);
  return { ids: slice, next: from + slice.length < ids.length ? String(from + slice.length) : null };
}

/** series は巻数の多い順。cursor は "<num_items>:<id>"（キーセット法。OFFSET だと深い
 *  ページほど遅くなるため）。 */
async function seriesPage(env: Env, cursor: string, count: number): Promise<SeriesPage> {
  const [numRaw, idRaw] = cursor.split(":");
  const num = Number(numRaw);
  const fromNum = Number.isFinite(num) && cursor ? num : Number.MAX_SAFE_INTEGER;
  const fromId = idRaw ?? "";
  const r = await env.DB.prepare(
    `SELECT id, num_items FROM series
      WHERE num_items IS NOT NULL AND (num_items < ?1 OR (num_items = ?1 AND id > ?2))
      ORDER BY num_items DESC, id LIMIT ?3`
  )
    .bind(fromNum, fromId, count)
    .all<{ id: string; num_items: number }>();
  const rows = r.results ?? [];
  const last = rows[rows.length - 1];
  return { ids: rows.map((x) => x.id), next: rows.length === count && last ? `${last.num_items}:${last.id}` : null };
}

async function nextSeries(env: Env, scope: WarmScope, cursor: string, count: number): Promise<SeriesPage> {
  if (scope === "circulation") return pageFromList(await circulationSeriesIds(env), cursor, count);
  if (scope === "sales") return pageFromList(await salesSeriesIds(env), cursor, count);
  return await seriesPage(env, cursor, count);
}

/** 渡したシリーズの巻のうち、まだ covers に無いもの。まとまり（G-id）は巻一覧を別に持つので
 *  ここでは扱わない（暖機の対象はマスタのシリーズに属する巻だけ）。 */
async function missingIsbns(env: Env, seriesIds: string[], want: number): Promise<string[]> {
  const ids = seriesIds.filter((id) => !id.startsWith("G"));
  if (!ids.length) return [];
  const r = await env.DB.prepare(
    `SELECT v.isbn FROM volumes v
       LEFT JOIN covers c ON c.isbn = v.isbn
      WHERE v.series_id IN (${ids.map(() => "?").join(",")}) AND c.isbn IS NULL
      ORDER BY v.vol_sort, v.isbn LIMIT ?`
  )
    .bind(...ids, want)
    .all<{ isbn: string }>();
  // 不正な ISBN は resolveCovers が黙って捨てる（covers に行が残らない）ので、ここで外す。
  // 外さないと、そのシリーズで永遠に同じ ISBN を拾い続けて先へ進めなくなる。
  return (r.results ?? []).map((x) => x.isbn).filter(isValidIsbn);
}

export interface WarmResult {
  scope: WarmScope;
  cursor: string | null; // 次の要求に渡す cursor（null = この scope は終わり）
  done: boolean;
  chunks: number; // 読み飛ばしたぶんも含めて見たシリーズのチャンク数
  attempted: number; // 温めようとした ISBN 数
  cached: number; // 実際に covers に入った数（レート制限で取れなかったぶんは入らない）
}

/** 次のひとかたまりを温める。温める対象が見つかったチャンクで止まり、その cursor を返す
 *  （同じチャンクに残りがあるうちは cursor が進まない）。 */
export async function warmNext(
  env: Env,
  scope: WarmScope,
  cursor: string,
  limit: number
): Promise<WarmResult> {
  const want = Math.min(Math.max(1, limit), MAX_LIMIT);
  let cur: string | null = cursor;
  let chunks = 0;

  for (; chunks < MAX_CHUNKS; chunks++) {
    const page: SeriesPage = await nextSeries(env, scope, cur ?? "", SERIES_CHUNK);
    if (!page.ids.length) return { scope, cursor: null, done: true, chunks, attempted: 0, cached: 0 };

    const cands = await missingIsbns(env, page.ids, want * CANDIDATE_FACTOR);
    if (!cands.length) {
      // このチャンクは温め済み（か、使える ISBN が無い）。次へ進む。
      cur = page.next;
      if (cur === null) return { scope, cursor: null, done: true, chunks: chunks + 1, attempted: 0, cached: 0 };
      continue;
    }

    const batch = cands.slice(0, want);
    const resolved = await resolveCovers(env, batch);
    // resolveCovers はキャッシュ済みのぶんも返すが、batch は全部 covers に無かったものなので
    // 返ってきた件数 = 今回 covers に入った件数。
    return { scope, cursor: cur, done: false, chunks: chunks + 1, attempted: batch.length, cached: resolved.size };
  }

  // MAX_CHUNKS ぶん読んでも温める対象が無かった。cursor を進めた状態で返し、続きは次の要求で。
  return { scope, cursor: cur, done: cur === null, chunks, attempted: 0, cached: 0 };
}

/** POST /api/admin/warm?scope=&cursor=&limit= */
export async function adminWarm(env: Env, url: URL): Promise<Response> {
  const scopeRaw = url.searchParams.get("scope") ?? "circulation";
  if (!isWarmScope(scopeRaw)) {
    return json({ error: `scope は ${WARM_SCOPES.join(" / ")} のいずれか` }, 400, { "cache-control": "no-store" });
  }
  const limit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const result = await warmNext(env, scopeRaw, url.searchParams.get("cursor") ?? "", limit);
  return json(result, 200, { "cache-control": "no-store" });
}

/** GET /api/admin/warm。キャッシュの埋まり具合（管理画面の表示とスクリプトの進捗表示用）。 */
export async function adminWarmStatus(env: Env): Promise<Response> {
  const totals = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM volumes) AS volumes,
            (SELECT COUNT(*) FROM covers) AS covers,
            (SELECT COUNT(*) FROM covers WHERE cover_url <> '') AS covers_found,
            (SELECT COUNT(*) FROM book_meta) AS book_meta`
  ).first<{ volumes: number; covers: number; covers_found: number; book_meta: number }>();

  // circulation / sales の寄せ先シリーズについて、巻がどこまで温まっているか。
  const scopes: Record<string, { series: number; volumes: number; warmed: number }> = {};
  for (const [name, ids] of [
    ["circulation", await circulationSeriesIds(env)],
    ["sales", await salesSeriesIds(env)],
  ] as const) {
    const target = ids.filter((id) => !id.startsWith("G"));
    let volumes = 0;
    let warmed = 0;
    for (let i = 0; i < target.length; i += SERIES_CHUNK) {
      const chunk = target.slice(i, i + SERIES_CHUNK);
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS volumes, SUM(c.isbn IS NOT NULL) AS warmed
           FROM volumes v LEFT JOIN covers c ON c.isbn = v.isbn
          WHERE v.series_id IN (${chunk.map(() => "?").join(",")})`
      )
        .bind(...chunk)
        .first<{ volumes: number; warmed: number | null }>();
      volumes += r?.volumes ?? 0;
      warmed += r?.warmed ?? 0;
    }
    scopes[name] = { series: target.length, volumes, warmed };
  }

  return json({ ...totals, scopes }, 200, { "cache-control": "no-store" });
}
