-- series.is_adult / volumes.is_adult。R18版 (my100shunga) が成年向けを収録するための印。
-- 既定 0 なので、本家の既存データはそのまま「全年齢」として残る（本家の D1 には成年向けの行が
-- そもそも入らない。ingest が adult_volumes へ落とすため）。
--
-- R18版の D1 では `node scripts/ingest.mjs --include-adult` が成年向けの巻に 1 を立て、
-- その巻を持つシリーズにも 1 を立てる。検索の既定の絞り込みは src/search.ts。
-- see docs/r18.md 2 節
--
-- 冪等ではない（2 回目は duplicate column name で落ちる）。
ALTER TABLE series ADD COLUMN is_adult INTEGER NOT NULL DEFAULT 0;
ALTER TABLE volumes ADD COLUMN is_adult INTEGER NOT NULL DEFAULT 0;
