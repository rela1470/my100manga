-- 既存 DB への adult_volumes（成年向けとして取り込みから外した巻）の追加。schema.sql と揃える。
-- 検索・追加・公開で「成年向けの作品は、こちらのサイトでは追加できません。」と出すのに使う
-- （src/adult.ts）。中身は月次取り込み（scripts/ingest.mjs）が作り直すので、ここでは空の表だけ作る。
-- src/search.ts・src/lists.ts 等がこの表を読むので、**デプロイ前に**流す。
-- CREATE IF NOT EXISTS なので再実行しても安全。書名は '%q%' の LIKE で照合するため索引は張らない
-- （約 8 千行の全行スキャン）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-adult-volumes.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-adult-volumes.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-adult-volumes.sql

CREATE TABLE IF NOT EXISTS adult_volumes (
  isbn        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  title_norm  TEXT NOT NULL,
  series_name TEXT
);
