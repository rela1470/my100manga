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
const SAFE_PATH = /^\/[A-Za-z0-9._~%@+\-\/]{1,300}$/;

// Yahoo の表紙として保存される URL の形（src/yahoo.ts bestImage）: item-shopping.c.yimg.jp の
// /i/<サイズ 1 文字>/<store>_<id>。以前は *.yimg.jp の任意パスを通していたが、プロキシとして
// 使える先を表紙画像そのものに絞る。保存済みの URL（covers / cover_suggestion / リスト項目）は
// 全部この形（実測: ローカル D1 の yimg URL はすべて /i/l/）。
const YAHOO_HOST = "item-shopping.c.yimg.jp";
const YAHOO_PATH = /^\/i\/[a-z]\/[A-Za-z0-9._\-]{1,200}$/;

/** Which baked-in framing /cover trims off this source, or null if it isn't proxied. */
export function trimKind(target: URL): "yahoo" | "mottainai" | null {
  if (target.protocol !== "https:" || target.username || target.password || target.port) return null;
  if (!SAFE_PATH.test(target.pathname) || target.pathname.includes("..")) return null;
  if (target.hostname === YAHOO_HOST && YAHOO_PATH.test(target.pathname)) return "yahoo";
  if (target.hostname === "thumbnail.image.rakuten.co.jp" && MOTTAINAI_PATH.test(target.pathname)) {
    return "mottainai";
  }
  return null;
}

// もったいない本舗の表紙に付ける楽天サムネイルのサイズ指定。こちらが保存する URL は
// src/ichiba.ts が必ずこの値に揃えるので、/cover が受けるのもこれだけでよい。任意の
// `_ex=<W>x<H>` を通すと、値を変えるだけで別ハッシュ＝別 R2 オブジェクト（永久保存）を
// 際限なく作らせられる。
const ICHIBA_EX = "600x600";

/**
 * /cover に渡された URL を正規化する（R2 キーのハッシュと取得先を揃える）。クエリや
 * フラグメントを変えただけの別 URL で R2 に無限にオブジェクトを作られないようにするため:
 *   - yahoo: クエリ・フラグメントは捨てる（item-shopping.c.yimg.jp/i/l/<id> はクエリ不要）。
 *   - mottainai: サイズ指定が ICHIBA_EX のときだけ残し、他（別サイズ・他のクエリ）は捨てる。
 * 既存の正規の URL（クエリ無しの Yahoo、`?_ex=600x600` の楽天）は toString() が変わらないので
 * 既存の R2 キーはそのまま当たる。
 */
export function normalizeCoverTarget(target: URL, kind: "yahoo" | "mottainai"): URL {
  const out = new URL(target.origin + target.pathname);
  if (kind === "mottainai" && target.searchParams.get("_ex") === ICHIBA_EX) {
    out.search = `?_ex=${ICHIBA_EX}`;
  }
  return out;
}

// 上流画像の上限。表紙は数十 KB〜数百 KB（Yahoo /i/l/ は 20〜30KB、もったいない本舗は 700px）
// なので、これを超えるものは読まない・デコードしない。
export const MAX_COVER_BYTES = 2 * 1024 * 1024;

// 上流画像の取得（接続〜本文読み切り）の上限。超えたら上流失敗と同じ扱い（null・キャッシュしない）。
const IMAGE_TIMEOUT_MS = 8000;

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
  try {
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
  } catch {
    return null; // 読み取り中のタイムアウト（AbortSignal）・切断
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

// R2 の前に置く Cache API（caches.default、データセンタ単位）。人気の表紙は同じ colo から何度も
// 要求されるので、毎回 R2 の get（クラス B 操作・レイテンシ）を払わないように。キーは実在しない
// 内部ホストの URL（src/edgeCache.ts と同じ流儀）+ R2 キー。エッジでの保持は 1 日に留める:
// 管理画面で R2 を消して再トリムしたとき（src/admin.ts purgeCoverStore）に、古い結果が colo に
// 長く残らないように。ブラウザ向けの cache-control は呼び出し側（index.ts coverHeaders）が付ける。
const COVER_EDGE_HOST = "https://cover-cache.my100manga.internal/";
const COVER_EDGE_TTL = "public, max-age=86400";

function coverEdgeCache(): Cache | null {
  // テストランタイムや Cache API の無い環境では素通し。
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

function edgePut(ctx: ExecutionContext, cache: Cache | null, key: string, body: ArrayBuffer, etag?: string): void {
  if (!cache) return;
  const headers = new Headers({ "content-type": "image/jpeg", "cache-control": COVER_EDGE_TTL });
  if (etag) headers.set("etag", etag);
  ctx.waitUntil(cache.put(COVER_EDGE_HOST + key, new Response(body, { headers })).catch(() => {}));
}

/**
 * A store cover with its baked-in framing trimmed: Yahoo's white bars
 * (trimWhitespace) or もったいない本舗's logo frame (trimShopFrame). First hit decodes
 * + trims (src/covertrim.ts) and persists the result to R2 keyed by a hash of the
 * source URL; every later hit is served from the colo's Cache API copy, else from R2.
 * If trimming yields nothing, the original image is stored and served unchanged. null
 * on an upstream failure (non-image / oversized / timed-out responses count as
 * failures) or when opts.onMiss refuses. R2 objects are permanent (no lifecycle rule):
 * a trimmed cover is stored forever.
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

  const cache = coverEdgeCache();
  if (cache) {
    const cached = await cache.match(COVER_EDGE_HOST + key).catch(() => undefined);
    if (cached?.body) return { body: cached.body, etag: cached.headers.get("etag") ?? undefined };
  }

  if (env.COVERS) {
    const hit = await env.COVERS.get(key);
    if (hit) {
      if (!cache) return { body: hit.body, etag: hit.httpEtag };
      // 表紙は数十 KB なので読み切ってから返す（同じバイト列を Cache API にも入れる）。
      const bytes = await hit.arrayBuffer();
      edgePut(ctx, cache, key, bytes, hit.httpEtag);
      return { body: bytes, etag: hit.httpEtag };
    }
  }
  // R2 に無い（＝上流取得とデコードが走る）ときだけ呼び出し側の濫用よけに諮る。
  if (opts.onMiss && !(await opts.onMiss())) return null;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      cf: { cacheEverything: true, cacheTtl: 86400 },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch {
    return null; // timeout / network error — same as an upstream failure, nothing cached
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    return null;
  }
  const original = await readImageCapped(upstream);
  if (!original) return null;

  let out: ArrayBuffer = original;
  try {
    // 寸法が大きすぎる・読めない画像は covertrim 側がデコードせず null を返す（＝原画のまま）。
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
  edgePut(ctx, cache, key, out);
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
  let res: Response;
  try {
    res = await fetch(target.toString(), {
      cf: { cacheEverything: true, cacheTtl: 86400 },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  // 共有画像の合成用。content-type は店によって揺れうるので見ず、サイズ上限だけかける。
  const buf = await readImageCapped(res, MAX_COVER_BYTES, false);
  return buf ? new Uint8Array(buf) : null;
}
