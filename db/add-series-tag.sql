-- シリーズ個別のタグと、その利用者申請（db/MIGRATIONS.md の台帳に記録すること）。
--
-- レーベル単位のタグ（label_tag, db/add-label-tag.sql）だけでは粒度が足りない。
-- 例: 「集英社文庫」はほとんどが漫画の文庫版だが、同じレーベルに文庫版でない本も混じる。
-- 「コロタン文庫」のように発行年があっても文庫版でないレーベルもある。そこでシリーズ単位の
-- 上書きを別に持ち、レーベルのタグより優先させる。
--
-- tag = '' は **「タグ無し」を明示する上書き**（レーベルのタグを打ち消す）。NULL ではなく空文字に
-- するのは、「行が無い＝レーベルに従う」と「行があって空＝レーベルのタグを外す」を区別するため。
CREATE TABLE IF NOT EXISTS series_tag (
  series_id  TEXT PRIMARY KEY,   -- C-id / U-id / G-id
  tag        TEXT NOT NULL,      -- src/labels.ts LABEL_TAGS のいずれか、または '' = タグ無しを明示
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 閲覧者からの「このシリーズは廉価版です」等の申請。シリーズ名の通報・結合依頼・分離依頼と
-- 同じ collect-only 方針で、ここには件数だけ積み、全体への反映は管理者が確定したときだけ
-- （series_tag に書く）。1 シリーズに複数のタグが申請されうるので (series_id, tag) が鍵。
CREATE TABLE IF NOT EXISTS series_tag_request (
  series_id         TEXT NOT NULL,
  tag               TEXT NOT NULL,   -- 申請されたタグ。'' = 「ついているタグを外してほしい」
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  PRIMARY KEY (series_id, tag)
);
-- 管理画面のキューを新しい順に出す。
CREATE INDEX IF NOT EXISTS idx_series_tag_request_last ON series_tag_request (last_reported_at);
