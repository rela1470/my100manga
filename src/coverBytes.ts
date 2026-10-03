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

// /cover が取りに行くパスの形。英数字と一般的な記号だけ、.. を含まない、長すぎない。
// Yahoo は item-shopping.c.yimg.jp/i/l/<store>_<id> の形（src/yahoo.ts bestImage）。
const SAFE_PATH = /^\/[A-Za-z0-9._~%@+\-\/]{1,300}$/;

/** Which baked-in framing /cover trims off this source, or null if it isn't proxied. */
export function trimKind(target: URL): "yahoo" | "mottainai" | null {
  if (target.protocol !== "https:" || target.username || target.password || target.port) return null;
  if (!SAFE_PATH.test(target.pathname) || target.pathname.includes("..")) return null;
  if (/(^|\.)yimg\.jp$/.test(target.hostname)) return "yahoo";
  if (target.hostname === "thumbnail.image.rakuten.co.jp" && MOTTAINAI_PATH.test(target.pathname)) {
    return "mottainai";
  }
  return null;
}

/**
 * /cover に渡された URL を正規化する（R2 キーのハッシュと取得先を揃える）。クエリや
 * フラグメントを変えただけの別 URL で R2 に無限にオブジェクトを作られないようにするため:
 *   - yahoo: クエリ・フラグメントは捨てる（item-shopping.c.yimg.jp/i/l/<id> はクエリ不要）。
 *   - mottainai: 楽天のサムネイルのサイズ指定 `_ex=<W>x<H>` だけ残し、他は捨てる。
 * 既存の正規の URL（クエリ無しの Yahoo、`?_ex=600x600` の楽天）は toString() が変わらないので
 * 既存の R2 キーはそのまま当たる。
 */
export function normalizeCoverTarget(target: URL, kind: "yahoo" | "mottainai"): URL {
  const out = new URL(target.origin + target.pathname);
  if (kind === "mottainai") {
    const ex = target.searchParams.get("_ex");
    if (ex && /^\d{2,4}x\d{2,4}$/.test(ex)) out.search = `?_ex=${ex}`;
  }
  return out;
}

// 上流画像の上限。表紙は数十 KB〜数百 KB なので、これを超えるものはデコードしない。
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

/** 上流のレスポンスを、image/* であること・サイズ上限内であることを確かめて読む。NG なら null。 */
export async function readImageCapped(
  res: Response,
  maxBytes = MAX_COVER_BYTES,
  requireImageType = true
): Promise<ArrayBuffer | null> {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (requireImageType && !ct.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf.buffer;
}

export type TrimmedCover = { body: ReadableStream | ArrayBuffer; etag?: string };

/**
 * A store cover with its baked-in framing trimmed: Yahoo's white bars
 * (trimWhitespace) or もったいない本舗's logo frame (trimShopFrame). First hit decodes
 * + trims (src/covertrim.ts) and persists the result to R2 keyed by a hash of the
 * source URL; every later hit streams straight from R2. If trimming yields nothing,
 * the original image is stored and served unchanged. null on an upstream failure
 * (non-image / oversized responses count as failures) or when opts.onMiss refuses.
 * R2 objects are permanent (no lifecycle rule): a trimmed cover is stored forever.
 */
export async function getTrimmedCover(
  env: Env,
  ctx: ExecutionContext,
  rawTarget: URL,
  kind: "yahoo" | "mottainai",
  opts: { onMiss?: () => Promise<boolean> } = {}
): Promise<TrimmedCover | null> {
  const target = normalizeCoverTarget(rawTarget, kind);
  const key = kind + "/" + (await sha256Hex(target.toString())) + ".jpg";

  if (env.COVERS) {
    const hit = await env.COVERS.get(key);
    if (hit) return { body: hit.body, etag: hit.httpEtag };
  }
  // R2 に無い（＝上流取得とデコードが走る）ときだけ呼び出し側の濫用よけに諮る。
  if (opts.onMiss && !(await opts.onMiss())) return null;

  const upstream = await fetch(target.toString(), {
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    return null;
  }
  const original = await readImageCapped(upstream);
  if (!original) return null;

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
  // 共有画像の合成用。content-type は店によって揺れうるので見ず、サイズ上限だけかける。
  const buf = await readImageCapped(res, MAX_COVER_BYTES, false);
  return buf ? new Uint8Array(buf) : null;
}
