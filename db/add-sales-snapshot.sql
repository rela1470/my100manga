-- 既存 DB への売上ランキング用テーブル（sales_snapshot）の追加。schema.sql の CREATE TABLE と
-- 揃える。CREATE ... IF NOT EXISTS なので何度実行しても安全。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-sales-snapshot.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-sales-snapshot.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-sales-snapshot.sql

CREATE TABLE IF NOT EXISTS sales_snapshot (
  day        TEXT NOT NULL,      -- 取得日 (JST, YYYY-MM-DD)
  rank       INTEGER NOT NULL,   -- その日の順位 (1 始まり)
  isbn       TEXT NOT NULL,      -- ISBN13
  title      TEXT NOT NULL,      -- 楽天の書名そのまま (「SPY×FAMILY 18」)
  work       TEXT NOT NULL,      -- 巻数・版の表記を除いた作品名 (salesWorkTitle)
  work_norm  TEXT NOT NULL,      -- normTitle(work)。集計の単位
  author     TEXT,
  publisher  TEXT,
  sales_date TEXT,               -- 楽天の発売日表記 (「2026年11月04日」「…頃」)
  cover_url  TEXT,
  PRIMARY KEY (day, rank)
);
CREATE INDEX IF NOT EXISTS idx_sales_snapshot_work ON sales_snapshot (work_norm, day);
