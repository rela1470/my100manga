-- 既存 DB への独自シリーズ・巻の紐付けテーブル（custom_series / volume_series_link）の追加。
-- schema.sql の CREATE TABLE と揃える。CREATE ... IF NOT EXISTS なので何度実行しても安全。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-custom-series.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-custom-series.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-custom-series.sql

CREATE TABLE IF NOT EXISTS custom_series (
  id         TEXT PRIMARY KEY,   -- "U" + 6 桁の連番
  name       TEXT NOT NULL,      -- 作成元のまとまりの書名（表示名は series_name_override で直せる）
  name_norm  TEXT NOT NULL,      -- normTitle(name)
  creator    TEXT,
  publisher  TEXT,
  label      TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS volume_series_link (
  isbn       TEXT PRIMARY KEY,   -- シリーズの無いマスタ巻の ISBN13
  series_id  TEXT NOT NULL,      -- 紐付け先（C-id か U-id）
  created_at INTEGER NOT NULL    -- 1 回の結合で紐付けた巻は同じ値（解除の単位）
);
CREATE INDEX IF NOT EXISTS idx_volume_series_link_series ON volume_series_link (series_id);
