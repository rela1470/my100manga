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

冪等: ○ = 何度流しても同じ結果。× = 2 回目はエラーになる（`ALTER TABLE ... ADD COLUMN` など。エラーで
止まるだけで壊れはしないが、同じファイルの後続の文も流れない）。

### `add-indexes-2026-10.sql` の注意

- `src/listItems.ts` が新しい表 `series_supplement_isbn` を参照するので、**このファイルを流してから**
  デプロイする（逆順だとリスト表示・ランキング・公開リスト一覧が「no such table」で落ちる）。
- 中身は索引 5 本・逆引き表 1 つ・トリガ 3 つと、既存の `series_supplement` の展開（`INSERT OR IGNORE`）。
  `volumes` の部分索引（約 7 万行）と `series` の索引（約 14 万行）の作成で数秒〜十数秒かかる。
- `series` / `volumes` の索引は月次取り込みの差し替え（`scripts/ingest.mjs` の `SWAP_SQL`）でも張り直す。

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
