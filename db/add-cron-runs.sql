-- 既存 DB への cron の実行履歴（cron_runs）の追加。schema.sql の CREATE TABLE と揃える。
-- CREATE ... IF NOT EXISTS なので何度実行しても安全。無くても cron は動く（履歴が残らないだけ）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-cron-runs.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-cron-runs.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-cron-runs.sql

CREATE TABLE IF NOT EXISTS cron_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cron        TEXT NOT NULL,
  job         TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs (started_at);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs (job, started_at);
