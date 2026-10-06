# D1 マイグレーション台帳

`db/schema.sql` は新規 DB 用の完全なスキーマ（全部 `IF NOT EXISTS`）。既存の DB には、そのあとに足した
変更を `db/*.sql` の個別ファイルで流す。D1 の `migrations` 機能は使っておらず、どこまで流したかは
DB 側に記録されないので、この表で管理する。

- **流したら、その場でこの表の日付を埋めてコミットする**（dev / 本番それぞれ）。
- 「未確認」は、git の履歴と作業メモから適用日を確かめられなかったもの。必要なら
  `wrangler d1 execute DB [--env dev] --remote --command "SELECT name, sql FROM sqlite_master"` で列・表・索引の
  有無を見て埋める。
- 流す前に下の「バックアップ」を必ず行う。dev / 本番への適用・デプロイ・ingest はリポ直下の CLAUDE.md の
  手順（全セッションへの予告）に従う。

## 台帳

| ファイル | 目的 | 冪等 | dev 適用 | 本番適用 |
|---|---|---|---|---|
| `schema.sql` | 新規 DB の完全スキーマ（`npm run db:init:*`） | ○ | 初期構築時 | 初期構築時 |
| `add-soft-delete.sql` | reports / cover_suggestion のソフトデリート列 | × | 未確認 | 未確認 |
| `backfill-events.sql` | 既存リストから `list_item_events` を seed（ランキング） | ○ | 未確認 | 未確認 |
| `add-series-report-suggestion.sql` | `series_report.suggested_name` | × | 未確認 | 未確認 |
| `add-list-bio.sql` | `lists.bio` | × | 未確認 | 未確認 |
| `migrate-list-data-by-isbn.sql` | `items_json` を ISBN だけの形へ移行・`live_volumes` | ×（DROP COLUMN） | 未確認 | 未確認 |
| `add-series-merge.sql` | `series_merge` / `series_merge_request` / `series_merge_dismissed` | ○ | 未確認（2026-10-02 の結合データ投入の前提なので、それ以前のはず） | 未確認（同左） |
| `series-merge-data.sql` | 結合データ（ローカルで確定 → dump → 投入。upsert） | ○ | 2026-10-02（166 件）、2026-10-03 再投入 | 2026-10-02（166 件）、2026-10-03 再投入 |
| `add-custom-series.sql` | `custom_series` / `volume_series_link`（シリーズ無しの巻の結合） | ○ | 2026-10-03 | 2026-10-03 |
| `add-series-split.sql` | `volume_series_link.from_series_id` / `series_split_request`（分離） | ×（ALTER） | 2026-10-03 | 2026-10-03 |
| `fix-kanji-vol-sort.sql` | 漢数字の巻の `vol_sort` 修正（データ修正） | ○ | 未確認 | 未確認 |
| `fix-arc-vol-sort.sql` | 「〜編N」の巻の `vol_sort` 修正（データ修正） | ○ | 未確認 | 未確認 |
| `add-sales-snapshot.sql` | `sales_snapshot`（売上ランキング） | ○ | 未確認 | 未確認 |
| `add-name-search.sql` | `series.name_search` / `volumes.title_search`（記号無視の検索。取り込み直しで埋まる） | × | 未確認 | 未確認 |
| `add-creators.sql` | `series.creators` / `volumes.creators`（役割付き作者表示。**デプロイ前に**） | × | 未確認（2026-10-03 に creators を dev へデプロイ・ingest した記録あり） | 未確認 |
| `add-creators-norm.sql` | `creators_norm`（共著者でも検索に掛かる） | × | 未確認 | 未確認 |
| `add-list-views.sql` | `list_views`（公開リスト一覧のアクセス数順） | ○ | 未確認 | 未確認 |
| `add-list-view-seen.sql` | `list_view_seen`（アクセス数の重複判定） | ○ | 未確認 | 未確認 |
| `add-list-unlisted.sql` | `lists.unlisted`（限定公開） | × | 2026-10-03 | 2026-10-03 |
| `add-accounts.sql` | `users` / `sessions` / `user_drafts` / `lists.user_id`（Google ログイン） | × | 2026-10-03 | 2026-10-03 |
| `add-indexes-2026-10.sql` | 公開前の索引見直し・`series_supplement_isbn`（逆引き表＋トリガ）。**デプロイ前に** | ○ | 2026-10-03 | 2026-10-03 |
| `add-adult-volumes.sql` | `adult_volumes`（成年向けで除外した巻。追加不可の明示用。中身は取り込み直しで埋まる）。**デプロイ前に** | ○ | 2026-10-03 | 2026-10-03 |
| `add-circulation.sql` | `circulation`（発行部数ランキング）＋ `idx_series_num_items`（暖機が巻数順にたどる索引）。**デプロイ前に** | ○ | 2026-10-04 | 2026-10-04 |
| `circulation-data.sql` | 発行部数ランキングの中身（`scripts/wikipedia-circulation.mjs` が生成。全件入れ替え） | ○ | 2026-10-04 | 2026-10-04 |
| `add-circulation-link.sql` | `circulation_link`（発行部数ランキングの寄せ先の指定）。**デプロイ前に** | ○ | 2026-10-04 | 2026-10-04 |
| `circulation-links.sql` | 寄せ先の指定の中身（`scripts/dump-circulation-links.mjs` が生成。upsert） | ○ | 2026-10-04 | 2026-10-04 |
| `add-is-adult.sql` | `series.is_adult` / `volumes.is_adult`（R18版が成年向けを収録するための印。本家では常に 0）。**R18版の D1 では ingest の前に** | × | 未適用 | 未適用（本家は次の月次 ingest で shadow テーブルごと入れ替わるときに入る。R18版は dev 2026-10-04 適用済み・本番未適用） |
| `add-volume-subtitle.sql` | `volumes.subtitle`（巻の副題。同じ巻番号の別作品が 1 冊に畳まれるのを直す。中身は取り込み直しで埋まる）。**デプロイ前に** | × | 2026-10-04 | 2026-10-04 |
| `add-series-version.sql` | `series.version`（版表示。同名の版違いシリーズを見分ける。中身は取り込み直しで埋まる）。**デプロイ前に** | × | 2026-10-04 | 2026-10-04 |
| `add-label-tag.sql` | `label_tag`（レーベルの廉価版・文庫版タグ）＋ `idx_series_label`（管理画面のレーベル一覧）。**デプロイ前に** | ○ | 2026-10-05 | 2026-10-05（R18版も dev / 本番とも 2026-10-05 適用・デプロイ済み） |
| `add-series-tag.sql` | `series_tag` / `series_tag_request`（シリーズ個別のタグと利用者申請）。**デプロイ前に** | ○ | 2026-10-05 | 2026-10-05（R18版も dev / 本番とも同日 適用・デプロイ済み） |
| `add-series-name-display.sql` | `series.name_display`（同名シリーズを見分ける表示用名。ALTER + 今のデータへのバックフィル）。**デプロイ前に** | × | 2026-10-05 | 2026-10-05（R18版も dev / 本番とも同日 適用・デプロイ済み） |
| `fix-series-name-display-variants.sql` | `name_display` の「同名」判定を検索の照合キー基準に直して入れ直す（「ブラック・ジャック」と「ブラックジャック」）。**デプロイ前に** | ○ | 2026-10-05 | 2026-10-05（R18版も dev / 本番とも同日 適用・デプロイ済み） |
| `add-name-override-search.sql` | `series_name_override.name_norm` / `name_search`（管理者が直した名前を検索の鍵にもする。ALTER + 既存行の `name_norm` バックフィル）。**デプロイ前に** | ×（ALTER。`UPDATE` は `WHERE name_norm = ''` なので再実行可） | 2026-10-05 | 2026-10-05（R18版も dev / 本番とも同日 適用・デプロイ済み） |
| `add-volume-master-fix.sql` | `volume_master_fix`（上流が壊している巻のマスタ行を丸ごと差し替える）＋ 9784063129502（Rave 9 巻）と 9784063029505（超感電少女モナ）の 2 件。管理画面「マスタ行の修正」が読み書きするので**デプロイ前に** | ○ | 2026-10-05 | 2026-10-05（R18版も dev / 本番とも同日 適用・デプロイ済み） |
| `remove-redundant-name-overrides.sql` | タグ（廉価版・文庫版・傑作選）で言えるようになったシリーズ名の修正 13 件を外す（`series_name_override` の DELETE）。管理画面の「修正を外す」導線と同時に入れるので**デプロイ後でも可**（SQL だけでも成立する） | ○ | 2026-10-05（0 件。該当行が無い） | 2026-10-05（13 件削除。R18版も dev / 本番とも同日 適用・デプロイ済み、どちらも 0 件） |
| `add-series-suggest.sql` | `series_suggest`（検索欄の入力補完の前方一致索引。マスタから作り直すので中身も入る）。`src/suggest.ts` が読むので**デプロイ前に**。適用後にファイルを `series_suggest_new` + `RENAME` 方式へ書き換えたが、出来上がる表は同じなので流し直しは不要 | ○ | 2026-10-06（245,177 行） | 2026-10-06（245,179 行。R18版も dev / 本番とも同日 適用・デプロイ済み、どちらも 257,560 行） |
| `add-series-register.sql` | `series_register_request`（マスタに丸ごと無い作品の「シリーズとして登録してほしい」依頼。collect-only）。`src/seriesRegister.ts` が読み書きするので**デプロイ前に** | ○ | 2026-10-06 | 2026-10-06（R18版も dev / 本番とも同日 適用・デプロイ済み） |

冪等: ○ = 何度流しても同じ結果。× = 2 回目はエラーになる（`ALTER TABLE ... ADD COLUMN` など。エラーで
止まるだけで壊れはしないが、同じファイルの後続の文も流れない）。

### 発行部数ランキングの 4 ファイルの注意

- `src/circulation.ts` と `src/warm.ts` が `circulation` / `circulation_link` を参照するので、**全部流してから**デプロイする
  （逆順だと `/circulation` と管理画面の「発行部数ランキング」「キャッシュ暖機」が「no such table」で落ちる）。

- `circulation-data.sql` は `DELETE FROM circulation` から始まる全件入れ替えで、手で編集しない。更新するときは
  `node scripts/wikipedia-circulation.mjs` を実行して作り直す（Wikipedia の最新版を取り直し、取得した oldid を
  `meta.circulation_source` に記録する）。
- 順番は `add-circulation.sql`（表と索引）→ `add-circulation-link.sql`（寄せ先の指定の表）→
  `circulation-data.sql`（作品と部数）→ `circulation-links.sql`（寄せ先の指定）。
- 流した後に管理画面「発行部数ランキング」の**再集計**を実行する（寄せ先と表紙を付け直す）。
  2 つのデータ SQL の末尾で `meta` の集計を消しているので、忘れても最初のアクセスで作り直される。
- `circulation_link` は**作品 → シリーズの寄せ先の指定**で、`circulation` とは別の表にしてある。
  Wikipedia を取り込み直すと `circulation` は `DELETE` → `INSERT` で全件入れ替わるので、同じ表に
  置くと指定が消えるため。`circulation-links.sql` は upsert で、本番で手動指定（`source='manual'`）した
  行はローカルのサジェストで潰さない。
- 既定の `circulation-links.sql` は 197 件すべて `source='suggested'`（自動照合の結果）。間違っている
  ものだけ管理画面で直し、`node scripts/dump-circulation-links.mjs` で書き出し直して本番へ流す
  （シリーズ結合の `series-merge-data.sql` と同じ運用）。
- `idx_series_num_items` は `series`（約 14 万行）への索引で、作成に数秒かかる。月次取り込みの差し替え
  （`scripts/ingest.mjs` の `SWAP_SQL`）でも張り直している。

### `add-label-tag.sql` の注意

- レーベルのタグ付け（廉価版・文庫版、`src/labels.ts`）。`label_tag` 表と `idx_series_label` の 2 つだけで、
  中身は空（管理画面「レーベル管理」で付けていく）。
- **必ずデプロイより前に流すこと。** `add-series-version.sql` と同じ種類の前提で、検索（`src/search.ts`
  の `SERIES_COLS`）とシリーズの巻一覧（`src/series.ts`）がシリーズ行と同じ 1 本の SQL で
  `label_tag` を引く（D1 の往復を増やさないため）。表が無いまま新しいコードを出すと
  `no such table: label_tag` で**検索と巻一覧が全部落ちる**。
- 本家・R18版の両方に要る（同じコードで動くため）。dev / 本番それぞれ。
- `idx_series_label` は `series`（約 14 万行）への索引で、作成に数秒かかる。月次取り込みの差し替え
  （`scripts/ingest.mjs` の `SWAP_SQL`）でも張り直す。
- タグの中身（どのレーベルに何を付けたか）は本番の管理画面で付ける運用。ローカルで付けて本番へ
  持っていく必要が出たら、`series-merge-data.sql` と同じく upsert の SQL に書き出す。

### `add-series-tag.sql` の注意

- シリーズ個別のタグ（`series_tag`）と、その利用者申請（`series_tag_request`）。表 2 つと索引 1 本で、
  中身は空。レーベル単位のタグでは拾えないシリーズ（同じレーベルに文庫版でない本が混じる等）を
  個別に上書きする。`series_tag.tag = ''` は「タグ無し」を明示する上書きで、レーベル由来の印を打ち消す。
- **必ずデプロイより前に流すこと。** `add-label-tag.sql` と同じ理由で、検索（`src/search.ts` の
  `SERIES_COLS`）とシリーズの巻一覧（`src/series.ts`）が `src/labels.ts` の `effectiveTagSql` を
  畳み込んで `series_tag` を引く。表が無いまま新しいコードを出すと `no such table: series_tag` で
  **検索と巻一覧が全部落ちる**。
- 本家・R18版の両方に要る（同じコードで動くため）。dev / 本番それぞれ、計 4 つ。
- 索引は `series_tag_request(last_reported_at)` の 1 本だけ（管理画面のキューを新しい順に出す）。
  `series` / `volumes` への索引ではないので、取り込みの差し替え（`scripts/ingest.mjs` の `SWAP_SQL`）に
  足す必要は無い。

### `add-series-name-display.sql` の注意

- 同名シリーズを見分けるための表示用シリーズ名（`series.name_display`）。全ての巻が同じ副題
  （`volumes.subtitle`）を名乗り、かつ同じ `name_norm` のシリーズが他にもあるときだけ、その副題を
  足した名前が入る。例: C328373「釣りキチ三平」→「釣りキチ三平 作者自選集」（同名が 6 件あり、
  うち全巻一致の副題を持つのはこれだけ）。
- **必ずデプロイより前に流すこと。** 検索（`src/search.ts` の `SERIES_COLS`）・巻一覧・本の詳細・
  管理画面が `src/util.ts` の `seriesNameSql()` 越しに `s.name_display` を読むので、列が無いまま
  新しいコードを出すと `no such column: s.name_display` で**検索と巻一覧が全部落ちる**。
- 本家・R18版の両方に要る（同じコードで動くため）。dev / 本番それぞれ、計 4 つ。
- `ALTER TABLE ... ADD COLUMN` なので**冪等ではない**（2 回目は "duplicate column name" で止まり、
  後続の `UPDATE` も流れない）。流し直すときは `UPDATE` 以降だけを流す。
- ファイルの後半の `UPDATE` は、取り込みを待たずに今のデータへ反映するためのバックフィル。
  `series`（約 14 万行）と `volumes`（約 35 万行）を引くが索引が効くので、ローカル実測で 2 秒。
- 月次取り込み（`scripts/ingest.mjs`）が毎回 `name_display` を入れ直すので、以後は取り込みに任せる。
  取り込み側の判定が本体で、このファイルの SQL はそれに合わせた写し（SQLite の `LOWER` が ASCII しか
  畳まないぶん、全角英字の重複判定だけがゆるい）。
- `series_name_override`（管理者の名前修正）があればそちらが優先なので、既に手で直したシリーズの
  表示は変わらない。

### `fix-series-name-display-variants.sql` の注意

- `add-series-name-display.sql` の続き。列は足さず、`name_display` を**全部入れ直す**だけ。
  最初の版は「同名」を `name_norm` の一致で見ていたが、MADB は同じ作品を表記ゆれで別シリーズに
  持つ（C294944「ブラックジャック」と C276567 ほか 14 件「ブラック・ジャック」）。利用者の検索は
  `name_search`（記号・全角半角を落としたキー）で照合するので 15 件が一緒に並ぶのに、
  C294944 だけ見分けが付かないままだった。判定を `COALESCE(name_search, name_norm)` の一致に変える。
- ローカルのマスタで 4,402 件 → 4,584 件。`name_norm` が一致する組は `name_search` でも必ず
  一致するので、この変更で表示名を失うシリーズは無い（増えるだけ）。
- **冪等**（`UPDATE` 2 本だけ。1 本目で既存の `name_display` を NULL に戻してから入れ直す）。
  何度流してもよい。ローカル実測で 2 秒。
- **デプロイより前に流すこと。** 列自体は `add-series-name-display.sql` で足してあるので、
  流す前にデプロイしても落ちはしないが、C294944 のようなシリーズの表示名が古いままになる。
- 本家・R18版の両方に要る。dev / 本番それぞれ、計 4 つ。
- 判定の中身（全巻が同じ非空の副題／副題に「：」を含まない／名前が既にその副題を含まない）は
  変えていない。取り込み（`scripts/ingest.mjs` の「3.5」）が本体で、このファイルはその写し。

### `fix-series-name-display-variants.sql` の適用記録（2026-10-05、全 4 環境）

4 つの DB すべてに適用 → 4 環境デプロイ。ingest なし。コミット `e8dd76a`
（表記ゆれの同名の見分けと、管理画面のシリーズ名を表示名に揃える分）。実施時に他セッションは
走っていなかったので（`ListAgents` で確認）、予告は省略。

- 適用前の Time Travel ブックマーク:

  | 環境 | bookmark |
  |---|---|
  | 本家 本番 | `000000f6-000000e0-000050fb-3e5039a5637878c1c60b8703a5f8b1f1` |
  | 本家 dev | `000000e2-00000000-000050fb-b42d35107311a3607113863396fba6bd` |
  | R18 dev | `00000015-00000000-000050fb-d80cf8548328b6cfe1ed8956139393db` |
  | R18 本番 | `0000001c-00000000-000050fb-5f4a80325bc5e379cbb526a069caa72d` |

- ユーザデータの書き出し: `backups/prod-20261005-namedisplay2.sql`（274KB）/
  `backups/dev-20261005-namedisplay2.sql`。R18 は `lists` 0 / `users` 0 なので従来どおり取らない。

- `name_display` が付いたシリーズ数: 本家 4,402 → **4,584**、R18 4,483 → **4,673**。
  `rows_written` は 4 環境とも 8,986（NULL 戻し 4,402 + 入れ直し 4,584）。

- デプロイ後の Version ID:

  | 環境 | Version ID |
  |---|---|
  | 本家 dev | `ea45a417-6b94-41f6-8f9a-e13b0c83ee26` |
  | 本家 本番 | `03d6c499-4969-49e0-b72c-13725889be6c` |
  | R18 dev | `850001f2-13cd-4278-a778-82b56b68ded5` |
  | R18 本番 | `47e17152-afcf-4e8c-8b54-731ff0c48a62` |

- 確認: 本家 本番・dev の `GET /api/search?q=ブラックジャック` で C294944 が
  「ブラックジャック 黒い医師」になった（同名 15 件のうち、全巻一致の副題を持つのはこれだけ）。
  C328373「釣りキチ三平 作者自選集」も維持。

### `add-series-tag.sql` の適用記録（2026-10-05、全 4 環境）

4 つの DB すべてに適用 → 4 環境デプロイ。ingest なし。コミット `a1aeb68`。
並行していた 2 セッション（my100manga-1f / my100manga-86）に予告して OK を得てから実施。

- 適用前の Time Travel ブックマーク:

  | 環境 | bookmark |
  |---|---|
  | 本家 本番 | `000000ef-00000000-000050fb-413cf125966a6a67800daf7de2a1bee1` |
  | 本家 dev | `000000de-00000000-000050fb-6fc927058cb8f1cd997998a6f8aa96d4` |
  | R18 dev | `00000010-00000000-000050fb-eec64e743641c63152b4ecdbc13e179c` |
  | R18 本番 | `00000017-00000000-000050fb-f0091d70abcf9c0070f6a89b82f03e1c` |

- ユーザデータの書き出し: `backups/prod-20261005-1736-seriestag.sql`（547KB）/
  `backups/dev-20261005-1736-seriestag.sql`。**`--table label_tag` を足すこと**（この時点で本番に
  344 行あり、管理画面で手作業で付けたもの＝取り込みで作り直せない）。R18 は `lists` 0 /
  `users` 0 なので従来どおり export は取らない。
- 4 つとも `series_tag` / `series_tag_request` / `idx_series_tag_request_last` の 3 つが出来た。
  本番は適用前後とも `label_tag` 344 / `series` 133,606 / `lists` 1 / `users` 1 /
  `series_merge` 194 / `series_correction` 148 で無傷、`series_tag` は 0 行。
- デプロイ（migration の後）:

  | 環境 | Version ID |
  |---|---|
  | 本家 dev | `7026f3be-a0a6-4678-945f-926c73c117ce` |
  | 本家 本番 | `4643478f-c31f-4aef-a7d5-7002fe6e6022` |
  | R18 dev | `982b0906-95de-44a3-9452-503cf442a155` |
  | R18 本番 | `bbe586b8-724f-4f91-908c-3cffa0f867d7` |

- 確認:

  | 確認 | 結果 |
  |---|---|
  | 本家 本番 `/` `/lists` `/ranking` `/circulation` `/sales-ranking` `/l/rela1470` | すべて 200 |
  | `GET /api/search?q=GTO` | `KPC`→廉価版 / `講談社漫画文庫`→文庫版（既存 344 件のタグが生きている） |
  | `GET /api/series/C322586/volumes` | GTO 56 巻・`label_tag: "廉価版"` |
  | `POST /api/series/:id/tag-request`（トークン無し） | 403 ボット確認（Turnstile の feedback グループに入っている） |
  | R18 dev / 本番 `&all=1` の検索 | 30 件・`label_tag` を返す（`series_tag` を引く経路が通る） |
  | R18 本番 `GET /api/series/C268196/volumes` | ONE PIECE 100 巻 |
  | admin（4 環境・未認証） | 本家 401 / R18 403 |

### `add-label-tag.sql` の適用記録

**dev（2026-10-05）**

- 適用前の Time Travel ブックマーク: `000000db-00000000-000050fb-4f29bb3769f44e0b0cda18dd8029af65`
- ユーザデータの書き出し: `backups/dev-20261005-1533-labeltag.sql`（`users` 1 / `series_merge` 168 /
  `custom_series` 1 / `volume_series_link` 36 / `series_correction` 3。`lists` は 0 件）
- `db/add-label-tag.sql` を適用（`rows_read` 268,989 / `rows_written` 133,588 = `idx_series_label` の作成、
  363ms）。`label_tag` 0 行、`series` 133,584 / `volumes` 349,020 と他のユーザデータは適用前後とも同数。
  レーベルは 7,808 種。
- 適用の時点では dev の Worker は旧コードのまま（旧コードは `label_tag` を参照しないので、
  表だけ先にある状態は無害）。そのあと `npm run deploy:dev` → Version ID
  `c91d1686-fed8-4b15-9e55-04c1d6ca5281`。**順番は migration → デプロイ**（逆だと
  `no such table: label_tag` で検索と巻一覧が落ちる）。ingest は不要（マスタの列は増えていない）。
- デプロイ後の確認:

  | 確認 | 結果 |
  |---|---|
  | `GET /` / `/lists` / `/ranking` / `/api/version` | すべて 200（`version` = `c91d1686`） |
  | `GET /api/search?q=GTO` | 4 件のカードが `label_tag` を返す（タグ未設定なので全部 `""`） |
  | `GET /api/series/C322586/volumes` | 200・56 巻・`label_tag: ""` |
  | `GET /api/admin/labels`（未認証） | 401（Cloudflare Access で閉じている） |
  | `GET /admin`（未認証） | 302（Access のログインへ） |

- 管理画面は Access の内側で手元から叩けないので、**管理画面が行うのと同じ 2 つの書き込み**
  （`label_tag` の upsert と `meta.view_epoch` の更新）を SQL で入れて読み出し側を確認した。
  `KPC` → `廉価版` の 1 件だけ入れてある（**dev にはこの 1 行が残っている**。管理画面から
  変更・解除できる）。`getViewEpoch` の isolate メモが 30 秒あるので、反映の確認はその後:

  | 確認 | 結果 |
  |---|---|
  | `GET /api/search?q=GTO` | C322586（KPC）だけ `廉価版`、他の 3 件は `""` |
  | `GET /api/series/C322586/volumes` | `label_tag: "廉価版"` |
  | `GET /api/search?q=9784063780390`（ISBN） | C322586 / `label_tag: "廉価版"` |


**本番（2026-10-05）**

- 適用前の Time Travel ブックマーク: `000000e1-00000000-000050fb-ecbadce63242a0e0dd9b9be7ba72682d`
- ユーザデータの書き出し: `backups/prod-20261005-1539-labeltag.sql`（`lists` 1 / `users` 1 /
  `user_drafts` 1 / `volume_series_link` 430 / `circulation_link` 200 / `series_merge` 194 /
  `series_correction` 148 / `list_item_events` 100 / `series_name_override` 51 /
  `cover_suggestion` 23 / `custom_series` 20）
- dev と同じ順: `db/add-label-tag.sql`（`rows_read` 269,028 / `rows_written` 133,607、923ms）→
  `npm run deploy:prod` → Version ID `eb0f1745-ca88-467f-8fac-d467109b2bba`。ingest は不要。
- 適用後: `label_tag` 0 行。`series` 133,603 / `volumes` 349,020 / `lists` 1 / `users` 1 /
  `series_merge` 194 / `custom_series` 20 / `volume_series_link` 430 / `series_correction` 148 /
  `series_name_override` 51 は適用前後とも同数。レーベルは 7,811 種。
- **本番の `label_tag` は空のまま**（タグ付けは管理画面から行う運用）。
- デプロイ後の確認:

  | 確認 | 結果 |
  |---|---|
  | `GET /` `/lists` `/ranking` `/circulation` `/sales-ranking` `/api/version` | すべて 200（`version` = `eb0f1745`） |
  | `GET /api/search?q=三国志` | カードが `label_tag` を返す（未設定なので全部 `""`）。版ごとの分離は回帰なし（希望コミックス / 愛蔵版 / 文庫版 / 大判 / 中国歴史コミック / MF文庫） |
  | `GET /api/series/C268196/volumes` | ONE PIECE 115 巻（回帰なし） |
  | `GET /l/rela1470` / `GET /api/lists/rela1470` | 200 / 100 冊（本番の実リスト） |
  | `GET /api/admin/labels`（未認証） | 401 |
  | `GET /admin`（未認証） | 302（Access のログインへ） |

### `add-label-tag.sql` の R18版（my100shunga）への適用

**dev / 本番とも 2026-10-05 適用済み（表だけ先に作った。デプロイはまだ）。**
R18版は本家と同じコードで動くので、表が無いまま新しいコードを出すと検索と巻一覧が
`no such table: label_tag` で落ちる（`add-series-version.sql` のときと同じ事故）。
本家より先に表だけ入れておき、落ちる窓を無くしてある。

- 適用前の Time Travel ブックマーク:
  dev `0000000c-00000000-000050fb-4ce7e338265010fbcc270567a73089df` /
  本番 `00000013-00000000-000050fb-00808b4b7cb613fba923df74982fc0fb`
- `d1 export` は取っていない。どちらも `lists` 0 / `users` 0 / `series_merge` 0 /
  `custom_series` 0 / `series_correction` 0 で、ユーザデータが 1 行も無い（マスタだけなので
  取り込み直しで作れる）。前回の R18版への適用と同じ判断。
- `db/add-label-tag.sql` を両方に適用（`rows_written` 139,134 = `idx_series_label` の作成、
  394ms / 415ms）。適用後はどちらも `label_tag` 0 行・`idx_series_label` あり、
  `series` 139,130 / `volumes` 356,644 / `lists` 0 / `users` 0 で適用前と同じ。
  レーベルは 7,992 種（本家より多いのは成年向けを収録しているため）。
- 適用の時点ではデプロイせず、`https://my100shunga.com/api/version` が `50592d71` のまま
  （＝旧コードで動いたまま）であることを確認した。デプロイは下の「傑作選タグの追加」で
  まとめて行った。R18版の ingest は不要（マスタの列は増えていない）。

## 2026-10-05 傑作選タグの追加と、レーベル検索の AND 化（全 4 環境）

**migration なし・ingest なし。** `label_tag.tag` は素の TEXT で、選べる値は
`src/labels.ts` の `LABEL_TAGS` が決めているので、タグを増やしても DB は変えなくてよい。
コミット `55b006f`。

- 「セレクション」系のレーベル（`ジャンプコミックスセレクション` 89 シリーズ・
  `少年サンデーコミックスビジュアルセレクション` 38・`YKベスト` 47 ほか）は連載から数話を
  選んで再編集した本なので、`傑作選` タグを足した。
- 管理画面のレーベル検索を空白区切りの AND にした。マスタは同じレーベルを何通りにも表記して
  いて（「ジャンプ…セレクション」は 8 通り）、1 本の LIKE では `ジャンプ セレクション` が
  0 件だった。AND にすると 8 レーベル / 127 シリーズを一度に拾ってまとめてタグ付けできる。

デプロイ（この順。DB は触っていない）:

| 環境 | Version ID | 確認 |
|---|---|---|
| 本家 dev | `5b9a6271-b465-467f-a28e-ec273e47b57f` | `/` `/lists` `/ranking` 200、検索が `KPC` に `廉価版` を返す（既存タグが生きている） |
| 本家 本番 | `fc62c32d-9fcc-46b7-b01f-6ad11d492cb7` | `/` `/lists` `/ranking` `/circulation` `/sales-ranking` `/l/rela1470` 200、`q=三国志` の版の分離に回帰なし、ONE PIECE 115 巻、公開リスト 100 冊 |
| R18 dev | `89e78a39-120f-4a8a-ae62-b731b558662d` | 下記 |
| R18 本番 | `410fd50d-4f05-429c-a0f1-67901ac9c650` | 下記 |

**R18版はこれが `label_tag` を参照するコードの初回デプロイ**だったので、列を実際に引く経路を
確認した（`age_ok=1` の cookie を付けて叩く）:

| 確認 | dev | 本番 |
|---|---|---|
| `GET /api/version` / `GET /` | `89e78a39` / 200 | `410fd50d` / 200 |
| cookie 無しの `GET /api/search` | 403 `{"age_gate":true}` | 同じ |
| `GET /api/search?q=三国志&all=1`（SERIES_COLS の `label_tag`） | 30 件・`label_tag` を返す | 同じ |
| `GET /api/series/C268196/volumes`（`src/series.ts` の `label_tag`） | ONE PIECE 100 巻 | 同じ |
| 既定の検索（成年向けのみ） | — | `q=はじめて` で 10 件 |

R18版の `series`/`volumes` は 10/04 の取り込みのままなので ONE PIECE は 100 巻
（本家は 115 巻）。これは今回の変更とは無関係。

なお台帳末尾の「R18版の検索が多くのキーワードで 0 件を返す」という既知の不具合は、
`&all=1` を付けると `三国志` が 30 件返ることから、**成年向けだけを出す既定の絞り込み
（`src/site.ts` `adultOnlySearch`）が効いているだけ**と思われる（不具合ではない）。

## 2026-10-05 3 セッション分をまとめてデプロイ（全 4 環境）

**migration なし・ingest なし。** 同じ作業ツリーで 3 セッションが並行していたので、CLAUDE.md の
手順どおり予告・調整し、全員のコミットが揃ってから代表して 1 回で出した。

| コミット | 内容 |
|---|---|
| `f1a702f` | 管理画面のレーベル管理に出版社と発行年の列を足し、ページ送りを廃止（1 回 1,000 件上限） |
| `ba23bfc` | 迷子巻を「そのシリーズの巻が実際に名乗っている書名」でも fold する修正 |
| `2651e5b` | admin#circulation に寄せ先レーベルのタグを表示、自動照合でタグ付きを後ろに回す |

出す前に合流状態で `npx tsc --noEmit` と `npm test`（25 ファイル 264 件）を通した。

| 環境 | Version ID |
|---|---|
| 本家 dev | `4851fdf9-eed5-4ba3-ad48-d389a4cfbb0b` |
| 本家 本番 | `0c56f938-a485-455c-8e83-522a767f1bc3` |
| R18 dev | `fb6c9755-ebba-41cb-8ac0-18b23a981029` |
| R18 本番 | `e05f7d07-036a-48d6-a784-60c5bf1bd160` |

確認:

| 確認 | 結果 |
|---|---|
| 本家 本番 `/` `/lists` `/ranking` `/circulation` `/sales-ranking` `/l/rela1470` | すべて 200 |
| `GET /api/series/C368624/volumes`（`ba23bfc`） | 東京卍リベンジャーズ 31 巻・1〜31 に抜けなし・7 巻が 9784065116203・短編集 9784065328712 の混入なし |
| `GET /api/circulation`（本番） | entries 200 件 |
| `GET /api/search?q=GTO` | `KPC` に `廉価版` が出る（回帰なし） |
| admin（4 環境・未認証） | 本家 api=401 / ui=302、R18 api=403 / ui=403 |
| R18 本番の年齢ゲート | ブラウザ UA・cookie 無しで 403 `{"age_gate":true}`、cookie 付きで 30 件 |

**R18 の年齢ゲートを curl で確かめるときは必ずブラウザの User-Agent を付けること。**
`curl` の既定 UA はクローラ判定（`src/ageGate.ts` の `isCrawler`）に当たって素通りし、
cookie 無しでも 200 が返る。ゲートが壊れたように見えるが正常な除外規則。

`2651e5b` の admin UI（タグの印・件数カード・候補の nested dialog の重なり順）は
Cloudflare Access の内側で手元から確認できないため**未確認**。ブラウザで要確認。

## 2026-10-05 admin#circulation の「戻す」の修正（全 4 環境）

**migration なし・ingest なし。** 上のデプロイの続き。コミットは `0dfea79` の 1 本だけ
（`fix: make 戻す land back on the suggestion instead of a state of its own`）。

管理画面で「戻す」を押すと「サジェスト」ではなく「指定なし」になる、という報告への修正。
「戻す」は `circulation_link` の行を消すだけだったので、行が無い状態 = 集計のたびにその場で
自動照合する「指定なし」に落ちていた。出る寄せ先は同じなので、画面上は「何も変わらないのに
要確認に移った」ように見える。いまは行を消したうえで、その 1 件だけ同じ自動照合を走らせて
結果を `'suggested'` として入れ直す（照合で何も見つからなければ行は作らない ー 空の
`series_id` の行は「寄せない」の意味になるため）。

「サジェスト」と「指定なし」は別物なので両方残してある。サジェストは照合結果を表に固定した
もので、集計時の作品名→シリーズ照合（200 作品ぶん＝この集計の重い部分）を省け、マスタを
取り込み直して寄せ先が消えたら「指定先が見つからない」として気付ける。指定なしは行がまだ
無い状態で、取り込んだばかりでまだ「サジェストを取り込む」を実行していない作品がこれにあたる。

出す前に `npx tsc --noEmit` と `npm test`（25 ファイル 266 件）を通した。

| 環境 | Version ID |
|---|---|
| 本家 dev | `7a189437-faba-4fa1-9fb5-b40db008b62c` |
| 本家 本番 | `aa75089d-1a05-4192-a97b-e309e482b34a` |
| R18 dev | `e40500cd-f859-4e65-aa5e-c5777bf785ea` |
| R18 本番 | `6dfc4669-313b-4b68-a195-8d883a467aa6` |

確認:

| 確認 | 結果 |
|---|---|
| 本家 本番 `/` `/circulation` `/api/circulation`、本家 dev `/` | すべて 200 |
| `GET /api/circulation`（本番） | entries 200 件 |
| admin（未認証） | 本家 api=401、R18 api=403 |
| R18 本番の年齢ゲート | ブラウザ UA・cookie 無しで `/api/site-stats` が 403 |

**R18 の年齢ゲートを curl で確かめるときのヘッダ。** ゲートは「HTML を見に来たリクエスト」
（`src/ageGate.ts` の `wantsDocument`）と API の両方に掛かるが、curl は既定でどちらの条件も
満たさないので素通りして見える。実測（本番 `/`、cookie 無し）:

| 付けるヘッダ | 結果 |
|---|---|
| 既定の curl UA | 200 本編（`isCrawler` に当たってゲート除外。**壊れて見えるが正常**） |
| ブラウザ UA のみ | 200 本編（`accept` も `sec-fetch-dest` も無く、HTML 要求と見なされない） |
| ブラウザ UA ＋ `accept: text/html` | **200 年齢確認ページ**（`<title>年齢確認 \| My 100 Shunga`） |
| ブラウザ UA ＋ `sec-fetch-dest: document` | **200 年齢確認ページ** |

つまり `/` も**ブラウザからは正しくゲートされる**（本物のブラウザは必ず `accept` と
`sec-fetch-dest` を送る）。curl で `/` が 200 本編だったことを「`/` はゲート対象外」と
読まないこと。API で見るなら `GET /api/search?q=…` にブラウザ UA を付けて 403
`{"age_gate":true}` を確認するのが手早い。

admin UI（「戻す」を押してサジェストに戻るか）は Access の内側なので**未確認**。ブラウザで要確認。

### `add-indexes-2026-10.sql` の注意

- `src/listItems.ts` が新しい表 `series_supplement_isbn` を参照するので、**このファイルを流してから**
  デプロイする（逆順だとリスト表示・ランキング・公開リスト一覧が「no such table」で落ちる）。
- 中身は索引 5 本・逆引き表 1 つ・トリガ 3 つと、既存の `series_supplement` の展開（`INSERT OR IGNORE`）。
  `volumes` の部分索引（約 7 万行）と `series` の索引（約 14 万行）の作成で数秒〜十数秒かかる。
- `series` / `volumes` の索引は月次取り込みの差し替え（`scripts/ingest.mjs` の `SWAP_SQL`）でも張り直す。

### dev / 本番への適用記録（2026-10-04）

**dev（2026-10-04）**

- 適用前の Time Travel ブックマーク: `000000c4-00000000-000050f9-4cfb21d9feb31b729794f2996c1866a3`
- 上の順で 4 ファイルを適用 → `circulation` 200 行 / `circulation_link` 199 行（うち `manual` 3）/
  `idx_series_num_items` 作成。そのあと `npm run deploy:dev`。
- **デプロイの前に Queues の作成が必要だった**（`wrangler.jsonc` が producer / consumer として
  参照しているのに未作成で、無いまま deploy すると失敗する）。両方ともこの日に作成済み:
  `npx wrangler queues create my100manga-views-dev` / `npx wrangler queues create my100manga-views`。

**本番（2026-10-04）**

- 適用前の Time Travel ブックマーク: `000000a4-00000000-000050f9-ce4aa8de714187a19b204d46787bead1`
- ユーザデータの書き出し: `backups/prod-20261004-0303.sql`（`lists` ほか。マスタは含めない）
- 同じ 4 ファイルを同じ順で適用 → `circulation` 200 行 / `circulation_link` 199 行（うち `manual` 3）/
  `idx_series_num_items` 作成（`series` 13.3 万行）。`lists` / `users` は適用前後とも 1 行で無傷。
- `npm run deploy:prod` → Version ID `21ebe2f8-5086-45ad-99e8-d231b9af18d4`。

### `add-volume-subtitle.sql` の適用記録

**dev（2026-10-04）**

- 適用前の Time Travel ブックマーク: `000000ce-00000000-000050fa-22718a1ddb3552abe55c3079fa9cbccf`
- ユーザデータの書き出し: `backups/dev-20261004-2227.sql`（`series_merge` 168 / `volume_series_link` 36 /
  `custom_series` 1 / `series_correction` 3 / `reports` 3 / `users` 1 ほか。マスタは含めない）
- 順番: `db/add-volume-subtitle.sql` → `npm run deploy:dev` → `npm run ingest:remote:dev`。
  **列の追加はデプロイより前**（逆にすると、取り込み前に `subtitle` を読むコードが出て no such column になる）。
- `npm run deploy:dev` → Version ID `e46d1649-0a47-4364-a1f2-cc856008c5f7`。
- 取り込み後: `series` 133,584 行 / `volumes` 349,020 行（うち `subtitle` ありが 70,680 = 20%）/
  `adult_volumes` 7,624 行。`series_merge` 168・`volume_series_link` 36・`custom_series` 1 は適用前後とも同数で、
  独自シリーズ（U-id）も `series` に入り直している。
- 確認: ISBN 9784063637564 で C318330 が「全13巻」（前は 5 巻）、巻一覧に 13 冊すべてと副題が出る。
  回帰: 七つの大罪 C332469 が 38 巻のまま（刷りによって副題が付かないケース）、世界一初恋 C256404 の
  13 巻が 1 行（副題を書名に畳み込んだ行との同居）、ONE PIECE C268196 が 100 巻のまま。

**本番（2026-10-04）**

- 適用前の Time Travel ブックマーク: `000000c8-00000000-000050fa-b8037226e600f296c502d0b0adbbaff9`
- ユーザデータの書き出し: `backups/prod-20261004-2237.sql`（`lists` 1 / `users` 1 / `series_merge` 194 /
  `volume_series_link` 430 / `custom_series` 20 / `series_correction` 142 ほか）
- dev と同じ順: `db/add-volume-subtitle.sql` → `npm run deploy:prod` → `npm run ingest:remote:prod`。
  Version ID `6930a297-7b82-4cac-99dc-0daf21d014c5`。
- **取り込みは `--work /tmp/madb-main` で流した。** `scripts/ingest.mjs` の作業ディレクトリは既定で
  `/tmp/madb` 固定で、R18版の取り込み（`--include-adult`）と同時に走らせると同じ `/tmp/madb/seed/
  volumes_new_*.sql` を書き合い、本家に成年向けが混入しうる。R18版側は `5f144ed` で
  `--work /tmp/madb-r18` を npm script に固定した。本家を並行で流すときはこの指定を付ける。
- 取り込み後: `series` 133,603 行 / `volumes` 349,020 行（うち `subtitle` ありが 70,680 = 20%、
  `is_adult = 1` は **0 行**＝成年向けの混入なし）/ `adult_volumes` 7,624 行。
  `lists` 1・`users` 1・`series_merge` 194・`volume_series_link` 430・`custom_series` 20・
  `series_correction` 142 は適用前後とも同数で、独自シリーズ 20 件も `series` に入り直している。
- 確認: ISBN 9784063637564 で C318330「金田一少年の事件簿 第Ⅱ期」が全14巻（前は 6 巻）、
  巻一覧に当該 ISBN が「下 獄門塾殺人事件」として出る。`/api/book` の「同じ巻の別 ISBN」は空
  （前は同じ「下」の別作品 4 冊を並べていた）。
  回帰: 七つの大罪 C332469 が 38 巻・巻番号の重複なし、世界一初恋 C256404 の 13 巻が 1 行、
  ONE PIECE C268196 が 115 巻・重複なし。楳図かずおこわい本 C260484 は 14 行で「1」「2」が
  複数あるが、これは 12 作品が別々の本として並んだ意図どおりの状態。

### `add-series-version.sql` の適用記録

MADB の `schema:version`（版表示）の取り込み。横山光輝「三国志」のように、同じ作品の版違いが
同じ `schema:name` の別 C-id として並んで区別できなかった件（README「同名の版違いの見分け」）。

**dev（2026-10-04）**

- 適用前の Time Travel ブックマーク: `000000d1-00000000-000050fa-a8cf1a580a9f7711b9648ce7ebc45633`
- ユーザデータの書き出し: `backups/dev-20261004-2318-seriesversion.sql`
- 順番: `db/add-series-version.sql` → `npm run deploy:dev` → `npm run ingest:remote:dev -- --work /tmp/madb-main`。
  **列の追加はデプロイより前**（逆だと取り込み前に `version` を読むコードが出て no such column）。
- `npm run deploy:dev` → Version ID `35a537ca-47d4-41e6-83cf-609d5ef8c780`。
- 取り込み後: `series` 133,584 行（うち `version` ありが 3,403 = 2.5%）/ `volumes` 349,020 行
  （`subtitle` あり 70,680・`is_adult = 1` は 0 行）/ `adult_volumes` 7,624 行。
  `series_merge` 168・`custom_series` 1・`volume_series_link` 36・`series_correction` 3 は適用前後とも同数。
- 確認: `/api/search?q=三国志` が C367640 を `version="大判"`、C276817 を `"カジュアルワイド"`、
  C433383 を `"改訂版"` で返す。版表示を持たない 3 件（C276797 2007年・C276805 1974年・C276801 1997年）は
  `first_year` とレーベルで並ぶ。
  回帰: 七つの大罪 C332469 が 38 巻、ONE PIECE C268196 が 100 巻、金田一少年の事件簿 C318330 が 13 巻（全巻副題あり）。

**本番（2026-10-04）**

- 適用前の Time Travel ブックマーク: `000000cc-00000000-000050fa-5208264a8a82c145b5e15d8113a9a794`
- ユーザデータの書き出し: `backups/prod-20261004-2325-seriesversion.sql`
- dev と同じ順: `db/add-series-version.sql` → `npm run deploy:prod`（Version ID
  `79b984dc-5570-44f1-9d7a-8273fba4a3f8`）→ `npm run ingest:remote:prod -- --work /tmp/madb-main --skip-download`。
- 取り込み後: `series` 133,603 行（`version` あり 3,403）/ `volumes` 349,020 行（`subtitle` 70,680・
  `is_adult = 1` は 0 行）/ `adult_volumes` 7,624 行。`lists` 1・`users` 1・`series_merge` 194・
  `custom_series` 20・`volume_series_link` 430・`series_correction` 142 は適用前後とも同数。
- **取り込み後に 1 点直してデプロイし直した**（Version ID `4a8f3414-45c2-40a1-9feb-6a59e2234712`、
  dev は `711cab18-d52d-4270-8c85-7a6bc454f8a9`）。本番には管理者のシリーズ名の上書き
  （`series_name_override`、60 件）があり、うち 16 件が版違いを手で名乗らせたもの
  （「三国志 大判」「鋼の錬金術師 完全版」…）。そこへ版表示を足すと「三国志 大判（大判）」と
  二重になる。`public/app.js` の `editionTitle` に「書名が既にその版を名乗っていれば足さない」
  ガードを入れた。dev には上書きが無いので dev では出なかった。
  上書き名と版表示が別の語のとき（C276817「三国志 廉価版」＋ `カジュアルワイド`）は併記のまま
  残る。上書きは別途全件見直す予定なので、`series_name_override` の有無でコードを分岐させることは
  していない。
- 確認: `/api/search?q=三国志` のカードが「三国志 愛蔵版 / 三国志（希望コミックス）/ 三国志 文庫版 /
  三国志 大判 / …」と版ごとに分かれ、二重表記が無い。

### `series_name_override` の整理（2026-10-04、本番のみ）

`series.version` が入ったことで、管理者のシリーズ名の上書きのうち「マスタ名 ＋ 版表示」でしかない
ものは不要になったので削除した。dev の `series_name_override` は 0 件なので本番だけの作業。

**前提: `src/listItems.ts` に版表示を効かせてから消すこと。** リスト・ランキング・編集画面の本の
タイトルを作る `resolveBooks` は `series_name_override` を見るが `version` を見ていなかった。先に
上書きを消すと公開リストの表示が「ドラゴンボール 完全版 第1巻」→「ドラゴンボール 第1巻」に戻り、
通常版と区別が付かなくなる。この順でデプロイしてから消した（本番 Version ID
`917d35ad-1f9f-47a7-b9a8-0efc55a5dc81`）。

- 削除前の Time Travel ブックマーク: `000000d0-00000004-000050fa-987bfc18472c2e54542b53d8e4784428`
- 書き出し: `backups/prod-20261004-2351-series_name_override.sql`（削除前の全 60 行）
- 削除した 10 件（`series` / `volumes` には触れていない）:
  `C253984` YAIBA 新装版 / `C257147` ドラゴンボール 完全版 / `C276817` 三国志 廉価版 /
  `C311611` 金田一少年の事件簿 バイリンガル版 / `C321571` 金田一少年の事件簿 極厚愛蔵版 /
  `C326531` グラップラー刃牙 完全版 / `C332274` タッチ<完全復刻版> / `C338357` 鋼の錬金術師 完全版 /
  `C367640` 三国志 大判 / `C371167` 宇宙兄弟 スペシャルエディション
- 削除と同時に `meta.view_epoch` を更新した（検索のエッジキャッシュとリストのスナップショットは
  世代を鍵に混ぜているので、直接 SQL で消すだけだと最大 1 時間古い名前が出る。管理画面経由の
  修正では `bumpViewEpoch` が呼ばれる、src/viewSnapshot.ts）。
- 残り 50 件は消していない。内訳は、MADB に版表示が無く上書きが唯一の情報源のもの 36 件
  （ゴルゴ13 の コンパクト版 / POCKET EDITION / My First Big / 小学館文庫版、金田一少年の事件簿の
  第Ⅰ期 / 第Ⅱ期 / 廉価版 / Ｃａｓｅ版 など）、書名そのものの修正 7 件（`ｖ`→「ハレグゥ」、
  ジョジョの Part 番号の統一）、版表示以外の修正を兼ねるもの 7 件。
- **`C262152` は意図的に残した。** 上書きは「SLAM DUNK 完全版」だがマスタ名が `Slam dunk` なので、
  消すと「Slam dunk（完全版）」になり大文字小文字の修正まで失われる。版表示と別の修正が同じ行に
  同居している例。
- 確認: `/api/search?q=三国志` が「三国志（全60巻）/ 三国志 愛蔵版 / 三国志 文庫版 / 三国志（大判）」、
  `q=ドラゴンボール` が「ドラゴンボール / ドラゴンボール（完全版）」と版ごとに分かれ、二重表記が無い。
  `/api/lists/:slug` が 100 件を正常に返す（`RESOLVE_SQL` に足した `s.version` が本番で解決できている）。

### R18版（my100shunga）への適用記録

**dev（2026-10-04）**

- 適用前の Time Travel ブックマーク: `00000005-00000000-000050fa-c61c73670ce90c432942d5f4e5dba261`（取り込み前は空の DB）
- `db/add-is-adult.sql` を適用 → `npm run ingest:remote:r18:dev`（MADB release 1.2.20）。所要 4 分ほど。
- 結果: `series` 139,130 行（うち `is_adult=1` が 5,586）/ `volumes` 356,644 行（うち 7,624）/ `adult_volumes` 0 行。
- 確認: `/api/search?q=ONE PIECE` が 0 件、`&all=1` で 30 件。成年向けのタイトルは既定で出る。

**dev 2 回目（2026-10-04、副題対応）**

- ブックマーク `00000007-00000000-000050fa-f297a2cd22458ff71a2a7e68f23bbfcb`
- `db/add-volume-subtitle.sql` → `npm run deploy:r18:dev`（`e162f93f`）→ `npm run ingest:remote:r18:dev`
- 結果: `series` 139,130（`is_adult` 5,586）/ `volumes` 356,644（`is_adult` 7,624・`subtitle` あり 71,746）/ `adult_volumes` 0

**本番（2026-10-04）**

- ブックマーク `00000009-00000000-000050fa-7590cae23b380f54f983bc9c52c339cc`（`lists` 0 / `users` 0 の空 DB なので `d1 export` は取らず）
- `db/add-is-adult.sql` → `db/add-volume-subtitle.sql` → `npm run deploy:r18:prod`（`73257fb7`）→ `npm run ingest:remote:r18:prod`
- 結果: dev と同数（`series` 139,130 / `volumes` 356,644 / `subtitle` 71,746 / `adult_volumes` 0）
- 確認: 年齢確認ゲート、`/api/search?q=ONE PIECE` が 0 件・`&all=1` で 30 件、成年向けのタイトルは既定で 1 件、C318330 が 13 巻で副題付き

**dev / 本番（2026-10-05、版表示と抜け巻対応）**

- ブックマーク: dev `00000009-00000000-000050fa-bc0743703d803b859061af7aa7e00695` /
  本番 `0000000c-00000000-000050fa-198e3e8a5293638c7dc194f90927434d`
- `db/add-series-version.sql` を dev・本番とも適用 → `npm run deploy:r18:dev`
  （`c2508d58-8f6c-4f87-8860-6e4acef81031`）→ `npm run deploy:r18:prod`
  （`50592d71-de28-4088-b08e-afd1d41fea5f`）。**ingest は未実施**。
- **この列追加は必須だった**。`src/search.ts` と `src/series.ts` が `series.version` を
  SELECT するので、列が無いまま新しいコードを出すと検索と巻一覧が
  `no such column: version` で全部壊れる。10/04 に本家へ適用したときは R18版を対象外に
  していたため、R18版だけ列が無い状態になっていた。適用前に本家と列を突き合わせて確認
  （差分は `series.version` の 1 列のみ、`volumes` は差分なし）。
- `version` の値は全行 NULL のまま。中身は次の R18版 ingest で入る（版表示が出ないだけで
  動作に支障はない）。
- 確認: C367640 の名指しが 6 件（15,16,17→C276797 / 18→迷子 / 23,24→C433383）、
  C276805 は 32 巻（**R18版は外部ストア API を使わないので `rakutenReady()` が false になり、
  楽天を使う抜け巻の穴埋めは走らない。これが正しい挙動**）、`GET /api/version` 200、
  年齢確認ゲートは cookie 無しの API が 403 `{"age_gate":true}`。

既知の不具合（この作業とは無関係・未調査）: R18版の検索が多くのキーワードで 0 件を返す。
`三国志`（DB 上 97 シリーズ）/ `ドラゴンボール`（57）/ `こち亀`（24）/ `ベルセルク`（10）が
0 件、`ナルト`（10）は 3 件。デプロイ前の旧コードでも同じ結果なので今回の変更が原因ではない。
`name_search` は 139,130 行中 6 行しか空でなくデータは正常で、巻一覧 API は同じシリーズを
返すので、`src/search.ts` の絞り込み側が怪しい。

**本家と R18版の ingest を並行で流すときは `--work` を分けること**。既定の `/tmp/madb/seed` を共有すると、同名の `volumes_new_*.sql` を書き合って本家に成年向けが混入しうる。`npm run ingest:remote:r18:*` は `--work /tmp/madb-r18` を固定済み。

## バックアップ（リモートの migration / ingest の前に毎回）

D1 は Time Travel で過去 30 日（無料プランは 7 日）の任意の時点に戻せる。流す直前のブックマークを控えて
おけば、失敗したときにその時点へ戻せる。加えて、取り込みで作り直せないユーザデータは SQL に書き出して
手元にも残す。

```bash
# 1) 現在のブックマークを控える（出力の bookmark を作業メモ・この表の備考に貼る）
npx wrangler d1 time-travel info DB --env dev   # dev
npx wrangler d1 time-travel info DB             # 本番

# 2) SQL に書き出す（backups/ は .gitignore 済みであること。個人情報を含むのでコミットしない）
mkdir -p backups
npx wrangler d1 export DB --env dev --remote --output backups/dev-$(date +%Y%m%d-%H%M).sql
npx wrangler d1 export DB --remote --output backups/prod-$(date +%Y%m%d-%H%M).sql
#   マスタ（series / volumes）まで含めると数百 MB になる。ユーザデータだけでよければ --table を並べる:
#   --table lists --table users --table sessions --table user_drafts --table list_item_events \
#   --table list_views --table reports --table cover_suggestion --table series_correction \
#   --table series_merge --table custom_series --table volume_series_link ...

# 3) 失敗したら控えたブックマークへ戻す（その時点以降の書き込みは消える）
npx wrangler d1 time-travel restore DB --env dev --bookmark=<bookmark>
```

- `export` の実行中は DB への書き込みが待たされる（大きい表の書き出しは数十秒）。アクセスの少ない時間に行う。
- ingest（`npm run ingest:remote*`）も同じ手順で事前にブックマークを控える。差し替え（SWAP_SQL）は
  1 回の `execute` だが、途中で失敗すると `series_new` / `volumes_new` が残るだけで現行の表は無傷。

## 2026-10-05 抜け巻の穴埋めと、別シリーズ・迷子巻の名指し（dev / 本番）

migration なし・ingest なし（スキーマ変更ゼロ。既存の `series_supplement` /
`series_supplement_isbn` に乗る）。

- dev … Version ID `fe09c728-4d89-4ac1-bfd7-b3f329ad6fda`
- 本番 … Version ID `f67f074d-8801-45da-b672-0da283f8d91a`

出したコミット:

- `5fbb79b` 取り込みが落とした巻（MADB に巻としてはあるが `schema:isbn` が無いもの。
  全 MangaBook の 11%）を、取得ボタンから楽天ブックスで引き当てて埋める。
  ※ これは 2026-10-04 の `917d35ad` で既に本番稼働していた分。
- `1d24854` / `17cd8b3` 抜け巻が別の C-id に紛れている／どのシリーズにも属さない
  場合に、その巻を名指しして結合依頼の導線に送る。データは書き換えない。

デプロイ後の確認（いずれも `POST /api/series/:id/supplement` の応答そのもの。
GET は 60 秒のエッジキャッシュを挟むので確認に使えない）:

| 確認 | dev | 本番 |
|---|---|---|
| C276805 三国志 希望コミックス（穴埋め） | 60巻 / 抜け 0 | 60巻 / 抜け 0 |
| C367640 三国志（大判）の名指し | 15,16,17→C276797 / 23,24→C433383 | 同じ |
| C261321 ブレイクショット の名指し | 5,6,8,9 → いずれも迷子 | 同じ |

### 追補（同日）迷子巻の引き当てを巻の書名でも行う

migration なし・ingest なし。

- dev … Version ID `d9c7b369-7271-483d-b22e-d0adab0ca4a0`
- 本番 … Version ID `20781b9a-b005-418f-81f7-1cab1b4d88e1`

コミット `00bdc01`。迷子巻をシリーズ名の完全一致だけで引いていたため、書名が違う巻を
取りこぼしていた（大判『三国志』C367640 はシリーズ名が「三国志」なのに巻の書名が
「大判三国志 = Three Kingdoms」で、18 巻 9784267906589 が拾えなかった）。シリーズ名に
加えて、そのシリーズの巻がマスタ上で実際に名乗っている書名も鍵にする。完全一致のままな
ので `idx_volumes_unlinked_title` がそのまま効く。

ローカル全量で 514 巻 / 381 シリーズ → 605 巻 / 464 シリーズ。

あわせて `public/app.js` で、抜け巻の候補ピッカーから「‹ 巻一覧へ戻る」で戻るときに
`opts` を渡すようにした（捨てていたので、取得バーの状態と名指しが戻った時点で消えていた）。

本番での確認:

| 確認 | 結果 |
|---|---|
| C367640 三国志（大判）の名指し | 6 件（15,16,17→C276797 / **18→迷子** / 23,24→C433383） |
| C261321 ブレイクショット | 4 件（5,6,8,9 → いずれも迷子） |
| C258780 うる星やつら（誤検出が出ないこと） | 0 件 |
| C276805 三国志（穴埋めの退行が無いこと） | 60 巻 / 抜け 0 |
| `GET /` / `GET /api/version` | 200 / 200 |
| `GET /api/search?q=三国志` | 版ごとに分離（通常 / 愛蔵版 / 文庫版 / 大判 / カジュアルワイド / 改訂版） |

## 2026-10-05 シリーズ名の見分けと、ISBN の無い抜け巻（4 環境）

migration **あり**（`add-series-name-display.sql`、非冪等）・ingest なし。`migration → デプロイ` の順で
4 環境ぶんまとめて適用した。出したのは 2 コミット。

- `b6adc4c` 同名シリーズを全巻共通の副題で見分ける（`series.name_display`）。migration を要するのはこちら。
- `6ccc03a` 抜け巻に ISBN が無いときは追加ボタンを出さず 1 行で説明する。migration 不要。

| 環境 | migration | Version ID |
|---|---|---|
| 本家 dev | 4,403 行 UPDATE（うち名前が付いたのは 4,402） | `4379fb3c-7bf8-4d72-bd87-9d256caa1b83` |
| 本家 本番 | 同上 | `409df416-7c30-408a-83bd-6fb8c89c4eb8` |
| R18 dev | 4,484 行 UPDATE（うち 4,483。成年向けを含むぶん多い） | `b2164676-47fb-4105-804f-7651716942b2` |
| R18 本番 | 同上 | `86e9da57-3ba3-4e84-a0a9-1b36df5c3527` |

適用直前の Time Travel ブックマーク（戻すときはこれ。30 日で失効）:

| 環境 | bookmark |
|---|---|
| 本家 dev | `000000df-00000000-000050fb-de75031face03891c20758ce8fe1c270` |
| 本家 本番 | `000000f3-00000000-000050fb-038656e4cd673e51de4d91854a56ed9c` |
| R18 dev | `00000012-00000000-000050fb-139898565b623a84d27b778f7beab585` |
| R18 本番 | `00000019-00000000-000050fb-bd07c035eea0d1378d8164a74b679bf3` |

SQL の書き出しは行っていない。この migration が触るのは `series.name_display` だけで、取り込みで
作り直せない利用者データ（`lists` / `users` / `series_correction` 等）には一切触れないため。

デプロイ後の確認（検索の `GET` は 60 秒のエッジキャッシュを挟むので、確認は `POST
/api/series/:id/supplement` で行った。本番の `GET /api/search` は直後まだ旧結果を返していた）:

| 確認 | 本家 dev | 本家 本番 | R18 dev | R18 本番 |
|---|---|---|---|---|
| `GET /` | 200 | 200 | 200 | 200 |
| C328373 のシリーズ名 | 釣りキチ三平 作者自選集 | 同じ | 同じ | 同じ |
| C326076 の巻数 / `volumes_no_isbn` | 23 巻 / 42 | 23 巻 / 42 | 15 巻 / 50 | 15 巻 / 50 |
| `name_display` が付いたシリーズ数 | 4,402 | 4,402 | 4,483 | 4,483 |

R18 版で巻数が 15 のまま・`volumes_no_isbn` が 50 なのは仕様どおり。R18 版は外部ストアの API を
呼ばないので楽天からの穴埋め（45〜49・51〜53 の 8 巻）が走らず、MADB だけで分かる「ISBN が無い巻」
だけが返る。本家は穴埋めが効いて 15 → 23 巻になり、残り 42 巻が説明に回る。

## 2026-10-05 絶版巻の ISBN を Yahoo から引き当てる（4 環境）

migration **なし**・ingest なし。`wrangler deploy` だけ。出したのは 3 コミット。

- `ca7bf12` 穴埋めに Yahoo!ショッピングの商品名検索を足す。`6ccc03a` の前提（MADB・NDL・楽天に
  無い ＝ ISBN が存在しない）が誤りだった。利用者の報告どおり C326076 26 巻の ISBN は講談社の
  公式サイトに 9784061735057 として載っており、Yahoo の中古出品が同じ JAN を持っていた。
- `df92915` 前回までの補完を穴から外す。Yahoo は 1 巻 1 リクエストなので、外さないと押すたびに
  同じ先頭の巻を引き直して進まない（dev で 3・7・12・13 巻から動かなくなった）。
- `e4ca495` 空振りした巻を次の押下で後回しにする巡回カーソル（`meta` の `yahoo_gap_cursor:<C-id>`）。
  空振りは穴に残り続けるので、カーソルが無いと先頭の空振りだけで 1 回ぶんの枠を使い切り、
  利用者が探している 26 巻以降へ永久に届かない（dev で 23 巻から動かなくなった）。

`ca7bf12` を 4 環境に出したあと dev で上の 2 件が分かったので、`df92915` `e4ca495` を入れて
4 環境とも出し直している。下の Version ID は最終のもの。

| 環境 | Version ID |
|---|---|
| 本家 dev | `b60c2a8f-5560-4bb0-9512-aeccbd5c213d` |
| 本家 本番 | `6438a427-2989-40a8-ba6f-f06c7bf02032` |
| R18 dev | `e22a30b5-f0da-4d1c-b9c8-d91e43eb739c` |
| R18 本番 | `9d28a4b2-e85e-4c12-ab46-f353a4f03e38` |

デプロイ後の確認（`POST /api/series/C326076/supplement` を収束するまで押した。1 回の押下で投げる
Yahoo の巻数は `MAX_YAHOO_PROBES` = 8 で、押下あたり 10〜16 秒）:

| 確認 | 本家 dev | 本家 本番 | R18 dev | R18 本番 |
|---|---|---|---|---|
| `GET /` | 200 | 200 | 200 | 200 |
| C326076 の巻数（前回 23 / 15） | 37 | 42 | 15 | 15 |
| `volumes_no_isbn`（前回 42 / 50） | 28 | 28 | 50 | 50 |

Yahoo から新たに埋まったのは 3・7・12〜15・17〜19・23・26〜28・30 巻の **14 巻で、誤りは 0 件**。
14 件すべて国会図書館サーチの講談社コミックス通し番号と一致した（26 巻 → 4-06-173505 ＝ 月マ 5、
27 巻 → 4-06-172510 ＝ KC510、12 巻 → 4-06-109364 ＝ KC364 …）。同じ巻番号で並ぶ KCスペシャル版
（1986 年・別シリーズ C328178）は MASTER-KNOWN 規則で落ちている。

本番だけ巻数が dev より 5 多いのは、20・21・22・24・25 巻に**以前からある利用者の手動追加**
（`series_correction`）が入っているため。中身は KCスペシャル版の ISBN（9784061012363 等）で、
C326076 ＝ 講談社コミックス版としては別の版にあたる。今回の変更が入れたものではない
（`correction: true` で返る）。これらの巻は講談社コミックス版の ISBN がどの情報源にも無いので、
直すなら手動追加を取り消して「ISBN が見つかりませんでした」に戻す形になる。要判断。

R18 版の数字が変わらないのは仕様どおり。外部ストアの API を呼ばない構成なので `yahooReady()` が
false になり、MADB だけで分かる「ISBN が見つからない巻」だけを返す。

## 2026-10-05 『釣りキチ三平』の手動追加を取り消す（本番のみ）

`db/fix-tsurikichi-sanpei-corrections.sql`（冪等・`DELETE` と `view_epoch` の更新だけ）。デプロイなし。
本番にだけ 13 件あり、dev / R18 2 環境は 0 件だったので本番のみに流した。

C326076『釣りキチ三平』(講談社コミックス) の 12〜25 巻として手動追加されていた 13 件は、中身が
すべて KCスペシャル版 (1986-87) の ISBN、つまり別シリーズ C328178 の巻そのものだった。穴埋め
(`src/gapFill.ts`) には「master が既に持つ ISBN はどのシリーズのものでも採らない」規則があるが、
手動追加 (`src/corrections.ts` `addCorrection`) は書影の有無しか見ていないので、この経路から入った。

適用直前の Time Travel ブックマーク（30 日で失効）:

| 環境 | bookmark |
|---|---|
| 本家 本番 | `000000fc-00000000-000050fb-64ec4430af8105e709352fb9a1b9c343` |

結果（`changes` 15 ＝ 削除 13 ＋ `view_epoch` の upsert）:

| 確認 | 適用前 | 適用後 |
|---|---|---|
| `series_correction` の C326076 | 13 件 | 0 件 |
| C326076 の巻数（本番） | 42 | 37（dev と一致） |
| `volumes_no_isbn` | 28 | 28（20・21・22・24・25 が戻り、12〜19・23 は正しい ISBN が残った） |
| 再取得で KCスペシャル版が再混入しないか | — | しない（C328178 の master が持つ ISBN なので MASTER-KNOWN 規則で落ちる） |

12・13・14・15・17・18・19・23 巻は同日の Yahoo 穴埋め (`ca7bf12`) で講談社コミックス版の正しい
ISBN が入っていたので、消した結果そちらだけが残った。20・21・22・24・25 巻は講談社コミックス版の
ISBN がどの情報源にも無いので「ISBN が見つかりませんでした」に戻る。

**未対応**: `addCorrection` に「その ISBN が他シリーズの巻かどうか」の確認が無い点はそのまま。
穴埋めと手動追加で規則が非対称なので、同じ混入は再び起こりうる。

## 2026-10-05 まとまりのシリーズ名の修正（4 環境）

migration なし（DDL 変更なし。`db/schema.sql` は `series_report` / `series_name_override` のキーに
G-id を許すコメントの追記だけ）。ingest なし。新しい Queue も不要。

シリーズに属さない巻のまとまり（G-id, `src/groups.ts`）の名前を直す導線。まとまりの名前は巻の書名
そのもので、マスタが書名を壊していると直す手段が無かった（G9784088511818 ＝『Dr.スランプ』
ジャンプ・コミックス版 18 巻が「Dr」で入っている）。シリーズ名の通報（collect-only）と管理者の
「名前を修正」を、series 行の無いまとまりにも通した:

- 巻一覧の「⚐ シリーズ名が違う？」をまとまりでも出す（`public/app.js`）。
- `POST /api/series/G…/report` を受け付ける（`src/index.ts` / `src/corrections.ts`）。どの巻の G-id から
  送っても、まとまりの正規 ID（G + 最小 ISBN）に集約する。
- 管理者の「名前を修正」が G-id でも通り、`series_name_override` に正規 ID で書く（`src/admin.ts`）。
  通報後に既存シリーズへ寄っていればそのシリーズ側に書く。series 行が無い分、通報一覧の現在名・
  ヒントはまとまりの巻の書名で代用する。
- 反映は read 時。`groups.applyGroupNames` が正規 ID で引き、巻一覧・検索カード・結合依頼画面・
  本の詳細のシリーズリンクに被せる。鍵・寄せ判定に使う素の書名（`UnlinkedGroup.title`）は触らず、
  表示名を `name` として分けてある。エッジキャッシュは admin の更新で `view_epoch` が上がって切れる。

同じ作業ツリーから `5f65a92`（手動追加 `addCorrection` の MASTER-KNOWN 規則・候補ピッカー
`/api/volume-candidates` の任意パラメータ `series`）も同梱。本家 dev には先行して出ていたので、
本番・R18 2 環境にはこのデプロイで初めて乗る。

| 環境 | Version ID |
|---|---|
| 本家 dev | `36eeaa88-1b16-41cd-b44d-b07a3a6cb43d` |
| 本家 本番 | `83d3ab4e-b706-4325-a454-a8c8b1e3aae7` |
| R18 dev | `0380c1ae-e5b3-47e5-830c-805a55fb007e` |
| R18 本番 | `2ba937b7-d5d0-4d89-9ce9-b59f6b8af6e5` |

デプロイ後の確認:

| 確認 | 結果 |
|---|---|
| `GET /`（4 環境） | すべて 200 |
| `GET /api/book?isbn=9784088511825`（2 巻・正規 ID ではない） | `series.id` が `G9784088511818`（＝まとまりの正規 ID）。本番で確認 |
| `GET /api/series/G9784088511986/volumes`（18 巻の G-id） | `series_id` = `G9784088511818`、18 巻 |
| `/api/volume-candidates`（`5f65a92` の確認） | `series` 無し → KCスペシャル版 9784061012363 が 1 件、`series=C326076` → 0 件、対照の `ONE PIECE` 110 は `series` 有無で同じ 1 件 |

名前自体はまだ「Dr」のまま。**実際の修正は管理画面（シリーズ名の修正 → 名前を修正）で入れる**。
入れると `series_name_override` に `G9784088511818` → 正しい名前が 1 行入り、全環境の閲覧者に反映される。

## 2026-10-05 直した名前を検索の鍵にする（4 環境）

`db/add-name-override-search.sql` を 4 環境に適用 → 4 環境をデプロイ。順序は **migration → デプロイ**
（列が無いと新コードの検索が 500、管理者の「名前を修正」も落ちる）。他セッションは起動しておらず、
`CLAUDE.md` の予告・調整は対象なし。

キーワード検索の照合はマスタの列（`series.name_norm` / `name_search` / `name_kana_norm`）だけを
見ていたので、マスタが書名を壊している作品は正しい名前で 1 件も当たらなかった。例が
『Dr.スランプ』のジャンプ・コミックス版 18 巻 `G9784088511818`: 書名が「Dr」で入っていて、
シリーズにも属さないので読みも無い。「Dr.スランプ」で検索すると完全版（`C297795`, 15 巻）や
文庫版（`C298933`, 9 巻）だけが並び、本編の 18 巻は出てこない。

管理者の名前修正（`series_name_override`）はこれまで表示専用だった。これを検索の鍵にもする:

- `series_name_override` に照合用の正規形 2 列を足す（`name_norm` = `normTitle(name)` /
  `name_search` = `searchKey(name)`、`series` の同名列と同じ畳み方）。修正時に JS で作って書く
  （`src/admin.ts`）。`name_search` は NFKC と記号落としを含むので SQL では作れず、migration の
  `UPDATE` は既存行の `name_norm` だけ埋める（空なら読み出し側が `name_norm` で代用する）。
- 検索は上書き表を 1 回だけ走査して当たった ID と段を拾う（`src/search.ts matchNameOverrides`）。
  表は管理者が直した分しか無く（本番 ~50 行）、重いキーワードクエリの方には手を入れない。
- **完全一致だけ 1 段上（mt=7）**。上書きは「この名前の作品はこれ」という管理者の明示なので、
  たまたま同名で並ぶマスタ行（『Dr.スランプ』は同名シリーズが 5 件）より先頭に出す。前方一致 5 /
  中間一致 4 は本体と同じ段で、同じ段の中は従来どおり巻数の多い順。
- まとまり（G-id）の上書きはまとまりを組み立ててカードにする。マスタの書名でも当たったときは
  二重に出さない。1 ページ目にだけ、`PAGE` の枠の外に最大 5 件まで足す（枠を食わせるとキーワードで
  当たった行がこぼれ、2 ページ目は SQL の offset で続きを出すので消えてしまう）。
- R18版の既定の絞り込み（成年向けのみ）は上書き側にも掛ける。

ローカル（本番相当のマスタ）で `G9784088511818` に「Dr.スランプ」の上書きを入れて確認:

| 検索語 | 適用前 | 適用後 |
|---|---|---|
| `Dr.スランプ` | 1 件も出ない（先頭は完全版 15 巻） | **先頭に `G9784088511818` 全18巻**、次に完全版 |
| `Drスランプ` / `ＤＲ．スランプ` | 同上 | 同上（`name_search` が記号・全角を吸収） |
| `スランプ`（中間一致） | 出ない | 同じ段の中で巻数が最多なので先頭 |
| `Dr`（壊れたままのマスタ書名） | まとまりが出る | 出る（二重にはならない） |
| `Dr.スランプ&offset=30` | — | 足さない（1 ページ目と重ねない） |

### 適用前に控えたブックマーク（Time Travel の戻し先）

| 環境 | bookmark |
|---|---|
| 本家 dev | `000000ec-00000000-000050fb-0a27b9d3963a7af1bca49e3e54dad3c6` |
| 本家 本番 | `00000101-00000000-000050fb-b6d962a35b451d86be26f45667290319` |
| R18 dev | `00000019-00000000-000050fb-9598685ae5d77c5e5361980355864c99` |
| R18 本番 | `00000020-00000000-000050fb-43d8bf053d6f547f3e2a658788580b65` |

`series_name_override` は 4 環境とも `backups/*-20261005-2043-series_name_override.sql` に書き出した
（本番 52 行、他 3 環境は 0 行）。この migration が触る表はここだけ。

### 適用とデプロイ

| 環境 | migration | Version ID |
|---|---|---|
| 本家 dev | 適用（`rows_written` 2 ＝ ALTER のみ、上書き 0 行） | `7025d0c1-f616-4538-8bcb-71974c04f7dd` |
| 本家 本番 | 適用（`changes` 53 ＝ ALTER ＋ 既存 52 行の `name_norm` バックフィル） | `a70488ec-8607-43c3-96af-d81896441507` |
| R18 dev | 適用（上書き 0 行） | `5846e6a2-247a-44fe-ae37-fab4c60cef83` |
| R18 本番 | 適用（上書き 0 行） | `1e733383-27dc-4e9b-9986-265308b63a6e` |

`name_search` は本番の既存 52 行で空のまま（NFKC と記号落としは SQL で作れない）。読み出しは
`name_norm` で代用し、その行を管理者が次に直したときに埋まる。

### デプロイ後の確認

| 確認 | 結果 |
|---|---|
| `GET /`（4 環境） | すべて 200 |
| 本家 本番 `?q=名探偵コナン`（既存の上書き 52 行が効く表示） | 従来どおり（`C254778` が「名探偵コナン[My First BIG]」で表示） |
| R18 本番 / dev `?q=ああ` | 年齢確認クッキー無しは 403（`age_gate`、従来どおり）、`age_ok=1` 付きで 5 件 |
| 本家 dev で `G9784088511818` に「Dr.スランプ」の上書きを投入 | `?q=Dr.スランプ` / `Drスランプ` / `スランプ` のいずれも **先頭が `G9784088511818` 全18巻**、次が完全版 15 巻。巻一覧も `Dr.スランプ` 18 巻 |

### デプロイ直後に本番で出なかった件（エッジキャッシュ）

本番には `G9784088511818` → `Dr.スランプ` の上書きが **20:25 に管理画面から既に入っていた**（デプロイの
前）。にもかかわらずデプロイ後も `?q=Dr.スランプ` で出てこなかった。原因は検索のエッジキャッシュ
（`SEARCH_CACHE_SEC` = 3600）:

- 鍵は `normTitle(q)` + `offset` + `view_epoch`。**デプロイしても鍵は変わらない**（コードの版は鍵に
  入っていない）。
- `view_epoch` が最後に上がったのは上書きを入れた 20:25。その直後に誰かが `?q=Dr.スランプ` を引くと、
  **旧コードの「出てこない」応答**がその鍵で最大 1 時間キャッシュされ、デプロイ後もそれが返り続けた。
- 切り分け: 鍵が別の `?q=Dr.スラ`（前方一致）は新コードの結果を返し、先頭に `G9784088511818` が出た。
  → コードは本番でも動いていて、特定の鍵が古いだけ。

対処は `view_epoch` を進めるだけ（全データセンタの鍵が同時に変わる）。あわせて、この行は旧コードが
書いたもので `name_search` が空だったので `drスランプ` を埋めた（新コードの管理画面なら自動で入る値）。

```sql
UPDATE series_name_override SET name_search='drスランプ'
 WHERE series_id='G9784088511818' AND name='Dr.スランプ';
INSERT INTO meta (key,value) VALUES ('view_epoch','<now ms>')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;
```

本番での確認（いずれも先頭が `G9784088511818` 全18巻、次が完全版 15 巻）:
`?q=Dr.スランプ` / `?q=Drスランプ` / `?q=ＤＲ．スランプ` / `?q=スランプ`。

**今後の教訓**: 検索の出方を変えるデプロイは、直後に `view_epoch` を 1 回進める（admin の更新系 API を
1 回叩くか、上の `INSERT`）。入れないと、デプロイ直前に引かれた鍵だけ最大 1 時間古いままになる。
鍵に Worker の版（`env.CF_VERSION.id`）を混ぜれば自動で切れるが、デプロイのたびに検索キャッシュが
全部捨てられることになるので未対応。

本家 dev にも動作確認用に同じ上書き 1 行が入っている（dev は `name_search` も入った新コード経由）。

**残っている穴**: 読み（かな）は直せない。上書きは名前 1 つだけなので、「ドクタースランプ」の
ような読みでの検索は、読みを持つマスタのシリーズ（`C298933` 等）にしか当たらない。


## 2026-10-05 上流が取り違えた ISBN を直す仕組み（`volume_master_fix`）

MADB は巻の ISBN 自体を取り違えていることがある。見つかった実例:

- `9784063129502` は実際には **『Rave』9 巻**（真島ヒロ / 講談社コミックス / 2001-03 / `C325142`）。
  MADB はこれを **『超感電少女モナ』**（安野モヨコ / 講談社コミックスフレンドB / 1994-04-13 /
  `C279630`）の巻として持っている。
- モナの正しい ISBN は `9784063029505`（`4-06-302950-6`）。`302950` → `312950` の 1 桁取り違えで、
  この ISBN はマスタに 1 行も無い。

根拠は 3 つ: openBD が `9784063129502` を "Rave 9" / 真島ヒロ / 講談社 / `200103` と返す。ISBN の近傍
`97840631294xx`〜`296xx` は全部 2001 年の講談社コミックス／少年マガジンコミックスで、1994 年の
KCフレンドB はこの行だけ浮いている（1994 年の KCフレンドB は `97840630294xx` 台）。NDLサーチが
モナの ISBN を `4-06-302950-6`（「講談社コミックスフレンドB：950巻」）と持っている。

症状は 2 つで、どちらも 1 行が原因:

- `C325142`『Rave』が 9 巻だけ欠番になる（8 巻 `9784063129250` と 10 巻 `9784063129694` の間）。
- その ISBN を手で足そうとすると「別シリーズの巻の ISBN は採らない」規則
  （`src/corrections.ts` の `ownersOfOtherSeries`、コミット `5f65a92`）に弾かれる。規則としては正しい。

### なぜ読み出し時の上書きでは足りないか

間違っているのは表示名だけでなくシリーズ・巻番号・著者・発行日の全部で、巻一覧・リスト表示・詳細は
どれも別経路で読む（`src/book.ts` はマスタの `creator` / `pubdate` を楽天より優先する）。
`volume_title_override` では詳細の「安野モヨコ / 1994-04-13」が残り、`volume_series_link` は
シリーズしか直せない。そこで**マスタ行そのものを正す**。

### 仕組み

`volume_master_fix` は「直した後のマスタ行そのもの」を ISBN ごとに持つ表（列は `volumes` と同じ並び
＋ `note` / `created_at`）。`volumes` は月次取り込みで作り直されるので、取り込みの最後に
`INSERT OR REPLACE INTO volumes ... SELECT ... FROM volume_master_fix` で載せ直す
（`scripts/ingest.mjs` の `APPLY_MASTER_FIX_SQL`。`APPLY_LINKS_SQL` の後 ＝ シリーズの紐付けも
含めてここが最終の値）。`db/add-volume-master-fix.sql` の最後の文はその写しで、取り込みを待たずに
今のマスタへ当てるためのもの。

- 部分指定ではなく全列を書く。上流の値は信用しないので `COALESCE` で混ぜない。
- `INSERT OR REPLACE` なので、上流に無い ISBN（取り違えで消えた側の巻）は新しい行として入る。
  今回はこれでモナを正しい ISBN で入れ直し、`C279630` が 0 巻になるのを避けている。
- 成年向けの巻は入れない（本家の `volumes` には成年向けの行が 1 行も無い前提で、この表は
  本家にもそのまま載せ直すため）。巻を消す/隠すのは従来どおり `volume_hidden`。
- `DEV_RESET_TABLES`（`src/admin.ts`）には入れない。`volume_series_link` と同じく取り込みで
  作り直せない管理者確定データなので。

公開側の読み出しパスは変えていない（マスタ行そのものが正しくなるので、巻一覧・リスト表示・詳細は
何も知らなくていい）。

### 管理画面「マスタ行の修正」

同じことを SQL を書かずにできる管理ページを足した（`#master-fixes`、`src/masterFix.ts`）。

- **ISBN で調べる** … 今のマスタ行（壊れている当人）、既にある修正、**openBD の書誌**（鍵なしの
  外部 API。書名・著者・出版社・発行日。あらすじは漫画でほぼ空なので使わないが、書誌は収録率 97%）、
  指定したシリーズの**手本**（そのシリーズで最多の書名/著者/出版社/レーベルの組）を材料として並べ、
  それぞれ「写す」「反映」「揃える」で下のフォームに入れられる。
- **保存** … `volume_master_fix` に upsert して、その場で `volumes` へ当てる。`title_search` /
  `creators_norm`（検索キー）はサーバが作り直し、`vol_sort` は空なら巻番号から導く。
  シリーズ ID は実在チェック（まとまりの G-id は拒否）、発行日は形のチェック、成年向けの印は
  R18版でだけ受け付ける。
- **一覧** … 差し替え済みの行。`反映` 列が「未反映」なら、修正はあるのにマスタがその値になっていない
  ＝ 取り込みの載せ直しが抜けている合図。
- **取り消し** … 控え（`prev_json`、差し替える前のマスタ行）があればそれを書き戻し、無ければ
  （上流に無い巻を足していたので）`volumes` から消す。控えは最初の保存のときだけ取る
  （上書き保存で控えが自分の値に化けないように）。

テストは `test/masterFix.test.ts`（列の並びが `volumes` と揃っていること、保存・新規投入・
取り消しの戻し/削除・取り込み後の載せ直しと冪等・一覧の反映状態・入力の検査）。ローカルの
`wrangler dev` で実物も通した（lookup が openBD から "Rave 9" を引く → 保存 → `/api/series/C325142/volumes`
に 9 巻が出る → 取り消しで `C279630` が元に戻る）。

### 適用（2026-10-05、全 4 環境）

**migration → デプロイの順**（逆だと管理画面が `no such table: volume_master_fix` で落ちる）。
ingest は不要（マスタの列は増えていない）。次の月次取り込み以降は `APPLY_MASTER_FIX_SQL` が
自動で載せ直す。

1. `wrangler d1 execute DB [--env dev|r18dev|r18] --remote --file db/add-volume-master-fix.sql`
   … 4 環境とも `changes: 5` / `rows_written: 13`。適用後はどの DB でも
   `volume_master_fix` 2 行、`volumes` の 9784063129502 が `C325142`、9784063029505 が `C279630`。
2. `npm run deploy:dev` → `deploy:prod` → `deploy:r18:dev` → `deploy:r18:prod`

| 環境 | Version ID | 適用前のブックマーク（Time Travel の戻し先） |
|---|---|---|
| dev | `e0bc6b3c-de25-4117-8290-36a295528248` | `000000f4-00000000-000050fb-4e8772fe2698c6632edc530345e40a61` |
| 本番 | `6c66f704-617b-44d4-9fe1-94cd85fa710d` | `00000108-0000041a-000050fb-300e3cb5bbc7a464b31456cfed2b2fef` |
| R18 dev | `aaeace56-1b65-4329-8c88-d31e9b0a9a62` | `0000001d-00000000-000050fb-5a3e1c057b26026bd05416f0b43b8e4b` |
| R18 本番 | `a50fc304-81fa-424c-9954-02ce47f020d7` | `00000025-00000000-000050fb-39052ee0dbdd6aa896029dd54ed30fe4` |

デプロイ後の確認: 4 ドメインとも `/api/series/C325142/volumes` が 35 巻を返し、9 巻が
`9784063129502` で出る（`my100manga.com` / `dev.my100manga.com` / `my100shunga.com` /
`dev.my100shunga.com`）。`/api/admin/master-fixes` は Cloudflare Access のガードで 401
（ルートは通っている）。

デプロイ中に並行セッション（`my100manga-0f`）から `db/fix-honzuki-part4-volume.sql`
（`series_correction` の 1 行の付け替え）の予告を受けたが、触る表が重ならないので止めずに続行し、
完了を知らせた。あちらは本番適用をこちらの完了まで待っている。

## 2026-10-05 『本好きの下剋上』第4部9巻の手動追加に巻番号を付ける（本番のみ）

`db/fix-honzuki-part4-volume.sql`（冪等。`series_correction` の 1 行の付け替えと `view_epoch` の更新
だけ）。デプロイなし・ingest なし。本番にだけ 1 件（local / dev remote は 0 件、R18 2 環境は未確認）。

ISBN `9784867943816` は openBD で『本好きの下剋上～司書になるためには手段を選んでいられません～
第四部「貴族院の図書館を救いたい！9」』(勝木光 / TOブックス / コロナ・コミックス)。本番のマスタは
第4部を `第4部[1]`〜`[8]`・`[10]`〜`[12]` まで持っていて **9 巻だけが欠番**なので、手で足したこと自体も、
足した先 `C365444` も正しい。間違っていたのは巻番号だけ:

| 列 | 旧 | 新 |
|---|---|---|
| `volume_number` | `9` | `第4部[9]` |
| `vol_sort` | `9` | `4009`（`src/util.ts` `volSort` の「部 ×1000 + 巻」。`第4部[8]`=4008 と `第4部[10]`=4010 の間） |

`series_id` / `cover_url` / `created_at` / `reviewed_at` はそのまま。`vol_sort` が 9 だったので、第4部の
9 巻が **`[6`(6) と `第1部[7]`(1007) の間**、つまり第1部の巻に紛れて並んでいた。

### 本番の結合の向きに注意（この修正で一度間違えた）

`db/series-merge-data.sql`（ローカルのダンプ）では `C417458` / `C452185` → **`C417457`** に吸収されて
いるが、**本番は逆で `C417457` / `C417458` / `C452185` → `C365444`** が結合先。本番のマスタはその後の
取り込みで第2部〜第5部の巻をほぼ `C365444` に寄せていて、`C417457` は 5 巻・`C452185` は 2 巻しか
持っていない（第4部[3]〜[12] は `C365444` に在る）。

ローカルのダンプだけを見て「第4部の実体は `C452185`」と判断し、最初の適用で `series_id` を
`C452185` に移してしまった（`finalBookmark 0000010b-00000006-…`）。巻一覧の見え方は同じ
（`src/series.ts` `getSeriesVolumes` と `src/corrections.ts` `getCorrectionVolumes` が結合の全 member の
訂正を読む）が、結合を解いたときに 9 巻だけ第4部の他の巻から離れる。SQL を書き直して `C365444` に
戻した（2 回目の適用、`finalBookmark 0000010b-0000000c-…`）。**今の SQL はどちらの状態から流しても
`C365444` / `第4部[9]` / `4009` に収束する**（`C365444` を優先して 1 行だけ採り、member 側の行は消す）。

教訓: **本番のデータを直す SQL は、本番の `series_merge` と `volumes` の実体を見てから書く。**
ローカルの D1 は取り込みの世代が古く、シリーズの結合の向きも巻の所属も本番と食い違う。

### 適用

適用前の Time Travel ブックマーク（30 日で失効）:

| 環境 | bookmark |
|---|---|
| 本家 本番 | `0000010b-00000000-000050fb-13dac183086677016c4ffef8c3c091e7` |

結果（2 回目の適用後）:

| 確認 | 適用前 | 適用後 |
|---|---|---|
| `series_correction` の当該行 | `C365444` / `9` / `vol_sort 9` | `C365444` / `第4部[9]` / `vol_sort 4009` |
| 本番 `/api/series/C365444/volumes` | 43 巻・9 巻が先頭付近 | 43 巻・`第4部[8]` と `第4部[10]` の間に `correction: true` で並ぶ |

この修正を SQL でしか行えなかった原因（画面で部付きの巻番号を入れられない・管理画面で直せない）は、
次の節の恒久対策で塞いだ。

## 2026-10-05 部立ての巻を手で足せるようにし、管理画面から直せるようにする（4 環境デプロイ済み）

migration なし（DDL 変更なし）。ingest なし。新しい Queue も不要。**デプロイだけ**。

上の『本好きの下剋上』の件は、独立した 3 つの穴が重なって起きた。塞いだのは次の 3 つ:

**① 巻番号に部を書けなかった**（`src/corrections.ts` `normalizeVolume`）。「N」「巻N」しか受け付けず、
部立てのシリーズに正しい巻番号で足す手段が画面に無かった。`src/util.ts` に部立てラベルの読み書き
（`parseArcLabel` / `arcLabelTemplate` / `formatArcLabel`）を足し、**そのシリーズが既に部立てで巻番号を
振っているときだけ**「第4部9」を受け付けて、そのシリーズの書式（`第4部[9]` / `第2部 4`）に揃えるように
した。部立てでないシリーズには入れない（`volSort` の「部 ×1000 + 巻」が他の巻と噛み合わないため）。
ラベルは結合の全 member から集める（吸収された側に部立ての巻が在ることがある）。

**② 新刊ピッカーの既定巻番号が部立てラベルを誤読していた**（`public/app.js` `openNewVolumePicker`）。
`s.match(/\d+/)` で最初の数字列を採るので `第1部[7]` から**部番号の 1** を拾い、本番の C365444 では
既定が「7巻」になっていた（正しくは第5部2巻）。数字が 1 つだけのラベルからだけ最大巻を取り
（`170　／　第170巻` のような同じ数の二重表記は 1 つとして読む）、部立てが多数派のシリーズでは
最後の部の最大巻 + 1 を既定にして、部と巻の 2 つを編集できる入力を出すようにした。

**③ 管理画面で直せなかった**。確定／却下しかできず、「巻そのものは正しいが巻番号や置き場所が違う」
投稿は、消すか SQL を書くかの二択だった。`PATCH /api/admin/corrections/:series/:isbn`
（`src/admin.ts` `adminUpdateCorrection`）と一覧の「修正」ボタンを足した。巻番号の付け直しと別シリーズ
への移動ができ、巻番号は投稿と同じ規則で**移動先のシリーズの書式に**揃う。`vol_sort` はサーバが
`volSort` で引き直す。表紙・投稿日・確定状態は引き継ぐ。移動先は series 行のあるシリーズだけ
（まとまり G-id へは移せない）、移動先に同じ ISBN があれば断る。

テストは `test/arcVolume.test.ts`（部立てラベルの分解・書式選び・`volSort`、部立てシリーズでの受理と
素の巻番号シリーズでの拒否、結合先からのラベル収集、管理画面の付け直し・移動・各種の拒否）。
ローカルの `wrangler dev` で PATCH のルートと巻一覧への反映も実物で通した
（`第4部[8]` と `第4部[10]` の間に `第4部[9]` が入る）。

**見送り**: openBD で ISBN の書誌を引いて「その ISBN が本当にこのシリーズの巻か」を確かめる案。
今回の取り違えには無関係（ISBN は本当にそのシリーズの巻だった）で、釣りキチ三平の件のような
別作品の混入にだけ効く予防策なので別件とする。抜け巻の検出（`public/app.js` `detectGaps`）も
部立てに対応していないままで、部立てのシリーズでは欠番ボタンが出ない（今回も「新刊が出ていますか？」
から入っている）。

### 適用

migration は無し（DDL 変更なし）。**2026-10-05 に 4 環境ともデプロイ済み**。同じ作業ツリーの
`remove-redundant-name-overrides.sql`（次の節）と同時に、my100manga-3b セッションが代表して出した
（リポ直下 CLAUDE.md の予告・調整の手順どおり、両セッションのユーザの合意を取ってから）。

| 環境 | Version ID |
|---|---|
| 本家 dev | `ad442dfa-a8e9-44c2-bae5-d168e2439ec1` |
| 本家 本番 | `6d1740b8-c143-4cc9-bef9-4fa21b5b2ef2` |
| R18 dev | `c1630baf-7ba8-42af-8c93-45784243964b` |
| R18 本番 | `956cc813-5906-4328-a628-0ea73f2c08eb` |

`db/fix-honzuki-part4-volume.sql`（本家 本番に適用済みのデータ後始末）はコードの前提ではないので、
このデプロイには含めていない（本家 dev / R18 2 環境は該当行が無く未適用のまま）。

デプロイ後の確認: `https://<host>/app.js` が `ARC_LABEL_RE` を含む（本家 本番 / 本家 dev / R18 本番の
3 つで確認）。管理画面側（`editCorrection`）は本家では `/admin.js` ごと Cloudflare Access が 302 で
止めるので外からは見えない。R18 は Access アプリが未作成（`docs/r18.md`）なので `/admin.js` が 200 で
出てしまい、そこで新コードを確認した。**API は 4 環境とも守られている**（R18 の `/admin`・
`/api/admin/*` は `ADMIN_EMAILS` 等が未投入で fail-closed の 403）。`/admin.js` は秘密を持たない
クライアントコードなので実害は無いが、R18 の Access アプリを作るまで管理画面の作りが読める
（`isAdminUiPath` は設計上 `/admin.js` を拾わず、ゾーン側の Access に任せている。`test/security.test.ts`）。

本番の管理画面 API（PATCH）は Access の内側にあり外から叩けないので、動作はローカルの
`wrangler dev` での実機確認と `test/arcVolume.test.ts` までで、本番では未実行。

## 2026-10-05 タグで言えるようになったシリーズ名の修正を外す（4 環境適用・デプロイ済み）

`db/remove-redundant-name-overrides.sql`（冪等。`series_name_override` から 13 行を DELETE するだけ）。
**2026-10-05 に 4 環境とも適用・デプロイ済み**（結果は末尾の「適用」節）。あわせて管理画面に個別の
「修正を外す」導線を入れた（下記）。

### 何を外すか

本番の `series_name_override` 53 件のうち、**今そのシリーズに有効なタグ（`series_tag` → `label_tag`）が
付いていて、修正名がそのタグと同じことしか足していない** 13 件。タグ（`db/add-label-tag.sql` /
`db/add-series-tag.sql`）が無かった頃に、版の違いをシリーズ名そのものへ書き込んで区別していたもので、
今はカードにも巻一覧にも「廉価版」「文庫版」「傑作選」のバッジが出るので二重になっている。

| 分類 | series_id | 修正名 | 外したあと |
|---|---|---|---|
| 修正名がタグの語そのもの | `C311653` | 金田一少年の事件簿 廉価版 | 金田一少年の事件簿 ＋ 廉価版 (KPC) |
| | `C311488` | 金田一少年の事件簿 文庫版 | ＋ 文庫版 (講談社漫画文庫) |
| | `C283600` | きょうの猫村さん 文庫版 | ＋ 文庫版 (マガジンハウス文庫) |
| | `C277372` | ジョジョの奇妙な冒険[文庫版] | ＋ 文庫版 (集英社文庫コミック版) |
| | `C276801` | 三国志 文庫版 | ＋ 文庫版 (潮漫画文庫) |
| レーベル名の括弧書き（レーベル＝タグの出どころ） | `C254099` | ゴルゴ13 (小学館文庫版) | ＋ 文庫版 (小学館文庫) |
| | `C334599` | 頭文字D (プラチナコミックス) | ＋ 廉価版 (KPC) |
| | `C254778` | 名探偵コナン[My First BIG] | ＋ 廉価版 (My first big) |
| | `C300052` | ドラえもん (My first big) | ＋ 廉価版 (My first big) |
| | `C259229` | ゴルゴ13 (My First Big) | ＋ 廉価版 (My first big) ※下記 |
| タグの方が粗いが、本家との区別は付く | `C258280` | ゴルゴ13 (小学館叢書) | ＋ 傑作選 (小学館叢書) |
| | `C336684` | キングダム 総集編 | ＋ 傑作選 (集英社マンガ総集編シリーズ) |
| | `C278917` | こち亀 秋本治自選コレクション | ＋ 文庫版 (集英社文庫 コミック版) |

残す 40 件は編名・部番号（ドラゴンボールZ 各編、ジョジョ Part 1〜9、金田一 第Ⅰ/Ⅱ期）、海外版
（NARUTO / Carlsen Manga!）、劇場版・限定版、マスタ破損の修正（`C312117` 「ｖ」→ ハレグゥ、
`G9784088511818` Dr.スランプ）など、タグでは代替できないもの。`C275066` もタグは傑作選だが、
修正名が同時に ドラゴンボールZ → ドラゴンボール の**書名修正**を兼ねていて、外すと `C275075` と同じ
カードになるので残す。

### 承知の上の副作用

- **`C259229` は見出しが重なるが、曖昧判定で区別が付く**（適用前の見立てを適用後に訂正）。外すと、
  同じく廉価版タグの `C260140`（My first big super, 3 巻）とカードの見出しが「ゴルゴ13［廉価版］」で
  並ぶ。見立てでは `series.creators` が違うので `public/app.js` `ambiguousEditionKeys` の曖昧判定に
  掛からないと書いたが、**鍵に使う作者は `series.creators` ではなく先頭の巻の `creators`**
  （`src/search.ts` `SERIES_COLS` の `COALESCE` 副問い合わせ）で、この 2 件はどちらも
  「さいとう・たかを、さいとう・プロ」で一致する。よって曖昧判定が効き、メタ行にレーベルと初版年が
  出る。適用後の本番 `/api/search` で `C259229` →「My first big」・`C260140` →「My first big super」と
  表示されることを確認済み。
- **`C278917` は情報が落ちる**。文庫版タグは付くが「**自選**コレクション」という選集であることは消える。
- **検索の引き当てが減る**。修正名は `name_norm` / `name_search` 経由で検索の鍵にもなっている
  （`db/add-name-override-search.sql`）。ただし今回の 13 件は「金田一少年の事件簿 廉価版」のような
  誰も打たない文字列なので実害は無い。マスタの書名が壊れていて修正名でしか引けないシリーズ
  （`C312117` / `G9784088511818`）は上記のとおり除外してある。

### 管理画面の導線（コード側、デプロイが要る）

以後の個別の取り消しは SQL 無しで行える。「シリーズ名の修正」→「修正した名前を表示」→ 各行の
**「修正を外す」**（`DELETE /api/admin/series-overrides/:id`、`src/admin.ts` `adminDeleteNameOverride`）。
`series_report` には触らないので、外した結果また通報されたら改めてキューに出る。

同じ一覧に**今そのシリーズに出ているタグ**の列を足した（`adminListNameOverrides` が
`series_tag` → `label_tag` の順で引く。まとまり G-id にもタグを付けられるので `series_tag` 側は
`o.series_id` で引いている）。修正名の隣に同じバッジが出るので、「名前とバッジが同じことを
言っている＝外せる」が一覧の上で見分けられる。確認ダイアログは戻り先の名前と、タグが
引き継ぐかどうかを出す（タグが無いシリーズでは「版の違いを示すものが無くなります」と警告する）。

### 適用（2026-10-05、4 環境）

適用前の Time Travel ブックマーク（30 日で失効）:

| 環境 | bookmark |
|---|---|
| 本家 dev | `000000f8-00000000-000050fb-aae11cdcc41faa118fea195f4f9fa6bb` |
| 本家 本番 | `0000010c-000001f0-000050fb-2ed7df4adfe03bab58788e63d67c0576` |
| R18 dev | `00000021-00000000-000050fb-898bde23a68a1377aca37eae4059048b` |
| R18 本番 | `00000029-00000000-000050fb-5000783e99934ba9ce1bfa51051d8551` |

結果:

| 環境 | 適用前の `series_name_override` | 削除 | 適用後 | Version ID |
|---|---|---|---|---|
| 本家 dev | 1 件（`G9784088511818` Dr.スランプ＝除外対象） | 0 | 1 件 | `ad442dfa-a8e9-44c2-bae5-d168e2439ec1` |
| 本家 本番 | 53 件 | **13** | 40 件 | `6d1740b8-c143-4cc9-bef9-4fa21b5b2ef2` |
| R18 dev | 0 件 | 0 | 0 件 | `c1630baf-7ba8-42af-8c93-45784243964b` |
| R18 本番 | 0 件 | 0 | 0 件 | `956cc813-5906-4328-a628-0ea73f2c08eb` |

実質 **本家 本番だけの変更**（修正は管理画面から本番に対して付けたものなので、他の 3 環境には
そもそも該当行が無い）。本家 本番の適用後ブックマークは
`0000010c-00000316-000050fb-3bc0ab74f79886c2d1523cf0385cc6f4`。

適用後の確認（本番 `/api/search`）:

| 確認 | 結果 |
|---|---|
| `series_name_override` の残り | 40 件・外した 13 件は 0 件 |
| 「金田一少年の事件簿」 | `C311653` → 素の書名＋**廉価版**バッジ、`C311488` → 素の書名＋**文庫版**バッジ |
| 「ゴルゴ13」 | `C254099` 文庫版 / `C258280` 傑作選 / `C259229`・`C260140` 廉価版（レーベル行で区別） |

このデプロイには my100manga-0f セッションの「部立ての巻」対応も同梱されている（同じ作業ツリーの
未コミット分。リポ直下 CLAUDE.md の手順どおり予告・合意のうえ、当方が代表してデプロイした）。

## 2026-10-05 並べ替えの誤タップ対策とモーダルの戻る対応（4 環境デプロイ済み）

migration なし（DDL 変更なし・`db/*.sql` の新規適用なし）。ingest なし。新しい Queue / 環境変数 /
Secret も不要。**デプロイだけ**。my100manga-01 セッションが代表して 4 環境に出した（リポ直下
CLAUDE.md の予告・調整の手順どおり、my100manga-26 から「デプロイ可・待機不要」の返信を得たうえで）。

### ① 並べ替えを 2 段階にした（`public/app.js` / `index.html` / `styles.css`、my100manga-01）

誤爆の原因は**選択の途中に移動のトリガが画面上に在った**こと。1 件でも選ぶと全カードの左 30% が
挿入キャレット（`.ins-caret`、タップで選択ごと移動）に変わるので、次の本を選ぼうとしたタップが
そこに当たると意図しない移動が確定していた。

- **選択フェーズ**: キャレットを描かない。カードのタップは選択だけ。下部バーも
  `名前順 / 選択解除 / 移動先を選ぶ / 完了` のみで、**移動を実行するボタンを置かない**
  （「先頭へ」「末尾へ」は移動先フェーズへ移した）。
- **移動先フェーズ**（`state.placing`。「移動先を選ぶ」で入る）: 挿入先はカード全体が当たり判定。
  キャレットは `pointer-events: none` の目印に降格。移動する本自身は薄く表示して `disabled`。
  「選択にもどる」で戻れる。全件選択のときは移動先が無いので入れない（トーストで知らせる）。
- **取り消し**: 挿入・先頭へ・末尾へ・名前順のすべてで「元に戻す」トーストを 6 秒出す
  （`finishMove(next, label)` → `offerUndoMove`。削除の誤タップ対策と同じ作り）。戻すまでの間に
  本が増減していたら古い並びで上書きしない。`sortByName` は元配列を残すようコピーを並べ替える。
- 固定バーに下端のカードとトーストが潜らないよう `body.reordering` に余白、狭い画面ではバーの
  ボタンを 1 行に収まる大きさにした（390px 幅で 2 行・85px）。

### ② モーダルをブラウザバックで閉じられるようにした（`public/ui-dialog.js`、my100manga-26）

開いている数だけ同じ URL の履歴を積み（state の深さ `__modal`）、戻る操作で最前面から順に閉じる。
画面内のボタンで閉じたときは `history.go` で積んだぶんを戻すので履歴に残らない。閉じ方はモーダル
ごとに違うので Esc を投げて既存の閉じ処理に乗せている。`ui-dialog.js` を読む全ページ（index / view /
admin / account / ranking / sales-ranking / circulation）に効く。各ページの JS は無変更。

対象は `.modal-backdrop` だけでなく `.ui-dialog-backdrop`（`uiAlert` / `uiConfirm` / `uiPrompt`、
share-x.js の SNS パネルと種別選択、account.js の紐付け・退会ダイアログ）も含む。重なっている
ときは 1 回の戻るで最前面の 1 枚だけ閉じる。**Esc で閉じないモーダルは戻るでも閉じない**
（公開後の共有モーダルは従来どおり「編集用URLをコピーしましたか」の確認を挟み、「戻ってコピー
する」を選べば開いたまま＝そのぶん履歴を積み直す）。

実装で踏んだ注意点:

- `history.go` は非同期なので、戻している最中は数合わせをしない（`awaitingPop`）。重ねて要求すると
  戻りすぎて前のページまで出る（確認ダイアログとモーダルが相次いで閉じる共有モーダルの流れで起きる）。
  戻り先が無く `popstate` が来ない場合に備えて 500ms で解除する。
- モーダルを開いたまま再読み込みすると履歴に深さの目印だけ残るので、起動時に `replaceState` で消す。
  残すと 1 回の戻るで「閉じる＋前のページへ」と二重に効く。
- account.js のダイアログは class の付け外しではなく `open` 付きで生成 → 削除なので、class 監視に
  `childList` を足して数合わせだけ拾う（フォーカス周りの既存挙動は変えていない）。
- Safari の `pushState` 連打制限で例外になっても数がずれないよう `try/catch` で積む。

このリポに DOM のテスト環境が無いため（vitest は workerd 上）自動テストは無し。確認は `node --check`
と、下記の本家 dev での実機操作。

### 適用

`db/*.sql` の新規適用は無し。ツリーに在る `fix-honzuki-part4-volume.sql` /
`remove-redundant-name-overrides.sql` は上の節のとおり適用済みで、今回は触っていない。

| 環境 | Version ID |
|---|---|
| 本家 dev | `8e9f1616-d97c-455b-952b-8bae2d8df5e3` |
| 本家 本番 | `269e6470-afb8-4a4d-b9ce-ffc3d087e2c4` |
| R18 dev | `6ac44d58-4602-4deb-b65d-5dbc028c81c2` |
| R18 本番 | `6edae359-5746-449b-b44b-1012eb26f3bb` |

デプロイ前: `npm test` 32 ファイル / 355 件すべて通過、`npx tsc --noEmit` エラー 0。

デプロイ後の確認（4 環境とも）: `/app.js` が `startPlacing` を、`/styles.css` が `.grid.placing` を、
`/ui-dialog.js` が `__modal` を、`/`（index）が `id="movePick"` を含む。

実機確認は本家 dev に対して Playwright で通した（下書きを localStorage に仕込んで操作）:

| 確認 | 結果 |
|---|---|
| 選択フェーズのキャレット数 | 0（＝移動のトリガが無い） |
| 以前の誤爆地点（カード左端 4px）をタップ | 並び順は不変・選択が 1 件増えるだけ |
| 移動先フェーズで 6 番目を指定 | `1,3,5,2,4,6`（選択 2 件がその前に順序を保って入る） |
| 「元に戻す」 | 元の並びに完全復元 |
| 編集モーダルを開いて戻る操作 | モーダルだけ閉じる（②の確認。my100manga-26 の依頼分） |

R18 2 環境は年齢確認ゲートがあるため実機操作は未実施。配信物が同一であることは上の 4 ファイルの
確認で担保している。

## 2026-10-06 マスタに無い作品をシリーズとして登録する（`series_register_request`）

MADB に **1 巻も載っていない作品**がある。実例:

- `9784758061780`『このこここのこ』1 巻（藤こよみ / 一迅社 IDコミックス REXコミックス / 2009-12 / 全 3 巻完結）。
  `series` にも `volumes` にも 1 行も無い（著者の他作品『ひとつ屋根の下の』『買い食いハラペコラ』は入っている）。
  openBD・NDLサーチ・版元ドットコムも 0 件。**楽天ブックスだけが 3 巻とも持っている**
  （`9784758061780` / `9784758061957` / `9784758062251`、表紙つき）。Yahoo! ショッピングにも中古出品がある。

症状: ISBN 検索は `rakutenCard`（`src/search.ts`）の**楽天ブックス由来の 1 冊ライブカード**を返す
（`series_id` が `rakuten<ISBN>` の擬似 ID）。リストには入れられるが、シリーズとして開けず、全巻まとめて
追加できず、書名「このこここのこ」で検索しても出ず、結合・分離・名前修正・タグ・抜け巻穴埋めのどの導線にも
乗らない。

> 楽天 API を直に叩いて確かめるときは **`outOfStockFlag=1` を必ず付ける**こと。既定では品切れ・絶版が
> 隠れるので、持っている本でも `count: 0` に見える（`src/rakuten.ts` の `call()` は付けている）。

### 仕組み（新しい読み出し経路は増やさない）

既にある 3 つの部品の組み合わせ。できあがるのは「普通のシリーズ 1 件と普通のマスタ巻 n 行」なので、
巻一覧・検索・リスト表示・詳細はこの仕組みを一切知らなくていい。

1. `custom_series` … 独自シリーズ（`U` + 6 桁）。取り込み後も `APPLY_LINKS_SQL` が `series` へ載せ直す。
2. `volume_master_fix` … 「足したマスタ行そのもの」。`prev_json` が NULL の行＝上流に無い巻を足したもので、
   取り込み後は `APPLY_MASTER_FIX_SQL` が載せ直す（`APPLY_LINKS_SQL` の**後**なので、シリーズ ID も含めて
   ここが最終の値）。
3. 楽天ブックスのタイトル検索（`rakutenSeriesPage`）＋ 絶版巻の保険に Yahoo の商品名検索
   （`yahooVolumeIsbns`）… 残りの巻の ISBN を集める。

`series_register_request` はそこに足した**利用者からの依頼キュー**だけ。他の申し出
（`series_report` / `series_merge_request` / `cover_suggestion`）と同じ collect-only 方針で、全体反映は
管理者の確定まで行わない。**依頼が運ぶのは ISBN 1 つだけ**で、書名・著者・出版社はサーバが自分の控え
（`live_volumes` / `book_meta`）から引く。利用者の自由入力を 1 文字も受けないので、通報・伏字の対象になる
文字列がこの表に入ることはない。

### 導線

- **利用者**: ISBN 検索の結果の末尾に「シリーズとして登録を依頼」（`public/app.js` `buildRegisterBar`）。
  出るのは ① 0 件（`isbn_miss`）② 結果が楽天ブックスの 1 冊ライブカードだけ、のどちらか。
  ボット確認（Turnstile, action `feedback`）と公開書き込みのレート制限の対象。
- **管理画面「シリーズの新規登録」**（`#series-register`, `src/seriesRegister.ts`）:
  依頼キュー →「候補を集める」で代表 ISBN から作品を同定し（楽天の ISBN 直引き → `salesWorkTitle` で
  巻数表記を外す）、その作品名＋著者で楽天のタイトル検索をページ送り、巻数の穴は Yahoo で拾う。
  同じ作品かの判定は `normTitle(salesWorkTitle(title))` の一致（取りこぼしより拾いすぎを選び、
  管理者がチェックを外す）。マスタが既に持つ巻・成年向けの巻は選べない印を付け、確定側でも弾く。
- **確定**: `custom_series` 1 行 ＋ 選んだ巻の `volume_master_fix` 行（`series_id` = U-id）を 1 バッチで書き、
  その場で `volumes` へ当てる。依頼の行は `resolution='registered'` になる。
- **取り消し**: 管理画面「マスタ行の修正」の取り消し（控えが無いので `volumes` から消える）。巻が 1 つも
  残らなくなった独自シリーズは `adminUnlinkVolumes` と同じ孤児判定（`volumes` を見る）で片付く。
- **サジェスト**: 新規登録した作品は、結合・シリーズ名の修正と同じく `series_suggest` には即時反映されない。
  入力補完にも出したいときは管理画面「概要」の「サジェスト索引 → 再構築」を押す（月次取り込みでも直る）。

### ついでに直したところ

- `src/masterFix.ts` の「ISBN で調べる」の下書き材料に **楽天ブックス（ISBN 直引き）と Yahoo の出品名**を
  足した。openBD は収録率 97% だが、この種の絶版巻ではまるごと持っていない（上の実例は `[null]`）。
  楽天は書名・著者・出版社・レーベル・発売日・表紙を構造化して持ち、楽天にも無い巻は Yahoo の出品名だけが
  書名の在りかになる。
- マスタ行の組み立て（検索キー `title_search` / `creators_norm`、`vol_sort` の導出）と
  `volume_master_fix` への upsert ＋ `volumes` への反映を `buildMasterRow` / `masterFixStmts` に括り出し、
  フォーム保存とシリーズの新規登録で共有した。

### テスト

`test/seriesRegister.test.ts`（22 件）。依頼が ISBN しか受け取らないこと（書名を送っても無視）、
再依頼が回数だけ増えること、却下した依頼が再依頼で開き直ること、マスタに既にある ISBN は依頼にならないこと、
成年向けの拒否、Turnstile の対象、候補集めの作品名の導出、確定で独自シリーズ＋マスタ巻ができること、
**月次取り込みで作り直しても `APPLY_LINKS_SQL` → `APPLY_MASTER_FIX_SQL` で元に戻ること**、
取り消しで巻が消えること、マスタが既に持つ巻の拒否、入力の検査、U-id の連番、キューの未処理／処理済み。

ローカルの `wrangler dev` で実物も通した（候補集めが楽天から全 3 巻を表紙つきで返す → 確定 → `U000004` →
ISBN 検索・書名検索・`/api/series/U000004/volumes` がどれも全 3 巻のシリーズとして返す → `/api/covers` が
3 巻とも表紙を解決 → 取り消しで巻が消え、足し直しで戻る）。

### 適用

**migration → デプロイの順**（逆だと依頼の受付と管理画面のキューが `no such table: series_register_request`
で落ちる）。ingest は不要（マスタの列は増えていない）。

1. `wrangler d1 execute DB [--env dev|r18dev|r18] --remote --file db/add-series-register.sql`
2. `npm run deploy:dev` → `deploy:prod` → `deploy:r18:dev` → `deploy:r18:prod`

| 環境 | Version ID | 適用後のブックマーク |
|---|---|---|
| dev | `28b1afc9-11c0-45cc-bc93-7479418b9a32` → `11e9f843-1d9e-4f27-8459-9291a1a7e161` | `00000108-00000006-000050fc-97630c3d037206464f14954a60f094ea` |
| 本番 | `b6a0a795-9d9e-43e3-8cab-bf599b6e05a6` | `00000122-00000000-000050fc-641f3ecb99bb00413057a5e474775c64` |
| R18 dev | `75cfbb28-09a2-4e05-88d3-cb0f85e08aee` | `0000002b-00000000-000050fc-7335f2ed64f47de085af1753e97484c0` |
| R18 本番 | `e4431b68-55f5-4cfc-8edd-713a96f1c512` | `00000034-00000000-000050fc-097557e0dde7086590dc9e38bc62fca1` |

本番 / R18 2 環境は 2026-10-06 に `my100manga-1e` が適用・デプロイした（3 環境とも `success` /
rows written 4 / num_tables 41。適用前のブックマークは本番 `0000011e-00000000-000050fc-640325d568d7403957063aa5103b1038`、
R18 dev `00000029-00000000-000050fc-cf17ab3d9ebbf341cf99f7b45b46046f`、
R18 本番 `00000032-00000000-000050fc-bdc1db1cb53bb29a11b047da4ba5e923`）。`--file` は D1 の import API を
使うので、query API（`--command`）が通る状態でも `Authentication error [code: 10000]` で落ちることがある
（1 回目が失敗・そのまま再実行で成功した）。同じデプロイに売上ランキングの寄せの改善
（`my100manga-1e`。読み / 副題・外伝での寄せ、DB 変更なし）も一緒に出ている。

dev は 2026-10-06 に並行セッション（`my100manga-4f`）が代表して適用・デプロイした（`success` / 2 queries /
rows written 4 / num_tables 41）。同じデプロイに 3 セッション分が一緒に出ている: こちらのシリーズ新規登録、
`my100manga-dc` の作者名検索（`/api/search?by=creator`、DB 変更なし）、`my100manga-4f` のランキング巻一覧からの
リスト追加（`public/draft-add.js` 新規 ＋ `series-volumes.js` / `book-detail.js` / `app.js` / `styles.css` と
ranking・sales-ranking・circulation の 3 HTML。DB 変更なし）。

dev での確認（HTTP で見られる範囲。管理画面は Cloudflare Access が要るのでブラウザから目視する）:

- `GET /api/search?q=9784758061780` → 楽天ブックスのライブカード 1 件（`series_id: "rakuten9784758061780"`）。登録前の期待どおり
- `GET /api/admin/series-register-requests` → 401（Access 未通過。`no such table` の 500 ではない ＝ 表は効いている）
- `POST /api/series-register-requests`（Turnstile トークン無し）→ 403（ルートは通っている）
