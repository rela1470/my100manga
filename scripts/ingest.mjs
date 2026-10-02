#!/usr/bin/env node
// MADB (メディア芸術データベース) manga master importer.
//
// Downloads the latest release of https://github.com/mediaarts-db/dataset
// (manga volumes = metadata101, manga series = metadata104), stream-parses the
// JSON-LD, and loads series/volumes into D1. This is the source of truth for
// series→volume→ISBN correlation that powers search and the "add all volumes"
// button. Run monthly (see .github/workflows/ingest.yml).
//
// Usage:
//   node scripts/ingest.mjs --local            # apply to local D1
//   node scripts/ingest.mjs --remote           # apply to remote D1
//   node scripts/ingest.mjs --local --skip-download --work /tmp   # reuse files
//   node scripts/ingest.mjs --local --limit 5000   # smoke test with a subset (loads
//                                                  # series_new/volumes_new only, no swap)
//
// Flags:
//   --local | --remote   target D1 (default: --local)
//   --tag <tag>          release tag (default: latest)
//   --work <dir>         working dir for downloads/unzip (default: /tmp/madb)
//   --skip-download      reuse already-extracted metadata10{1,4}.json under work
//   --out <dir>          where to write seed SQL chunks (default: <work>/seed)
//   --chunk <n>          rows per INSERT statement file group (default: 25000)
//   --limit <n>          only process first n volumes (testing). Stops after loading
//                        the shadow tables: never swaps a partial master into place
//   --env <name>         wrangler environment (e.g. dev → targets my100manga-dev)
//   --no-apply           generate SQL but do not run wrangler

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { chain } from "stream-chain";

const REPO = "mediaarts-db/dataset";
const VOLUMES_ASSET = "metadata101_json.zip"; // マンガ単行本
const SERIES_ASSET = "metadata104_json.zip"; // マンガ単行本シリーズ
// Reference the DB by its binding name so `--env` selects the right database
// (top-level = my100manga, `--env dev` = my100manga-dev). See wrangler.jsonc.
const DB_BINDING = "DB";
const ID_PREFIX = "https://mediaarts-db.artmuseums.go.jp/id/";

// Column definitions kept in sync with db/schema.sql (series / volumes). The shadow
// tables deliberately omit indexes — they're added post-swap (see SWAP_SQL).
const SERIES_COLS =
  "id TEXT PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, name_kana TEXT, " +
  "name_kana_norm TEXT, name_search TEXT, creator TEXT, creators TEXT, creators_norm TEXT, publisher TEXT, label TEXT, num_items INTEGER";
const VOLUMES_COLS =
  "isbn TEXT PRIMARY KEY, series_id TEXT, volume_number TEXT, vol_sort INTEGER, " +
  "title TEXT NOT NULL, title_search TEXT, creator TEXT, creators TEXT, creators_norm TEXT, publisher TEXT, label TEXT, pubdate TEXT";

const DROP_AND_CREATE_SHADOW_SQL =
  "DROP TABLE IF EXISTS series_new; DROP TABLE IF EXISTS volumes_new; " +
  `CREATE TABLE series_new (${SERIES_COLS}); ` +
  `CREATE TABLE volumes_new (${VOLUMES_COLS});`;

// Drop supplement volumes the new master now carries (same ISBN, or the same volume
// number within the series) so they aren't counted/listed twice. Volumes the master
// still lacks — MADB often leaves new tankobon unlinked for months — are kept, so a
// series doesn't lose its newest volumes until someone presses 取得 again.
// checked_at is left alone so the "probed" state survives the ingest.
const PRUNE_SUPPLEMENT_SQL =
  "UPDATE series_supplement SET volumes_json = COALESCE((" +
  "SELECT json_group_array(json(j.value)) FROM json_each(series_supplement.volumes_json) j " +
  "WHERE NOT EXISTS (SELECT 1 FROM volumes v WHERE " +
  "v.isbn IN (SELECT value FROM json_each(j.value, '$.isbns')) " +
  "OR (v.series_id = series_supplement.series_id AND v.vol_sort = json_extract(j.value, '$.vol_sort')))" +
  "), '[]');";

// Re-apply admin-confirmed links (see src/groups.ts APPLY_LINKS_SQL — keep in sync):
// custom series go back into `series`, linked ISBNs get their series_id again. Only
// volumes still where they were when linked are rewritten — series-less (from_series_id
// NULL) or still in the split source — so the new master's own re-filing wins.
const APPLY_LINKS_SQL = [
  "CREATE TABLE IF NOT EXISTS custom_series (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, creator TEXT, publisher TEXT, label TEXT, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS volume_series_link (isbn TEXT PRIMARY KEY, series_id TEXT NOT NULL, created_at INTEGER NOT NULL, from_series_id TEXT);",
  "INSERT OR REPLACE INTO series (id, name, name_norm, name_kana, name_kana_norm, creator, publisher, label, num_items) " +
    "SELECT id, name, name_norm, NULL, NULL, creator, publisher, label, NULL FROM custom_series;",
  "UPDATE volumes SET series_id = (SELECT l.series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn) " +
    "WHERE isbn IN (SELECT isbn FROM volume_series_link) " +
    "AND series_id IS (SELECT l.from_series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn);",
];

// Blue-green cutover. RENAMEs are instant metadata ops, so the window where the live
// `series`/`volumes` names point at anything other than a fully-loaded table is
// negligible. Old tables are dropped first to free the global index names, then the
// canonical indexes are rebuilt on the freshly-promoted tables.
const SWAP_SQL = [
  `CREATE TABLE IF NOT EXISTS series (${SERIES_COLS});`,
  `CREATE TABLE IF NOT EXISTS volumes (${VOLUMES_COLS});`,
  "DROP TABLE IF EXISTS series_old;",
  "DROP TABLE IF EXISTS volumes_old;",
  "ALTER TABLE series RENAME TO series_old;",
  "ALTER TABLE volumes RENAME TO volumes_old;",
  "ALTER TABLE series_new RENAME TO series;",
  "ALTER TABLE volumes_new RENAME TO volumes;",
  "DROP TABLE series_old;",
  "DROP TABLE volumes_old;",
  "CREATE INDEX IF NOT EXISTS idx_series_name_norm ON series (name_norm);",
  "CREATE INDEX IF NOT EXISTS idx_series_kana_norm ON series (name_kana_norm);",
  "CREATE INDEX IF NOT EXISTS idx_volumes_series ON volumes (series_id, vol_sort);",
  "CREATE TABLE IF NOT EXISTS series_supplement (series_id TEXT PRIMARY KEY, volumes_json TEXT NOT NULL, checked_at INTEGER NOT NULL);",
  PRUNE_SUPPLEMENT_SQL,
  ...APPLY_LINKS_SQL,
].join(" ");

function parseArgs(argv) {
  const a = {
    target: "local",
    tag: "latest",
    work: "/tmp/madb",
    out: null,
    chunk: 25000,
    limit: 0,
    skipDownload: false,
    apply: true,
    env: "",
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--local") a.target = "local";
    else if (v === "--remote") a.target = "remote";
    else if (v === "--skip-download") a.skipDownload = true;
    else if (v === "--no-apply") a.apply = false;
    else if (v === "--tag") a.tag = argv[++i];
    else if (v === "--work") a.work = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--chunk") a.chunk = parseInt(argv[++i], 10);
    else if (v === "--limit") a.limit = parseInt(argv[++i], 10);
    else if (v === "--env") a.env = argv[++i];
    else throw new Error(`unknown flag: ${v}`);
  }
  if (!a.out) a.out = path.join(a.work, "seed");
  return a;
}

function log(...m) {
  console.log("[ingest]", ...m);
}

// ── download & unzip ────────────────────────────────────────────────────────

async function resolveAssets(tag) {
  const api =
    tag === "latest"
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
  const headers = { "user-agent": "my100manga-ingest" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(api, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${api}`);
  const rel = await res.json();
  const find = (name) => {
    const asset = rel.assets.find((x) => x.name === name);
    if (!asset) throw new Error(`asset not found in release ${rel.tag_name}: ${name}`);
    return asset.browser_download_url;
  };
  return {
    tag: rel.tag_name,
    releasedAt: rel.published_at ? Date.parse(rel.published_at) : null,
    volumes: find(VOLUMES_ASSET),
    series: find(SERIES_ASSET),
  };
}

async function download(url, dest) {
  log("download", url);
  const res = await fetch(url, { headers: { "user-agent": "my100manga-ingest" } });
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log("saved", dest, `(${Math.round(buf.length / 1048576)}MB)`);
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "inherit" });
}

// Returns the single extracted metadata*.json path in a dir.
function extractedJson(dir) {
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".json"));
  if (!f) throw new Error(`no .json extracted in ${dir}`);
  return path.join(dir, f);
}

// ── JSON-LD value helpers ───────────────────────────────────────────────────

// schema:name etc. are either a plain string, or an array mixing plain strings
// and { "@value", "@language" } objects. Pull the first plain string.
function primary(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) if (typeof x === "string") return x;
    for (const x of v) if (x && typeof x === "object" && typeof x["@value"] === "string") return x["@value"];
    return "";
  }
  if (typeof v === "object" && typeof v["@value"] === "string") return v["@value"];
  return "";
}

// Collect ALL ja-hrkt readings. MADB lists several under schema:name — often an
// English alias AND the true kana reading (e.g. ONE PIECE → ["ONE PIECE","ワン ピース"];
// 鋼の錬金術師 → ["FULLMETAL ALCHEMIST","ハガネ ノ レンキンジュツシ"]). Taking only the
// first would drop the katakana reading and make katakana queries miss the series.
function kanaReadings(v) {
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    if (x && typeof x === "object" && x["@language"] === "ja-hrkt" && typeof x["@value"] === "string") {
      out.push(x["@value"]);
    }
  }
  return out;
}

function cid(node, prop) {
  const v = node[prop];
  if (v && typeof v === "object" && typeof v["@id"] === "string") {
    return v["@id"].startsWith(ID_PREFIX) ? v["@id"].slice(ID_PREFIX.length) : v["@id"];
  }
  return "";
}

function normTitle(s) {
  return s.replace(/[\s　]+/g, "").toLowerCase();
}

// Search-only key (series.name_search / volumes.title_search): normTitle plus NFKC
// width folding and punctuation/symbols dropped, so 「ぼっちざろっく」 finds
// 「ぼっち・ざ・ろっく！」. Keep in sync with src/util.ts searchKey.
function searchKey(s) {
  return s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

// MADB packs alternate readings/variants after "∥" (kana) or "／" (alt spelling):
//   "講談社　∥　コウダンシャ" / "フラワーコミックス　／　少コミ..." → take the first.
function firstVariant(s) {
  return String(s ?? "")
    .split(/[／∥]/)[0]
    .trim();
}

// schema:creator is often an array whose FIRST entry is a non-author role, e.g.
// ONE PIECE volumes list ["[編]ホーム社","[著]尾田栄一郎",...] — taking the first
// would credit the editor "ホーム社" as the author. Prefer authorship roles
// (著/作画/まんが/漫画/作/原作/画) over editor/supervisor roles (編/編集/監修/…).
const EDITOR_ROLE = /\[(編|編集|監修|企画|協力|訳|翻訳)\]/;
function pickCreator(v) {
  const arr = Array.isArray(v) ? v : [v];
  const strs = arr.filter((x) => typeof x === "string" && x.trim());
  if (strs.length === 0) return "";
  const nonEditor = strs.filter((s) => !EDITOR_ROLE.test(s));
  return nonEditor[0] ?? strs[0];
}

// pickCreator keeps ONE name for display, but co-authored works list the rest after it
// (e.g. ["よむ","丸戸史明", …]), so a search for the 2nd author would miss. Store every
// non-editor name — normalized like normTitle() and "|"-joined — for search only.
function creatorsNorm(v) {
  const arr = Array.isArray(v) ? v : [v];
  const strs = arr.filter((x) => typeof x === "string" && x.trim());
  const names = strs
    .filter((s) => !EDITOR_ROLE.test(s))
    .map((s) => normTitle(cleanCreator(s)))
    .filter(Boolean);
  return [...new Set(names)].join("|");
}

// Display credit line for every author-type contributor, with roles when they tell the
// contributors apart: "原作：丸戸史明、作画：よむ". A single author, or co-authors who all
// share one role (e.g. 2 × [著]), get names only: "ゆでたまご" / "A、B". MADB literals
// are messy — several credits in one string ("[原作]A [作画]B"), a bracketed name
// ("[作画][司敬]"), stacked roles ("[原作][著]X"), dangling roles ("[著]X[監修]") — see
// parseCredits. Editor/design/translation credits are dropped; story roles sort first.
// A bracket that reads as a role: known role words, optionally joined ("原作・監修", "作並構成",
// "キャラクター原案"). Whole words, so katakana names ("[作画][カシバ]") aren't mistaken for roles.
const ROLE_WORDS =
  "キャラクター|デザイン|カバー|イラスト|シナリオ|ライター|アーティスト|まんが|マンガ|ほか|" +
  "著|作|画|原|案|編|集|監|修|訳|翻|脚|本|文|絵|装|丁|幀|構|成|漫|劇|共|述|他|え|協|力|企|制|製|色|彩|同|立|指|導|挿|口|表|紙|題|字|箱|背|景";
const ROLE_CHARS = new RegExp(`^(?:${ROLE_WORDS})(?:[・･並及び]*(?:${ROLE_WORDS}))*$`);
const AUTHOR_ROLE = /著|作|画|絵|漫|まんが|マンガ|案|脚|シナリオ|文|構成|劇|述|^え$|story|art|script|original|illust|comic|manga|writ/i;
const NON_AUTHOR_ROLE = /編|監修|制作|製作|企画|デザイン|解説|協力|訳|装|作曲|作詞/;
const CORE_AUTHOR_ROLE = /著|原作|原案|画|漫|まんが|マンガ|脚本|シナリオ/;
// Cover/illustration and assistant credits read like author roles (装画, 作画協力) but never are.
const NEVER_AUTHOR_ROLE = /装|カバー|口絵|挿|協力|表紙|題字|箱絵|背景|仕上|アシスタント/;
const OTHERS_ROLE = /^(ほか|他)共?[・･]?/; // "and others" prefix on a role, not worth showing
const ORIGINAL_ROLE = /原作|原案|original/i;
const CHARACTER_ROLE = /キャラクター/; // キャラクター原案/デザイン credit after the manga artist
const STORY_ROLE = /^作$|脚|シナリオ|^文$|構成|story|script|writ/i;
const MAX_CREDITS = 4;

/** One MADB creator literal → [{ role, name }]. role is "" when untagged. */
function parseCredits(s) {
  const toks = [];
  const re = /\[+([^\[\]]*)\]|([^\[\]]+)/g;
  // Repair dropped brackets: "[ほか]原作]富野由悠季" → "[ほか][原作]富野由悠季",
  // "解説]野坂昭如" → "[解説]野坂昭如", a lone "[著" → "[著]" (dangling, dropped).
  s = s
    .replace(/\]([^\[\]]+)\]/g, "][$1]")
    .replace(/^([^\[\]]+)\]/, "[$1]")
    .replace(/\[([^\[\]]*)$/, "[$1]");
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) toks.push({ br: true, v: m[1].trim().replace(/^[(（](.*)[)）]$/, "$1") }); // "[(漫画)]"
    // glued: no whitespace before the next token, so "若木書房[編]" reads as name+role.
    // Bare separators between bracketed names ("[原作][A], [B]") aren't names.
    else if (!/^[\s,，、・]*$/.test(m[2])) toks.push({ br: false, v: m[2].trim(), glued: !/\s$/.test(m[2]) });
  }
  const out = [];
  let roles = [];
  let lastBrName = null; // role of the previous bracketed name: "[原作][A], [B]" credits B too
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    if (t.br) {
      // A bracket right before text is a role tag ("[原作]A", "[STORY]B"). One after a
      // role tag that doesn't read as a role is a bracketed name ("[作画][司敬]"); any
      // other bracket is a role, or dangling when nothing follows ("X[監修]", "X[ほか]").
      if (!roles.length && lastBrName !== null && !ROLE_CHARS.test(t.v)) roles = [lastBrName];
      const isName = !(next && !next.br) && roles.length > 0 && !ROLE_CHARS.test(t.v);
      if (!isName) {
        if (next) roles.push(t.v);
        lastBrName = null;
        continue;
      }
      lastBrName = roles.join("・");
    } else {
      lastBrName = null;
    }
    // A role tag glued AFTER an untagged name belongs to it ("若木書房[編]",
    // "A[原作] B[作画]"), not to the next name. Only when no prefix role is pending:
    // "[著]上田美和[監修]" keeps 著 and drops the dangling 監修.
    if (!t.br && t.glued && !roles.length) {
      while (toks[i + 1]?.br && ROLE_CHARS.test(toks[i + 1].v)) roles.push(toks[++i].v);
    }
    // A name: plain text, or a bracketed name. Cataloging-style text gives each ";"
    // segment its own trailing role word and leaves the tag for the rest
    // ("[作画]石ノ森章太郎 原作 ; 辻真先 脚本 ; 尾瀬あきら"); a trailing " ほか"/" 他" only
    // means "and others". A tagged credit may pack several names ("[著]A, B, C"; untagged
    // western "Cash, Megan" stays whole). Authority dates ("ラズウェル細木1956-") are dropped.
    const role = roles.join("・");
    const segs = t.v.split(/\s*[;；]\s*/);
    for (let seg of segs) {
      seg = seg.replace(/\s+(ほか|他)$/, "");
      let segRole = role;
      const w = seg.match(/^(.+?)\s+(\S+)$/);
      // One-kanji words (文, 画) are only roles in ";" text; elsewhere they may be a given name.
      if (w && ROLE_CHARS.test(w[2]) && (segs.length > 1 || w[2].length > 1 || w[2] === "著")) {
        seg = w[1];
        segRole = w[2];
      }
      const names = segRole ? seg.split(/\s*[,，、]\s*/) : [seg];
      for (const n of names) {
        const name = n.replace(/\s*\d{4}-(\d{4})?$/, "").replace(/[\s　]+/g, " ").trim();
        if (name && !/^(ほか|他)$/.test(name)) out.push({ role: segRole, name });
      }
    }
    roles = [];
  }
  return out;
}

// "編著" / "原作・監修" still credit an author; "編集・制作" / "キャラクターデザイン" / "装画" don't.
function isAuthorRole(role) {
  if (!AUTHOR_ROLE.test(role) || NEVER_AUTHOR_ROLE.test(role)) return false;
  return !NON_AUTHOR_ROLE.test(role) || CORE_AUTHOR_ROLE.test(role);
}

function creatorsDisplay(v) {
  const arr = Array.isArray(v) ? v : [v];
  const credits = [];
  const seen = new Set();
  let others = false; // "A ほか" / "[ほか著]A" / "A[他]": the source lists only some names
  for (const s of arr) {
    if (typeof s !== "string" || !s.trim()) continue;
    if (/(?:^|[\s\[\]])(?:ほか|他)(?:共?著)?(?:\]|\s|$)/.test(s)) others = true;
    for (const c of parseCredits(s)) {
      c.role = c.role.replace(OTHERS_ROLE, ""); // "[他]" → untagged, "[ほか著]" → 著, "[ほか監修]" → 監修
      if (c.role && !isAuthorRole(c.role)) continue;
      const key = c.name.replace(/\s/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      credits.push(c);
    }
  }
  if (!credits.length) return "";
  // Story roles first (キャラクター原案 last, as books credit it); credits sharing a role
  // sit together and print the role once ("原作：富野由悠季、矢立肇、作画：…").
  const firstSeen = new Map();
  credits.forEach((c, i) => firstSeen.has(c.role) || firstSeen.set(c.role, i));
  const rank = (c) =>
    CHARACTER_ROLE.test(c.role) ? 3 : ORIGINAL_ROLE.test(c.role) ? 0 : STORY_ROLE.test(c.role) ? 1 : 2;
  credits.sort((a, b) => rank(a) - rank(b) || firstSeen.get(a.role) - firstSeen.get(b.role));
  const shown = credits.slice(0, MAX_CREDITS);
  const roles = new Set(credits.map((c) => (c.role === "著" ? "" : c.role)));
  const withRoles = roles.size > 1;
  const text = shown
    .map((c, i) => (withRoles && c.role && c.role !== shown[i - 1]?.role ? `${c.role}：${c.name}` : c.name))
    .join("、");
  return credits.length > MAX_CREDITS || others ? `${text} ほか` : text;
}

// Creator strings carry role tags like "[著]尾玉なみえ" / "[原作]A [作画]B".
function cleanCreator(s) {
  return String(s ?? "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

// Numeric sort key from a volume-number string ("1", "10", "上", "3.5", "巻ノ二十七" →
// 1,10,0,3,27). Kanji numerals only count in a plain volume label (not "三つの符号編").
// Mirrors src/util.ts volSort.
const KANJI_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, ニ: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNITS = { 十: 10, 百: 100, 千: 1000 };
const KANJI_NUM_RE = /[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*/g;
function kanjiToNumber(s) {
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
const KANJI_VOLUME_RE =
  /^(?:[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*|(?:巻|巻ノ|巻の|第)[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*|第[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*[巻集]|[〇零一二三四五六七八九十百千][〇零一二三四五六七八九十百千ニ]*巻)$/;
function volSort(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/\d+/);
  if (m) return parseInt(m[0], 10);
  return KANJI_VOLUME_RE.test(s) ? kanjiToNumber(s.match(KANJI_NUM_RE)[0]) : 0;
}

// ISBN normalize → ISBN13. Accepts ISBN10/13 with hyphens; converts 10→13.
// schema:isbn can be multi-valued, sometimes with a malformed sibling (e.g.
// ["088701424", "9784088701424"] on こち亀 172巻). Stringifying the array would glue
// them into one invalid run and drop the volume, so take the first valid value.
function isbn13(raw) {
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const r = isbn13(x);
      if (r) return r;
    }
    return "";
  }
  if (raw && typeof raw === "object") raw = raw["@value"];
  // Box-set ISBNs ("9784099430115(set)") are shared by every book in the box, so they
  // never identify a single volume; skip them (src/madbLive.ts liveIsbn does the same).
  if (/\(set\)/i.test(String(raw ?? ""))) return "";
  const s = String(raw ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10) {
    const core = "978" + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(core[i]);
    const check = (10 - (sum % 10)) % 10;
    return core + check;
  }
  return "";
}

// ── SQL emission ────────────────────────────────────────────────────────────

function sqlStr(s) {
  if (s == null || s === "") return "NULL";
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function sqlInt(n) {
  return n == null || Number.isNaN(n) ? "NULL" : String(n);
}

// Buffered writer that flushes multi-row INSERTs into numbered .sql files.
// finish() returns [{ path, rows }] in apply order so the daily seeder can
// budget exactly how many rows each file writes (see scripts/seed-daily.mjs).
class SqlChunkWriter {
  constructor(outDir, prefix, columns, rowsPerFile) {
    this.outDir = outDir;
    this.prefix = prefix;
    this.columns = columns;
    this.rowsPerFile = rowsPerFile;
    this.fileIdx = 0;
    this.rowsInFile = 0;
    this.values = [];
    this.counts = []; // [{ path, rows }] finalized files, in order
    fs.mkdirSync(outDir, { recursive: true });
  }
  add(valuesTuple) {
    this.values.push("(" + valuesTuple.join(",") + ")");
    this.rowsInFile++;
    // Keep individual INSERT statements bounded (SQLite max SQL length).
    if (this.values.length >= 100) this._flushStatement();
    if (this.rowsInFile >= this.rowsPerFile) this._rotate();
  }
  _flushStatement() {
    if (this.values.length === 0) return;
    const stmt =
      `INSERT OR REPLACE INTO ${this.prefix} (${this.columns.join(",")}) VALUES\n` +
      this.values.join(",\n") +
      ";\n";
    fs.appendFileSync(this._currentPath(), stmt);
    this.values = [];
  }
  _currentPath() {
    return path.join(this.outDir, `${this.prefix}_${String(this.fileIdx).padStart(3, "0")}.sql`);
  }
  _rotate() {
    this._flushStatement();
    this.counts.push({ path: this._currentPath(), rows: this.rowsInFile });
    this.fileIdx++;
    this.rowsInFile = 0;
  }
  finish() {
    this._flushStatement();
    if (this.rowsInFile > 0) this.counts.push({ path: this._currentPath(), rows: this.rowsInFile });
    return this.counts;
  }
}

async function streamGraph(jsonPath, onNode) {
  await new Promise((resolve, reject) => {
    const p = chain([
      fs.createReadStream(jsonPath),
      parser(),
      pick({ filter: "@graph" }),
      streamArray(),
    ]);
    p.on("data", ({ value }) => onNode(value));
    p.on("close", resolve);
    p.on("error", reject);
  });
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const a = parseArgs(process.argv);
  fs.mkdirSync(a.work, { recursive: true });

  let volumesJson, seriesJson;
  let releaseTag = a.tag && a.tag !== "latest" ? a.tag : null;
  let releasedAt = null;
  if (a.skipDownload) {
    // Support both our layout and the ad-hoc /tmp/cm10x/metadataXXX.json layout.
    volumesJson = firstExisting([
      path.join(a.work, "volumes", "metadata101.json"),
      "/tmp/cm101/metadata101.json",
    ]);
    seriesJson = firstExisting([
      path.join(a.work, "series", "metadata104.json"),
      "/tmp/cm104/metadata104.json",
    ]);
    log("reusing", volumesJson, seriesJson);
  } else {
    const assets = await resolveAssets(a.tag);
    log("release", assets.tag);
    releaseTag = assets.tag;
    releasedAt = assets.releasedAt;
    const volZip = path.join(a.work, VOLUMES_ASSET);
    const serZip = path.join(a.work, SERIES_ASSET);
    await download(assets.volumes, volZip);
    await download(assets.series, serZip);
    unzip(volZip, path.join(a.work, "volumes"));
    unzip(serZip, path.join(a.work, "series"));
    volumesJson = extractedJson(path.join(a.work, "volumes"));
    seriesJson = extractedJson(path.join(a.work, "series"));
  }

  // Reset output dir.
  fs.rmSync(a.out, { recursive: true, force: true });
  fs.mkdirSync(a.out, { recursive: true });

  // 1. series → load into a shadow table (series_new); swapped in atomically at the
  // end so the live site never reads a half-loaded master. See the swap block below.
  const seriesWriter = new SqlChunkWriter(
    a.out,
    "series_new",
    ["id", "name", "name_norm", "name_kana", "name_kana_norm", "name_search", "creator", "creators", "creators_norm", "publisher", "label", "num_items"],
    a.chunk
  );
  let seriesCount = 0;
  await streamGraph(seriesJson, (node) => {
    if (node["@type"] !== "class:MangaBookSeries") return;
    const id = (node["@id"] || "").startsWith(ID_PREFIX)
      ? node["@id"].slice(ID_PREFIX.length)
      : node["@id"];
    const name = primary(node["schema:name"]) || node["rdfs:label"] || "";
    if (!id || !name) return;
    const readings = kanaReadings(node["schema:name"]);
    const nameKana = readings.join(" / ");
    // Store each reading normalized and "|"-delimited so search can match either a
    // whole reading (exact tier) or a substring across the combined blob.
    const kanaNorm = [...new Set(readings.map(normTitle).filter(Boolean))].join("|");
    seriesWriter.add([
      sqlStr(id),
      sqlStr(name),
      sqlStr(normTitle(name)),
      sqlStr(nameKana),
      sqlStr(kanaNorm),
      sqlStr(searchKey(name)),
      sqlStr(cleanCreator(pickCreator(node["schema:creator"]))),
      sqlStr(creatorsDisplay(node["schema:creator"])),
      sqlStr(creatorsNorm(node["schema:creator"])),
      sqlStr(firstVariant(primary(node["schema:publisher"]))),
      sqlStr(firstVariant(primary(node["schema:brand"]))),
      sqlInt(node["schema:numberOfItems"] ? parseInt(node["schema:numberOfItems"], 10) : null),
    ]);
    seriesCount++;
  });
  const seriesFiles = seriesWriter.finish();
  log(`series: ${seriesCount} rows → ${seriesFiles.length} files`);

  // 2. volumes (deduped by ISBN) → shadow table volumes_new, swapped in below.
  const volumesWriter = new SqlChunkWriter(
    a.out,
    "volumes_new",
    ["isbn", "series_id", "volume_number", "vol_sort", "title", "title_search", "creator", "creators", "creators_norm", "publisher", "label", "pubdate"],
    a.chunk
  );
  const seen = new Set();
  let volCount = 0;
  let processed = 0;
  await streamGraph(volumesJson, (node) => {
    if (a.limit && processed >= a.limit) return;
    processed++;
    if (node["@type"] !== "class:MangaBook") return;
    const isbn = isbn13(node["schema:isbn"]);
    if (!isbn || seen.has(isbn)) return;
    const title = primary(node["schema:name"]) || node["rdfs:label"] || "";
    if (!title) return;
    seen.add(isbn);
    const vnum = primary(node["schema:volumeNumber"]);
    volumesWriter.add([
      sqlStr(isbn),
      sqlStr(cid(node, "schema:isPartOf")),
      sqlStr(vnum),
      sqlInt(volSort(vnum)),
      sqlStr(title),
      sqlStr(searchKey(title)),
      sqlStr(cleanCreator(pickCreator(node["schema:creator"]))),
      sqlStr(creatorsDisplay(node["schema:creator"])),
      sqlStr(creatorsNorm(node["schema:creator"])),
      sqlStr(firstVariant(primary(node["schema:publisher"]))),
      sqlStr(firstVariant(primary(node["schema:brand"]))),
      sqlStr(primary(node["schema:datePublished"])),
    ]);
    volCount++;
  });
  const volumeFiles = volumesWriter.finish();
  log(`volumes: ${volCount} rows → ${volumeFiles.length} files`);

  // Emit a manifest so a resumable per-day loader (scripts/seed-daily.mjs) can
  // budget exactly how many rows each file writes, in apply order.
  const manifest = {
    tag: releaseTag,
    releasedAt,
    chunk: a.chunk,
    files: [
      ...seriesFiles.map((f) => ({ file: path.basename(f.path), table: "series", rows: f.rows })),
      ...volumeFiles.map((f) => ({ file: path.basename(f.path), table: "volumes", rows: f.rows })),
    ],
  };
  fs.writeFileSync(path.join(a.out, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (!a.apply) {
    log("--no-apply: SQL written to", a.out);
    return;
  }

  // Apply with a blue-green swap so the live site never reads a half-loaded master.
  // We load the whole dump into shadow tables (series_new / volumes_new), then flip
  // them into place with instant RENAMEs. The old approach (DELETE then reload the
  // live tables chunk-by-chunk) left search / "全巻追加" broken for the whole load
  // window — minutes to hours against remote D1.
  const targetFlag = a.target === "remote" ? "--remote" : "--local";
  const envArgs = a.env ? ["--env", a.env] : [];

  // 1. Fresh shadow tables, no indexes yet. SQLite index names are global, so we
  //    can't create the canonical indexes on *_new while the live tables still own
  //    those names — they're (re)created after the old tables are dropped in step 3.
  execWrangler(envArgs, targetFlag, "--command", DROP_AND_CREATE_SHADOW_SQL);

  // 2. Stream the chunks into the shadow tables. The live site keeps serving the
  //    current master untouched throughout.
  for (const f of [...seriesFiles, ...volumeFiles]) {
    log("apply", path.basename(f.path));
    execWrangler(envArgs, targetFlag, "--file", f.path);
  }

  // 3. Atomic cutover: rename shadow → live, drop the old tables (freeing the index
  //    names), recreate indexes, and prune series_supplement. The supplement is a
  //    live-SPARQL cache of volumes the *old* master lacked; entries the new master
  //    now carries would duplicate it, so they're removed (see PRUNE_SUPPLEMENT_SQL)
  //    while still-missing ones are kept. CREATE IF NOT EXISTS on the live tables
  //    keeps this working on a first-ever ingest where they don't exist yet.
  // A --limit run is a partial master by definition. Swapping it in would silently
  // replace the full live data with a few thousand volumes (this wiped the local DB
  // once), so stop here and leave the shadow tables for inspection; the next ingest's
  // step 1 drops them.
  if (a.limit) {
    log(`--limit ${a.limit}: loaded series_new / volumes_new only; skipped swap (live tables untouched).`);
    return;
  }

  log("swap shadow tables into place");
  execWrangler(envArgs, targetFlag, "--command", SWAP_SQL);

  // Record dump provenance so the UI can show "マスター更新". released_at is the MADB
  // release date (preferred); imported_at is when this ingest ran (fallback).
  const metaRows = [
    ["imported_at", String(Date.now())],
    releaseTag ? ["madb_release_tag", releaseTag] : null,
    releasedAt ? ["madb_released_at", String(releasedAt)] : null,
  ].filter(Boolean);
  const metaSql =
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); " +
    metaRows
      .map(([k, v]) => `INSERT OR REPLACE INTO meta (key, value) VALUES (${sqlStr(k)}, ${sqlStr(v)});`)
      .join(" ");
  execWrangler(envArgs, targetFlag, "--command", metaSql);
  log("done.");
}

function firstExisting(paths) {
  for (const p of paths) if (fs.existsSync(p)) return p;
  throw new Error(`none exist: ${paths.join(", ")}`);
}

function execWrangler(envArgs, targetFlag, ...args) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_BINDING, ...envArgs, targetFlag, "--yes", ...args],
    { stdio: "inherit" }
  );
}

main().catch((err) => {
  console.error("[ingest] FAILED:", err);
  process.exit(1);
});
