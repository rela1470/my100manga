import { site } from "./site";
import { Env } from "./types";

// 公開ページ共通のヘッダーボタン（みんなのリスト・人気ランキング・売上ランキング・発行部数ランキング）。各 HTML の
// <!--HEADER_LINKS--> に差し込む。フッター (src/footer.ts) と同じく injectAnalytics
// （静的配信ページ）と renderViewPage（view.html）の両方から呼ぶ。
//
// allAges: 中身が全年齢のデータ源によるランキング（売上＝楽天ブックスのコミック売れ筋、
// 発行部数＝手入力のマスタ）。R18版では出さない（src/site.ts allAgesRankings）。
const LINKS = [
  { href: "/lists", icon: "📚", label: "みんなのリスト" },
  { href: "/ranking", icon: "🔥", label: "人気ランキング" },
  { href: "/sales-ranking", icon: "👑", label: "売上ランキング", allAges: true },
  { href: "/circulation", icon: "📈", label: "発行部数ランキング", allAges: true },
];

export function headerLinksHtml(env: Pick<Env, "SITE_VARIANT">): string {
  const showAllAges = site(env).allAgesRankings;
  return LINKS.filter((l) => showAllAges || !l.allAges).map(
    (l) =>
      `<a class="header-link" href="${l.href}"><span class="header-link-icon" aria-hidden="true">${l.icon}</span>${l.label}</a>`
  ).join("\n    ");
}
