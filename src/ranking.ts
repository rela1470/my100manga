import { Env } from "./types";
import { json } from "./util";

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
  title: string | null;
  author: string | null;
  cover_url: string | null;
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
            MAX(title)     AS title,
            MAX(author)    AS author,
            MAX(cover_url) AS cover_url,
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

  const build = (pick: (r: AggRow) => number): RankEntry[] =>
    rows
      .filter((r) => pick(r) > 0)
      .sort((a, b) => pick(b) - pick(a) || (a.title ?? "").localeCompare(b.title ?? ""))
      .slice(0, TOP_N)
      .map((r, i) => ({
        rank: i + 1,
        isbn: r.isbn,
        title: r.title ?? "",
        author: r.author ?? "",
        cover_url: r.cover_url ?? "",
        count: pick(r),
      }));

  return {
    windows: {
      cumulative: build((r) => r.c_all),
      d30: build((r) => r.c30),
      d7: build((r) => r.c7),
      d24: build((r) => r.c24),
    },
    computed_at: now,
  };
}

/** meta にキャッシュした結果を返す。TTL 切れなら再計算して保存する。covers の TTL パターンと
 *  同じ発想で、書き込みパスには触らず読み取り時に materialize する。 */
export async function getBookRanking(env: Env): Promise<RankingPayload> {
  const atRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(META_AT_KEY)
    .first<{ value: string }>();
  const at = atRow ? Number(atRow.value) : 0;

  if (at && Date.now() - at < TTL_MS) {
    const jsonRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
      .bind(META_JSON_KEY)
      .first<{ value: string }>();
    if (jsonRow) {
      try {
        return JSON.parse(jsonRow.value) as RankingPayload;
      } catch {
        // 壊れていたら下の再計算にフォールスルーする。
      }
    }
  }

  const payload = await computeRanking(env);
  const value = JSON.stringify(payload);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(META_JSON_KEY, value),
    env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(META_AT_KEY, String(payload.computed_at)),
  ]);
  return payload;
}

export async function handleRanking(env: Env): Promise<Response> {
  const payload = await getBookRanking(env);
  // 集計は最大 10 分古い。閲覧側でも数分キャッシュして再計算の発火を間引く。
  return json(payload, 200, { "cache-control": "public, max-age=300" });
}
