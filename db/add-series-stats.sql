-- 既存 DB へのシリーズの巻数の集計（series_stats）の追加。schema.sql の CREATE TABLE と揃える。
-- CREATE ... IF NOT EXISTS なので何度実行しても安全。中身は空で作り、巻一覧を開いたとき・
-- 2 分ごとの cron（src/seriesList.ts runSeriesStatsBatch）が埋める。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-series-stats.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-series-stats.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-series-stats.sql

CREATE TABLE IF NOT EXISTS series_stats (
  series_id    TEXT PRIMARY KEY,
  vol_count    INTEGER NOT NULL,
  complete_run INTEGER NOT NULL DEFAULT 0,
  first_isbn   TEXT NOT NULL DEFAULT '',
  last_pubdate TEXT NOT NULL DEFAULT '',
  computed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_stats_count ON series_stats (vol_count DESC, series_id);
CREATE INDEX IF NOT EXISTS idx_series_stats_run ON series_stats (complete_run, series_id);
