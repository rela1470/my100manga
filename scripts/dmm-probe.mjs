#!/usr/bin/env node
// DMM affiliate API cover-source probe (throwaway measurement tool, not wired into
// the Worker). Measures how many volumes the DMM 商品情報API v3 can give a cover
// and an affiliate link for, to decide whether DMM is worth adding next to
// Rakuten / Yahoo / 楽天市場. See memory: cover-source-dmm-todo.
//
// DMM has no ISBN lookup (keyword=<ISBN> returns 0), so each volume is searched
// by title and the result is matched two ways:
//   mono  通販 本・コミック (site=DMM.com service=mono floor=book) returns `isbn`
//         per item → exact ISBN match. Images stop at 140×200 (ps), pl 302s away.
//   ebook DMMブックス コミック (service=ebook floor=comic) has no ISBN. A keyword
//         search returns one item per *series* (its latest volume; `volume` is
//         the page count, `number` the volume number), so: keyword → series id
//         (same name + same author) → article=series listing → `number` match.
//         The edition is not guaranteed. Images are 375×600 (pl); missing ones
//         302 to now_printing.jpeg.
// Only site=DMM.com (一般) is queried, so FANZA (adult) items never come back.
//
// Usage:
//   node scripts/dmm-probe.mjs                       # default sample
//   node scripts/dmm-probe.mjs 9784870252455 ...     # explicit ISBNs (must exist in local D1)
//   node scripts/dmm-probe.mjs --from-volumes-old 60 # oldest 60 volumes (same set as yahoo-probe)
//   node scripts/dmm-probe.mjs --random 60           # random volumes with a pubdate
//   node scripts/dmm-probe.mjs --fanza --random 60   # R18版: site=FANZA, random 成年向け volumes
//                                                    # (mono は FANZA 通販ブックの floor=book)
//   node scripts/dmm-probe.mjs --fanza --from-json adult60.json
//                                                    # volumes as a JSON array of rows (same columns
//                                                    # as COLS) — e.g. a SELECT against the R18 D1,
//                                                    # since the local D1 has no 成年向け volumes
//
// Credentials from the environment or .dev.vars: DMM_API_ID, DMM_API_AFFILIATE_ID
// (the API-only id, must end in 990–999).

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const API = "https://api.dmm.com/affiliate/v3/ItemList";
const MIN_BYTES = 12000;

function fromDevVars(key) {
  try {
    const m = fs.readFileSync(".dev.vars", "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}
const API_ID = process.env.DMM_API_ID || fromDevVars("DMM_API_ID");
const AF_ID = process.env.DMM_API_AFFILIATE_ID || fromDevVars("DMM_API_AFFILIATE_ID");
if (!API_ID || !AF_ID) {
  console.error("No credentials. Put DMM_API_ID / DMM_API_AFFILIATE_ID in .dev.vars, then re-run.");
  process.exit(1);
}

const DEFAULT_SAMPLE = [
  "9784870252455", // ジャングルはいつもハレのちグゥ 1 (1998, 絶版) — the canonical miss
  "9784088598406", // ONE PIECE 1 — sanity check
  "9784091083500", // 名探偵コナン 平成のホームズ — mook, Rakuten/Yahoo both 0
];

function parseArgs(argv) {
  const out = { old: 0, random: 0, fanza: false, json: "", isbns: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from-volumes-old") out.old = Number(argv[++i] || "0");
    else if (argv[i] === "--random") out.random = Number(argv[++i] || "0");
    else if (argv[i] === "--fanza") out.fanza = true;
    else if (argv[i] === "--from-json") out.json = argv[++i] || "";
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

const COLS =
  "v.isbn, v.title, v.volume_number, v.pubdate, v.creators_norm, COALESCE(s.name, v.title) AS series";
const FROM = "volumes v LEFT JOIN series s ON s.id = v.series_id";
function volumes(args) {
  if (args.json) return JSON.parse(fs.readFileSync(args.json, "utf8"));
  if (args.isbns.length) {
    const list = args.isbns.map((i) => `'${i}'`).join(",");
    return d1Query(`SELECT ${COLS} FROM ${FROM} WHERE v.isbn IN (${list});`);
  }
  if (args.old) {
    return d1Query(
      `SELECT ${COLS} FROM ${FROM} WHERE v.pubdate != '' AND v.pubdate IS NOT NULL ORDER BY v.pubdate ASC LIMIT ${args.old};`
    );
  }
  if (args.random) {
    return d1Query(
      `SELECT ${COLS} FROM ${FROM} WHERE v.is_adult = ${args.fanza ? 1 : 0} AND v.pubdate != '' ORDER BY random() LIMIT ${args.random};`
    );
  }
  return volumes({ isbns: DEFAULT_SAMPLE });
}

const norm = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・:：!！?？、。,.\-－ー〜~()（）「」『』【】\[\]]/g, "");

async function search(service, floor, params) {
  const qs = new URLSearchParams({
    api_id: API_ID,
    affiliate_id: AF_ID,
    site: SITE,
    service,
    floor,
    hits: "100",
    output: "json",
    ...params,
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}?${qs}`);
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { items: data?.result?.items ?? [], total: Number(data?.result?.total_count || 0) };
  }
  throw new Error("retries exhausted");
}

async function imageBytes(url) {
  if (!url) return 0;
  try {
    const res = await fetch(url, { redirect: "manual" });
    if (!res.ok) return 0;
    return (await res.arrayBuffer()).byteLength;
  } catch {
    return -1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(v) {
  // Series name only: adding the volume number makes DMM's AND match return 0
  // ("…グゥ 1" → 0, "…グゥ" → 6), and the ISBN filter picks the volume anyway.
  const keyword = v.series;
  const out = { ...v, keyword };

  // 1) mono/book — exact ISBN match against the returned `isbn`.
  try {
    const { items } = await search("mono", "book", { keyword });
    const hit = items.find((it) => String(it.isbn || "") === v.isbn);
    if (hit) {
      const img = hit.imageURL?.large || hit.imageURL?.small || hit.imageURL?.list || "";
      out.mono = { title: hit.title, img, bytes: await imageBytes(img), stock: hit.stock, url: hit.affiliateURL };
    }
    out.monoCount = items.length;
  } catch (e) {
    out.monoErr = String(e);
  }
  await sleep(1000);

  // 2) ebook/comic — keyword search returns one item per series (its latest
  // volume). Pick the series whose name matches exactly and shares an author,
  // then list that series (article=series) and take the item whose `number`
  // equals our volume number.
  try {
    const { items } = await search("ebook", "comic", { keyword });
    out.ebookCount = items.length;
    const want = norm(v.series);
    const authors = String(v.creators_norm || "").split("|").map(norm).filter(Boolean);
    const sameAuthor = (it) =>
      !authors.length || (it.iteminfo?.author ?? []).some((a) => authors.includes(norm(a.name)));
    const series = items.find((it) => norm(it.iteminfo?.series?.[0]?.name || it.title) === want && sameAuthor(it));
    if (!series) {
      out.ebookWhy = items.length ? "no series with same name+author" : "0 results";
    } else {
      out.ebookSeries = series.iteminfo?.series?.[0]?.name;
      const vol = String(v.volume_number || "").normalize("NFKC").replace(/\D/g, "") || "1";
      const sid = String(series.iteminfo.series[0].id);
      let hit = null;
      for (let offset = 1; !hit; offset += 100) {
        await sleep(1000);
        const page = await search("ebook", "comic", { article: "series", article_id: sid, offset: String(offset) });
        hit = page.items.find((it) => String(it.number || "") === vol);
        if (offset + 100 > page.total) break;
      }
      if (hit) {
        const img = hit.imageURL?.large || hit.imageURL?.small || "";
        out.ebook = { title: `${hit.title} #${hit.number}`, img, bytes: await imageBytes(img), url: hit.affiliateURL };
      } else {
        out.ebookWhy = `series「${out.ebookSeries}」has no #${vol}`;
      }
    }
  } catch (e) {
    out.ebookErr = String(e);
  }
  await sleep(1000);
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SITE = args.fanza ? "FANZA" : "DMM.com";
const vols = volumes(args);
console.log(`Probing ${vols.length} volume(s) against ${SITE} ItemList (mono/book + ebook/comic)\n`);

let monoHit = 0, monoReal = 0, ebookHit = 0, ebookReal = 0, either = 0, errors = 0;
const kb = (b) => (b < 0 ? "fetch-fail" : `${(b / 1024).toFixed(1)}KB`);
for (const v of vols) {
  const r = await probe(v);
  if (r.monoErr || r.ebookErr) errors++;
  const m = r.mono, e = r.ebook;
  if (m) { monoHit++; if (m.bytes >= MIN_BYTES) monoReal++; }
  if (e) { ebookHit++; if (e.bytes >= MIN_BYTES) ebookReal++; }
  if (m || e) either++;
  console.log(`${r.isbn}  ${r.pubdate || "-"}  「${r.keyword}」`);
  console.log(
    `    mono : ${m ? `HIT ${kb(m.bytes)} stock=${m.stock} ${m.title}` : r.monoErr ? `ERR ${r.monoErr}` : `miss (${r.monoCount} results)`}`
  );
  console.log(
    `    ebook: ${e ? `HIT ${kb(e.bytes)} ${e.title}\n           ${e.img}` : r.ebookErr ? `ERR ${r.ebookErr}` : `miss (${r.ebookWhy})`}`
  );
}

const n = vols.length || 1;
const pct = (x) => `${((x / n) * 100).toFixed(0)}%`;
console.log(
  `\nSummary (${vols.length}):\n` +
    `  mono  ISBN一致   ${monoHit} (${pct(monoHit)}), ≥${MIN_BYTES / 1000}KB ${monoReal} (${pct(monoReal)})\n` +
    `  ebook シリーズ+巻 ${ebookHit} (${pct(ebookHit)}), ≥${MIN_BYTES / 1000}KB ${ebookReal} (${pct(ebookReal)})\n` +
    `  どちらか        ${either} (${pct(either)})   errors ${errors}`
);
