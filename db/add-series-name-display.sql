-- series.name_display: 同名シリーズを見分けるための表示用シリーズ名（db/MIGRATIONS.md の台帳に記録すること）。
--
-- MADB のシリーズ名（schema:name）だけでは同名のシリーズを区別できない。例えば
-- 「釣りキチ三平」という名前のシリーズは 6 件ある:
--   C326076 講談社コミックス 65巻 / C327929 週刊少年マガジン名作セレクション /
--   C327974 講談社漫画文庫 16巻 / C328178 KCスペシャル 37巻 / C328197 KPC /
--   C328373 （レーベル空欄・出版社「コミックス」）10巻
-- 版表示（series.version, db/add-series-version.sql）とレーベルで大半は見分けられるが、
-- C328373 はどちらも空で、カード上の手掛かりが何も無かった。
--
-- 一方で C328373 の 10 巻はすべて副題（volumes.subtitle = MADB の schema:alternateName）
-- 「作者自選集」を持つ。本の表示タイトルは「書名 + 巻 + 副題」で組み立てているので
-- （public/app.js bookTitle）、本は「釣りキチ三平 1 作者自選集」と出るのに、シリーズ名だけが
-- 素の「釣りキチ三平」のまま、という状態だった。そこで
--
--   全ての巻が同じ非空の副題を名乗り、かつ同じ name_norm のシリーズが他にもある
--
-- ときだけ、その副題を足した名前を name_display に入れる。→「釣りキチ三平 作者自選集」。
--
-- 同名シリーズが無ければ足さない。副題は作品の惹句や英語別名であることも多く
-- （「HEAT」の「灼熱」、「SWAN」の「白鳥」、「カクテル」の「Cocktail」）、もともと曖昧でない
-- 名前に足しても冗長になるだけだから。この条件でローカルの 13.3 万シリーズ中 4,402 件が付く。
--
-- 副題に「：」を含む行は外す。これは 1 冊に複数の schema:alternateName がある合本を取り込みが
-- 繋いだ印で（scripts/ingest.mjs subtitle）、その巻の収録内容であってシリーズの副題ではない。
--
-- version と同じく表示専用。検索の照合（name_norm / name_search / name_kana_norm）にも、
-- シリーズ無しの巻の引き当て（巻の title との完全一致、src/series.ts / src/groups.ts）にも
-- 使わない。管理者の名前修正（series_name_override）があればそちらが優先。
--
-- 取り込み（scripts/ingest.mjs）が毎回入れ直すので、下の UPDATE は取り込みを待たずに
-- 今のデータへ反映するためのもの。判定は取り込み側（JS）と同じだが、SQLite の LOWER が
-- ASCII しか畳まないぶんだけ全角英字の重複判定がゆるい（次の取り込みで揃う）。
-- デプロイの前に流す。

ALTER TABLE series ADD COLUMN name_display TEXT;

UPDATE series
   SET name_display = name || ' ' ||
       (SELECT MIN(v.subtitle) FROM volumes v WHERE v.series_id = series.id)
 WHERE id IN (
   SELECT s.id
     FROM series s
     -- 同名が他にもある（巻を持つシリーズだけ数える。巻の無いシリーズは検索にも出ない）
     JOIN series d ON d.name_norm = s.name_norm AND d.id <> s.id
                  AND EXISTS (SELECT 1 FROM volumes v2 WHERE v2.series_id = d.id)
    WHERE EXISTS (
            SELECT 1 FROM volumes v WHERE v.series_id = s.id
             GROUP BY v.series_id
            -- 全ての巻が副題を持ち、それが 1 種類だけ
            HAVING COUNT(*) = COUNT(NULLIF(COALESCE(v.subtitle, ''), ''))
               AND COUNT(DISTINCT v.subtitle) = 1
               AND INSTR(MIN(v.subtitle), '：') = 0
               -- 名前が既にその副題を含むなら足さない（「あした天気になあれ 全英オープン編」）
               AND INSTR(LOWER(REPLACE(REPLACE(s.name, ' ', ''), '　', '')),
                         LOWER(REPLACE(REPLACE(MIN(v.subtitle), ' ', ''), '　', ''))) = 0)
 );
