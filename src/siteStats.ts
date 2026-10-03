import { Env } from "./types";
import { json } from "./util";
import { readMaterialized } from "./metaCache";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";

// トップページに出す収録数（シリーズ / 巻(ISBN) / 公開リスト）。series・volumes の COUNT(*) は
// 数十万行を読むので、公開エンドポイントから毎回叩かないよう ranking.ts と同じく meta に
// materialize する。series・volumes は月次の取り込みでしか変わらないので 1 日、lists は
// 10 分持つ。lists は全行が公開済みリスト（未公開の下書きはブラウザ側にしか無い）。

const MASTER_TTL_MS = 24 * 60 * 60 * 1000;
const LISTS_TTL_MS = 10 * 60 * 1000;
const MASTER_KEYS = { json: "site_stats_master_json", at: "site_stats_master_at" };
const LISTS_KEYS = { json: "site_stats_lists_json", at: "site_stats_lists_at" };

interface SiteStats {
  series: number;
  volumes: number;
  lists: number;
  computed_at: number;
}

async function count(env: Env, sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

async function getSiteStats(env: Env, ctx: ExecutionContext): Promise<SiteStats> {
  // TTL 切れの瞬間に要求が重なっても再計算するのは 1 件だけで、裏で行う（src/metaCache.ts）。
  const [master, lists] = await Promise.all([
    readMaterialized(
      env,
      MASTER_KEYS,
      MASTER_TTL_MS,
      async () => {
        const [series, volumes] = await Promise.all([
          count(env, `SELECT COUNT(*) AS n FROM series`),
          count(env, `SELECT COUNT(*) AS n FROM volumes`),
        ]);
        return { series, volumes };
      },
      ctx
    ),
    readMaterialized(env, LISTS_KEYS, LISTS_TTL_MS, async () => ({ lists: await count(env, `SELECT COUNT(*) AS n FROM lists`) }), ctx),
  ]);
  return { series: master.series, volumes: master.volumes, lists: lists.lists, computed_at: Date.now() };
}

/** GET /api/site-stats — トップページの収録数表示用。 */
export async function handleSiteStats(env: Env, ctx: ExecutionContext): Promise<Response> {
  // トップページのたびに呼ばれるので、エッジでも 60 秒持って meta の読み取りも省く。
  return withEdgeCache(edgeCacheKey(env, "/api/site-stats"), 60, async () =>
    json(await getSiteStats(env, ctx), 200, { "cache-control": "public, max-age=300" })
  );
}
