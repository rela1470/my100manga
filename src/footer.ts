// 全公開ページ共通のサイトフッター。各 HTML の <!--FOOTER--> に差し込む。
// injectAnalytics（静的配信ページ）と renderViewPage（view.html）の両方から呼ぶ。
// admin.html は内部ツールでリンク構成が別なので、このプレースホルダを持たず素通りする。
//
// withAff: 購入リンクが実際に出るページ（index の編集プレビュー・view の閲覧）だけ
// アフィリエイト注記を一行出す。Amazon アソシエイト規約・ステマ規制の「リンクと同じ
// ページで分かる」要件を満たすため。詳細は /about に集約し、ここはリンクだけ。
// それ以外（about/terms/privacy/ranking）は注記なしの <!--FOOTER--> を使う。
//
// 「この端末のデータを初期化」: localStorage の my100manga_* を消す。下書き・通報済み
// フラグに加え、編集リンク復帰用の MyLists レジストリ（edit_token）も消えるので、
// 確認文でその点をはっきり伝える。ui-dialog.js を読まないページ（about 等）もあるため
// uiConfirm が無ければ素の confirm にフォールバックする。
const RESET_SCRIPT =
  `<script>(function(){var b=document.getElementById("reset-local-data");if(!b)return;` +
  `b.addEventListener("click",async function(){` +
  `var msg="この端末（ブラウザ）に保存されている My 100 Manga のデータを削除します。\\n\\n` +
  `・作成中の下書き\\n・「作ったリスト」の一覧と編集権限\\n・通報済みの記録\\n\\n` +
  `編集用リンクを控えていないリストは、二度と編集できなくなります。公開済みのリスト自体は消えません。\\n\\n本当に初期化しますか？";` +
  `var ok=window.uiConfirm?await window.uiConfirm(msg,{okLabel:"初期化する",danger:true}):confirm(msg);if(!ok)return;` +
  `try{Object.keys(localStorage).forEach(function(k){if(k.indexOf("my100manga_")===0)localStorage.removeItem(k);});}catch(e){}` +
  `location.reload();});})();</script>`;

export function footerHtml(withAff = false): string {
  const aff = withAff
    ? `<p class="aff-disclosure">当サイトはアフィリエイトプログラムを利用しています（<a href="/about">詳細</a>）。</p>`
    : "";
  return (
    `<footer class="site">` +
    `<p>データ提供: メディア芸術データベース（文化庁）｜ 書影: 楽天ブックス・Yahoo!ショッピング ｜ My 100 Manga / @rela1470</p>` +
    aff +
    `<p class="foot-links"><a href="/ranking">人気ランキング</a> ｜ <a href="/about">利用ソース・アフィリエイトについて</a> ｜ <a href="/terms">利用規約</a> ｜ <a href="/privacy">プライバシーポリシー</a> ｜ <a href="/operator">運営者について</a></p>` +
    `<p class="foot-reset"><button type="button" id="reset-local-data">この端末のデータを初期化</button></p>` +
    `</footer>` +
    RESET_SCRIPT
  );
}
