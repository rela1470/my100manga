import { Env } from "./types";
import { json } from "./util";

// トップページに出す収録数（シリーズ / 巻(ISBN) / 公開リスト）。series・volumes の COUNT(*) は
// 数十万行を読むので、公開エンドポイントから毎回叩かないよう ranking.ts と同じく meta に
// 10 分 materialize する。lists は全行が公開済みリスト（未公開の下書きはブラウザ側にしか無い）。

const TTL_MS = 10 * 60 * 1000;
const META_JSON_KEY = "site_stats_json";
const META_AT_KEY = "site_stats_at";

interface SiteStats {
  series: number;
  volumes: number;
  lists: number;
  computed_at: number;
}

async function computeSiteStats(env: Env): Promise<SiteStats> {
  const count = async (sql: string): Promise<number> =>
    (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const [series, volumes, lists] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM series`),
    count(`SELECT COUNT(*) AS n FROM volumes`),
    count(`SELECT COUNT(*) AS n FROM lists`),
  ]);
  return { series, volumes, lists, computed_at: Date.now() };
}

async function getSiteStats(env: Env): Promise<SiteStats> {
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
        return JSON.parse(jsonRow.value) as SiteStats;
      } catch {
        // 壊れていたら下の再計算にフォールスルーする。
      }
    }
  }

  const stats = await computeSiteStats(env);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(META_JSON_KEY, JSON.stringify(stats)),
    env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(META_AT_KEY, String(stats.computed_at)),
  ]);
  return stats;
}

/** GET /api/site-stats — トップページの収録数表示用。 */
export async function handleSiteStats(env: Env): Promise<Response> {
  const stats = await getSiteStats(env);
  return json(stats, 200, { "cache-control": "public, max-age=300" });
}
