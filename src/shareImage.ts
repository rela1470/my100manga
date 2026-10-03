// Share image: every cover of a list composited onto one picture, under a one-line
// 「◯◯'s My 100 Manga」 header with the list URL on the right. Used as the view page's
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
import { initWasm, Resvg } from "@resvg/resvg-wasm";
// CF Workers can't dynamically import wasm — bundle it explicitly (as covertrim.ts does).
import RESVG_WASM from "../node_modules/@resvg/resvg-wasm/index_bg.wasm";
import { getCoverBytes, sha256Hex } from "./coverBytes";
import { encodeRgba } from "./covertrim";
import { escapeHtml } from "./util";
import { Env, MangaList } from "./types";

export type ShareVariant = "og" | "full" | "q1" | "q2" | "q3" | "q4";
export const SHARE_VARIANTS: readonly ShareVariant[] = ["og", "full", "q1", "q2", "q3", "q4"];

// Bump to regenerate every stored image after a design change.
const LAYOUT_VERSION = 3;
const CELLS = 100;
const COVER_CONCURRENCY = 10;
const MAX_NAME_CHARS = 16;
const FONT_FAMILY = "Noto Sans JP";
const SITE = "my100manga.com";

const COLOR = {
  bg: "#f4f8ff",
  text: "#16202e",
  muted: "#6b7684",
  accent: "#3b82f6",
  empty: "#dde7f5",
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
      ? { width: 1200, pad: 16, gap: 4, gridTop: 56, headerY: 40, headerSize: 28 }
      : { width: 1200, pad: 24, gap: variant === "full" ? 8 : 12, gridTop: 80, headerY: 54, headerSize: 36 };
  const areaW = header.width - header.pad * 2;
  if (variant === "og") {
    // Fixed canvas: take whichever column count gives the biggest covers (3:4) in the
    // area under the header, and centre the grid horizontally.
    const height = 630;
    const areaH = height - header.gridTop - header.pad;
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
    return { ...header, height, cols, cellW, cellH: (cellW * 4) / 3, gridLeft: (header.width - gridW) / 2, first: 0, count: CELLS };
  }
  // Portrait grid filling the width (10×10, or 5×5 for a quarter); the height follows.
  const q = quarterIndex(variant);
  const count = q === null ? CELLS : QUARTER;
  const cols = q === null ? 10 : 5;
  const cellW = (areaW - header.gap * (cols - 1)) / cols;
  const cellH = (cellW * 4) / 3; // the site's cover frames are 3:4
  const rows = Math.ceil(count / cols);
  const gridH = rows * cellH + (rows - 1) * header.gap;
  const height = Math.ceil(header.gridTop + gridH + header.pad);
  return { ...header, height, cols, cellW, cellH, gridLeft: header.pad, first: q === null ? 0 : q * QUARTER, count };
}

export const SHARE_IMAGE_SIZE = Object.fromEntries(
  SHARE_VARIANTS.map((v) => [v, { width: layout(v).width, height: layout(v).height }])
) as Record<ShareVariant, { width: number; height: number }>;

/** Identifies what a share image would show; changes whenever it would look different. */
export async function shareImageHash(list: MangaList): Promise<string> {
  const key = JSON.stringify([
    LAYOUT_VERSION,
    list.owner_name,
    list.items.map((it) => [it.position, it.isbn, it.cover_url]),
  ]);
  return (await sha256Hex(key)).slice(0, 16);
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

function buildSvg(list: MangaList, variant: ShareVariant, hasCover: boolean[], host: string): string {
  const L = layout(variant);
  const owner = ownerPossessive(list.owner_name);
  const url = listUrlLabel(host, list.slug);
  // The URL is drawn at 0.75× the title size; shrink both if a long name would run into it.
  const range = rangeLabel(L);
  const fit = (L.width - L.pad * 2 - 24) / (emWidth(`${owner}My 100 Manga ${range}`) + emWidth(url) * 0.75);
  const size = Math.max(16, Math.min(L.headerSize, Math.floor(fit)));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" font-family="${FONT_FAMILY}" font-weight="700">`,
    `<defs><clipPath id="r" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.07" ry="0.0525"/></clipPath></defs>`,
    `<rect width="100%" height="100%" fill="${COLOR.bg}"/>`,
    `<text x="${L.pad}" y="${L.headerY}" font-size="${size}" fill="${COLOR.text}">${escapeHtml(owner)}My <tspan fill="${COLOR.accent}">100</tspan> Manga${range ? `<tspan dx="0.4em" fill="${COLOR.muted}">${range}</tspan>` : ""}</text>`,
    `<text x="${L.width - L.pad}" y="${L.headerY}" font-size="${Math.round(size * 0.75)}" fill="${COLOR.muted}" text-anchor="end">${escapeHtml(url)}</text>`
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

// Placeholder hrefs; resvg reports them via imagesToResolve() and we hand it the bytes.
function coverHref(i: number): string {
  return `https://${SITE}/_share-cover/${i}.jpg`;
}

let wasmReady: Promise<void> | null = null;

// Google Fonts serves a subset holding only the requested glyphs (text=), as TrueType
// to a plain non-browser UA — resvg can't read woff2. Both responses are edge-cached.
async function loadFont(text: string): Promise<Uint8Array> {
  const chars = [...new Set(text)].join("");
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(FONT_FAMILY)}:wght@700&text=${encodeURIComponent(chars)}`;
  const cssRes = await fetch(cssUrl, {
    headers: { "user-agent": "my100manga-share-image" },
    cf: { cacheEverything: true, cacheTtl: 30 * 86400 },
  });
  if (!cssRes.ok) throw new Error(`font css ${cssRes.status}`);
  const m = (await cssRes.text()).match(/url\((https:[^)]+)\)\s*format\('(?:truetype|opentype)'\)/);
  if (!m) throw new Error("font css: no truetype source");
  const fontRes = await fetch(m[1], { cf: { cacheEverything: true, cacheTtl: 30 * 86400 } });
  if (!fontRes.ok) throw new Error(`font ${fontRes.status}`);
  return new Uint8Array(await fontRes.arrayBuffer());
}

// Only the cells this image draws (a quarter fetches 25); the result is indexed by
// list position like list.items.
async function fetchCovers(env: Env, ctx: ExecutionContext, list: MangaList, first: number, count: number): Promise<(Uint8Array | null)[]> {
  const urls = list.items.slice(0, first + count).map((it, i) => (i >= first ? it.cover_url : ""));
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
  const [covers, font] = await Promise.all([
    fetchCovers(env, ctx, list, L.first, L.count),
    loadFont(`${ownerPossessive(list.owner_name)}My Manga–${listUrlLabel(host, list.slug)}0123456789`),
  ]);
  if (!wasmReady) wasmReady = initWasm(RESVG_WASM);
  await wasmReady;

  const svg = buildSvg(list, variant, covers.map((c) => c !== null), host);
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
  const hash = await shareImageHash(list);
  const prefix = `share/${list.slug}/`;
  const key = `${prefix}${variant}-${hash}.jpg`;
  if (env.COVERS) {
    const hit = await env.COVERS.get(key);
    if (hit) return hit.body;
  }
  if (opts.onMiss && !(await opts.onMiss())) return null;

  const jpeg = await generate(env, ctx, list, variant, host);
  if (env.COVERS) {
    const bucket = env.COVERS;
    ctx.waitUntil(
      (async () => {
        await bucket.put(key, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
        const stale = (await bucket.list({ prefix: `${prefix}${variant}-` })).objects
          .map((o) => o.key)
          .filter((k) => k !== key);
        if (stale.length) await bucket.delete(stale);
      })().catch((err) => console.error("share image store failed", err))
    );
  }
  return jpeg;
}
