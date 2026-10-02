-- 既存 DB へのシリーズ結合テーブル（series_merge / series_merge_request /
-- series_merge_dismissed）の追加。schema.sql の CREATE TABLE と揃える。
-- CREATE ... IF NOT EXISTS なので何度実行しても安全。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-series-merge.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-series-merge.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-series-merge.sql

CREATE TABLE IF NOT EXISTS series_merge (
  absorbed_id TEXT PRIMARY KEY,   -- 吸収される側の C-id（検索から消え、target に読み替える）
  target_id   TEXT NOT NULL,      -- 残す側の C-id
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_merge_target ON series_merge (target_id);

CREATE TABLE IF NOT EXISTS series_merge_request (
  series_a          TEXT NOT NULL,   -- 小さい方の C-id
  series_b          TEXT NOT NULL,   -- 大きい方の C-id
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  PRIMARY KEY (series_a, series_b)
);
CREATE INDEX IF NOT EXISTS idx_series_merge_request_last ON series_merge_request (last_reported_at);

CREATE TABLE IF NOT EXISTS series_merge_dismissed (
  group_key  TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
