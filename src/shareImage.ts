// Share image: every cover of a list composited onto one picture, under a one-line
// 「◯◯'s My 100 Manga」（サイト名は src/site.ts, R18版は別名）header with the list URL on the right. Used as the view page's
// og:image (variant "og", 1200×630, the column count that makes the covers largest)
// and as the image a visitor attaches to an X post themselves (variant "full",
// portrait 10×10 grid, or "q1"–"q4": a quarter each, 25 covers on a 5×5 grid, for a
// four-image post).
//
// Built server-side because the main cover host (thumbnail.image.rakuten.co.jp)
// sends no CORS headers, so a browser canvas would be tainted (public/cover-fit.js).
// The grid is fixed, so the SVG is laid out by hand (no layout engine), rasterised
// with resvg and encoded to JPEG — PNG of 100 photos runs to several MB.
//
// The result is stored in R2 under share/<slug>/<variant>-<hash>.jpg. The hash
// covers everything drawn (owner name, ISBNs, cover URLs, layout version), so a
// list edit or a cover filled in later yields a fresh image, and the og:image URL
// carries it as ?v= so X re-fetches.
//
// 書影の出典（楽天ブックス / 楽天市場 / Yahoo!ショッピング 等）と「© 各著作権者」を全種類の
// 画像の下端に 1 行で入れる。出典は実際に描くセルの表紙 URL から割り出す（creditLine）。
//
// フォントは描画時に外部（Google Fonts）へ取りに行かず、静的アセットの Noto Sans JP Bold
// （JIS X 0208 + ASCII + 半角カナ/全角英数にサブセット化した OTF, public/fonts/, OFL）を
// env.ASSETS から読んで isolate 内に保持する。JIS 第 3・4 水準や絵文字は描かれない。
//
// メモリ: Workers の isolate は 128MB。resvg と mozjpeg の wasm メモリは一度伸びると縮まない
// ので、描画は isolate 内で 1 本ずつ（renderLock）にし、同じ画像の同時リクエストは 1 回の
// 描画を共有する（inflight）。表紙は楽天の _ex= でセルの大きさ近くまで縮めて取る（shareCoverUrl）。
import { initWasm, Resvg } from "@resvg/resvg-wasm";
// CF Workers can't dynamically import wasm — bundle it explicitly (as covertrim.ts does).
import RESVG_WASM from "../node_modules/@resvg/resvg-wasm/index_bg.wasm";
import { getCoverBytes, sha256Hex } from "./coverBytes";
import { encodeRgba } from "./covertrim";
import { escapeHtml } from "./util";
import { site, SiteVariant, siteVariant } from "./site";
import { Env, ListItem, MangaList } from "./types";

export type ShareVariant = "og" | "full" | "q1" | "q2" | "q3" | "q4";
export const SHARE_VARIANTS: readonly ShareVariant[] = ["og", "full", "q1", "q2", "q3", "q4"];

// Bump to regenerate every stored image after a design change.
const LAYOUT_VERSION = 4;
const CELLS = 100;
const COVER_CONCURRENCY = 10;
const MAX_NAME_CHARS = 16;
const FONT_FAMILY = "Noto Sans JP";
// 相対 URL を URL() で解くときの土台と、resvg に表紙を渡すための差し込み用 href に使うだけの
// 内部の値。画像に描く URL ではない（それは host 引数 → listUrlLabel）。ASSETS.fetch も絶対 URL を
// 要求するが host は見ないのでこれで足りる。実際のサイトのホストとは関係しない。
const SELF = "share.invalid";
// public/fonts/ の静的アセット（ライセンスは同じディレクトリの OFL.txt）。
const FONT_PATH = "/fonts/NotoSansJP-Bold-subset.otf";

// 配色はサイト種別ごと（src/site.ts）。public/styles.css の :root / :root[data-site="adult"] と
// 揃えること（画面と共有画像で色が食い違わないように）。
const PALETTE: Record<SiteVariant, { bg: string; text: string; muted: string; accent: string; empty: string }> = {
  general: {
    bg: "#f4f8ff",
    text: "#16202e",
    muted: "#6b7684",
    accent: "#3b82f6",
    empty: "#dde7f5",
  },
  adult: {
    bg: "#fff5f9",
    text: "#2a1620",
    muted: "#6e5562",
    accent: "#ec4899",
    empty: "#f6dbe7",
  },
};

interface Layout {
  width: number;
  height: number;
  cols: number;
  pad: number;
  gap: number;
  gridTop: number;
  gridLeft: number;
  cellW: number;
  cellH: number;
  headerY: number; // header text baseline
  headerSize: number; // largest header font size (shrunk to fit a long name/URL)
  creditY: number; // 出典クレジットの baseline（下端）
  creditSize: number;
  first: number; // index of the first cell drawn (quarters start at 0/25/50/75)
  count: number; // cells drawn
}

const QUARTER = 25;

function quarterIndex(variant: ShareVariant): number | null {
  const m = variant.match(/^q([1-4])$/);
  return m ? Number(m[1]) - 1 : null;
}

function layout(variant: ShareVariant): Layout {
  const header =
    variant === "og"
      ? { width: 1200, pad: 16, gap: 4, gridTop: 56, headerY: 40, headerSize: 28, creditSize: 13 }
      : { width: 1200, pad: 24, gap: variant === "full" ? 8 : 12, gridTop: 80, headerY: 54, headerSize: 36, creditSize: 18 };
  // グリッドの下に出典クレジット 1 行ぶん（og は約 22px）を空ける。
  const creditH = Math.round(header.creditSize * 1.7);
  const areaW = header.width - header.pad * 2;
  if (variant === "og") {
    // Fixed canvas: take whichever column count gives the biggest covers (3:4) in the
    // area under the header, and centre the grid horizontally.
    const height = 630;
    const areaH = height - header.gridTop - creditH;
    let cols = 1;
    let cellW = 0;
    for (let c = 1; c <= CELLS; c++) {
      const rows = Math.ceil(CELLS / c);
      const w = Math.min((areaW - header.gap * (c - 1)) / c, (((areaH - header.gap * (rows - 1)) / rows) * 3) / 4);
      if (w > cellW) {
        cellW = w;
        cols = c;
      }
    }
    const gridW = cols * cellW + (cols - 1) * header.gap;
    const creditY = height - Math.round((creditH - header.creditSize) / 2) - 2;
    return { ...header, height, creditY, cols, cellW, cellH: (cellW * 4) / 3, gridLeft: (header.width - gridW) / 2, first: 0, count: CELLS };
  }
  // Portrait grid filling the width (10×10, or 5×5 for a quarter); the height follows.
  const q = quarterIndex(variant);
  const count = q === null ? CELLS : QUARTER;
  const cols = q === null ? 10 : 5;
  const cellW = (areaW - header.gap * (cols - 1)) / cols;
  const cellH = (cellW * 4) / 3; // the site's cover frames are 3:4
  const rows = Math.ceil(count / cols);
  const gridH = rows * cellH + (rows - 1) * header.gap;
  const creditY = Math.ceil(header.gridTop + gridH + header.gap + header.creditSize);
  const height = Math.ceil(header.gridTop + gridH + creditH + header.pad / 2);
  return { ...header, height, creditY, cols, cellW, cellH, gridLeft: header.pad, first: q === null ? 0 : q * QUARTER, count };
}

export const SHARE_IMAGE_SIZE = Object.fromEntries(
  SHARE_VARIANTS.map((v) => [v, { width: layout(v).width, height: layout(v).height }])
) as Record<ShareVariant, { width: number; height: number }>;

/** Identifies what a share image would show; changes whenever it would look different. */
export async function shareImageHash(list: MangaList): Promise<string> {
  // 出典クレジットは variant ごとに描くセルで変わりうるので、全 variant の文言を入れる。
  const key = JSON.stringify([
    LAYOUT_VERSION,
    list.owner_name,
    list.items.map((it) => [it.position, it.isbn, it.cover_url]),
    SHARE_VARIANTS.map((v) => creditLine(list, v)),
  ]);
  return (await sha256Hex(key)).slice(0, 16);
}

// 書影の出典。表示順は固定（主な取得元から）。
const SOURCE_ORDER = ["楽天ブックス", "楽天市場", "Yahoo!ショッピング", "Google Books", "各販売サイト"] as const;
type CoverSource = (typeof SOURCE_ORDER)[number];

/** 表紙 URL がどの販売サイトの画像か。/cover?u=…（整形プロキシ）経由なら元 URL で判定する。 */
export function coverSource(url: string): CoverSource | null {
  if (!url) return null;
  let u: URL;
  try {
    // 保存されている表紙 URL は自サイトの相対 URL（/cover?u=…）か、販売サイトの絶対 URL。
    // 前者を解くための土台が SELF。/cover?u= はホストに依らず自前の整形プロキシと見なす
    // （本家・R18版でホストが違っても同じ判定になるように）。
    u = new URL(url, `https://${SELF}`);
    if (u.pathname === "/cover" && u.searchParams.get("u")) u = new URL(u.searchParams.get("u")!);
  } catch {
    return "各販売サイト";
  }
  const host = u.hostname;
  // 楽天ブックスの書影も /@0_mall/book/ 配下（楽天ブックス自体が楽天市場の 1 店舗）。それ以外の
  // /@0_mall/<店舗>/ が楽天市場の商品画像（src/ichiba.ts）。
  if (host === "thumbnail.image.rakuten.co.jp") {
    return u.pathname.startsWith("/@0_mall/") && !u.pathname.startsWith("/@0_mall/book/") ? "楽天市場" : "楽天ブックス";
  }
  if (/(^|\.)rakuten\.co\.jp$/.test(host)) return "楽天ブックス";
  if (/(^|\.)yimg\.jp$/.test(host)) return "Yahoo!ショッピング";
  if (host === "books.google.com" || /(^|\.)books\.googleusercontent\.com$/.test(host)) return "Google Books";
  return "各販売サイト";
}

/** 画像下端のクレジット: 「書影: 楽天ブックス / Yahoo!ショッピング　© 各著作権者」。
 *  出典はこの variant が描くセル（表紙のあるもの）に実際に含まれるものだけ。 */
export function creditLine(list: MangaList, variant: ShareVariant): string {
  const L = layout(variant);
  const found = new Set<CoverSource>();
  for (const it of list.items.slice(L.first, L.first + L.count) as ListItem[]) {
    const src = coverSource(it.cover_url);
    if (src) found.add(src);
  }
  const sources = SOURCE_ORDER.filter((s) => found.has(s));
  return (sources.length ? `書影: ${sources.join(" / ")}　` : "") + "© 各著作権者";
}

/** 「rela1470's 」 before the brand; nothing when the list has no name. */
function ownerPossessive(name: string): string {
  const chars = [...name.trim()];
  if (chars.length === 0) return "";
  return (chars.length > MAX_NAME_CHARS ? chars.slice(0, MAX_NAME_CHARS).join("") + "…" : chars.join("")) + "'s ";
}

function listUrlLabel(host: string, slug: string): string {
  return `${host}/l/${slug}`;
}

/** Quarters say which part they are, after the brand: 「1–25」. */
function rangeLabel(L: Layout): string {
  return L.count === CELLS ? "" : `${L.first + 1}–${L.first + L.count}`;
}

/** Rough advance width in em: full-width glyphs 1, ASCII ~0.6. Good enough to fit a line. */
function emWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! < 0x2000 ? 0.6 : 1;
  return w;
}

function buildSvg(list: MangaList, variant: ShareVariant, hasCover: boolean[], host: string, env: Env): string {
  const L = layout(variant);
  const COLOR = PALETTE[siteVariant(env)];
  const brand = site(env).name;
  const owner = ownerPossessive(list.owner_name);
  const url = listUrlLabel(host, list.slug);
  // The URL is drawn at 0.75× the title size; shrink both if a long name would run into it.
  const range = rangeLabel(L);
  const fit = (L.width - L.pad * 2 - 24) / (emWidth(`${owner}${brand} ${range}`) + emWidth(url) * 0.75);
  const size = Math.max(16, Math.min(L.headerSize, Math.floor(fit)));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" font-family="${FONT_FAMILY}" font-weight="700">`,
    `<defs><clipPath id="r" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.07" ry="0.0525"/></clipPath></defs>`,
    `<rect width="100%" height="100%" fill="${COLOR.bg}"/>`,
    `<text x="${L.pad}" y="${L.headerY}" font-size="${size}" fill="${COLOR.text}">${escapeHtml(owner)}${brandSvg(brand, COLOR.accent)}${range ? `<tspan dx="0.4em" fill="${COLOR.muted}">${range}</tspan>` : ""}</text>`,
    `<text x="${L.width - L.pad}" y="${L.headerY}" font-size="${Math.round(size * 0.75)}" fill="${COLOR.muted}" text-anchor="end">${escapeHtml(url)}</text>`,
    `<text x="${L.width - L.pad}" y="${L.creditY}" font-size="${L.creditSize}" fill="${COLOR.muted}" text-anchor="end">${escapeHtml(creditLine(list, variant))}</text>`
  );

  const r = (L.cellW * 0.07).toFixed(1);
  const numSize = Math.round(L.cellW * 0.32);
  for (let i = L.first; i < L.first + L.count; i++) {
    const k = i - L.first; // position within this image's grid
    const x = (L.gridLeft + (k % L.cols) * (L.cellW + L.gap)).toFixed(1);
    const y = (L.gridTop + Math.floor(k / L.cols) * (L.cellH + L.gap)).toFixed(1);
    const w = L.cellW.toFixed(1);
    const h = L.cellH.toFixed(1);
    if (i < list.items.length && hasCover[i]) {
      parts.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${COLOR.empty}"/>`,
        `<image href="${coverHref(i)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)"/>`
      );
    } else {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${COLOR.empty}"/>`);
      if (i < list.items.length) {
        const cx = (Number(x) + L.cellW / 2).toFixed(1);
        const cy = (Number(y) + L.cellH / 2 + numSize * 0.35).toFixed(1);
        parts.push(
          `<text x="${cx}" y="${cy}" font-size="${numSize}" fill="${COLOR.muted}" text-anchor="middle">${i + 1}</text>`
        );
      }
    }
  }
  parts.push(`</svg>`);
  return parts.join("");
}

/** サイト名のうち数字（「My 100 Manga」の 100）だけアクセント色にした SVG の断片。
 *  数字が無い名前ならそのまま描く。 */
function brandSvg(name: string, accent: string): string {
  const m = name.match(/^(.*?)(\d+)(.*)$/);
  if (!m) return escapeHtml(name);
  return `${escapeHtml(m[1])}<tspan fill="${accent}">${m[2]}</tspan>${escapeHtml(m[3])}`;
}

// Placeholder hrefs; resvg reports them via imagesToResolve() and we hand it the bytes.
function coverHref(i: number): string {
  return `https://${SELF}/_share-cover/${i}.jpg`;
}

let wasmReady: Promise<void> | null = null;

// 静的アセットのフォント（約 1.5MB）。isolate ごとに 1 回だけ読む。失敗したら次回また試す。
let fontBytes: Promise<Uint8Array> | null = null;

function loadFont(env: Env): Promise<Uint8Array> {
  if (!fontBytes) {
    fontBytes = (async () => {
      const res = await env.ASSETS.fetch(new Request(`https://${SELF}${FONT_PATH}`));
      if (!res.ok) throw new Error(`font asset ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    })();
    fontBytes.catch(() => (fontBytes = null));
  }
  return fontBytes;
}

/** 楽天の表紙は ?_ex=WxH で縮小版を返すので、セルの大きさ（の約 2 倍）で取る。resvg は
 *  表紙を全部デコードして持つので、600px の画像を 100 枚読むと wasm メモリが 60MB 近く伸びる。
 *  もったいない本舗の画像は /cover の整形済み（R2）を使うので触らない。 */
export function shareCoverUrl(url: string, cellW: number): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.hostname !== "thumbnail.image.rakuten.co.jp" || !u.searchParams.has("_ex")) return url;
  if (/^\/@0_mall\/(comicset|mottainaihonpo|mottainaihonpo-omatome)\/cabinet\//.test(u.pathname)) return url;
  const px = Math.min(300, Math.max(100, Math.ceil((cellW * 2 * 4) / 3 / 50) * 50));
  u.searchParams.set("_ex", `${px}x${px}`);
  return u.toString();
}

// Only the cells this image draws (a quarter fetches 25); the result is indexed by
// list position like list.items.
async function fetchCovers(env: Env, ctx: ExecutionContext, list: MangaList, first: number, count: number, cellW: number): Promise<(Uint8Array | null)[]> {
  const urls = list.items.slice(0, first + count).map((it, i) => (i >= first && it.cover_url ? shareCoverUrl(it.cover_url, cellW) : ""));
  const out: (Uint8Array | null)[] = new Array(urls.length).fill(null);
  let next = first;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      if (!urls[i]) continue;
      try {
        out[i] = await getCoverBytes(env, ctx, urls[i]);
      } catch {
        out[i] = null; // drawn as a numbered placeholder
      }
    }
  }
  await Promise.all(Array.from({ length: COVER_CONCURRENCY }, worker));
  return out;
}

async function generate(env: Env, ctx: ExecutionContext, list: MangaList, variant: ShareVariant, host: string): Promise<ArrayBuffer> {
  const L = layout(variant);
  const [covers, font] = await Promise.all([fetchCovers(env, ctx, list, L.first, L.count, L.cellW), loadFont(env)]);
  if (!wasmReady) wasmReady = initWasm(RESVG_WASM);
  await wasmReady;

  const svg = buildSvg(list, variant, covers.map((c) => c !== null), host, env);
  const resvg = new Resvg(svg, {
    font: { fontBuffers: [font], defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY },
  });
  try {
    for (const href of resvg.imagesToResolve() as string[]) {
      const m = href.match(/\/_share-cover\/(\d+)\.jpg$/);
      const bytes = m ? covers[Number(m[1])] : null;
      if (bytes) resvg.resolveImage(href, bytes);
    }
    const img = resvg.render();
    try {
      return await encodeRgba(new Uint8ClampedArray(img.pixels), img.width, img.height, 85);
    } finally {
      img.free();
    }
  } finally {
    resvg.free();
  }
}

/**
 * The share image for a list, from R2 if this exact content was rendered before,
 * otherwise rendered now and stored (older renders of the list are removed).
 * `host` is the site's host, printed in the og header as the list URL. It's fixed per
 * deployment (and each deployment has its own bucket), so it isn't part of the hash.
 */
export async function getShareImage(
  env: Env,
  ctx: ExecutionContext,
  list: MangaList,
  variant: ShareVariant,
  host: string,
  opts: { onMiss?: () => Promise<boolean> } = {}
): Promise<ArrayBuffer | ReadableStream | null> {
  const key = await shareImageKey(list, variant);
  if (env.COVERS) {
    const hit = await env.COVERS.get(key);
    if (hit) return hit.body;
  }
  // 描画中の同じ画像があれば（レート制限を数えずに）それを待つ。
  const pending = inflight.get(key);
  if (pending) return (await pending).slice(0);
  if (opts.onMiss && !(await opts.onMiss())) return null;
  return (await renderAndStore(env, ctx, list, variant, host, key)).slice(0);
}

/** R2 に無ければ描いて保存する（キュー consumer 用）。描いたら true。 */
export async function ensureShareImage(
  env: Env,
  ctx: ExecutionContext,
  list: MangaList,
  variant: ShareVariant,
  host: string
): Promise<boolean> {
  const key = await shareImageKey(list, variant);
  if (env.COVERS && (await env.COVERS.head(key))) return false;
  const pending = inflight.get(key);
  if (pending) {
    await pending;
    return false;
  }
  await renderAndStore(env, ctx, list, variant, host, key);
  return true;
}

async function shareImageKey(list: MangaList, variant: ShareVariant): Promise<string> {
  return `share/${list.slug}/${variant}-${await shareImageHash(list)}.jpg`;
}

// R2 キー → 描画中の Promise。同じ画像への同時リクエストは 1 回の描画を共有する。
const inflight = new Map<string, Promise<ArrayBuffer>>();
// isolate 内の描画は 1 本ずつ（wasm メモリのピークを 1 枚ぶんに抑える）。
let renderQueue: Promise<unknown> = Promise.resolve();

function withRenderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(fn, fn);
  renderQueue = run.catch(() => {});
  return run;
}

function renderAndStore(
  env: Env,
  ctx: ExecutionContext,
  list: MangaList,
  variant: ShareVariant,
  host: string,
  key: string
): Promise<ArrayBuffer> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = withRenderLock(async () => {
    const jpeg = await generate(env, ctx, list, variant, host);
    if (env.COVERS) {
      const bucket = env.COVERS;
      // 保存し終えてから inflight を外す（外した直後のリクエストが R2 で拾えるように）。
      try {
        await bucket.put(key, jpeg.slice(0), { httpMetadata: { contentType: "image/jpeg" } });
        const prefix = `share/${list.slug}/${variant}-`;
        const stale = (await bucket.list({ prefix })).objects.map((o) => o.key).filter((k) => k !== key);
        if (stale.length) await bucket.delete(stale);
      } catch (err) {
        console.error("share image store failed", err); // 画像自体は返せるので応答は失敗させない
      }
    }
    return jpeg;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  // 最初のリクエストが切断されても描画・保存は最後まで走らせる（待っている他のリクエスト用）。
  ctx.waitUntil(p.catch((err) => console.error("share image render failed", err)));
  return p;
}

// リンクプレビューのクローラ。投稿直後に og 画像を取りに来るので、R2 ミス時の描画を
// レート制限に数えない（同じ IP から多数のリストを取りに来るため。描画自体は renderLock で直列）。
const LINK_PREVIEW_BOT = /Twitterbot|facebookexternalhit|Facebot|Slackbot|Slack-ImgProxy|Discordbot|line-poker|LINE\/|Bluesky Cardyb|Cardyb|TelegramBot|WhatsApp|Mastodon|misskey/i;

export function isLinkPreviewBot(ua: string | null): boolean {
  return !!ua && LINK_PREVIEW_BOT.test(ua);
}
