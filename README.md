# My 100 Manga

「自分を構成する100の漫画」を選んでカード化し、URLで共有できるサイト。

- スタック: Cloudflare Workers（Static Assets） + D1（SQLite）
- 検索: [メディア芸術データベース（MADB）](https://mediaarts-db.artmuseums.go.jp/) のマンガ単行本 LOD を取り込んだローカルマスタ（`series` / `volumes`）を参照。シリーズ→巻→ISBN が相関済みなので、検索結果からシリーズを開いて全巻を一括追加できる
- 表紙: ISBN 一致で解決（楽天ブックス ISBN一致 → Google Books の順。楽天優先）。どちらにも無い場合はグレーの No Image プレースホルダ
- 編集画面の「表紙がない本を指定」から、No Image の巻に正しい書影を手動指定できる
- アカウント不要。公開すると共有URL（`/l/:slug`）と編集用URL（`/?edit=:slug&t=:token`）が発行される

## セットアップ

```bash
npm install
```

### 設定ファイルを作る

`wrangler.jsonc` は個人設定（ドメイン・D1 ID 等）を含むため **gitignore 済み**。公開しているのはテンプレートの `wrangler.jsonc.sample` なので、コピーして自分の値に書き換える。

```bash
cp wrangler.jsonc.sample wrangler.jsonc
```

書き換える箇所: `RAKUTEN_REFERER` と `routes` の `pattern`（`example.com` → 自分のドメイン）、D1 の `database_id`（下記）。アフィリ ID / `ACCESS_*` / `ADMIN_EMAILS` / 楽天 API キーは vars ではなく `wrangler secret`（下記各節）で注入する。

### D1 データベース作成

本番と開発で D1 を分ける。2つ作成する。

```bash
npx wrangler d1 create my100manga        # 本番
npx wrangler d1 create my100manga-dev    # 開発
```

出力された `database_id` を `wrangler.jsonc` に貼り付ける。

- 本番の ID → トップレベルの `d1_databases[0].database_id`（`REPLACE_WITH_PROD_DATABASE_ID`）
- 開発の ID → `env.dev.d1_databases[0].database_id`（`REPLACE_WITH_DEV_DATABASE_ID`）

### スキーマ適用

```bash
# ローカル
npm run db:init:local
# 本番
npm run db:init:remote
# 開発（dev 環境）
npm run db:init:remote:dev
```

### MADB マスタ取り込み

`series` / `volumes` は MADB の LOD ダンプから作る。

```bash
# ローカル D1 へ（初回・動作確認用）
npm run ingest:local
# 本番 D1 へ
npm run ingest:remote
# 開発 D1 へ（dev 環境）
npm run ingest:remote:dev
```

`scripts/ingest.mjs` は [mediaarts-db/dataset](https://github.com/mediaarts-db/dataset) の最新リリースから
マンガ単行本（`metadata101`）とシリーズ（`metadata104`）の JSON-LD を取得し、
ストリームパースして `INSERT OR REPLACE` の SQL に変換、`wrangler d1 execute` で流し込む。

投入は **blue-green 方式**でサイトを止めない。シャドウテーブル `series_new` / `volumes_new`
に全件ロードし終えてから、最後に一回の `ALTER TABLE ... RENAME`（瞬時のメタ操作）で
現行テーブルと差し替える。ロード中は本番の検索・シリーズ表示は旧マスタをそのまま参照し続け、
空や中途半端な状態を一切見せない。差し替え後に正規のインデックスを張り直し、`series_supplement`
キャッシュからは新マスタに入った巻（ISBN 一致、または同シリーズの同じ巻番号）だけを取り除く。
新マスタにまだ無い巻は残すので、取り込み直後に最新巻が巻一覧から消えることはない。

主なフラグ:

| フラグ | 説明 |
|---|---|
| `--local` / `--remote` | 投入先 D1（既定 `--local`） |
| `--tag <v>` | MADB リリースタグ指定（既定は最新） |
| `--skip-download --work <dir>` | 既にダウンロード済みのファイルを再利用 |
| `--limit <n>` | 先頭 n 件だけ（スモークテスト）。`series_new` / `volumes_new` への投入までで止め、本番テーブルとの差し替えはしない |
| `--no-apply` | SQL 生成のみ（wrangler を実行しない） |

> ⚠️ **D1 の書き込み上限に注意**。初回シードは概算で **series 約 14 万行 + volumes 約 36 万行 ≒ 50 万 rows written**。
> D1 無料枠は **100,000 rows written / 日** なので初回シードは無料枠では 1 日で完了しない。
> Workers 有料プラン（$5/月、50M rows written/日）が実質必須。
> 月次更新も全行を書き直すため毎回同規模の書き込みが発生する（blue-green でも書き込み量は変わらない）。
> また差し替え前はシャドウと現行の両方が同時に存在するため、ロード中だけ当該テーブルのストレージが一時的に約 2 倍になる。

### シリーズ結合データの投入

MADB が同じ作品を複数の C-id に分けて持っている場合に、管理者が確定した結合（`series_merge`）は
`db/series-merge-data.sql` に保存してある。マスタを取り込んだあとに流すと、結合済みの状態から始められる
（`db/add-series-merge.sql` のテーブルが前提。upsert なので何度流しても安全）。

```bash
npx wrangler d1 execute DB --local --file db/series-merge-data.sql            # ローカル
npx wrangler d1 execute DB --remote --file db/series-merge-data.sql           # 本番
npx wrangler d1 execute DB --env dev --remote --file db/series-merge-data.sql # 開発
```

結合はローカルの管理画面でまとめて判断し、`node scripts/dump-series-merge.mjs` でローカル D1 から
このファイルを作り直す。ローカルで解除した結合は upsert では本番から消えないので、解除は本番の管理画面で行う。

## 手動取り込み（GitHub Actions）

`.github/workflows/ingest.yml` を Actions の「Run workflow」ボタンから手動実行すると、
`node scripts/ingest.mjs --remote` を実行して本番 D1 のマスタを最新の MADB リリースへ更新する（タグ指定可）。
MADB はおよそ月次で新リリースを出すので、リリース後に手動で回す。
リポジトリの Secrets に以下を設定しておくこと:

- `CLOUDFLARE_API_TOKEN` — D1 編集権限を持つ API トークン
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare アカウント ID

## 楽天ブックス API（表紙フォールバック）

Google Books で書影が取れない ISBN を、楽天ブックス書籍検索 API（新 OpenAPI ゲートウェイ `openapi.rakuten.co.jp`）で補完する。未設定でも動作するが、その場合は Google のみのカバレッジになる。

- 楽天ウェブサービスでアプリを登録し、`applicationId`（UUID 形式）と `accessKey`（`pk_...`）を発行する。
- アプリのサイトURL（Referer）には本番ドメイン（例 `https://example.com/`）を登録する。**localhost は登録不可**。
- `applicationId` / `accessKey` は**シークレット**。コードやコミットに含めない。
  - ローカル: `.dev.vars` に `RAKUTEN_APP_ID=` / `RAKUTEN_ACCESS_KEY=` を書く（gitignore 済み）。
  - 本番: `npx wrangler secret put RAKUTEN_APP_ID` と `npx wrangler secret put RAKUTEN_ACCESS_KEY`。
  - 開発: 同じコマンドに `--env dev` を付ける（`npx wrangler secret put RAKUTEN_APP_ID --env dev` 等）。シークレットは Worker 単位なので本番・開発それぞれに設定が必要。
- `RAKUTEN_REFERER`（登録したサイトURL）は秘密ではないため `wrangler.jsonc` の `vars` に置く（本番 `https://example.com/`、dev 環境は `https://dev.example.com/`）。ゲートウェイは Referer / Sec-Fetch-* 等のブラウザ相当ヘッダを要求するため `src/rakuten.ts` が付与する。
  - ⚠️ dev で書影を楽天から取るには、Rakuten アプリのサイトURL（Referer）に `https://dev.example.com/` も登録しておくこと。未登録なら dev では楽天が弾かれ Google Books のみのカバレッジになる（動作自体は継続する）。

## アフィリエイト（購入リンク）

閲覧ページ（`/l/:slug`）の作品詳細モーダルに **Amazon・楽天・Yahoo!ショッピング・メルカリの購入リンク**を出す。紙の本は絶版が多いので、**紙版と電子書籍版（Kindle / 楽天Kobo）を常に併記**する（電子版は絶版でも入手できることが多い）。

- リンク生成は `public/affiliate.js`（クライアント側）。ISBN があれば Amazon は ISBN-10（=ASIN）に変換して商品ページ `/dp/<isbn10>` へ直リンク、楽天ブックスは ISBN 検索。ISBN が無い／979始まり（ISBN-10 が無い）ときはタイトル検索にフォールバックする。電子版は紙の ISBN が使えないため常にタイトル検索（Kindle=`i=digital-text`、楽天Kobo=`g=101`）。
- アフィリエイト ID は Worker が `window.__AFF__` として閲覧ページに注入する（`src/index.ts` `renderViewPage`）。
- ステマ規制対応として、フッタとモーダルにアフィリエイト利用の明示（ディスクロージャ）を入れている。外部リンクには `rel="sponsored nofollow noopener"` を付与。

### 設定（`AMAZON_ASSOCIATE_TAG` / `RAKUTEN_AFFILIATE_ID` / `MERCARI_AFID` / `YAHOO_VC_SID` / `YAHOO_VC_PID`）

アフィリエイト ID はリンクに露出する公開値だが、**clone した人が誤って別人のタグ付きリンクを配信しないよう** `wrangler.jsonc` には載せず、デプロイ先ごとに **`wrangler secret` で注入する**。**未設定でもリンクは動作する**（各ストアの正しいページを開くが、紹介タグは付かない＝報酬は発生しない）。

- `AMAZON_ASSOCIATE_TAG` — Amazon アソシエイトのトラッキング ID（例 `xxxxxxxx-22`）。
- `RAKUTEN_AFFILIATE_ID` — 楽天アフィリエイト ID（`hb.afl.rakuten.co.jp/hgc/<ID>/` の `<ID>`。`g00xxxxx.xxxxxxxx.g00xxxxx.xxxxxxxx` 形式）。
- `MERCARI_AFID` — メルカリのアフィリエイト ID。
- `YAHOO_VC_SID` / `YAHOO_VC_PID` — バリューコマースで発行した Yahoo!ショッピングの自由テキストリンク（`ck.jp.ap.valuecommerce.com/servlet/referral?sid=…&pid=…`）の `sid` / `pid`。Yahoo!ショッピングの ISBN 検索ページを `vc_url=` で包んだリンクになる（両方そろわないとタグ無し）。

```bash
# 本番
npx wrangler secret put AMAZON_ASSOCIATE_TAG
npx wrangler secret put RAKUTEN_AFFILIATE_ID
npx wrangler secret put MERCARI_AFID
npx wrangler secret put YAHOO_VC_SID
npx wrangler secret put YAHOO_VC_PID
# 開発は --env dev を付ける
npx wrangler secret put AMAZON_ASSOCIATE_TAG --env dev
```

ローカル `wrangler dev` で試すときは `.dev.vars`（gitignore 済み）に `AMAZON_ASSOCIATE_TAG=` 等を書く。

## admin 認証（Cloudflare Access）

`/admin`・`/api/admin/*` は **Cloudflare Access（Zero Trust）** で保護する。ログイン（Google / メール OTP / MFA）は Cloudflare が処理し、Worker は発行済み JWT を `src/adminAuth.ts` の `requireAdmin()` で再検証する多重防御。`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` 未設定なら **fail-closed で 403**（誤って素通りしない）。

### 承認するアカウント

管理者のメールアドレスのみ。Access ポリシーの Include→Emails と、Worker 側 `ADMIN_EMAILS` secret の両方に設定する。

### セットアップ

本番・開発を**1つの Access アプリ**でまとめて保護する構成（team domain は `your-team.cloudflareaccess.com`）。

1. **Access アプリを作成**: Zero Trust ダッシュボード → Access → Applications → Add an application → Self-hosted。
   - Application の対象に管理パスを登録する（`example.com/admin`・`example.com/api/admin`・`dev.example.com/admin`・`dev.example.com/api/admin` を同一アプリにまとめる）。
   - Identity provider は Google もしくは One-time PIN（メール OTP）。
   - Policy: **Allow** / Include → **Emails** → 管理者のメールアドレス。
2. **値を控えて secret で注入**（個人固有値なので公開リポの `wrangler.jsonc` には載せない）:
   - チームドメイン（`xxx.cloudflareaccess.com`、スキームなし）→ `ACCESS_TEAM_DOMAIN`。
   - アプリの **Application Audience (AUD) タグ**（アプリの Overview / Settings で確認）→ `ACCESS_AUD`。
   - 許可メール（カンマ区切り）→ `ADMIN_EMAILS`。
   ```bash
   npx wrangler secret put ACCESS_TEAM_DOMAIN
   npx wrangler secret put ACCESS_AUD
   npx wrangler secret put ADMIN_EMAILS
   # 開発（dev 環境）も同様に --env dev を付けて設定する
   npx wrangler secret put ACCESS_TEAM_DOMAIN --env dev
   ```
   1アプリ構成なので本番・dev で同じ値を入れる。**未設定なら admin は fail-closed で 403**。
3. `npm run deploy` / `npm run deploy:dev` で反映。

### workers.dev バイパス封鎖

`wrangler.jsonc` の `workers_dev: false` で `*.workers.dev` 経路を無効化している。Access は独自ドメイン上のアプリなので、workers.dev URL を残すと Access を通らない抜け道になるため。

### ローカル開発時

ローカル `wrangler dev` には Access が無いので、`.dev.vars` に `ADMIN_DEV_BYPASS=true` を置いて検証をスキップする（`.dev.vars` は gitignore 済み・本番 vars には入れない）。これで `http://localhost:8787/admin` が開ける。

## レート制限（濫用対策）

アカウント不要の公開書き込み（リスト作成・更新、通報、修正提案、表紙解決など）への連投・自動化を抑えるため、Cloudflare の [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) で IP 単位のレート制限をかける（`src/ratelimit.ts`）。ルート照合の前に `src/index.ts` でゲートし、超過時は `429`（`retry-after: 60`）を返す。

- `RL_WRITE` — 書き込み系 API 全般（`/api/admin/*` は Cloudflare Access 済みなので対象外）。
- `RL_COVERS` — 外部 API（楽天/Google Books）を叩く表紙解決（`POST /api/covers`）用に別枠。
- 制限値は `wrangler.jsonc` の `ratelimits`（トップレベルと `env.dev` の両方。binding は非継承のため両方に必要）で調整する。`period` は 10 か 60 秒のみ、カウントは per-colo。
- **binding 未設定なら fail-open**（そのまま通す）。ローカル `wrangler dev` や secret 未注入でも機能自体は止まらない。特別なセットアップ（secret 等）は不要で、`wrangler.jsonc.sample` に既定値入りで含まれている。

## ローカル開発

```bash
npm run dev
```

`http://localhost:8787/` でエディタが開く。

- `GET /api/search?q=<タイトル>` — シリーズ検索（ローカル MADB マスタ）
- `GET /api/series/:id/volumes` — シリーズの全巻一覧（巻順）
- `POST /api/lists` — リスト作成 `{owner_name, items[], slug?}` → `{slug, edit_token}`。`slug` は任意（英数字・ハイフン・アンダースコアのみ、15文字以内）。未指定ならランダム10文字。既存と衝突すると `409`
- `GET /api/lists/:slug` — リスト取得
- `PUT /api/lists/:slug` — 更新（`edit_token` 必須）
- `GET /api/cover-candidates?isbn=&title=` — 表紙ピッカー用。Google / 楽天ISBN一致 / 楽天タイトル検索の候補を返す
- `GET /api/ranking` — 本が追加されている回数ランキング。巻(ISBN)単位・選んだ人数(`COUNT(DISTINCT slug)`)で集計。`{windows:{cumulative,d30,d7,d24}, computed_at}` を返す（各窓 top100）。`src/ranking.ts`。閲覧ページは `/ranking`（`public/ranking.html`）
- `GET /api/sales-ranking` — 売上ランキング。楽天ブックスのコミック「売れている順」（書籍検索API `sort=sales`）の上位 300 件を毎日 Cron（05:00 JST）で `sales_snapshot` に記録し、作品単位で集計する。日ごとの順位をポイント（1 位 = 300pt）にし、同じ日の同じ作品は最高順位だけを数える。`{windows:{day,d7,d30,year}, latest_day, first_day, year, computed_at}` を返す（各窓 top100）。作品名は楽天の書名から巻数・版の表記を除いたもので、シリーズ / まとまり（G-id）へ書名で寄せて巻一覧へのリンクにする（寄せ先が無い作品はトップの検索 `/?q=<作品名>` へのリンク）。`src/salesRanking.ts`。閲覧ページは `/sales-ranking`（`public/sales-ranking.html`）
- `GET /api/admin/sales-ranking` — 管理画面「売上ランキング」用。直近 14 日の取得件数、集計開始日、最後に集計した時刻、窓ごとのリンク付き件数、巻一覧へのリンクが付かなかった作品（どれかの窓の上位に入っているもの）を返す
- `POST /api/admin/sales-ranking/snapshot` — 売上ランキングの今日の分を Cron を待たずに取得・集計する。手動分はその日の 05:00 の Cron が置き換え、Cron が取得済みの日（`meta.sales_snapshot_cron_day`）は何もしない（`skipped: "cron_done"`）。毎日同じ時刻の順位で揃えるため。`?recompute=1` は取得せず、作品名の付け直しと集計だけ行う（作品名・寄せ先の判定を直した後に使う）
- `GET /l/:slug` — 閲覧ページ（OGP メタを Worker が埋め込み）

## デプロイ

本番と開発の2環境を `wrangler.jsonc` の environments で管理する。

| 環境 | Worker 名 | ドメイン | D1 | デプロイ |
|---|---|---|---|---|
| 本番 | `my100manga` | `example.com` | `my100manga` | `npm run deploy` |
| 開発 | `my100manga-dev` | `dev.example.com` | `my100manga-dev` | `npm run deploy:dev` |

### 前提（カスタムドメイン）

`routes` の `custom_domain: true` で独自ドメインを割り当てる。事前に **`example.com` ゾーンを同じ Cloudflare アカウントに追加し、ネームサーバを Cloudflare に向けてアクティブ**にしておくこと。`example.com` / `dev.example.com` の DNS レコードは初回デプロイ時に wrangler が自動作成する。ゾーンが未登録だとデプロイ時に custom domain の割当で失敗する。

### 手順

```bash
npx wrangler login          # 初回のみ

# 本番
npm run db:init:remote      # スキーマ
npm run ingest:remote       # MADB マスタ投入
npm run deploy              # example.com へ公開

# 開発
npm run db:init:remote:dev
npm run ingest:remote:dev
npm run deploy:dev          # dev.example.com へ公開
```

ランキング (`/api/ranking`) を既存データにも効かせる場合は、スキーマ適用後に一度だけ
`list_item_events` を seed する（既存リストの現在の内容を `created_at` で追加イベント化する。
冪等なので再実行しても二重に入らない）:

```bash
wrangler d1 execute DB --remote --file db/backfill-events.sql          # 本番
wrangler d1 execute DB --env dev --remote --file db/backfill-events.sql # 開発
```

以降の作成・更新公開は `src/lists.ts` が自動でイベントを追記するので、backfill は初回のみ。

売上ランキング (`/api/sales-ranking`) は `sales_snapshot` テーブルが前提。既存 DB には一度だけ流す:

```bash
wrangler d1 execute DB --remote --file db/add-sales-snapshot.sql          # 本番
wrangler d1 execute DB --env dev --remote --file db/add-sales-snapshot.sql # 開発
```

データは Cron（`wrangler.jsonc` の `triggers`）が毎日貯める。初日分をすぐ入れたいときは管理者で
`POST /api/admin/sales-ranking/snapshot` を叩く。

検索で記号・全角半角を無視する（「ぼっちざろっく」で「ぼっち・ざ・ろっく！」が出る）ための検索専用列
`series.name_search` / `volumes.title_search` は、既存 DB に一度だけ列を足してから取り込み直すと埋まる
（埋まるまでは従来の照合のまま動く）:

```bash
wrangler d1 execute DB --remote --file db/add-name-search.sql          # 本番
wrangler d1 execute DB --env dev --remote --file db/add-name-search.sql # 開発
npm run ingest:remote        # 本番（列を埋めるには取り込み直しが必要）
```

検索カード・シリーズ表示の作者を役割付きで全員出す（「原作：丸戸史明、作画：守姫武士」）ための表示用列
`series.creators` / `volumes.creators` も同様。Worker が SELECT するので**デプロイ前に**列を足し、取り込み直すと
埋まる（埋まるまでは従来の代表作者 `creator` を表示）:

```bash
wrangler d1 execute DB --remote --file db/add-creators.sql          # 本番
wrangler d1 execute DB --env dev --remote --file db/add-creators.sql # 開発
npm run ingest:remote        # 本番（列を埋めるには取り込み直しが必要）
```

公開前の索引見直し（`db/add-indexes-2026-10.sql`: 公開リスト一覧・巻一覧・リスト表示の全表スキャン解消と、
ライブ補完の ISBN 逆引き表 `series_supplement_isbn`）。Worker が逆引き表を引くので**デプロイ前に**流す（冪等）:

```bash
wrangler d1 execute DB --remote --file db/add-indexes-2026-10.sql          # 本番
wrangler d1 execute DB --env dev --remote --file db/add-indexes-2026-10.sql # 開発
```

どの migration をどの環境にいつ流したかは [`db/MIGRATIONS.md`](db/MIGRATIONS.md) の台帳で管理する。リモートに
流す前・ingest の前には、同じファイルの「バックアップ」の手順（Time Travel のブックマークを控える・
`wrangler d1 export`）を行う。

MADB の取り込みでは成年コミック（MADB の `schema:contentRating` が「成年コミック」等の巻）を除外し、
成年向けの巻しか無いシリーズも入れない。ライブ検索・補完（`src/madbLive.ts`）も同じ条件で落とす。判定に
書名の文字列照合を使わない理由は `src/adult.ts` に書いてある。

シークレット（楽天API）は環境ごとに設定する（下記参照）。

## データモデル（D1）

- `lists` — `slug`(PK), `edit_token`, `owner_name`, `items_json`, `created_at`, `updated_at`
- `series` — MADB シリーズ。`id`(PK, C-id), `name`, `name_norm`, `name_kana`, `name_kana_norm`, `name_search`(検索専用。全角半角を寄せて記号を落とした書名、`src/util.ts` `searchKey`), `creator`(代表作者), `creators`(表示用。役割付き全作者), `creators_norm`(検索専用), `publisher`, `label`, `num_items`
- `volumes` — MADB 単行本。`isbn`(PK), `series_id`, `volume_number`, `vol_sort`, `title`, `title_search`(検索専用、`name_search` と同じ変換), `creator`, `creators`, `creators_norm`, `publisher`, `label`, `pubdate`
- `covers` — 書影解決結果のキャッシュ。`isbn`(PK), `cover_url`(解決した書影URL。`""` は「どこにも無し」), `checked_at`。詳細は下記。
- `list_item_events` — 巻の「追加」イベントログ（ランキングの元データ）。`id`(PK), `slug`, `isbn`, `added_at`。表示名・著者・表紙は持たず、ランキング計算時に ISBN から引く。公開時に新しく加わった巻を追記（作成は全 item、更新は旧→新差分の新規 isbn のみ）。ランキングは `COUNT(DISTINCT slug)` で人数を数え `added_at` で窓を切る。リスト削除時は `slug` 単位で掃除。集計結果は `meta` に `book_ranking_json` / `book_ranking_at` として 10 分 TTL キャッシュ。`src/ranking.ts`。
- `sales_snapshot` — 売上ランキングの日次スナップショット。`(day, rank)`(PK), `isbn`, `title`(楽天の書名), `work` / `work_norm`(巻数・版の表記を除いた作品名と集計キー), `author`, `publisher`, `sales_date`, `cover_url`。1 日 300 行。集計結果は `meta` の `sales_ranking_json` に保存し、Cron のたびに作り直す。`src/salesRanking.ts`。

- `live_volumes` — 検索画面の「最新DBから取得」で取れた、マスタに無い巻。`isbn`(PK), `title`, `volume_number`, `author`, `fetched_at`。サーバが MADB から取得した値だけを保存し、リストの本のタイトル解決に使う。

`items_json` は `{position,isbn,comment,spoiler}` の配列（100件、ISBN は ISBN13 必須）。表示名・著者・表紙は保存せず、読み出し時に ISBN から 1 クエリでサイト共通データを引く（`src/listItems.ts` `resolveBooks`）。タイトルはマスタ → 手動補正 → ライブ補完 → `live_volumes` の順に探し、管理者のシリーズ名/巻タイトル修正と巻数表記の統一を反映する。表紙は `covers`（ISBN ごとに 1 つ）で、その ISBN に無ければ同じ巻の別 ISBN の表紙を使う。ランキング・公開ページ・管理画面も同じ関数で引く。既存 DB は `db/migrate-list-data-by-isbn.sql` で移行する。

## 既知の制約 / TODO

- **新刊の欠落（シリーズ検索）**: シリーズ検索（`/api/search`）は MADB ダンプ時点のマスタのみを参照する。ダンプに無い新シリーズは出てこない（NDL 等での新シリーズ補完は **未実装（TODO）**）。
- **巻の欠落を MADB ライブ SPARQL で補完**: MADB は新しい単行本ほど `schema:isPartOf`（巻→シリーズ）が欠けており、月次ダンプでは未リンク（例: ONE PIECE は正典シリーズ C268196 が巻100までで、巻101+ が別扱い）。`/api/series/:id/volumes` はダンプの巻に加えて、MADB ライブ SPARQL エンドポイント（`https://mediaarts-db.artmuseums.go.jp/sparql`）へ問い合わせ、ダンプの最大巻より後の未収録巻だけを追記する（`src/madbLive.ts`）。同名別エディションへの誤割当を避けるため補完は厳格に絞る:
  1. **タイトル完全一致＋著者一致**（ロール接頭辞 `[著]` は ingest と同じ正規化で除去）。
  2. **対象シリーズが単一の標準巻番号形式**（`巻N` または `N`。アーク別「N (◯◯編)」・総集編・混在は補完対象外）で、**追記する巻もその形式に一致**するものだけ。
  3. **同名＋同著者で同形式を使う別シリーズが無い**こと（新装版と原作が両方 `巻N` 等だと巻を奪い合うため、曖昧なら補完しない）。
  結果（"[]" 含む）は `series_supplement` テーブルに月次キャッシュし、SPARQL 問い合わせは各シリーズ初回オープン時のみ。検索カードの「全N巻」（`/api/search`）もキャッシュ済み補完数を加算するので、一度開いたシリーズは検索側と開いた側の巻数が一致する（未オープンのシリーズは初回オープンで揃う）。ライブ側にも欠番はある（ONE PIECE 巻110 は SPARQL にも無い）。
- **欠番の手動補正（ダンプにもライブにも無い巻）**: MADB のダンプ・ライブ双方に単行本エントリ自体が無い巻（例: ONE PIECE 巻110）は自動補完できない。巻一覧はこの種の**内部欠番**（支配的な標準巻番号形式 `巻N`/`N` の最小〜最大の間で抜けている番号）を検出して「＋110巻を追加」の導線を出す（`public/app.js` `detectGaps`）。少数の非標準ラベル（例: ゴルゴ13 が `1`〜`202` に混ぜて持つ `50巻`・`第100巻`・`volume. 155`）は**数値だけ抽出して"存在"として扱う**ので、それらは欠番として誤検出しない（信頼できる範囲は標準形式の巻番号からのみ取り、`2020年版` のような値がレンジを広げて偽の欠番を作ることは無い）。標準形式が `巻N`/`N` で混在している、または標準形式の巻番号が2件未満のシリーズは判定を諦める。押すとタイトル＋巻番号で楽天を検索し（`GET /api/volume-candidates`）、実在の書影付き候補から選べる。選んだ巻は `POST /api/series/:id/corrections` で `series_correction` テーブルに保存され、以降 `/api/series/:id/volumes` がマージして返す（＝全員向けのキャッシュ）。補正は特定の C-id に紐づくため SPARQL 補完のような同名別シリーズの曖昧性は無い。アカウント無しの公開書き込みなので軽い悪用対策として、**受け取るのは isbn と volume_number のみ**（タイトル・著者はシリーズ行から、書影はサーバ側で再解決し、実書影が取れない ISBN は拒否）、巻番号は標準形式（`巻N`/`N`）のみ、シリーズあたり上限 20 件（`src/corrections.ts` の `MAX_CORRECTIONS` で調整）。検索カードの「全N巻」にも補正件数を加算する。
- **書影（ISBN 一致・楽天優先）**: `src/covers.ts` / `src/rakuten.ts` が以下の順で書影を解決し、`covers` テーブルにキャッシュする。
  1. **楽天ブックス ISBN一致**（`isbn=` 検索）。旧刊の多くは品切れ/絶版で、楽天 API は既定でそれらを除外する（サイトには表示されるのに API では 0 件になる）。書影さえ取れればよいので全リクエストに `outOfStockFlag=1` を付け、品切れ・絶版も含めて取得する。楽天ゲートウェイは ~1 req/s で 429 を返すため `RAKUTEN_CONCURRENCY=4` の小バッチ＋1回リトライで叩く。書影URLは `covers` にキャッシュするので、楽天へのプローブは各 ISBN 初回のみ（月次で再チェック）。
  2. **Google Books**（`books.google.com/books/content?vid=ISBN...`、APIキー不要）。楽天で取れなかった ISBN を補完する。書影が無い ISBN でもグレーの「画像なし」プレースホルダ（約10KB）を返すため、サーバ側で書影バイト数を検査する（実書影は約12KB以上）。
  - タイトル検索による救済は行わない（同名の別シリーズが複数あり、巻番号一致で別作品の書影を割り当てる事故があったため。ISBN 厳密一致のみで解決する）。
  - 同一巻が複数 ISBN（通常版/重版/特装版）で登録されている場合、**書影のある ISBN を優先採用**する（`firstCover`）。
  - どの経路でも書影が無い巻は自前の No Image を出す（グレーの偽書影を出さない）。
- **表紙はサイト共通（ISBN ごとに 1 つ）**: リストは表紙を保存せず、表示時に `covers` から引く。編集画面で表紙を選ぶと、その ISBN に表紙がまだ無ければ（楽天/Yahoo!/Google の画像に限り）即座に全体へ反映し、既に表紙がある ISBN は上書きせず管理者への提案に回す（`COVER_SUGGESTIONS_ENABLED` 有効時のみ。`src/corrections.ts` `suggestCover`）。管理者が表紙の通報を伏字にすると、その画像は全 ISBN から消える。
- 著者名: MADB の `schema:creator` は先頭が編集ロール（例 `[編]ホーム社`）のことがあるため、ingest 側で著者ロール（著/作画/原作 等）を優先抽出している（`pickCreator`）。同様にカナ読みは複数の ja-hrkt から全て取り込む（`kanaReadings`）。

## 今後（MVP外）

- カード画像書き出し、R2 での表紙キャッシュ、独自ドメイン（本が追加された回数ランキング `/ranking` は実装済み）
- **アダルト（成人向け）漫画ゾーンの分離**: 一般向けサイトは Amazon アソシエイト・楽天・メルカリのアフィリエイト規約でアダルトコンテンツを含むサイトが禁止されているため、成人向けは扱わない（当面この本体では**アダルト禁止**を明記して運用）。将来やるなら**完全に別の独自ドメイン**（例: `example-r18.com`。同一 apex のサブドメイン `adult.example.com` はグレーで、やる場合も一般ゾーンとの相互リンク厳禁が絶対条件）に、年齢確認ゲート＋**DMM/FANZA アフィリエイトのみ**で切り出す。一般向けのアフィリンク（Amazon/楽天/メルカリ）はアダルトゾーンに一切出さない。UGC なので一般ゾーンに成人向け作品が紛れ込むと一般アフィリの規約違反になりうる点にも注意（成人向け作品の判定・排除が必要）。
