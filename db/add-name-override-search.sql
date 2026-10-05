-- series_name_override.name_norm / name_search: 管理者が直したシリーズ名を「検索の鍵」にもする
-- （db/MIGRATIONS.md の台帳に記録すること）。
--
-- マスタ（MADB）の書名が壊れている作品は、どの照合列にも正しい名前が入っていない。例えば
-- 『Dr.スランプ』のジャンプ・コミックス版 18 巻（G9784088511818）は書名が「Dr」で入っており、
-- シリーズ行も無いので読み（name_kana_norm）も無い。壊れた書名で引けるのは「Dr」だけで、
-- 「Dr.スランプ」では検索に一切出てこなかった。
--
-- 管理者の名前修正（series_name_override）はこれまで表示専用で、閲覧者が辿り着いた後の
-- 名前しか直せなかった。直した名前を検索の照合にも使えば、「正しい名前はこれ」という管理者の
-- 明示がそのまま検索の鍵になる。そこで照合用の正規形を 2 列持たせる:
--
--   name_norm   … normTitle(name)  空白除去 + 小文字化（series.name_norm と同じ畳み方）
--   name_search … searchKey(name)  さらに NFKC + 記号落とし（series.name_search と同じ）
--
-- どちらも修正時に JS 側で作って書く（src/admin.ts adminOverrideSeriesName）。name_search は
-- NFKC と Unicode の記号クラスを使うので SQL では作れない。下の UPDATE は既存行の name_norm
-- だけを埋めるためのもので、name_search は空のまま残る（読み出し側が空なら name_norm で
-- 代用する。src/search.ts matchNameOverrides）。次に管理者がその行を直せば両方揃う。
--
-- 索引は張らない。この表は管理者が直した分しかなく（本番で数十行）、照合は '%q%' の
-- 中間一致なので索引は効かない。全行走査で十分軽い。
--
-- デプロイの前に流す（列が無いと INSERT が落ちる）。

ALTER TABLE series_name_override ADD COLUMN name_norm TEXT NOT NULL DEFAULT '';
ALTER TABLE series_name_override ADD COLUMN name_search TEXT NOT NULL DEFAULT '';

UPDATE series_name_override
   SET name_norm = REPLACE(REPLACE(LOWER(name), ' ', ''), '　', '')
 WHERE name_norm = '';
