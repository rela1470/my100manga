import { Env } from "./types";
import { googleCover, isValidIsbn } from "./util";
import { rakutenResolveFull, rakutenReady } from "./rakuten";
import { yahooResolveCover, yahooReady } from "./yahoo";
import { ichibaCovers } from "./ichiba";
import { bookMetaInsertFromRakuten } from "./book";
import { PROBE_TIMEOUT_MS } from "./ratelimiter";

// Google Books returns a ~10.8KB gray "image not available" placeholder when an
// ISBN has no cover. Real covers we've seen are ≥12.6KB, so anything smaller than
// this threshold is treated as "no cover".
const COVER_MIN_BYTES = 12000;

/** Google Books cover source. Off by default — Rakuten is the primary source and
 *  Google stays wired up but dormant. Set GOOGLE_ENABLED="true" (or "1") to
 *  re-enable it as the Tier 2 cover fallback and correction-page candidate. */
export function googleEnabled(env: Env): boolean {
  return env.GOOGLE_ENABLED === "true" || env.GOOGLE_ENABLED === "1";
}
// Rakuten's ~1 req/s cap is now enforced globally by the RakutenRateLimiter DO
// (each call reserves a slot). This only bounds how many probes wait in flight
// at once; the pacing itself comes from the limiter. Kept at 2 because the limiter
// hands a lane at most 2 slots in a row (src/ratelimiter.ts MAX_RUN / MAX_BOOK_AHEAD):
// asking for more just gets refused and wastes the round trip — the covers resolved
// per call is the same either way (measured: 0.92/s at any concurrency).
const RAKUTEN_CONCURRENCY = 2;

// Hard wall-clock budget for one resolveCovers call. Rakuten's global 1 req/s
// limiter serializes cache misses at ~1.1s each, so a POST /api/covers carrying
// many uncached ISBNs (e.g. a multi-volume series) would otherwise run for
// minutes and get killed mid-request ("worker restarted mid-request" → 503).
// We resolve as many as fit in this budget (~7-8 covers) and leave the rest
// uncached; the client fills them with subsequent lazy POSTs.
const RESOLVE_BUDGET_MS = 9000;

interface CoverRow {
  isbn: string;
  cover_url: string;
}

/** Read cached covers. Never hits the network, so the volume/search list
 *  endpoints can return instantly and let the client fill uncached covers lazily
 *  via POST /api/covers. The cache is permanent: a cover (or a confirmed "no
 *  cover") for a given ISBN doesn't change, so once resolved it's kept forever.
 *  Missing covers are recovered on demand via the manual correction flow.
 *  Returns isbn → cover URL. */
// D1 caps a single statement at 100 bound parameters, so chunk the IN (...) query.
const SQL_VARS_MAX = 90;

export async function readCachedCovers(env: Env, isbns: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(isbns.filter(Boolean))];
  if (uniq.length === 0) return out;

  for (let i = 0; i < uniq.length; i += SQL_VARS_MAX) {
    const chunk = uniq.slice(i, i + SQL_VARS_MAX);
    const placeholders = chunk.map(() => "?").join(",");
    const cached = await env.DB.prepare(
      `SELECT isbn, cover_url FROM covers WHERE isbn IN (${placeholders})`
    )
      .bind(...chunk)
      .all<CoverRow>();
    for (const r of cached.results ?? []) out.set(r.isbn, r.cover_url);
  }
  return out;
}

/** Resolve the best cover URL for each ISBN: the Rakuten Books cover (exact-ISBN)
 *  if one exists, else a Yahoo!ショッピング cover (exact-ISBN via jan_code), else a
 *  楽天市場 cover (ISBN keyword — only a 楽天ブックス/used-book-shop image applies directly;
 *  a shop image is queued for admin review and the ISBN stays coverless), else a
 *  real Google Books cover, else "". Results (including "no cover") are cached
 *  permanently in the `covers` table; only cache misses hit the network, so each
 *  API's rate limit is paid at most once per ISBN. Returns a map isbn → cover URL
 *  (""=none). */
export async function resolveCovers(env: Env, isbns: string[]): Promise<Map<string, string>> {
  const out = await readCachedCovers(env, isbns);
  const uniq = [...new Set(isbns.filter(Boolean))];

  // Only well-formed ISBNs (check digit included) go to the network. Anything else is
  // silently dropped: not resolved and NOT cached, so junk ids in a POST /api/covers
  // can neither spend API slots nor leave "" rows in `covers`.
  const toResolve = uniq.filter((i) => !out.has(i) && isValidIsbn(i));
  if (toResolve.length === 0) return out;

  const now = Date.now();
  const deadline = now + RESOLVE_BUDGET_MS;

  // Only ISBNs with a *determined* answer are cached: a real cover URL, or "" when
  // a source definitively has no cover. ISBNs we skip (out of budget) or that come
  // back undetermined (rate-limit/HTTP error) are left out entirely so the cache is
  // never poisoned with a permanent "no cover" for something that just wasn't tried.
  const determined = new Map<string, string>();
  // ISBNs Rakuten confirmed it has no cover for — handed down the fallback chain
  // (Yahoo → 楽天市場 → Google).
  const needFallback: string[] = [];
  // Book metadata (author/publisher/発行日/あらすじ) parsed from the SAME Rakuten
  // response as the cover, cached for the detail popup so /api/book is a pure cache
  // read instead of a second Rakuten call. See src/book.ts / bookMetaInsertFromRakuten.
  const metaWrites: D1PreparedStatement[] = [];

  // Tier 1: Rakuten exact-ISBN (rate-limited — small concurrent batches), bounded
  // by RESOLVE_BUDGET_MS so a big batch of cache misses can't outlive the request.
  if (rakutenReady(env)) {
    for (let i = 0; i < toResolve.length; i += RAKUTEN_CONCURRENCY) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // out of time — leave the rest uncached
      const batch = toResolve.slice(i, i + RAKUTEN_CONCURRENCY);
      const results = await Promise.all(
        batch.map((isbn) => rakutenResolveFull(env, isbn, "low", remaining))
      );
      batch.forEach((isbn, j) => {
        const { cover, meta } = results[j];
        if (meta) {
          const stmt = bookMetaInsertFromRakuten(env, meta);
          if (stmt) metaWrites.push(stmt);
        }
        if (cover === null) return; // undetermined — don't cache, retry on a later POST
        if (cover) determined.set(isbn, cover); // found
        else needFallback.push(isbn); // Rakuten confirmed none — fall through to Yahoo/Google
      });
    }
  } else {
    needFallback.push(...toResolve);
  }

  // Tier 2: Yahoo (jan_code exact-ISBN) for Rakuten misses — rate-limited and
  // bounded by the SAME deadline as Rakuten. Found → cached cover; Yahoo-confirmed
  // "none" falls through to Google. Items not reached before the deadline (or that
  // come back undetermined) are left uncached so a later POST retries them, exactly
  // like the Rakuten tier.
  const needIchiba: string[] = [];
  if (needFallback.length && yahooReady(env)) {
    for (const isbn of needFallback) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // out of time — leave the rest uncached
      const cover = await yahooResolveCover(env, isbn, "low", remaining);
      if (cover === null) continue; // undetermined — don't cache, retry on a later POST
      if (cover) determined.set(isbn, cover); // found
      else needIchiba.push(isbn); // Yahoo confirmed none — fall through to 楽天市場
    }
  } else {
    needIchiba.push(...needFallback);
  }

  // Tier 3: 楽天市場 (ISBN keyword) for Yahoo misses — same Rakuten limiter and
  // deadline. A trusted image (楽天ブックス / used-book shop cabinet, see isTrustedCoverUrl)
  // applies directly. Other shop images (used-book logo frames, wrong editions) are
  // never applied unreviewed: the best one is queued into cover_suggestion for the
  // admin and the ISBN is cached as "no cover" meanwhile (approve writes `covers`).
  const needGoogle: string[] = [];
  const queued: { isbn: string; url: string }[] = [];
  if (needIchiba.length && rakutenReady(env)) {
    for (const isbn of needIchiba) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // out of time — leave the rest uncached
      const found = await ichibaCovers(env, isbn, "low", remaining);
      if (found === null) continue; // undetermined — don't cache, retry on a later POST
      if (!found.length) {
        needGoogle.push(isbn); // 楽天市場 confirmed none — fall through to Google
        continue;
      }
      const trusted = found.find((c) => isTrustedCoverUrl(c.url));
      if (trusted) determined.set(isbn, trusted.url);
      else {
        queued.push({ isbn, url: found[0].url });
        determined.set(isbn, "");
      }
    }
  } else {
    needGoogle.push(...needIchiba);
  }

  // Tier 4: Google (parallel — no rate limit) for ISBNs neither Rakuten nor Yahoo
  // could cover. Off by default; see googleEnabled. Either way these are now
  // determined: a Google cover, or a confirmed "no cover" ("").
  if (needGoogle.length && googleEnabled(env)) {
    const hasGoogle = await Promise.all(needGoogle.map((i) => probeGoogle(i)));
    needGoogle.forEach((isbn, k) => {
      determined.set(isbn, hasGoogle[k] ? googleCover(isbn) : "");
    });
  } else {
    for (const isbn of needGoogle) determined.set(isbn, "");
  }

  // A store can hand back an image an admin redacted (same URL under another ISBN of
  // the volume, which the list showed via the sibling fallback). Cache those as "no
  // cover" so auto-resolution can't undo the redaction.
  const redacted = await redactedCoverUrls(env, [...determined.values(), ...queued.map((q) => q.url)]);
  for (const [isbn, url] of determined) if (redacted.has(url)) determined.set(isbn, "");

  const writes = [];
  for (const [isbn, url] of determined) {
    out.set(isbn, url);
    writes.push(
      env.DB.prepare(`INSERT OR REPLACE INTO covers (isbn, cover_url, checked_at) VALUES (?, ?, ?)`)
        .bind(isbn, url, now)
    );
  }
  if (writes.length) await env.DB.batch(writes);
  if (metaWrites.length) await env.DB.batch(metaWrites);
  if (queued.length) await queueReview(env, queued, redacted, now);

  return out;
}

/** Queue auto-found 楽天市場 covers for admin review (cover_suggestion with
 *  suggest_count 0 = found by the resolver, not picked by a user). Not gated by
 *  COVER_SUGGESTIONS_ENABLED: that switch guards user-supplied URLs, and these come
 *  from the API. DO NOTHING on conflict so a pair the admin already dismissed or
 *  redacted isn't reopened on every re-resolve. */
async function queueReview(
  env: Env,
  items: { isbn: string; url: string }[],
  redacted: Set<string>,
  now: number,
): Promise<void> {
  const stmts = items
    .filter((q) => !redacted.has(q.url))
    .map((q) =>
      env.DB.prepare(
        `INSERT INTO cover_suggestion (isbn, cover_url, old_cover_url, suggest_count, first_at, last_at)
         VALUES (?, ?, '', 0, ?, ?) ON CONFLICT (isbn, cover_url) DO NOTHING`
      ).bind(q.isbn, q.url, now, now)
    );
  if (stmts.length) await env.DB.batch(stmts);
}

/** Whether a picked image may fill an empty global cover without review: a book image
 *  from 楽天ブックス or the used-book shops ブックオフ / 駿河屋 / もったいない本舗 (the
 *  thumbnail host serves every 楽天 product, so only those shops' cabinet paths
 *  count; their images are cover scans, もったいない本舗's after the frame crop) or Google Books (book covers only). Yahoo!ショッピング
 *  and other 楽天市場 shop images can be anything (logo frames, set photos), so they
 *  go through review. An unreviewed fill can then at worst be a different product's
 *  cover, never an arbitrary image. */
const TRUSTED_RAKUTEN_CABINETS = [
  "/@0_mall/book/cabinet/",
  "/@0_mall/bookoffonline/cabinet/",
  "/@0_mall/surugaya-a-too/cabinet/",
  // もったいない本舗: framed with a logo band + mascot, but /cover crops that off
  // (src/covertrim.ts trimShopFrame) so what's shown is the plain scan.
  "/@0_mall/comicset/cabinet/",
  "/@0_mall/mottainaihonpo/cabinet/",
  "/@0_mall/mottainaihonpo-omatome/cabinet/",
];

export function isTrustedCoverUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.hostname === "thumbnail.image.rakuten.co.jp") {
      return TRUSTED_RAKUTEN_CABINETS.some((p) => u.pathname.startsWith(p));
    }
    return u.hostname === "books.google.com";
  } catch {
    return false;
  }
}

/** Which of `urls` an admin redacted via a cover report (cover_suggestion
 *  resolution 'redacted', for any ISBN). */
export async function redactedCoverUrls(env: Env, urls: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const uniq = [...new Set(urls.filter(Boolean))];
  if (uniq.length === 0) return out;
  const res = await env.DB.prepare(
    `SELECT DISTINCT cover_url FROM cover_suggestion
      WHERE resolution = 'redacted' AND cover_url IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(uniq))
    .all<{ cover_url: string }>();
  for (const r of res.results ?? []) out.add(r.cover_url);
  return out;
}

/** First non-empty cover URL among the given ISBNs (in order), else "". */
export function firstCover(isbns: string[], covers: Map<string, string>): string {
  for (const isbn of isbns) {
    const url = covers.get(isbn);
    if (url) return url;
  }
  return "";
}

/** Google cover URL for an ISBN if a real cover exists there, else "" (used by
 *  the correction page to offer Google as a candidate). */
export async function probeGoogleCover(env: Env, isbn: string): Promise<string> {
  if (!isbn || !googleEnabled(env) || !isValidIsbn(isbn)) return "";
  return (await probeGoogle(isbn)) ? googleCover(isbn) : "";
}

async function probeGoogle(isbn: string): Promise<boolean> {
  try {
    const res = await fetch(googleCover(isbn), {
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
    // Network hiccup: don't hide a possibly-real cover (and don't cache this as a miss).
    return true;
  }
}
