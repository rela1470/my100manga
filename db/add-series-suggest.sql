-- 検索欄の入力補完（サジェスト）用の前方一致索引 series_suggest。
-- シリーズ 1 件につき「引ける綴り」1 つで 1 行（書名・記号無視の書名・読み（複数あれば 1 つずつ）・
-- 管理者が直した名前）。/api/suggest が (key, series_id) の主キーをレンジで引く。
-- 中身の作り方は src/suggest.ts SUGGEST_BUILD_SQL と scripts/ingest.mjs SUGGEST_SQL が同じものを
-- 持つ（3 か所を揃える。ずれたら test/suggest.test.ts が落ちる）。
--
-- いったん series_suggest_new に作ってから RENAME で入れ替えるので、途中で失敗しても今の表は
-- そのまま残る（候補は古いまま出続ける）。何度流しても同じ結果になる（冪等）。
--
-- ★ デプロイより先に流すこと。src/suggest.ts が series_suggest を読むので、この表が無い DB に
--   新しいコードを出すとサジェストが 500 になる（検索本体は影響を受けない）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-series-suggest.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-series-suggest.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-series-suggest.sql
--
-- 月次の取り込み（scripts/ingest.mjs）が series / volumes を作り直した直後に、この表も作り直す。
-- 管理者の結合・名前修正のあとは管理画面の「サジェスト索引の再構築」で作り直せる。

DROP TABLE IF EXISTS series_suggest_new;

CREATE TABLE series_suggest_new (
  key       TEXT NOT NULL,     -- 前方一致で引く綴り（normTitle / searchKey / 読み のいずれか）
  series_id TEXT NOT NULL,     -- C-id / U-id / G-id
  name      TEXT NOT NULL,     -- 候補として出す表示名（上書き > 表示用名 > マスタ名）
  name_key  TEXT NOT NULL,     -- 表示名の揺れを畳むキー（「ONE PIECE」と「One piece」を 1 つに）
  weight    INTEGER NOT NULL,  -- 並び順に使う巻数
  is_adult  INTEGER NOT NULL DEFAULT 0,  -- R18版の既定の絞り込み用（本家は常に 0）
  PRIMARY KEY (key, series_id)
) WITHOUT ROWID;

-- 書名の綴り（マスタの name_norm / name_search と、管理者が直した名前の同じ 2 つ）。
-- 1 行を 4 つの綴りに開くため、1..4 の小さな表と直積を取って CASE で選ぶ。
-- weight は巻数。結合されたシリーズの巻は吸収先に足して数え、吸収された側は候補から外す。
-- 4 つの綴りは同じになることがある（記号の無い書名では name_norm = name_search）ので OR REPLACE。
INSERT OR REPLACE INTO series_suggest_new (key, series_id, name, name_key, weight, is_adult)
SELECT key, series_id, name, LOWER(REPLACE(REPLACE(name, ' ', ''), '　', '')), weight, is_adult FROM (
  SELECT CASE t.i WHEN 1 THEN s.name_norm
                  WHEN 2 THEN s.name_search
                  WHEN 3 THEN NULLIF(o.name_norm, '')
                  WHEN 4 THEN NULLIF(o.name_search, '') END AS key,
         s.id AS series_id,
         COALESCE(o.name, s.name_display, s.name) AS name,
         vc.n AS weight,
         s.is_adult AS is_adult
    FROM series s
    JOIN (SELECT COALESCE(m.target_id, v.series_id) AS sid, COUNT(*) AS n
            FROM volumes v LEFT JOIN series_merge m ON m.absorbed_id = v.series_id
           WHERE v.series_id IS NOT NULL
           GROUP BY sid) vc ON vc.sid = s.id
    LEFT JOIN series_name_override o ON o.series_id = s.id
    JOIN (SELECT 1 AS i UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) t
   WHERE s.id NOT IN (SELECT absorbed_id FROM series_merge))
 WHERE key IS NOT NULL AND key <> '';

-- 読みの綴り。name_kana_norm は "onepiece|ワンピース" のように読みを "|" で繋いだ塊なので
-- （『ONE PIECE』はカナの読みが 2 つ目）、再帰 CTE で 1 つずつ行に開く。塊のまま前方一致させると
-- ローマ字別名を先に持つ主要作がカナ入力で出てこない。
INSERT OR REPLACE INTO series_suggest_new (key, series_id, name, name_key, weight, is_adult)
WITH RECURSIVE
  live AS (
    SELECT s.id, COALESCE(o.name, s.name_display, s.name) AS name, s.name_kana_norm AS kana, s.is_adult
      FROM series s LEFT JOIN series_name_override o ON o.series_id = s.id
     WHERE COALESCE(s.name_kana_norm, '') <> ''
       AND s.id NOT IN (SELECT absorbed_id FROM series_merge)),
  kana(id, rest, part) AS (
    SELECT id, kana || '|', '' FROM live
    UNION ALL
    SELECT id, substr(rest, instr(rest, '|') + 1), substr(rest, 1, instr(rest, '|') - 1)
      FROM kana WHERE rest <> ''),
  vc AS (SELECT COALESCE(m.target_id, v.series_id) AS sid, COUNT(*) AS n
           FROM volumes v LEFT JOIN series_merge m ON m.absorbed_id = v.series_id
          WHERE v.series_id IS NOT NULL
          GROUP BY sid)
SELECT k.part, l.id, l.name, LOWER(REPLACE(REPLACE(l.name, ' ', ''), '　', '')), vc.n, l.is_adult
  FROM kana k JOIN live l ON l.id = k.id JOIN vc ON vc.sid = l.id
 WHERE k.part <> '';

-- シリーズ行を持たない上書き（まとまり G-id の名前修正。マスタが書名を壊していて、直した名前
-- だけが手掛かりの作品 — 『Dr.スランプ』のジャンプ・コミックス版など）。巻数は数えようがないので
-- weight = 1（候補の末尾）。成年向けの印はまとまりの正規 ID が持つ ISBN の巻から引く。
INSERT OR REPLACE INTO series_suggest_new (key, series_id, name, name_key, weight, is_adult)
SELECT key, series_id, name, LOWER(REPLACE(REPLACE(name, ' ', ''), '　', '')), 1,
       COALESCE((SELECT v.is_adult FROM volumes v WHERE v.isbn = substr(series_id, 2)), 0)
  FROM (
  SELECT CASE t.i WHEN 1 THEN NULLIF(o.name_norm, '') WHEN 2 THEN NULLIF(o.name_search, '') END AS key,
         o.series_id AS series_id, o.name AS name
    FROM series_name_override o
    JOIN (SELECT 1 AS i UNION ALL SELECT 2) t
   WHERE NOT EXISTS (SELECT 1 FROM series s WHERE s.id = o.series_id))
 WHERE key IS NOT NULL AND key <> '';

-- 入れ替え。ここまでに失敗していれば今の series_suggest はそのまま（候補は古いまま出続ける）。
-- 初回・まだ表が無い DB でも RENAME できるよう、空の表を作ってから入れ替える。
CREATE TABLE IF NOT EXISTS series_suggest (
  key       TEXT NOT NULL,
  series_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  name_key  TEXT NOT NULL,
  weight    INTEGER NOT NULL,
  is_adult  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, series_id)
) WITHOUT ROWID;

DROP TABLE IF EXISTS series_suggest_old;

ALTER TABLE series_suggest RENAME TO series_suggest_old;

ALTER TABLE series_suggest_new RENAME TO series_suggest;

DROP TABLE series_suggest_old;
