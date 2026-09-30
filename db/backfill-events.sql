-- 一度だけ実行する list_item_events の初期 seed。
-- 既存リストには「いつ各巻を追加したか」の履歴が無いので、現在の items_json を展開し、
-- そのリストの created_at を added_at とみなして 1 巻 = 1 イベントとして流し込む。
-- isbn が空の item (作品単位追加) は集計対象外なので除外する。
-- 冪等性のため、まだイベントが 1 件も無い slug だけを対象にする (再実行しても二重に入らない)。
--
-- 実行例 (本番):   wrangler d1 execute <DB名> --remote --file db/backfill-events.sql
--         (ローカル): wrangler d1 execute <DB名> --local  --file db/backfill-events.sql
INSERT INTO list_item_events (slug, isbn, title, author, cover_url, added_at)
SELECT
  lists.slug,
  json_extract(j.value, '$.isbn')      AS isbn,
  json_extract(j.value, '$.title')     AS title,
  json_extract(j.value, '$.author')    AS author,
  json_extract(j.value, '$.cover_url') AS cover_url,
  lists.created_at
FROM lists, json_each(lists.items_json) AS j
WHERE json_extract(j.value, '$.isbn') <> ''
  AND NOT EXISTS (SELECT 1 FROM list_item_events e WHERE e.slug = lists.slug);
