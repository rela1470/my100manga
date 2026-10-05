-- 2026-10-05 ISBN 9784867943816 の手動追加に、正しい巻番号「第4部[9]」を付ける。
--
-- この ISBN は openBD で『本好きの下剋上～司書になるためには手段を選んでいられません～
-- 第四部「貴族院の図書館を救いたい！9」』(勝木光 / TOブックス / コロナ・コミックス)。
-- 本番のマスタは第4部を [1]〜[8] と [10]〜[12] まで持っていて 9 巻だけが欠番なので、手で足したこと
-- 自体も、足した先 C365444 も正しい（C417457 / C417458 / C452185 を吸収した結合先が C365444）。
-- 間違っていたのは巻番号だけで、「9」/ vol_sort 9 で入っていた ＝ 巻一覧の先頭、第1部の巻より
-- 前に並んでいた。
--
-- 巻番号は同じ第4部の既存巻に合わせて「第4部[9]」。vol_sort は src/util.ts volSort と同じ
-- 「部の番号 ×1000 + 巻番号」= 4009（第4部[8] の 4008 と 第4部[10] の 4010 の間）。手動追加の API
-- (src/corrections.ts addCorrection) は巻番号を「N」「巻N」しか受け付けないので、この形は
-- 画面からは入れられない。表紙・追加時刻・レビュー状態は元の行から引き継ぐ。
--
-- 結合の member（C417457 / C417458 / C452185）側に入っていても巻一覧の見え方は同じだが
-- （src/series.ts getSeriesVolumes が全 member の訂正を読む）、第4部[3]〜[12] のマスタ行が
-- C365444 に在るので、結合を解いたときに 9 巻だけ離れないよう結合先に寄せる。
--
-- 本番にだけ存在する（local / dev remote は 0 件）。行が無い環境では何も起きない。
INSERT OR REPLACE INTO series_correction
  (series_id, isbn, volume_number, vol_sort, cover_url, created_at, reviewed_at)
SELECT 'C365444', isbn, '第4部[9]', 4009, cover_url, created_at, reviewed_at
  FROM series_correction
 WHERE isbn = '9784867943816'
   AND series_id IN ('C365444', 'C417457', 'C417458', 'C452185')
 ORDER BY (series_id = 'C365444') DESC
 LIMIT 1;

DELETE FROM series_correction
 WHERE isbn = '9784867943816'
   AND series_id IN ('C417457', 'C417458', 'C452185');

-- 表示データの世代を上げて、巻一覧のエッジキャッシュとリストの閲覧スナップショットを作り直させる
-- (src/viewSnapshot.ts)。admin の更新系 API が成功後にやることを、直接書き換えたぶん手で行う。
INSERT INTO meta (key, value) VALUES ('view_epoch', CAST(strftime('%s','now') AS TEXT) || '000')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
