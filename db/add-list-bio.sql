-- 既存 DB への lists.bio（作者のひとこと）列の追加。schema.sql の CREATE TABLE と揃える。
-- 冪等ではないので一度だけ実行すること（列が既にあると ALTER は失敗する）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-list-bio.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-list-bio.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-list-bio.sql

ALTER TABLE lists ADD COLUMN bio TEXT NOT NULL DEFAULT '';
