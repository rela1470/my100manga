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
//   node scripts/ingest.mjs --local --limit 5000   # smoke test with a subset
//
// Flags:
//   --local | --remote   target D1 (default: --local)
//   --tag <tag>          release tag (default: latest)
//   --work <dir>         working dir for downloads/unzip (default: /tmp/madb)
//   --skip-download      reuse already-extracted metadata10{1,4}.json under work
//   --out <dir>          where to write seed SQL chunks (default: <work>/seed)
//   --chunk <n>          rows per INSERT statement file group (default: 25000)
//   --limit <n>          only process first n volumes (testing)
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
function pickCreator(v) {
  const arr = Array.isArray(v) ? v : [v];
  const strs = arr.filter((x) => typeof x === "string" && x.trim());
  if (strs.length === 0) return "";
  const nonEditor = strs.filter((s) => !/\[(編|編集|監修|企画|協力|訳|翻訳)\]/.test(s));
  return nonEditor[0] ?? strs[0];
}

// Creator strings carry role tags like "[著]尾玉なみえ" / "[原作]A [作画]B".
function cleanCreator(s) {
  return String(s ?? "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

// Numeric sort key from a volume-number string ("1", "10", "上", "3.5" → 1,10,0,3).
function volSort(s) {
  const m = String(s ?? "").match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// ISBN normalize → ISBN13. Accepts ISBN10/13 with hyphens; converts 10→13.
function isbn13(raw) {
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

  // 1. series
  const seriesWriter = new SqlChunkWriter(
    a.out,
    "series",
    ["id", "name", "name_norm", "name_kana", "name_kana_norm", "creator", "publisher", "label", "num_items"],
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
      sqlStr(cleanCreator(pickCreator(node["schema:creator"]))),
      sqlStr(firstVariant(primary(node["schema:publisher"]))),
      sqlStr(firstVariant(primary(node["schema:brand"]))),
      sqlInt(node["schema:numberOfItems"] ? parseInt(node["schema:numberOfItems"], 10) : null),
    ]);
    seriesCount++;
  });
  const seriesFiles = seriesWriter.finish();
  log(`series: ${seriesCount} rows → ${seriesFiles.length} files`);

  // 2. volumes (deduped by ISBN)
  const volumesWriter = new SqlChunkWriter(
    a.out,
    "volumes",
    ["isbn", "series_id", "volume_number", "vol_sort", "title", "creator", "publisher", "label", "pubdate"],
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
      sqlStr(cleanCreator(pickCreator(node["schema:creator"]))),
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

  // Apply: clear existing rows first, then load chunks. series_supplement is a
  // live-SPARQL cache of volumes the *old* master lacked, filtered against it at
  // write time; once master is replaced those entries can duplicate newly-ingested
  // volumes, so drop the cache and let it recompute against the fresh master.
  const targetFlag = a.target === "remote" ? "--remote" : "--local";
  const envArgs = a.env ? ["--env", a.env] : [];
  execWrangler(envArgs, targetFlag, "--command", "DELETE FROM volumes; DELETE FROM series; DELETE FROM series_supplement;");
  for (const f of [...seriesFiles, ...volumeFiles]) {
    log("apply", path.basename(f.path));
    execWrangler(envArgs, targetFlag, "--file", f.path);
  }

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
