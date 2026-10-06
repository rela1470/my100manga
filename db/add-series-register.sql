-- 閲覧者からの「この作品をシリーズとして登録してほしい」依頼（series_register_request）。
-- 対象は「MADB に丸ごと無い作品」。ISBN 検索では楽天ブックス由来の 1 冊ライブカード
-- （src/search.ts rakutenCard、series_id が "rakuten<ISBN>" の擬似 ID）にしかならず、
-- シリーズとして開く・全巻まとめて追加する・結合や名前修正の導線に乗せる、がどれもできない。
--
-- 他の利用者からの申し出（series_report / series_merge_request / cover_suggestion）と同じ
-- collect-only 方針で、全体反映は管理者が確定するまで行わない。依頼は ISBN 1 つだけを受け取り、
-- 書名・著者・出版社は**サーバが自分で引く**（live_volumes / 楽天）。利用者の自由入力を 1 文字も
-- 受けないので、通報・伏字の対象になる文字列がこの表に入ることはない。
--
-- 管理者の確定（src/seriesRegister.ts adminRegisterSeries）がやること:
--   1. custom_series に独自シリーズ（U-id）を 1 行作る
--   2. 選んだ巻を volume_master_fix 行として書き、その場で volumes へ当てる（series_id = U-id）
-- どちらも月次取り込みのあとに載せ直される（scripts/ingest.mjs の APPLY_LINKS_SQL →
-- APPLY_MASTER_FIX_SQL の順。後者が最終の値になる）。取り消しは管理画面「マスタ行の修正」の
-- 取り消しで巻を消し、巻が 1 つも残らなくなった独自シリーズは一緒に片付ける。
--
-- 実行例 (本番):   wrangler d1 execute DB --remote --file db/add-series-register.sql
--         (開発):   wrangler d1 execute DB --env dev --remote --file db/add-series-register.sql
--         (ローカル): wrangler d1 execute DB --local  --file db/add-series-register.sql
--
-- ★ デプロイより先に流すこと。src/seriesRegister.ts がこの表を読み書きするので、無い DB に
--   新しいコードを出すと依頼の受付と管理画面のキューが 500 になる。

CREATE TABLE IF NOT EXISTS series_register_request (
  isbn              TEXT PRIMARY KEY,           -- 依頼された代表 ISBN13（利用者が開いていた 1 冊）
  title             TEXT NOT NULL DEFAULT '',   -- 依頼を受けた時点でサーバが引けた書名（'' = 引けなかった）
  creator           TEXT NOT NULL DEFAULT '',
  publisher         TEXT NOT NULL DEFAULT '',
  report_count      INTEGER NOT NULL DEFAULT 1, -- 同じ ISBN の依頼が重なった回数
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  resolved_at       INTEGER NOT NULL DEFAULT 0, -- 管理者が処理した時刻。0 = 未処理
  resolution        TEXT NOT NULL DEFAULT '',   -- '' | 'registered'(登録した) | 'dismissed'(却下)
  series_id         TEXT NOT NULL DEFAULT ''    -- 登録して作った独自シリーズ（U-id）。却下なら ''
);
-- 管理画面のキュー（未処理を新しい順）と、処理済みを含む一覧の両方がこの 1 本で読める。
CREATE INDEX IF NOT EXISTS idx_series_register_request_queue
  ON series_register_request (resolved_at, last_reported_at);
