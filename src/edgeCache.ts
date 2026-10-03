import { siteVariant } from "./site";
import { Env } from "./types";

// 公開 GET API の応答を Cache API (caches.default) にデータセンタ単位で短時間キャッシュする。
// D1 を毎回なめる読み取り（検索・公開リスト一覧・収録数・売上ランキング）を、同じ内容の要求が
// 続く間は 1 回の計算で済ませるため。キャッシュは各データセンタのローカルなので、TTL の間は
// 更新が反映されない（どれも数十秒〜10 分の遅れなら困らないものだけに使う）。
//
// キーは実在しない内部ホストの URL にする（ハンドラが元の URL を受け取らないものもあるため）。
// ブラウザ向けの cache-control はハンドラが付けたものをそのまま返し、キャッシュに入れる写しだけ
// TTL の max-age に差し替える（検索はブラウザには no-store のまま、エッジでだけ 10 分持つ）。

// ホスト名にサイト種別（src/site.ts）を入れる。Cache API はゾーン単位なので、本家と R18 版を同じ
// ゾーンに置いても互いのキャッシュ（検索結果など）を読まないように。
const CACHE_HOST = "edge-cache.my100manga.internal";
const CLIENT_CC = "x-client-cache-control";

/** キャッシュキー（GET の Request）。path は "/api/search" のような先頭 "/" 付き。 */
export function edgeCacheKey(
  env: Pick<Env, "SITE_VARIANT">,
  path: string,
  params: Record<string, string | number> = {}
): Request {
  const url = new URL(path, `https://${siteVariant(env)}.${CACHE_HOST}`);
  for (const k of Object.keys(params).sort()) url.searchParams.set(k, String(params[k]));
  return new Request(url.toString(), { method: "GET" });
}

function defaultCache(): Cache | null {
  // テストランタイムや Cache API の無い環境では素通し。
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

/** key のキャッシュがあればそれを返し、無ければ build() の結果を返しつつ ttlSec 秒キャッシュする。
 *  キャッシュに入れるのは cacheable(res)（既定: 200）を満たす応答だけ。Cache API の失敗は握りつぶして
 *  build() の結果を返す（キャッシュはあくまで最適化）。 */
export async function withEdgeCache(
  key: Request,
  ttlSec: number,
  build: () => Promise<Response>,
  cacheable: (res: Response) => boolean = (res) => res.status === 200
): Promise<Response> {
  const cache = defaultCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const headers = new Headers(hit.headers);
        const cc = headers.get(CLIENT_CC);
        headers.delete(CLIENT_CC);
        if (cc !== null) headers.set("cache-control", cc);
        else headers.delete("cache-control");
        return new Response(hit.body, { status: hit.status, headers });
      }
    } catch (err) {
      console.error("edge cache match failed", err);
    }
  }

  const res = await build();
  if (!cache || !cacheable(res)) return res;
  const body = await res.arrayBuffer();
  try {
    const stored = new Headers(res.headers);
    stored.set(CLIENT_CC, res.headers.get("cache-control") ?? "");
    stored.set("cache-control", `public, max-age=${ttlSec}`);
    await cache.put(key, new Response(body.slice(0), { status: res.status, headers: stored }));
  } catch (err) {
    console.error("edge cache put failed", err);
  }
  return new Response(body, { status: res.status, headers: res.headers });
}

/** key のキャッシュをこのデータセンタから消す（他のデータセンタの分は TTL まで残る）。 */
export async function purgeEdgeCache(keys: Request[]): Promise<void> {
  const cache = defaultCache();
  if (!cache) return;
  await Promise.all(keys.map((k) => cache.delete(k).catch(() => false)));
}
