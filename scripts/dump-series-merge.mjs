#!/usr/bin/env node
// ローカル D1 で管理者が確定したシリーズ結合（series_merge / series_merge_dismissed、
// シリーズに属さない巻の紐付け・シリーズの分離 custom_series / volume_series_link）を
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
const customs = query(
  "SELECT id, name, name_norm, creator, publisher, label, created_at FROM custom_series ORDER BY id"
);
const links = query(
  "SELECT isbn, series_id, created_at, from_series_id FROM volume_series_link ORDER BY series_id, isbn"
);
const qn = (v) => (v == null ? "NULL" : q(v));

const lines = [
  "-- シリーズ結合のダンプ（scripts/dump-series-merge.mjs で生成。手で編集しない）。",
  `-- 生成: ${new Date().toISOString()}  series_merge ${merges.length} 件 / series_merge_dismissed ${dismissed.length} 件` +
    ` / custom_series ${customs.length} 件 / volume_series_link ${links.length} 件`,
  "-- リストア: npx wrangler d1 execute DB --remote --file db/series-merge-data.sql",
  "-- 前提: db/add-series-merge.sql・db/add-custom-series.sql・db/add-series-split.sql 適用済み。upsert なので何度流しても安全。",
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
for (const c of customs) {
  lines.push(
    "INSERT INTO custom_series (id, name, name_norm, creator, publisher, label, created_at) VALUES " +
      `(${q(c.id)}, ${q(c.name)}, ${q(c.name_norm)}, ${qn(c.creator)}, ${qn(c.publisher)}, ${qn(c.label)}, ${Number(c.created_at)})` +
      " ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_norm = excluded.name_norm, creator = excluded.creator," +
      " publisher = excluded.publisher, label = excluded.label;"
  );
}
for (const l of links) {
  lines.push(
    "INSERT INTO volume_series_link (isbn, series_id, created_at, from_series_id) VALUES " +
      `(${q(l.isbn)}, ${q(l.series_id)}, ${Number(l.created_at)}, ${qn(l.from_series_id)})` +
      " ON CONFLICT (isbn) DO UPDATE SET series_id = excluded.series_id, created_at = excluded.created_at," +
      " from_series_id = excluded.from_series_id;"
  );
}
// 独自シリーズを series に、紐付けを volumes に反映する（src/groups.ts APPLY_LINKS_SQL と同じ）。
lines.push(
  "INSERT OR REPLACE INTO series (id, name, name_norm, name_kana, name_kana_norm, creator, publisher, label, num_items)",
  "  SELECT id, name, name_norm, NULL, NULL, creator, publisher, label, NULL FROM custom_series;",
  "UPDATE volumes SET series_id = (SELECT l.series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn)",
  "  WHERE isbn IN (SELECT isbn FROM volume_series_link)",
  "    AND series_id IS (SELECT l.from_series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn);"
);
// 結合で片付いた依頼（両方が同じ単位に入ったもの）を消す。src/merge.ts
// CLEANUP_MERGE_REQUESTS_SQL と同じ条件（G-id は紐付け先、結合済みは残す側に読み替える）。
const unit = (col) =>
  `(CASE WHEN ${col} GLOB 'G[0-9]*' THEN COALESCE((SELECT l.series_id FROM volume_series_link l WHERE l.isbn = SUBSTR(${col}, 2)), ${col}) ELSE ${col} END)`;
const target = (col) =>
  `COALESCE((SELECT m.target_id FROM series_merge m WHERE m.absorbed_id = ${unit(col)}), ${unit(col)})`;
lines.push(`DELETE FROM series_merge_request WHERE ${target("series_a")} = ${target("series_b")};`, "");

fs.writeFileSync(OUT, lines.join("\n"));
console.log(
  `wrote ${OUT}: series_merge ${merges.length}, series_merge_dismissed ${dismissed.length}, ` +
    `custom_series ${customs.length}, volume_series_link ${links.length}`
);
