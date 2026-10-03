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

/** 検索専用のキー（series.name_search / volumes.title_search）。normTitle に加えて全角半角を
 *  寄せ（NFKC）、記号・句読点を落とす（「ぼっち・ざ・ろっく！」↔「ぼっちざろっく」、「あさドラ！」↔
 *  「あさドラ!」）。長音「ー」は文字扱いで残る（ワールドトリガー）。記号の違いだけの別作品
 *  （「もやしもん」「もやしもん+」）も同じキーになるので、検索の照合にだけ使い、シリーズへの寄せや
 *  まとまりの判定（normTitle の一致）には使わない。scripts/ingest.mjs の searchKey と揃える。 */
export function searchKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** ひらがなをカタカナに寄せる（ぁ-ゖ → ァ-ヶ、ゝゞ → ヽヾ）。series.name_kana_norm（MADB の読み）は
 *  カタカナなので、ひらがなの検索語「ひだまりすけっち」を読み「ヒダマリスケッチ」に当てるのに使う。 */
export function hiraToKata(s: string): string {
  return s.replace(/[\u3041-\u3096\u309d\u309e]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/** ヴ行をバ行に寄せる（ヴァ→バ、ヴィ→ビ、ヴェ→ベ、ヴォ→ボ、ヴ→ブ）。MADB の読み自体が
 *  「デジャヴ／デジャブ」「ヘヴン／ヘブン」と揺れているので、ingest は寄せた読みも
 *  name_kana_norm に足しておき、検索語も同じく寄せて照合する。scripts/ingest.mjs の vuFold と揃える。 */
export function vuFold(s: string): string {
  return s.replace(/ヴ([ァィェォ])?/g, (_, v?: string) =>
    v ? ({ ァ: "バ", ィ: "ビ", ェ: "ベ", ォ: "ボ" } as Record<string, string>)[v] : "ブ"
  );
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
const VOLUME_LABEL_TEMPLATES = ["{n}", "巻{n}", "第{n}巻", "{n}巻", "巻ノ{n}", "巻の{n}", "第{n}集"];

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, ニ: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
// カタカナの「ニ」は MADB の誤記（NARUTO「巻ノ六十ニ」）。語頭では拾わない（「ニンジャ」等）。
const KANJI_NUM_RE = /[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*/g;

function kanjiToNumber(s: string): number {
  // 位取りの無い並び（「一〇五」）はそのまま桁として読む。
  if (!/[十百千]/.test(s)) return parseInt([...s].map((c) => KANJI_DIGITS[c]).join(""), 10);
  let total = 0;
  let digit = 0;
  for (const c of s) {
    if (c in KANJI_UNITS) {
      total += (digit || 1) * KANJI_UNITS[c];
      digit = 0;
    } else digit = KANJI_DIGITS[c];
  }
  return total + digit;
}

/** Kanji numerals in a volume label → ASCII digits ("巻ノ二十七" → "巻ノ27", "第一巻" → "第1巻").
 *  MADB mixes them into otherwise numeric series (NARUTO: "巻ノ26" then "巻ノ二十七"). */
export function arabicVolumeLabel(label: string): string {
  return (label ?? "").replace(KANJI_NUM_RE, (m) => String(kanjiToNumber(m)));
}

// 漢数字だけの巻番号ラベル（VOLUME_LABEL_TEMPLATES の形）。副題（「三つの符号編」）は読まない。
const KANJI_VOLUME_RE =
  /^(?:[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*|(?:巻|巻ノ|巻の|第)[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*|第[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*[巻集]|[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*巻)$/;

// 部・編・幕の番号が頭に付き、巻番号が末尾にあるラベル（「24億脱出編4」「第2部[9]」「第2幕 9」）。
// 先頭の数字だけだと全巻が同じ値になるので、部の番号 ×1000 + 巻番号にする（同じまとまりに
// 第1部・第2部が混ざっても部ごとに並ぶ）。巻・集が続く数字（「第1巻　／　1」）や、
// 「8 世紀末ギャンブル黙示録編 5」のように数字の後が空白のものは対象外。
const ARC_VOLUME_RE =
  /^[^／/]*?(\d+)[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}](?<![巻集])[^／/]*?(\d+)\]?$/u;

/** Sort key for a volume label: an arc-prefixed label ("24億脱出編4" → 24004), else the
 *  first run of digits, else a kanji-numeral volume label ("巻ノ二十七" → 27), else 0.
 *  Mirrored in scripts/ingest.mjs. */
export function volSort(label: string): number {
  const s = (label ?? "").trim();
  const arc = ARC_VOLUME_RE.exec(s);
  if (arc) return parseInt(arc[1], 10) * 1000 + parseInt(arc[2], 10);
  const m = s.match(/\d+/);
  if (m) return parseInt(m[0], 10);
  return KANJI_VOLUME_RE.test(s) ? parseInt(arabicVolumeLabel(s).match(/\d+/)![0], 10) : 0;
}

/** The volume number in a plain volume label, or null for anything else. Accepts the
 *  VOLUME_LABEL_TEMPLATES forms ("12" / "巻12" / "第12巻" / "12巻" / "巻ノ12" …, kanji
 *  numerals included), the Latin forms MADB mixes in within one series
 *  (名探偵コナン: "v.15" / "volume 9" / "Volume77" / "VOLUME26") and the doubled form
 *  "170　／　第170巻" / "巻ノ55　／　巻ノ五十五" (only when both numbers agree). */
export function plainVolumeNumber(label: string): number | null {
  const s = arabicVolumeLabel(label).trim();
  const d = /^(\D*)(\d+)(\D*)$/.exec(s);
  if (d && VOLUME_LABEL_TEMPLATES.includes(`${d[1]}{n}${d[3]}`)) return parseInt(d[2], 10);
  const m = /^v(?:ol(?:ume)?)?\.?[\s　]*(\d+)$/i.exec(s);
  if (m) return parseInt(m[1], 10);
  const parts = s.split(/[\s　]*[／/][\s　]*/);
  if (parts.length === 2 && !/[／/]/.test(parts[0] + parts[1])) {
    const a = plainVolumeNumber(parts[0]);
    if (a !== null && a === plainVolumeNumber(parts[1])) return a;
  }
  return null;
}

/** The series' dominant plain volume-label template, e.g. "第{n}巻" for こち亀 (mostly
 *  「第2巻」, with stray "9" / "170　／　第170巻") or "巻{n}" for ONE PIECE. Latin forms
 *  are only a fallback for series with no Japanese label at all (犯沢さん: "VOLUME1"〜,
 *  so a correction's "9" becomes "VOLUME9"); where they're mixed in (名探偵コナン) the
 *  Japanese form still wins. null when no plain label is present. */
export function volumeLabelTemplate(labels: string[]): string | null {
  const counts = new Map<string, number>();
  const latin = new Map<string, number>();
  for (const l of labels) {
    const s = arabicVolumeLabel(l).trim();
    if (!/^\D*\d+\D*$/.test(s)) continue;
    const t = s.replace(/\d+/, "{n}");
    if (VOLUME_LABEL_TEMPLATES.includes(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    else if (/^v(?:ol(?:ume)?)?\.?[\s　]*\{n\}$/i.test(t)) latin.set(t, (latin.get(t) ?? 0) + 1);
  }
  return mostCommon(counts) ?? mostCommon(latin);
}

function mostCommon(counts: Map<string, number>): string | null {
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

/** 接続元 IP。Cloudflare 経由なら cf-connecting-ip、無ければ x-forwarded-for の先頭。 */
export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}
