import { Env } from "./types";
import { badRequest, json } from "./util";
import { probeGoogleCover } from "./covers";
import { rakutenByIsbn, rakutenSearchTitle } from "./rakuten";

interface Candidate {
  src: string;
  source: string; // where the image comes from, e.g. "Google Books" / "楽天ブックス"
  label: string; // what it is, e.g. "ISBN一致" or the matched edition title
}

// Candidate cover images for the correction page: Google (if real), Rakuten by
// exact ISBN, and Rakuten title-search hits (so the owner can pick the right one
// when the stored ISBN's edition has no cover). GET /api/cover-candidates.
// `q` is an owner-typed keyword: when present we run a literal Rakuten title
// search (no broadening, no ISBN lookups) so they can steer past bad auto matches.
export async function coverCandidates(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isbn = (url.searchParams.get("isbn") ?? "").trim().slice(0, 20);
  const title = (url.searchParams.get("title") ?? "").trim().slice(0, 200);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!isbn && !title && !q) return badRequest("isbn か title を指定してください");

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (src: string, source: string, label: string) => {
    if (src && !seen.has(src)) {
      seen.add(src);
      candidates.push({ src, source, label });
    }
  };

  if (q) {
    const hits = await rakutenSearchTitle(env, q, 30, { genre: false, priority: "high" });
    for (const b of hits) add(b.cover_url, "楽天ブックス", b.title);
    return json({ candidates }, 200, { "cache-control": "no-store" });
  }

  const [google, rakutenIsbn, rakutenTitle] = await Promise.all([
    isbn ? probeGoogleCover(env, isbn) : Promise.resolve(""),
    isbn ? rakutenByIsbn(env, isbn, "high") : Promise.resolve(""),
    title ? searchTitleBroadening(env, title) : Promise.resolve([]),
  ]);

  if (google) add(google, "Google Books", "ISBN一致");
  if (rakutenIsbn) add(rakutenIsbn, "楽天ブックス", "ISBN一致");
  for (const b of rakutenTitle) add(b.cover_url, "楽天ブックス", b.title);

  return json({ candidates }, 200, { "cache-control": "no-store" });
}

interface VolumeCandidate {
  isbn: string;
  title: string;
  cover_url: string;
  volume: string; // volume number parsed from the Rakuten title ("" if none)
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
  const candidates: VolumeCandidate[] = hits.map((b) => ({
    isbn: b.isbn,
    title: b.title,
    cover_url: b.cover_url,
    volume: b.volume,
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
