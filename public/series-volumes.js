"use strict";

// ランキングのページ（/ranking・/sales-ranking・/circulation）で「巻一覧を開く」を押したときに、
// ページを離れずに巻を並べる読み取り専用の一覧。本の詳細（book-detail.js）の上に重ねて開く。
//
// トップ（エディタ）の巻一覧（public/app.js の renderVolumes, 約 270 行）は「自分の100に追加」
// 「全N巻を追加」「間違っています」の通報・補完・手動追加まで担う編集画面の一部で、エディタの
// 状態（編集中のリスト・検索結果への戻り先）に強く結び付いている。そのまま持ち出せないので、
// ここには表示だけの軽い版を置く。追加したい人のためにエディタへのリンクは残す。
//
// window.openSeriesVolumes(seriesId, title, { editHref })
//   seriesId: C-id / U-id / G-id。GET /api/series/<id>/volumes で引く。
//   title:    開くまでの見出し（API が返す正式名で上書きする）。
//   editHref: 「トップで開く」の遷移先。省略すると /?series=<id>&st=<title> を組み立てる。
(function () {
  const MODAL_HTML = `
    <div class="modal sv-modal">
      <h2 id="svTitle"></h2>
      <div class="sv-sub" id="svSub"></div>
      <p class="hint" id="svNote"></p>
      <div class="grid sv-grid" id="svGrid"></div>
      <div class="modal-actions">
        <a class="primary" id="svEdit" style="display:none">トップで開く（自分の100に追加）</a>
        <div style="flex:1"></div>
        <button type="button" id="svClose">閉じる</button>
      </div>
    </div>`;

  let modal = null;
  let seq = 0; // 遅れて返った /volumes が別のシリーズの表示を上書きしないように

  const $ = (id) => document.getElementById(id);

  /** 本の詳細（book-detail.js）がこの一覧の上に開いているか。Esc と背景クリックを
   *  上に乗っている方だけに効かせるため。 */
  function detailOpen() {
    const bd = document.getElementById("bookDetailModal");
    return Boolean(bd && bd.classList.contains("open"));
  }

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "modal-backdrop modal-sheet"; // スマホでは全画面（styles.css）
    modal.id = "seriesVolumesModal";
    modal.innerHTML = MODAL_HTML;
    document.body.appendChild(modal);
    $("svClose").addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target === modal && !detailOpen()) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("open") && !detailOpen()) close();
    });
    return modal;
  }

  function close() {
    if (modal) modal.classList.remove("open");
  }

  function render(data) {
    const volumes = data.volumes || [];
    $("svTitle").textContent = data.title || "";
    $("svSub").textContent = data.creators || data.creator || "";
    $("svNote").textContent = volumes.length ? `全 ${volumes.length} 巻` : "巻が見つかりませんでした。";

    const grid = $("svGrid");
    grid.textContent = "";
    for (const v of volumes) {
      const slot = document.createElement("button");
      slot.type = "button";
      slot.className = "slot view sv-slot";
      slot.title = v.volume_number ? `${v.title}（${v.volume_number}）` : v.title;
      // 巻一覧から開いた詳細では「巻一覧を開く」を出さない（開いているのがそれなので）。
      slot.addEventListener("click", () => window.openBookDetail(v, { noSeries: true }));

      slot.appendChild(coverNode(v.cover_url, v.title));

      const meta = document.createElement("div");
      meta.className = "meta";
      const t = document.createElement("div");
      t.className = "t";
      // 作品名は見出しに出ているので、ここは巻番号。独自シリーズのように巻番号が無く書名そのものが
      // 巻の区別になっているもの（ルフィ / ゾロ …）は書名を出す。
      t.textContent = v.volume_number || v.title;
      meta.appendChild(t);
      if (v.pubdate) {
        const c = document.createElement("div");
        c.className = "c";
        c.textContent = v.pubdate;
        meta.appendChild(c);
      }
      slot.appendChild(meta);
      grid.appendChild(slot);
    }
  }

  window.openSeriesVolumes = async function (seriesId, title, opts = {}) {
    if (!seriesId) return;
    ensureModal();
    const mySeq = ++seq;

    $("svTitle").textContent = title || "";
    $("svSub").textContent = "";
    $("svNote").textContent = "巻を読み込み中...";
    $("svGrid").textContent = "";
    const edit = $("svEdit");
    edit.href = opts.editHref || `/?series=${encodeURIComponent(seriesId)}&st=${encodeURIComponent(title || "")}`;
    edit.style.display = "";
    modal.querySelector(".modal").scrollTop = 0;
    modal.classList.add("open");

    try {
      const data = await apiFetch(`/api/series/${encodeURIComponent(seriesId)}/volumes`);
      if (mySeq !== seq) return;
      render(data);
    } catch (e) {
      if (mySeq !== seq) return;
      $("svNote").textContent = apiErrorMessage(e, "巻一覧の取得に失敗しました。時間をおいて再度お試しください。");
    }
  };
})();
