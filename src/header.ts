import { site } from "./site";
import { Env } from "./types";

// 公開ページ共通のヘッダーボタン（みんなのリスト・人気ランキング・売上ランキング・発行部数ランキング）。各 HTML の
// <!--HEADER_LINKS--> に差し込む。フッター (src/footer.ts) と同じく injectAnalytics
// （静的配信ページ）と renderViewPage（view.html）の両方から呼ぶ。
//
// allAges: 中身が全年齢のデータ源によるランキング（売上＝楽天ブックスのコミック売れ筋、
// 発行部数＝手入力のマスタ）。R18版では出さない（src/site.ts allAgesRankings）。

// アイコンは線画の SVG（デザイン: Main.dc.html）。黒帯の上に白で描くので currentColor。
const icon = (path: string) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

const LINKS = [
  { href: "/lists", icon: icon(`<path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"></path><path d="M8 7h6"></path>`), label: "みんなのリスト" },
  { href: "/ranking", icon: icon(`<path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-3 2-4 2-7 1 1 2 2 3 4"></path>`), label: "人気ランキング" },
  { href: "/sales-ranking", icon: icon(`<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"></path>`), label: "売上ランキング", allAges: true },
  { href: "/circulation", icon: icon(`<path d="M3 17l6-6 4 4 8-8"></path><path d="M15 7h6v6"></path>`), label: "発行部数ランキング", allAges: true },
];

export function headerLinksHtml(env: Pick<Env, "SITE_VARIANT">): string {
  const showAllAges = site(env).allAgesRankings;
  return LINKS.filter((l) => showAllAges || !l.allAges).map(
    (l) =>
      `<a class="header-link" href="${l.href}"><span class="header-link-icon" aria-hidden="true">${l.icon}</span>${l.label}</a>`
  ).join("\n    ");
}
