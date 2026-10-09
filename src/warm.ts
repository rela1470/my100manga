import { Env } from "./types";
import { isValidIsbn, json } from "./util";
import { readCachedCovers, resolveCovers } from "./covers";
import { getSeriesVolumes, getMasterUpdatedAt } from "./series";
import { getGroupVolumes } from "./groups";
import { readAutoWarmState } from "./warmAuto";
import { limiterStub } from "./ratelimiter";
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
//
// 温める巻は「巻一覧（getSeriesVolumes / getGroupVolumes）が実際に出す巻」。MADB の巻の約 2 割は
// series_id を持たず（うるわしの宵の月は 3 巻以降が全部これ）、巻一覧は書名一致などでそれを
// 寄せて出すので、volumes.series_id だけで巻を拾うと寄せた巻が暖機から漏れる。補完・手動追加の
// 巻もここで一緒に拾える。

export type WarmScope = "circulation" | "sales" | "series";
export const WARM_SCOPES: WarmScope[] = ["circulation", "sales", "series"];

export const isWarmScope = (s: string): s is WarmScope => (WARM_SCOPES as string[]).includes(s);

const DEFAULT_LIMIT = 8; // 1 要求で温める ISBN 数（約 0.9 req/s × 9 秒の予算に合わせる）
const MAX_LIMIT = 30;
const SERIES_CHUNK = 60; // 埋まり具合の集計で一度に見るシリーズ数（D1 の bind 上限 90 の内側）
// 1 要求で巻一覧を組み立てるシリーズ数。巻一覧 1 本で D1 を 20 本前後引くので、Worker 1 回の
// D1 クエリ上限（1000）に届かないよう抑える。温め済みのシリーズを読み飛ばす速さもこれで決まる。
const SERIES_PER_REQUEST = 25;

// 暖機が 1 件あたり枠を待つ上限。利用者の取得（最大 8 秒待つ）より短くしておくと、枠を
// 取り合ったとき必ず利用者が勝つ。楽天の枠はサイト全体で 1 秒 1 件・同じレーンの早い者勝ちで、
// 暖機は休みなく回るので、これが無いと利用者の取得が 1 件も通らなくなる。
const WARM_SLOT_WAIT_MS = 1000;
// 閲覧者が表紙を取得している間は、暖機そのものを休ませる（枠を譲るだけでなく、D1 の読みも
// 止める）。待ち行列には入らないよう pending 0 で人数だけ聞く。
const WARM_PRESENCE_CLIENT = "warm-cache-probe";

/** scope ごとの「次に見るシリーズ」。cursor は scope ごとに意味が違う（下の説明を参照）。 */
interface SeriesPage {
  ids: string[];
  /** cursors[i] = ids[i] から読み始める cursor（そのシリーズに温め残しがあればここで止まる）。 */
  cursors: string[];
  /** 次の要求に渡す cursor。これ以上無ければ null。 */
  next: string | null;
}

/** circulation / sales は materialize 済みの集計の並び順そのもの。cursor は読んだ件数。 */
function pageFromList(ids: string[], cursor: string, count: number): SeriesPage {
  const from = Number(cursor) || 0;
  const slice = ids.slice(from, from + count);
  return {
    ids: slice,
    cursors: slice.map((_, i) => (i === 0 ? cursor : String(from + i))),
    next: from + slice.length < ids.length ? String(from + slice.length) : null,
  };
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
  return {
    ids: rows.map((x) => x.id),
    cursors: rows.map((_, i) => (i === 0 ? cursor : `${rows[i - 1].num_items}:${rows[i - 1].id}`)),
    next: rows.length === count && last ? `${last.num_items}:${last.id}` : null,
  };
}

async function nextSeries(env: Env, scope: WarmScope, cursor: string, count: number): Promise<SeriesPage> {
  if (scope === "circulation") return pageFromList(await circulationSeriesIds(env), cursor, count);
  if (scope === "sales") return pageFromList(await salesSeriesIds(env), cursor, count);
  return await seriesPage(env, cursor, count);
}

/** 巻一覧に出る巻（ISBN の束 = 同じ巻の通常版・重版・特装版）。巻一覧と同じ関数で組み立てる
 *  ので、迷子巻の寄せ・補完・手動追加・結合・非表示がそのまま効く。 */
async function displayedVolumes(env: Env, id: string): Promise<string[][]> {
  const res = id.startsWith("G")
    ? await getGroupVolumes(env, id, (sid) => getSeriesVolumes(env, sid), () => getMasterUpdatedAt(env))
    : await getSeriesVolumes(env, id);
  if (!res.ok) return [];
  const data = await res.json<{ volumes?: Array<{ isbn: string; isbns?: string[] }> }>();
  return (data.volumes ?? []).map((v) => (v.isbns?.length ? v.isbns : [v.isbn]));
}

/** 巻一覧の巻のうち、まだ表紙が決まっていないものから、次に引く ISBN を巻ごとに 1 つ。
 *  表紙の見つかった ISBN が 1 つでもある巻は済み（巻一覧は束の最初の表紙を出す）。無ければ
 *  束のうちまだ covers に行の無いものを順に試す。 */
async function missingIsbns(env: Env, id: string): Promise<string[]> {
  const vols = await displayedVolumes(env, id);
  const covers = await readCachedCovers(env, vols.flat());
  const out: string[] = [];
  for (const isbns of vols) {
    if (isbns.some((i) => covers.get(i))) continue;
    // 不正な ISBN は resolveCovers が黙って捨てる（covers に行が残らない）ので、ここで外す。
    // 外さないと、そのシリーズで永遠に同じ ISBN を拾い続けて先へ進めなくなる。
    const next = isbns.find((i) => !covers.has(i) && isValidIsbn(i));
    if (next) out.push(next);
  }
  return out;
}

export interface WarmResult {
  scope: WarmScope;
  cursor: string | null; // 次の要求に渡す cursor（null = この scope は終わり）
  done: boolean;
  chunks: number; // 見たシリーズのページ数（今は 1 要求 1 ページ）
  attempted: number; // 温めようとした ISBN 数
  cached: number; // 実際に covers に入った数（レート制限で取れなかったぶんは入らない）
  /** 閲覧者が表紙を取得中なので今回は何もしなかった。呼び出し側は少し待って同じ cursor で
   *  やり直す（「進まない」として打ち切らない）。 */
  paused?: number;
}

/** いま表紙を取得している閲覧者の数。取れなければ 0（存在確認は飾りなので失敗させない）。 */
async function coverFillsInFlight(env: Env): Promise<number> {
  if (!env.RAKUTEN_LIMITER) return 0;
  try {
    const q = await limiterStub(env.RAKUTEN_LIMITER, "cover-queue").report(WARM_PRESENCE_CLIENT, 0);
    return q.users;
  } catch {
    return 0;
  }
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
  // 閲覧者が取得中なら何もしない。暖機は何時間でも待てるが、利用者は待てない。
  const inFlight = await coverFillsInFlight(env);
  if (inFlight > 0) {
    return { scope, cursor: cursor || null, done: false, chunks: 0, attempted: 0, cached: 0, paused: inFlight };
  }
  const page = await nextSeries(env, scope, cursor, SERIES_PER_REQUEST);
  if (!page.ids.length) return { scope, cursor: null, done: true, chunks: 0, attempted: 0, cached: 0 };

  // 温め残しのあるシリーズから want 件まで集める。最初に温め残しが見つかったシリーズの
  // cursor を返し、そのシリーズが済むまでは cursor を進めない。
  const batch: string[] = [];
  let stopAt: string | null = null;
  for (let i = 0; i < page.ids.length && batch.length < want; i++) {
    const cands = await missingIsbns(env, page.ids[i]);
    if (!cands.length) continue;
    if (stopAt === null) stopAt = page.cursors[i];
    for (const isbn of cands) if (batch.length < want && !batch.includes(isbn)) batch.push(isbn);
  }

  if (!batch.length) {
    // このページは温め済み（か、使える ISBN が無い）。次のページへ進めて返す。
    return { scope, cursor: page.next, done: page.next === null, chunks: 1, attempted: 0, cached: 0 };
  }

  const resolved = await resolveCovers(env, batch, { maxSlotWaitMs: WARM_SLOT_WAIT_MS });
  // resolveCovers はキャッシュ済みのぶんも返すが、batch は全部 covers に無かったものなので
  // 返ってきた件数 = 今回 covers に入った件数。
  return { scope, cursor: stopAt, done: false, chunks: 1, attempted: batch.length, cached: resolved.size };
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
  // 数えるのは series_id で紐付いた巻だけの目安（巻一覧が寄せる迷子巻は入らない）。暖機と同じく
  // 巻一覧を組み立てると数百シリーズぶん D1 を引くことになり、状況表示には重すぎるため。
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

  // ランキング集計のあとの自動暖機（src/warmAuto.ts）の状態。一度も走っていなければ null。
  const auto = await readAutoWarmState(env);
  return json({ ...totals, scopes, auto }, 200, { "cache-control": "no-store" });
}
