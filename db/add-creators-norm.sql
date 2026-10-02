-- series / volumes に検索専用の全作者列 creators_norm を追加（scripts/ingest.mjs が投入）。
-- 共著作品の 2 人目以降の作者（例: 原作 丸戸史明 / 作画 よむ）でも検索に掛かるようにする。
-- 追加直後は NULL で、検索は creator にフォールバックする。次回 ingest で埋まる。
-- ALTER TABLE ... ADD COLUMN は再実行するとエラーになるので 1 回だけ流す。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-creators-norm.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-creators-norm.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-creators-norm.sql

ALTER TABLE series ADD COLUMN creators_norm TEXT;
ALTER TABLE volumes ADD COLUMN creators_norm TEXT;
