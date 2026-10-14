-- 既存 DB へのリストの控え（list_history）の追加。schema.sql の CREATE TABLE と揃える。
-- CREATE ... IF NOT EXISTS なので何度実行しても安全。**デプロイ前に**流すこと（表が無いと、
-- 削除・更新公開・伏字の書き込みが丸ごと失敗して、リストを消すことも更新することもできなくなる）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --env='' --file db/add-list-history.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-list-history.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-list-history.sql

CREATE TABLE IF NOT EXISTS list_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  owner_name  TEXT,
  bio         TEXT NOT NULL DEFAULT '',
  items_json  TEXT NOT NULL,
  user_id     TEXT,
  unlisted    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  reason      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_list_history_slug ON list_history (slug, id);
CREATE INDEX IF NOT EXISTS idx_list_history_at ON list_history (archived_at);
