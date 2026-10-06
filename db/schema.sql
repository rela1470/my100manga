-- my100manga schema

CREATE TABLE IF NOT EXISTS lists (
  slug        TEXT PRIMARY KEY,
  edit_token  TEXT NOT NULL,
  owner_name  TEXT,
  bio         TEXT NOT NULL DEFAULT '',  -- 作者のひとこと（100文字まで・公開ページ上部に表示）
  items_json  TEXT NOT NULL,             -- [{position, isbn(ISBN13), comment, spoiler}]。表示名・著者・表紙は持たず読み出し時に ISBN から引く (src/listItems.ts)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  user_id     TEXT,                      -- 所有アカウント (users.id)。匿名公開なら NULL。編集権限は edit_token のまま
  unlisted    INTEGER NOT NULL DEFAULT 0 -- 1 = 限定公開: 公開ページを noindex にし、運営からの紹介対象にしない (URL を知っていれば見られる)
);

CREATE INDEX IF NOT EXISTS idx_lists_created_at ON lists (created_at);
CREATE INDEX IF NOT EXISTS idx_lists_user ON lists (user_id);
-- 公開リスト一覧 (/lists) の「限定公開でないものを新しい順」と件数を 1 本で引く (src/publicLists.ts)。
-- rowid が末尾に暗黙に付くので ORDER BY created_at DESC, rowid DESC も索引順で読める。
-- idx_lists_created_at は unlisted で絞らない管理画面の一覧が使う。
CREATE INDEX IF NOT EXISTS idx_lists_public ON lists (unlisted, created_at);

-- ── Google ログイン（任意）──────────────────────────────────────────────
-- ログインは任意で、匿名作成・edit_token による編集はそのまま残る。ログインすると
-- 作成中のリスト (user_drafts, 1 アカウント 1 件) がサーバに保存され、公開したリスト
-- (lists.user_id) をどの端末からでも一覧・編集できる。See src/auth.ts / src/account.ts。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,         -- 内部 ID (randomSlug)
  google_sub    TEXT NOT NULL UNIQUE,     -- Google ID トークンの sub (アカウントの不変キー)
  email         TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  picture       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- ログインセッション。Cookie にはランダムトークン、ここにはその SHA-256 だけを持つ
-- (DB が漏れてもセッションを乗っ取れない)。期限切れ行はログイン時に掃除する。
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- 作成中のリスト (新規作成の下書き)。端末の localStorage 下書きをそのまま同期するので、
-- 公開データと違い title/author/cover_url も持つ (ISBN 未解決の巻も描画できるように)。
CREATE TABLE IF NOT EXISTS user_drafts (
  user_id    TEXT PRIMARY KEY,
  owner_name TEXT NOT NULL DEFAULT '',
  bio        TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL,               -- [{isbn,title,author,cover_url,comment,spoiler}]
  updated_at INTEGER NOT NULL             -- クライアントの保存時刻 (epoch ms)。端末間の新旧判定に使う
);

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

-- 公開ページ (/l/:slug) の日別アクセス数。公開リスト一覧 (/lists) のアクセス数順
-- (今日 / 7日間 / 30日間 / 累計) の元データ。day は JST の YYYY-MM-DD。クローラは数えない。
-- リスト削除時 (adminDeleteList) は slug 単位で掃除する。See src/publicLists.ts。
CREATE TABLE IF NOT EXISTS list_views (
  slug  TEXT NOT NULL,
  day   TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);
CREATE INDEX IF NOT EXISTS idx_list_views_day ON list_views (day);

-- アクセス数の重複判定。同じ訪問者は 1 リストにつき 1 日 1 回だけ数える。visitor は
-- IP + 日付の SHA-256（IP そのものは持たない）。User-Agent は混ぜない（UA を変えるだけで水増し
-- できてしまうため）。前日より古い行は日次 cron で消す。
CREATE TABLE IF NOT EXISTS list_view_seen (
  slug    TEXT NOT NULL,
  day     TEXT NOT NULL,
  visitor TEXT NOT NULL,
  PRIMARY KEY (slug, day, visitor)
);
CREATE INDEX IF NOT EXISTS idx_list_view_seen_day ON list_view_seen (day);

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
  num_items      INTEGER,        -- schema:numberOfItems
  -- 成年向けの巻を 1 冊でも持つシリーズ。R18版 (SITE_VARIANT="adult") の検索が既定でこれだけを
  -- 出し、「全年齢も含める」で外す (src/site.ts adultOnly, src/search.ts)。本家の DB には成年
  -- 向けの行が 1 行も入らない (ingest が adult_volumes へ落とす) ので常に 0。see docs/r18.md
  is_adult       INTEGER NOT NULL DEFAULT 0,
  -- 版表示 (schema:version)。「新装版」「完全版」「愛蔵版」「大判」「カジュアルワイド」など、
  -- 同名シリーズを分ける唯一のマスタ情報。MADB は同じ作品の版違いを同じ schema:name の別
  -- C-id で持つので（横山光輝「三国志」は潮出版社だけで 8 シリーズ）、これが無いと検索結果が
  -- 同名のカードだらけになる。13.9 万シリーズ中 3,923 件が持つ。表示専用で、検索の照合には
  -- 使わない（name_norm / name_kana_norm はそのまま）。外国語の版表示（"1st ed." 等）や、
  -- 既に名前・レーベルに入っている値は取り込みで落とす（scripts/ingest.mjs editionVersion）。
  version        TEXT,
  -- 表示用のシリーズ名。MADB のシリーズ名だけでは区別が付かない同名シリーズのうち、全ての巻が
  -- 同じ副題 (volumes.subtitle = schema:alternateName) を名乗るものに、その副題を足した名前。
  -- 例: C328373「釣りキチ三平」は全 10 巻が副題「作者自選集」を持ち、同名の「釣りキチ三平」が
  -- ほかに 5 件（C326076 / C327929 / C327974 / C328178 / C328197）あるので「釣りキチ三平 作者
  -- 自選集」になる。本の表示タイトルが「釣りキチ三平 1 作者自選集」なのに、シリーズ名だけが
  -- 素の「釣りキチ三平」でレーベルも空欄、という状態を避けるのが目的。
  -- 同名シリーズが無ければ副題は足さない（NULL のまま）: 副題は作品の惹句や英語別名のことも
  -- 多く（「HEAT」の「灼熱」「SWAN」の「白鳥」）、曖昧でない名前に足しても冗長なだけ。
  -- 「同名」は検索の照合キー（name_search）の一致で見る。MADB は同じ作品を「ブラック・ジャック」
  -- 「ブラックジャック」と表記ゆれで別シリーズに持ち、name_norm では別名に見えるが、検索では
  -- 同じキーワードで一緒に並ぶため（C294944 →「ブラックジャック 黒い医師」）。
  -- version と同じく表示専用で、検索の照合（name_norm / name_search / name_kana_norm）にも、
  -- 迷子巻の引き当て（巻の title との完全一致）にも使わない。管理者の名前修正
  -- (series_name_override) があればそちらが優先。読み出しは src/util.ts seriesNameSql。
  -- 埋めるのは取り込み (scripts/ingest.mjs)。see db/add-series-name-display.sql と
  -- db/fix-series-name-display-variants.sql
  name_display   TEXT
);
CREATE INDEX IF NOT EXISTS idx_series_name_norm ON series (name_norm);
CREATE INDEX IF NOT EXISTS idx_series_kana_norm ON series (name_kana_norm);
-- 巻一覧の「同名（＋同レーベル）の別シリーズが無いか」判定 (src/series.ts isSoleSeriesForName 等)。
-- 無いとシリーズを開くたびに全シリーズを数回スキャンする。取り込みの SWAP_SQL でも張り直す。
CREATE INDEX IF NOT EXISTS idx_series_name_label ON series (name, label);
-- 公開前のキャッシュ暖機 (src/warm.ts) が巻数の多いシリーズから順にたどる。取り込みの SWAP_SQL でも張り直す。
CREATE INDEX IF NOT EXISTS idx_series_num_items ON series (num_items DESC, id);
-- 管理画面のレーベル管理 (src/labels.ts) がレーベルごとのシリーズ数を数える GROUP BY label。
-- 取り込みの SWAP_SQL でも張り直す。
CREATE INDEX IF NOT EXISTS idx_series_label ON series (label);

CREATE TABLE IF NOT EXISTS volumes (
  isbn          TEXT PRIMARY KEY,  -- normalized ISBN13
  series_id     TEXT,              -- MADB isPartOf C-id (nullable; ~20% unlinked)
  volume_number TEXT,              -- schema:volumeNumber (kept as text: "1","上",...)
  vol_sort      INTEGER,           -- numeric sort key derived from volume_number
  title         TEXT NOT NULL,     -- schema:name (series title on the volume)
  subtitle      TEXT,              -- schema:name に入らない副題 (schema:alternateName。「獄門塾殺人事件」)
  title_search  TEXT,              -- searchKey(title) (search only; NULL → normalized title)
  creator       TEXT,              -- representative author (display / grouping)
  creators      TEXT,              -- display credit line, all authors with roles ("原作：A、作画：B")
  creators_norm TEXT,              -- every credited name, normalized and "|"-joined (search only)
  publisher     TEXT,
  label         TEXT,
  pubdate       TEXT,
  is_adult      INTEGER NOT NULL DEFAULT 0  -- 成年向けの巻。series.is_adult と同じ扱い
);
CREATE INDEX IF NOT EXISTS idx_volumes_series ON volumes (series_id, vol_sort);
-- シリーズ無しの巻を書名（＋レーベル）で引く巻一覧の取り込み (src/series.ts getSeriesVolumes)。
-- シリーズ無しの巻だけの部分索引。取り込みの SWAP_SQL でも張り直す。
CREATE INDEX IF NOT EXISTS idx_volumes_unlinked_title ON volumes (title, label) WHERE series_id IS NULL;

-- 検索欄の入力補完（サジェスト）用の前方一致索引。シリーズ 1 件につき「引ける綴り」1 つで 1 行
-- （書名 name_norm / 記号無視の name_search / 読み name_kana_norm（複数あれば 1 つずつ）/ 管理者が
-- 直した名前）。/api/suggest（src/suggest.ts）が (key, series_id) の主キーをレンジで引く。
-- LIKE 'q%' は SQLite の LIKE 最適化が ASCII にしか効かず「ドラゴ%」で全表走査になるため、
-- key >= q AND key < q+(最大符号位置) のレンジで引く。実データで 24.5 万行・約 29MB。
-- 中身は月次取り込み（scripts/ingest.mjs SUGGEST_SQL）が series / volumes を入れ替えた直後に
-- 作り直す。管理者の結合・名前修正のあとは管理画面の「サジェスト索引の再構築」で作り直す。
-- どちらも series_suggest_new に作ってから RENAME で入れ替えるので、途中で失敗しても
-- 今の索引は残る（空の表が残って候補が無言で消えることがない）。
-- 作り方は src/suggest.ts SUGGEST_BUILD_SQL と db/add-series-suggest.sql と揃える。
CREATE TABLE IF NOT EXISTS series_suggest (
  key       TEXT NOT NULL,     -- 前方一致で引く綴り（normTitle / searchKey / 読み のいずれか）
  series_id TEXT NOT NULL,     -- C-id / U-id / G-id
  name      TEXT NOT NULL,     -- 候補として出す表示名（上書き > 表示用名 > マスタ名）
  name_key  TEXT NOT NULL,     -- 表示名の揺れを畳むキー（「ONE PIECE」と「One piece」を 1 つに）
  weight    INTEGER NOT NULL,  -- 並び順に使う巻数
  is_adult  INTEGER NOT NULL DEFAULT 0,  -- R18版の既定の絞り込み用（本家は常に 0）
  PRIMARY KEY (key, series_id)
) WITHOUT ROWID;

-- 成年向けとして取り込みから外した巻（MADB の schema:contentRating「成年コミック」等。scripts/ingest.mjs
-- isAdult）。巻自体は volumes に入れず、ISBN 検索・追加・公開で「成年向けの作品は、こちらのサイトでは
-- 追加できません。」と明示するためだけに持つ（src/adult.ts findAdultIsbns）。月次取り込みで series /
-- volumes と一緒に作り直す（adult_volumes_new → SWAP_SQL）。約 8 千行。
-- 書名の照合は '%q%' の LIKE（src/search.ts の adult_hits）なので索引は効かず、全行スキャンになるが
-- 行数が少なく、検索結果自体もエッジキャッシュされるので索引は張らない。
CREATE TABLE IF NOT EXISTS adult_volumes (
  isbn        TEXT PRIMARY KEY,  -- normalized ISBN13
  title       TEXT NOT NULL,     -- schema:name（巻の書名）
  title_norm  TEXT NOT NULL,     -- searchKey(title)（キーワード検索と同じ正規化）
  series_name TEXT               -- 所属シリーズ名（あれば）
);

-- Cache of extra volumes recovered from the live MADB SPARQL endpoint for a series
-- (newer tankobon that exist in MADB but lack schema:isPartOf, so the monthly dump
-- leaves them unlinked — e.g. ONE PIECE vol 101+). See src/madbLive.ts.
CREATE TABLE IF NOT EXISTS series_supplement (
  series_id    TEXT PRIMARY KEY,   -- MADB collection C-id this supplement extends
  volumes_json TEXT NOT NULL,      -- JSON array of extra volumes ("[]" = none found)
  checked_at   INTEGER NOT NULL
);

-- series_supplement の ISBN 逆引き。リスト表示の ISBN 解決 (src/listItems.ts RESOLVE_SQL) が
-- volumes_json を LIKE '%isbn%' で全行なめないよう、補完の各巻の isbns を (isbn, series_id) に
-- 展開して持つ。series_supplement への書き込み経路（src/madbLive.ts・管理画面の削除・取り込みの
-- prune）のどれでもずれないよう、下のトリガで保つ。INSERT OR REPLACE の REPLACE は DELETE
-- トリガを起こさない（recursive_triggers 無効）ので、INSERT トリガでも先に同じ series_id を消す。
CREATE TABLE IF NOT EXISTS series_supplement_isbn (
  isbn      TEXT NOT NULL,   -- 補完の巻の ISBN（volumes_json の isbns の値そのまま。ISBN13）
  series_id TEXT NOT NULL,   -- その巻を持つ series_supplement.series_id
  PRIMARY KEY (isbn, series_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_series_supplement_isbn_series ON series_supplement_isbn (series_id);

CREATE TRIGGER IF NOT EXISTS trg_series_supplement_ai AFTER INSERT ON series_supplement
BEGIN
  DELETE FROM series_supplement_isbn WHERE series_id = NEW.series_id;
  INSERT OR IGNORE INTO series_supplement_isbn (isbn, series_id)
    SELECT ji.value, NEW.series_id
      FROM json_each(CASE WHEN json_valid(NEW.volumes_json) THEN NEW.volumes_json ELSE '[]' END) j,
           json_each(j.value, '$.isbns') ji
     WHERE j.type = 'object' AND ji.type = 'text' AND ji.value <> '';
END;

CREATE TRIGGER IF NOT EXISTS trg_series_supplement_au AFTER UPDATE OF series_id, volumes_json ON series_supplement
BEGIN
  DELETE FROM series_supplement_isbn WHERE series_id = OLD.series_id;
  DELETE FROM series_supplement_isbn WHERE series_id = NEW.series_id;
  INSERT OR IGNORE INTO series_supplement_isbn (isbn, series_id)
    SELECT ji.value, NEW.series_id
      FROM json_each(CASE WHEN json_valid(NEW.volumes_json) THEN NEW.volumes_json ELSE '[]' END) j,
           json_each(j.value, '$.isbns') ji
     WHERE j.type = 'object' AND ji.type = 'text' AND ji.value <> '';
END;

CREATE TRIGGER IF NOT EXISTS trg_series_supplement_ad AFTER DELETE ON series_supplement
BEGIN
  DELETE FROM series_supplement_isbn WHERE series_id = OLD.series_id;
END;

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
-- リスト表示の ISBN 解決 (src/listItems.ts RESOLVE_SQL) が isbn 単独で引く（主キーは series_id 先頭）。
CREATE INDEX IF NOT EXISTS idx_series_correction_isbn ON series_correction (isbn);

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
-- シリーズに属さない巻のまとまり（G-id, src/groups.ts。名前は巻の書名そのもので、「Dr.スランプ」
-- が「Dr」で入っている等）も同じ導線で通報でき、まとまりの正規 ID（G + 最小 ISBN）で記録する。
CREATE TABLE IF NOT EXISTS series_report (
  series_id         TEXT PRIMARY KEY,          -- 通報されたシリーズ: C-id / U-id / G-id
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
-- otherwise restore the corrupt master name. One row per series.
-- シリーズに属さない巻のまとまり（G-id）の名前もここで直す（series_tag と同じ扱い）。series 行が
-- 無いので COALESCE では畳めず、src/groups.ts applyGroupNames がまとまりの正規 ID で引く。
-- 直した名前は検索の照合にも使う（db/add-name-override-search.sql）。マスタの書名が壊れている
-- 作品（『Dr.スランプ』の JC 版 18 巻が「Dr」）は name_norm でも読みでも当たらず、直した名前が
-- 唯一の手掛かりだから。照合用の正規形は修正時に JS で作って name_norm / name_search に入れ、
-- 完全一致はマスタ名の完全一致より 1 段上に置く（src/search.ts matchNameOverrides）。
-- See src/admin.ts (adminOverrideSeriesName), src/search.ts and src/series.ts.
CREATE TABLE IF NOT EXISTS series_name_override (
  series_id   TEXT PRIMARY KEY,          -- 表示名を上書きするシリーズ: C-id / U-id / G-id
  name        TEXT NOT NULL,             -- corrected series title shown to everyone
  -- 検索の照合用。normTitle(name) / searchKey(name)（series の同名列と同じ畳み方）。
  -- 古い行・他の経路で入った行は空のことがあり、読み出し側が SQL で代用する。
  name_norm   TEXT NOT NULL DEFAULT '',
  name_search TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- ── レーベルのタグ付け（廉価版・文庫版） ────────────────────────────────────
-- 「KPC」「講談社プラチナコミックス」のように、名前を見ればコンビニ廉価版・文庫版だと分かる
-- レーベルがマスタに多数ある（マスタ側にその区別を表す列は無い）。管理画面（レーベル管理）で
-- レーベルにタグを付けると、そのレーベルのシリーズの検索カード・巻一覧に「廉価版」「文庫版」
-- と出る。series.version（新装版・完全版…）と役割が似ているが、あちらは MADB 由来の版表示で、
-- こちらは運営がレーベル単位で付ける印。
-- series / volumes は月次の取り込みで表ごと作り直される（scripts/ingest.mjs SWAP_SQL）ので、
-- series.id ではなく **レーベル名そのもの** を鍵にして取り込みで消えないようにしてある。
-- See src/labels.ts。
CREATE TABLE IF NOT EXISTS label_tag (
  label      TEXT PRIMARY KEY,   -- series.label / volumes.label の値そのまま（正規化しない）
  tag        TEXT NOT NULL,      -- src/labels.ts LABEL_TAGS のいずれか（'廉価版' / '文庫版'）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- レーベル単位では粒度が足りないとき（同じレーベルに文庫版でない本が混じる等）の、
-- シリーズ単位の上書き。label_tag より優先する。tag = '' は「タグ無し」を明示する上書きで、
-- レーベルのタグを打ち消す（行が無い＝レーベルに従う、と区別するため NULL ではなく空文字）。
CREATE TABLE IF NOT EXISTS series_tag (
  series_id  TEXT PRIMARY KEY,   -- C-id / U-id / G-id
  tag        TEXT NOT NULL,      -- src/labels.ts LABEL_TAGS のいずれか、または ''
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 閲覧者からのタグの申請。シリーズ名の通報・結合/分離依頼と同じ collect-only 方針で、
-- ここには件数だけ積み、全体への反映は管理者が series_tag に確定したときだけ行う。
CREATE TABLE IF NOT EXISTS series_tag_request (
  series_id         TEXT NOT NULL,
  tag               TEXT NOT NULL,   -- 申請されたタグ。'' = 「ついているタグを外してほしい」
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  PRIMARY KEY (series_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_series_tag_request_last ON series_tag_request (last_reported_at);

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

-- ── 上流（MADB）が壊している巻のマスタ行を丸ごと差し替える ─────────────────
-- MADB の巻は ISBN 自体を取り違えていることがある。実例: 9784063129502 は実際には
-- 『Rave』9 巻（真島ヒロ / 講談社コミックス / 2001-03。openBD・NDLサーチで確認）だが、MADB は
-- これを『超感電少女モナ』（安野モヨコ / 講談社コミックスフレンドB / 1994-04-13）の ISBN として
-- 登録している。モナの正しい ISBN は 9784063029505（4-06-302950-6）で、1 桁の取り違え
-- （302950 → 312950）。この 1 行のせいで Rave は 9 巻が欠番になり、その ISBN を手で足そうとしても
-- 「別シリーズの巻の ISBN は採らない」規則（src/corrections.ts ownersOfOtherSeries）に弾かれる。
--
-- 読み出し時の上書き（volume_title_override / series_name_override）では足りない: 間違っているのは
-- 表示名だけでなく シリーズ・巻番号・著者・発行日の全部で、巻一覧・リスト表示・詳細（src/book.ts は
-- マスタの creator / pubdate を楽天より優先）とどれも別経路で読む。そこでマスタ行そのものを正す。
-- volumes は月次取り込みで作り直されるので、この表を正本として取り込みの最後に載せ直す
-- （scripts/ingest.mjs の APPLY_MASTER_FIX_SQL — keep in sync）。
--
-- 行は「直した後のマスタ行そのもの」。部分指定ではなく全列を書く（上流の値は信用しないので
-- COALESCE で混ぜない）。INSERT OR REPLACE なので、上流に無い ISBN（取り違えで消えた側の巻）は
-- 新しい行として入る。列は volumes と同じ並びで揃える（scripts/ingest.mjs の VOLUMES_COLS）。
--
-- 注意:
--   ・成年向けの巻は入れない。本家の DB には成年向けの行が 1 行も無い前提（ingest が
--     adult_volumes へ落とす）で、この表は本家にもそのまま載せ直すため。
--   ・行は消さない方向の仕組み。巻を消す/隠すのは volume_hidden。
--   ・volume_series_link より後に当てる（シリーズの紐付けも含めてここが最終の値）。
--   ・DEV_RESET_TABLES（src/admin.ts の開発用リセット）には入れない。volume_series_link と同じく
--     管理者が確定したマスタ整形データで、取り込みで作り直せないため。
CREATE TABLE IF NOT EXISTS volume_master_fix (
  isbn          TEXT PRIMARY KEY,  -- 直す（または足す）巻の ISBN13
  series_id     TEXT,
  volume_number TEXT,
  vol_sort      INTEGER,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  title_search  TEXT,              -- searchKey(title)（src/util.ts）。検索の照合に使う
  creator       TEXT,
  creators      TEXT,
  creators_norm TEXT,
  publisher     TEXT,
  label         TEXT,
  pubdate       TEXT,
  is_adult      INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',  -- なぜ直したか・根拠（openBD / NDLサーチ 等）
  created_at    INTEGER NOT NULL,
  -- 差し替える前のマスタ行（JSON、volumes の列そのまま）。管理画面の「取り消し」がこれを
  -- 書き戻す。NULL ＝ 上流にその ISBN の行が無かった（取り違えで消えた側の巻を足した場合）
  -- ＝ 取り消しでは volumes から消す。取り込みを挟むと上流の値が変わっていることがあるが、
  -- 戻した値は次の取り込みでどのみち上流の行に置き換わるので、控えは作った時のままでよい。
  prev_json     TEXT
);

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
-- cover_url で引く 2 か所（src/corrections.ts suggestCover の却下済み判定・src/covers.ts
-- redactedCoverUrls）。処理済みの提案も行を残すので表は増え続ける。書き込みは提案時だけ。
CREATE INDEX IF NOT EXISTS idx_cover_suggestion_url ON cover_suggestion (cover_url);

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

-- 閲覧者からの「この作品をシリーズとして登録してほしい」依頼（src/seriesRegister.ts）。
-- 対象は「MADB に丸ごと無い作品」。ISBN 検索では楽天ブックス由来の 1 冊ライブカード
-- （src/search.ts rakutenCard、series_id が "rakuten<ISBN>" の擬似 ID）にしかならず、
-- シリーズとして開く・全巻まとめて追加する・結合や名前修正の導線に乗せる、がどれもできない。
--
-- 他の申し出（series_report / series_merge_request / cover_suggestion）と同じ collect-only 方針で、
-- 全体反映は管理者が確定するまで行わない。依頼が運ぶのは ISBN 1 つだけで、書名・著者・出版社は
-- サーバが自分の控え（live_volumes / book_meta）から引く。利用者の自由入力を 1 文字も受けないので、
-- 通報・伏字の対象になる文字列がこの表に入ることはない。
--
-- 管理者の確定がやること（src/seriesRegister.ts adminRegisterSeries）:
--   1. custom_series に独自シリーズ（U-id）を 1 行作る
--   2. 選んだ巻を volume_master_fix 行として書き、その場で volumes へ当てる（series_id = U-id）
-- どちらも月次取り込みのあとに載せ直される（scripts/ingest.mjs の APPLY_LINKS_SQL →
-- APPLY_MASTER_FIX_SQL の順。後者が最終の値）。できあがるのは普通のシリーズ 1 件と普通のマスタ巻 n 行
-- なので、巻一覧・検索・リスト表示・詳細はこの仕組みを知らなくていい。
--
-- 取り消しは管理画面「マスタ行の修正」の取り消し（prev_json が NULL なので volumes から消える）。
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
