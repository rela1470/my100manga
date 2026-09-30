# about ページ（利用ソース・アフィリエイト）の非公開メモ

`public/about.html` は一般公開ページなので、実装上の「設定オフ」に関する内部事情は本文から外している。
将来 about ページを見直すときの参考として、外した内容をここに残す。

## 外した記述

- **書影 Google Books は現在オフ**: 楽天ブックス書籍検索API が書影の第一候補で、Google Books は補助的なフォールバック。ただし `wrangler.jsonc` の `GOOGLE_ENABLED` が本番・dev とも既定 `"false"` のため、現状 Google Books 経路は実際には呼ばれていない。再度有効化するには `GOOGLE_ENABLED` を `"true"` にする。about ページ本文では「補助的に補完」とだけ書き、オンオフ状態には触れていない。
- **アフィリエイト ID 未設定でもリンクは動く**: `AMAZON_ASSOCIATE_TAG` / `RAKUTEN_AFFILIATE_ID` / `MERCARI_AFID` が空でも購入リンクは正しいストアのページを開く（紹介タグが付かない＝紹介料は発生しないだけ）。dev 環境は Amazon/楽天の ID を空にしている。この「未設定でも動く」挙動は実装詳細なので公開ページには載せない。

## 参照

- 設定値: `wrangler.jsonc`（`vars` の `GOOGLE_ENABLED` / `AMAZON_ASSOCIATE_TAG` / `RAKUTEN_AFFILIATE_ID` / `MERCARI_AFID`）
- 書影解決の順序: `src/covers.ts` / `src/rakuten.ts`
- 購入リンク生成: `public/affiliate.js`
