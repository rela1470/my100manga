-- 既存 DB へのシリーズの分離の追加: volume_series_link の分離元（from_series_id）列と、閲覧者の
-- 分離依頼テーブル（series_split_request）。schema.sql と揃える。db/add-custom-series.sql の後に
-- 1 回だけ流す（ALTER TABLE ADD COLUMN は 2 回目で duplicate column エラーになる。CREATE は先に
-- 置いてあり IF NOT EXISTS なので、2 回目に流しても依頼テーブルは作られた状態で止まる）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-series-split.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-series-split.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-series-split.sql

-- 閲覧者の「別の版が混ざっている？」依頼（シリーズの分離の依頼）。結合依頼と同じ collect-only
-- 方針で、全体反映は管理者の確定まで行わない。閲覧者が別の版だと選んだ巻を ISBN ごとに 1 行、
-- 繰り返しの依頼は report_count を増やす。series_id は結合済みなら残す側。管理者は 分離（移した
-- ISBN の行を消す）か 却下（そのシリーズの行を消す）。See src/merge.ts (requestSeriesSplit)。
CREATE TABLE IF NOT EXISTS series_split_request (
  series_id         TEXT NOT NULL,   -- 依頼されたシリーズ（C-id / U-id）
  isbn              TEXT NOT NULL,   -- 別の版だと選ばれた巻の ISBN13
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  PRIMARY KEY (series_id, isbn)
);
CREATE INDEX IF NOT EXISTS idx_series_split_request_last ON series_split_request (last_reported_at);

ALTER TABLE volume_series_link ADD COLUMN from_series_id TEXT;
