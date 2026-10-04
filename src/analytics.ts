import { Env } from "./types";
import { footerHtml } from "./footer";
import { headerLinksHtml } from "./header";
import { rankSwitchHtml } from "./rankSwitch";
import { brandHtml, GENERAL_MAIL_DOMAIN, GENERAL_NAME, GENERAL_ORIGIN, site } from "./site";
import { escapeHtml } from "./util";

// 全 HTML ページの <head> の <!--ANALYTICS--> に差し込む Google タグを組み立てる。
// AdSense ローダ（ADSENSE_CLIENT）と GTM のヘッダスニペット（GTM_CONTAINER_ID）。
// どちらも公開値なので secret ではなく wrangler.jsonc の vars に集約。空/未設定なら
// そのタグは出力しない。admin.html にはプレースホルダを置いていないので自動で素通り。
// あわせて Turnstile のサイトキー（公開値）を <meta> で渡す（public/turnstile.js が読む）。
// サイト種別（src/site.ts）も window.__SITE__ で渡す（public/share-x.js 等が読む）。
export function analyticsTags(env: Env): string {
  const s = site(env);
  let out = `<script>window.__SITE__=${JSON.stringify({ variant: s.variant, name: s.name, hashtag: s.hashtag, commerce: s.commerce }).replace(/</g, "\\u003c")};</script>`;
  const sitekey = (env.TURNSTILE_SITE_KEY ?? "").trim();
  if (sitekey) {
    out += `<meta name="turnstile-sitekey" content="${escapeHtml(sitekey)}">`;
  }
  const ads = (env.ADSENSE_CLIENT ?? "").trim();
  if (ads) {
    out +=
      `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads)}" crossorigin="anonymous"></script>`;
  }
  const gtm = (env.GTM_CONTAINER_ID ?? "").trim();
  if (gtm) {
    const id = JSON.stringify(gtm);
    out +=
      `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${id});</script>`;
  }
  return out;
}

// <body> 直後の <!--GTM_BODY--> に差し込む GTM の noscript フォールバック（iframe）。
// JS 無効時でも計測できるよう GTM が <body> 冒頭に置くことを要求する。
export function gtmBody(env: Env): string {
  const gtm = (env.GTM_CONTAINER_ID ?? "").trim();
  if (!gtm) return "";
  return (
    `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(gtm)}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`
  );
}

// 編集ページ（index.html）の <!--AFF_DATA--> に差し込む affiliate id。閲覧ページと同じ
// affiliate.js / buildBuyLinks が購入リンクにタグを付けられるようにする。公開値なので
// secret ではなく env の vars。view ページは renderViewPage 側で __AFF__ を注入するため
// このプレースホルダを持たず、素通りする。
export function affIds(env: Env) {
  // R18版は購入リンクを出さない（src/site.ts commerce）。紹介 ID を渡さないだけでなく、
  // public/affiliate.js の buildBuyLinks が window.__SITE__.commerce を見てリンク自体を作らない。
  if (!site(env).commerce) return { amazon: "", rakuten: "", mercari: "", yahooSid: "", yahooPid: "" };
  return {
    amazon: env.AMAZON_ASSOCIATE_TAG ?? "",
    rakuten: env.RAKUTEN_AFFILIATE_ID ?? "",
    mercari: env.MERCARI_AFID ?? "",
    yahooSid: env.YAHOO_VC_SID ?? "",
    yahooPid: env.YAHOO_VC_PID ?? "",
  };
}

export function affData(env: Env): string {
  const safe = JSON.stringify(affIds(env)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<script>window.__AFF__=${safe};</script>`;
}

// 毎デプロイで変わるバージョン文字列。Cloudflare の version_metadata バインディングの
// id（UUID）の先頭 8 桁を使う。未バインド（ローカル等）なら "dev"。script の ?v= と
// <meta app-version> / /api/version で共通に使い、開きっぱなしのタブに新デプロイを気付かせる。
export function appVersion(env: Env): string {
  const id = env.CF_VERSION?.id;
  return id ? id.slice(0, 8) : "dev";
}

// HTML に SPA のバージョン印を差し込む。<meta name="app-version"> を <head> に、そして
// 自サイトの script src / stylesheet href（"/xxx.js" "/xxx.css"、クエリ無しのもの）すべてに
// ?v= を付けてデプロイごとにブラウザキャッシュを破棄する（app.js だけ新しく、共用の
// ui-dialog.js や styles.css が古いまま、という食い違いを防ぐ）。外部 URL（https://…）や
// すでにクエリの付いたものは触らない。view.html を返す renderViewPage からも使えるよう export。
export function injectVersion(html: string, v: string): string {
  const ver = encodeURIComponent(v);
  let out = html
    .replace(/(<script\b[^>]*\bsrc=")(\/(?!\/)[A-Za-z0-9_\-./]+\.js)(")/g, `$1$2?v=${ver}$3`)
    .replace(
      /(<link\b[^>]*\brel="stylesheet"[^>]*\bhref=")(\/(?!\/)[A-Za-z0-9_\-./]+\.css)(")/g,
      `$1$2?v=${ver}$3`
    );
  if (out.includes("</head>") && !out.includes('name="app-version"')) {
    out = out.replace("</head>", `<meta name="app-version" content="${escapeHtml(v)}"></head>`);
  }
  return out;
}

// 静的 HTML（本家の表記で書いてある）をサイト種別（src/site.ts）に合わせる。<html> に
// data-site を付け（public/styles.css が配色を切り替える）、本家以外ならサイト名と canonical /
// og:url の本家ドメイン、問い合わせ窓口の mailto を差し替える。ユーザ入力を差し込む前の
// テンプレートにだけ使うこと（表示名などに「My 100 Manga」と書かれていても書き換えないように）。
//
// mailto は canonical と別扱いで、配信オリジンではなく site(env).mailDomain を使う。dev
// （dev.my100shunga.com）には受信箱が無く、メールは本番ドメインで受けるため。see docs/r18.md 3 節
export function applySiteIdentity(html: string, env: Env, origin: string): string {
  const s = site(env);
  let out = html.replace(/<html\b(?![^>]*\bdata-site=)/, `<html data-site="${s.variant}"`);
  if (s.variant !== "general") {
    out = out
      // <h1>My <span class="accent">100</span> Manga</h1> のように要素で割れている表記は
      // GENERAL_NAME の置換に引っかからないので、同じ形を組み立てて先に差し替える。
      .replaceAll(brandHtml(GENERAL_NAME), brandHtml(s.name))
      .replaceAll(GENERAL_NAME, s.name)
      .replaceAll(`@${GENERAL_MAIL_DOMAIN}`, `@${s.mailDomain}`)
      .replaceAll(GENERAL_ORIGIN, origin);
  }
  return out;
}

// 静的配信（ASSETS.fetch）の HTML レスポンスを加工する。全 HTML にバージョン印（script の
// ?v= と <meta app-version>）を付け、プレースホルダがあれば Google タグ／affiliate id も差す。
// HTML 以外（css/js/画像）は素通り。
export async function injectAnalytics(res: Response, env: Env, origin: string, path = ""): Promise<Response> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return res;
  const html = applySiteIdentity(await res.text(), env, origin);
  const replaced = injectVersion(html, appVersion(env))
    .replace("<!--ANALYTICS-->", analyticsTags(env))
    .replace("<!--GTM_BODY-->", gtmBody(env))
    .replace("<!--AFF_DATA-->", affData(env))
    .replace("<!--HEADER_LINKS-->", headerLinksHtml(env))
    .replace("<!--RANK_SWITCH-->", rankSwitchHtml(env, path))
    .replace("<!--FOOTER_AFF-->", footerHtml(env, true))
    .replace("<!--FOOTER-->", footerHtml(env));
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  // 本文を書き換えたので、資産の強い ETag は本文と一致しなくなる。残すと再検証で
  // 古い本文の 304 を招きうるので落とす（HTML は max-age=0 で毎回取り直す前提）。
  headers.delete("etag");
  return new Response(replaced, { status: res.status, headers });
}
