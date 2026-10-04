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
| `add-volume-subtitle.sql` | `volumes.subtitle`（巻の副題。同じ巻番号の別作品が 1 冊に畳まれるのを直す。中身は取り込み直しで埋まる）。**デプロイ前に** | × | 未適用 | 未適用 |

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

### R18版（my100shunga）への適用記録

**dev（2026-10-04）**

- 適用前の Time Travel ブックマーク: `00000005-00000000-000050fa-c61c73670ce90c432942d5f4e5dba261`（取り込み前は空の DB）
- `db/add-is-adult.sql` を適用 → `npm run ingest:remote:r18:dev`（MADB release 1.2.20）。所要 4 分ほど。
- 結果: `series` 139,130 行（うち `is_adult=1` が 5,586）/ `volumes` 356,644 行（うち 7,624）/ `adult_volumes` 0 行。
- 確認: `/api/search?q=ONE PIECE` が 0 件、`&all=1` で 30 件。成年向けのタイトルは既定で出る。

**本番（my100shunga）**: 未適用。dev で通し確認してから同じ順で流す
（`db/add-is-adult.sql` → `npm run ingest:remote:r18:prod`）。

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
