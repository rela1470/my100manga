-- 既存 DB への売上ランキングの寄せ先指定（sales_link）の追加。schema.sql の CREATE TABLE と
-- 揃える。CREATE ... IF NOT EXISTS なので何度実行しても安全。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --env='' --file db/add-sales-link.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-sales-link.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-sales-link.sql

CREATE TABLE IF NOT EXISTS sales_link (
  work_norm  TEXT PRIMARY KEY,   -- sales_snapshot.work_norm（集計の単位）
  series_id  TEXT NOT NULL,      -- 寄せ先（C-id / U-id / G-id）。'' は「寄せない」
  created_at INTEGER NOT NULL
);
