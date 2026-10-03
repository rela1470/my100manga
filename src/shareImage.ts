// Share image: every cover of a list composited onto one picture with the
// 「◯◯さんを構成する100の漫画」 title. Used as the view page's og:image (variant "og",
// 1200×630, 20×5 grid) and as the image a visitor attaches to an X post themselves
// (variant "full", portrait 10×10 grid).
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

export type ShareVariant = "og" | "full";

// Bump to regenerate every stored image after a design change.
const LAYOUT_VERSION = 1;
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
  padX: number;
  gap: number;
  gridTop: number;
  brandY: number;
  brandSize: number;
  titleY: number;
  titleMax: number; // largest title font size
  footerY: number | null; // baseline of the site URL under the grid (null: shown in the header)
}

function layout(variant: ShareVariant): Layout & { cellW: number; cellH: number } {
  const base: Layout =
    variant === "og"
      ? { width: 1200, height: 630, cols: 20, padX: 24, gap: 4, gridTop: 0, brandY: 52, brandSize: 26, titleY: 158, titleMax: 62, footerY: null }
      : { width: 1200, height: 0, cols: 10, padX: 40, gap: 10, gridTop: 230, brandY: 70, brandSize: 34, titleY: 170, titleMax: 72, footerY: 0 };
  const cellW = (base.width - base.padX * 2 - base.gap * (base.cols - 1)) / base.cols;
  const cellH = (cellW * 4) / 3; // the site's cover frames are 3:4
  const rows = Math.ceil(CELLS / base.cols);
  const gridH = rows * cellH + (rows - 1) * base.gap;
  if (variant === "og") {
    base.gridTop = base.height - base.padX - gridH;
  } else {
    base.footerY = base.gridTop + gridH + 56;
    base.height = Math.ceil(base.footerY + 34);
  }
  return { ...base, cellW, cellH };
}

export const SHARE_IMAGE_SIZE: Record<ShareVariant, { width: number; height: number }> = {
  og: { width: layout("og").width, height: layout("og").height },
  full: { width: layout("full").width, height: layout("full").height },
};

/** Identifies what a share image would show; changes whenever it would look different. */
export async function shareImageHash(list: MangaList): Promise<string> {
  const key = JSON.stringify([
    LAYOUT_VERSION,
    list.owner_name,
    list.items.map((it) => [it.position, it.isbn, it.cover_url]),
  ]);
  return (await sha256Hex(key)).slice(0, 16);
}

function ownerLabel(name: string): string {
  const chars = [...name.trim()];
  if (chars.length === 0) return "誰か";
  return (chars.length > MAX_NAME_CHARS ? chars.slice(0, MAX_NAME_CHARS).join("") + "…" : chars.join("")) + "さん";
}

/** Rough advance width in em: full-width glyphs 1, ASCII ~0.6. Good enough to fit a line. */
function emWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! < 0x2000 ? 0.6 : 1;
  return w;
}

function buildSvg(list: MangaList, variant: ShareVariant, hasCover: boolean[]): string {
  const L = layout(variant);
  const owner = ownerLabel(list.owner_name);
  const head = `${owner}を構成する`;
  const tail = "の漫画";
  const maxW = L.width - L.padX * 2;
  const titleSize = Math.max(24, Math.min(L.titleMax, Math.floor(maxW / emWidth(head + "100" + tail))));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" font-family="${FONT_FAMILY}" font-weight="700">`,
    `<defs><clipPath id="r" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.07" ry="0.0525"/></clipPath></defs>`,
    `<rect width="100%" height="100%" fill="${COLOR.bg}"/>`,
    `<text x="${L.padX}" y="${L.brandY}" font-size="${L.brandSize}" fill="${COLOR.text}">My <tspan fill="${COLOR.accent}">100</tspan> Manga</text>`,
    `<text x="${L.width / 2}" y="${L.titleY}" font-size="${titleSize}" fill="${COLOR.text}" text-anchor="middle">${escapeHtml(head)}<tspan fill="${COLOR.accent}">100</tspan>${tail}</text>`
  );
  if (L.footerY === null) {
    parts.push(
      `<text x="${L.width - L.padX}" y="${L.brandY}" font-size="${Math.round(L.brandSize * 0.75)}" fill="${COLOR.muted}" text-anchor="end">${SITE}</text>`
    );
  } else {
    parts.push(
      `<text x="${L.width / 2}" y="${L.footerY}" font-size="${L.brandSize}" fill="${COLOR.muted}" text-anchor="middle">${SITE}</text>`
    );
  }

  const r = (L.cellW * 0.07).toFixed(1);
  const numSize = Math.round(L.cellW * 0.32);
  for (let i = 0; i < CELLS; i++) {
    const x = (L.padX + (i % L.cols) * (L.cellW + L.gap)).toFixed(1);
    const y = (L.gridTop + Math.floor(i / L.cols) * (L.cellH + L.gap)).toFixed(1);
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

async function fetchCovers(env: Env, ctx: ExecutionContext, list: MangaList): Promise<(Uint8Array | null)[]> {
  const urls = list.items.slice(0, CELLS).map((it) => it.cover_url);
  const out: (Uint8Array | null)[] = new Array(urls.length).fill(null);
  let next = 0;
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

async function generate(env: Env, ctx: ExecutionContext, list: MangaList, variant: ShareVariant): Promise<ArrayBuffer> {
  const [covers, font] = await Promise.all([
    fetchCovers(env, ctx, list),
    loadFont(`${ownerLabel(list.owner_name)}を構成する100の漫画My Manga${SITE}0123456789`),
  ]);
  if (!wasmReady) wasmReady = initWasm(RESVG_WASM);
  await wasmReady;

  const svg = buildSvg(list, variant, covers.map((c) => c !== null));
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
 */
export async function getShareImage(
  env: Env,
  ctx: ExecutionContext,
  list: MangaList,
  variant: ShareVariant,
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

  const jpeg = await generate(env, ctx, list, variant);
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
