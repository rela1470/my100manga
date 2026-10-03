-- 発行部数ランキング（src/circulation.ts）。英語版 Wikipedia「List of best-selling manga」
-- （累計 2000 万部以上の約 200 作品）から、作品名・著者・出版社・累計発行部数・出典の時点
-- という事実の列だけを取り込んだもの。中身は scripts/wikipedia-circulation.mjs が生成する
-- db/circulation-data.sql で入れ替える（この表の定義を流した後に実行する）。
--
-- ライセンス: Wikipedia 本文は CC BY-SA 4.0。公開ページ（public/circulation.html）に出典・
-- ライセンス・改変の明示を出し、利用規約（public/terms.html）の無断複製の禁止からこの表の
-- 内容を適用除外にしてある（CC は「追加の制限をかけない」ことを求めるため）。
--
-- シリーズへの寄せ（C-id / U-id / G-id）は保存しない。月次の取り込みや結合・分離で変わるので、
-- 売上ランキングと同じく集計のたびに作品名から引き直し、結果を meta に materialize する
-- （meta.circulation_ranking_json）。
CREATE TABLE IF NOT EXISTS circulation (
  article    TEXT PRIMARY KEY,          -- 英語版 Wikipedia の記事名（一意。表示には使わない）
  title_ja   TEXT NOT NULL,             -- 日本語の作品名（シリーズへの寄せと表示に使う）
  title_en   TEXT NOT NULL DEFAULT '',  -- 英題（同名作品の区別の手がかり）
  author     TEXT NOT NULL DEFAULT '',  -- 著者（ローマ字表記。寄せの候補を絞るのに使う）
  publisher  TEXT NOT NULL DEFAULT '',  -- 出版社（ローマ字表記）
  copies     INTEGER NOT NULL,          -- 累計発行部数（部）
  as_of      TEXT NOT NULL DEFAULT '',  -- 出典の時点（"2026-03"。空 = 出典に日付が無い）
  source_url TEXT NOT NULL DEFAULT '',  -- 各行の一次出典（将来 Wikipedia 以外へ差し替える用。今は表示しない）
  updated_at INTEGER NOT NULL           -- 取り込んだ時刻（epoch ms）
);
-- 部数の降順に並べるだけなので索引は 1 本。
CREATE INDEX IF NOT EXISTS idx_circulation_copies ON circulation (copies DESC);

-- 公開前のキャッシュ暖機（src/warm.ts）が、残り全部を巻数の多い順にたどるための索引。
-- どこまで温めたかは covers 表の有無で判断するので、進捗そのものは持たない。
-- series は月次の取り込みで作り直すので、scripts/ingest.mjs の SWAP_SQL でも張り直している。
CREATE INDEX IF NOT EXISTS idx_series_num_items ON series (num_items DESC, id);
