import { commerceEnabled, excludeAdult } from "./site";
import { Env } from "./types";
import { pacedFetchJson, PROBE_TIMEOUT_MS, type Priority } from "./ratelimiter";
import { isValidIsbn } from "./util";

// Yahoo!ショッピング 商品検索API V3. A book's ISBN-13 is a JAN code (Bookland EAN,
// 978/979 prefix), so `jan_code` is an exact-ISBN lookup — the direct-match that
// makes Yahoo a reliable Tier 2 cover source behind Rakuten (no sales gate, free
// Client ID). Measured on the oldest/絶版 volumes (the ones Rakuten drops): ~68%
// return a real 600px cover. See scripts/yahoo-probe.mjs.
const V3 = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch";

// Yahoo item images are served at https://item-shopping.c.yimg.jp/i/<size>/<id>.
// The API only hands back /i/g/ (146px, ~7KB) as `image.medium`, but a /i/l/
// (600px, ~20-28KB) variant exists for the same id — the actual usable cover.
// Rewrite to it; non-yimg seller CDNs (rare) are left as-is.
function bestImage(h: any): string {
  const url: string = h?.exImage?.url || h?.image?.medium || h?.image?.small || "";
  return url.replace(/(\/\/item-shopping\.c\.yimg\.jp\/i\/)[a-z]\//, "$1l/");
}

// The /i/l/ cover is ~20-28KB; the small /i/g/ thumbnail is ~7KB. Reject anything
// below this so a book whose seller only uploaded a tiny image isn't taken as a
// real cover (matches the covers.ts Google threshold).
const COVER_MIN_BYTES = 12000;

// Marketplace listings can include adult floors; a manga ISBN won't collide with
// an adult JAN, but guard the name/genre anyway so nothing NSFW slips into covers.
const ADULT = /アダルト|成人|18禁|FANZA|官能|ボーイズラブ用品/; // R18版では判定しない（excludeAdult, src/site.ts）

/** True when the Yahoo Client ID is configured; callers skip Yahoo otherwise. */
export function yahooReady(env: Env): boolean {
  // R18版は外部ストアの API を一切使わない（src/site.ts commerce）。鍵が入っていても呼ばない。
  if (!commerceEnabled(env)) return false;
  return Boolean(env.YAHOO_APP_ID);
}

// Yahoo paces on its own "yahoo" instance of the RakutenRateLimiter DO (a generic 1 req/s
// spacer; the binding name is historical) so Yahoo and Rakuten don't share a lane.

async function call(env: Env, isbn: string, priority: Priority, maxWaitMs?: number): Promise<any | null> {
  const qs = new URLSearchParams({ appid: env.YAHOO_APP_ID!, jan_code: isbn, results: "5" });
  const url = `${V3}?${qs.toString()}`;
  // Slot, timeout and the 429 retry (re-paced on the "yahoo" lane) live in pacedFetchJson.
  return pacedFetchJson(env, "yahoo", priority, url, {}, maxWaitMs, 1500);
}

/** Byte-check the (possibly placeholder) image. False only when definitively tiny;
 *  a network error / missing length returns true so a real cover is never dropped. */
async function isRealCover(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    // GET, not HEAD: when the CDN omits Content-Length we measure the body instead.
    // When the header is there, cancel the body so the connection isn't left draining.
    const res = await fetch(url, {
      cf: { cacheEverything: true, cacheTtl: 86400 },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > 0) {
      await res.body?.cancel().catch(() => {});
      return len >= COVER_MIN_BYTES;
    }
    const buf = await res.arrayBuffer();
    return buf.byteLength >= COVER_MIN_BYTES;
  } catch {
    return true;
  }
}

/** Resolve a Yahoo cover for an exact ISBN (via jan_code).
 *   - string URL: a real 600px cover.
 *   - "" : Yahoo responded but has no listing / no real cover — determinate.
 *   - null: the lookup was not made (rate-limit budget exhausted / HTTP error).
 *     Never cache null as "no cover".
 *  `priority` picks the rate-limit lane; `maxWaitMs` caps the slot wait. */
export async function yahooResolveCover(
  env: Env,
  isbn: string,
  priority: Priority = "low",
  maxWaitMs?: number,
): Promise<string | null> {
  if (!yahooReady(env) || !isbn) return "";
  if (!isValidIsbn(isbn)) return ""; // can't be a JAN — skip the call
  const data = await call(env, isbn, priority, maxWaitMs);
  if (data === null) return null; // undetermined
  const hits: any[] = data?.hits ?? [];
  const exclude = excludeAdult(env);
  for (const h of hits) {
    if (exclude && ADULT.test(`${h?.genreCategory?.name ?? ""} ${h?.name ?? ""}`)) continue;
    const img = bestImage(h);
    if (img && (await isRealCover(img))) return img;
  }
  return ""; // determinate: no usable cover on Yahoo
}

/** Yahoo cover for the correction picker (high-priority lane), "" when none. */
export function probeYahooCover(env: Env, isbn: string): Promise<string> {
  if (!yahooReady(env) || !isbn) return Promise.resolve("");
  return yahooResolveCover(env, isbn, "high").then((c) => c ?? "");
}
