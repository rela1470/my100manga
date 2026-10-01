/** Google Books cover thumbnail (works by ISBN without an API key). When a cover
 *  is unavailable Google returns a ~10.8KB gray "no image" placeholder image;
 *  covers.ts probes for that so callers can fall back to our own No Image. */
export function googleCover(isbn: string): string {
  return isbn
    ? `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=1`
    : "";
}

/** Normalize a title/query the way series.name_norm is stored: strip spaces
 *  (ASCII + full-width) and lowercase. Mirrors scripts/ingest.mjs normTitle so
 *  stored *_norm columns and runtime queries align. */
export function normTitle(s: string): string {
  return s.replace(/[\s　]+/g, "").toLowerCase();
}

/** Escape LIKE wildcards so a value containing % or _ matches literally (ESCAPE '\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

/** A title's "base": the head before MADB's alt-title / subtitle separators
 *  (= ： : ／ ∥), with trailing punctuation dropped, then normalized. MADB registers
 *  the same work under several schema:name strings — an English alias after "=", a
 *  descriptive subtitle after ":", or none at all — e.g.
 *    「Dジェネシス = D GENESIS : ダンジョンが出来て3年」「Dジェネシス」「Dジェネシス : …．」
 *  all share base "dジェネシス". Grouping on the base re-unites these variants into one
 *  series card. The cut is ONLY at a separator, so a genuinely distinct work like
 *  「Dジェネシス外伝」(no separator) keeps its own base and never merges. Because the
 *  head is a prefix of the full name, baseTitle(name) is always a prefix of name_norm,
 *  letting callers pre-filter with `name_norm LIKE base || '%'` (index-backed) before
 *  re-checking equality in JS. */
export function baseTitle(s: string): string {
  const head = s.split(/[=:：／∥]/)[0].replace(/[\s　.．。・･、,]+$/u, "");
  return normTitle(head);
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

export function notFound(message = "Not Found"): Response {
  return json({ error: message }, 404);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function randomSlug(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const MAX_CUSTOM_SLUG = 15;
const CUSTOM_SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/** ユーザ指定 slug を検証・正規化する。使えるのは英数字・ハイフン・アンダースコアのみ、
 *  1〜15文字。ランダム slug (10文字) と衝突しにくいよう文字種は同系統に揃える。
 *  不正なら null を返す。 */
export function normalizeCustomSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim();
  if (slug.length < 1 || slug.length > MAX_CUSTOM_SLUG) return null;
  if (!CUSTOM_SLUG_RE.test(slug)) return null;
  return slug;
}

export function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Escape text for safe insertion into HTML (element text or double-quoted attributes). */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
