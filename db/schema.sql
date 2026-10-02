-- my100manga schema

CREATE TABLE IF NOT EXISTS lists (
  slug        TEXT PRIMARY KEY,
  edit_token  TEXT NOT NULL,
  owner_name  TEXT,
  bio         TEXT NOT NULL DEFAULT '',  -- 作者のひとこと（100文字まで・公開ページ上部に表示）
  items_json  TEXT NOT NULL,             -- [{position, isbn(ISBN13), comment, spoiler}]。表示名・著者・表紙は持たず読み出し時に ISBN から引く (src/listItems.ts)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lists_created_at ON lists (created_at);

-- ── 巻の「追加」イベントログ (本が追加された回数ランキングの元データ) ──────────
-- lists.items_json は現在のスナップショットしか持たず「どの巻をいつ追加したか」の履歴が
-- 無いため、時間窓 (過去24h/7d/30d) ランキングを出せない。そこで公開時にリストへ新規に
-- 加わった巻を 1 行ずつ append する。作成公開では全 item、更新公開では旧→新の差分で新しく
-- 現れた isbn のみ記録する (added_at = その時刻)。ランキングは COUNT(DISTINCT slug) で
-- 「選んだ人数」を数え、added_at の絞り込みで窓を出す。累計も同じテーブルから (窓なし) 出す
-- ので 4 窓が一貫する。リスト削除時 (adminDeleteList) は幻レコードを残さないよう slug 単位で
-- まとめて削除する。既存リストの seed は db/backfill-events.sql を一度だけ実行する。
-- 表示名・著者・表紙は持たない。ランキング表示時に ISBN からサイト共通データで引く
-- (src/listItems.ts resolveBooks)。See src/ranking.ts。
CREATE TABLE IF NOT EXISTS list_item_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,            -- 追加元リストの slug (リスト削除時にこの単位で掃除)
  isbn       TEXT NOT NULL,            -- 追加された巻の ISBN13 (集計キー)
  added_at   INTEGER NOT NULL          -- 追加時刻 (epoch ms)。窓の絞り込みに使う
);
CREATE INDEX IF NOT EXISTS idx_lie_added_at ON list_item_events (added_at);
CREATE INDEX IF NOT EXISTS idx_lie_isbn ON list_item_events (isbn);
CREATE INDEX IF NOT EXISTS idx_lie_slug ON list_item_events (slug);

-- Cache of resolved cover URLs per ISBN: a real Google Books cover if one exists,
-- else the Rakuten Books cover, else "" (no cover anywhere). See src/covers.ts.
CREATE TABLE IF NOT EXISTS covers (
  isbn       TEXT PRIMARY KEY,
  cover_url  TEXT NOT NULL,     -- resolved best cover URL ("" = none found)
  checked_at INTEGER NOT NULL
);

-- Cache of per-ISBN book metadata for the view-page detail popup: all authors,
-- publisher, 発行日 and the あらすじ (Rakuten itemCaption). Merged from the MADB
-- master (volumes) + Rakuten and cached permanently — a published book's metadata
-- is immutable, so each ISBN hits Rakuten at most once (same reasoning as `covers`).
-- Only written when the Rakuten lookup was determinate; a rate-limit-skipped lookup
-- is left uncached so a later open can retry. Exception: a row with an empty あらすじ
-- (typically a pre-release volume whose Rakuten description isn't written yet) is
-- re-fetched on open once its checked_at is a day old. See src/book.ts.
CREATE TABLE IF NOT EXISTS book_meta (
  isbn       TEXT PRIMARY KEY,
  authors    TEXT NOT NULL DEFAULT '',  -- "/"-joined author list
  publisher  TEXT NOT NULL DEFAULT '',
  pubdate    TEXT NOT NULL DEFAULT '',  -- already display-formatted
  caption    TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL
);

-- Volumes fetched from live MADB by the search page's 最新DBから取得 (src/search.ts
-- handleLiveSearch) that the master lacks. Server-fetched (never client-supplied), so
-- list items picked from those results can still resolve a title/author by ISBN
-- (src/listItems.ts). One row per ISBN (each sibling ISBN of a volume gets its own row);
-- refreshed on every live search. Rows the master later carries are simply shadowed
-- (the master wins in resolution).
CREATE TABLE IF NOT EXISTS live_volumes (
  isbn          TEXT PRIMARY KEY,   -- normalized ISBN13
  title         TEXT NOT NULL,      -- schema:name (series title, without the volume label)
  volume_number TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  fetched_at    INTEGER NOT NULL
);

-- Key/value metadata. Currently holds the MADB dump provenance written by each
-- ingest: madb_release_tag (release tag), madb_released_at / imported_at (epoch ms).
-- Surfaced in the volume view as "マスター更新". See scripts/ingest.mjs.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── MADB master (メディア芸術データベース単行本LOD) ──────────────────────────
-- Imported monthly from https://github.com/mediaarts-db/dataset releases.
-- Source of truth for series→volume→ISBN correlation. See scripts/ingest.mjs.

CREATE TABLE IF NOT EXISTS series (
  id         TEXT PRIMARY KEY,   -- MADB collection C-id (e.g. C268475)
  name           TEXT NOT NULL,  -- schema:name (series title)
  name_norm      TEXT NOT NULL,  -- normalized title for search (no spaces, lower)
  name_kana      TEXT,           -- kana reading (schema:name ja-hrkt)
  name_kana_norm TEXT,           -- normalized kana (lets カナ queries hit roman-titled series)
  name_search    TEXT,           -- searchKey(name): width-folded, symbols dropped (search only; NULL → name_norm)
  creator        TEXT,           -- representative author (display / grouping)
  creators       TEXT,           -- display credit line, all authors with roles ("原作：A、作画：B")
  creators_norm  TEXT,           -- every credited name, normalized and "|"-joined (search only)
  publisher      TEXT,
  label          TEXT,           -- schema:brand (レーベル)
  num_items      INTEGER         -- schema:numberOfItems
);
CREATE INDEX IF NOT EXISTS idx_series_name_norm ON series (name_norm);
CREATE INDEX IF NOT EXISTS idx_series_kana_norm ON series (name_kana_norm);

CREATE TABLE IF NOT EXISTS volumes (
  isbn          TEXT PRIMARY KEY,  -- normalized ISBN13
  series_id     TEXT,              -- MADB isPartOf C-id (nullable; ~20% unlinked)
  volume_number TEXT,              -- schema:volumeNumber (kept as text: "1","上",...)
  vol_sort      INTEGER,           -- numeric sort key derived from volume_number
  title         TEXT NOT NULL,     -- schema:name (series title on the volume)
  title_search  TEXT,              -- searchKey(title) (search only; NULL → normalized title)
  creator       TEXT,              -- representative author (display / grouping)
  creators      TEXT,              -- display credit line, all authors with roles ("原作：A、作画：B")
  creators_norm TEXT,              -- every credited name, normalized and "|"-joined (search only)
  publisher     TEXT,
  label         TEXT,
  pubdate       TEXT
);
CREATE INDEX IF NOT EXISTS idx_volumes_series ON volumes (series_id, vol_sort);

-- Cache of extra volumes recovered from the live MADB SPARQL endpoint for a series
-- (newer tankobon that exist in MADB but lack schema:isPartOf, so the monthly dump
-- leaves them unlinked — e.g. ONE PIECE vol 101+). See src/madbLive.ts.
CREATE TABLE IF NOT EXISTS series_supplement (
  series_id    TEXT PRIMARY KEY,   -- MADB collection C-id this supplement extends
  volumes_json TEXT NOT NULL,      -- JSON array of extra volumes ("[]" = none found)
  checked_at   INTEGER NOT NULL
);

-- User-submitted corrections: volumes missing from BOTH the dump and live MADB
-- (e.g. ONE PIECE 巻110, absent upstream entirely) that a visitor filled in by
-- picking a real book from the assisted search. Keyed per series C-id, merged into
-- the volume list on read so the fix is cached for everyone. Only isbn/volume are
-- accepted from the client; title/author come from the series row and the cover is
-- re-resolved server-side, so no client-controlled strings are trusted. See
-- src/corrections.ts.
CREATE TABLE IF NOT EXISTS series_correction (
  series_id         TEXT NOT NULL,     -- MADB collection C-id this correction extends
  isbn              TEXT NOT NULL,     -- normalized ISBN13 of the picked edition
  volume_number     TEXT NOT NULL,     -- standard label only ("巻110" / "110")
  vol_sort          INTEGER NOT NULL,  -- numeric sort key derived from volume_number
  cover_url         TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  reviewed_at       INTEGER NOT NULL DEFAULT 0,  -- 管理者が「確定(承認)」した時刻。0=レビュー待ち
  PRIMARY KEY (series_id, isbn)
);
CREATE INDEX IF NOT EXISTS idx_series_correction_series ON series_correction (series_id);

-- Visitor "間違っています" reports against ANY volume in a series view — not just
-- user corrections but master (dump) and live-supplement volumes too, since the
-- master itself can be wrong. A report does NOT hide the row globally: it only bumps
-- report_count here and the reporter's own browser hides it locally (localStorage).
-- The volume stays public for everyone else until an admin reviews and finalizes:
-- for a user correction that means purging (deleting) the series_correction row; for
-- a master/supplement volume it's an upstream data issue to note. Keyed per
-- (series_id, isbn); repeated flags bump the count. See src/corrections.ts
-- (reportVolume) and src/admin.ts (list + dismiss).
CREATE TABLE IF NOT EXISTS volume_report (
  series_id         TEXT NOT NULL,     -- MADB collection C-id the volume was reported under
  isbn              TEXT NOT NULL,     -- normalized ISBN13 of the reported volume
  volume_number     TEXT NOT NULL DEFAULT '',  -- label snapshot for the admin view
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  PRIMARY KEY (series_id, isbn)
);
CREATE INDEX IF NOT EXISTS idx_volume_report_last ON volume_report (last_reported_at);

-- Admin-confirmed globally-hidden volumes. A report only hides the volume on the
-- reporter's own device; when an admin presses 確定 the volume is recorded here so
-- getSeriesVolumes filters it out for EVERYONE (master / supplement / correction
-- alike, since even master data can be wrong and otherwise can't be removed).
-- See src/admin.ts (adminConfirmVolumeReport) and src/series.ts (getSeriesVolumes).
CREATE TABLE IF NOT EXISTS volume_hidden (
  series_id  TEXT NOT NULL,
  isbn       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (series_id, isbn)
);
CREATE INDEX IF NOT EXISTS idx_volume_hidden_series ON volume_hidden (series_id);

-- ── Visitor reports that a series NAME is wrong (シリーズ名の通報) ────────────
-- Upstream MADB data can carry a corrupt series title (e.g. C312117 「ハレグゥ」
-- imported as schema:name "ｖ"). A visitor on the 巻一覧 view can flag the name as
-- wrong. Like volume_report this does NOT rewrite the name globally: it only bumps
-- report_count here (+timestamps) for the admin audit, and the reporter's own browser
-- suppresses nothing (the name is not per-row hidden). The admin reviews and either
-- 却下 (delete this row) or 名前修正 (write series_name_override, applied at read time).
-- reported_name is a best-effort snapshot of the wrong name at report time. Keyed per
-- series_id; repeated flags bump the count. See src/corrections.ts (reportSeriesName)
-- and src/admin.ts (list / dismiss / override).
CREATE TABLE IF NOT EXISTS series_report (
  series_id         TEXT PRIMARY KEY,          -- MADB collection C-id reported
  reported_name     TEXT NOT NULL DEFAULT '',  -- name snapshot at report time
  suggested_name    TEXT NOT NULL DEFAULT '',  -- 通報者が任意で入力した正しい名前の提案（最新の非空値）
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_report_last ON series_report (last_reported_at);

-- Admin-confirmed series name overrides. When an admin fixes a reported name, the
-- corrected title is stored here and applied at READ time (COALESCE over series.name
-- in search + series detail), so it survives the monthly MADB re-ingest that would
-- otherwise restore the corrupt master name. Display-only: search matching still runs
-- against the original name_norm / name_kana_norm columns (the kana reading already
-- carries the real title, so corrupt-named series remain findable). One row per series.
-- See src/admin.ts (adminOverrideSeriesName), src/search.ts and src/series.ts.
CREATE TABLE IF NOT EXISTS series_name_override (
  series_id  TEXT PRIMARY KEY,   -- MADB collection C-id whose display name is overridden
  name       TEXT NOT NULL,      -- corrected series title shown to everyone
  created_at INTEGER NOT NULL
);

-- ── 巻(本)のタイトルの通報 (本のタイトルが違う？) ───────────────────────────
-- MADB のマスタは巻ごとに schema:name を持つが、タイトル表記ゆれの分割などで一部の巻
-- だけ変なタイトル文字列を背負うことがある（例: "Dジェネシス = D GENESIS : ダンジョン…"）。
-- 閲覧者が巻一覧/リスト詳細で「このタイトルを通報」すると、volume_report と同じく
-- 全体へは即時反映せず report_count を増やすだけ（本人端末のみ localStorage で抑止）。
-- 管理者がレビューして 却下 するか、タイトル修正（volume_title_override を書く／シリーズ
-- 最多タイトルへ揃える）する。reported_title は通報時点のマスタタイトルのスナップショット。
-- series_id は通報時に ISBN から解決したもの（最多タイトル算出の対象シリーズ）。1 ISBN 1 行。
-- See src/corrections.ts (reportVolumeTitle) と src/admin.ts (list / dismiss / override)。
CREATE TABLE IF NOT EXISTS volume_title_report (
  isbn              TEXT PRIMARY KEY,          -- normalized ISBN13 of the reported volume
  series_id         TEXT NOT NULL DEFAULT '',  -- resolved series C-id (for most-common計算)
  reported_title    TEXT NOT NULL DEFAULT '',  -- master title snapshot at report time
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_volume_title_report_last ON volume_title_report (last_reported_at);

-- Admin-confirmed per-ISBN title overrides. When an admin fixes a reported volume
-- title (manually, or by snapping to the series' most-common title), the corrected
-- title is stored here keyed by ISBN and applied at READ time in getSeriesVolumes
-- (COALESCE over the master volumes.title), so it survives the monthly MADB re-ingest
-- that would otherwise restore the odd master title. Display-only; one row per ISBN.
-- NOTE: like cover_suggestion, this does NOT retroactively rewrite title snapshots
-- already stored in published lists' items_json. See src/admin.ts and src/series.ts.
CREATE TABLE IF NOT EXISTS volume_title_override (
  isbn       TEXT PRIMARY KEY,   -- normalized ISBN13 whose display title is overridden
  title      TEXT NOT NULL,      -- corrected volume title shown to everyone
  created_at INTEGER NOT NULL
);

-- ── シリーズの結合 (分裂したシリーズを 1 つにまとめる) ─────────────────────
-- 上流 MADB では同一作品が複数の C-id に分裂していることがある（例: 「One piece」SJR 版が
-- C451457 = 1巻 と C451211 = 2〜5巻 に分かれている）。名前・著者・出版社・レーベルが同じ
-- でも新装版/通常版のような別の版も多い（本番で同条件 1,320 組中 843 組は巻番号が重なる）ので
-- 自動では結合せず、閲覧者の依頼 or 管理画面の候補一覧から管理者が確定する。
-- 確定した結合は series_merge に記録し READ 時に適用する（月次再取り込みでも残る）:
--   ・getSeriesVolumes … target を開くと全 member の巻をまとめて返す。absorbed を開くと
--     target を返す（series_id も target になる）。訂正/非表示も member 横断で効く。
--   ・検索 … absorbed は結果から外し、ヒットしていれば target に置き換える。
--   ・リスト表示 (listItems) … absorbed の巻も target のシリーズ名/巻数表記で表示する。
-- 連鎖はさせない: target は常に「どこにも吸収されていない」シリーズ。結合時に正規化する。
-- See src/merge.ts.
CREATE TABLE IF NOT EXISTS series_merge (
  absorbed_id TEXT PRIMARY KEY,   -- 吸収される側の C-id（検索から消え、target に読み替える）
  target_id   TEXT NOT NULL,      -- 残す側の C-id
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_merge_target ON series_merge (target_id);

-- 独自シリーズと巻の紐付け（シリーズに属さない巻のまとまりの結合）。MADB の巻の ~20% は
-- schema:isPartOf を持たない。検索はこれを「書名 + 著者」のまとまり（G<ISBN>）として出し、
-- 閲覧者の依頼 → 管理者の確定で既存シリーズや別のまとまりと結合できる（src/groups.ts,
-- src/merge.ts）。確定すると巻を ISBN 単位で volume_series_link に記録し volumes.series_id を
-- 書き換える。結合先にシリーズが無いとき（まとまり同士）は custom_series に独自シリーズ
-- （ID「U000001」）を作り series にも載せる。series / volumes は月次の取り込みで作り直すので、
-- 取り込み後にこの 2 表から載せ直す（scripts/ingest.mjs の SWAP_SQL）。
CREATE TABLE IF NOT EXISTS custom_series (
  id         TEXT PRIMARY KEY,   -- "U" + 6 桁の連番
  name       TEXT NOT NULL,      -- 作成元のまとまりの書名（表示名は series_name_override で直せる）
  name_norm  TEXT NOT NULL,      -- normTitle(name)
  creator    TEXT,
  publisher  TEXT,
  label      TEXT,
  created_at INTEGER NOT NULL
);
-- シリーズの分離（1 つの C-id に混ざった別の版、例: キン肉マン C261524 の復刻版を独自シリーズへ
-- 移す）も同じ表に from_series_id 付きで記録する。取り込み後の載せ直し・解除は「巻が今
-- from_series_id にいる（NULL ならシリーズ無し）」ときだけ書き換える・そこへ戻す。
CREATE TABLE IF NOT EXISTS volume_series_link (
  isbn       TEXT PRIMARY KEY,   -- マスタ巻の ISBN13
  series_id  TEXT NOT NULL,      -- 紐付け先（C-id か U-id）
  created_at INTEGER NOT NULL,   -- 1 回の結合・分離で紐付けた巻は同じ値（解除の単位）
  from_series_id TEXT            -- 分離元の C-id（NULL = シリーズ無しの巻の紐付け）
);
CREATE INDEX IF NOT EXISTS idx_volume_series_link_series ON volume_series_link (series_id);

-- 閲覧者の「シリーズが分かれている？」依頼。series_report と同じ collect-only 方針で、
-- 全体反映は管理者の確定まで行わない。ペアは (series_a < series_b) に正規化して 1 行、
-- 繰り返しの依頼は report_count を増やす。管理者は 結合（series_merge を書いて行を消す）
-- か 却下（行を消す）。See src/merge.ts (requestSeriesMerge) と管理画面「シリーズの結合」。
CREATE TABLE IF NOT EXISTS series_merge_request (
  series_a          TEXT NOT NULL,   -- 小さい方の C-id
  series_b          TEXT NOT NULL,   -- 大きい方の C-id
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  PRIMARY KEY (series_a, series_b)
);
CREATE INDEX IF NOT EXISTS idx_series_merge_request_last ON series_merge_request (last_reported_at);

-- 閲覧者の「別の版が混ざっている？」依頼（シリーズの分離の依頼）。結合依頼と同じ collect-only
-- 方針で、全体反映は管理者の確定まで行わない。閲覧者が別の版だと選んだ巻を ISBN ごとに 1 行、
-- 繰り返しの依頼は report_count を増やす。series_id は結合済みなら残す側。管理者は 分離（移した
-- ISBN の行を消す）か 却下（そのシリーズの行を消す）。See src/merge.ts (requestSeriesSplit)。
CREATE TABLE IF NOT EXISTS series_split_request (
  series_id         TEXT NOT NULL,   -- 依頼されたシリーズ（C-id / U-id）
  isbn              TEXT NOT NULL,   -- 別の版だと選ばれた巻の ISBN13
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  PRIMARY KEY (series_id, isbn)
);
CREATE INDEX IF NOT EXISTS idx_series_split_request_last ON series_split_request (last_reported_at);

-- 管理画面の自動検出候補（名前・著者・出版社・レーベルが同じで巻番号が重ならない組）を
-- 「別の版なので結合しない」と却下した記録。group_key は候補グループの未結合メンバーの
-- C-id をソートして "," で連結したもの。メンバーが増減すると key が変わり候補に再浮上する。
CREATE TABLE IF NOT EXISTS series_merge_dismissed (
  group_key  TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- ── User-submitted reports of free-text content (通報) ───────────────────────
-- Visitors can flag a list's owner_name or an item's comment as inappropriate.
-- One row per (slug, target_type, position); repeated reports bump report_count
-- instead of piling up rows (light anti-spam). reported_text is a snapshot of the
-- offending text at report time so the admin sees what was flagged even if it later
-- changes. Position is the 1-based item position for comments, 0 for owner_name.
-- See src/reports.ts (public write) and src/admin.ts (audit + redaction).
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL,
  target_type   TEXT NOT NULL,              -- 'owner_name' | 'bio' | 'comment' | 'cover'
  position      INTEGER NOT NULL DEFAULT 0, -- comment/cover: item position (1-based); owner_name/bio: 0
  reported_text TEXT NOT NULL,              -- snapshot at report time (comment text / cover_url)
  report_count  INTEGER NOT NULL DEFAULT 1,
  first_at      INTEGER NOT NULL,
  last_at       INTEGER NOT NULL,
  resolved_at   INTEGER NOT NULL DEFAULT 0, -- 管理者が処理した時刻。0 = 未処理（ソフトデリート）
  resolution    TEXT NOT NULL DEFAULT '',   -- '' | 'dismissed'(誤報却下) | 'redacted'(伏字対応)
  UNIQUE (slug, target_type, position)
);
CREATE INDEX IF NOT EXISTS idx_reports_last_at ON reports (last_at);
CREATE INDEX IF NOT EXISTS idx_reports_resolved ON reports (resolved_at);

-- ── User-submitted cover corrections (表紙の修正) ────────────────────────────
-- リスト編集の「表紙を変更」で、ユーザがキャッシュと違う表紙を選んだときに 1 件収集する。
-- リスト保存ではその表紙はそのリストの items_json にしか入らない＝本人のリストにしか反映
-- されないため、正しい表紙をグローバルな covers キャッシュへ波及させる承認キューとして使う。
-- 巻の通報と同じく「収集するだけ・自動では全体反映しない」: 管理者が承認して初めて covers を
-- 上書きし、全リスト/シリーズ閲覧に反映される。1 ISBN に複数の候補があり得るので PK は
-- (isbn, cover_url)。同じ提案の再送は suggest_count を増やすだけ。old_cover_url は提案時点の
-- キャッシュ値のスナップショット（管理者が新旧を並べて目視するため。'' = 当時キャッシュ無し）。
-- See src/corrections.ts (suggestCover) と src/admin.ts (list / approve / dismiss)。
CREATE TABLE IF NOT EXISTS cover_suggestion (
  isbn          TEXT NOT NULL,              -- 対象書籍の正規化 ISBN13
  cover_url     TEXT NOT NULL,              -- ユーザが選んだ提案表紙 URL
  old_cover_url TEXT NOT NULL DEFAULT '',   -- 提案時点の covers キャッシュ値（'' = 当時無し）
  suggest_count INTEGER NOT NULL DEFAULT 0, -- 同一 (isbn, cover_url) が提案された回数
  first_at      INTEGER NOT NULL,
  last_at       INTEGER NOT NULL,
  resolved_at   INTEGER NOT NULL DEFAULT 0, -- 管理者が処理した時刻。0 = 未処理（ソフトデリート）
  resolution    TEXT NOT NULL DEFAULT '',   -- '' | 'approved'(採用) | 'superseded'(別候補採用) | 'dismissed'(却下) | 'redacted'(表紙通報で伏字。この画像での空欄補完を拒否)
  PRIMARY KEY (isbn, cover_url)
);
CREATE INDEX IF NOT EXISTS idx_cover_suggestion_last ON cover_suggestion (last_at);
CREATE INDEX IF NOT EXISTS idx_cover_suggestion_resolved ON cover_suggestion (resolved_at);

-- ── 公開の監査ログ (audit trail) ─────────────────────────────────────────────
-- リストの新規公開 (POST /api/lists) と更新公開 (PUT /api/lists/:slug) のたびに 1 行
-- 追記する append-only の証跡。アカウントの無い匿名公開サイトなので「誰が」は特定でき
-- る範囲 = 接続元 IP (CF-Connecting-IP) / User-Agent / CF 由来の国を残す。追記のみで
-- 更新・削除しない。See src/lists.ts (recordPublishAudit) と src/admin.ts。
CREATE TABLE IF NOT EXISTS publish_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,               -- 対象リストの slug
  action     TEXT NOT NULL,               -- 'create' (新規公開) | 'update' (更新公開)
  owner_name TEXT,                        -- 公開時点の owner_name スナップショット
  ip         TEXT,                        -- 接続元 IP (CF-Connecting-IP)
  user_agent TEXT,                        -- User-Agent ヘッダ (最大 512 文字)
  country    TEXT,                        -- request.cf.country (取得できた場合)
  created_at INTEGER NOT NULL             -- 公開時刻 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_publish_audit_slug ON publish_audit (slug);
CREATE INDEX IF NOT EXISTS idx_publish_audit_created ON publish_audit (created_at);

-- 売上ランキング（src/salesRanking.ts）。楽天ブックスのコミックを「売れている順」で毎日
-- 上位 300 件取得した日次スナップショット。楽天は期間も部数も出さないので、日ごとの順位を
-- ポイントにして作品単位（work_norm）で過去7日・30日・年間に積み上げる。
CREATE TABLE IF NOT EXISTS sales_snapshot (
  day        TEXT NOT NULL,      -- 取得日 (JST, YYYY-MM-DD)
  rank       INTEGER NOT NULL,   -- その日の順位 (1 始まり)
  isbn       TEXT NOT NULL,      -- ISBN13
  title      TEXT NOT NULL,      -- 楽天の書名そのまま (「SPY×FAMILY 18」)
  work       TEXT NOT NULL,      -- 巻数・版の表記を除いた作品名 (salesWorkTitle)
  work_norm  TEXT NOT NULL,      -- normTitle(work)。集計の単位
  author     TEXT,
  publisher  TEXT,
  sales_date TEXT,               -- 楽天の発売日表記 (「2026年11月04日」「…頃」)
  cover_url  TEXT,
  PRIMARY KEY (day, rank)
);
CREATE INDEX IF NOT EXISTS idx_sales_snapshot_work ON sales_snapshot (work_norm, day);
