-- 既存 DB への lists.unlisted（限定公開フラグ）列の追加。schema.sql の CREATE TABLE と揃える。
-- 1 = 限定公開: 公開ページを noindex にし、運営からの紹介対象にしない。既存リストは 0（紹介可）のまま。
-- 冪等ではないので一度だけ実行すること（列が既にあると ALTER は失敗する）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-list-unlisted.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-list-unlisted.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-list-unlisted.sql

ALTER TABLE lists ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0;
