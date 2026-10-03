-- 既存 DB への list_view_seen（公開リストのアクセス数の重複判定）テーブルの追加。schema.sql と揃える。
-- CREATE IF NOT EXISTS なので再実行しても安全。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-list-view-seen.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-list-view-seen.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-list-view-seen.sql

-- アクセス数の重複判定。同じ訪問者は 1 リストにつき 1 日 1 回だけ数える。visitor は
-- IP + User-Agent + 日付の SHA-256（IP そのものは持たない）。前日より古い行は日次 cron で消す。
CREATE TABLE IF NOT EXISTS list_view_seen (
  slug    TEXT NOT NULL,
  day     TEXT NOT NULL,
  visitor TEXT NOT NULL,
  PRIMARY KEY (slug, day, visitor)
);
CREATE INDEX IF NOT EXISTS idx_list_view_seen_day ON list_view_seen (day);
