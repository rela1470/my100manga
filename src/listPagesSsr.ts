import { injectAnalytics } from "./analytics";
import { CirculationPayload } from "./circulation";
import { handleCirculation } from "./circulation";
import { handlePublicLists } from "./publicLists";
import { handleRanking, RankEntry } from "./ranking";
import { handleSalesRanking, SalesPayload } from "./salesRanking";
import { SeriesListEntry, handleSeriesList } from "./seriesList";
import { pageCoverSrc } from "./seriesPage";
import { fetchSiteAsset } from "./siteAssets";
import { Env } from "./types";
import { escapeHtml } from "./util";

// 一覧系のページ（人気・売上・発行部数ランキング、シリーズ一覧、公開リスト一覧）の中身を
// サーバで HTML に埋めて返す。中身は各ページの JS が /api/* から取って描くが、それだと JS を
// 動かさないクローラ（AdSense の審査を含む）には見出しとナビしか見えず、「有用性の低い
// コンテンツ」と判定される。
//
// データは同じ /api/* のハンドラを内部で呼んで取る（エッジキャッシュ済みの応答を使い回すので
// D1 の負荷は増えない）。マークアップは各ページの JS（public/ranking.js 等）と同じ形にして、
// JS は読み込み後にいつもどおり描き直す（クリックで本の詳細を開くなどの挙動は JS が付ける）。
//
// テンプレートの差し込み口は <!--SSR_LIST-->（一覧の器の中）・<!--SSR_NOTE-->（一覧の上の
// 1 行）・<!--SSR_ATTRIBUTION-->（発行部数ランキングの出典）。データが無いときは空にする。

type Fill = { list: string; note: string; attribution?: string };

const e = escapeHtml;

/** 表紙。public/cover-fit.js の coverNode と同じ形（表紙が無ければタイトル入りの枠）。 */
function coverHtml(url: string, title: string, label = title): string {
  const src = pageCoverSrc(url);
  return src
    ? `<img class="cover" src="${e(src)}" alt="${e(title)}" loading="lazy" decoding="async">`
    : `<div class="cover placeholder">${e(label)}</div>`;
}

/** 順位つきの表紙 1 枠（public/ranking.js などの render と同じ形）。 */
function rankSlot(o: { href: string; rank: number; cover: string; title: string; tooltip?: string; subs: string[] }): string {
  const num = `<span class="num${o.rank <= 3 ? ` top${o.rank}` : ""}">${o.rank}</span>`;
  const meta =
    `<div class="meta"><div class="t">${e(o.title)}</div>` + o.subs.filter(Boolean).map((s) => `<div class="c">${e(s)}</div>`).join("") + `</div>`;
  const title = o.tooltip ? ` title="${e(o.tooltip)}"` : "";
  return `<a class="slot view rank-slot" href="${e(o.href)}"${title}>${num}${o.cover}${meta}</a>`;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return res.ok ? ((await res.json()) as T) : null;
}

// ── 人気ランキング（public/ranking.js。最初に開くのは累計）──
async function fillRanking(env: Env, ctx: ExecutionContext): Promise<Fill> {
  const data = await readJson<{ windows: Record<string, RankEntry[]> }>(await handleRanking(env, ctx));
  const entries = data?.windows.cumulative ?? [];
  return {
    note: entries.length ? "累計で選ばれた回数の多い順（選んだ人数）" : "",
    list: entries
      .map((r) =>
        rankSlot({
          href: `/?q=${encodeURIComponent(r.isbn)}`,
          rank: r.rank,
          cover: coverHtml(r.cover_url, r.title),
          title: r.title,
          tooltip: r.author ? `${r.title}（${r.author}）` : undefined,
          subs: [`${r.count}人が選択`],
        })
      )
      .join(""),
  };
}

// ── 売上ランキング（public/sales-ranking.js。最初に開くのは過去7日）──
const md = (day: string): string => {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
};

export function salesNote(data: Pick<SalesPayload, "latest_day" | "first_day">): string {
  if (!data.latest_day) return "";
  const start = new Date(Date.parse(data.latest_day + "T00:00:00Z") - 6 * 86400000).toISOString().slice(0, 10);
  const from = data.first_day > start ? data.first_day : start;
  const partial = data.first_day > start ? "（集計開始日から）" : "";
  return `${md(from)}〜${md(data.latest_day)} の集計${partial}`;
}

async function fillSales(env: Env): Promise<Fill> {
  const data = await readJson<SalesPayload>(await handleSalesRanking(env));
  const entries = data?.windows?.d7 ?? [];
  return {
    note: data && entries.length ? salesNote(data) : "",
    list: entries
      .map((r) =>
        rankSlot({
          href: r.series_id
            ? `/?series=${encodeURIComponent(r.series_id)}&st=${encodeURIComponent(r.work)}`
            : `/?q=${encodeURIComponent(r.search_q || r.work)}`,
          rank: r.rank,
          cover: coverHtml(r.cover_url, r.work),
          title: r.work,
          tooltip: r.title ? (r.sales_date ? `${r.title}（${r.sales_date}発売）` : r.title) : undefined,
          subs: [`最高${r.best_rank}位・${r.days}日`],
        })
      )
      .join(""),
  };
}

// ── 発行部数ランキング（public/circulation.js）──
export function copiesLabel(copies: number): string {
  const man = Math.round(copies / 10000);
  if (man < 10000) return `${man}万部`;
  const oku = Math.floor(man / 10000);
  const rest = man % 10000;
  return rest ? `${oku}億${rest}万部` : `${oku}億部`;
}

function asOfLabel(asOf: string): string {
  if (!asOf) return "時点不明";
  const [y, m] = asOf.split("-");
  return m ? `${Number(y)}年${Number(m)}月時点` : `${Number(y)}年時点`;
}

async function fillCirculation(env: Env): Promise<Fill> {
  const data = await readJson<CirculationPayload>(await handleCirculation(env));
  const entries = data?.entries ?? [];
  const s = data?.source;
  const link = (href: string, text: string) => `<a href="${e(href)}" rel="noopener" target="_blank">${e(text)}</a>`;
  return {
    note: entries.length ? `累計 2000 万部以上の ${entries.length} 作品` : "",
    list: entries
      .map((r) => {
        const sub = `${copiesLabel(r.copies)}・${asOfLabel(r.as_of)}`;
        return rankSlot({
          href: r.series_id
            ? `/?series=${encodeURIComponent(r.series_id)}&st=${encodeURIComponent(r.title)}`
            : `/?q=${encodeURIComponent(r.search_q || r.title)}`,
          rank: r.rank,
          cover: coverHtml(r.cover_url, r.title),
          title: r.title,
          tooltip: `${r.title}（${sub}）`,
          subs: [sub],
        });
      })
      .join(""),
    // 出典の文言は public/circulation.js renderAttribution と同じ（CC BY-SA 4.0 の帰属表示）。
    attribution: s
      ? `出典: ウィキペディア ${link(s.url, `「${s.title}」`)}（${e(s.retrieved)} 取得の版）／ ${link(s.license_url, s.license)}。` +
        "この一覧は同記事から作品名・著者・出版社・累計発行部数・その時点を取り出し、" +
        "日本語の作品名に対応付けて当サイトの巻の一覧と結び付けたものです（注記などの文章は含みません）。" +
        "この一覧の内容は同じく CC BY-SA 4.0 で利用できます。"
      : "",
  };
}

// ── シリーズ一覧（public/series-list.js。最初のページ）──
async function fillSeries(env: Env, url: URL): Promise<Fill> {
  const data = await readJson<{ entries: SeriesListEntry[] }>(await handleSeriesList(env, new URL("/api/series-list", url)));
  const entries = data?.entries ?? [];
  return {
    note: entries.length ? `巻数の多い順に ${entries.length} シリーズを表示中` : "",
    list: entries
      .map((r) => {
        const name = r.version ? `${r.title}（${r.version}）` : r.title;
        return rankSlot({
          href: `/s/${encodeURIComponent(r.series_id)}`,
          rank: r.rank,
          cover: coverHtml(r.cover_url, name),
          title: name,
          tooltip: `${name}（全${r.vol_count}巻）`,
          subs: [[`全${r.vol_count}巻`, r.creator].filter(Boolean).join("・"), r.label || r.publisher],
        });
      })
      .join(""),
  };
}

// ── 公開リスト一覧（public/lists.js。?sort=&page= をそのまま使う）──
const LIST_NOTE: Record<string, string> = {
  new: "公開された順（新しい順）",
  today: "今日（日本時間）のアクセス数の多い順",
  d7: "過去7日間のアクセス数の多い順",
  d30: "過去30日間のアクセス数の多い順",
  all: "累計アクセス数の多い順",
};

interface PublicListCard {
  slug: string;
  owner_name: string;
  bio: string;
  created_at: number;
  views: number | null;
  covers: { title: string; cover_url: string }[];
}

/** 公開日（日本時間）。public/lists.js fmtDate と同じ「2026/10/19」。 */
function jstDate(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

async function fillLists(env: Env, url: URL): Promise<Fill> {
  const api = new URL("/api/public-lists", url);
  for (const k of ["sort", "page"]) {
    const v = url.searchParams.get(k);
    if (v) api.searchParams.set(k, v);
  }
  const data = await readJson<{ sort: string; lists: PublicListCard[] }>(await handlePublicLists(api, env));
  const lists = data?.lists ?? [];
  return {
    note: data ? LIST_NOTE[data.sort] ?? "" : "",
    list: lists
      .map((l) => {
        const covers = l.covers.map((c) => coverHtml(c.cover_url, c.title, "")).join("");
        const meta = [`${jstDate(l.created_at)} 公開`];
        if (l.views !== null) meta.push(`${l.views.toLocaleString("ja-JP")}回表示`);
        return (
          `<a class="plist-card" href="/l/${encodeURIComponent(l.slug)}">` +
          `<div class="plist-covers">${covers}</div>` +
          `<div class="plist-title">${e(l.owner_name ? `${l.owner_name}さん` : "誰か")}を構成する100の漫画</div>` +
          (l.bio ? `<div class="plist-bio">${e(l.bio)}</div>` : "") +
          `<div class="plist-meta">${e(meta.join(" ・ "))}</div>` +
          `</a>`
        );
      })
      .join(""),
  };
}

const FILLERS: Record<string, (env: Env, ctx: ExecutionContext, url: URL) => Promise<Fill>> = {
  "/ranking": (env, ctx) => fillRanking(env, ctx),
  "/sales-ranking": (env) => fillSales(env),
  "/circulation": (env) => fillCirculation(env),
  "/series": (env, _ctx, url) => fillSeries(env, url),
  "/lists": (env, _ctx, url) => fillLists(env, url),
};

export const SSR_LIST_PATHS = Object.keys(FILLERS);

/** テンプレートの差し込み口を埋める。純粋関数（テストから直接呼ぶ）。 */
export function applyFill(html: string, fill: Fill): string {
  // 置換文字列の $ を特殊扱いさせないため、関数で渡す。
  return html
    .replace("<!--SSR_LIST-->", () => fill.list)
    .replace("<!--SSR_NOTE-->", () => e(fill.note))
    .replace("<!--SSR_ATTRIBUTION-->", () => fill.attribution ?? "");
}

/** 一覧系のページなら中身を埋めた HTML を返す。対象外なら null（呼び出し側が静的配信へ流す）。
 *  データの取得に失敗しても、ページは中身なし（JS が後から描く）で返す。 */
export async function renderListPage(env: Env, ctx: ExecutionContext, url: URL, method: string): Promise<Response | null> {
  const filler = FILLERS[url.pathname];
  if (!filler || method !== "GET") return null;
  // 条件付き要求のヘッダを持ち込まない（304 が返ると埋める本文が無い）。
  const res = await injectAnalytics(await fetchSiteAsset(new Request(url.toString()), env, url.pathname), env, url.origin, url.pathname);
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  let fill: Fill = { list: "", note: "" };
  try {
    fill = await filler(env, ctx, url);
  } catch (err) {
    console.warn(`ssr ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new Response(applyFill(await res.text(), fill), { status: 200, headers: res.headers });
}
