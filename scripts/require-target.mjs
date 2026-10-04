// 本番を踏む npm script を「環境を書かずに」呼べないようにするためのガード。
//
// wrangler も、以前の package.json も、環境を省くと本番を指す作りだった（`npm run deploy`
// が my100manga.com へ、`npm run ingest:remote` が本番 D1 へ）。一番打ちやすい名前が一番
// 危ない向き先になっているので、素の名前はここで止めて、`:prod` / `:dev` を付け直させる。
//
// 使い方: package.json の "deploy" などの値を `node scripts/require-target.mjs deploy` にする。
// 候補は package.json の scripts から拾うので、環境を足してもここは直さなくてよい。
import { readFileSync } from "node:fs";

const name = process.argv[2] ?? "";
const { scripts = {} } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const variants = Object.keys(scripts).filter((s) => s.startsWith(`${name}:`));

console.error(
  [
    "",
    `  npm run ${name} は向き先が曖昧なので実行しません。環境を明示して呼び直してください:`,
    "",
    ...variants.map((s) => `    npm run ${s}${s.endsWith(":prod") ? "   <- 本番" : ""}`),
    "",
    "  本番 (:prod) はリポジトリ直下の CLAUDE.md の手順（全セッションへの予告）に従うこと。",
    "",
  ].join("\n")
);
process.exit(1);
