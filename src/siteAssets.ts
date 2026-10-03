import { siteVariant } from "./site";
import { Env } from "./types";

// R18版だけ、静的ファイルを public/adult/ のものに差し替えて配信する。利用規約・プライバシー・
// about・運営者のように本文が実質別物になるページと、og 画像・favicon のような顔まわりが対象。
// public/adult/ に同名のファイルがあればそれを、無ければ本家のファイルをそのまま返す。
// assets は run_worker_first なので、env.ASSETS.fetch に渡す URL を差し替えるだけで済む。
// see docs/r18.md 4 節
//
// 本家（SITE_VARIANT="general"）では常に素の配信。どちらの種別でも /adult/… を直接引くことは
// できない（URL を 1 本に保つため 404 にする）。

const PREFIX = "/adult";

/** 顔まわりの画像。HTML ではないが種別で差し替えたいもの。 */
const BRAND_FILES = new Set(["/og-default.png", "/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"]);

/** R18版で差し替えを試すパスか。HTML（拡張子なしのクリーン URL と .html）と顔まわりの画像だけ。
 *  css/js/フォント/表紙などは種別で変わらないので、余計な ASSETS 引きをしない。 */
export function overridable(path: string): boolean {
  if (BRAND_FILES.has(path)) return true;
  if (path.endsWith(".html")) return true;
  return !/\.[a-z0-9]+$/i.test(path);
}

/** 差し替え先のパス。差し替えないなら null。 */
export function adultAssetPath(env: Pick<Env, "SITE_VARIANT">, path: string): string | null {
  if (siteVariant(env) !== "adult") return null;
  if (path.startsWith(`${PREFIX}/`)) return null;
  return overridable(path) ? `${PREFIX}${path === "/" ? "/index.html" : path}` : null;
}

/** /adult/… の直接アクセスか（種別によらず 404 にする）。 */
export function isAdultAssetPath(path: string): boolean {
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

/**
 * 静的ファイルの取得。R18版で public/adult/ に同名のものがあればそちらを返す。
 * env.ASSETS.fetch の代わりに使う。
 */
export async function fetchSiteAsset(request: Request, env: Env, path?: string): Promise<Response> {
  const url = new URL(request.url);
  const target = adultAssetPath(env, path ?? url.pathname);
  if (target) {
    url.pathname = target;
    const res = await env.ASSETS.fetch(new Request(url, request));
    // 見つからなければ not_found_handling により 404（本家のファイルへ落とす）。
    if (res.ok) return res;
  }
  return await env.ASSETS.fetch(request);
}
