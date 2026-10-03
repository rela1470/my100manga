#!/usr/bin/env node
// 発行部数ランキングの寄せ先の指定（circulation_link）をローカル D1 から SQL にダンプする。
// 寄せ先はローカルの管理画面でまとめて判断し、結果だけを本番へ流す運用のため
// （シリーズ結合の scripts/dump-series-merge.mjs と同じ考え方）。
//
// Usage:
//   node scripts/dump-circulation-links.mjs                 # ローカル D1 → db/circulation-links.sql
//   node scripts/dump-circulation-links.mjs --out path.sql  # 出力先を指定
//
// リストア（何度流しても同じ結果になる upsert）:
//   npx wrangler d1 execute DB --remote --file db/circulation-links.sql            # 本番
//   npx wrangler d1 execute DB --env dev --remote --file db/circulation-links.sql  # 開発
//
// upsert なので本番側にだけある指定は残る。本番で付けた 'manual' をローカルの 'suggested' で
// 潰さないよう、同じ記事の行は「本番が 'manual' なら残す」条件付きで更新する。
// ローカルの判断で全部そろえ直したいときは DELETE FROM circulation_link してから流す。

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "db/circulation-links.sql";

function query(sql) {
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1 << 26,
  });
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// 作品名も一緒に出して、SQL を読んだだけでどの作品の指定か分かるようにする。
const rows = query(
  `SELECT l.article, l.series_id, l.source, l.created_at,
          COALESCE(c.title_ja, '') AS title_ja,
          COALESCE(s.name, '') AS series_name
     FROM circulation_link l
     LEFT JOIN circulation c ON c.article = l.article
     LEFT JOIN series s ON s.id = l.series_id
    ORDER BY l.article`
);

const manual = rows.filter((r) => r.source === "manual");
const lines = [
  "-- 発行部数ランキングの寄せ先の指定（scripts/dump-circulation-links.mjs で生成。手で編集しない）。",
  `-- 生成: ${new Date().toISOString()}  ${rows.length} 件（manual ${manual.length} / suggested ${rows.length - manual.length}）`,
  "-- リストア: npx wrangler d1 execute DB --remote --file db/circulation-links.sql",
  "-- 前提: db/add-circulation.sql・db/add-circulation-link.sql 適用済み。upsert なので何度流しても安全。",
  "-- 流したあとに管理画面「発行部数ランキング」の再集計を実行する（寄せ先と表紙を付け直す）。",
  "",
];

for (const r of rows) {
  // series_id が '' の行は「寄せない」として確定したもの。
  const what = r.series_id ? r.series_name || r.series_id : "寄せない";
  lines.push(`-- ${r.title_ja || r.article} → ${what}${r.source === "manual" ? "（手動）" : ""}`);
  lines.push(
    `INSERT INTO circulation_link (article, series_id, source, created_at) VALUES (${q(r.article)}, ${q(
      r.series_id
    )}, ${q(r.source)}, ${r.created_at})`
  );
  // 本番で手動確定した指定を、ローカルのサジェストで上書きしない。
  lines.push(
    `  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at`
  );
  lines.push(`  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';`);
}
lines.push("");
lines.push("-- 集計を作り直させる（管理画面の再集計を忘れても、次のアクセスで作り直される）。");
lines.push("DELETE FROM meta WHERE key = 'circulation_ranking_json';");
lines.push("");

fs.writeFileSync(OUT, lines.join("\n"));
process.stderr.write(`wrote ${OUT} (${rows.length} 件 / manual ${manual.length})\n`);
