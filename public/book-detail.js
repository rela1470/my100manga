"use strict";

// ランキングページ（/ranking・/sales-ranking）の本の詳細ポップアップ。100 冊の閲覧画面
// （view.html / view.js openDetail）と同じ見た目で、ページを離れずに本のデータ
// （作者・出版社・発行日・あらすじ。/api/book がマスタ + 楽天ブックスから返す）と購入リンク
// （affiliate.js）を出す。シリーズの巻一覧（= 自分の100への追加）はエディタへの遷移になる。
//
// 管理画面（admin.js の巻一覧ドリルダウン）からも使う。
//
// window.openBookDetail(book, { seriesHref, noSeries })
//   book: { isbn, title, author, cover_url }。手元にあれば creators / publisher / label /
//         pubdate / volume_number / isbns も渡すと、/api/book を待たずに先に出す。
//   seriesHref: /api/book がシリーズを返さないとき（マスタにまだ無い新刊など）の巻一覧・
//               検索へのリンク（売上ランキングの寄せ先）。省略可。
//   noSeries: 「巻一覧を開く」を出さない（巻一覧から開いたとき）。
(function () {
  const MODAL_HTML = `
    <div class="modal">
      <h2 id="bdTitle"></h2>
      <div class="detail-body">
        <div id="bdCoverBox"></div>
        <div class="dinfo">
          <div class="dauthor" id="bdAuthor"></div>
          <dl class="dmeta">
            <div class="dmeta-row" id="bdVolRow" style="display:none"><dt>巻</dt><dd id="bdVol"></dd></div>
            <div class="dmeta-row" id="bdPublisherRow" style="display:none"><dt>出版社</dt><dd id="bdPublisher"></dd></div>
            <div class="dmeta-row" id="bdLabelRow" style="display:none"><dt>レーベル</dt><dd id="bdLabel"></dd></div>
            <div class="dmeta-row" id="bdPubdateRow" style="display:none"><dt>発行日</dt><dd id="bdPubdate"></dd></div>
            <div class="dmeta-row" id="bdIsbnRow" style="display:none"><dt>ISBN</dt><dd id="bdIsbn"></dd></div>
            <div class="dmeta-row" id="bdEditionsRow" style="display:none"><dt>他の版</dt><dd id="bdEditions"></dd></div>
          </dl>
          <a class="primary bd-series" id="bdSeries" style="display:none"></a>
        </div>
      </div>
      <div class="dsynopsis" id="bdSynopsisBox" style="display:none">
        <div class="dsynopsis-title">あらすじ</div>
        <p class="dsynopsis-text" id="bdSynopsis"></p>
      </div>
      <div class="buy" id="bdBuy" style="display:none">
        <div class="buy-title">購入する</div>
        <div class="buy-group" id="bdBuyPrint"></div>
        <div class="buy-group" id="bdBuyEbook"></div>
        <div class="buy-group" id="bdBuyUsed"></div>
        <p class="buy-note">[AD]絶版でも電子書籍なら手に入ることがあります。リンクは各社アフィリエイトを含みます。</p>
      </div>
      <div class="modal-actions">
        <div style="flex:1"></div>
        <button type="button" id="bdClose">閉じる</button>
      </div>
    </div>`;

  let modal = null;
  let seq = 0; // 遅れて返った /api/book が別の本の表示を上書きしないように

  const $ = (id) => document.getElementById(id);

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "modal-backdrop modal-sheet"; // スマホでは全画面（styles.css）
    modal.id = "bookDetailModal";
    modal.innerHTML = MODAL_HTML;
    document.body.appendChild(modal);
    $("bdClose").addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("open")) close();
    });
    return modal;
  }

  function close() {
    if (modal) modal.classList.remove("open");
  }

  function setRow(rowId, valueId, text) {
    $(rowId).style.display = text ? "" : "none";
    if (text) $(valueId).textContent = text;
  }

  function setSeries(href, label) {
    const a = $("bdSeries");
    a.style.display = href ? "" : "none";
    if (!href) return;
    a.href = href;
    a.textContent = label;
  }

  function renderCover(book) {
    const box = $("bdCoverBox");
    box.textContent = "";
    const noimg = () => {
      const d = document.createElement("div");
      d.className = "dnoimg";
      d.textContent = "No Image";
      return d;
    };
    if (!book.cover_url) {
      box.appendChild(noimg());
      return;
    }
    const img = document.createElement("img");
    img.className = "dcover";
    img.alt = book.title || "";
    img.onerror = () => img.replaceWith(noimg());
    applyCover(img, book.cover_url);
    box.appendChild(img);
  }

  // view.js renderBuy と同じ。
  function renderBuy(book) {
    const box = $("bdBuy");
    const groups = { print: $("bdBuyPrint"), ebook: $("bdBuyEbook"), used: $("bdBuyUsed") };
    Object.values(groups).forEach((g) => (g.innerHTML = ""));
    const links = typeof window.buildBuyLinks === "function" ? window.buildBuyLinks(book) : [];
    if (!links.length) {
      box.style.display = "none";
      return;
    }
    for (const l of links) {
      const a = document.createElement("a");
      a.className = "buy-btn " + l.store;
      a.href = l.url;
      a.target = "_blank";
      a.rel = "noopener sponsored nofollow";
      a.textContent = l.label;
      if (l.pixel) {
        const px = document.createElement("img");
        px.src = l.pixel;
        px.width = px.height = 1;
        px.alt = "";
        px.style.border = "0";
        a.appendChild(px);
      }
      (groups[l.format] || groups.print).appendChild(a);
    }
    box.style.display = "";
  }

  // 作者（全員）・出版社・発行日・あらすじ・シリーズを /api/book で埋める。
  async function loadMeta(book, opts, mySeq) {
    let data;
    try {
      const res = await fetch(`/api/book?isbn=${encodeURIComponent(book.isbn)}`);
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    if (mySeq !== seq) return;
    // 役割付きの全作者（book.creators: "原作：A、作画：B"）を渡されていればそちらを残す。
    if (!book.creators && Array.isArray(data.authors) && data.authors.length) {
      $("bdAuthor").textContent = data.authors.join("、");
      $("bdAuthor").style.display = "";
    }
    // 渡された値（巻一覧のマスタ）を空の応答で消さない。
    if (data.publisher) setRow("bdPublisherRow", "bdPublisher", data.publisher);
    if (data.pubdate) setRow("bdPubdateRow", "bdPubdate", data.pubdate);
    if (data.label) setRow("bdLabelRow", "bdLabel", data.label);
    if (data.volume_number) setRow("bdVolRow", "bdVol", data.volume_number);
    if (Array.isArray(data.editions) && data.editions.length) {
      setRow("bdEditionsRow", "bdEditions", data.editions.join("、"));
    }
    // 巻一覧はトップ（エディタ）の検索モーダルにしか無いので ?series= で開く（app.js openSeriesFromUrl）。
    if (data.series && !opts.noSeries) {
      setSeries(
        `/?series=${encodeURIComponent(data.series.id)}&st=${encodeURIComponent(data.series.title)}`,
        "巻一覧を開く"
      );
    }
    if (data.caption) {
      $("bdSynopsis").textContent = data.caption;
      $("bdSynopsisBox").style.display = "";
    }
  }

  window.openBookDetail = function (book, opts = {}) {
    ensureModal();
    const mySeq = ++seq;
    $("bdTitle").textContent = book.title || "";
    const author = book.creators || book.author || "";
    $("bdAuthor").textContent = author;
    $("bdAuthor").style.display = author ? "" : "none";
    setRow("bdVolRow", "bdVol", book.volume_number || "");
    setRow("bdPublisherRow", "bdPublisher", book.publisher || "");
    setRow("bdLabelRow", "bdLabel", book.label || "");
    setRow("bdPubdateRow", "bdPubdate", book.pubdate || "");
    setRow("bdIsbnRow", "bdIsbn", book.isbn || "");
    const editions = (book.isbns || []).filter((x) => x !== book.isbn);
    setRow("bdEditionsRow", "bdEditions", editions.join("、"));
    $("bdSynopsisBox").style.display = "none";
    $("bdSynopsis").textContent = "";
    // /api/book がシリーズを返せばそちらで差し替える。
    setSeries(opts.noSeries ? "" : opts.seriesHref || "", "巻一覧を開く");
    renderCover(book);
    renderBuy(book);
    modal.querySelector(".modal").scrollTop = 0;
    modal.classList.add("open");
    if (book.isbn) loadMeta(book, opts, mySeq);
  };
})();
