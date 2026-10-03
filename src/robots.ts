import { AGE_GATE_PATH } from "./ageGate";
import { site, siteVariant } from "./site";
import { Env } from "./types";

// robots.txt と sitemap.xml。どちらもドメインを含むので、静的ファイルに置かず配信時の
// オリジンから組む（本家 my100manga.com と R18版 my100shunga.com で同じコードを使うため。
// src/analytics.ts の applySiteIdentity は HTML にしか効かない）。see docs/r18.md

/** 全年齢のデータ源によるランキング。R18版では sitemap にもヘッダーにも出さない
 *  （src/site.ts allAgesRankings、src/header.ts）。 */
const ALL_AGES_ONLY: readonly string[] = ["/sales-ranking", "/circulation"];

/** sitemap に載せる公開ページ。リストの閲覧ページ（/l/<slug>）は数が多く入れ替わるうえ、
 *  限定公開は noindex なので載せない（各ページの canonical と og で拾われる）。
 *  静的ページを足したらここにも足す。 */
export const SITEMAP_PATHS = [
  "/",
  "/lists",
  "/ranking",
  "/sales-ranking",
  "/circulation",
  "/about",
  "/books-guide",
  "/terms",
  "/privacy",
  "/operator",
] as const;

/** 1 時間。内容はデプロイでしか変わらないが、長く持たせても得がないので控えめに。 */
const CACHE_CONTROL = "public, max-age=3600";

export function robotsTxt(origin: string, env: Pick<Env, "SITE_VARIANT">): string {
  // R18版は年齢確認ゲート（src/ageGate.ts）の画面を拾わせない。クローラはゲートを素通りする
  // ので本来ここには来ないが、直接引かれたときのため。
  const gate = siteVariant(env) === "adult" ? [`Disallow: ${AGE_GATE_PATH}`] : [];
  return [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /api/",
    ...gate,
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemapXml(origin: string, env: Pick<Env, "SITE_VARIANT">): string {
  const paths = site(env).allAgesRankings ? SITEMAP_PATHS : SITEMAP_PATHS.filter((p) => !ALL_AGES_ONLY.includes(p));
  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

/** GET /robots.txt・GET /sitemap.xml。該当しなければ null（呼び出し側が先へ流す）。 */
export function handleSiteFile(path: string, method: string, origin: string, env: Env): Response | null {
  if (method !== "GET") return null;
  if (path === "/robots.txt") {
    return new Response(robotsTxt(origin, env), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": CACHE_CONTROL },
    });
  }
  if (path === "/sitemap.xml") {
    return new Response(sitemapXml(origin, env), {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": CACHE_CONTROL },
    });
  }
  return null;
}
