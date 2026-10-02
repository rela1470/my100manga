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

/** D1/SQLite caps LIKE/GLOB pattern length at 50 bytes
 *  (SQLITE_LIMIT_LIKE_PATTERN_LENGTH); anything longer throws "LIKE or GLOB
 *  pattern too complex". Leave a few bytes of slack for surrounding wildcards. */
export const LIKE_MAX_BYTES = 48;

const UTF8 = new TextEncoder();

/** Longest prefix of `s`, escaped for LIKE (ESCAPE '\'), whose encoded form stays
 *  within `maxBytes` — never splitting a character or a `\x` escape pair. Lets a
 *  long query or title be used as a LIKE pattern without tripping D1's length cap;
 *  callers needing exactness re-check the (possibly shortened) match in JS. */
export function escapeLikeClamped(s: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const esc = escapeLike(ch);
    const n = UTF8.encode(esc).length;
    if (bytes + n > maxBytes) break;
    out += esc;
    bytes += n;
  }
  return out;
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

/** Parse a JSON request body as a plain object for optional-field handlers. Anything
 *  else — unparseable text, or valid JSON that isn't an object such as `null` / `[]` /
 *  `"x"` — yields {} so reading `body.foo` can't throw (a `null` body used to 500). */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
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

// Plain volume labels we know how to read and rewrite. Arc / edition labels like
// "6 (アラバスタ編)" or "2020年版" deliberately don't match and are left untouched.
const VOLUME_LABEL_TEMPLATES = ["{n}", "巻{n}", "第{n}巻", "{n}巻"];

/** The volume number in a plain volume label, or null for anything else. Accepts
 *  "12" / "巻12" / "第12巻" / "12巻" and MADB's doubled form "170　／　第170巻"
 *  (only when both numbers agree). */
export function plainVolumeNumber(label: string): number | null {
  const s = (label ?? "").trim();
  const m =
    /^(\d+)$/.exec(s) || /^巻(\d+)$/.exec(s) || /^第(\d+)巻$/.exec(s) || /^(\d+)巻$/.exec(s);
  if (m) return parseInt(m[1], 10);
  const d = /^(\d+)[\s　]*[／/][\s　]*第(\d+)巻$/.exec(s);
  if (d && d[1] === d[2]) return parseInt(d[1], 10);
  return null;
}

/** The series' dominant plain volume-label template, e.g. "第{n}巻" for こち亀 (mostly
 *  「第2巻」, with stray "9" / "170　／　第170巻") or "巻{n}" for ONE PIECE. null when
 *  no plain label is present. */
export function volumeLabelTemplate(labels: string[]): string | null {
  const counts = new Map<string, number>();
  for (const l of labels) {
    const s = (l ?? "").trim();
    if (!/^\D*\d+\D*$/.test(s)) continue;
    const t = s.replace(/\d+/, "{n}");
    if (!VOLUME_LABEL_TEMPLATES.includes(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [t, n] of counts) if (n > bestN) ((best = t), (bestN = n));
  return best;
}

/** Render volume `n` in a template from volumeLabelTemplate ("第{n}巻" + 1 → "第1巻"). */
export function formatVolumeLabel(template: string | null, n: number, fallback: string): string {
  return template && n > 0 ? template.replace("{n}", String(n)) : fallback;
}

/** Rewrite a plain volume label into the series template ("9" → "第9巻"); any other
 *  label (arc names, 総集編, …) is returned unchanged. */
export function unifyVolumeLabel(template: string | null, label: string): string {
  const n = plainVolumeNumber(label);
  return n === null ? label : formatVolumeLabel(template, n, label);
}

/** Normalize an ISBN-10/13 (hyphens allowed) to ISBN-13, mirroring scripts/ingest.mjs
 *  isbn13 so list items saved with an ISBN-10 ("4088725093") match master rows. "" if
 *  it isn't an ISBN. */
export function toIsbn13(raw: string): string {
  const s = String(raw ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) return s;
  if (/^\d{9}[\dX]$/.test(s)) {
    const core = "978" + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(core[i]);
    return core + ((10 - (sum % 10)) % 10);
  }
  return "";
}
