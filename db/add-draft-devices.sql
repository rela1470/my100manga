-- 既存 DB への draft_devices（本棚の下書きを localStorage に持っている端末）テーブルの追加。
-- schema.sql と揃える。CREATE IF NOT EXISTS なので再実行しても安全。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-draft-devices.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-draft-devices.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-draft-devices.sql

-- device は端末の localStorage に置いたランダム ID（IP も下書きの中身も持たない）。
-- 30 日より古い行は日次 cron で消す。See src/draftDevices.ts。
CREATE TABLE IF NOT EXISTS draft_devices (
  device    TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draft_devices_last_seen ON draft_devices (last_seen);
