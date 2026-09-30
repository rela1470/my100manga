-- 既存 DB への soft-delete 列の追加（表紙の修正 / 通報）。
-- 確定・却下・伏字をハードデリートせず resolved_at(>0) + resolution で残し、
-- admin で「処理済み履歴」を表示できるようにする。schema.sql の CREATE TABLE と揃える。
-- 冪等ではないので一度だけ実行すること（列が既にあると ALTER は失敗する）。
--
-- 実行例 (本番):   wrangler d1 execute <DB名> --remote --file db/add-soft-delete.sql
--         (ローカル): wrangler d1 execute <DB名> --local  --file db/add-soft-delete.sql

ALTER TABLE reports ADD COLUMN resolved_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN resolution  TEXT    NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_reports_resolved ON reports (resolved_at);

ALTER TABLE cover_suggestion ADD COLUMN resolved_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cover_suggestion ADD COLUMN resolution  TEXT    NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_cover_suggestion_resolved ON cover_suggestion (resolved_at);
