# CSP（Content-Security-Policy）の現状と、この先の締め方

実装は `src/util.ts` の `SECURITY_HEADERS`。全レスポンスに付く（`withSecurityHeaders`）。

## いま入れているもの

```
frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
```

| 指示 | 何を止めるか | 壊れない理由 |
|---|---|---|
| `frame-ancestors 'none'` | 他サイトへの埋め込み（クリックジャッキング） | 埋め込ませる用途が無い |
| `base-uri 'self'` | `<base>` を差し込んで相対 URL のスクリプト・リンクを別ホストへ向け替える攻撃 | `<base>` をどのページでも使っていない |
| `form-action 'self'` | フォームの送信先の差し替え | フォームは年齢確認（自分へ POST）と `method="dialog"` だけ。ログインと購入リンクは `<a>`＝対象外 |
| `object-src 'none'` | `<object>`/`<embed>` 経由の読み込み | どのページでも使っていない |

## わざと入れていないもの

`script-src` / `img-src` / `connect-src` / `frame-src`。

GTM・AdSense・ValueCommerce は**実行時に動的に読み込み先を増やす**（`googleads.g.doubleclick.net`、
`tpc.googlesyndication.com`、`adtrafficquality.google`、`fundingchoicesmessages.google.com`、
地域別の `*.google.com` …）。許可リストを 1 つ取りこぼすと、広告と計測が**エラーも出さずに静かに止まる**。
公開当日に入れる変更ではない。

さらに `public/*.html` にはインラインの `<script>`（編集トークンをアドレスバーから消す処理、
GTM スニペット等）があるので、`'unsafe-inline'` を外すには nonce か hash の配布が要る。
Worker が HTML を書き換えているので nonce は配れる（`src/analytics.ts injectAnalytics` で
`<script>` に付ける）が、`'strict-dynamic'` と組み合わせないと AdSense が動かない。

## 公開後に締めるときの手順

1. `Content-Security-Policy-Report-Only` で**同じ内容＋`script-src` 等**を流す。Report-Only は
   ブロックしないので広告は止まらない。
2. 違反を集める。`report-to` の受け口を自前で足すか（Worker に `/api/csp-report` を作って
   `console.error` へ。observability に出る）、まずはブラウザのコンソールで数える。
3. 1〜2 週間ぶんの違反が出なくなったら、同じ内容を enforce 側へ移す。
4. 最後にインライン `<script>` を nonce 化して `'unsafe-inline'` を落とす。

### 出発点にする下書き（未検証・そのまま入れないこと）

```
default-src 'self';
script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://pagead2.googlesyndication.com
           https://challenges.cloudflare.com https://ck.jp.ap.valuecommerce.com;
img-src 'self' data: https:;
style-src 'self' 'unsafe-inline';
connect-src 'self' https://www.google-analytics.com https://analytics.google.com
            https://www.googletagmanager.com;
frame-src https://challenges.cloudflare.com https://googleads.g.doubleclick.net
          https://tpc.googlesyndication.com;
```

`img-src` を `https:` と広く取っているのは、表紙が楽天 (`thumbnail.image.rakuten.co.jp`)・自分の
`/cover`・広告配信元と散らばるため。ここを絞るなら表紙の配信元を `/cover` に寄せてからにする。

## 関連

- XSS 側の実態: `innerHTML` はすべて静的テンプレか空文字で、ユーザ入力は `textContent` と
  `escapeHtml`、`<script>` への埋め込みは `safeJson`（`src/index.ts`）。CSP が無くても
  差し込み口は塞いである。CSP は多重防御として足す位置づけ。
- 外部送信の一覧は `public/privacy.html` の「外部送信について」。新しい読み込み先を足したら
  そちらと、この文書の許可リストの両方を直すこと。
