#!/usr/bin/env node
// Yahoo! Shopping cover-source probe (throwaway measurement tool, not wired into
// the Worker). Measures hit rate + image quality of the Yahoo!ショッピング
// 商品検索API V3 for a set of ISBNs, to decide whether Yahoo is worth adding as a
// Tier 2 cover fallback behind Rakuten. See memory: cover-source-dmm-todo.
//
// Books' ISBN-13 is a JAN code (Bookland EAN, 978/979 prefix), so the API's
// `jan_code` parameter gives an exact-ISBN lookup — the direct-lookup advantage
// Yahoo has over DMM (keyword-only). No sales gate, free app id (Client ID).
//
// Usage:
//   YAHOO_APP_ID=<clientId> node scripts/yahoo-probe.mjs                 # default sample
//   YAHOO_APP_ID=<clientId> node scripts/yahoo-probe.mjs 9784870252455 ...   # explicit ISBNs
//   YAHOO_APP_ID=<clientId> node scripts/yahoo-probe.mjs --from-d1 40    # 40 real misses from local D1
//
// --from-d1 <n>   pull n ISBNs that Rakuten confirmed "no cover" (covers.cover_url='')
//                 from the LOCAL D1, i.e. exactly the volumes Yahoo would need to rescue.
//
// Prints per-ISBN: HIT/miss, image bytes (quality proxy — real covers ≥12KB,
// placeholders are tiny), genre category, seller, product name. Then a summary:
// hit rate, "real cover" rate (≥ MIN_BYTES), adult-flagged count.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const V3 = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch";
// Real book covers we've seen are ≥12KB; smaller = placeholder / thumbnail junk.
const MIN_BYTES = 12000;

// YAHOO_APP_ID from the environment, else from .dev.vars (same file the Worker
// uses for local secrets — gitignored) so there's one place to put the Client ID.
function appIdFromDevVars() {
  try {
    const m = fs.readFileSync(".dev.vars", "utf8").match(/^YAHOO_APP_ID=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}
const APP_ID = process.env.YAHOO_APP_ID || appIdFromDevVars();
if (!APP_ID) {
  console.error(
    "No Client ID. Set YAHOO_APP_ID=<id> inline, or add YAHOO_APP_ID=<id> to .dev.vars, then re-run."
  );
  process.exit(1);
}

const DEFAULT_SAMPLE = [
  "9784870252455", // ジャングルはいつもハレのちグゥ 1 (1998, 絶版) — the canonical miss
  "9784088598406", // ONE PIECE 1 (current, should always hit — sanity check)
  "9784253055000", // old 少年画報社 vol — plausible miss
];

function parseArgs(argv) {
  const out = { fromD1: 0, fromVolumesOld: 0, isbns: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from-d1") out.fromD1 = Number(argv[++i] || "0");
    else if (argv[i] === "--from-volumes-old") out.fromVolumesOld = Number(argv[++i] || "0");
    else out.isbns.push(argv[i].replace(/[^0-9Xx]/g, ""));
  }
  return out;
}

function d1Query(sql) {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const json = JSON.parse(raw);
  return json?.[0]?.results ?? json?.results ?? [];
}

// ISBNs Rakuten confirmed "no cover" (covers.cover_url='') — the real rescue set.
function isbnsFromD1(n) {
  return d1Query(`SELECT isbn FROM covers WHERE cover_url='' LIMIT ${n};`).map((r) => String(r.isbn)).filter(Boolean);
}

// Oldest volumes from the MADB master — proxy for the hard (絶版) population that
// Rakuten tends to drop. Measures Yahoo's raw coverage on old manga.
function isbnsFromVolumesOld(n) {
  return d1Query(
    `SELECT isbn FROM volumes WHERE pubdate != '' AND pubdate IS NOT NULL ORDER BY pubdate ASC LIMIT ${n};`
  ).map((r) => String(r.isbn)).filter(Boolean);
}

// Yahoo item images live at https://item-shopping.c.yimg.jp/i/<size>/<seller>_<code>.
// The API only hands back /i/g/ (146px, ~7KB) as `medium`, but a /i/l/ (600px,
// ~28KB) variant exists for the same code — the actual usable cover. Rewrite to it.
// Non-yimg seller CDNs are left as-is (use exImage/medium/small directly).
function bestImage(h) {
  const url = h?.exImage?.url || h?.image?.medium || h?.image?.small || "";
  return url.replace(/(\/\/item-shopping\.c\.yimg\.jp\/i\/)[a-z]\//, "$1l/");
}

async function imageBytes(url) {
  if (!url) return 0;
  try {
    const res = await fetch(url);
    if (!res.ok) return 0;
    const buf = await res.arrayBuffer();
    return buf.byteLength;
  } catch {
    return -1; // fetch failed
  }
}

async function probe(isbn) {
  const qs = new URLSearchParams({ appid: APP_ID, jan_code: isbn, results: "5" });
  let data;
  try {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`${V3}?${qs}`);
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // back off on rate limit
    }
    if (!res.ok) return { isbn, error: `HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { isbn, error: String(e) };
  }
  const hits = data?.hits ?? [];
  if (!hits.length) return { isbn, hit: false };
  const h = hits[0];
  const imgUrl = bestImage(h);
  const bytes = await imageBytes(imgUrl);
  const genre = h?.genreCategory?.name || "";
  const name = (h?.name || "").slice(0, 60);
  const seller = h?.seller?.name || "";
  const adult = /アダルト|成人|18禁|FANZA/.test(genre + " " + name);
  return { isbn, hit: true, bytes, imgUrl, genre, name, seller, adult, hits: hits.length };
}

const args = parseArgs(process.argv.slice(2));
let isbns = args.isbns;
if (!isbns.length && args.fromD1) isbns = isbnsFromD1(args.fromD1);
if (!isbns.length && args.fromVolumesOld) isbns = isbnsFromVolumesOld(args.fromVolumesOld);
if (!isbns.length) isbns = DEFAULT_SAMPLE;

console.log(`Probing ${isbns.length} ISBN(s) against Yahoo!ショッピング V3 (jan_code)\n`);

let hitCount = 0, realCount = 0, adultCount = 0;
for (const isbn of isbns) {
  const r = await probe(isbn);
  if (r.error) {
    console.log(`${isbn}  ERROR  ${r.error}`);
    continue;
  }
  if (!r.hit) {
    console.log(`${isbn}  miss`);
    continue;
  }
  hitCount++;
  const real = r.bytes >= MIN_BYTES;
  if (real) realCount++;
  if (r.adult) adultCount++;
  const kb = r.bytes < 0 ? "fetch-fail" : `${(r.bytes / 1024).toFixed(1)}KB`;
  console.log(
    `${isbn}  HIT  ${kb.padStart(10)} ${real ? "✓real" : "✗small"}` +
      `${r.adult ? " ⚠ADULT" : ""}  [${r.genre}] ${r.seller}\n` +
      `            ${r.name}\n            ${r.imgUrl}`
  );
  // Be polite to the API (it rate-limits aggressively — ~1 req/s is safe).
  await new Promise((res) => setTimeout(res, 1000));
}

const n = isbns.length;
console.log(
  `\nSummary: ${hitCount}/${n} hit (${((hitCount / n) * 100).toFixed(0)}%), ` +
    `${realCount}/${n} real cover ≥${MIN_BYTES / 1000}KB (${((realCount / n) * 100).toFixed(0)}%), ` +
    `${adultCount} adult-flagged`
);
