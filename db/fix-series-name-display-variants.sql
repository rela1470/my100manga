-- series.name_display の「同名」の判定を、検索の照合キー（name_search）基準に直す
-- （db/MIGRATIONS.md の台帳に記録すること。db/add-series-name-display.sql の続き）。
--
-- 最初の版は「同名」を name_norm（空白と大小だけを畳んだ形）の一致で見ていた。しかし MADB は
-- 同じ作品を表記ゆれで別シリーズに持つ:
--   C294944「ブラックジャック」（少年チャンピオン・コミックス、全3巻、全巻が副題「黒い医師」）
--   C276567 ほか 14 件「ブラック・ジャック」（中黒あり。手塚治虫文庫全集・漫画全集・豪華版…）
-- name_norm では中黒が残るので別名に見え、C294944 には何も付かなかった。だが利用者が
-- 「ブラックジャック」で検索すると、照合は name_search（searchKey = NFKC + 記号を落とす）で
-- 行うので 15 件が一緒に並ぶ。並ぶのに見分けが付かない、という最初に直したかった状態そのもの。
--
-- そこで「同名」を COALESCE(name_search, name_norm) の一致に変える。
-- → C294944 は「ブラックジャック 黒い医師」になる。ローカルのマスタで 4,402 件 → 4,584 件
-- （+182 件。増えるのは「可愛いひと。」と「可愛いひと」、「もやしもん+」と「もやしもん」のように
--  記号の有無だけが違う名前。これらは検索結果でも隣り合って出るので、見分けが付いた方がよい）。
--
-- name_norm が一致する組は name_search でも必ず一致するので、この変更で表示名を失うシリーズは
-- 無い（増えるだけ）。それでも全部入れ直すのは、取り込み（scripts/ingest.mjs の「3.5」）と
-- 同じ状態に揃えるため。**このファイルは冪等**で、何度流しても同じ結果になる。
--
-- 判定の中身（全巻が同じ非空の副題を名乗る／副題に「：」を含まない／名前が既にその副題を
-- 含まない）は db/add-series-name-display.sql から変えていない。SQLite の LOWER が ASCII しか
-- 畳まないぶん、名前の重複判定だけが取り込み側（JS）よりゆるいのも同じ。
-- デプロイの前に流す（列自体は add-series-name-display.sql で足してある）。

UPDATE series SET name_display = NULL WHERE name_display IS NOT NULL;

WITH uniform AS (
  -- 全ての巻が副題を持ち、それが 1 種類だけのシリーズ。「：」は、1 冊に複数の
  -- schema:alternateName がある合本を取り込みが繋いだ印なので外す（その巻の収録内容であって
  -- シリーズの副題ではない）。
  SELECT v.series_id AS sid, MIN(v.subtitle) AS sub
    FROM volumes v
   WHERE v.series_id IS NOT NULL
   GROUP BY v.series_id
  HAVING COUNT(*) = COUNT(NULLIF(COALESCE(v.subtitle, ''), ''))
     AND COUNT(DISTINCT v.subtitle) = 1
     AND INSTR(MIN(v.subtitle), '：') = 0
),
dup AS (
  -- 検索の照合キーが同じシリーズが 2 件以上ある名前。巻を持つシリーズだけ数える
  -- （巻の無いシリーズは検索にも巻一覧にも出てこないので、同名の相手にならない）。
  SELECT COALESCE(s.name_search, s.name_norm) AS k
    FROM series s
   WHERE EXISTS (SELECT 1 FROM volumes v WHERE v.series_id = s.id)
   GROUP BY k
  HAVING COUNT(*) > 1
)
UPDATE series
   SET name_display = name || ' ' || (SELECT sub FROM uniform WHERE sid = series.id)
 WHERE EXISTS (SELECT 1 FROM uniform u WHERE u.sid = series.id)
   AND COALESCE(name_search, name_norm) IN (SELECT k FROM dup)
   -- 名前が既にその副題を含むなら足さない（「あした天気になあれ 全英オープン編」）
   AND INSTR(LOWER(REPLACE(REPLACE(name, ' ', ''), '　', '')),
             LOWER(REPLACE(REPLACE((SELECT sub FROM uniform WHERE sid = series.id), ' ', ''), '　', ''))) = 0;
