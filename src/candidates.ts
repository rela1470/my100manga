import { Env } from "./types";
import { badRequest, json } from "./util";
import { coverSuggestionsEnabled } from "./corrections";
import { probeGoogleCover } from "./covers";
import { probeYahooCover } from "./yahoo";
import { ichibaCovers } from "./ichiba";
import { rakutenResolveFull, rakutenSearchTitle, RakutenBook } from "./rakuten";
import { bookMetaInsertFromRakuten, cacheBookMetaBatch } from "./book";

interface Candidate {
  src: string;
  source: string; // where the image comes from, e.g. "Google Books" / "楽天ブックス"
  label: string; // what it is, e.g. "ISBN一致" or the matched edition title
}

// Candidate cover images for the correction page, fetched in stages so the picker
// can show each source as soon as it answers instead of waiting for the slowest
// (all of them queue on the 1 req/s Rakuten/Yahoo limiters). GET
// /api/cover-candidates?stage=…:
//   isbn   — exact-ISBN hits: Google (if real), 楽天ブックス, Yahoo!ショッピング (jan_code)
//   title  — 楽天ブックス title-search hits, so the owner can pick the right one when
//            the stored ISBN's edition has no cover
//   ichiba — 楽天市場 shop listings for the ISBN (used-book shops etc.; review-only)
// `q` is an owner-typed keyword: when present we run a literal Rakuten title
// search (no broadening, no ISBN lookups) so they can steer past bad auto matches.
type Stage = "isbn" | "title" | "ichiba";
const STAGES: Stage[] = ["isbn", "title", "ichiba"];

export async function coverCandidates(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isbn = (url.searchParams.get("isbn") ?? "").trim().slice(0, 20);
  const title = (url.searchParams.get("title") ?? "").trim().slice(0, 200);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const stage = url.searchParams.get("stage") as Stage | null;
  if (!isbn && !title && !q) return badRequest("isbn か title を指定してください");
  if (!q && !(stage && STAGES.includes(stage))) return badRequest("stage を指定してください");

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (src: string, source: string, label: string) => {
    if (src && !seen.has(src)) {
      seen.add(src);
      candidates.push({ src, source, label });
    }
  };

  // Tells the client whether the "画像URLを直接指定" input should be shown (single
  // source of truth = the server flag; the submission endpoint enforces it anyway).
  const urlSubmit = coverSuggestionsEnabled(env);
  const reply = () => json({ candidates, url_submit: urlSubmit }, 200, { "cache-control": "no-store" });

  if (q) {
    const hits = await searchOwnerQuery(env, q);
    for (const b of hits) add(b.cover_url, "楽天ブックス", b.title);
    await cacheBookMetaBatch(env, hits);
    return reply();
  }

  if (stage === "isbn") {
    if (!isbn) return reply();
    const [google, yahoo, rakutenIsbnRes] = await Promise.all([
      probeGoogleCover(env, isbn),
      probeYahooCover(env, isbn),
      rakutenResolveFull(env, isbn, "high"),
    ]);
    // The exact-ISBN cover call also carried the book's author/publisher/発行日/あらすじ
    // — cache it (book_meta) so the detail popup's /api/book is a free cache read
    // instead of a second Rakuten call for the same ISBN.
    if (rakutenIsbnRes.meta) {
      const stmt = bookMetaInsertFromRakuten(env, rakutenIsbnRes.meta);
      if (stmt) await stmt.run();
    }
    if (google) add(google, "Google Books", "ISBN一致");
    if (rakutenIsbnRes.cover) add(rakutenIsbnRes.cover, "楽天ブックス", "ISBN一致");
    if (yahoo) add(yahoo, "Yahoo!ショッピング", "ISBN一致");
    return reply();
  }

  if (stage === "ichiba") {
    if (!isbn) return reply();
    for (const c of (await ichibaCovers(env, isbn, "high")) ?? []) add(c.url, "楽天市場", c.shop);
    return reply();
  }

  // stage === "title". A title ending in a volume ("鋼の錬金術師 6") gets a precise
  // Rakuten "（n）" phrase too, so the exact volume floats above the series-broadened hits.
  if (!title) return reply();
  const volPhrase = volumePhrase(title);
  const [rakutenVolume, rakutenTitle] = await Promise.all([
    volPhrase ? rakutenSearchTitle(env, volPhrase, 30, { genre: false, priority: "high" }) : Promise.resolve([]),
    searchTitleBroadening(env, title),
  ]);
  // The title-search calls (volume phrase + broadened series) each returned full
  // records too — cache them so their ISBNs' popups are a free book_meta read.
  await cacheBookMetaBatch(env, [...rakutenVolume, ...rakutenTitle]);
  for (const b of rakutenVolume) add(b.cover_url, "楽天ブックス", b.title);
  for (const b of rakutenTitle) add(b.cover_url, "楽天ブックス", b.title);
  return reply();
}

interface VolumeCandidate {
  isbn: string;
  title: string;
  cover_url: string;
  volume: string; // volume number parsed from the Rakuten title ("" if none)
  author: string; // Rakuten author string, contributors joined with "/"
  publisher: string;
  pubdate: string; // Rakuten salesDate ("2015年08月04日")
}

// Candidates for manually filling a single missing volume the master lacks (e.g.
// ONE PIECE 巻110, which is absent from MADB entirely). The client passes the
// series title and the missing volume number; we search Rakuten and surface books
// whose parsed volume matches first. GET /api/volume-candidates.
export async function volumeCandidates(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const title = (url.searchParams.get("title") ?? "").trim().slice(0, 200);
  const volume = (url.searchParams.get("volume") ?? "").trim().slice(0, 10);
  const vnum = parseInt(volume, 10);
  if (!title || !Number.isFinite(vnum)) return badRequest("title と volume を指定してください");

  const hits = await searchVolume(env, title, String(vnum));
  await cacheBookMetaBatch(env, hits);
  const candidates: VolumeCandidate[] = hits.map((b) => ({
    isbn: b.isbn,
    title: b.title,
    cover_url: b.cover_url,
    volume: b.volume,
    author: b.author,
    publisher: b.publisher,
    pubdate: b.pubdate,
  }));
  return json({ candidates }, 200, { "cache-control": "no-store" });
}

/** Rakuten hits for a specific volume: try the precise "<title> <n>" phrase first,
 *  fall back to a broadened title search, and float exact volume matches to the top
 *  (deduped by ISBN). Rakuten titles carry a trailing レーベル so the volume can't
 *  always be parsed — unmatched hits are still offered, just ranked lower. */
async function searchVolume(env: Env, title: string, vnum: string) {
  let hits = await rakutenSearchTitle(env, `${title} ${vnum}`, 30, { genre: false, priority: "high" });
  if (!hits.length) hits = await searchTitleBroadening(env, title);
  const ordered = [...hits.filter((b) => b.volume === vnum), ...hits.filter((b) => b.volume !== vnum)];
  const seen = new Set<string>();
  const out: typeof ordered = [];
  for (const b of ordered) {
    if (!b.isbn || !b.cover_url || seen.has(b.isbn)) continue;
    seen.add(b.isbn);
    out.push(b);
    if (out.length >= 12) break;
  }
  return out;
}

/** Owner-typed keyword search for the manual picker. Rakuten's `title` is a strict
 *  phrase match, so a space-separated volume ("鋼の錬金術師 6") finds nothing even
 *  though the series is stocked as "鋼の錬金術師（6）". Try the literal phrase first
 *  (owner may be steering deliberately); if that's empty and the tail is a volume
 *  number, retry in Rakuten's "（n）" form so a trailing volume still lands on the
 *  exact book — without broadening to unrelated titles. */
async function searchOwnerQuery(env: Env, q: string): Promise<RakutenBook[]> {
  for (const v of ownerQueryVariants(q)) {
    const hits = await rakutenSearchTitle(env, v, 30, { genre: false, priority: "high" });
    if (hits.length) return hits;
  }
  return [];
}

/** The literal query, then — when it ends in a volume number — the Rakuten
 *  "<title>（n）" phrase ("鋼の錬金術師 6" → "鋼の錬金術師（6）"). */
function ownerQueryVariants(q: string): string[] {
  const variants = [q];
  const phrase = volumePhrase(q);
  if (phrase) variants.push(phrase);
  return [...new Set(variants.filter(Boolean))];
}

/** When a title ends in a volume number, Rakuten's exact "<title>（n）" phrase
 *  ("鋼の錬金術師 6" → "鋼の錬金術師（6）"); "" when there's no trailing volume. */
function volumePhrase(title: string): string {
  const m = title.match(/^(.*?)[\s　]+[（(]?\s*(\d{1,4})\s*[）)]?$/);
  return m ? `${m[1].trim()}（${m[2]}）` : "";
}

/** Rakuten's `title` search is a strict phrase match, so a compound MADB title
 *  ("冴えない彼女の育てかた 恋するメトロノーム 1") can return nothing even when the
 *  base series is stocked. Try the volume-stripped title first, then progressively
 *  broader prefixes, stopping at the first query that yields hits. */
async function searchTitleBroadening(env: Env, rawTitle: string) {
  const queries = titleQueries(rawTitle);
  for (const q of queries) {
    const hits = await rakutenSearchTitle(env, q, 12, { genre: false, priority: "high" });
    if (hits.length) return hits;
  }
  return [];
}

/** Ordered search terms from most to least specific, deduped. */
function titleQueries(rawTitle: string): string[] {
  const base = seriesQuery(rawTitle);
  const segments = base.split(/[\s　]+/).filter(Boolean);
  const queries: string[] = [base];
  // Drop trailing segments to reach the core series title ("A B C" → "A B" → "A").
  for (let n = segments.length - 1; n >= 1; n--) {
    queries.push(segments.slice(0, n).join(" "));
  }
  return [...new Set(queries.filter((q) => q.length >= 2))];
}

/** Trim a volume label down to the series title for a broader Rakuten search
 *  ("ワカコ酒 14" → "ワカコ酒"). */
function seriesQuery(title: string): string {
  return title.replace(/\s*[（(]?\s*\d{1,4}\s*[）)]?\s*$/, "").trim() || title;
}
