import { AGE_GATE_PATH } from "./ageGate";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";
import { INDEX_MIN_VOLUMES, seriesPagePath } from "./seriesPage";
import { site, siteVariant } from "./site";
import { Env } from "./types";

// robots.txt と sitemap.xml。どちらもドメインを含むので、静的ファイルに置かず配信時の
// オリジンから組む（本家と R18版で同じコードを使うため。
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
  "/series",
  "/about",
  "/books-guide",
  "/terms",
  "/privacy",
  "/operator",
] as const;

/** 1 時間。内容はデプロイでしか変わらないが、長く持たせても得がないので控えめに。 */
const CACHE_CONTROL = "public, max-age=3600";

// sitemap.xml はサイトマップの索引にして、静的ページ（sitemap-pages.xml）とシリーズの個別ページ
// （sitemap-series-<n>.xml、src/seriesPage.ts）を分けて載せる。1 ファイル 5 万 URL の上限より
// 十分小さく切る（2 巻以上のシリーズは約 3.7 万本）。シリーズの分は series_stats（巻一覧と同じ
// 数え方の巻数。cron が埋める、src/seriesList.ts）から引き、結合で吸収された側は出さない。
/** シリーズの sitemap 1 ファイルあたりの URL 数。 */
export const SERIES_SITEMAP_SIZE = 10000;
/** シリーズの sitemap のエッジキャッシュ。シリーズは月次の取り込みでしか増えない。 */
const SERIES_SITEMAP_TTL_SEC = 6 * 60 * 60;
const SERIES_SITEMAP_RE = /^\/sitemap-series-([1-9][0-9]{0,2})\.xml$/;

const SERIES_WHERE = `st.vol_count >= ?1
   AND EXISTS (SELECT 1 FROM series s WHERE s.id = st.series_id)
   AND NOT EXISTS (SELECT 1 FROM series_merge m WHERE m.absorbed_id = st.series_id)`;

async function seriesSitemapCount(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM series_stats st WHERE ${SERIES_WHERE}`)
    .bind(INDEX_MIN_VOLUMES)
    .first<{ n: number }>();
  return Math.ceil((r?.n ?? 0) / SERIES_SITEMAP_SIZE);
}

async function seriesSitemapIds(env: Env, page: number): Promise<string[]> {
  const rows =
    (
      await env.DB.prepare(
        `SELECT st.series_id AS id FROM series_stats st WHERE ${SERIES_WHERE}
          ORDER BY st.series_id LIMIT ?2 OFFSET ?3`
      )
        .bind(INDEX_MIN_VOLUMES, SERIES_SITEMAP_SIZE, (page - 1) * SERIES_SITEMAP_SIZE)
        .all<{ id: string }>()
    ).results ?? [];
  return rows.map((r) => r.id);
}

export function sitemapIndexXml(origin: string, seriesFiles: number): string {
  const files = ["/sitemap-pages.xml", ...Array.from({ length: seriesFiles }, (_, i) => `/sitemap-series-${i + 1}.xml`)];
  const items = files.map((f) => `  <sitemap><loc>${origin}${f}</loc></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>`;
}

export function urlsetXml(origin: string, paths: readonly string[]): string {
  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

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

/** 静的ページの sitemap（/sitemap-pages.xml）。 */
export function sitemapXml(origin: string, env: Pick<Env, "SITE_VARIANT">): string {
  const paths = site(env).allAgesRankings ? SITEMAP_PATHS : SITEMAP_PATHS.filter((p) => !ALL_AGES_ONLY.includes(p));
  return urlsetXml(origin, paths);
}

/** /llms.txt（https://llmstxt.org/）。AI のクローラ・エージェント向けに、サイトの中身と、
 *  シリーズの巻数を答えるページの URL の形を書いておく。 */
export function llmsTxt(origin: string, env: Pick<Env, "SITE_VARIANT">): string {
  const s = site(env);
  const rankings = s.allAgesRankings
    ? [
        `- [売上ランキング](${origin}/sales-ranking): 楽天ブックスのコミック売れ筋をシリーズ単位にまとめたもの`,
        `- [発行部数ランキング](${origin}/circulation): 累計発行部数の多い漫画`,
      ]
    : [];
  return [
    `# ${s.name}`,
    "",
    "> 自分を構成する100の漫画を選んで共有するサイト。漫画のシリーズごとに、何巻まで出ているか（全何巻か）と各巻の発売日を、メディア芸術データベース（国立アートリサーチセンター）の単行本の記録をもとに載せています。",
    "",
    "## シリーズの巻数",
    "",
    `- [シリーズ一覧](${origin}/series): 巻数の多い順。各シリーズの個別ページへのリンク`,
    `- シリーズの個別ページは ${origin}/s/<シリーズID> の形です${s.variant === "general" ? `（例: ${origin}/s/C295645）` : ""}。ページの冒頭に「〇〇は全N巻」または「既刊N巻（YYYY年M月時点）」の答えがあり、巻の一覧・発売日・同じ作品の別の版（文庫版など）を載せています`,
    "- 「全N巻」は最後の巻から3年以上新刊が無いシリーズ、「既刊N巻」はそれ以外です。巻数はデータベースに載っている単行本の数で、新装版・文庫版は別のシリーズとして数えます",
    "",
    "## ほかのページ",
    "",
    `- [公開リスト](${origin}/lists): 利用者が作った「自分を構成する100の漫画」`,
    `- [人気ランキング](${origin}/ranking): 公開リストに多く選ばれている漫画`,
    ...rankings,
    `- [このサイトについて](${origin}/about): データの出典`,
    "",
  ].join("\n");
}

/** GET /robots.txt・/sitemap.xml（索引）・/sitemap-pages.xml・/sitemap-series-<n>.xml・/llms.txt。
 *  該当しなければ null（呼び出し側が先へ流す）。 */
export async function handleSiteFile(path: string, method: string, origin: string, env: Env): Promise<Response | null> {
  if (method !== "GET") return null;
  const text = (body: string, type: string, cc = CACHE_CONTROL) =>
    new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": cc } });
  if (path === "/robots.txt") return text(robotsTxt(origin, env), "text/plain");
  if (path === "/llms.txt") return text(llmsTxt(origin, env), "text/plain");
  if (path === "/sitemap-pages.xml") return text(sitemapXml(origin, env), "application/xml");
  if (path === "/sitemap.xml") {
    return withEdgeCache(edgeCacheKey(env, "/sitemap.xml", { o: origin }), SERIES_SITEMAP_TTL_SEC, async () =>
      text(sitemapIndexXml(origin, await seriesSitemapCount(env)), "application/xml")
    );
  }
  const m = SERIES_SITEMAP_RE.exec(path);
  if (m) {
    const page = Number(m[1]);
    return withEdgeCache(edgeCacheKey(env, "/sitemap-series", { o: origin, page }), SERIES_SITEMAP_TTL_SEC, async () => {
      const ids = await seriesSitemapIds(env, page);
      if (!ids.length) return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
      return text(urlsetXml(origin, ids.map(seriesPagePath)), "application/xml");
    });
  }
  return null;
}
