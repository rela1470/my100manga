import { Env } from "./types";

// The 2026 Rakuten OpenAPI gateway rejects server-side calls unless they look
// like a browser XHR from the app's registered site: a matching Referer/Origin
// plus Sec-Fetch-* headers. Without these it returns 403 REFERRER_MISSING even
// when the applicationId/accessKey are valid.
const BOOKS_SEARCH = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const COMICS_GENRE = "001001"; // 本 > コミック
const DEFAULT_REFERER = "https://my100manga.com/";

export interface RakutenBookFull {
  title: string;
  isbn: string;
  author: string; // raw Rakuten author string; multiple contributors joined with "/"
  publisher: string; // publisherName
  pubdate: string; // salesDate, already in Japanese form ("2015年08月04日")
  caption: string; // itemCaption — the publisher's blurb / synopsis
  cover_url: string;
}

export interface RakutenBook extends RakutenBookFull {
  volume: string; // best-effort volume number parsed from the title ("" if none)
}

/** True when Rakuten credentials are configured; callers should skip Rakuten otherwise. */
export function rakutenReady(env: Env): boolean {
  return Boolean(env.RAKUTEN_APP_ID && env.RAKUTEN_ACCESS_KEY);
}

/** Browser-XHR-looking headers the 2026 OpenAPI gateway requires. Shared with the
 *  楽天市場 client (src/ichiba.ts), which goes through the same gateway. */
export function headers(env: Env): Record<string, string> {
  const ref = env.RAKUTEN_REFERER || DEFAULT_REFERER;
  const origin = ref.replace(/\/$/, "");
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ja,en-US;q=0.9",
    Origin: origin,
    Referer: ref,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
  };
}

/** Bump Rakuten's thumbnail size hint (…?_ex=200x200) up for a sharper cover. */
function upsize(url: string): string {
  return url ? url.replace(/_ex=\d+x\d+/, "_ex=300x300") : url;
}

// Rakuten serves a gray "noimage" placeholder as a normal largeImageUrl for books
// it has no cover for. The filename always contains "noimage" (…/noimage_01.gif),
// which is the reliable signal — the byte size isn't: upsizing to _ex=300x300
// inflates the placeholder to ~8KB, past any sane small-image threshold. The byte
// floor is kept only as a secondary guard for other tiny/broken images.
const COVER_MIN_BYTES = 4000;

/** False only when the URL is *definitively* a noimage placeholder (by filename)
 *  or a tiny image. A network error or a missing Content-Length returns true, so a
 *  possibly-real cover is never dropped (nor cached as "no cover") on a transient
 *  failure. */
async function isRealCover(url: string): Promise<boolean> {
  if (!url) return false;
  if (/noimage/i.test(url)) return false; // Rakuten's placeholder filename
  try {
    const res = await fetch(url, { method: "HEAD", cf: { cacheEverything: true, cacheTtl: 86400 } });
    if (!res.ok) return true;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len <= 0) return true; // unknown size — don't drop
    return len >= COVER_MIN_BYTES;
  } catch {
    return true;
  }
}

/** Parse a volume number out of a Rakuten book title (「ワカコ酒（27）」→ "27"). */
function parseVolume(title: string): string {
  const m = title.match(/[（(]\s*(\d{1,4})\s*[）)]\s*$/) || title.match(/\s(\d{1,4})\s*$/);
  return m ? m[1] : "";
}

import type { Priority } from "./ratelimiter";

// How long a call waits for a global rate-limit slot before giving up (returns
// null). Also caps how deep each lane's queue grows — see RakutenRateLimiter.
// High = user-initiated (correction picker): generous, so it's essentially
// always served and, being on its own lane, jumps ahead of background backlog.
// Low = background bulk cover fill: bounded so it doesn't book minutes ahead.
const MAX_WAIT_MS: Record<Priority, number> = { high: 15000, low: 8000 };

/** Wait for a global 1 req/s slot on the given priority lane. Returns false when
 *  the caller should skip Rakuten (slot past budget, or limiter unavailable).
 *  `maxWaitMs` overrides the lane default so a caller with a shrinking wall-clock
 *  budget (resolveCovers) can refuse a slot that would land past its deadline.
 *  楽天市場 (src/ichiba.ts) uses the same applicationId, so it shares this lane. */
export async function awaitSlot(env: Env, priority: Priority, maxWaitMs?: number): Promise<boolean> {
  if (!env.RAKUTEN_LIMITER) return true; // limiter unbound (tests/local) → no pacing
  const cap = maxWaitMs ?? MAX_WAIT_MS[priority];
  if (cap <= 0) return false;
  try {
    const stub = env.RAKUTEN_LIMITER.getByName("global");
    const wait = await stub.acquire(cap, priority);
    if (wait < 0) return false;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return true;
  } catch {
    return true; // limiter failure shouldn't block covers entirely
  }
}

async function call(
  env: Env,
  params: Record<string, string>,
  priority: Priority,
  maxWaitMs?: number,
): Promise<any | null> {
  const qs = new URLSearchParams({
    format: "json",
    applicationId: env.RAKUTEN_APP_ID!,
    accessKey: env.RAKUTEN_ACCESS_KEY!,
    // Most older manga volumes are 品切れ/絶版; the API hides them by default.
    // We only want the cover image, not purchasability, so include them.
    outOfStockFlag: "1",
    ...params,
  });
  const url = `${BOOKS_SEARCH}?${qs.toString()}`;
  if (!(await awaitSlot(env, priority, maxWaitMs))) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: headers(env) });
    if (res.status === 429) {
      // Rate limited: wait a beat and retry once, then give up (cover is optional).
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  }
  return null;
}

function toBook(item: any): RakutenBook {
  const full = toFull(item, String(item?.isbn ?? ""));
  return { ...full, volume: parseVolume(full.title) };
}

function toFull(item: any, isbn: string): RakutenBookFull {
  return {
    title: String(item?.title ?? ""),
    isbn: String(item?.isbn ?? isbn),
    author: String(item?.author ?? ""),
    publisher: String(item?.publisherName ?? ""),
    pubdate: String(item?.salesDate ?? ""),
    caption: String(item?.itemCaption ?? ""),
    cover_url: upsize(String(item?.largeImageUrl ?? "")),
  };
}

const emptyFull = (isbn: string): RakutenBookFull => ({
  title: "", isbn, author: "", publisher: "", pubdate: "", caption: "", cover_url: "",
});

/** One exact-ISBN Rakuten call, returning BOTH the cover and the full book record
 *  parsed from the SAME response — so a caller resolving a cover gets the author/
 *  publisher/発行日/あらすじ for free (see covers.ts piggybacking book_meta) instead
 *  of paying a second call.
 *   - cover: the cover URL, "" when Rakuten definitively has none, or `null` when the
 *     lookup was *not made* (rate-limit budget exhausted / HTTP error). Never cache
 *     `null` as "no cover".
 *   - meta: the book record, or `null` when the lookup was not made. An all-empty
 *     record (title==="") means Rakuten responded but has no entry for the ISBN —
 *     determinate, safe to cache.
 *  `priority` picks the rate-limit lane; `maxWaitMs` caps the slot wait. */
export async function rakutenResolveFull(
  env: Env,
  isbn: string,
  priority: Priority = "low",
  maxWaitMs?: number,
): Promise<{ cover: string | null; meta: RakutenBookFull | null }> {
  if (!rakutenReady(env) || !isbn) return { cover: "", meta: null };
  const data = await call(env, { isbn }, priority, maxWaitMs);
  if (data === null) return { cover: null, meta: null }; // undetermined
  const item = data?.Items?.[0]?.Item;
  if (!item) return { cover: "", meta: emptyFull(isbn) };
  const meta = toFull(item, isbn);
  const cover = meta.cover_url && (await isRealCover(meta.cover_url)) ? meta.cover_url : "";
  return { cover, meta };
}

/** Title search. Used to rescue volumes whose stored ISBN is an edition Rakuten
 *  no longer indexes. Defaults to the comics genre for automatic rescue (avoids
 *  auto-applying non-manga covers); pass { genre: false } for the manual picker,
 *  where broader matches (light novels, art books) are useful choices to offer.
 *  `priority` picks the rate-limit lane (default "low"). Returns up to `limit`
 *  books with covers. */
export async function rakutenSearchTitle(
  env: Env,
  title: string,
  limit = 30,
  opts: { genre?: boolean; priority?: Priority } = {},
): Promise<RakutenBook[]> {
  if (!rakutenReady(env) || !title) return [];
  const params: Record<string, string> = { title, hits: String(Math.min(limit, 30)) };
  if (opts.genre !== false) params.booksGenreId = COMICS_GENRE;
  const data = await call(env, params, opts.priority ?? "low");
  const items: any[] = data?.Items ?? [];
  const books = items.map((x) => toBook(x?.Item)).filter((b) => b.cover_url);
  const real = await Promise.all(books.map((b) => isRealCover(b.cover_url)));
  return books.filter((_, i) => real[i]); // drop noimage placeholders
}
