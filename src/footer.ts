import { site } from "./site";
import { Env } from "./types";
import { escapeHtml } from "./util";

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
const resetScript = (name: string) =>
  `<script>(function(){var b=document.getElementById("reset-local-data");if(!b)return;` +
  `b.addEventListener("click",async function(){` +
  `var msg="この端末（ブラウザ）に保存されている ${name} のデータを削除します。\\n\\n` +
  `・作成中の下書き\\n・「作ったリスト」の一覧と編集権限\\n・通報済みの記録\\n\\n` +
  `編集用リンクを控えていないリストは、二度と編集できなくなります。公開済みのリスト自体は消えません。\\nGoogle でログイン中なら、アカウントに保存されたリストと作成中のリストは残ります。\\n\\n本当に初期化しますか？";` +
  `var ok=window.uiConfirm?await window.uiConfirm(msg,{okLabel:"初期化する",danger:true}):confirm(msg);if(!ok)return;` +
  `try{Object.keys(localStorage).forEach(function(k){if(k.indexOf("my100manga_")===0)localStorage.removeItem(k);});}catch(e){}` +
  `location.reload();});})();</script>`;

// 並び: ページへのリンク → 出典（MADB・書影の取得元）→ API の公式クレジットと端末データの初期化。
// 下 2 段は小さく薄く出す（必要な表記だが目立たせない）。
// 運営者のページへは、リンク一覧ではなく下のコピーライトの行から辿る。
const FOOT_LINKS = [
  { href: "/books-guide", label: "追加できる本" },
  { href: "/terms", label: "利用規約" },
  { href: "/privacy", label: "プライバシーポリシー" },
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

// ヘッダー右上の Google ログイン / アカウント表示（public/account.js）。ヘッダーを持つ
// ページ全部で同じように出したいので、各 HTML に書かずフッターと同じ場所で差し込む
// （ページ自身の <script> より前に入るので、window.Account を使う app.js / account-page.js
// から見えている）。admin.html はフッターのプレースホルダを持たないので読まれない。
const ACCOUNT_SCRIPT = `<script src="/account.js"></script>`;

export function footerHtml(env: Env, withAff = false): string {
  const s = site(env);
  const name = escapeHtml(s.name);
  // アフィリエイト注記も楽天 / Yahoo のクレジットも、外部ストアを使っているサイトだけのもの。
  // R18版（commerce: false）は購入リンクも API 呼び出しも無いので両方出さない。
  const aff =
    withAff && s.commerce
      ? `<p class="aff-disclosure">当サイトはアフィリエイト広告（PR）を利用しています（<a href="/about">詳細</a>）。</p>`
      : "";
  // MADB の利用規約は、出典に加えて「編集・加工した」旨の記載を求めている（当サイトはシリーズの
  // 結合・巻の並べ替え・表記の正規化をしている）。書影の行は外部ストアから取っている本家だけ。
  // see https://mediaarts-db.artmuseums.go.jp/terms
  // 1 項目 1 行。区切りのスラッシュは使わず、改行で分ける（.foot-line が display: block）。
  const sourceLines = s.commerce
    ? [
        `データ: メディア芸術データベース（国立アートリサーチセンター）を加工して作成`,
        `書影: 楽天ブックス・楽天市場・Yahoo!ショッピング`,
      ]
    : [`データ: メディア芸術データベース（国立アートリサーチセンター）を加工して作成`];
  const source = sourceLines.map((l) => `<span class="foot-line">${l}</span>`).join("");
  // 公式スニペットは改変できないので、外側を <span class="foot-line"> で包んで行を分ける。
  const credits = s.commerce
    ? `<span class="foot-line">${RAKUTEN_CREDIT}</span>\n<span class="foot-line">${YAHOO_CREDIT}</span>`
    : "";
  const links = FOOT_LINKS.map((l) => `<a href="${l.href}">${l.label}</a>`).join("");
  return (
    `<footer class="site">` +
    `<nav class="foot-links" aria-label="サイト情報">${links}</nav>` +
    aff +
    // 出典の行そのものを /about（利用ソース・広告の説明）へのリンクにする（リンク一覧には別に置かない）。
    `<p class="foot-source"><a href="/about">${source}</a></p>` +
    `<p class="foot-credits">${credits}` +
    `<span class="foot-line"><button type="button" id="reset-local-data">この端末のデータを初期化</button></span></p>` +
    `<p class="foot-copy"><a href="/operator">© 2026 ${name} @rela1470</a></p>` +
    `</footer>` +
    ACCOUNT_SCRIPT +
    TO_TOP +
    resetScript(name)
  );
}
