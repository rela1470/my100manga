// 全公開ページ共通のサイトフッター。各 HTML の <!--FOOTER--> に差し込む。
// injectAnalytics（静的配信ページ）と renderViewPage（view.html）の両方から呼ぶ。
// admin.html は内部ツールでリンク構成が別なので、このプレースホルダを持たず素通りする。
//
// withAff: 購入リンクが実際に出るページ（index の編集プレビュー・view の閲覧）だけ
// アフィリエイト注記を一行出す。Amazon アソシエイト規約・ステマ規制の「リンクと同じ
// ページで分かる」要件を満たすため。詳細は /about に集約し、ここはリンクだけ。
// それ以外（about/terms/privacy/ranking）は注記なしの <!--FOOTER--> を使う。
export function footerHtml(withAff = false): string {
  const aff = withAff
    ? `<p class="aff-disclosure">当サイトはアフィリエイトプログラムを利用しています（<a href="/about">詳細</a>）。</p>`
    : "";
  return (
    `<footer class="site">` +
    `<p>データ提供: メディア芸術データベース（文化庁）｜ 書影: 楽天ブックス・Yahoo!ショッピング ｜ My 100 Manga / @rela1470</p>` +
    aff +
    `<p class="foot-links"><a href="/ranking">人気ランキング</a> ｜ <a href="/about">利用ソース・アフィリエイトについて</a> ｜ <a href="/terms">利用規約</a> ｜ <a href="/privacy">プライバシーポリシー</a> ｜ <a href="/operator">運営者について</a></p>` +
    `</footer>`
  );
}
