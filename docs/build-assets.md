# 配布用アセットのビルド（コメントを落とす）

`public/` 配下はブラウザにそのまま配られる。実装メモ・設計の経緯・TODO を書いたコメントも
一緒に公開されるので、**配る分だけ**コメントを落としたコピーを作ってデプロイする。

```
public/            ← 手で書く。コメントはここに全部残す（git の履歴もここ）
  ↓  npm run build   (scripts/build-assets.mjs)
dist/public/       ← コメントを落としたコピー。git 管理外（.gitignore）
  ↓  npm run deploy:prod   →  wrangler deploy --assets dist/public --minify
Cloudflare
```

## 方針: 元のファイルは触らない

コメントを消すのは**配布物だけ**で、`public/` のソースには一切手を入れない。だから
「なぜこうしたか」の文脈は手元にも git にも全部残り、次に触るときに読める。
ソースからコメントを削って別の場所に退避する方式は採らない（退避先とコードが離れると腐るため）。

## 何をどう落とすか

| 対象 | 方法 | 補足 |
|---|---|---|
| `*.js` | esbuild `minifyWhitespace` | **識別子は変えない**。`public/*.js` は素のクラシックスクリプトで `window.MyLists` などグローバル名を跨いで共有し、HTML の `onclick` からも呼ぶので、名前を変えると壊れうる |
| `*.css` | esbuild `minifyWhitespace` (loader: css) | |
| `*.html` | コメント除去（自前）。インラインの `<script>` / `<style>` の中身は上と同じ処理 | `<pre>` / `<textarea>` の中身は触らない |
| 画像・フォント・`*.txt`・`ads.txt` | そのままコピー | フォントのライセンス文（OFL）も**必ずそのまま**残す |
| Worker 本体（`src/`） | `wrangler deploy --minify` | バンドル時に esbuild がコメントごと落とす |

実測（2026-10-07）: `app.js` 217KB → 137KB、`admin.js` 201KB → 168KB、`styles.css` 126KB → 76KB。

## 消してはいけないもの

- **Worker が差し込みに使うプレースホルダ**: `<!--ANALYTICS-->` `<!--GTM_BODY-->` `<!--OGP_META-->`
  `<!--LIST_DATA-->` `<!--HEADER_LINKS-->` `<!--RANK_SWITCH-->` `<!--FOOTER-->` `<!--FOOTER_AFF-->`
  `<!--AFF_DATA-->`。消すと Google タグ・ヘッダー・フッター・OGP が黙って出なくなる。
  ビルドはこの形（`<!--[A-Za-z0-9_]+-->`）のコメントだけ残し、ファイルごとに**ビルド前後で
  一致するか検算して**、合わなければビルドを失敗させる（`verifyHtml`）。
- **楽天・Yahoo! のクレジット表記**。これは `public/` ではなく `src/footer.ts` が配信時に差し込む
  HTML コメント付きの公式スニペットで、改変禁止。ビルドの対象外なのでそのまま残る
  （`docs/about-page-notes.md` 参照）。

## 使い方

```sh
npm run build          # dist/public を作り直す（デプロイ前に自動で走る）
npm run deploy:dev     # build してから dev へ
npm run deploy:prod    # build してから本番へ（CLAUDE.md の予告手順に従うこと）
```

ローカルの `wrangler dev` は `wrangler.jsonc` の `assets.directory`（= `./public`）をそのまま見る。
コメント付きの元ファイルで開発し、配るときだけ落とす。

**`npx wrangler deploy` を直に叩かないこと。** `--assets` を渡さないと `public/` がそのまま出る。
デプロイは必ず npm script 経由で行う。

## 確認のしかた

```sh
npm run build
npx wrangler dev --assets dist/public --port 8799   # 落とした方で動かす
curl -s localhost:8799/ | grep -c '<!--'            # 4（楽天・Yahoo のクレジットだけ）
```
