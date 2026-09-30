/** Google Books cover thumbnail (works by ISBN without an API key). When a cover
 *  is unavailable Google returns a ~10.8KB gray "no image" placeholder image;
 *  covers.ts probes for that so callers can fall back to our own No Image. */
export function googleCover(isbn: string): string {
  return isbn
    ? `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=1`
    : "";
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
