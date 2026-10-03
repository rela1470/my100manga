// 全公開ページ共通のサイトフッター。各 HTML の <!--FOOTER--> に差し込む。
// injectAnalytics（静的配信ページ）と renderViewPage（view.html）の両方から呼ぶ。
// admin.html は内部ツールでリンク構成が別なので、このプレースホルダを持たず素通りする。
//
// withAff: 購入リンクが実際に出るページ（index の編集プレビュー・view の閲覧・ランキングの本の詳細）だけ
// アフィリエイト注記を一行出す。Amazon アソシエイト規約・ステマ規制の「リンクと同じ
// ページで分かる」要件を満たすため。詳細は /about に集約し、ここはリンクだけ。
// それ以外（about/books-guide/terms/privacy）は注記なしの <!--FOOTER--> を使う。
//
// クレジット表記: 楽天ウェブサービス（https://webservice.rakuten.co.jp/guide/credit）と
// Yahoo! JAPAN Webサービス（https://developer.yahoo.co.jp/attribution/）の利用規約で、
// 公式の HTML を「改変せずに」掲載することが求められている（Yahoo はページ下部に配置）。
// そのため下の 2 つのスニペットは開始/終了コメントも含めて公式のまま。体裁を変えたいときも
// スニペット自体には手を入れず、外側の <p> 側で調整すること。
const RAKUTEN_CREDIT =
  `<!-- Rakuten Web Services Attribution Snippet FROM HERE -->\n` +
  `<a href="https://developers.rakuten.com/" target="_blank">Supported by Rakuten Developers</a>\n` +
  `<!-- Rakuten Web Services Attribution Snippet TO HERE -->`;
const YAHOO_CREDIT =
  `<!-- Begin Yahoo! JAPAN Web Services Attribution Snippet -->\n` +
  `<span style="margin:15px 15px 15px 15px"><a href="https://developer.yahoo.co.jp/sitemap/">Webサービス by Yahoo! JAPAN</a></span>\n` +
  `<!-- End Yahoo! JAPAN Web Services Attribution Snippet -->`;

// 「この端末のデータを初期化」: localStorage の my100manga_* を消す。下書き・通報済み
// フラグに加え、編集リンク復帰用の MyLists レジストリ（edit_token）も消えるので、
// 確認文でその点をはっきり伝える。ui-dialog.js を読まないページ（about 等）もあるため
// uiConfirm が無ければ素の confirm にフォールバックする。
const RESET_SCRIPT =
  `<script>(function(){var b=document.getElementById("reset-local-data");if(!b)return;` +
  `b.addEventListener("click",async function(){` +
  `var msg="この端末（ブラウザ）に保存されている My 100 Manga のデータを削除します。\\n\\n` +
  `・作成中の下書き\\n・「作ったリスト」の一覧と編集権限\\n・通報済みの記録\\n\\n` +
  `編集用リンクを控えていないリストは、二度と編集できなくなります。公開済みのリスト自体は消えません。\\nGoogle でログイン中なら、アカウントに保存されたリストと作成中のリストは残ります。\\n\\n本当に初期化しますか？";` +
  `var ok=window.uiConfirm?await window.uiConfirm(msg,{okLabel:"初期化する",danger:true}):confirm(msg);if(!ok)return;` +
  `try{Object.keys(localStorage).forEach(function(k){if(k.indexOf("my100manga_")===0)localStorage.removeItem(k);});}catch(e){}` +
  `location.reload();});})();</script>`;

// 並び: ページへのリンク → 出典（MADB・書影の取得元）→ API の公式クレジットと端末データの初期化。
// 下 2 段は小さく薄く出す（必要な表記だが目立たせない）。
const FOOT_LINKS = [
  { href: "/books-guide", label: "追加できる本" },
  { href: "/terms", label: "利用規約" },
  { href: "/privacy", label: "プライバシーポリシー" },
  { href: "/operator", label: "運営者" },
];

// 右下の「ページの先頭へ」ボタン（PC のみ。表示条件は styles.css の .to-top）。少しスクロール
// したら出す。scroll は passive で拾い、状態が変わったときだけクラスを付け外しする。
const TO_TOP =
  `<button type="button" class="to-top" id="to-top" aria-label="ページの先頭へ" title="ページの先頭へ">` +
  `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5l-7 7m7-7l7 7M12 5v14" ` +
  `fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
  `<script>(function(){var b=document.getElementById("to-top");if(!b)return;var on=false;` +
  `function u(){var v=window.scrollY>400;if(v!==on){on=v;b.classList.toggle("show",v);}}` +
  `window.addEventListener("scroll",u,{passive:true});u();` +
  `b.addEventListener("click",function(){var r=matchMedia("(prefers-reduced-motion: reduce)").matches;` +
  `window.scrollTo({top:0,behavior:r?"auto":"smooth"});});})();</script>`;

export function footerHtml(withAff = false): string {
  const aff = withAff
    ? `<p class="aff-disclosure">当サイトはアフィリエイト広告（PR）を利用しています（<a href="/about">詳細</a>）。</p>`
    : "";
  const links = FOOT_LINKS.map((l) => `<a href="${l.href}">${l.label}</a>`).join("");
  return (
    `<footer class="site">` +
    `<nav class="foot-links" aria-label="サイト情報">${links}</nav>` +
    aff +
    // 出典の行そのものを /about（利用ソース・広告の説明）へのリンクにする（リンク一覧には別に置かない）。
    `<p class="foot-source"><a href="/about">データ: メディア芸術データベース（国立アートリサーチセンター）／ 書影: 楽天ブックス・楽天市場・Yahoo!ショッピング</a></p>` +
    `<p class="foot-credits">${RAKUTEN_CREDIT}\n${YAHOO_CREDIT}` +
    `<button type="button" id="reset-local-data">この端末のデータを初期化</button></p>` +
    `<p class="foot-copy">© 2026 My 100 Manga @rela1470</p>` +
    `</footer>` +
    TO_TOP +
    RESET_SCRIPT
  );
}
