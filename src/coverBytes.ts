import { Env } from "./types";
import { trimShopFrame, trimWhitespace } from "./covertrim";

export const COVER_CACHE = "public, max-age=31536000, immutable";

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// もったいない本舗's 楽天 storefronts — their listing images frame the cover with a
// logo band and mascot (src/covertrim.ts trimShopFrame). Kept in sync with
// MOTTAINAI_RE in public/cover-fit.js.
const MOTTAINAI_PATH = /^\/@0_mall\/(comicset|mottainaihonpo|mottainaihonpo-omatome)\/cabinet\//;

/** Which baked-in framing /cover trims off this source, or null if it isn't proxied. */
export function trimKind(target: URL): "yahoo" | "mottainai" | null {
  if (target.protocol !== "https:") return null;
  if (/(^|\.)yimg\.jp$/.test(target.hostname)) return "yahoo";
  if (target.hostname === "thumbnail.image.rakuten.co.jp" && MOTTAINAI_PATH.test(target.pathname)) {
    return "mottainai";
  }
  return null;
}

export type TrimmedCover = { body: ReadableStream | ArrayBuffer; etag?: string };

/**
 * A store cover with its baked-in framing trimmed: Yahoo's white bars
 * (trimWhitespace) or もったいない本舗's logo frame (trimShopFrame). First hit decodes
 * + trims (src/covertrim.ts) and persists the result to R2 keyed by a hash of the
 * source URL; every later hit streams straight from R2. If trimming yields nothing,
 * the original image is stored and served unchanged. null on an upstream failure.
 */
export async function getTrimmedCover(
  env: Env,
  ctx: ExecutionContext,
  target: URL,
  kind: "yahoo" | "mottainai"
): Promise<TrimmedCover | null> {
  const key = kind + "/" + (await sha256Hex(target.toString())) + ".jpg";

  if (env.COVERS) {
    const hit = await env.COVERS.get(key);
    if (hit) return { body: hit.body, etag: hit.httpEtag };
  }

  const upstream = await fetch(target.toString(), {
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!upstream.ok) return null;
  const original = await upstream.arrayBuffer();

  let out: ArrayBuffer = original;
  try {
    const trimmed = kind === "yahoo" ? await trimWhitespace(original) : await trimShopFrame(original);
    if (trimmed) out = trimmed;
  } catch {
    // decode/encode failure: fall back to the original bytes.
  }

  if (env.COVERS) {
    ctx.waitUntil(
      env.COVERS.put(key, out, {
        httpMetadata: { contentType: "image/jpeg", cacheControl: COVER_CACHE },
      })
    );
  }
  return { body: out };
}

/** Raw bytes of any cover URL as the view page would show it (trimmed where /cover trims). */
export async function getCoverBytes(env: Env, ctx: ExecutionContext, url: string): Promise<Uint8Array | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const kind = trimKind(target);
  if (kind) {
    const c = await getTrimmedCover(env, ctx, target, kind);
    if (!c) return null;
    return new Uint8Array(c.body instanceof ArrayBuffer ? c.body : await new Response(c.body).arrayBuffer());
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return null;
  const res = await fetch(target.toString(), { cf: { cacheEverything: true, cacheTtl: 86400 } });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}
