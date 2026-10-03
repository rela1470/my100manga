import { Env } from "./types";
import { json, toIsbn13 } from "./util";
import { resolveBooks } from "./listItems";
import { readMaterialized } from "./metaCache";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";

// 「本が追加されている回数」ランキング。集計単位は巻 (ISBN)、カウントは COUNT(DISTINCT slug)
// =「その巻を選んだ人数」。元データは list_item_events (公開時に追記される巻の追加イベント。
// db/schema.sql 参照)。累計と 3 つの時間窓 (過去30日/7日/24時間) を同じテーブルから出すので
// 4 窓が一貫する (どの窓でも count が 累計 を超えない)。

const TOP_N = 100;
const TTL_MS = 10 * 60 * 1000; // 全リストを跨ぐ集計なので 10 分 materialized cache する
const DAY_MS = 24 * 60 * 60 * 1000;

const META_JSON_KEY = "book_ranking_json";
const META_AT_KEY = "book_ranking_at";

export type RankKey = "cumulative" | "d30" | "d7" | "d24";

export interface RankEntry {
  rank: number;
  isbn: string;
  title: string;
  author: string;
  cover_url: string;
  count: number;
}

interface RankingPayload {
  windows: Record<RankKey, RankEntry[]>;
  computed_at: number;
}

interface AggRow {
  isbn: string;
  c_all: number;
  c30: number;
  c7: number;
  c24: number;
}

/** 4 窓ぶんを 1 パスで集計する。窓の絞り込みは COUNT(DISTINCT CASE WHEN added_at>=? …) で
 *  行うので、イベントテーブルを 1 度だけスキャンすれば済む。 */
async function computeRanking(env: Env): Promise<RankingPayload> {
  const now = Date.now();
  const d30 = now - 30 * DAY_MS;
  const d7 = now - 7 * DAY_MS;
  const d24 = now - DAY_MS;

  const res = await env.DB.prepare(
    `SELECT isbn,
            COUNT(DISTINCT slug)                                  AS c_all,
            COUNT(DISTINCT CASE WHEN added_at >= ?1 THEN slug END) AS c30,
            COUNT(DISTINCT CASE WHEN added_at >= ?2 THEN slug END) AS c7,
            COUNT(DISTINCT CASE WHEN added_at >= ?3 THEN slug END) AS c24
     FROM list_item_events
     WHERE isbn <> ''
     GROUP BY isbn`
  )
    .bind(d30, d7, d24)
    .all<AggRow>();

  const rows = res.results ?? [];

  // Rank by count (ISBN breaks ties so the order is stable), then look up the
  // site-wide title/author/cover for just the ISBNs that made a top list — events
  // store only the ISBN (see db/schema.sql list_item_events).
  const top = (pick: (r: AggRow) => number): AggRow[] =>
    rows
      .filter((r) => pick(r) > 0)
      .sort((a, b) => pick(b) - pick(a) || a.isbn.localeCompare(b.isbn))
      .slice(0, TOP_N);
  const picks: Record<RankKey, (r: AggRow) => number> = {
    cumulative: (r) => r.c_all,
    d30: (r) => r.c30,
    d7: (r) => r.c7,
    d24: (r) => r.c24,
  };
  const tops = Object.fromEntries(
    (Object.keys(picks) as RankKey[]).map((k) => [k, top(picks[k])])
  ) as Record<RankKey, AggRow[]>;
  const books = await resolveBooks(env, Object.values(tops).flatMap((t) => t.map((r) => r.isbn)));
  const build = (k: RankKey): RankEntry[] =>
    tops[k].map((r, i) => {
      const b = books.get(toIsbn13(r.isbn));
      return {
        rank: i + 1,
        isbn: r.isbn,
        title: b?.title || `ISBN ${r.isbn}`,
        author: b?.author ?? "",
        cover_url: b?.cover_url ?? "",
        count: picks[k](r),
      };
    });

  return {
    windows: { cumulative: build("cumulative"), d30: build("d30"), d7: build("d7"), d24: build("d24") },
    computed_at: now,
  };
}

/** meta にキャッシュした結果を返す。TTL 切れなら再計算して保存する。covers の TTL パターンと
 *  同じ発想で、書き込みパスには触らず読み取り時に materialize する。TTL 切れの瞬間に要求が
 *  重なっても再計算するのは 1 件だけ（src/metaCache.ts）。 */
export async function getBookRanking(env: Env): Promise<RankingPayload> {
  return readMaterialized(env, { json: META_JSON_KEY, at: META_AT_KEY }, TTL_MS, () => computeRanking(env));
}

export async function handleRanking(env: Env): Promise<Response> {
  // 集計は最大 10 分古い。閲覧側でも数分キャッシュして再計算の発火を間引く。エッジでも 60 秒
  // 持って、meta の大きな JSON を要求ごとに D1 から読まないようにする。
  return withEdgeCache(edgeCacheKey(env, "/api/ranking"), 60, async () =>
    json(await getBookRanking(env), 200, { "cache-control": "public, max-age=300" })
  );
}
