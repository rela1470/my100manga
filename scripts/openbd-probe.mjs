#!/usr/bin/env node
// openBD synopsis-source probe (throwaway measurement tool, not wired into the
// Worker). Measures how many ISBNs openBD can give an あらすじ (内容紹介) for, to
// decide whether openBD is worth adding as a Tier 2 synopsis fallback behind
// Rakuten's itemCaption. See memory: cover-source-dmm-todo (sibling probe:
// scripts/yahoo-probe.mjs for covers).
//
// openBD aggregates 版元ドットコム + JPRO, i.e. publisher-submitted 内容紹介. It's
// free, keyless, and takes a comma-separated batch of ISBNs in one GET — none of
// Rakuten's 1 req/s cap or Google's daily quota.
//
// あらすじ lives in onix.CollateralDetail.TextContent[], keyed by ONIX TextType:
//   "03" = 内容紹介/説明 (what we want), "02" = 短い紹介, "04" = 目次. We take 03,
//   then 02, as the synopsis.
//
// Usage:
//   node scripts/openbd-probe.mjs                      # default sample
//   node scripts/openbd-probe.mjs 9784088598406 ...    # explicit ISBNs
//   node scripts/openbd-probe.mjs --from-d1 60         # 60 ISBNs Rakuten gave NO あらすじ (the rescue set)
//   node scripts/openbd-probe.mjs --from-volumes-old 60  # 60 oldest MADB volumes (hard/絶版 population)
//
// --from-d1 <n>   pull n ISBNs whose book_meta.caption='' from the LOCAL D1, i.e.
//                 exactly the volumes openBD would need to rescue. The headline
//                 number is openBD's fill rate over THIS set (incremental lift).
//
// Prints per-ISBN: HIT/miss, char length, TextType, title, snippet. Then a
// summary: how many of the (Rakuten-empty) ISBNs openBD filled.

import { execFileSync } from "node:child_process";

const API = "https://api.openbd.jp/v1/get";
// openBD accepts a big batch per request; keep chunks modest to bound URL length.
const CHUNK = 80;

const DEFAULT_SAMPLE = [
  "9784088598406", // ONE PIECE 1 (current, should hit)
  "9784870252455", // ハレのちグゥ 1 (1998, 絶版) — the canonical hard miss
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

// ISBNs Rakuten gave no あらすじ for (book_meta.caption='') — the real rescue set.
function isbnsFromD1(n) {
  return d1Query(`SELECT isbn FROM book_meta WHERE caption='' LIMIT ${n};`)
    .map((r) => String(r.isbn))
    .filter(Boolean);
}

// Oldest volumes from the MADB master — proxy for the hard (絶版) population where
// publisher metadata is thinnest.
function isbnsFromVolumesOld(n) {
  return d1Query(
    `SELECT isbn FROM volumes WHERE pubdate != '' AND pubdate IS NOT NULL ORDER BY pubdate ASC LIMIT ${n};`
  )
    .map((r) => String(r.isbn))
    .filter(Boolean);
}

/** Pull the synopsis out of an openBD record: ONIX TextType 03 (内容紹介), else 02. */
function synopsis(rec) {
  const tc = rec?.onix?.CollateralDetail?.TextContent ?? [];
  const pick = (type) => tc.find((t) => t?.TextType === type)?.Text || "";
  const text = pick("03") || pick("02");
  const type = pick("03") ? "03" : pick("02") ? "02" : "";
  // openBD sometimes stashes a blurb in summary too (rare), as a last resort.
  return { text: text.trim(), type };
}

function title(rec) {
  return rec?.summary?.title || rec?.onix?.DescriptiveDetail?.TitleDetail?.TitleElement?.TitleText?.content || "";
}

async function fetchBatch(isbns) {
  const url = `${API}?isbn=${isbns.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json(); // array aligned to isbns order; null for unknown ISBN
}

const args = parseArgs(process.argv.slice(2));
let isbns = args.isbns;
if (!isbns.length && args.fromD1) isbns = isbnsFromD1(args.fromD1);
if (!isbns.length && args.fromVolumesOld) isbns = isbnsFromVolumesOld(args.fromVolumesOld);
if (!isbns.length) isbns = DEFAULT_SAMPLE;

console.log(`Probing ${isbns.length} ISBN(s) against openBD (TextType 03/02)\n`);

let known = 0; // ISBN present in openBD at all
let filled = 0; // ISBN with a non-empty synopsis
for (let i = 0; i < isbns.length; i += CHUNK) {
  const chunk = isbns.slice(i, i + CHUNK);
  let recs;
  try {
    recs = await fetchBatch(chunk);
  } catch (e) {
    console.log(`  [batch ${i}-${i + chunk.length}] ERROR ${e.message}`);
    continue;
  }
  recs.forEach((rec, j) => {
    const isbn = chunk[j];
    if (!rec) {
      console.log(`${isbn}  unknown (not in openBD)`);
      return;
    }
    known++;
    const { text, type } = synopsis(rec);
    if (!text) {
      console.log(`${isbn}  miss (in openBD, no 内容紹介)   ${title(rec).slice(0, 40)}`);
      return;
    }
    filled++;
    const snippet = text.replace(/\s+/g, " ").slice(0, 70);
    console.log(
      `${isbn}  HIT  ${String(text.length).padStart(5)}字  type=${type}  ${title(rec).slice(0, 36)}\n` +
        `            ${snippet}…`
    );
  });
}

const n = isbns.length;
console.log(
  `\nSummary: ${filled}/${n} with あらすじ (${((filled / n) * 100).toFixed(0)}%), ` +
    `${known}/${n} known to openBD (${((known / n) * 100).toFixed(0)}%)`
);
