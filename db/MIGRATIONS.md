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
| `add-label-tag.sql` | `label_tag`（レーベルの廉価版・文庫版タグ）＋ `idx_series_label`（管理画面のレーベル一覧）。**デプロイ前に** | ○ | 2026-10-05 | 2026-10-05（**R18版は dev / 本番とも未適用**。次に R18版をデプロイする前に流すこと） |

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

### R18版（my100shunga）への適用

**未適用（dev / 本番とも）。次に `npm run deploy:r18:*` を行う前に必ず流すこと。**
R18版は同じコードで動くので、表が無いまま新しいコードを出すと検索と巻一覧が
`no such table: label_tag` で落ちる（`add-series-version.sql` のときと同じ事故）。

```bash
npx wrangler d1 time-travel info DB --env r18dev   # ブックマークを控える
npx wrangler d1 execute DB --env r18dev --remote --file db/add-label-tag.sql
npx wrangler d1 time-travel info DB --env r18
npx wrangler d1 execute DB --env r18    --remote --file db/add-label-tag.sql
```

今 R18版が動いている版は `label_tag` を参照しない旧コードなので、デプロイしない限り
この未適用で壊れることはない。

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
