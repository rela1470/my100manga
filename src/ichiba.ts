import { Env } from "./types";
import type { Priority } from "./ratelimiter";
import { awaitSlot, headers, rakutenReady } from "./rakuten";

// 楽天市場 商品検索API — Tier 3 cover source behind 楽天ブックス and Yahoo!ショッピング.
// Mainly rescues ムック / 絶版 volumes no new-book store lists anymore, via used-book
// shops (もったいない本舗, ブックオフ) and the odd new-book shop. There's no JAN
// parameter, but those shops put the ISBN in the item text, so `keyword=<ISBN-13>`
// is a near-exact lookup. Most images are shop-made (logo frames, wrong edition,
// ...), so only the used-book shops' scans (ブックオフ / 駿河屋 / もったいない本舗,
// whose frame /cover crops off) apply unreviewed — see isTrustedCoverUrl.
// Same applicationId (and gateway) as 楽天ブックス, so it shares the Rakuten limiter.
const ICHIBA_SEARCH = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

// Shop preference, best first. Unlisted shops (bookfan, booxstore, Kobo, ...) mostly
// carry the publisher's clean cover image. ブックオフ / 駿河屋 are clean but only
// ~150px wide at source. もったいない本舗 (three storefronts sharing one image cabinet) is 700px but
// framed with its logo band and mascot.
const SHOP_RANK: Record<string, number> = {
  bookoffonline: 1,
  "surugaya-a-too": 1, // 駿河屋: clean scans, ~137×192 at source
  comicset: 2,
  mottainaihonpo: 2,
  "mottainaihonpo-omatome": 2,
};

// Set listings photograph a stack of volumes, not the one cover we want.
const SET_ITEM = /全巻|セット|まとめ売り|\d+\s*[〜~～\-－]\s*\d+\s*巻/;
const ADULT = /アダルト|成人|18禁|官能/;

// The thumbnail service caps at the source size, so asking for 600px is safe for
// both the 700px もったいない images and the 150px ブックオフ ones.
function upsize(url: string): string {
  return url.replace(/_ex=\d+x\d+/, "_ex=600x600");
}

// Below this it's a broken/placeholder image (ブックオフ's 150×223 covers are ~10KB).
const COVER_MIN_BYTES = 4000;

// Shop "no image" placeholders by filename: noimage_01.gif, ブックオフ's r_noimg.gif
// (5.5KB once upsized — past COVER_MIN_BYTES, so the byte check alone misses it).
const NO_IMAGE_RE = /no[_-]?im(?:age|g)/i;

async function isRealCover(url: string): Promise<boolean> {
  if (!url || NO_IMAGE_RE.test(url)) return false;
  try {
    const res = await fetch(url, { method: "HEAD", cf: { cacheEverything: true, cacheTtl: 86400 } });
    if (!res.ok) return false;
    const len = Number(res.headers.get("content-length") ?? "0");
    return len <= 0 || len >= COVER_MIN_BYTES;
  } catch {
    return true;
  }
}

/** ISBN-13 (978-) → ISBN-10, "" when not convertible. Item text often carries only
 *  the 10-digit form (もったいない本舗 uses it as its item URL). */
function isbn10(isbn13: string): string {
  if (!/^978\d{10}$/.test(isbn13)) return "";
  const body = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
  const c = (11 - (sum % 11)) % 11;
  return body + (c === 10 ? "X" : String(c));
}

export interface IchibaCover {
  url: string;
  shop: string; // shopName, e.g. "もったいない本舗　楽天市場店"
  title: string; // itemName
}

/** 楽天市場 covers for an exact ISBN, best shop first (deduped by image file —
 *  もったいない本舗's storefronts share images).
 *   - array (possibly empty): 楽天市場 responded; [] = no usable cover — determinate.
 *   - null: the lookup was not made (rate-limit budget exhausted / HTTP error).
 *     Never cache null as "no cover".
 *  `priority` picks the rate-limit lane; `maxWaitMs` caps the slot wait. */
export async function ichibaCovers(
  env: Env,
  isbn: string,
  priority: Priority = "low",
  maxWaitMs?: number,
  limit = 6,
): Promise<IchibaCover[] | null> {
  if (!rakutenReady(env) || !/^97[89]\d{10}$/.test(isbn)) return [];
  const qs = new URLSearchParams({
    format: "json",
    formatVersion: "2",
    applicationId: env.RAKUTEN_APP_ID!,
    accessKey: env.RAKUTEN_ACCESS_KEY!,
    keyword: isbn,
    hits: "30",
    imageFlag: "1",
    availability: "0", // include sold-out listings — we only want the image
  });
  if (!(await awaitSlot(env, priority, maxWaitMs))) return null;
  let data: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${ICHIBA_SEARCH}?${qs.toString()}`, { headers: headers(env) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    if (!res.ok) return null;
    data = await res.json().catch(() => null);
    break;
  }
  if (!data) return null;

  // keyword matches anywhere in the item text, so an item that merely mentions the
  // ISBN in passing can come back too — require it in the name or caption.
  const i10 = isbn10(isbn);
  const items: any[] = data?.Items ?? [];
  const picked: (IchibaCover & { rank: number })[] = [];
  const seenFile = new Set<string>();
  for (const it of items) {
    const name = String(it?.itemName ?? "");
    const text = `${name} ${it?.itemCaption ?? ""}`;
    if (!text.includes(isbn) && !(i10 && text.includes(i10))) continue;
    if (SET_ITEM.test(name) || ADULT.test(name)) continue;
    const raw = String(it?.mediumImageUrls?.[0] ?? "");
    if (!raw) continue;
    const file = raw.replace(/\?.*$/, "").split("/").pop() ?? raw;
    if (seenFile.has(file)) continue;
    seenFile.add(file);
    picked.push({
      url: upsize(raw),
      shop: String(it?.shopName ?? it?.shopCode ?? ""),
      title: name,
      rank: SHOP_RANK[String(it?.shopCode ?? "")] ?? 0,
    });
  }
  picked.sort((a, b) => a.rank - b.rank); // stable: keeps 楽天's relevance order within a rank
  const top = picked.slice(0, limit);
  const real = await Promise.all(top.map((c) => isRealCover(c.url)));
  return top.filter((_, i) => real[i]).map(({ url, shop, title }) => ({ url, shop, title }));
}
