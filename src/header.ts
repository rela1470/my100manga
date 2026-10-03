// 公開ページ共通のヘッダーボタン（みんなのリスト・売上ランキング）。各 HTML の
// <!--HEADER_LINKS--> に差し込む。フッター (src/footer.ts) と同じく injectAnalytics
// （静的配信ページ）と renderViewPage（view.html）の両方から呼ぶ。
const LINKS = [
  { href: "/lists", icon: "📚", label: "みんなのリスト" },
  { href: "/sales-ranking", icon: "👑", label: "売上ランキング" },
];

export function headerLinksHtml(): string {
  return LINKS.map(
    (l) =>
      `<a class="header-link" href="${l.href}"><span class="header-link-icon" aria-hidden="true">${l.icon}</span>${l.label}</a>`
  ).join("\n    ");
}
