-- 公開前の索引見直し（2026-10）。全クエリを EXPLAIN QUERY PLAN で確認し、公開ページ・巻一覧・
-- リスト表示の通り道で全表スキャンになっていたものにだけ索引を足す。schema.sql と揃える。
-- すべて IF NOT EXISTS / INSERT OR IGNORE なので何度流しても安全（冪等）。
--
-- ★ デプロイより先に流すこと。src/listItems.ts の RESOLVE_SQL が series_supplement_isbn を
--   参照するので、この表が無い DB に新しいコードを出すとリスト表示・ランキングが落ちる。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-indexes-2026-10.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-indexes-2026-10.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-indexes-2026-10.sql
--
-- series / volumes の索引は月次の取り込み（scripts/ingest.mjs SWAP_SQL）が表を作り直すたびに
-- 張り直す。ここで足した 2 つも SWAP_SQL に入れてある。

-- 公開リスト一覧 (/lists, src/publicLists.ts)。「限定公開でないものを新しい順」の絞り込みと並びを
-- 1 本で引く（rowid が索引の末尾に暗黙に付くので ORDER BY created_at DESC, rowid DESC もそのまま
-- 読める）。COUNT(*) WHERE unlisted = 0 も items_json を抱えた表本体ではなくこの索引だけで数える。
CREATE INDEX IF NOT EXISTS idx_lists_public ON lists (unlisted, created_at);

-- リスト表示の ISBN 解決 (src/listItems.ts RESOLVE_SQL) は series_correction を isbn で引くが、
-- 主キーは (series_id, isbn) なので isbn 単独では全行スキャンになっていた。
CREATE INDEX IF NOT EXISTS idx_series_correction_isbn ON series_correction (isbn);

-- 表紙の提案を cover_url で引く 2 か所（src/corrections.ts suggestCover の却下済み判定、
-- src/covers.ts redactedCoverUrls）。主キーは (isbn, cover_url) で、提案は処理後も行を残す
-- （ソフトデリート）ので表は増え続ける。書き込みは提案時だけで少ない。
CREATE INDEX IF NOT EXISTS idx_cover_suggestion_url ON cover_suggestion (cover_url);

-- 巻一覧 (src/series.ts getSeriesVolumes) の「同名の別シリーズが無いか」判定
-- (isSoleSeriesForName / ...NameLabel / isUnambiguousForSupplement) は series を name（と label）で
-- 引く。索引が無く、シリーズを開くたびに ~14 万行を数回スキャンしていた。
CREATE INDEX IF NOT EXISTS idx_series_name_label ON series (name, label);

-- シリーズ無しの巻（series_id IS NULL, ~7 万行）を書名で引く巻一覧の取り込み
-- (src/series.ts getSeriesVolumes の title = ? / title = ? AND label = ?)。idx_volumes_series の
-- series_id IS NULL 部分を全部なめていた。シリーズ無しの巻だけの部分索引にして小さく保つ。
CREATE INDEX IF NOT EXISTS idx_volumes_unlinked_title ON volumes (title, label) WHERE series_id IS NULL;

-- ── series_supplement の ISBN 逆引き ─────────────────────────────────────────
-- リスト表示の ISBN 解決は「この ISBN をライブ補完のどれかが持っているか」を
-- series_supplement.volumes_json LIKE '%<isbn>%' で探していて、補完の全行（各行は巻の JSON 配列）を
-- ISBN の数だけなめていた。補完の各巻の isbns を (isbn, series_id) に展開した逆引き表を置き、
-- series_supplement への書き込み（src/madbLive.ts・管理画面の削除・取り込みの prune）に追従する
-- トリガで保つ。どの経路で書いても逆引きがずれないよう、アプリ側ではなくトリガで持つ。
-- INSERT OR REPLACE の REPLACE は（recursive_triggers が無効なので）DELETE トリガを起こさない。
-- そのため INSERT トリガでも先に同じ series_id の行を消してから入れ直す。
CREATE TABLE IF NOT EXISTS series_supplement_isbn (
  isbn      TEXT NOT NULL,   -- 補完の巻の ISBN（volumes_json の isbns の値そのまま。ISBN13）
  series_id TEXT NOT NULL,   -- その巻を持つ series_supplement.series_id
  PRIMARY KEY (isbn, series_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_series_supplement_isbn_series ON series_supplement_isbn (series_id);

CREATE TRIGGER IF NOT EXISTS trg_series_supplement_ai AFTER INSERT ON series_supplement
BEGIN
  DELETE FROM series_supplement_isbn WHERE series_id = NEW.series_id;
  INSERT OR IGNORE INTO series_supplement_isbn (isbn, series_id)
    SELECT ji.value, NEW.series_id
      FROM json_each(CASE WHEN json_valid(NEW.volumes_json) THEN NEW.volumes_json ELSE '[]' END) j,
           json_each(j.value, '$.isbns') ji
     WHERE j.type = 'object' AND ji.type = 'text' AND ji.value <> '';
END;

CREATE TRIGGER IF NOT EXISTS trg_series_supplement_au AFTER UPDATE OF series_id, volumes_json ON series_supplement
BEGIN
  DELETE FROM series_supplement_isbn WHERE series_id = OLD.series_id;
  DELETE FROM series_supplement_isbn WHERE series_id = NEW.series_id;
  INSERT OR IGNORE INTO series_supplement_isbn (isbn, series_id)
    SELECT ji.value, NEW.series_id
      FROM json_each(CASE WHEN json_valid(NEW.volumes_json) THEN NEW.volumes_json ELSE '[]' END) j,
           json_each(j.value, '$.isbns') ji
     WHERE j.type = 'object' AND ji.type = 'text' AND ji.value <> '';
END;

CREATE TRIGGER IF NOT EXISTS trg_series_supplement_ad AFTER DELETE ON series_supplement
BEGIN
  DELETE FROM series_supplement_isbn WHERE series_id = OLD.series_id;
END;

-- 既存の補完を展開する（トリガは作成後の書き込みにしか効かないため）。
INSERT OR IGNORE INTO series_supplement_isbn (isbn, series_id)
  SELECT ji.value, sp.series_id
    FROM series_supplement sp,
         json_each(CASE WHEN json_valid(sp.volumes_json) THEN sp.volumes_json ELSE '[]' END) j,
         json_each(j.value, '$.isbns') ji
   WHERE j.type = 'object' AND ji.type = 'text' AND ji.value <> '';
