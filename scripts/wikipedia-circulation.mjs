#!/usr/bin/env node
// 発行部数ランキングの取り込み。英語版 Wikipedia「List of best-selling manga」の表を
// 取って db/circulation-data.sql を書き出す（src/circulation.ts が読む circulation 表）。
//
// この記事は累計 2000 万部以上の約 200 作品を部数の降順で載せたもので、各行の部数セルには
// 並べ替え用の {{dsv|<千部>}} が入っているため機械可読。日本語の作品名は記事そのものには
// 無いので、各作品の記事から ja へのランク間リンク（langlinks）を引いて補う。
//
// ライセンス: Wikipedia 本文は CC BY-SA 4.0。取り込むのは作品名・著者・出版社・部数・
// 出典の時点という事実の列だけで、注記などの文章は持ち込まない。公開ページ
// (public/circulation.html) に出典・ライセンス・改変の明示を出す（表示側の要件は
// そちらに書いてある）。取得した版（oldid）を meta に残し、出典リンクはその版を指す。
//
// Usage:
//   node scripts/wikipedia-circulation.mjs                 # db/circulation-data.sql を書く
//   node scripts/wikipedia-circulation.mjs --out /tmp/x.sql
//   node scripts/wikipedia-circulation.mjs --json          # SQL ではなく JSON を標準出力へ（確認用）
//   node scripts/wikipedia-circulation.mjs --cache /tmp/wiki.json   # 取得結果を使い回す
//
// 書き出した SQL の流し方は db/MIGRATIONS.md（add-circulation.sql → circulation-data.sql）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARTICLE = "List of best-selling manga";
const API = "https://en.wikipedia.org/w/api.php";
const UA = "my100manga/0.1 (https://my100manga.com; info@harine.jp)";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

async function api(params) {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", ...params })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`MediaWiki API ${res.status} ${res.statusText} for ${url.searchParams.get("prop")}`);
  const body = await res.json();
  if (body.error) throw new Error(`MediaWiki API error: ${body.error.code} ${body.error.info}`);
  return body;
}

// ── wikitext の下ごしらえ ────────────────────────────────────────────────────

/** <ref>…</ref> と <ref … /> を全部外す。 */
const stripRefs = (s) => s.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");

/** 括弧・テンプレート・ref の入れ子を数えながら、深さ 0 の sep で切る。
 *  表のセル区切り "||" は素の split だと {{Transliteration|ja|…}} の中の "|" まで拾ってしまう。 */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let ref = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("{{", i) || s.startsWith("[[", i)) (depth++, i++);
    else if (s.startsWith("}}", i) || s.startsWith("]]", i)) (depth = Math.max(0, depth - 1), i++);
    else if (/^<ref[\s>]/i.test(s.slice(i, i + 5))) ref++;
    else if (s.startsWith("</ref>", i)) (ref = Math.max(0, ref - 1), (i += 5));
    else if (depth === 0 && ref === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** テンプレートの引数（{{nowrap|X}} → ["X"]）。名前付き引数（|date=…）も値のまま返す。 */
const tmplArgs = (body) => splitTop(body, "|").slice(1);

const ILL_RE = /\{\{\s*(?:ill|interlanguage link)\s*\|([^{}]*)\}\}/i;

/** テンプレート引数の「3=」のような位置指定を外す。 */
const unnumbered = (a) => String(a ?? "").replace(/^\s*\d+\s*=/, "").trim();

/** wikitext → 表示文字列。リンク・強調・よく出るテンプレートを外して素のテキストにする。 */
function plain(s) {
  let t = stripRefs(s);
  // 英語版に記事が無い作品は {{ill|Gaki Deka|ja|がきデカ}}（= Interlanguage link）で書かれる。
  // 最初の引数が英題。日本語名は illJa で別に拾う。
  t = t.replace(new RegExp(ILL_RE.source, "gi"), (_m, body) => unnumbered(splitTop(body, "|")[0]));
  // {{Transliteration|ja|X}} / {{nowrap|X}} / {{lang|ja|X}} は最後の引数が本文。
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/\{\{\s*(transliteration|nowrap|lang|nihongo|small|sortname)\s*\|([^{}]*)\}\}/gi, (_m, _n, body) => {
      const args = tmplArgs("x|" + body).filter((a) => !/^\s*\w+\s*=/.test(a));
      return args[args.length - 1] ?? "";
    });
  }
  return t
    .replace(/\{\{[^{}]*\}\}/g, " ") // 残りのテンプレート（{{dsv}}, {{†}} 等）
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<br\s*\/?>/gi, "、")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** セル内の最初の [[記事名]] / [[記事名|表示]] の記事名。 */
function firstLink(s) {
  const m = stripRefs(s).match(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/);
  return m ? m[1].trim().replace(/_/g, " ") : "";
}

/** {{ill|<英題>|ja|<日本語名>}} の日本語名。英語版に記事が無い作品はこれで日本語名が取れる
 *  （langlinks を引く必要が無い）。 */
function illJa(s) {
  const m = stripRefs(s).match(ILL_RE);
  if (!m) return "";
  const args = splitTop(m[1], "|").map((a) => a.trim());
  const i = args.findIndex((a) => a === "ja");
  return i < 0 ? "" : unnumbered(args[i + 1]);
}

// ja.wikipedia の記事名は作品名そのものではなく、曖昧さ回避の括弧や副題が付く
// （「キングダム (漫画)」「NARUTO -ナルト-」「最遊記シリーズ」）。表示にも突き合わせにも
// 邪魔なので外す。外しすぎると別作品に寄ってしまうので、曖昧さ回避は中身が作品の種別を
// 指すものだけ、副題は区切り記号で閉じているものだけに限る。
const DISAMBIG_RE = /[\s　]*[（(][^（()）]*(?:漫画|マンガ|まんが|作品|小説|アニメ|ゲーム)[^（()）]*[）)][\s　]*$/;
const DASH_SUBTITLE_RE = /[\s　]*[-－‐―—][^-－‐―—]{2,}[-－‐―—][\s　]*$/;
const WAVE_SUBTITLE_RE = /[\s　]*[〜～~][^〜～~]{2,}[〜～~][\s　]*$/;

function cleanJaTitle(raw) {
  let t = String(raw).replace(DISAMBIG_RE, "").trim();
  t = t.replace(DASH_SUBTITLE_RE, "").trim();
  t = t.replace(WAVE_SUBTITLE_RE, "").trim();
  // 末尾の「シリーズ」は落とさない。「ひみつシリーズ」→「ひみつ」のように一般名詞になると、
  // 同名の無関係な作品へ寄ってしまう（実際に 1 巻の別作品に当たった）。まとめ記事になっている
  // 作品は、寄せたい先が決まっているものだけ TITLE_OVERRIDES で明示する。
  return t || String(raw);
}

/** 部数セルの {{dsv|600000}}（単位は千部）→ 部数。無ければ本文の「600 million」から拾う。 */
function copiesOf(cell) {
  const dsv = cell.match(/\{\{\s*dsv\s*\|\s*([\d,]+)/i);
  if (dsv) return Number(dsv[1].replace(/,/g, "")) * 1000;
  const txt = plain(cell);
  const m = txt.match(/([\d.]+)\s*(million|billion)/i);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2].toLowerCase() === "billion" ? 1e9 : 1e6));
}

const MONTHS = "january february march april may june july august september october november december".split(" ");

/** 「March 3, 2026」「2026-03-03」→「2026-03」。 */
function ym(raw) {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/([A-Za-z]+)\s+\d{1,2},?\s*(\d{4})/) || s.match(/([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const i = MONTHS.indexOf(m[1].toLowerCase());
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})$/);
  return m ? m[1] : "";
}

/** 部数セルの出典（最初の <ref>）から時点と URL を拾う。date を優先し、無ければ access-date。 */
function sourceOf(cell) {
  const ref = cell.match(/<ref[^>]*>([\s\S]*?)<\/ref>/i);
  if (!ref) return { as_of: "", url: "" };
  const body = ref[1];
  const field = (name) => {
    const m = body.match(new RegExp(`\\|\\s*${name}\\s*=\\s*([^|}]+)`, "i"));
    return m ? m[1].trim() : "";
  };
  return { as_of: ym(field("date") || field("access-date") || field("accessdate")), url: field("url") };
}

// ── 表のパース ──────────────────────────────────────────────────────────────

/** 記事の wikitext → 行の配列。見出しの直後の wikitable だけを対象にする。
 *  列が足りない行は落とすが、記事の表の形が変わったときに黙って減らないよう必ず報告する。 */
function parseTables(wikitext) {
  const rows = [];
  const skipped = [];
  for (const table of wikitext.matchAll(/\{\|\s*class="wikitable[\s\S]*?\n\|\}/g)) {
    const lines = table[0].split("\n");
    let cells = null;
    const flush = () => {
      if (cells && cells.length >= 7) rows.push(cells);
      else if (cells && cells.length) skipped.push(`${cells.length} 列: ${plain(cells[0]).slice(0, 60)}`);
      cells = null;
    };
    for (const line of lines) {
      if (line.startsWith("|-")) (flush(), (cells = []));
      else if (line.startsWith("!") || line.startsWith("|}") || line.startsWith("{|")) flush();
      else if (cells && line.startsWith("|")) cells.push(...splitTop(line.replace(/^\|+/, ""), "||"));
      else if (cells && cells.length && line.trim()) cells[cells.length - 1] += "\n" + line; // 折り返した ref
    }
    flush();
  }
  if (skipped.length) {
    process.stderr.write(`列が足りず落とした行 ${skipped.length} 件:\n`);
    for (const s of skipped) process.stderr.write(`  ${s}\n`);
  }
  // 列は「作品 / 著者 / 出版社 / 読者層 / 巻数 / 連載期間 / 部数」。
  return rows.map((c) => {
    const { as_of, url } = sourceOf(c[6]);
    return {
      // 英語版に記事が無い作品（{{ill}}）は記事名が無いので英題をキーにする。
      article: firstLink(c[0]) || plain(c[0]),
      title_en: plain(c[0]),
      title_ja_hint: illJa(c[0]),
      author: plain(c[1]),
      publisher: plain(c[2]),
      copies: copiesOf(c[6]),
      as_of,
      source_url: /^https?:\/\//.test(url) ? url : "",
    };
  });
}

// ── 日本語の作品名（langlinks） ───────────────────────────────────────────────

// 英語版の記事に ja へのリンクが無いもの。日本語版の記事名を手で補う（実行時に
// 「no ja link」として報告されるので、増えたらここに足す）。
//   Dragon Ball (manga) … ja の「ドラゴンボール」は作品全体の記事と結ばれていて漫画の記事には ja リンクが無い
//   The Chef (manga)    … en 側に ja へのリンクが無い
const JA_OVERRIDES = new Map([
  ["Dragon Ball (manga)", "ドラゴンボール"],
  ["The Chef (manga)", "ザ・シェフ"],
]);

// ウィキペディアの日本語記事名と、当サイトのマスタ（MADB）の書名が食い違うもの。cleanJaTitle
// では寄らない表記ゆれだけを手で対応付ける（管理画面の「巻一覧へのリンクが付かなかった作品」に
// 出てきたものを、マスタ側の書名で埋める）。表示名もこちらになる。
// 寄せると部数の出どころと別の作品を指してしまうもの（涼宮ハルヒ = 小説の部数、
// ビー・バップ・ハイスクール = マスタには映画版しか無い）は、あえて入れずリンク無しで出す。
const TITLE_OVERRIDES = new Map([
  ["Yu-Gi-Oh!", "遊・戯・王"], // マスタは中黒
  ["Tokyo Ghoul", "東京喰種"], // 記事名は読みを連結した「東京喰種トーキョーグール」
  ["Oshi no Ko", "推しの子"], // 記事名は【】付き
  ["Minami no Teiō", "ミナミの帝王"], // 記事名は「難波金融伝・ミナミの帝王」
  ["Jingi (manga)", "仁義"], // 記事名は「JINGI 仁義」
  ["Dragon Quest: The Adventure of Dai", "ドラゴンクエスト ダイの大冒険"],
  ["Dragon Quest Retsuden: Roto no Monshō", "ロトの紋章"],
  ["Shōnen Shōjo Nippon no Rekishi", "少年少女日本の歴史"], // 記事名は「学習漫画」
  ["Saiyuki (manga)", "最遊記"], // 記事名は「最遊記シリーズ」（続編をまとめたもの）→ 本編へ
]);

/** 英語版の記事名 → 日本語版の記事名。50 件ずつ問い合わせ、リダイレクト・正規化を戻す。 */
async function japaneseTitles(articles) {
  const out = new Map();
  for (let i = 0; i < articles.length; i += 50) {
    const chunk = articles.slice(i, i + 50);
    const body = await api({
      action: "query",
      prop: "langlinks",
      lllang: "ja",
      lllimit: "500",
      redirects: "1",
      titles: chunk.join("|"),
    });
    const q = body.query ?? {};
    // 問い合わせた名前 → API が実際に返したページ名（正規化 → リダイレクトの順にたどる）。
    const alias = new Map();
    for (const n of [...(q.normalized ?? []), ...(q.redirects ?? [])]) alias.set(n.from, n.to);
    const resolve = (name) => {
      let cur = name;
      for (let n = 0; n < 5 && alias.has(cur); n++) cur = alias.get(cur);
      return cur;
    };
    const byTitle = new Map((q.pages ?? []).map((p) => [p.title, p.langlinks?.[0]?.title ?? ""]));
    for (const a of chunk) {
      const ja = byTitle.get(resolve(a)) ?? "";
      if (ja) out.set(a, ja);
    }
    process.stderr.write(`  langlinks ${Math.min(i + 50, articles.length)}/${articles.length}\n`);
  }
  return out;
}

// ── SQL ─────────────────────────────────────────────────────────────────────

const q = (s) => "'" + String(s ?? "").replace(/'/g, "''") + "'";

function toSql(entries, source) {
  const now = Date.now();
  const values = entries.map(
    (e) =>
      `  (${q(e.article)}, ${q(e.title_ja)}, ${q(e.title_en)}, ${q(e.author)}, ${q(e.publisher)}, ` +
      `${e.copies}, ${q(e.as_of)}, ${q(e.source_url)}, ${now})`
  );
  return (
    `-- 発行部数ランキングのデータ。scripts/wikipedia-circulation.mjs が生成（手で編集しない）。\n` +
    `-- 出典: ${source.url}\n` +
    `-- 取得: ${source.retrieved}（oldid ${source.revid} / 最終更新 ${source.touched}）\n` +
    `-- Wikipedia 本文は CC BY-SA 4.0。持ち込むのは事実の列だけ（注記などの文章は入れない）。\n` +
    `-- 全件を入れ替える。add-circulation.sql を流した後に実行する。\n` +
    `DELETE FROM circulation;\n` +
    `INSERT INTO circulation\n` +
    `  (article, title_ja, title_en, author, publisher, copies, as_of, source_url, updated_at)\n` +
    `VALUES\n${values.join(",\n")};\n` +
    `INSERT INTO meta (key, value) VALUES ('circulation_source', ${q(JSON.stringify(source))})\n` +
    `  ON CONFLICT(key) DO UPDATE SET value = excluded.value;\n` +
    `-- 取り込み後に管理画面の「発行部数ランキング」で再集計する（作品 → シリーズの突き合わせ）。\n` +
    `DELETE FROM meta WHERE key IN ('circulation_ranking_json', 'circulation_ranking_at');\n`
  );
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const cache = arg("--cache");
  let page;
  if (cache && fs.existsSync(cache)) {
    page = JSON.parse(fs.readFileSync(cache, "utf8"));
  } else {
    process.stderr.write(`fetching "${ARTICLE}" …\n`);
    const body = await api({
      action: "query",
      prop: "revisions|info",
      rvprop: "content|ids|timestamp",
      rvslots: "main",
      titles: ARTICLE,
    });
    page = body.query.pages[0];
    if (!page || page.missing) throw new Error(`article not found: ${ARTICLE}`);
    if (cache) fs.writeFileSync(cache, JSON.stringify(page));
  }

  const rev = page.revisions[0];
  const source = {
    url: `https://en.wikipedia.org/wiki/Special:PermanentLink/${rev.revid}`,
    page_url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(ARTICLE.replace(/ /g, "_")),
    title: ARTICLE,
    revid: rev.revid,
    touched: String(rev.timestamp).slice(0, 10),
    retrieved: new Date().toISOString().slice(0, 10),
    license: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0/deed.ja",
  };

  const rows = parseTables(rev.slots.main.content).filter((r) => r.article && r.copies > 0);
  process.stderr.write(`parsed ${rows.length} rows\n`);
  if (rows.length < 150) throw new Error(`too few rows (${rows.length}) — 記事の表の形が変わった可能性`);

  // 同じ記事が複数の表に出ることは無いはずだが、念のため部数の大きい方を残す。
  const byArticle = new Map();
  for (const r of rows) {
    const prev = byArticle.get(r.article);
    if (!prev || r.copies > prev.copies) byArticle.set(r.article, r);
  }
  const entries = [...byArticle.values()].sort((a, b) => b.copies - a.copies);

  // 日本語名は {{ill}} に書いてあればそれ、無ければ langlinks、最後に手当ての表。
  const needLink = entries.filter((e) => !e.title_ja_hint && !JA_OVERRIDES.has(e.article));
  const ja = await japaneseTitles(needLink.map((e) => e.article));
  const missing = [];
  const cleaned = [];
  for (const e of entries) {
    const raw = e.title_ja_hint || ja.get(e.article) || JA_OVERRIDES.get(e.article) || "";
    e.title_ja = TITLE_OVERRIDES.get(e.article) || (raw ? cleanJaTitle(raw) : "");
    if (raw && !TITLE_OVERRIDES.has(e.article) && e.title_ja !== raw) cleaned.push(`${raw} → ${e.title_ja}`);
    if (!e.title_ja) (missing.push(e), (e.title_ja = e.title_en));
    delete e.title_ja_hint;
  }
  process.stderr.write(`japanese titles: ${entries.length - missing.length}/${entries.length}\n`);
  if (missing.length) {
    process.stderr.write(`  no ja link（JA_OVERRIDES に足す）: ${missing.map((e) => e.article).join(", ")}\n`);
  }
  // 装飾を外した作品名は、別作品に寄っていないか目で確かめる（管理画面の「リンクが付かなかった
  // 作品」には出ないので、ここで出しておく）。
  if (cleaned.length) {
    process.stderr.write(`記事名から装飾を外した作品 ${cleaned.length} 件:\n`);
    for (const c of cleaned) process.stderr.write(`  ${c}\n`);
  }

  if (has("--json")) {
    process.stdout.write(JSON.stringify({ source, entries }, null, 2) + "\n");
    return;
  }
  const out = arg("--out", path.join(ROOT, "db", "circulation-data.sql"));
  fs.writeFileSync(out, toSql(entries, source));
  process.stderr.write(`wrote ${out} (${entries.length} works)\n`);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
