-- series / volumes に表示用の作者表記列 creators を追加（scripts/ingest.mjs が投入）。
-- 共著作品の作者を役割付きでまとめた 1 行（例: "原作：丸戸史明、作画：よむ"）。単独作者や
-- 役割が全員同じ場合は名前だけ（"A、B"）。編集・監修・装丁などの作者以外は含めない。
-- 追加直後は NULL で、表示は creator にフォールバックする。次回 ingest で埋まる。
-- Worker が creators を SELECT するので、デプロイ前に流すこと。
-- ALTER TABLE ... ADD COLUMN は再実行するとエラーになるので 1 回だけ流す。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-creators.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-creators.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-creators.sql

ALTER TABLE series ADD COLUMN creators TEXT;
ALTER TABLE volumes ADD COLUMN creators TEXT;
