import { Env } from "./types";

// The 2026 Rakuten OpenAPI gateway rejects server-side calls unless they look
// like a browser XHR from the app's registered site: a matching Referer/Origin
// plus Sec-Fetch-* headers. Without these it returns 403 REFERRER_MISSING even
// when the applicationId/accessKey are valid.
const BOOKS_SEARCH = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const COMICS_GENRE = "001001"; // 本 > コミック
const DEFAULT_REFERER = "https://my100manga.com/";

export interface RakutenBook {
  title: string;
  isbn: string;
  volume: string; // best-effort volume number parsed from the title ("" if none)
  cover_url: string;
}

/** True when Rakuten credentials are configured; callers should skip Rakuten otherwise. */
export function rakutenReady(env: Env): boolean {
  return Boolean(env.RAKUTEN_APP_ID && env.RAKUTEN_ACCESS_KEY);
}

function headers(env: Env): Record<string, string> {
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
 *  budget (resolveCovers) can refuse a slot that would land past its deadline. */
async function awaitSlot(env: Env, priority: Priority, maxWaitMs?: number): Promise<boolean> {
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
  const title = String(item?.title ?? "");
  return {
    title,
    isbn: String(item?.isbn ?? ""),
    volume: parseVolume(title),
    cover_url: upsize(String(item?.largeImageUrl ?? "")),
  };
}

/** Exact-ISBN cover lookup. Returns the cover URL, "" when Rakuten definitively
 *  has no cover, or `null` when the lookup was *not made* (rate-limit budget
 *  exhausted, HTTP/network error). Callers must not cache `null` as "no cover" —
 *  it just means "unknown, try again later".
 *  `priority` picks the rate-limit lane: "high" for user-initiated lookups,
 *  "low" (default) for background bulk cover fills. `maxWaitMs` caps how long the
 *  call may wait for a rate-limit slot before giving up (returns null). */
export async function rakutenByIsbn(
  env: Env,
  isbn: string,
  priority: Priority = "low",
  maxWaitMs?: number,
): Promise<string | null> {
  if (!rakutenReady(env) || !isbn) return "";
  const data = await call(env, { isbn }, priority, maxWaitMs);
  if (data === null) return null; // lookup skipped/failed — undetermined, don't cache
  const item = data?.Items?.[0]?.Item;
  return item ? upsize(String(item.largeImageUrl ?? "")) : "";
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
  return items
    .map((x) => toBook(x?.Item))
    .filter((b) => b.cover_url);
}
