#!/usr/bin/env node
// ローカル D1 で管理者が確定したシリーズ結合（series_merge / series_merge_dismissed）を
// SQL にダンプし、本番へいつでもリストアできるようにする。結合はローカルの管理画面で
// まとめて判断し、結果だけを本番に流す運用のためのもの。
//
// Usage:
//   node scripts/dump-series-merge.mjs                 # ローカル D1 → db/series-merge-data.sql
//   node scripts/dump-series-merge.mjs --out path.sql  # 出力先を指定
//
// リストア（何度流しても同じ結果になる upsert）:
//   npx wrangler d1 execute DB --remote --file db/series-merge-data.sql            # 本番
//   npx wrangler d1 execute DB --env dev --remote --file db/series-merge-data.sql  # 開発
//
// upsert なので本番側にだけある結合は残る（ローカルで解除した結合は本番から消えない）。
// 解除を反映したいときは本番の管理画面で解除するか、DELETE FROM series_merge してから流す。
// ダンプはローカルの結合を連鎖の無い形（target は常に未吸収）で持つので、本番が空か
// ローカルと同じ判断の上に積んだ状態なら、リストア後も連鎖は生じない。

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "db/series-merge-data.sql";

function query(sql) {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  return JSON.parse(raw)[0].results;
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const merges = query(
  "SELECT absorbed_id, target_id, created_at FROM series_merge ORDER BY target_id, absorbed_id"
);
const dismissed = query(
  "SELECT group_key, created_at FROM series_merge_dismissed ORDER BY group_key"
);

const lines = [
  "-- シリーズ結合のダンプ（scripts/dump-series-merge.mjs で生成。手で編集しない）。",
  `-- 生成: ${new Date().toISOString()}  series_merge ${merges.length} 件 / series_merge_dismissed ${dismissed.length} 件`,
  "-- リストア: npx wrangler d1 execute DB --remote --file db/series-merge-data.sql",
  "-- 前提: db/add-series-merge.sql 適用済み。upsert なので何度流しても安全。",
  "",
];
for (const m of merges) {
  lines.push(
    `INSERT INTO series_merge (absorbed_id, target_id, created_at) VALUES (${q(m.absorbed_id)}, ${q(m.target_id)}, ${Number(m.created_at)})` +
      " ON CONFLICT (absorbed_id) DO UPDATE SET target_id = excluded.target_id, created_at = excluded.created_at;"
  );
}
for (const d of dismissed) {
  lines.push(
    `INSERT INTO series_merge_dismissed (group_key, created_at) VALUES (${q(d.group_key)}, ${Number(d.created_at)})` +
      " ON CONFLICT (group_key) DO NOTHING;"
  );
}
// 結合で片付いた依頼（両方が同じ target に入ったもの）を消す。adminMergeSeries と同じ条件。
lines.push(
  "DELETE FROM series_merge_request",
  "  WHERE COALESCE((SELECT target_id FROM series_merge WHERE absorbed_id = series_a), series_a)",
  "      = COALESCE((SELECT target_id FROM series_merge WHERE absorbed_id = series_b), series_b);",
  ""
);

fs.writeFileSync(OUT, lines.join("\n"));
console.log(`wrote ${OUT}: series_merge ${merges.length}, series_merge_dismissed ${dismissed.length}`);
