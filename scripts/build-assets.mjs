#!/usr/bin/env node
// 本番に配る静的アセットを public/ から dist/public/ へ作る。コメントを落とすのが目的。
//
// なぜ: public/ 配下はブラウザにそのまま配られる（wrangler.jsonc の assets）。実装メモや
// 設計の経緯を書いたコメントも一緒に公開されるので、配る分だけ落とす。元の public/ は
// 一切触らないので、コメント（＝文脈）はそのまま手元と git に残る。see docs/build-assets.md
//
// 落とし方:
//   .js  … esbuild の minifyWhitespace（識別子は変えない）。コメントと余白だけ消える。
//   .css … 同上（loader: css）。
//   .html… コメントを消す。ただし Worker が差し込みに使う <!--ANALYTICS--> 等の
//          プレースホルダ（PLACEHOLDER_RE）は残す。消すと差し込みが効かなくなる。
//          インラインの <script> / <style> の中身も同じ要領で落とす。
//   それ以外（画像・フォント・ライセンス文・ads.txt）… そのままコピー。
//
// 識別子の圧縮（esbuild の --minify 相当）はしない。public/*.js は素のクラシックスクリプトで
// window 越しに名前を共有しており（window.MyLists 等）、HTML の onclick からも呼ぶので、
// 名前を変えると壊れうる。コメント除去が目的なので、そこまでは踏み込まない。

import { createRequire } from "node:module";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "public");
const OUT = path.join(ROOT, "dist", "public");

// Worker が差し込みに使うプレースホルダ（src/index.ts / src/analytics.ts）。これだけは残す。
const PLACEHOLDER_RE = /^<!--[A-Za-z0-9_]+-->$/;

// 消してはいけないコメント。上のプレースホルダと、ライセンス・帰属表記。後者は楽天・Yahoo! の
// クレジットスニペットのように「改変せずそのまま載せる」ことが条件になっているものがあるため
// （いまは src/footer.ts が配信時に差し込んでいるので public/ には無いが、将来 HTML に直接
// 置かれたときに黙って消さない）。
const KEEP_COMMENT_RE = /@license|@preserve|copyright|\(c\)\s*\d|spdx-|attribution/i;

function keepComment(comment) {
  const inner = comment.trim();
  return PLACEHOLDER_RE.test(inner) || KEEP_COMMENT_RE.test(inner);
}

const stats = { js: 0, css: 0, html: 0, copied: 0, bytesIn: 0, bytesOut: 0 };

async function transform(code, loader) {
  const res = await esbuild.transform(code, {
    loader,
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    // ライセンス表記（/*! … */ や @license / @preserve）はその場に残す。実装メモだけ落とす。
    legalComments: "inline",
  });
  return res.code;
}

async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...args) => {
    jobs.push(fn(...args));
    return "";
  });
  const done = await Promise.all(jobs);
  let i = 0;
  return str.replace(re, () => done[i++]);
}

// 退避した塊を差し戻すときの目印。本文に出てこない制御文字（U+0001）で囲む。"VAULT1" の
// ような普通の語だと、同じ綴りが本文にあったときに差し戻しで中身をねじ込んでしまう。
const MARK = "\u0001";

/** HTML から説明コメントを落とす。<script> / <style> / <pre> の中身は先に退避しておく
 *  （中に "<!--" や "-->" が現れてもコメント除去が暴れないように）。 */
async function stripHtml(html) {
  if (html.includes(MARK)) throw new Error("本文に U+0001 が含まれている（退避の目印と衝突する）");
  const vault = [];
  const stash = (text) => {
    vault.push(text);
    return `${MARK}${vault.length - 1}${MARK}`;
  };

  let out = html;
  // インラインの <script>（src 付きは中身が空なので実質対象外）。
  out = await replaceAsync(
    out,
    /(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi,
    async (_m, open, body, close) => {
      const type = /\btype=["']?([^"'\s>]+)/i.exec(open)?.[1] ?? "";
      // JSON-LD など JavaScript でないものは触らない。
      const code = !type || /javascript|module/i.test(type) ? await transform(body, "js") : body;
      return stash(open + code + close);
    }
  );
  out = await replaceAsync(out, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (_m, open, body, close) =>
    stash(open + (await transform(body, "css")) + close)
  );
  // <pre> / <textarea> の中身はそのまま画面に出るので触らない。
  out = out.replace(/<(pre|textarea)\b[\s\S]*?<\/\1>/gi, (m) => stash(m));

  // 残ったコメントを落とす（プレースホルダは残す）。行がコメントだけならその行ごと消す。
  out = out.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n|<!--[\s\S]*?-->/gm, (m) =>
    keepComment(m) ? m : ""
  );

  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, i) => vault[Number(i)]);
}

/** 出来上がった HTML の検算。プレースホルダが 1 つでも欠けると Worker の差し込み
 *  （Google タグ・ヘッダー・フッター・OGP）が黙って効かなくなるので、ここで止める。 */
function verifyHtml(relPath, before, after) {
  const marks = (s) => (s.match(/<!--[A-Za-z0-9_]+-->/g) ?? []).sort().join(" ");
  if (marks(before) !== marks(after)) {
    throw new Error(`${relPath}: プレースホルダが変わった [${marks(before)}] -> [${marks(after)}]`);
  }
  const left = (after.match(/<!--[\s\S]*?-->/g) ?? []).filter((c) => !keepComment(c));
  if (left.length) throw new Error(`${relPath}: コメントが残っている: ${left[0].slice(0, 60)}`);
  // タグの数が変わっていたら、コメント除去がタグを巻き込んでいる（コメント自身は数から外す）。
  const tags = (s) => (s.replace(/<!--[\s\S]*?-->/g, "").match(/<[a-zA-Z/][^>]*>/g) ?? []).length;
  if (tags(before) !== tags(after)) {
    throw new Error(`${relPath}: タグ数が変わった ${tags(before)} -> ${tags(after)}`);
  }
}

async function walk(dir, rel = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    const relPath = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      await walk(from, relPath);
      continue;
    }
    const to = path.join(OUT, relPath);
    await mkdir(path.dirname(to), { recursive: true });
    const ext = path.extname(entry.name).toLowerCase();
    stats.bytesIn += (await stat(from)).size;

    if (ext === ".js" || ext === ".css" || ext === ".html") {
      const text = await readFile(from, "utf8");
      let built;
      if (ext === ".js") {
        built = await transform(text, "js");
        stats.js++;
      } else if (ext === ".css") {
        built = await transform(text, "css");
        stats.css++;
      } else {
        built = await stripHtml(text);
        verifyHtml(relPath, text, built);
        stats.html++;
      }
      await writeFile(to, built);
      stats.bytesOut += Buffer.byteLength(built);
    } else {
      await cp(from, to);
      stats.copied++;
      stats.bytesOut += (await stat(from)).size;
    }
  }
}

await rm(path.join(ROOT, "dist"), { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await walk(SRC);

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
console.log(
  `assets: js ${stats.js} / css ${stats.css} / html ${stats.html} / copied ${stats.copied}  ` +
    `${kb(stats.bytesIn)} -> ${kb(stats.bytesOut)} ` +
    `(-${(100 - (stats.bytesOut / stats.bytesIn) * 100).toFixed(1)}%)  -> dist/public`
);
