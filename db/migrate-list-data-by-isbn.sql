-- リスト/ランキングが表示名・著者・表紙を ISBN から引くようになったことに伴う既存 DB の移行。
-- schema.sql と揃える。冪等ではないので一度だけ実行すること（列が既に無いと DROP COLUMN は失敗する）。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/migrate-list-data-by-isbn.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/migrate-list-data-by-isbn.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/migrate-list-data-by-isbn.sql

-- 「最新DBから取得」で取れたマスタに無い巻（タイトル解決用）。
CREATE TABLE IF NOT EXISTS live_volumes (
  isbn          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  volume_number TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  fetched_at    INTEGER NOT NULL
);

-- ランキングの追加イベントからスナップショット列を外す。
ALTER TABLE list_item_events DROP COLUMN title;
ALTER TABLE list_item_events DROP COLUMN author;
ALTER TABLE list_item_events DROP COLUMN cover_url;

-- ISBN-10 → ISBN-13 は 978 + 先頭9桁 + チェックディジット（978 の重み付き和 9+21+8 = 38 に続けて
-- 3,1,3,… の重み）。アプリ側 src/util.ts toIsbn13 と同じ。

-- ランキングの追加イベントも ISBN-13 に揃える（ISBN-10 と 13 で同じ本が別集計にならないように）。
UPDATE list_item_events SET isbn = CASE WHEN length(replace(isbn, '-', '')) = 10 THEN '978' || substr(replace(isbn, '-', ''), 1, 9) || ((10 - ((38 + 3 * CAST(substr(replace(isbn, '-', ''), 1, 1) AS INTEGER) + 1 * CAST(substr(replace(isbn, '-', ''), 2, 1) AS INTEGER) + 3 * CAST(substr(replace(isbn, '-', ''), 3, 1) AS INTEGER) + 1 * CAST(substr(replace(isbn, '-', ''), 4, 1) AS INTEGER) + 3 * CAST(substr(replace(isbn, '-', ''), 5, 1) AS INTEGER) + 1 * CAST(substr(replace(isbn, '-', ''), 6, 1) AS INTEGER) + 3 * CAST(substr(replace(isbn, '-', ''), 7, 1) AS INTEGER) + 1 * CAST(substr(replace(isbn, '-', ''), 8, 1) AS INTEGER) + 3 * CAST(substr(replace(isbn, '-', ''), 9, 1) AS INTEGER)) % 10)) % 10) ELSE replace(isbn, '-', '') END
 WHERE length(replace(isbn, '-', '')) = 10;

-- 既存リストの items_json からも表示名・著者・表紙を落とし、ISBN を ISBN-13 に揃える。読み出し側は
-- 余分なキーを無視するので、これは容量と「二重に持たない」ための掃除。ISBN の無い古い item は解決
-- 手段が無いので元の内容（タイトル等）をそのまま残す（src/listItems.ts resolveListItems が使う）。
UPDATE lists SET items_json = (
  SELECT json_group_array(
    CASE WHEN COALESCE(json_extract(j.value, '$.isbn'), '') = '' THEN json(j.value)
    ELSE json_object(
      'position', json_extract(j.value, '$.position'),
      'isbn', CASE WHEN length(replace(json_extract(j.value, '$.isbn'), '-', '')) = 10 THEN '978' || substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 1, 9) || ((10 - ((38 + 3 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 1, 1) AS INTEGER) + 1 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 2, 1) AS INTEGER) + 3 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 3, 1) AS INTEGER) + 1 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 4, 1) AS INTEGER) + 3 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 5, 1) AS INTEGER) + 1 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 6, 1) AS INTEGER) + 3 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 7, 1) AS INTEGER) + 1 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 8, 1) AS INTEGER) + 3 * CAST(substr(replace(json_extract(j.value, '$.isbn'), '-', ''), 9, 1) AS INTEGER)) % 10)) % 10) ELSE replace(json_extract(j.value, '$.isbn'), '-', '') END,
      'comment', json_extract(j.value, '$.comment'),
      'spoiler', json(CASE WHEN json_extract(j.value, '$.spoiler') THEN 'true' ELSE 'false' END)
    ) END
  )
  FROM json_each(lists.items_json) j
);
