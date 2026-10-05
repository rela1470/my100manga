#!/usr/bin/env node
// MADB (メディア芸術データベース) manga master importer.
//
// Downloads the latest release of https://github.com/mediaarts-db/dataset
// (manga volumes = metadata101, manga series = metadata104), stream-parses the
// JSON-LD, and loads series/volumes into D1. This is the source of truth for
// series→volume→ISBN correlation that powers search and the "add all volumes"
// button. Run monthly (see .github/workflows/ingest.yml).
// 成年コミック（schema:contentRating / description）は取り込まない（isAdult, src/adult.ts）。
// 落とした巻（ISBN あり）は adult_volumes に記録し、検索・追加で「成年向けは追加できない」と
// 明示するのに使う（src/adult.ts findAdultIsbns）。
// R18版（my100shunga, SITE_VARIANT="adult"）は成年向けも収録する上位互換なので、--include-adult
// で同じダンプから別の出力を作る。see docs/r18.md 2 節
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
//   --include-adult      成年向けも本体表（volumes_new）へ入れる。R18版（--env r18 / r18dev）専用。
//                        adult_volumes_new は空で作る（src/adult.ts が表の存在を前提にするため）
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
  "name_kana_norm TEXT, name_search TEXT, creator TEXT, creators TEXT, creators_norm TEXT, publisher TEXT, label TEXT, num_items INTEGER, " +
  "is_adult INTEGER NOT NULL DEFAULT 0, version TEXT, name_display TEXT";
const VOLUMES_COLS =
  "isbn TEXT PRIMARY KEY, series_id TEXT, volume_number TEXT, vol_sort INTEGER, " +
  "title TEXT NOT NULL, subtitle TEXT, title_search TEXT, creator TEXT, creators TEXT, creators_norm TEXT, publisher TEXT, label TEXT, pubdate TEXT, " +
  "is_adult INTEGER NOT NULL DEFAULT 0";

// 成年向けとして取り込みから外した巻（db/schema.sql adult_volumes と揃える）。title_norm は
// searchKey(title)（src/search.ts のキーワード照合と同じ正規化）。
const ADULT_COLS = "isbn TEXT PRIMARY KEY, title TEXT NOT NULL, title_norm TEXT NOT NULL, series_name TEXT";

const DROP_AND_CREATE_SHADOW_SQL =
  "DROP TABLE IF EXISTS series_new; DROP TABLE IF EXISTS volumes_new; DROP TABLE IF EXISTS adult_volumes_new; " +
  `CREATE TABLE series_new (${SERIES_COLS}); ` +
  `CREATE TABLE volumes_new (${VOLUMES_COLS}); ` +
  `CREATE TABLE adult_volumes_new (${ADULT_COLS});`;

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
  `CREATE TABLE IF NOT EXISTS adult_volumes (${ADULT_COLS});`,
  "DROP TABLE IF EXISTS series_old;",
  "DROP TABLE IF EXISTS volumes_old;",
  "DROP TABLE IF EXISTS adult_volumes_old;",
  "ALTER TABLE series RENAME TO series_old;",
  "ALTER TABLE volumes RENAME TO volumes_old;",
  "ALTER TABLE adult_volumes RENAME TO adult_volumes_old;",
  "ALTER TABLE series_new RENAME TO series;",
  "ALTER TABLE volumes_new RENAME TO volumes;",
  "ALTER TABLE adult_volumes_new RENAME TO adult_volumes;",
  "DROP TABLE series_old;",
  "DROP TABLE volumes_old;",
  "DROP TABLE adult_volumes_old;",
  "CREATE INDEX IF NOT EXISTS idx_series_name_norm ON series (name_norm);",
  "CREATE INDEX IF NOT EXISTS idx_series_kana_norm ON series (name_kana_norm);",
  "CREATE INDEX IF NOT EXISTS idx_volumes_series ON volumes (series_id, vol_sort);",
  // db/add-indexes-2026-10.sql で足した索引。表を作り直すたびに張り直さないと消える。
  "CREATE INDEX IF NOT EXISTS idx_series_name_label ON series (name, label);",
  // db/add-circulation.sql で足した索引（暖機 src/warm.ts が巻数順にたどる）。
  "CREATE INDEX IF NOT EXISTS idx_series_num_items ON series (num_items DESC, id);",
  // db/add-label-tag.sql で足した索引（管理画面のレーベル管理が GROUP BY label で数える）。
  "CREATE INDEX IF NOT EXISTS idx_series_label ON series (label);",
  "CREATE INDEX IF NOT EXISTS idx_volumes_unlinked_title ON volumes (title, label) WHERE series_id IS NULL;",
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
    includeAdult: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--local") a.target = "local";
    else if (v === "--remote") a.target = "remote";
    else if (v === "--skip-download") a.skipDownload = true;
    else if (v === "--no-apply") a.apply = false;
    else if (v === "--include-adult") a.includeAdult = true;
    else if (v === "--tag") a.tag = argv[++i];
    else if (v === "--work") a.work = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--chunk") a.chunk = parseInt(argv[++i], 10);
    else if (v === "--limit") a.limit = parseInt(argv[++i], 10);
    else if (v === "--env") a.env = argv[++i];
    else throw new Error(`unknown flag: ${v}`);
  }
  if (!a.out) a.out = path.join(a.work, "seed");
  // 本家の D1 に成年向けを流し込む / R18版の D1 に成年向け抜きを流し込む、という取り違えは
  // どちらも master の作り直しでしか戻せないので、リモートに触るときだけ env と突き合わせる。
  // ローカル（--local）は試し取り込みの場なので縛らない。
  if (a.target === "remote") {
    const r18 = a.env.startsWith("r18");
    if (a.includeAdult && !r18) {
      throw new Error(`--include-adult は R18版の env でのみ使えます（--env r18 / r18dev）。今の --env は ${a.env || "（未指定＝本家の本番）"}`);
    }
    if (r18 && !a.includeAdult) {
      throw new Error(`--env ${a.env}（R18版）への取り込みには --include-adult が要ります（R18版は成年向けも収録する）`);
    }
  }
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

// 巻の副題（schema:alternateName の、読み仮名でない方）。MADB は「金田一少年の事件簿」のように
// schema:name をシリーズ名の繰り返しにして、事件名「獄門塾殺人事件」を alternateName に分けて持つ。
// これが無いと、巻番号が「上」「下」しか無い別作品が同じ巻として 1 冊に畳まれる（src/util.ts
// workKey）。読み（@language: "ja-hrkt"）は落とし、1 冊に複数ある（2 話収録の合本）ときは
// 「：」で繋ぐ — 書名側に「書名 : 副題 : 副題」と畳み込んである別の行と workKey で一致させるため。
function subtitle(v) {
  const arr = Array.isArray(v) ? v : [v];
  const all = [...new Set(arr.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean))];
  // 同じ副題を巻番号付きでも持っている行がある（「雪霊伝説殺人事件」と「雪霊伝説殺人事件 上」）。
  // 他の値を丸ごと含む値は重複なので落とし、短い方（作品名そのもの）を残す。
  const kept = all.filter((x) => !all.some((y) => y !== x && x.includes(y)));
  return kept.join("：");
}

// 版表示（schema:version）。同じ schema:name の別シリーズとして並ぶ版違い（新装版・完全版・
// 愛蔵版・大判…）を見分ける唯一のマスタ情報で、表示にだけ使う。see db/add-series-version.sql
//
// 落とすもの:
//   ・ASCII だけの値 … 外国語版の版表示（"1st ed." / "Wyd. 1." / "1a ed." 等 205 件）。
//     日本語のカードに出しても区別にならない。
//   ・シリーズ名・レーベルに既に入っている値 … 「ブラック・エンジェルズ」(レーベル
//     「集英社文庫 コミック版」) に「コミック版」を足しても同じことを二度言うだけ。
//     272 件がレーベル、14 件が名前と重複する。
function editionVersion(v, name, brand) {
  const ver = firstVariant(primary(v)).trim();
  if (!ver || /^[\x20-\x7e]+$/.test(ver)) return "";
  if (name.includes(ver) || (brand && brand.includes(ver))) return "";
  return ver;
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

// Fold ヴ行 to バ行 (ヴァ→バ … ヴ→ブ). MADB's own readings vary (デジャヴ／デジャブ), so the
// folded form of each reading is stored too and search folds the query the same way.
// Keep in sync with src/util.ts vuFold.
function vuFold(s) {
  return s.replace(/ヴ([ァィェォ])?/g, (_, v) => (v ? { ァ: "バ", ィ: "ビ", ェ: "ベ", ォ: "ボ" }[v] : "ブ"));
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
// Arc-prefixed label ("24億脱出編4", "第2部[9]") → arc × 1000 + volume. See src/util.ts.
const ARC_VOLUME_RE =
  /^[^／/]*?(\d+)[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}](?<![巻集])[^／/]*?(\d+)\]?$/u;
function volSort(raw) {
  const s = String(raw ?? "").trim();
  const arc = ARC_VOLUME_RE.exec(s);
  if (arc) return parseInt(arc[1], 10) * 1000 + parseInt(arc[2], 10);
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

// ── 成年向けの除外 ──────────────────────────────────────────────────────────
// 全年齢向けサイトなので成年コミックは取り込まない。判定は MADB の明示的なメタデータだけ:
// schema:contentRating（NDL 由来の「成年コミック」等。2026-09 のダンプで 8,317 巻）と、
// schema:description 末尾の「/ 成年コミック」。書名・レーベル・出版社の文字列照合は一般向けの
// 誤検出が多いので使わない（理由と実測は src/adult.ts）。src/adult.ts ADULT_RATING と揃えること。
const ADULT_RATING = /(?<!未)成年|成人/;
const ADULT_DESCRIPTION = /(?<!未)成年コミック|成人コミック|成年向け/;

function strings(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? x["@value"] : ""))
    .filter((x) => typeof x === "string" && x);
}

function isAdult(node) {
  return (
    strings(node["schema:contentRating"]).some((x) => ADULT_RATING.test(x)) ||
    strings(node["schema:description"]).some((x) => ADULT_DESCRIPTION.test(x))
  );
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
    ["id", "name", "name_norm", "name_kana", "name_kana_norm", "name_search", "creator", "creators", "creators_norm", "publisher", "label", "num_items", "version", "name_display"],
    a.chunk
  );
  let seriesCount = 0;
  // シリーズ名の引き当て用（成年向けの巻の series_name。成年向けだけのシリーズは series から
  // 消すので、ここで覚えておかないと名前が残らない）。
  const seriesNames = new Map();
  // 同名シリーズの検出用（name_display、下の「3.5」）。「同名」は検索の照合キー（name_search =
  // searchKey。記号と全角半角を落とした形）で見る: MADB は同じ作品を「ブラック・ジャック」
  // 「ブラックジャック」と中黒の有無で別シリーズに持っていて、name_norm（空白と大小だけを
  // 畳んだ形）では別名に見えてしまうが、利用者の検索では同じキーワードで並ぶ。
  // 数えるのは巻を読み終えてから（巻が 1 冊も残らないシリーズは検索にも出ないので数えない）。
  const seriesNameKeys = new Map(); // id → 検索の照合キー（name_search 相当）
  await streamGraph(seriesJson, (node) => {
    if (node["@type"] !== "class:MangaBookSeries") return;
    const id = (node["@id"] || "").startsWith(ID_PREFIX)
      ? node["@id"].slice(ID_PREFIX.length)
      : node["@id"];
    const name = primary(node["schema:name"]) || node["rdfs:label"] || "";
    if (!id || !name) return;
    seriesNames.set(id, name);
    // name_search は空になることがあり（記号だけの名前）、その場合 SQL 側は name_norm に
    // 落ちる（COALESCE(name_search, name_norm)）ので、ここでも同じ順で決める。
    seriesNameKeys.set(id, searchKey(name) || normTitle(name));
    const readings = kanaReadings(node["schema:name"]);
    const nameKana = readings.join(" / ");
    // Store each reading normalized and "|"-delimited so search can match either a
    // whole reading (exact tier) or a substring across the combined blob. A reading with
    // ヴ also gets its バ行-folded form (see vuFold) so a folded query matches it.
    const kanaNorm = [...new Set(readings.map(normTitle).flatMap((k) => [k, vuFold(k)]).filter(Boolean))].join("|");
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
      sqlStr(editionVersion(node["schema:version"], name, primary(node["schema:brand"]))),
      // name_display は巻を全部読まないと決まらないので、ここでは NULL。下の「3.5」で埋める。
      "NULL",
    ]);
    seriesCount++;
  });
  const seriesFiles = seriesWriter.finish();
  log(`series: ${seriesCount} rows → ${seriesFiles.length} files`);

  // 2. volumes (deduped by ISBN) → shadow table volumes_new, swapped in below.
  const volumesWriter = new SqlChunkWriter(
    a.out,
    "volumes_new",
    ["isbn", "series_id", "volume_number", "vol_sort", "title", "subtitle", "title_search", "creator", "creators", "creators_norm", "publisher", "label", "pubdate", "is_adult"],
    a.chunk
  );
  const seen = new Set();
  let volCount = 0;
  let processed = 0;
  let adultCount = 0;
  const adultWriter = new SqlChunkWriter(a.out, "adult_volumes_new", ["isbn", "title", "title_norm", "series_name"], a.chunk);
  const adultSeries = new Set(); // 成年向けの巻を持つシリーズ
  const keptSeries = new Set(); // 取り込んだ巻を持つシリーズ
  // シリーズごとの「全巻に共通する副題」（name_display、下の「3.5」）。値は副題の文字列、
  // null = 共通しない（副題の無い巻がある／複数種類ある）。取り込む巻だけを見る。
  const commonSubtitle = new Map();
  await streamGraph(volumesJson, (node) => {
    if (a.limit && processed >= a.limit) return;
    processed++;
    if (node["@type"] !== "class:MangaBook") return;
    const isbn = isbn13(node["schema:isbn"]);
    if (!isbn || seen.has(isbn)) return;
    const title = primary(node["schema:name"]) || node["rdfs:label"] || "";
    if (!title) return;
    seen.add(isbn); // 成年向けで落とす巻も seen に入れ、同じ ISBN の重複ノードから入り込ませない
    const seriesId = cid(node, "schema:isPartOf");
    // R18版（--include-adult）は成年向けも本体表に入れる。adult_volumes は空のままにして、
    // 「成年向けなので追加できません」を出す側（src/adult.ts findAdultIsbns）を無効にする。
    if (isAdult(node) && !a.includeAdult) {
      adultCount++;
      if (seriesId) adultSeries.add(seriesId);
      // 検索・追加で「成年向けは追加できません」と明示するために記録する（src/adult.ts）。
      adultWriter.add([sqlStr(isbn), sqlStr(title), sqlStr(searchKey(title) || normTitle(title) || title), sqlStr(seriesNames.get(seriesId) ?? null)]);
      return;
    }
    const adult = isAdult(node);
    if (adult) {
      adultCount++;
      if (seriesId) adultSeries.add(seriesId); // 下で series_new に印を付ける
    }
    if (seriesId) keptSeries.add(seriesId);
    const sub = subtitle(node["schema:alternateName"]);
    if (seriesId) {
      // 1 冊でも副題が無い／違えば、そのシリーズは共通副題なし。null は上書きされない
      // （null !== sub なので、一度 null になったらそのまま）。
      if (!commonSubtitle.has(seriesId)) commonSubtitle.set(seriesId, sub || null);
      else if (commonSubtitle.get(seriesId) !== sub) commonSubtitle.set(seriesId, null);
    }
    const vnum = primary(node["schema:volumeNumber"]);
    volumesWriter.add([
      sqlStr(isbn),
      sqlStr(seriesId),
      sqlStr(vnum),
      sqlInt(volSort(vnum)),
      sqlStr(title),
      sqlStr(sub),
      sqlStr(searchKey(title)),
      sqlStr(cleanCreator(pickCreator(node["schema:creator"]))),
      sqlStr(creatorsDisplay(node["schema:creator"])),
      sqlStr(creatorsNorm(node["schema:creator"])),
      sqlStr(firstVariant(primary(node["schema:publisher"]))),
      sqlStr(firstVariant(primary(node["schema:brand"]))),
      sqlStr(primary(node["schema:datePublished"])),
      sqlInt(adult ? 1 : 0),
    ]);
    volCount++;
  });
  const volumeFiles = volumesWriter.finish();
  const adultFiles = adultWriter.finish();
  log(
    a.includeAdult
      ? `volumes: ${volCount} rows → ${volumeFiles.length} files (成年向け ${adultCount} 巻を含む。adult_volumes は空)`
      : `volumes: ${volCount} rows → ${volumeFiles.length} files (成年向け ${adultCount} 巻を除外し adult_volumes へ)`
  );

  // 本家: 成年向けの巻しか持たないシリーズは series_new から消す（巻が 0 になったシリーズを検索・
  // 収録数に残さない）。一般向けの巻も持つシリーズは残す。volumes_new の読み込み後に流す。
  // R18版 (--include-adult): 消さずに is_adult の印を付ける。検索の既定の絞り込みに使う
  // （src/search.ts）。シリーズは巻より先に書き出し済みなので、あとから UPDATE で立てる。
  const pruneIds = a.includeAdult ? [] : [...adultSeries].filter((id) => !keptSeries.has(id));
  const markIds = a.includeAdult ? [...adultSeries] : [];
  const pruneFile = path.join(a.out, a.includeAdult ? "series_new_mark_adult.sql" : "series_new_prune_adult.sql");
  const pruneStmts = [];
  // keptSeries（一般向けの巻を 1 冊でも残したシリーズ）を除いた後なので、ここで volumes_new を
  // 見直す必要はない。NOT EXISTS で volumes_new を引くと、取り込み中の volumes_new には
  // series_id の索引が無く ID ごとに全件走査になって D1 の CPU 上限で落ちる（2026-10-03 dev で発生）。
  for (let i = 0; i < pruneIds.length; i += 500) {
    pruneStmts.push(`DELETE FROM series_new WHERE id IN (${pruneIds.slice(i, i + 500).map(sqlStr).join(",")});\n`);
  }
  for (let i = 0; i < markIds.length; i += 500) {
    pruneStmts.push(
      `UPDATE series_new SET is_adult = 1 WHERE id IN (${markIds.slice(i, i + 500).map(sqlStr).join(",")});\n`
    );
  }
  fs.writeFileSync(pruneFile, pruneStmts.join(""));
  log(
    a.includeAdult
      ? `series: 成年向けの巻を持つシリーズ ${markIds.length} 件に is_adult を立てる（除外はしない）`
      : `series: 成年向けの巻だけのシリーズ ${pruneIds.length} 件を除外予定`
  );

  // 3.5 表示用のシリーズ名（series_new.name_display）。MADB のシリーズ名だけでは同名シリーズを
  // 見分けられないので（「釣りキチ三平」は 6 件ある）、全ての巻が同じ副題を名乗るシリーズには
  // その副題を足した名前を持たせる（C328373 →「釣りキチ三平 作者自選集」）。本の表示タイトルは
  // 「書名 + 巻 + 副題」なので（public/app.js bookTitle）、本が「釣りキチ三平 1 作者自選集」と
  // 出るのにシリーズ名だけ素の「釣りキチ三平」、という状態を無くすのが目的。
  // 同名シリーズが無ければ足さない: 副題は惹句や英語別名のことも多く（「HEAT」の「灼熱」、
  // 「SWAN」の「白鳥」）、もともと曖昧でない名前を長くするだけになる。「同名」は検索の照合キー
  // （name_search）で見るので、中黒の有無だけが違う「ブラック・ジャック」と「ブラックジャック」
  // （C294944 →「ブラックジャック 黒い医師」）のような表記ゆれの同名も拾う。
  // 表示専用で、照合（name_norm / name_search）にも迷子巻の引き当て（巻の title との完全一致）
  // にも使わない。see db/schema.sql series.name_display / db/add-series-name-display.sql
  const displayFile = path.join(a.out, "series_new_name_display.sql");
  // 同名かどうかは、巻が 1 冊でも残るシリーズ（keptSeries）だけで数える。巻の無いシリーズと
  // 成年向けだけで消えるシリーズは検索にも巻一覧にも出てこないので、同名の相手にならない。
  const nameKeyCounts = new Map();
  for (const id of keptSeries) {
    const key = seriesNameKeys.get(id);
    if (key) nameKeyCounts.set(key, (nameKeyCounts.get(key) ?? 0) + 1);
  }
  const displayStmts = [];
  for (const [id, sub] of commonSubtitle) {
    if (!sub) continue;
    const name = seriesNames.get(id);
    if (!name) continue;
    // 「：」は、1 冊に複数の schema:alternateName がある合本を上の subtitle() が繋いだ印。
    // その巻の収録内容であってシリーズの副題ではない。
    if (sub.includes("：")) continue;
    if ((nameKeyCounts.get(seriesNameKeys.get(id)) ?? 0) < 2) continue;
    // 名前が既に副題を含むなら足さない（「あした天気になあれ 全英オープン編」）。
    if (normTitle(name).includes(normTitle(sub))) continue;
    displayStmts.push(
      `UPDATE series_new SET name_display = ${sqlStr(`${name} ${sub}`)} WHERE id = ${sqlStr(id)};\n`
    );
  }
  fs.writeFileSync(displayFile, displayStmts.join(""));
  log(`series: 同名シリーズと見分けるため ${displayStmts.length} 件に副題付きの表示名を付ける`);

  // Emit a manifest so a resumable per-day loader (scripts/seed-daily.mjs) can
  // budget exactly how many rows each file writes, in apply order.
  const manifest = {
    tag: releaseTag,
    releasedAt,
    chunk: a.chunk,
    files: [
      ...seriesFiles.map((f) => ({ file: path.basename(f.path), table: "series", rows: f.rows })),
      ...volumeFiles.map((f) => ({ file: path.basename(f.path), table: "volumes", rows: f.rows })),
      ...adultFiles.map((f) => ({ file: path.basename(f.path), table: "adult_volumes", rows: f.rows })),
      // 書き込みではなく削除。volumes の後に流す。
      {
        file: path.basename(pruneFile),
        table: a.includeAdult ? "series_mark_adult" : "series_prune",
        rows: a.includeAdult ? markIds.length : pruneIds.length,
      },
      // 書き込みではなく更新。series・volumes の後に流す。
      { file: path.basename(displayFile), table: "series_name_display", rows: displayStmts.length },
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
  //    remote は `d1 execute --file`（D1 の import API）を使わない。import は 1 ファイルごとに
  //    DB 全体を止めるので、取り込み中にサイトの検索・公開などが 500 になり、逆にサイトの
  //    クエリが import を「Not currently importing anything」で落とす（2026-10-03 本番で発生）。
  //    代わりに通常のクエリ API（/query）へ小分けに投げ、利用者のクエリと交互に処理させる。
  const loadFiles = [...seriesFiles, ...volumeFiles, ...adultFiles].map((f) => f.path);
  if (pruneStmts.length) loadFiles.push(pruneFile);
  if (displayStmts.length) loadFiles.push(displayFile);
  if (a.target === "remote") {
    const conn = await remoteD1(envArgs);
    for (const file of loadFiles) {
      log("apply", path.basename(file));
      await applyFileViaQueryApi(conn, file);
    }
  } else {
    for (const file of loadFiles) {
      log("apply", path.basename(file));
      execWrangler(envArgs, targetFlag, "--file", file);
    }
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
    log(`--limit ${a.limit}: loaded series_new / volumes_new / adult_volumes_new only; skipped swap (live tables untouched).`);
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
  // トップの収録数（シリーズ数・巻数）は meta に 1 日 materialize している（src/siteStats.ts）。
  // 取り込み直後に古い数を 1 日出し続けないよう、そのキャッシュだけ消す（次の閲覧で数え直す）。
  const metaSql =
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); " +
    "DELETE FROM meta WHERE key IN ('site_stats_master_json', 'site_stats_master_at'); " +
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

// ── remote: D1 の通常クエリ API で shadow 表へ投入 ──────────────────────────
// 認証・対象 DB は wrangler と同じものを使う: トークンは CLOUDFLARE_API_TOKEN（CI）か
// `wrangler auth token`（ローカルの OAuth ログイン）、アカウントは CLOUDFLARE_ACCOUNT_ID か
// whoami の唯一のアカウント、DB は `wrangler d1 info DB [--env]` の uuid。

// 1 リクエストの SQL の上限。D1 は 1 文 100KB まで（生成 SQL の 1 文は最大 30KB 程度）。
// 1 回の処理を数百 ms に抑えて、その間に利用者のクエリが待たされすぎないようにする。
const QUERY_BATCH_BYTES = 200_000;
// バッチの間に空ける時間。利用者のクエリが割り込めるように。
const QUERY_BATCH_PAUSE_MS = 50;

function wranglerJson(args) {
  const out = execFileSync("npx", ["wrangler", ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(out);
}

async function remoteD1(envArgs) {
  const token = process.env.CLOUDFLARE_API_TOKEN || wranglerJson(["auth", "token"]).token;
  if (!token) throw new Error("no Cloudflare API token (set CLOUDFLARE_API_TOKEN or run `wrangler login`)");
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const accounts = wranglerJson(["whoami"]).accounts ?? [];
    if (accounts.length !== 1) throw new Error("set CLOUDFLARE_ACCOUNT_ID (multiple or no accounts)");
    accountId = accounts[0].id;
  }
  const dbId = wranglerJson(["d1", "info", DB_BINDING, ...envArgs]).uuid;
  if (!dbId) throw new Error("could not resolve D1 database id");
  return { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`, token };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 投入は INSERT OR REPLACE / DELETE なので、同じバッチを流し直しても結果は変わらない。
// 429・5xx・通信エラーは間を空けてリトライする。
async function d1Query(conn, sql, attempts = 6) {
  for (let i = 1; ; i++) {
    let detail;
    try {
      const res = await fetch(conn.url, {
        method: "POST",
        headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) return;
      detail = `${res.status} ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`;
      // 4xx（429 以外）は SQL かリクエストの誤りなのでリトライしない。
      if (res.status < 500 && res.status !== 429) throw new Error(`D1 query failed: ${detail}`);
    } catch (err) {
      if (String(err.message).startsWith("D1 query failed")) throw err;
      detail = err.message;
    }
    if (i >= attempts) throw new Error(`D1 query failed after ${attempts} attempts: ${detail}`);
    const wait = Math.min(2 ** i, 30) * 1000;
    log(`  retry in ${wait / 1000}s (${detail})`);
    await sleep(wait);
  }
}

// 生成 SQL の文は INSERT OR REPLACE / DELETE で始まり「;\n」で終わる（SqlChunkWriter と
// prune の書き方）。値の中の「;\n」で切らないよう、次の文の頭も見て区切る。
function splitStatements(sqlText) {
  return sqlText
    .split(/;\n(?=INSERT OR REPLACE INTO |DELETE FROM )/)
    .map((x) => x.trim().replace(/;$/, ""))
    .filter(Boolean)
    .map((x) => x + ";");
}

async function applyFileViaQueryApi(conn, file) {
  const stmts = splitStatements(fs.readFileSync(file, "utf8"));
  let batch = [];
  let bytes = 0;
  let done = 0;
  const flush = async () => {
    if (!batch.length) return;
    await d1Query(conn, batch.join("\n"));
    done += batch.length;
    batch = [];
    bytes = 0;
    await sleep(QUERY_BATCH_PAUSE_MS);
  };
  for (const st of stmts) {
    const n = Buffer.byteLength(st);
    if (bytes + n > QUERY_BATCH_BYTES) await flush();
    batch.push(st);
    bytes += n;
  }
  await flush();
  log(`  ${done} statements`);
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
