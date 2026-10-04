import { commerceEnabled, excludeAdult } from "./site";
import { Env } from "./types";
import { isValidIsbn } from "./util";

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
  // R18版は外部ストアの API を一切使わない（src/site.ts commerce）。鍵が入っていても呼ばない。
  if (!commerceEnabled(env)) return false;
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
    const res = await fetch(url, {
      method: "HEAD",
      cf: { cacheEverything: true, cacheTtl: 86400 },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
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

import { pacedFetchJson, PROBE_TIMEOUT_MS, type Priority } from "./ratelimiter";

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
  // Slot, timeout and the 429 retry (re-paced on the same lane) live in pacedFetchJson.
  return pacedFetchJson(env, "global", priority, url, { headers: headers(env) }, maxWaitMs);
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
  // A malformed ISBN can't match anything: skip the call (and the empty "determinate"
  // record a caller would cache). Callers validate at their entry too; this is the net.
  if (!isValidIsbn(isbn)) return { cover: "", meta: null };
  const data = await call(env, { isbn }, priority, maxWaitMs);
  if (data === null) return { cover: null, meta: null }; // undetermined
  const item = data?.Items?.[0]?.Item;
  if (!item) return { cover: "", meta: emptyFull(isbn) };
  const meta = toFull(item, isbn);
  const cover = meta.cover_url && (await isRealCover(meta.cover_url)) ? meta.cover_url : "";
  return { cover, meta };
}

// Genres accepted for ISBN search's fallback card (rakutenComicByIsbn): 漫画（コミック）and its
// children, plus 文庫 > 漫画. Rakuten Books has no adult genre under these; the regex below
// is a second net over title / series / publisher in case something slips in anyway.
const COMIC_GENRES = /^(001001|001019011)/;
const ADULT = /アダルト|成人|成年|18禁|R-?18|官能/i; // R18版では判定しない（excludeAdult, src/site.ts）

/** The book for an ISBN the master lacks, for ISBN search — only when Rakuten files it
 *  under a manga genre and nothing in its names looks adult; otherwise null. Rakuten
 *  Books only (never 楽天市場 / Yahoo: their marketplace listings include adult items). */
export async function rakutenComicByIsbn(env: Env, isbn: string): Promise<RakutenBook | null> {
  // ISBN search (src/search.ts) passes user input here on the high-priority lane, so
  // anything that isn't a real ISBN (check digit included) never reaches Rakuten.
  if (!rakutenReady(env) || !isValidIsbn(isbn)) return null;
  const item = (await call(env, { isbn }, "high"))?.Items?.[0]?.Item;
  if (!item?.title) return null;
  const genres = String(item.booksGenreId ?? "").split("/");
  if (!genres.some((g) => COMIC_GENRES.test(g))) return null;
  if (excludeAdult(env) && ADULT.test(`${item.title} ${item.seriesName ?? ""} ${item.publisherName ?? ""}`)) return null;
  const book = toBook(item);
  if (/noimage/i.test(book.cover_url)) book.cover_url = "";
  return book;
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
  return (await rakutenSearchTitleOrSkip(env, title, limit, opts)) ?? [];
}

/** rakutenSearchTitle, but null when the call was NOT made (no rate-limit slot,
 *  timeout, HTTP error) instead of []. Lets a caller trying several queries in a row
 *  (src/candidates.ts) stop as soon as the limiter refuses, rather than queueing more. */
export async function rakutenSearchTitleOrSkip(
  env: Env,
  title: string,
  limit = 30,
  opts: { genre?: boolean; priority?: Priority } = {},
): Promise<RakutenBook[] | null> {
  if (!rakutenReady(env) || !title) return [];
  const params: Record<string, string> = { title, hits: String(Math.min(limit, 30)) };
  if (opts.genre !== false) params.booksGenreId = COMICS_GENRE;
  const data = await call(env, params, opts.priority ?? "low");
  if (data === null) return null;
  const items: any[] = data?.Items ?? [];
  const books = items.map((x) => toBook(x?.Item)).filter((b) => b.cover_url);
  const real = await Promise.all(books.map((b) => isRealCover(b.cover_url)));
  return books.filter((_, i) => real[i]); // drop noimage placeholders
}

export interface RakutenBestseller {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  sales_date: string; // salesDate as-is ("2026年11月04日", "2026年09月30日頃")
  cover_url: string;
}

/** One page of 楽天ブックス' comics sorted by 売れている順 (sort=sales) — the daily sales
 *  ranking snapshot (src/salesRanking.ts). In-stock/予約 only: an out-of-stock title
 *  isn't selling. null when the call wasn't made (rate-limit budget / HTTP error). */
export async function rakutenBestsellers(env: Env, page: number, hits = 30): Promise<RakutenBestseller[] | null> {
  if (!rakutenReady(env)) return null;
  const data = await call(
    env,
    { booksGenreId: COMICS_GENRE, sort: "sales", hits: String(hits), page: String(page), outOfStockFlag: "0" },
    "low",
  );
  if (data === null) return null;
  const items: any[] = data?.Items ?? [];
  return items
    .map((x) => x?.Item)
    .filter((it) => it?.isbn && it?.title)
    .map((it) => ({
      isbn: String(it.isbn),
      title: String(it.title),
      author: String(it.author ?? ""),
      publisher: String(it.publisherName ?? ""),
      sales_date: String(it.salesDate ?? ""),
      cover_url: /noimage/i.test(String(it.largeImageUrl ?? "")) ? "" : upsize(String(it.largeImageUrl ?? "")),
    }));
}
