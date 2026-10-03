import { site } from "./site";
import { Env } from "./types";

// ランキング 3 ページ（みんなが選んだ / 売上 / 発行部数）を行き来するタブ。各 HTML の
// <!--RANK_SWITCH--> に差し込む（ヘッダー src/header.ts と同じ作り）。
//
// allAges: 中身が全年齢のデータ源によるもの。R18版では出さない（src/site.ts allAgesRankings）。
// 残りが 1 本になるなら nav ごと出さない（タブ 1 本は意味がないので）。
const TABS = [
  { href: "/ranking", label: "みんなが選んだ" },
  { href: "/sales-ranking", label: "売上（楽天ブックス）", allAges: true },
  { href: "/circulation", label: "発行部数（歴代）", allAges: true },
];

/** `currentPath` は配信中のページのパス。一致するタブに class="active" を付ける。 */
export function rankSwitchHtml(env: Pick<Env, "SITE_VARIANT">, currentPath: string): string {
  const showAllAges = site(env).allAgesRankings;
  const tabs = TABS.filter((t) => showAllAges || !t.allAges);
  if (tabs.length < 2) return "";
  // /ranking.html のような直指定でも現在地が分かるように拡張子と末尾の / を落とす。
  const current = currentPath.replace(/\.html$/, "").replace(/(.)\/$/, "$1");
  const links = tabs
    .map((t) => `<a href="${t.href}"${t.href === current ? ` class="active"` : ""}>${t.label}</a>`)
    .join("\n      ");
  return `<nav class="rank-switch">\n      ${links}\n    </nav>`;
}
