# about ページ（利用ソース・アフィリエイト）の非公開メモ

`public/about.html` は一般公開ページなので、実装上の「設定オフ」に関する内部事情は本文から外している。
将来 about ページを見直すときの参考として、外した内容をここに残す。

## 外した記述

- **書影 Google Books は現在オフ**: 楽天ブックス書籍検索API が書影の第一候補で、Google Books は補助的なフォールバック。ただし `wrangler.jsonc` の `GOOGLE_ENABLED` が本番・dev とも既定 `"false"` のため、現状 Google Books 経路は実際には呼ばれていない。再度有効化するには `GOOGLE_ENABLED` を `"true"` にする。使っていないので about ページ本文からは外した（2026-10-03）。再度有効化するなら about・privacy の取得元と外部送信の記載も戻すこと。
- **アフィリエイト ID 未設定でもリンクは動く**: `AMAZON_ASSOCIATE_TAG` / `RAKUTEN_AFFILIATE_ID` / `MERCARI_AFID` が空でも購入リンクは正しいストアのページを開く（紹介タグが付かない＝紹介料は発生しないだけ）。dev 環境は Amazon/楽天の ID を空にしている。この「未設定でも動く」挙動は実装詳細なので公開ページには載せない。

## 参照

- 設定値: `wrangler.jsonc`（`vars` の `GOOGLE_ENABLED` / `AMAZON_ASSOCIATE_TAG` / `RAKUTEN_AFFILIATE_ID` / `MERCARI_AFID`）
- 書影解決の順序: `src/covers.ts` / `src/rakuten.ts`
- 購入リンク生成: `public/affiliate.js`

## 法務まわりの補足（2026-10 公開前対応）

- **クレジット表記**: 楽天ウェブサービス（テキストリンク "Supported by Rakuten Developers"）と Yahoo! JAPAN（"Webサービス by Yahoo! JAPAN"）の公式スニペットを `src/footer.ts` のフッター最下部に改変せず掲載。両社とも HTML の改変禁止（Yahoo は CSS での装飾変更も不可、ページ下部に配置）。出典: https://webservice.rakuten.co.jp/guide/credit / https://developer.yahoo.co.jp/attribution/
- **共有画像のクレジット**: 共有画像（`src/shareImage.ts`）自体には書影の出典表記を描いていない。about ページで「表紙を縮小・合成したもの・権利は権利者に帰属」と説明している。画像内に出典を入れるかは運営判断。
- **外部送信（privacy.html）**: ページ読込で送信されるのは GTM/GA・AdSense・楽天の書影画像（thumbnail.image.rakuten.co.jp）。Yahoo の書影と もったいない本舗の書影は `/cover` 経由（サーバ取得）なのでブラウザから直接は送信されない。バリューコマースの計測ピクセルは購入リンク表示時。Turnstile は送信時のみ読込。Amazon/楽天アフィリエイト/メルカリ/Google ログインはクリック時のみ。unavatar.io（operator.html のアイコン）は運営判断で記載対象外。新しい外部スクリプト・画像ホストを足したら privacy.html の「外部送信について」も更新すること。
