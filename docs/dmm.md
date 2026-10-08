# DMM / FANZA アフィリエイト API 調査記録

2026-10-08 に DMM アフィリエイトが仮承認され、商品情報API v3 に接続できるようになった。
表紙のフォールバック源と購入リンク源として使えるかを PoC で実測した記録。**まだ Worker には
組み込んでいない**。実装するときの前提・数字・決めること をここにまとめる。

計測ツールは `scripts/dmm-probe.mjs`（`scripts/yahoo-probe.mjs` と同じ使い捨ての計測ツール）。

## 1. 認証情報

| キー（`.dev.vars`） | 値の種類 | 用途 |
|---|---|---|
| `DMM_API_ID` | API ID | すべての API 呼び出し |
| `DMM_API_AFFILIATE_ID` | `harine-990`（API 用、末尾 990〜999 しか API に通らない） | API 呼び出しの `affiliate_id` |
| `DMM_AFFILIATE_ID` | `harine-002`（広告用） | 購入リンクに付ける想定（4.3 節の未確認事項を参照） |

ローカルの `.dev.vars` には投入済み。本番 / dev / R18 の各環境へは未投入。Worker に組み込むときに
`wrangler secret put` で入れる（API ID は秘密扱い、アフィリエイト ID は vars でもよい）。

## 2. API の性質（実測で分かったこと）

エンドポイント: `https://api.dmm.com/affiliate/v3/ItemList`（`FloorList` で棚の一覧が取れる）。

使う棚:

| site | service / floor | 中身 | 使い道 |
|---|---|---|---|
| `DMM.com`（一般） | `ebook` / `comic` | DMMブックス（電子版） | 本家の表紙・購入リンク |
| `DMM.com` | `mono` / `book` | 通販 本・コミック | 本家の ISBN 照合だけ（画像は使えない） |
| `FANZA` | `ebook` / `comic` | FANZAブックス（電子版） | R18版の表紙・購入リンク |
| `FANZA` | `mono` / `book` | 通販 ブック | R18版の表紙（画像は大きいサイズに書き換えて使える） |

`site=DMM.com` だけを叩けば FANZA の商品は返らない（本家に成年向けが混ざらない）。

### 2.1 ISBN では引けない

- `keyword=<ISBN>` は 0 件。`cid` に ISBN を入れて引く方法もない（FANZA 通販の cid には ISBN を
  埋め込んだもの〔例 `208book978486653424418`〕があるが、規則が一定でなく組み立てられない）。
- キーワードは AND 一致で厳しい。**シリーズ名に巻数を足すと 0 件になる**（「ジャングルはいつもハレのちグゥ 1」→ 0 件、
  「ジャングルはいつもハレのちグゥ」→ 6 件）。キーワードはシリーズ名だけにして、返ってきた結果から巻を選ぶ。
- 1 回の呼び出しで最大 100 件（`hits=100`）。続きは `offset`。

### 2.2 通販（mono）

- 商品に `isbn` が付いているので **ISBN の完全一致で照合できる**。
- 一般（DMM.com）の画像は `ps` の 140×200 まで。大きいサイズ `pl` は `now_printing.jpg` へ 302 で、
  古い巻はそもそも画像がない。**本家の表紙には使えない**。
- **FANZA 通販は API が返さない `pl` が実在する**（URL の `ps.jpg` → `pl.jpg` 書き換えで 411×600・80〜140KB。
  6 件確かめて 6 件とも 200）。Yahoo の `/i/g/` → `/i/l/` と同じパターン。

### 2.3 電子版（ebook）

- ISBN は無い。
- **キーワード検索はシリーズごとに 1 件（最新巻）しか返らない**。`volume` はページ数で、巻数は `number`。
- 巻を特定するには 2 段階で引く:
  1. キーワード = シリーズ名で検索し、`iteminfo.series[0].name` がシリーズ名と（正規化して）一致し、
     かつ `iteminfo.author` に MADB の著者（`creators_norm`）が含まれるものを選んで series id を取る。
  2. `article=series&article_id=<series id>` でそのシリーズの全巻を取り、`number` が巻数と一致するものを選ぶ
     （巻数なしの単巻は `number=1`）。
- 画像は `imageURL.large`（`…pl.jpg`）が 375×600・50〜120KB の実書影。画像の無い巻は
  `https://ebook-assets.dmm.com/now_printing.jpeg` へ 302 する（`redirect: "manual"` で弾ける）。
- 著者一致を外すと誤マッチが増える（「サイボーグ009」で別作品の『神速の改造戦士009』等が引っかかる）。
  MADB と DMM で表記が違う著者（石森章太郎 / 石ノ森章太郎）は取りこぼすが、誤マッチよりましとして今回は厳しい方を採った。

### 2.4 返ってくるリンク

- `affiliateURL` は `https://al.dmm.com/?lurl=<商品URL>&af_id=harine-990&ch=api`（FANZA は `al.fanza.co.jp`）。
- 電子版には `tachiyomi.affiliateURL`（試し読み）もある。
- 価格は `prices.price`、レビューは `review.count` / `review.average`。

## 3. 実測結果（2026-10-08）

サンプルはローカル D1（本家）と R18 dev の D1（成年向け、読み取り専用 SELECT で 60 件抜いた）。

| サンプル | 電子版でシリーズ+巻一致 | 通販で ISBN 一致（12KB 以上） | どちらか |
|---|---|---|---|
| 本家・最古 60 巻（yahoo-probe と同じ集合） | 19（32%） | 24（40%）、うち 12KB 以上 7 | 35（58%） |
| 本家・ランダム 60 巻 | 36（60%） | 37（62%）、うち 12KB 以上 24 | 43（72%） |
| R18・成年向けランダム 60 巻（`site=FANZA`） | 23（38%） | 26（43%）、うち 12KB 以上 24（`pl` 書き換えなし） | 30（50%） |

- 一般の通販の「12KB 以上」は 140×200 の小画像がたまたま 12KB を超えただけで、表紙としては粗い。表紙に使えるのは電子版の列と考える。
- **Yahoo との比較（最古 60 巻、同日実測）**: Yahoo の実書影は 33/60（55%。10-01 の 68% より下がった）。Yahoo で埋まらない 27 件のうち **6 件を DMM の電子版が埋めた**（いじわるばあさん 2・4、幻魔大戦、やけっぱちのマリア 1、原始少年リュウ 2、バンパイヤ 3）。最古 60 巻には洋書の画集が 8 件あり、これはどこからも取れない。
- ジャングルはいつもハレのちグゥ 1（9784870252455、楽天・Yahoo の定番の取りこぼし）は電子版で 95.7KB の書影が取れた。
- R18版はいま表紙なし運用（`docs/r18.md`）なので、成年向けの半分に表紙が付くのは大きい。通販 ISBN 一致は `pl` 書き換えで 411×600 になるので、R18 は **通販（ISBN 確定）→ 電子版** の順が良い。

再計測:

```sh
node scripts/dmm-probe.mjs --from-volumes-old 60
node scripts/dmm-probe.mjs --random 60
# R18: ローカル D1 に成年向けが無いので、R18 の D1 から SELECT した行を JSON で渡す
node scripts/dmm-probe.mjs --fanza --from-json adult60.json
```

API は 1 秒に 1 回の間隔で叩いて 429 / エラーは 0 件だった。1 巻あたり 3〜4 回呼ぶ（通販 1、電子版の検索 1、シリーズ一覧 1〜）。

## 4. 実装するときの方針案

### 4.1 表紙

- **版違いが混ざる**。電子版はカラー版・全集・分冊版などで、紙の版と表紙が違うことがある。分冊版は巻数もずれる
  （『おぼっちゃまくん 3（下）』が `number=6`）。
- このため本家では**自動で表紙を差し替えず `cover_suggestion` に積む**（楽天市場の非信頼店と同じ扱い。
  `suggest_count=0` で管理画面に「自動」と出る）。シリーズ名が完全一致、著者一致、版の注記（「カラー版」「分冊版」
  「全集」「【タテヨミ】」等）を含まないものに限れば自動適用してもよいかは、件数を見て決める。
- 位置づけは Yahoo（Tier2）の後ろ。`covers.ts resolveCovers` は 1 巻あたり 3 回以上呼ぶので budget を食う。
  resolveCovers に入れず、`candidates.ts` の補正ピッカー候補と管理画面向けの別バッチに入れる方が安全かもしれない。
- レート制限は `src/ratelimiter.ts` の `pacedFetchJson(env, "dmm", …)` で、Yahoo（`"yahoo"`）と同じく専用のレーンを切る。
- 画像の配信元は `ebook-assets.dmm.com` / `pics.dmm.com`（FANZA は `.co.jp`）。CSP の `img-src` は `https:` 全許可（`src/util.ts`）なので変更不要。即適用する経路を作るなら `src/covers.ts isTrustedCoverUrl` に足す。
- シリーズ id は巻ごとに引き直すと無駄なので、`series.id → DMM series id` をキャッシュする（D1 の表か KV）。

### 4.2 R18版

- R18版は外部ストアを全部止めて DMM だけにする方針（`docs/r18.md` 決定事項）。`src/site.ts` の `commerce: false` を
  戻すのではなく、DMM 用の経路を足す。
- 表紙は FANZA 通販（ISBN 一致 → `ps` を `pl` に書き換え）→ FANZA 電子版（シリーズ+巻）の順。通販は ISBN が確定するので自動適用してよい。

### 4.3 購入リンク

- 価値は表紙より大きい可能性がある（本家ランダム 60 巻の 60% に DMMブックスの巻ページがある）。
- `public/affiliate.js buildBuyLinks` に DMM を足す。巻ページの URL は API でしか分からないので、表紙と同じ照合結果を
  保存してリンクにも使う（URL を組み立てて作る方式は取れない）。
- **未確認**:
  - API が返す `affiliateURL` は API 用 ID `harine-990` 入り。これで成果が付くのか、広告用の `harine-002` に
    `af_id` を差し替えるべきかを、アフィリエイト管理画面か規約で確かめる。
  - DMM Webサービスの規約が求めるクレジット表記（「Powered by DMM.com Webサービス」/ FANZA 版）の要否と置き場所。
  - 仮承認から本承認までの条件（成果件数など）。仮承認のまま使っていてよい範囲。
  - 本家に DMM のリンクを出すとき、DMM.com 側の商品ページから FANZA へ導線があることが AdSense のポリシーに触れないか
    （`docs/r18.md` の住み分けの論点と同じ）。

## 5. 関連

- 表紙フォールバック全体（楽天 → Yahoo → 楽天市場）の経緯はメモリ `cover-source-dmm-todo`、コードは `src/covers.ts` / `src/yahoo.ts` / `src/ichiba.ts`。
- R18版の外部ストア方針は `docs/r18.md` の「表紙・アフィリエイト」と 5.5 節。
