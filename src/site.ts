import { Env } from "./types";

// サイトの種別（本家 / R18版）。同じコードを別の Worker（別ドメイン・別 D1/R2/キュー）として
// デプロイし、wrangler.jsonc の vars の SITE_VARIANT で切り替える想定。サイト名・配色・成年向けの
// 扱いなど、種別で変わるものはここに集める（散らばった分岐を作らない）。
//
//   "general" … 本家（全年齢）。既定値。未設定・不明な値もこれ（成年向けを除外する側に倒す）。
//   "adult"   … R18版（準備中）。成年向けの除外を外す。名前・ドメインは仮。
//
// 静的 HTML（public/*.html）は本家の表記で書いたまま、配信時に src/analytics.ts の
// applySiteIdentity が種別に合わせて差し替える。配色は <html data-site="..."> を見て
// public/styles.css が切り替える。ブラウザ側の JS は window.__SITE__（siteHeadTags）を読む。

export type SiteVariant = "general" | "adult";

export interface SiteConfig {
  variant: SiteVariant;
  /** サイト名（<title> の「| ◯◯」、og:site_name、フッターの ©）。 */
  name: string;
  /** SNS シェアのハッシュタグ（# は付けない）。 */
  hashtag: string;
  /** 成年向けの巻を除外・拒否するか（src/adult.ts、MADB の SPARQL、表紙ソースの ADULT 判定）。 */
  excludeAdult: boolean;
  /** 全年齢のデータ源に基づくランキング（売上＝楽天ブックスのコミック売れ筋、発行部数＝手入力の
   *  マスタ）を出すか。R18版では中身が全年齢作品なので出さない（ヘッダーのボタンと sitemap）。
   *  ページ自体は残る（URL を知っていれば見られる）。 */
  allAgesRankings: boolean;
  /** 検索の既定を成年向けだけにするか。R18版の収録は「成年向け＋全年齢」の上位互換だが、
   *  既定で全部出すと全年齢の作品に埋もれる（成年向け 7.6 千巻に対して全年齢は 35 万巻）。
   *  既定は成年向けだけにして、検索フォームの「全年齢の作品も含める」で外す。
   *  絞り込みは series.is_adult / volumes.is_adult（db/add-is-adult.sql）。see src/search.ts */
  adultOnlySearch: boolean;
  /** 外部ストアの API とアフィリエイトを使うか。表紙の取得（楽天ブックス・Yahoo!ショッピング・
   *  楽天市場）、購入リンク（Amazon・楽天・Yahoo・メルカリ）、売上ランキング（楽天ブックス）、
   *  フッターの楽天 / Yahoo 公式クレジットがまとめてこれで切れる。R18版が false なのは、
   *  各社の規約が成人向けサイトでの利用を認めているか未確認で、使う予定の DMM アフィリエイトが
   *  承認待ちのため（docs/r18.md 6 節）。false の間 R18版に表紙は出ない（MADB の書誌だけ）。 */
  commerce: boolean;
  /** 問い合わせ窓口（info@ / abuse@）のドメイン。利用規約・プライバシー・運営者の mailto を
   *  applySiteIdentity がこれに差し替える。canonical と違って**配信オリジンから作れない**:
   *  dev のホストには受信箱が無く、メールは本番ドメインで受けるため。 */
  mailDomain: string;
}

// 本家の静的 HTML に書かれている表記。applySiteIdentity が置き換える元の文字列。
export const GENERAL_NAME = "My 100 Manga";
export const GENERAL_ORIGIN = "https://my100manga.com";
export const GENERAL_MAIL_DOMAIN = "my100manga.com";

const SITES: Record<SiteVariant, SiteConfig> = {
  general: {
    variant: "general",
    name: GENERAL_NAME,
    hashtag: "my100manga",
    excludeAdult: true,
    allAgesRankings: true,
    adultOnlySearch: false,
    commerce: true,
    mailDomain: GENERAL_MAIL_DOMAIN,
  },
  // R18版（ドメインは wrangler.jsonc の env.r18 / env.r18dev）。サイトのドメインはここには持たない
  // （canonical・og:url は配信時のオリジンから applySiteIdentity が作る）。mailDomain だけは
  // 例外で、dev でも本番ドメインの窓口を出す（上の mailDomain のコメント）。
  adult: {
    variant: "adult",
    name: "My 100 Shunga",
    hashtag: "my100shunga",
    excludeAdult: false,
    allAgesRankings: false,
    adultOnlySearch: true,
    commerce: false,
    mailDomain: "my100shunga.com",
  },
};

/** 見出し用のブランド表記。「My 100 Manga」の数字だけをアクセント色にした HTML を組む。
 *  静的 HTML（public/*.html の <h1>）には本家の形が直書きしてあるが、`<span>` で割れていて
 *  applySiteIdentity の文字列置換（GENERAL_NAME）に引っかからない。そこで同じ形を組み立てて
 *  差し替える。src/shareImage.ts の brandSvg と同じ考え方。名前は SITES の定数なので
 *  エスケープは要らない（ユーザ入力は通さないこと）。 */
export function brandHtml(name: string): string {
  return name
    .split(" ")
    .map((w) => (/^\d+$/.test(w) ? `<span class="accent">${w}</span>` : w))
    .join(" ");
}

export function siteVariant(env: Pick<Env, "SITE_VARIANT">): SiteVariant {
  return (env.SITE_VARIANT ?? "").trim() === "adult" ? "adult" : "general";
}

export function site(env: Pick<Env, "SITE_VARIANT">): SiteConfig {
  return SITES[siteVariant(env)];
}

/** 検索で既定として成年向けだけを出すか。クライアントが all=1 を付けたときは外す
 *  （src/search.ts handleSearch）。 */
export function adultOnlySearch(env: Pick<Env, "SITE_VARIANT">): boolean {
  return site(env).adultOnlySearch;
}

/** 外部ストアの API・アフィリエイトを使うか。rakutenReady / yahooReady（＝表紙 Tier1–3 と
 *  売上ランキング）、affIds（購入リンク）、フッターのクレジットがこれを見る。 */
export function commerceEnabled(env: Pick<Env, "SITE_VARIANT">): boolean {
  return site(env).commerce;
}

/** 成年向けを除外するか。src/adult.ts・表紙ソース・MADB ライブ検索の判定はこれを通す。 */
export function excludeAdult(env: Pick<Env, "SITE_VARIANT">): boolean {
  return site(env).excludeAdult;
}
