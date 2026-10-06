"use strict";

// ランキングのページ（/ranking・/sales-ranking・/circulation）で「巻一覧を開く」を押したときに、
// ページを離れずに巻を並べる一覧。本の詳細（book-detail.js）の上に重ねて開く。
//
// トップ（エディタ）の巻一覧（public/app.js の renderVolumes, 約 270 行）は、通報・補完・抜け巻の
// 手動追加まで担う編集画面の一部で、エディタの状態（編集中のリスト・検索結果への戻り先）に強く
// 結び付いている。そのまま持ち出せないので、ここにはその中の「並べる」と「追加する」だけを
// 置く。マスタの訂正まわり（間違っています／シリーズ名が違う／結合・分離の依頼）はエディタ側に
// 残すので、そちらへのリンクも残す。
//
// 追加はトップと同じ流れにそろえてある:
//   ・一覧の上のバーに「全N巻を追加」（app.js renderVolumes の addAll と同じ）
//   ・巻をタップ → 本の詳細 → 「リストに追加」（app.js openVolumeDetail → selectVolume と同じ）
// 追加先は作成中のリストの下書き（public/draft-add.js）。ページを跨ぐのでエディタの state は
// 使えず、localStorage の下書きに直接足す。
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
      <div class="vol-bar search-bar sv-bar" id="svBar" hidden></div>
      <p class="hint" id="svNote"></p>
      <div class="grid sv-grid" id="svGrid"></div>
      <div class="modal-actions">
        <a class="linkbtn sv-edit" id="svEdit" style="display:none"></a>
        <div style="flex:1"></div>
        <button type="button" id="svClose">閉じる</button>
      </div>
    </div>`;

  let modal = null;
  let seq = 0; // 遅れて返った /volumes が別のシリーズの表示を上書きしないように
  let slots = []; // 表示中の巻 [{ el, volume }]。追加済みの印を塗り直すのに使う。

  const $ = (id) => document.getElementById(id);

  /** 下書きに足せるページか（public/draft-add.js を読んでいるか）。読んでいないページ
   *  （管理画面など）では追加の導線を出さず、従来どおり表示だけにする。 */
  function canAdd() {
    return !!window.Draft;
  }

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

  // 巻の副題（MADB の schema:alternateName）。同じシリーズに「上」「下」しか巻番号を持たない
  // 別作品が並ぶとき、巻番号だけでは全部同じ表示になるので足す（public/app.js と同じ）。
  function withSubtitle(base, subtitle) {
    if (!subtitle) return base;
    if (!base) return subtitle;
    return base.includes(subtitle) ? base : `${base} ${subtitle}`;
  }

  // 下書きに入れるときの書名（public/app.js volLabel と同じ）。
  function volLabel(v) {
    return withSubtitle(v.volume_number ? `${v.title} ${v.volume_number}` : v.title, v.subtitle);
  }

  function isAdded(v) {
    return canAdd() && !!v.isbn && window.Draft.has(v.isbn);
  }

  /** 巻を下書きへ足し、結果をトーストで知らせる。トップ（app.js bulkAddSeries）と同じく、
   *  追加済みの ISBN は飛ばし、上限を超えた分は足さない。 */
  function addVolumes(vols, what) {
    const r = window.Draft.add(
      vols.map((v) => ({
        isbn: v.isbn,
        title: volLabel(v),
        author: v.author || "",
        cover_url: v.cover_url || "",
      }))
    );
    paintAdded();
    if (r.failed) {
      uiAlert("追加できませんでした。ブラウザの設定でデータの保存が止められている可能性があります。");
      return;
    }
    if (r.added === 0) {
      uiToast(r.skipped ? `${what}はすでに追加済みです。` : "追加できる巻がありませんでした。");
      return;
    }
    const notes = [];
    if (r.skipped > 0) notes.push(`追加済み${r.skipped}巻はスキップ`);
    if (r.overflow > 0) notes.push(`上限のため残り${r.overflow}巻は未追加`);
    const tail = notes.length ? `（${notes.join("、")}）` : "";
    uiToast(`${what}を追加しました${tail}。自分の100は ${r.total} 冊になりました。`, {
      actionLabel: "開く",
      onAction: () => {
        location.href = "/";
      },
    });
  }

  /** 一覧の上のバー（「全N巻を追加」）。巻一覧をスクロールしても押せるよう、
   *  スクロールする .sv-grid の外に置く（トップの searchBar と同じ考え方）。 */
  function renderBar(volumes) {
    const bar = $("svBar");
    bar.textContent = "";
    if (canAdd() && volumes.length > 0) {
      const addAll = document.createElement("button");
      addAll.type = "button";
      addAll.className = "primary";
      addAll.textContent = `全${volumes.length}巻を追加`;
      addAll.addEventListener("click", () => addVolumes(volumes, `全${volumes.length}巻`));
      bar.appendChild(addAll);
    }
    bar.hidden = !bar.childElementCount;
  }

  /** すでに下書きに入っている巻に印を付ける。追加のたびに呼ぶ。 */
  function paintAdded() {
    for (const s of slots) {
      const added = isAdded(s.volume);
      s.el.classList.toggle("added", added);
      s.badge.hidden = !added;
    }
  }

  function render(data) {
    const volumes = data.volumes || [];
    $("svTitle").textContent = data.title || "";
    $("svSub").textContent = data.creators || data.creator || "";
    $("svNote").textContent = volumes.length ? `全 ${volumes.length} 巻` : "巻が見つかりませんでした。";
    renderBar(volumes);

    const grid = $("svGrid");
    grid.textContent = "";
    slots = [];
    for (const v of volumes) {
      const slot = document.createElement("button");
      slot.type = "button";
      slot.className = "slot view sv-slot";
      const vol = withSubtitle(v.volume_number || "", v.subtitle);
      slot.title = vol ? `${v.title}（${vol}）` : v.title;
      // 巻一覧から開いた詳細では「巻一覧を開く」を出さない（開いているのがそれなので）。
      // 追加できるページでは詳細に「リストに追加」を出す（トップの巻一覧と同じ流れ）。
      slot.addEventListener("click", () =>
        window.openBookDetail(v, {
          noSeries: true,
          added: isAdded(v),
          onAdd: canAdd() ? () => addVolumes([v], `「${volLabel(v)}」`) : null,
        })
      );

      slot.appendChild(coverNode(v.cover_url, v.title));

      const badges = document.createElement("div");
      badges.className = "badges";
      const badge = document.createElement("span");
      badge.className = "badge sv-badge-added";
      badge.textContent = "追加済み";
      badge.hidden = true;
      badges.appendChild(badge);
      slot.appendChild(badges);

      const meta = document.createElement("div");
      meta.className = "meta";
      const t = document.createElement("div");
      t.className = "t";
      // 作品名は見出しに出ているので、ここは巻番号（＋副題）。独自シリーズのように巻番号が無く
      // 書名そのものが巻の区別になっているもの（ルフィ / ゾロ …）は書名を出す。
      t.textContent = vol || v.title;
      meta.appendChild(t);
      if (v.pubdate) {
        const c = document.createElement("div");
        c.className = "c";
        c.textContent = v.pubdate;
        meta.appendChild(c);
      }
      slot.appendChild(meta);
      grid.appendChild(slot);
      slots.push({ el: slot, volume: v, badge });
    }
    paintAdded();
  }

  window.openSeriesVolumes = async function (seriesId, title, opts = {}) {
    if (!seriesId) return;
    ensureModal();
    const mySeq = ++seq;

    $("svTitle").textContent = title || "";
    $("svSub").textContent = "";
    $("svNote").textContent = "巻を読み込み中...";
    $("svGrid").textContent = "";
    $("svBar").hidden = true;
    $("svBar").textContent = "";
    slots = [];
    const edit = $("svEdit");
    edit.href = opts.editHref || `/?series=${encodeURIComponent(seriesId)}&st=${encodeURIComponent(title || "")}`;
    // ここで追加できるようになったので、トップへの導線は「ここではできないこと」
    // （抜け巻の手動追加・誤りの通報・シリーズの結合/分離の依頼）の入り口として案内する。
    edit.textContent = canAdd() ? "トップの編集画面で開く" : "トップで開く（自分の100に追加）";
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
