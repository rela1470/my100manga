-- 既存 DB への series_report.suggested_name（通報者が任意で添える正しい名前の提案）列の追加。
-- schema.sql の CREATE TABLE と揃える。
-- 冪等ではないので一度だけ実行すること（列が既にあると ALTER は失敗する）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-series-report-suggestion.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-series-report-suggestion.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-series-report-suggestion.sql

ALTER TABLE series_report ADD COLUMN suggested_name TEXT NOT NULL DEFAULT '';
