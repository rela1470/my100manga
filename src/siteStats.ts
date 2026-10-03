import { Env } from "./types";
import { json } from "./util";
import { readMaterialized } from "./metaCache";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";

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
  // TTL 切れの瞬間に要求が重なっても再計算するのは 1 件だけ（src/metaCache.ts）。
  return readMaterialized(env, { json: META_JSON_KEY, at: META_AT_KEY }, TTL_MS, () => computeSiteStats(env));
}

/** GET /api/site-stats — トップページの収録数表示用。 */
export async function handleSiteStats(env: Env): Promise<Response> {
  // トップページのたびに呼ばれるので、エッジでも 60 秒持って meta の読み取りも省く。
  return withEdgeCache(edgeCacheKey(env, "/api/site-stats"), 60, async () =>
    json(await getSiteStats(env), 200, { "cache-control": "public, max-age=300" })
  );
}
