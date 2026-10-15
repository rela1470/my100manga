#!/usr/bin/env node
// DLsite cover/affiliate-source probe for the R18 site (throwaway measurement
// tool, not wired into the Worker). DMM's affiliate review failed (2026-10-15),
// so this measures how many 成年向け volumes DLsite 成年コミック (floor `books`)
// can give a cover and a purchase link for. See docs/dlsite.md.
//
// DLsite has no public product API and its pages carry no ISBN, so each volume
// is searched by title on the public search page and matched by
//   title  DLsite's title starts with the MADB series name (DLsite often appends
//          a subtitle: 「絶頂多発地帯」→「絶頂多発地帯 イキ地獄へようこそ」)
//   volume the number after the series name equals volume_number (none → none/1)
//   who    an author matches creators_norm, or (no MADB author) the publisher
//          matches the maker shown in the result
// If the title search finds nothing, it retries with the first author's name.
// A hit is then checked with product/info/ajax for `affiliate_deny` and the
// cover (`_img_main.jpg`) is fetched to record its size.
//
// Rate: DLsite's llms.txt asks crawlers for ≤2 req/s and ≤120 req/min; this
// waits 1 s between requests.
//
// Usage:
//   node scripts/dlsite-probe.mjs --from-json adult60.json
//     rows: [{ isbn, title, volume_number, pubdate, creators_norm, publisher, series }]
//     e.g. a read-only SELECT against the R18 D1 (the local D1 has no 成年向け volumes)

import fs from "node:fs";

const BASE = "https://www.dlsite.com/books";
const UA = "Mozilla/5.0 (my100manga measurement; contact admin@my100manga.com)";
const MIN_BYTES = 12000;

const args = process.argv.slice(2);
const jsonPath = args[args.indexOf("--from-json") + 1];
if (!args.includes("--from-json") || !jsonPath) {
  console.error("Usage: node scripts/dlsite-probe.mjs --from-json rows.json");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, opts = {}) {
  const wait = last + 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA, cookie: "adultchecked=1" }, ...opts });
    if ([400, 401, 403, 404].includes(res.status)) return res;
    if (res.status === 429 || res.status >= 500) {
      await sleep(30000); // llms.txt: retry after 30 s, at most twice
      continue;
    }
    return res;
  }
  throw new Error(`retries exhausted: ${url}`);
}

const SMALL = { ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ッ: "ツ", ヮ: "ワ" };
const norm = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァィゥェォャュョッヮ]/g, (c) => SMALL[c])
    .replace(/[\s・:：!！?？、。,.\-－ー〜~()（）「」『』【】\[\]〈〉《》☆★♡♥]/g, "");
// DLsite writes pen names with the real one in parentheses: 「月下冴喜(若宮参太)」.
const normAuthor = (s) => norm(String(s || "").normalize("NFKC").replace(/\([^)]*\)/g, ""));
// Publisher strings in MADB carry role prefixes like 「[発売]オークス」.
const normPub = (s) => norm(String(s || "").replace(/\[[^\]]*\]|\([^)]*\)/g, ""));
// Drop a subtitle after a colon and ruby-like readings in parentheses / angle
// brackets: 「私が全裸になった理由(ワケ)」→「私が全裸になった理由」.
const mainTitle = (s) =>
  String(s || "")
    .split(/\s*[:：]\s*/)[0]
    .replace(/[(（〈][^)）〉]*[)）〉]/g, "")
    .trim();
const numbers = (s) => (String(s || "").normalize("NFKC").match(/\d+/g) || []).map(Number);

function parseResults(html) {
  return html
    .split('data-list_item_product_id="')
    .slice(1)
    .map((chunk) => {
      const id = chunk.slice(0, chunk.indexOf('"'));
      const title = (chunk.match(/<dd class="work_name">[\s\S]*?title="([^"]*)"/) || [])[1] || "";
      const maker = (chunk.match(/alt="[^"]*\[([^\]]*)\]"/) || [])[1] || "";
      const authorBlock = (chunk.match(/<span class="author">([\s\S]*?)<\/span>/) || [])[1] || "";
      const authors = [...authorBlock.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1].trim());
      const img = (chunk.match(/'(\/\/img\.dlsite\.jp\/modpub\/[^']*_img_main\.jpg)'/) || [])[1] || "";
      return { id, title: decode(title), maker: decode(maker), authors: authors.map(decode), img: img && `https:${img}` };
    });
}
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function search(keyword) {
  // Spaces must be "+": "%20" in the path gets a 403 from DLsite.
  const kw = keyword.split(/\s+/).filter(Boolean).map(encodeURIComponent).join("+");
  // robots.txt disallows /fsr/=/…/per_page/…/page/ except page 1, so one page
  // of 100 is all we take — prolific authors' old books can fall off it.
  const res = await get(`${BASE}/fsr/=/language/jp/keyword/${kw}/per_page/100/page/1/`);
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return parseResults(await res.text());
}

function judge(v, items) {
  const want = norm(mainTitle(v.series));
  const vol = numbers(v.volume_number)[0] ?? null;
  const authors = String(v.creators_norm || "").split("|").map(norm).filter(Boolean);
  const pub = normPub(v.publisher);
  const titled = items.filter((it) => {
    const t = norm(it.title);
    if (!t.startsWith(want)) return false;
    const rest = numbers(it.title.normalize("NFKC").slice(mainTitle(v.series).normalize("NFKC").length));
    return vol == null ? rest.length === 0 || rest[0] === 1 : rest[0] === vol;
  });
  const who = (it) =>
    authors.length
      ? it.authors.some((a) => authors.includes(normAuthor(a)))
      : !!pub && !!normPub(it.maker) && (normPub(it.maker).includes(pub) || pub.includes(normPub(it.maker)));
  const strict = titled.find(who);
  if (strict) return { level: "strict", hit: strict };
  if (titled.length) return { level: "titleOnly", hit: titled[0], others: titled.length };
  return null;
}

async function probe(v) {
  const out = { isbn: v.isbn, series: v.series, vol: v.volume_number, authors: v.creators_norm, pub: v.publisher };
  try {
    let items = await search(mainTitle(v.series));
    out.titleResults = items.length;
    let m = judge(v, items);
    const firstAuthor = String(v.creators_norm || "").split("|")[0];
    if ((!m || m.level !== "strict") && firstAuthor) {
      items = await search(firstAuthor);
      out.authorResults = items.length;
      const m2 = judge(v, items);
      if (m2 && (!m || m2.level === "strict")) m = { ...m2, via: "author" };
    }
    if (!m) return { ...out, level: "none" };
    out.level = m.level;
    out.via = m.via || "title";
    out.hit = m.hit;
    const info = await get(`${BASE}/product/info/ajax?product_id=${m.hit.id}&cdn_cache_min=1`);
    const j = info.ok ? (await info.json())?.[m.hit.id] : null;
    out.affiliateDeny = j ? j.affiliate_deny : "?";
    out.onSale = j ? j.on_sale : "?";
    if (m.hit.img) {
      const r = await get(m.hit.img);
      out.bytes = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    }
  } catch (e) {
    out.err = String(e);
  }
  return out;
}

const results = [];
for (const v of rows) {
  const r = await probe(v);
  results.push(r);
  const tag = r.level === "strict" ? "OK " : r.level === "titleOnly" ? "T? " : r.err ? "ERR" : "-- ";
  console.log(
    `${tag} ${r.isbn} ${r.series}${r.vol ? ` #${r.vol}` : ""} [${r.authors || "-"} / ${r.pub || "-"}]` +
      (r.hit ? `\n      → ${r.hit.id} ${r.hit.title} [${r.hit.authors.join(",")} / ${r.hit.maker}] via=${r.via} deny=${r.affiliateDeny} sale=${r.onSale} ${r.bytes ?? "-"}B` : "") +
      (r.err ? `\n      ${r.err}` : "")
  );
}

const n = results.length;
const count = (f) => results.filter(f).length;
const pct = (k) => `${k}/${n} (${Math.round((100 * k) / n)}%)`;
console.log("\n== summary");
console.log("strict match        ", pct(count((r) => r.level === "strict")));
console.log("  cover ≥12KB       ", pct(count((r) => r.level === "strict" && r.bytes >= MIN_BYTES)));
console.log("  affiliate allowed ", pct(count((r) => r.level === "strict" && r.affiliateDeny === 0)));
console.log("  found via author  ", pct(count((r) => r.level === "strict" && r.via === "author")));
console.log("title-only (unsure) ", pct(count((r) => r.level === "titleOnly")));
console.log("none                ", pct(count((r) => r.level === "none")));
console.log("errors              ", pct(count((r) => r.err)));
fs.writeFileSync(jsonPath.replace(/\.json$/, "") + ".dlsite.json", JSON.stringify(results, null, 1));
