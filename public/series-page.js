"use strict";

// シリーズの個別ページ（/s/<id>、src/seriesPage.ts）。本文はサーバが組んで返すので、ここでは
//   ・「巻を選んで自分の100に追加」と巻のタップで、巻一覧（series-volumes.js）を開く
//   ・表紙の無い巻を /api/covers（サイト共通の表紙キャッシュだけ）で埋める
// だけをする。
(function () {
  const article = document.querySelector(".sp");
  if (!article) return;
  const id = article.dataset.seriesId;
  const title = article.dataset.seriesTitle || "";

  function open() {
    if (!window.openSeriesVolumes) {
      location.href = `/?series=${encodeURIComponent(id)}&st=${encodeURIComponent(title)}`;
      return;
    }
    window.openSeriesVolumes(id, title);
  }

  document.getElementById("spOpen")?.addEventListener("click", open);

  // 「リンクをコピー」。クリップボードが使えない環境（http・古いブラウザ）では出さない。
  const copy = document.getElementById("spCopy");
  if (copy && navigator.clipboard) {
    copy.hidden = false;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(copy.dataset.url || location.href);
        copy.textContent = "コピーしました";
      } catch (e) {
        copy.textContent = "コピーできませんでした";
      }
      setTimeout(() => (copy.textContent = "リンクをコピー"), 2000);
    });
  }
  for (const li of article.querySelectorAll(".sp-vol")) li.addEventListener("click", open);

  const missing = [...article.querySelectorAll(".sp-vol[data-cover-isbn]")];
  if (!missing.length || !window.lookupCovers) return;
  window.lookupCovers(missing.map((li) => li.dataset.coverIsbn), { cacheOnly: true }).then((covers) => {
    for (const li of missing) {
      const url = covers[li.dataset.coverIsbn];
      const ph = li.querySelector(".cover.placeholder");
      if (!url || !ph) continue;
      ph.replaceWith(window.coverNode(url, li.querySelector(".meta .t")?.textContent || ""));
    }
  });
})();
