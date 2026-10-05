-- レーベルのタグ付け（db/MIGRATIONS.md の台帳に記録すること）。
--
-- 「KPC」「講談社プラチナコミックス」のように、名前を見ればコンビニ廉価版・文庫版だと分かる
-- レーベルがマスタに多数ある。管理画面（レーベル管理）でレーベルにタグを付けておくと、その
-- レーベルのシリーズの検索カード・巻一覧に「廉価版」「文庫版」と出る。
--
-- series / volumes は月次の取り込みで表ごと作り直される（scripts/ingest.mjs SWAP_SQL）ので、
-- タグは series.id ではなく **レーベル名そのもの** を鍵にした別表に持つ（取り込みで消えない）。
CREATE TABLE IF NOT EXISTS label_tag (
  label      TEXT PRIMARY KEY,   -- series.label / volumes.label の値そのまま（正規化しない）
  tag        TEXT NOT NULL,      -- src/labels.ts LABEL_TAGS のいずれか（'廉価版' / '文庫版'）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 管理画面のレーベル一覧（レーベルごとのシリーズ数を数える GROUP BY label）が使う。
-- 取り込みの差し替えでも張り直すこと（scripts/ingest.mjs SWAP_SQL に入れてある）。
CREATE INDEX IF NOT EXISTS idx_series_label ON series (label);
