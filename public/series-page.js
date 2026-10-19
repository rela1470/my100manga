"use strict";

// シリーズの個別ページ（/s/<id>）と巻のページ（/b/<isbn>）。src/seriesPage.ts。本文はサーバが
// 組んで返すので、ここでは
//   ・「巻を選んで自分の100に追加」で巻一覧（series-volumes.js）を開く
//   ・巻のページの「この巻を自分の100に追加」で、その巻を下書き（draft-add.js）に足す
//   ・「リンクをコピー」
//   ・表紙の無い巻を /api/covers（サイト共通の表紙キャッシュだけ）で埋める
// だけをする。巻のタイルは巻のページへのふつうのリンク。
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

  // 巻のページ: その巻だけを下書きに足す（series-volumes.js addVolumes と同じ扱い）。
  const focus = article.querySelector(".sp-focus");
  const addVol = document.getElementById("spAddVol");
  if (focus && addVol) {
    const isbn = focus.dataset.isbn;
    const paint = () => {
      const added = !!(window.Draft && window.Draft.has(isbn));
      addVol.disabled = added;
      addVol.textContent = added ? "自分の100に追加済み" : "この巻を自分の100に追加";
    };
    if (!window.Draft) addVol.hidden = true;
    else paint();
    addVol.addEventListener("click", () => {
      const r = window.Draft.add([
        { isbn, title: focus.dataset.title || "", author: focus.dataset.author || "", cover_url: focus.dataset.cover || "" },
      ]);
      paint();
      if (r.failed) {
        uiAlert("追加できませんでした。ブラウザの設定でデータの保存が止められている可能性があります。");
      } else if (r.added) {
        uiToast("自分の100に追加しました。トップで続きを作れます。");
      } else if (r.overflow) {
        uiToast("リストがいっぱいで追加できませんでした。");
      }
    });
  }

  // 「リンクをコピー」。クリップボードが使えない環境（http・古いブラウザ）では出さない。
  // 巻のページには巻の分とシリーズの分の 2 つある。
  if (navigator.clipboard) {
    for (const copy of article.querySelectorAll(".sp-copy")) {
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
  }

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
