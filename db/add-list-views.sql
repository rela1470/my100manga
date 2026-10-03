-- 既存 DB への list_views（公開ページの日別アクセス数）テーブルの追加。schema.sql と揃える。
-- 公開リスト一覧 (/lists) のアクセス数順の元データ。CREATE IF NOT EXISTS なので再実行しても安全。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-list-views.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-list-views.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-list-views.sql

CREATE TABLE IF NOT EXISTS list_views (
  slug  TEXT NOT NULL,
  day   TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);
CREATE INDEX IF NOT EXISTS idx_list_views_day ON list_views (day);
