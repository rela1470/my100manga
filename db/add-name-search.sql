-- series / volumes に検索専用の書名キー（name_search / title_search）を追加（scripts/ingest.mjs が
-- 投入）。全角半角を寄せて記号を落とした書名で、「ぼっちざろっく」で「ぼっち・ざ・ろっく！」、
-- 「あさドラ！」で「あさドラ!」が検索に掛かるようにする（src/util.ts searchKey）。
-- 追加直後は NULL で、検索はこれまでの name_norm / 書名にフォールバックする。次回 ingest で埋まる。
-- ALTER TABLE ... ADD COLUMN は再実行するとエラーになるので 1 回だけ流す。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-name-search.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-name-search.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-name-search.sql

ALTER TABLE series ADD COLUMN name_search TEXT;
ALTER TABLE volumes ADD COLUMN title_search TEXT;
