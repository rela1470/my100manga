-- Google ログイン（任意）用のテーブルと lists.user_id 列の追加。schema.sql と揃える。
-- 冪等ではないので一度だけ実行すること（ALTER は列が既にあると失敗する）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-accounts.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-accounts.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-accounts.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  picture       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS user_drafts (
  user_id    TEXT PRIMARY KEY,
  owner_name TEXT NOT NULL DEFAULT '',
  bio        TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE lists ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_lists_user ON lists (user_id);
