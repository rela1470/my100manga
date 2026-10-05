-- volume_master_fix: 上流（MADB）が壊している巻のマスタ行を丸ごと差し替える表。
-- 表の役割・注意は db/schema.sql の同名ブロックを参照。取り込み後の載せ直しは
-- scripts/ingest.mjs の APPLY_MASTER_FIX_SQL が本体で、このファイルの最後の
-- INSERT OR REPLACE はその写し（取り込みを待たずに今のデータへ反映するため）。

CREATE TABLE IF NOT EXISTS volume_master_fix (
  isbn          TEXT PRIMARY KEY,
  series_id     TEXT,
  volume_number TEXT,
  vol_sort      INTEGER,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  title_search  TEXT,
  creator       TEXT,
  creators      TEXT,
  creators_norm TEXT,
  publisher     TEXT,
  label         TEXT,
  pubdate       TEXT,
  is_adult      INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  prev_json     TEXT
);

-- ── 1 件目: ISBN 9784063129502 の取り違え ────────────────────────────────────
-- MADB はこの ISBN を『超感電少女モナ』（安野モヨコ / 講談社コミックスフレンドB /
-- 1994-04-13 / C279630）の巻として持つが、実際は『Rave』9 巻（真島ヒロ / 講談社コミックス /
-- 2001-03 / C325142）。根拠:
--   ・openBD が 9784063129502 を "Rave 9" / 真島ヒロ / 講談社 / 200103 と返す。
--   ・ISBN の近傍 97840631294xx〜296xx は全て 2001 年の講談社コミックス／少年マガジン
--     コミックスで、1994 年の KCフレンドB はこの行だけ浮いている（1994 年の KCフレンドB は
--     97840630294xx 台）。
--   ・C325142『Rave』は 8 巻 9784063129250（2001-01）と 10 巻 9784063129694（2001-05）の
--     間だけが欠番で、この ISBN はちょうどそこに収まる。
-- 値は前後の巻（9784063129250 / 9784063129694）と揃えた。
-- prev_json は差し替える前のマスタ行（管理画面の「取り消し」の戻し先）。この 2 件は手で書く
-- （管理画面から足した行はサーバが今の volumes から控える）。
INSERT OR REPLACE INTO volume_master_fix
  (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search,
   creator, creators, creators_norm, publisher, label, pubdate, is_adult, note, created_at, prev_json)
VALUES
  ('9784063129502', 'C325142', '9', 9, 'Rave', NULL, 'rave',
   '真島ヒロ', '真島ヒロ', '真島ヒロ', '講談社', '講談社コミックス', '2001-03', 0,
   'MADB が ISBN を取り違え 超感電少女モナ(C279630) の巻として登録していた。実体は Rave 9 巻（openBD / 近傍 ISBN の発行年で確認）',
   1791158400000,
   json_object('isbn','9784063129502','series_id','C279630','volume_number',NULL,'vol_sort',0,
               'title','超感電少女モナ','subtitle',NULL,'title_search','超感電少女モナ',
               'creator','安野モヨコ','creators','安野モヨコ','creators_norm','安野モヨコ',
               'publisher','講談社','label','講談社コミックスフレンドB','pubdate','1994-04-13','is_adult',0));

-- ── 2 件目: 上の取り違えで ISBN を失った『超感電少女モナ』──────────────────
-- モナの正しい ISBN は 4-06-302950-6 = 9784063029505（NDLサーチ。「講談社コミックスフレンドB：
-- 950巻」）。MADB はこれを 302950 → 312950 と 1 桁取り違えたので、9784063029505 はマスタに
-- 1 行も無い。上の差し替えで C279630 が 0 巻になるのを避けるため、正しい ISBN で入れ直す。
-- 巻番号は元のマスタ行と同じく無し（1 冊もの）。
-- prev_json は NULL（上流にこの ISBN の行は無い）＝ 取り消したら volumes から消える。
INSERT OR REPLACE INTO volume_master_fix
  (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search,
   creator, creators, creators_norm, publisher, label, pubdate, is_adult, note, created_at, prev_json)
VALUES
  ('9784063029505', 'C279630', NULL, 0, '超感電少女モナ', NULL, '超感電少女モナ',
   '安野モヨコ', '安野モヨコ', '安野モヨコ', '講談社', '講談社コミックスフレンドB', '1994-04-13', 0,
   '9784063129502 の取り違えでマスタから消えていた巻。正しい ISBN は NDLサーチの 4-06-302950-6',
   1791158400000, NULL);

-- 取り込みを待たずに今のマスタへ反映する（scripts/ingest.mjs APPLY_MASTER_FIX_SQL の写し）。
INSERT OR REPLACE INTO volumes
  (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search,
   creator, creators, creators_norm, publisher, label, pubdate, is_adult)
SELECT isbn, series_id, volume_number, vol_sort, title, subtitle, title_search,
       creator, creators, creators_norm, publisher, label, pubdate, is_adult
  FROM volume_master_fix;
