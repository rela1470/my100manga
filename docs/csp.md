# CSP（Content-Security-Policy）

実装は `src/util.ts`。全レスポンスが `withSecurityHeaders` を通る（`src/index.ts` の
`export default` で包んでいる）。

## 2 段構え

| 対象 | 付ける CSP |
|---|---|
| HTML ページ | `CSP_DOCUMENT` — 読み込み先の許可リスト込み（script-src / img-src / connect-src / frame-src …） |
| それ以外（API の JSON・JS・CSS・画像） | `CSP_MINIMAL` — `frame-ancestors` / `base-uri` / `form-action` / `object-src` だけ |

HTML 以外に `script-src` を付けても意味が無く、書き間違えたときの被害だけが残るので分けている。

## 止まったときの戻し方（これが一番大事）

広告や計測が止まったら、**コードのデプロイ無しで**巻き戻せる。`CSP_MODE` を secret で入れると
Worker が次のリクエストから読む。

```sh
echo report | npx wrangler secret put CSP_MODE            # 本番を Report-Only に（ブロックしない）
echo off    | npx wrangler secret put CSP_MODE            # 最小の CSP に戻す
npx wrangler secret delete CSP_MODE                       # enforce（既定）に戻す
# dev は --env dev を付ける
```

| 値 | 挙動 |
|---|---|
| 未設定 / `enforce` | 実際にブロックする（既定） |
| `report` | `Content-Security-Policy-Report-Only` で送るだけ。ブロックしない。enforce 側は最小の CSP が残る |
| `off` | 最小の CSP だけ。クリックジャッキング対策（`frame-ancestors`）は消えない |

`off` でも埋め込み禁止・フォーム送信先固定は残るので、巻き戻しても裸にはならない。

## 違反の見かた

違反は `/api/csp-report` に飛ぶ（`report-uri` と、Reporting API 用の `reporting-endpoints` の両方）。
受け口は `src/index.ts` の `handleCspReport` で、1 行に畳んで `console.error` する。

```sh
npx wrangler tail --format pretty | grep 'csp violation'
```

出るのは `{mode, directive, blocked, doc}` の 4 項目だけ（ブラウザが投げてくる中身は信用せず
200 字で切っている）。公開直後の数分はこれを見ること。`directive` が `script-src` で `blocked` が
Google 系なら許可リストの取りこぼし、`blocked` が `eval` なら `'unsafe-eval'` の要否の判断になる。

受け口はレート制限の別枠（`RL_COVERS` の `csp-report` バケット）に入れてある。壊れたページから
連打されても、公開・通報の枠（30/分）は食わない。

## 許可リストの中身

`src/util.ts` の定数にまとめてある。**新しい外部スクリプト・画像・接続先を足したら、ここと
`public/privacy.html` の「外部送信について」の両方を直すこと。**

| 定数 | 中身 |
|---|---|
| `CSP_GOOGLE_TAG` | GTM・タグマネージャ。`frame-src` にも入れる（`<noscript>` の `ns.html` iframe） |
| `CSP_GOOGLE_ANALYTICS` | GA4 のビーコン送信先（地域別ホストがあるのでワイルドカード） |
| `CSP_ADSENSE` | AdSense 本体・セーフフレーム・広告品質・資金調達メッセージ |
| `CSP_TURNSTILE` | `challenges.cloudflare.com`（スクリプトと iframe） |
| `CSP_VALUECOMMERCE` | Yahoo!ショッピングの購入リンクと計測ピクセル |

`style-src` に `https://fonts.googleapis.com` が要る（`public/styles.css` が Google Fonts を
`@import` している）。`font-src` は `https://fonts.gstatic.com`。

`img-src` が `https:` と広いのは、表紙（楽天・自前の `/cover`）と広告の画像が多数のホストに
散らばるため。ここを絞るなら、表紙の配信を `/cover` に寄せてからにする。

## 今あえて緩くしてあるところ

- **`script-src 'unsafe-inline'`**: インラインの `<script>`（編集トークンをアドレスバーから
  消す処理・GTM スニペット）と、AdSense がインラインを使うため。nonce 化は AdSense の
  `'strict-dynamic'` 対応とセットでないと広告が止まるので、公開後に違反レポートを見ながら。
  それでも許可ホストの制限は効くので、「知らないドメインからスクリプトを読ませる」形は塞げる。
- **`'unsafe-eval'` は入れていない**: 自前コードは `eval` / `new Function` を使っていない
  （確認済み）。広告が要求して止まるなら違反レポートに出るので、そこで判断する。

XSS 側の実態として、`innerHTML` はすべて静的テンプレか空文字で、ユーザ入力は `textContent` と
`escapeHtml`、`<script>` への埋め込みは `safeJson`（`src/index.ts`）。差し込み口は CSP が無くても
塞いである。CSP は多重防御として足している。

## 変更したときの確認

許可リストを触ったら、**実際に配られる HTML が参照している読み込み先が全部ポリシー内か**を
機械的に確かめる（GTM の `ns.html` iframe の漏れはこれで見つかった）。各ページの
`script`/`link`/`img`/`iframe` の src を集めて、CSP の各ディレクティブと突き合わせる。

**検算は必ず「デプロイ済みの実物」に対してやること。ローカルの `wrangler dev` では駄目。**
Cloudflare はゾーンの設定でエッジが HTML に手を入れる（Web Analytics のビーコン
`static.cloudflareinsights.com/beacon.min.js` の自動挿入など）。これはリポジトリを検索しても
出てこないし、ローカルでは挿入されない。**実際にこれで 1 件漏らして本番に出した**（RUM の
ビーコンがブロックされる状態で数分間動いていた）。dev に出してから dev の HTML で検算し、
本番に出したあともう一度本番の HTML で検算する。

静的な参照しか見られないので、実行時に増える読み込み先（広告の配信先など）は違反レポート頼み。
だから公開直後の `wrangler tail` が要る。

### AdSense は審査が通るまで検証できない

`pagead2.googlesyndication.com/pagead/js/adsbygoogle.js` は審査中でも読み込まれるので
`script-src` の 1 ホストぶんは今も通っているが、**広告が実際に配信され始めてから増える
読み込み先（セーフフレーム・広告品質・計測）は、審査通過まで一切出てこない**。
承認が下りたら、広告が出た状態で `wrangler tail | grep 'csp violation'` を見ること。
止まっていたら `CSP_MODE=report` に落として、違反を集めてから許可リストを直す。
