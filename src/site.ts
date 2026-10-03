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
}

// 本家の静的 HTML に書かれている表記。applySiteIdentity が置き換える元の文字列。
export const GENERAL_NAME = "My 100 Manga";
export const GENERAL_ORIGIN = "https://my100manga.com";

const SITES: Record<SiteVariant, SiteConfig> = {
  general: { variant: "general", name: GENERAL_NAME, hashtag: "my100manga", excludeAdult: true },
  // R18版（my100shunga.com / dev.my100shunga.com）。ドメインはここには持たない（canonical・og:url は
  // 配信時のオリジンから applySiteIdentity が作る）。
  adult: { variant: "adult", name: "My 100 Shunga", hashtag: "my100shunga", excludeAdult: false },
};

export function siteVariant(env: Pick<Env, "SITE_VARIANT">): SiteVariant {
  return (env.SITE_VARIANT ?? "").trim() === "adult" ? "adult" : "general";
}

export function site(env: Pick<Env, "SITE_VARIANT">): SiteConfig {
  return SITES[siteVariant(env)];
}

/** 成年向けを除外するか。src/adult.ts・表紙ソース・MADB ライブ検索の判定はこれを通す。 */
export function excludeAdult(env: Pick<Env, "SITE_VARIANT">): boolean {
  return site(env).excludeAdult;
}
