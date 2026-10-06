import { commerceEnabled, excludeAdult } from "./site";
import { Env } from "./types";
import { pacedFetchJson, PROBE_TIMEOUT_MS, type Priority } from "./ratelimiter";
import { isValidIsbn } from "./util";

// Yahoo!ショッピング 商品検索API V3. A book's ISBN-13 is a JAN code (Bookland EAN,
// 978/979 prefix), so `jan_code` is an exact-ISBN lookup — the direct-match that
// makes Yahoo a reliable Tier 2 cover source behind Rakuten (no sales gate, free
// Client ID). Measured on the oldest/絶版 volumes (the ones Rakuten drops): ~68%
// return a real 600px cover. See scripts/yahoo-probe.mjs.
const V3 = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch";

// Yahoo item images are served at https://item-shopping.c.yimg.jp/i/<size>/<id>.
// The API only hands back /i/g/ (146px, ~7KB) as `image.medium`, but a /i/l/
// (600px, ~20-28KB) variant exists for the same id — the actual usable cover.
// Rewrite to it; non-yimg seller CDNs (rare) are left as-is.
function bestImage(h: any): string {
  const url: string = h?.exImage?.url || h?.image?.medium || h?.image?.small || "";
  return url.replace(/(\/\/item-shopping\.c\.yimg\.jp\/i\/)[a-z]\//, "$1l/");
}

// The /i/l/ cover is ~20-28KB; the small /i/g/ thumbnail is ~7KB. Reject anything
// below this so a book whose seller only uploaded a tiny image isn't taken as a
// real cover (matches the covers.ts Google threshold).
const COVER_MIN_BYTES = 12000;

// Marketplace listings can include adult floors; a manga ISBN won't collide with
// an adult JAN, but guard the name/genre anyway so nothing NSFW slips into covers.
const ADULT = /アダルト|成人|18禁|FANZA|官能|ボーイズラブ用品/; // R18版では判定しない（excludeAdult, src/site.ts）

/** True when the Yahoo Client ID is configured; callers skip Yahoo otherwise. */
export function yahooReady(env: Env): boolean {
  // R18版は外部ストアの API を一切使わない（src/site.ts commerce）。鍵が入っていても呼ばない。
  if (!commerceEnabled(env)) return false;
  return Boolean(env.YAHOO_APP_ID);
}

// Yahoo paces on its own "yahoo" instance of the RakutenRateLimiter DO (a generic 1 req/s
// spacer; the binding name is historical) so Yahoo and Rakuten don't share a lane.

async function call(env: Env, isbn: string, priority: Priority, maxWaitMs?: number): Promise<any | null> {
  const qs = new URLSearchParams({ appid: env.YAHOO_APP_ID!, jan_code: isbn, results: "5" });
  const url = `${V3}?${qs.toString()}`;
  // Slot, timeout and the 429 retry (re-paced on the "yahoo" lane) live in pacedFetchJson.
  return pacedFetchJson(env, "yahoo", priority, url, {}, maxWaitMs, 1500);
}

/** Byte-check the (possibly placeholder) image. False only when definitively tiny;
 *  a network error / missing length returns true so a real cover is never dropped. */
async function isRealCover(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    // GET, not HEAD: when the CDN omits Content-Length we measure the body instead.
    // When the header is there, cancel the body so the connection isn't left draining.
    const res = await fetch(url, {
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
    return true;
  }
}

/** Resolve a Yahoo cover for an exact ISBN (via jan_code).
 *   - string URL: a real 600px cover.
 *   - "" : Yahoo responded but has no listing / no real cover — determinate.
 *   - null: the lookup was not made (rate-limit budget exhausted / HTTP error).
 *     Never cache null as "no cover".
 *  `priority` picks the rate-limit lane; `maxWaitMs` caps the slot wait. */
export async function yahooResolveCover(
  env: Env,
  isbn: string,
  priority: Priority = "low",
  maxWaitMs?: number,
): Promise<string | null> {
  if (!yahooReady(env) || !isbn) return "";
  if (!isValidIsbn(isbn)) return ""; // can't be a JAN — skip the call
  const data = await call(env, isbn, priority, maxWaitMs);
  if (data === null) return null; // undetermined
  const hits: any[] = data?.hits ?? [];
  const exclude = excludeAdult(env);
  for (const h of hits) {
    if (exclude && ADULT.test(`${h?.genreCategory?.name ?? ""} ${h?.name ?? ""}`)) continue;
    const img = bestImage(h);
    if (img && (await isRealCover(img))) return img;
  }
  return ""; // determinate: no usable cover on Yahoo
}

export interface YahooListing {
  name: string; // 出品の商品名（「このこここのこ(1) REX C/藤こよみ(著者)」）
  cover_url: string; // 600px の書影（無ければ ""）
}

/** ISBN（＝ JAN）の出品そのもの。管理画面「マスタ行の修正」の下書き材料用。
 *
 *  openBD にも楽天ブックスにも無い絶版巻は、中古書店の出品名だけが書名の在りかになる
 *  （memory の調査どおり）。出品名は出品者の自由入力なので構造化された書誌としては使えず、
 *  管理者が目で見て書名を起こすための材料として**そのまま**返す。セット売りは代表 1 冊の
 *  JAN が付くだけで中身が分からないので落とす（yahooNameIsVolume と同じ SET_ITEM）。
 *  null = 引けなかった（枠が取れない / HTTP エラー）。*/
export async function yahooListingByIsbn(
  env: Env,
  isbn: string,
  priority: Priority = "high",
): Promise<YahooListing | null> {
  if (!yahooReady(env) || !isValidIsbn(isbn)) return null;
  const data = await call(env, isbn, priority);
  if (data === null) return null;
  const exclude = excludeAdult(env);
  for (const h of (data?.hits ?? []) as any[]) {
    const name = String(h?.name ?? "");
    if (!name || SET_ITEM.test(name.normalize("NFKC"))) continue;
    if (exclude && ADULT.test(`${h?.genreCategory?.name ?? ""} ${name}`)) continue;
    return { name, cover_url: bestImage(h) };
  }
  return null;
}

/** Yahoo cover for the correction picker (high-priority lane), "" when none. */
export function probeYahooCover(env: Env, isbn: string): Promise<string> {
  if (!yahooReady(env) || !isbn) return Promise.resolve("");
  return yahooResolveCover(env, isbn, "high").then((c) => c ?? "");
}

// ── シリーズの穴埋め用の検索（src/gapFill.ts）────────────────────────────────
// 楽天ブックスは新刊書店の在庫なので、絶版の古い巻は扱いが無い（『釣りキチ三平』講談社
// コミックス版は 45 巻以降しか出てこない）。Yahoo!ショッピングは中古書店（ネットオフ・
// ブックオフ等）が出品していて、その出品が JAN ＝ ISBN-13 を持っているため、書名＋巻数の
// フリーテキスト検索が「楽天に無い巻の ISBN」を引く唯一の経路になる。実測で『釣りキチ三平』
// の MADB に ISBN が無い 42 巻のうち 16 巻がこれで取れ、取れた 16 件はすべて国会図書館
// サーチの講談社コミックス通し番号と一致した（誤りゼロ）。

const BOOK_GENRE = "10002"; // 本、雑誌、コミック。フィギュア・DVD・グッズを落とす。
// 1 巻 1 リクエストなので、取りこぼしても次の押下に回せばよい。枠が取れなくなったら
// 呼び手（src/gapFill.ts）が打ち切る。
const SEARCH_RESULTS = "20";

// 全巻セット・まとめ売りの出品。代表 1 冊の JAN が付くので、巻の同定には使えない。
const SET_ITEM = /セット|全巻|まとめ|\d+\s*[〜~～\-－]\s*\d+\s*巻/;

async function searchCall(env: Env, query: string, priority: Priority): Promise<any | null> {
  const qs = new URLSearchParams({
    appid: env.YAHOO_APP_ID!,
    query,
    results: SEARCH_RESULTS,
    genre_category_id: BOOK_GENRE,
  });
  return pacedFetchJson(env, "yahoo", priority, `${V3}?${qs.toString()}`, {}, undefined, 1500);
}

/** 出品者が書いた商品名が「このシリーズのこの巻」を名乗っているか。
 *
 *  Yahoo の検索は緩く、「釣りキチ三平 26」で『生誕50周年特別版』や文庫版の別編まで返る。
 *  通すのは「シリーズ名の直後の最初のトークンが目当ての巻数で、その後ろが区切りで終わる」
 *  ものだけ。これで別版・別編（「釣りキチ三平 平成版 2」「釣りキチ三平（3）−おもしろ釣り編
 *  − 1」「釣りキチ三平（スペシャル版）（14）」）は巻数の手前か後ろに余計な語が付くので落ちる。
 *  同じ巻番号を持つ別版（KCスペシャル版）はこの判定では落ちないが、master が既に持つ ISBN を
 *  外す規則（src/gapFill.ts の alreadyTaken）と ISBN 接頭辞の順位付けで分かれる。 */
export function yahooNameIsVolume(name: string, title: string, volume: number): boolean {
  // NFKC で全角括弧・全角数字・「／」を半角に寄せてから見る（出品者ごとに表記が揺れる）。
  const s = (name ?? "").normalize("NFKC");
  if (SET_ITEM.test(s)) return false;
  const t = (title ?? "").normalize("NFKC");
  if (!t) return false;
  const at = s.indexOf(t);
  if (at < 0) return false;
  const rest = s.slice(at + t.length);
  const m = /^\s*[(【]?(\d{1,4})[)】]?/.exec(rest);
  if (!m || Number(m[1]) !== volume) return false;
  // 巻数の後ろに残ってよいのは区切りだけ。「−おもしろ釣り編−」のような版の説明が続いたら、
  // それは同じ巻数を持つ別物。
  return /^\s*([/|,、。]|$)/.test(rest.slice(m[0].length));
}

/** 書名＋巻数で Yahoo を引き、その巻を名乗る出品の ISBN-13 を返す（重複なし）。
 *  null = 呼び出さなかった（枠が取れない / HTTP エラー）。[] = 引いたが該当なし。 */
export async function yahooVolumeIsbns(
  env: Env,
  title: string,
  volume: number,
  priority: Priority = "high",
): Promise<string[] | null> {
  if (!yahooReady(env) || !title) return [];
  const data = await searchCall(env, `${title} ${volume}`, priority);
  if (data === null) return null;
  const exclude = excludeAdult(env);
  const out: string[] = [];
  for (const h of (data?.hits ?? []) as any[]) {
    if (exclude && ADULT.test(`${h?.genreCategory?.name ?? ""} ${h?.name ?? ""}`)) continue;
    const isbn = String(h?.janCode ?? "");
    if (!/^978\d{10}$/.test(isbn) || !isValidIsbn(isbn)) continue;
    if (!yahooNameIsVolume(String(h?.name ?? ""), title, volume)) continue;
    if (!out.includes(isbn)) out.push(isbn);
  }
  return out;
}
