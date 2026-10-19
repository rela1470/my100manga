import { affData, analyticsTags, appVersion, applySiteIdentity, gtmBody, injectVersion } from "./analytics";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";
import { footerHtml } from "./footer";
import { headerLinksHtml } from "./header";
import { cachedSeriesVolumes, getSeriesVolumes } from "./series";
import { isCompleteRun } from "./seriesStats";
import { site } from "./site";
import { fetchSiteAsset } from "./siteAssets";
import { Env } from "./types";
import { escapeHtml, plainVolumeNumber, replaceLiteral } from "./util";
import { getViewEpoch } from "./viewSnapshot";

// シリーズの個別ページ（GET /s/<id>）。検索エンジンと AI に「〇〇は全何巻？」の答えを拾わせるため、
// 巻一覧（src/series.ts getSeriesVolumes、/api/series/:id/volumes と同じもの）をサーバで HTML に
// 組む。答えは <title>・description・本文の冒頭・構造化データ（JSON-LD の BookSeries / FAQPage）
// の全部に同じ文で書く。本文は JS 無しで読める（クローラの多くは JS を実行しない）。
//
// 「全N巻」と言い切るのは、最後の巻から STALE_MONTHS 以上新刊の無いシリーズだけ。MADB には完結の
// 印が無く、連載中の作品に「全」と書くと誤りになるので、新しいものは「既刊N巻（YYYY年M月時点）」に
// する。休載中の作品（長く新刊の無い未完の作品）も「全N巻」になるが、本文で「第N巻を最後に新刊は
// 出ていません」と事実だけを添える。
//
// 巻数は巻一覧に並ぶ冊数で、シリーズ一覧（/series）・series_stats と同じ数え方。
//
// 2 巻以上のシリーズだけを検索に載せる（sitemap にも 2 巻以上だけを出す。src/robots.ts）。1 巻物は
// 約 9 万本あり、中身の薄いページを大量に載せると、サイト全体の評価を下げかねないため。

/** この月数より新刊が無ければ「全N巻」と書く。 */
export const STALE_MONTHS = 36;
/** 検索に載せる下限の巻数。 */
export const INDEX_MIN_VOLUMES = 2;
/** エッジキャッシュの秒数。表示データの世代（view_epoch）とデプロイ版をキーに入れているので、
 *  管理者の変更・デプロイでは外れる。月次の取り込みと補完・手動追加の反映がこの分だけ遅れる。 */
const PAGE_EDGE_TTL_SEC = 6 * 60 * 60;
/** ブラウザには持たせない（デプロイ後に古い HTML と ?v= の付いた古い JS を使い続けないように）。 */
const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=300";
/** 同じ作品の別の版として並べる上限。 */
const SIBLINGS_MAX = 12;

/** /s/<id> で受け付ける ID。シリーズ（C-id）と運営が作ったシリーズ（U-id）。まとまり（G<ISBN>）は
 *  シリーズではないので個別ページを持たない。 */
export const SERIES_PAGE_RE = /^\/s\/([CU][0-9A-Za-z]{1,20})$/;

export function seriesPagePath(id: string): string {
  return `/s/${id}`;
}

export interface PageVolume {
  isbn: string;
  volume_number: string;
  vol_sort: number;
  title: string;
  subtitle: string;
  pubdate: string;
  cover_url: string;
}

export interface PageSeries {
  series_id: string;
  title: string;
  version: string;
  creator: string;
  creators: string;
  master_updated_at: number;
  volumes: PageVolume[];
}

export interface PageSibling {
  id: string;
  name: string;
  version: string;
  label: string;
  publisher: string;
  vol_count: number;
}

/** "2021-10" / "2000-08-16" / "1977" → "2021年10月" / "2000年8月" / "1977年"。読めなければ ""。 */
export function formatPubdate(pubdate: string): string {
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec((pubdate ?? "").trim());
  if (!m) return "";
  return m[2] ? `${m[1]}年${Number(m[2])}月` : `${m[1]}年`;
}

function monthIndex(pubdate: string): number | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec((pubdate ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0);
}

/** 巻の見出し。巻番号だけの巻は「第N巻」にそろえ、それ以外（「外伝」「2020年版」）はそのまま。 */
export function volumeLabel(v: Pick<PageVolume, "volume_number" | "subtitle">): string {
  const n = plainVolumeNumber(v.volume_number ?? "");
  const base = n !== null ? `第${n}巻` : (v.volume_number ?? "").trim();
  if (base) return base;
  return (v.subtitle ?? "").trim();
}

export interface SeriesAnswer {
  count: number;
  /** 巻番号が 1..count で欠けなくそろっている。 */
  complete: boolean;
  /** 最後の巻から STALE_MONTHS 以上新刊が無い（「全N巻」と書く）。 */
  ended: boolean;
  /** 「全201巻」/「既刊111巻」。 */
  headline: string;
  first: PageVolume | null;
  last: PageVolume | null;
  /** 冒頭に置く答えの文。 */
  sentence: string;
}

/** 発売日のいちばん新しい巻（同じ月なら巻番号の大きい方）。発売日の無い巻しか無ければ末尾の巻。 */
function latestVolume(vols: PageVolume[]): PageVolume | null {
  let best: PageVolume | null = null;
  for (const v of vols) {
    if (!v.pubdate) continue;
    if (!best || v.pubdate > best.pubdate || (v.pubdate === best.pubdate && v.vol_sort > best.vol_sort)) best = v;
  }
  return best ?? vols[vols.length - 1] ?? null;
}

function earliestVolume(vols: PageVolume[]): PageVolume | null {
  let best: PageVolume | null = null;
  for (const v of vols) {
    if (!v.pubdate) continue;
    if (!best || v.pubdate < best.pubdate || (v.pubdate === best.pubdate && v.vol_sort < best.vol_sort)) best = v;
  }
  return best ?? vols[0] ?? null;
}

function withDate(v: PageVolume): string {
  const d = formatPubdate(v.pubdate);
  return d ? `${volumeLabel(v)}（${d}発売）` : volumeLabel(v);
}

/** 「〇〇は全何巻？」の答え。name は『』の中に入れる表示名。now は epoch ms。 */
export function seriesAnswer(name: string, vols: PageVolume[], now: number, asOf: number): SeriesAnswer {
  const count = vols.length;
  const complete = count > 0 && isCompleteRun(vols, count);
  const first = earliestVolume(vols);
  const last = latestVolume(vols);
  const nowDate = new Date(now);
  const nowIdx = nowDate.getUTCFullYear() * 12 + nowDate.getUTCMonth();
  const lastIdx = last ? monthIndex(last.pubdate) : null;
  const ended = lastIdx !== null && nowIdx - lastIdx >= STALE_MONTHS;
  const headline = ended ? `全${count}巻` : `既刊${count}巻`;
  const q = `『${name}』`;

  let sentence: string;
  if (!count) {
    sentence = `${q}の巻の情報は、まだありません。`;
  } else if (ended) {
    const range = complete && count > 1 ? `第1巻から第${count}巻まで刊行され、` : "";
    sentence = last
      ? `${q}は全${count}巻です。${range}${withDate(last)}を最後に新刊は出ていません。`
      : `${q}は全${count}巻です。`;
  } else {
    const asOfText = asOf ? formatPubdate(new Date(asOf).toISOString().slice(0, 7)) : "";
    sentence = `${q}は既刊${count}巻です${asOfText ? `（${asOfText}時点）` : ""}。`;
    if (last) sentence += `最新刊は${withDate(last)}です。`;
  }
  return { count, complete, ended, headline, first, last, sentence };
}

/** 同名の別の版があるときに、どの版かを見分ける添え字（レーベル > 出版社）。 */
function editionOf(label: string, publisher: string): string {
  return (label || publisher || "").trim();
}

/** 表示名。版（schema:version）を添え、同名の別の版のほうが巻数が多い（同じ）ならレーベルも添える
 *  （「こちら葛飾区亀有公園前派出所」はジャンプ・コミックス版が素の名前を取り、文庫版は
 *  「（集英社文庫 コミック版）」付きになる。巻数が同じなら両方に添えて見分ける）。 */
export function pageDisplayName(
  data: Pick<PageSeries, "title" | "version">,
  label: string,
  publisher: string,
  count: number,
  siblings: PageSibling[]
): string {
  let name = data.version ? `${data.title}（${data.version}）` : data.title;
  const edition = editionOf(label, publisher);
  if (edition && siblings.some((s) => s.vol_count >= count)) {
    name += `（${edition}）`;
  }
  return name;
}

/** 表紙の URL。Yahoo とももったいない本舗は /cover を通す（public/cover-fit.js needsTrim と同じ）。 */
const MOTTAINAI_RE = /^\/@0_mall\/(comicset|mottainaihonpo|mottainaihonpo-omatome)\/cabinet\//;
export function pageCoverSrc(url: string): string {
  if (!url) return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const trim =
    /(^|\.)yimg\.jp$/.test(u.hostname) ||
    (u.hostname === "thumbnail.image.rakuten.co.jp" && MOTTAINAI_RE.test(u.pathname));
  return trim ? `/cover?u=${encodeURIComponent(url)}` : url;
}

/** JSON-LD を <script> に入れても閉じタグにならないように。 */
function ldJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** 「原作：A、作画：B」→ ["A", "B"]。役割の無い表記はそのまま 1 人。 */
export function creatorNames(creators: string, creator: string): string[] {
  const src = (creators || creator || "").trim();
  if (!src) return [];
  const names = src
    .split(/[、,]/)
    .map((p) => p.replace(/^[^：:]*[：:]/, "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

export interface PageParts {
  head: string;
  body: string;
  indexable: boolean;
}

export interface PageContext {
  origin: string;
  siteName: string;
  label: string;
  publisher: string;
  siblings: PageSibling[];
  now: number;
}

/** <head> の差し込みと本文。純粋関数（テストから直接呼ぶ）。 */
export function buildSeriesPage(data: PageSeries, ctx: PageContext): PageParts {
  const vols = data.volumes ?? [];
  const name = pageDisplayName(data, ctx.label, ctx.publisher, vols.length, ctx.siblings);
  const ans = seriesAnswer(name, vols, ctx.now, data.master_updated_at);
  const indexable = ans.count >= INDEX_MIN_VOLUMES;
  const pageUrl = `${ctx.origin}${seriesPagePath(data.series_id)}`;
  const names = creatorNames(data.creators, data.creator);
  const edition = editionOf(ctx.label, ctx.publisher);
  const lastWord = ans.ended ? "最終巻" : "最新刊";
  const lastDate = ans.last ? formatPubdate(ans.last.pubdate) : "";

  const title = `${name}は全何巻？${ans.count ? `${ans.headline}${lastDate ? `・${lastWord}は${lastDate}発売` : ""}` : ""}`;
  const desc =
    ans.sentence +
    (names.length ? `作者は${names.join("、")}。` : "") +
    (edition ? `${edition}。` : "") +
    (ans.count ? `第1巻から最新の巻まで、各巻の発売日と表紙を一覧にしています。` : "");
  const cover = vols.find((v) => v.cover_url)?.cover_url ?? "";
  const ogImage = pageCoverSrc(cover).startsWith("/") ? `${ctx.origin}${pageCoverSrc(cover)}` : pageCoverSrc(cover);

  // ── よくある質問（本文と FAQPage で同じ文を使う）──
  const faq: { q: string; a: string }[] = [];
  if (ans.count) {
    faq.push({ q: `『${name}』は全何巻？`, a: ans.sentence });
    if (ans.last) {
      faq.push({
        q: `『${name}』の${lastWord}は何巻？`,
        a: `${lastWord}は${withDate(ans.last)}です。`,
      });
    }
    // 巻の一覧の先頭（読む順の最初の巻）。発売日が空なら聞かれても答えられないので出さない
    // （発売日のいちばん古い巻を代わりに答えると「第1巻は？」に第2巻を答えてしまう）。
    const head = vols[0];
    if (head?.pubdate) {
      faq.push({ q: `『${name}』の${volumeLabel(head)}はいつ発売？`, a: `${withDate(head)}です。` });
    }
  }
  if (ctx.siblings.length) {
    const list = ctx.siblings
      .map((s) => `${siblingName(s)}（${s.vol_count}巻）`)
      .join("、");
    faq.push({ q: `『${data.title}』にはほかにどんな版がある？`, a: `${list}があります。` });
  }

  // ── 構造化データ ──
  const series: Record<string, unknown> = {
    "@type": "BookSeries",
    "@id": `${pageUrl}#series`,
    name,
    url: pageUrl,
    inLanguage: "ja",
    genre: "漫画",
  };
  if (names.length) series.author = names.map((n) => ({ "@type": "Person", name: n }));
  if (ctx.publisher) series.publisher = { "@type": "Organization", name: ctx.publisher };
  if (ans.first?.pubdate) series.startDate = ans.first.pubdate;
  if (ans.ended && ans.last?.pubdate) series.endDate = ans.last.pubdate;
  if (ogImage) series.image = ogImage;
  series.hasPart = vols.map((v, i) => {
    const part: Record<string, unknown> = { "@type": "Book", name: `${data.title} ${volumeLabel(v)}`.trim(), position: i + 1 };
    if (v.isbn) part.isbn = v.isbn;
    if (v.pubdate) part.datePublished = v.pubdate;
    return part;
  });
  const graph: unknown[] = [
    series,
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: ctx.siteName, item: `${ctx.origin}/` },
        { "@type": "ListItem", position: 2, name: "シリーズ一覧", item: `${ctx.origin}/series` },
        { "@type": "ListItem", position: 3, name, item: pageUrl },
      ],
    },
  ];
  if (faq.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  const e = escapeHtml;
  const fullTitle = `${title} | ${ctx.siteName}`;
  const head = [
    `<title>${e(fullTitle)}</title>`,
    `<meta name="description" content="${e(desc)}">`,
    ...(indexable ? [] : [`<meta name="robots" content="noindex">`]),
    `<link rel="canonical" href="${e(pageUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${e(ctx.siteName)}">`,
    `<meta property="og:title" content="${e(fullTitle)}">`,
    `<meta property="og:description" content="${e(desc)}">`,
    `<meta property="og:url" content="${e(pageUrl)}">`,
    `<meta property="og:image" content="${e(ogImage || `${ctx.origin}/og-default.png`)}">`,
    `<meta name="twitter:card" content="${ogImage ? "summary" : "summary_large_image"}">`,
    `<script type="application/ld+json">${ldJson({ "@context": "https://schema.org", "@graph": graph })}</script>`,
  ].join("\n  ");

  // ── 本文 ──
  const info: [string, string][] = [];
  if (names.length) info.push(["作者", data.creators || data.creator]);
  if (ctx.publisher) info.push(["出版社", ctx.publisher]);
  if (ctx.label) info.push(["レーベル", ctx.label]);
  if (data.version) info.push(["版", data.version]);
  if (ans.count) info.push(["巻数", ans.headline + (ans.complete ? "" : "（巻の一覧に並ぶ冊数）")]);
  if (ans.first?.pubdate) {
    const from = formatPubdate(ans.first.pubdate);
    const to = ans.last ? formatPubdate(ans.last.pubdate) : "";
    info.push(["刊行", to && to !== from ? `${from}〜${to}` : from]);
  }

  const volItems = vols
    .map((v) => {
      const label = volumeLabel(v);
      const alt = `${data.title} ${label}`.trim();
      const src = pageCoverSrc(v.cover_url);
      const cover = src
        ? `<img class="cover" src="${e(src)}" alt="${e(alt)}" loading="lazy" decoding="async">`
        : `<div class="cover placeholder">${e(label)}</div>`;
      const date = formatPubdate(v.pubdate);
      return (
        `<li class="slot view sp-vol" data-isbn="${e(v.isbn)}"${src ? "" : ` data-cover-isbn="${e(v.isbn)}"`}>` +
        cover +
        `<div class="meta"><div class="t">${e(label)}</div>${date ? `<div class="c">${e(date)}</div>` : ""}</div>` +
        `</li>`
      );
    })
    .join("\n      ");

  const siblingItems = ctx.siblings
    .map(
      (s) =>
        `<li><a href="${e(seriesPagePath(s.id))}">${e(siblingName(s))}</a>（${s.vol_count}巻）</li>`
    )
    .join("\n        ");

  const body = `<nav class="sp-crumbs" aria-label="パンくずリスト"><a href="/">トップ</a> › <a href="/series">シリーズ一覧</a> › <span>${e(name)}</span></nav>

    <article class="sp" data-series-id="${e(data.series_id)}" data-series-title="${e(name)}">
      <h1 class="sp-q">『${e(name)}』は全何巻？</h1>
      <p class="sp-answer"><strong>${e(ans.headline)}</strong></p>
      <p class="lead">${e(ans.sentence)}</p>

      ${info.length ? `<dl class="sp-info">${info.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl>` : ""}

      <div class="publish-bar">
        <button type="button" class="primary" id="spOpen"${ans.count ? "" : " hidden"}>巻を選んで自分の100に追加</button>
      </div>

      ${ans.count ? `<h3 class="sp-h">巻の一覧（${e(ans.headline)}）</h3>
      <ol class="grid sp-vols" aria-label="${e(name)}の巻の一覧">
      ${volItems}
      </ol>` : ""}

      ${siblingItems ? `<h3 class="sp-h">同じ作品の別の版</h3>
      <ul class="sp-siblings">
        ${siblingItems}
      </ul>` : ""}

      ${faq.length ? `<h3 class="sp-h">よくある質問</h3>
      <dl class="sp-faq">${faq.map((f) => `<dt>${e(f.q)}</dt><dd>${e(f.a)}</dd>`).join("")}</dl>` : ""}

      <p class="rank-source">
        巻数と発売日は<a href="/about">メディア芸術データベース</a>（国立アートリサーチセンター）の
        単行本の記録をもとにしています。まだ出ていない巻や、データベースに載っていない巻は数えていません。
        新装版・文庫版などは別のシリーズとして数えます。
      </p>
    </article>

    <div class="publish-bar">
      <a class="button primary" href="/">自分の100を作る</a>
    </div>`;

  return { head, body, indexable };
}

function siblingName(s: PageSibling): string {
  const base = s.version ? `${s.name}（${s.version}）` : s.name;
  const edition = editionOf(s.label, s.publisher);
  return edition ? `${base}（${edition}）` : base;
}

async function loadSiblingsAndLabel(
  env: Env,
  id: string
): Promise<{ label: string; publisher: string; siblings: PageSibling[] }> {
  const self = await env.DB.prepare(`SELECT name_norm, label, publisher FROM series WHERE id = ?`)
    .bind(id)
    .first<{ name_norm: string; label: string | null; publisher: string | null }>();
  if (!self) return { label: "", publisher: "", siblings: [] };
  const rows =
    (
      await env.DB.prepare(
        `SELECT s.id, COALESCE(o.name, s.name_display, s.name) AS name, s.version, s.label, s.publisher, st.vol_count
           FROM series s
           JOIN series_stats st ON st.series_id = s.id
           LEFT JOIN series_name_override o ON o.series_id = s.id
          WHERE s.name_norm = ?1 AND s.id <> ?2 AND st.vol_count > 0
            AND NOT EXISTS (SELECT 1 FROM series_merge m WHERE m.absorbed_id = s.id)
          ORDER BY st.vol_count DESC, s.id
          LIMIT ?3`
      )
        .bind(self.name_norm, id, SIBLINGS_MAX)
        .all<{ id: string; name: string; version: string | null; label: string | null; publisher: string | null; vol_count: number }>()
    ).results ?? [];
  return {
    label: self.label ?? "",
    publisher: self.publisher ?? "",
    siblings: rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version ?? "",
      label: r.label ?? "",
      publisher: r.publisher ?? "",
      vol_count: r.vol_count,
    })),
  };
}

async function notFoundPage(env: Env, origin: string): Promise<Response> {
  const res = await fetchSiteAsset(new Request(`${origin}/404`), env, "/404");
  const html = res.ok ? await res.text() : "<!doctype html><title>Not Found</title><p>シリーズが見つかりません。</p>";
  return new Response(
    injectVersion(
      applySiteIdentity(html, env, origin)
        .replace("<!--ANALYTICS-->", analyticsTags(env))
        .replace("<!--GTM_BODY-->", gtmBody(env))
        .replace("<!--HEADER_LINKS-->", headerLinksHtml(env))
        .replace("<!--FOOTER-->", footerHtml(env)),
      appVersion(env)
    ),
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

/** GET /s/<id>。結合で吸収された側は残す側へ 301。見つからなければ 404。 */
export async function renderSeriesPage(env: Env, id: string, origin: string): Promise<Response> {
  const key = edgeCacheKey(env, "/s", { id, e: await getViewEpoch(env), v: appVersion(env), o: origin });
  return withEdgeCache(
    key,
    PAGE_EDGE_TTL_SEC,
    async () => {
      const res = await cachedSeriesVolumes(env, id, () => getSeriesVolumes(env, id));
      if (res.status === 404) return notFoundPage(env, origin);
      if (!res.ok) throw new Error(`series volumes ${res.status}`);
      const data = (await res.json()) as PageSeries;
      if (data.series_id !== id) {
        return new Response(null, {
          status: 301,
          headers: { location: `${origin}${seriesPagePath(data.series_id)}`, "cache-control": "public, max-age=3600" },
        });
      }
      const { label, publisher, siblings } = await loadSiblingsAndLabel(env, id);
      const s = site(env);
      const parts = buildSeriesPage(data, { origin, siteName: s.name, label, publisher, siblings, now: Date.now() });

      const template = await (await fetchSiteAsset(new Request(`${origin}/series-page.html`), env, "/series-page.html")).text();
      // テンプレートへの差し込み（バージョン印・サイト種別）はシリーズ名などを入れる前に済ませる。
      let html = injectVersion(
        applySiteIdentity(template, env, origin)
          .replace("<!--HEADER_LINKS-->", headerLinksHtml(env))
          .replace("<!--FOOTER_AFF-->", footerHtml(env, true)),
        appVersion(env)
      );
      const fill: [string, string][] = [
        ["<!--SERIES_HEAD-->", parts.head],
        ["<!--SERIES_BODY-->", parts.body],
        ["<!--ANALYTICS-->", analyticsTags(env)],
        ["<!--GTM_BODY-->", gtmBody(env)],
        ["<!--AFF_DATA-->", affData(env)],
      ];
      for (const [ph, value] of fill) html = replaceLiteral(html, ph, value);
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": PAGE_CACHE_CONTROL,
      };
      if (!parts.indexable) headers["x-robots-tag"] = "noindex";
      return new Response(html, { headers });
    },
    (r) => r.status === 200 || r.status === 301
  );
}
