-- 発行部数ランキングの寄せ先の指定（src/circulation.ts）。作品 → シリーズの対応を
-- 管理画面で確定して持つ表。
--
-- circulation 本体と分けてあるのは、Wikipedia を取り込み直すと circulation が
-- DELETE → INSERT で全件入れ替わるため（db/circulation-data.sql）。マスタ（series /
-- volumes）と、管理者の判断（volume_series_link / series_name_override）を分けてあるのと
-- 同じ理由で、取り込み直しても指定が消えないようにする。
--
-- 寄せ先の決め方（computeCirculation）:
--   1. この表に行があれば、それを使う（series_id が '' なら「寄せない」として確定）
--   2. 行が無ければ、作品名からの自動照合（売上ランキングと同じ resolveTargets）
-- どちらも最後に resolveUnit を通すので、あとでシリーズを結合しても指定は追従する。
-- 指定先のシリーズが取り込み直しで消えていたら、管理画面に「指定先が見つからない」として出る。
--
-- source:
--   'suggested' … 自動照合の結果をそのまま取り込んだもの（管理画面の「サジェストを取り込む」）。
--                 既定のデータ（db/circulation-links.sql）はこれで入る。
--   'manual'    … 管理者が画面で選んだもの。「サジェストを取り込む」で上書きしない。
CREATE TABLE IF NOT EXISTS circulation_link (
  article    TEXT PRIMARY KEY,   -- circulation.article（英語版 Wikipedia の記事名）
  series_id  TEXT NOT NULL,      -- 寄せ先の C-id / U-id / G-id。'' = 寄せない
  source     TEXT NOT NULL,      -- 'suggested' | 'manual'
  created_at INTEGER NOT NULL
);
