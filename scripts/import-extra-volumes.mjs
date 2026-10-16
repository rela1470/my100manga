#!/usr/bin/env node
// R18版の収録補完: MADB に無い成年コミックの巻（r18-bookdb の書き出し）を、独自シリーズ＋
// 差し替え行（volume_master_fix）として入れる SQL を作る。作るだけで、流さない（流すのはリポ直下の
// CLAUDE.md の手順で全セッションに予告してから）。仕組みは scripts/extra-volumes-sql.mjs。
//
//   node scripts/import-extra-volumes.mjs --env r18dev --file ../r18-bookdb/data/missing.json
//     → backups/extra-volumes-r18dev-<日時>.sql（backups/ はコミットしない: ブックオフ等から集めた書誌を
//       公開リポに載せないため）
//   npx wrangler d1 execute DB --env r18dev --remote --file backups/extra-volumes-r18dev-<日時>.sql
//
// 成年向けとして入れたが一般向けだった巻を全年齢に直す SQL（ISBN を 1 行ずつ並べたファイル）:
//   node scripts/import-extra-volumes.mjs --env r18dev --unadult ../r18-bookdb/data/non-adult.txt
//
// リモートは読むだけ（今の独自シリーズの最大 ID と、入力の ISBN のうち既に volumes /
// volume_master_fix にあるもの）。R18版（--env r18 / r18dev）だけ。本家に成年向けの巻は入れない。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APPLY_LINKS_SQL, SERIES_ADULT_SQL, SUGGEST_SQL, normTitle, searchKey, volSort } from "./ingest.mjs";
import { IMPORT_ID_FLOOR, IMPORTED_FIX_NOTE_PREFIX, applySql, buildImportSql, unadultSql } from "./extra-volumes-sql.mjs";

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = opt("--env");
const file = opt("--file");
const unadult = opt("--unadult");
if (!["r18", "r18dev"].includes(env) || !(file || unadult)) {
  console.error("Usage: node scripts/import-extra-volumes.mjs --env r18dev|r18 (--file missing.json | --unadult isbns.txt) [--out path.sql]");
  process.exit(1);
}

if (unadult) {
  const isbns = [...new Set(fs.readFileSync(unadult, "utf8").split(/\s+/).filter((s) => /^97[89]\d{10}$/.test(s)))];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const out = opt("--out") ?? path.join("backups", `extra-volumes-unadult-${env}-${stamp}.sql`);
  const lines = [
    `-- R18版の収録補完の直し: 一般向けだった ${isbns.length} 巻を全年齢に（scripts/import-extra-volumes.mjs --unadult）`,
    ...unadultSql(isbns),
    "-- 入力補完の索引を作り直す",
    ...SUGGEST_SQL,
  ];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.error(`書き出し: ${out}（${isbns.length} 巻）`);
  console.error(`流すには（全セッションに予告してから）: npx wrangler d1 execute DB --env ${env} --remote --file ${out}`);
  process.exit(0);
}

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--env", env, "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out)[0].results;
}

const input = JSON.parse(fs.readFileSync(file, "utf8"));
const isbns = [...new Set((input.items ?? []).flatMap((it) => (it.volumes ?? []).map((v) => v.isbn)))].filter((i) =>
  /^97[89]\d{10}$/.test(i)
);
console.error(`入力: シリーズ ${input.items?.length ?? 0}・巻 ${isbns.length}`);

const existing = new Set();
for (let i = 0; i < isbns.length; i += 400) {
  const list = isbns
    .slice(i, i + 400)
    .map((s) => `'${s}'`)
    .join(",");
  for (const r of d1(
    `SELECT isbn FROM volumes WHERE isbn IN (${list}) UNION SELECT isbn FROM volume_master_fix WHERE isbn IN (${list})`
  ))
    existing.add(r.isbn);
}
const maxRow = d1(`SELECT id FROM custom_series WHERE id GLOB 'U[0-9]*' ORDER BY id DESC LIMIT 1`)[0];
// 一括投入の番号帯（IMPORT_ID_FLOOR 以上）の続きから。管理画面が作る独自シリーズの番号帯とは分ける。
const nextId = Math.max(maxRow ? parseInt(maxRow.id.slice(1), 10) + 1 : 1, IMPORT_ID_FLOOR);

const now = Date.now();
const stamp = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 13);
const note = `${IMPORTED_FIX_NOTE_PREFIX}${path.basename(file)} ${stamp}`;
const built = buildImportSql(input, { nextId, existing, note, now, normTitle, searchKey, volSort });
if (!built.volumes) {
  console.error(`入れる巻がありません（既にある・不正な ISBN ${built.skipped}）`);
  process.exit(0);
}
const lines = [
  `-- R18版の収録補完（scripts/import-extra-volumes.mjs）。env=${env} input=${path.basename(file)}`,
  `-- 独自シリーズ ${built.series}（${built.ids[0]} 〜 ${built.ids[1]}）・巻 ${built.volumes}・飛ばした ${built.skipped}`,
  `-- note=${note}`,
  ...built.sql,
  ...applySql(note, built.ids, { APPLY_LINKS_SQL, SERIES_ADULT_SQL }),
  "-- 入力補完の索引を作り直す（新しいシリーズが補完に出るように）",
  ...SUGGEST_SQL,
];
const out = opt("--out") ?? path.join("backups", `extra-volumes-${env}-${stamp}.sql`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join("\n") + "\n");
console.error(`書き出し: ${out}`);
console.error(`  独自シリーズ ${built.series}（${built.ids[0]} 〜 ${built.ids[1]}）・巻 ${built.volumes}・飛ばした ${built.skipped}`);
console.error(`流すには（全セッションに予告してから）: npx wrangler d1 execute DB --env ${env} --remote --file ${out}`);
