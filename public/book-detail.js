"use strict";

// ランキングページ（/ranking・/sales-ranking）の本の詳細ポップアップ。100 冊の閲覧画面
// （view.html / view.js openDetail）と同じ見た目で、ページを離れずに本のデータ
// （作者・出版社・発行日・あらすじ。/api/book がマスタ + 楽天ブックスから返す）と購入リンク
// （affiliate.js）を出す。シリーズの巻一覧は series-volumes.js がその場で開く。
//
// 管理画面（admin.js の巻一覧ドリルダウン）からも使う。
//
// window.openBookDetail(book, { seriesHref, noSeries, onAdd, added, addLabel })
//   book: { isbn, title, author, cover_url }。手元にあれば creators / publisher / label /
//         pubdate / volume_number / isbns も渡すと、/api/book を待たずに先に出す。
//   seriesHref: /api/book がシリーズを返さないとき（マスタにまだ無い新刊など）の巻一覧・
//               検索へのリンク（売上ランキングの寄せ先）。省略可。
//   noSeries: 「巻一覧を開く」を出さない（巻一覧から開いたとき）。
//   onAdd(book): 「リストに追加」を出し、押されたら詳細を閉じてから呼ぶ。渡さなければ
//                ボタンは出ない（管理画面や、追加の受け皿が無いページ）。
//   added:    すでに下書きに入っている（ボタンを「追加済み」にして押せなくする）。
//   addLabel: ボタンの文言を変える（既定「リストに追加」）。
(function () {
  // 巻の副題（MADB の schema:alternateName）。同じシリーズに「上」「下」しか巻番号を持たない
  // 別作品が並ぶとき、巻番号だけでは全部同じ表示になるので足す（public/app.js と同じ）。
  function withSubtitle(base, subtitle) {
    if (!subtitle) return base;
    if (!base) return subtitle;
    return base.includes(subtitle) ? base : `${base} ${subtitle}`;
  }

  const MODAL_HTML = `
    <div class="modal">
      <!-- 操作は右上（あらすじ・購入リンクが長くてもスクロールせずに押せるよう、上に貼り付ける）。
           並びは他のダイアログと同じで、閉じるが一番右。 -->
      <div class="modal-head">
        <h2 id="bdTitle"></h2>
        <div class="modal-head-actions">
          <button type="button" class="primary" id="bdAdd" style="display:none">リストに追加</button>
          <button type="button" id="bdClose">閉じる</button>
        </div>
      </div>
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
        <p class="dsynopsis-src">出典: 楽天ブックス</p>
      </div>
      <div class="buy" id="bdBuy" style="display:none">
        <div class="buy-title">購入リンク<span class="pr-label">PR</span></div>
        <div class="buy-group" id="bdBuyPrint"></div>
        <div class="buy-group" id="bdBuyEbook"></div>
        <div class="buy-group" id="bdBuyUsed"></div>
        <p class="buy-note">[AD]絶版でも電子書籍なら手に入ることがあります。リンクは各社アフィリエイトを含みます。</p>
      </div>
    </div>`;

  let modal = null;
  let seq = 0; // 遅れて返った /api/book が別の本の表示を上書きしないように
  // 表紙の拡大表示（public/cover-zoom.js）に出す著作権表示。/api/book が返るまでは、
  // 呼び出し側が渡したぶんだけ。先に拡大を開いていたら、返ってきた時点で書き直す。
  let coverMeta = { pubdate: "", author: "", publisher: "" };
  let current = null; // 表示中の本（「リストに追加」が渡す）
  let onAdd = null; // opts.onAdd（無ければ追加ボタンを出さない）

  const $ = (id) => document.getElementById(id);

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "modal-backdrop modal-sheet"; // スマホでは全画面（styles.css）
    modal.id = "bookDetailModal";
    modal.innerHTML = MODAL_HTML;
    document.body.appendChild(modal);
    $("bdClose").addEventListener("click", close);
    // 追加したらこの詳細は閉じる。下に開いている巻一覧へ戻り、続けて別の巻を見られる。
    $("bdAdd").addEventListener("click", () => {
      const fn = onAdd, book = current;
      close();
      if (fn && book) fn(book);
    });
    $("bdSeries").addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      const id = $("bdSeries").dataset.seriesId;
      if (!id || !window.openSeriesVolumes) return; // 従来どおりトップへ遷移
      ev.preventDefault();
      const title = $("bdTitle").textContent;
      const editHref = $("bdSeries").href;
      // 巻一覧は詳細の「下」（z-index 49。styles.css #seriesVolumesModal）に開く。巻一覧から
      // 巻をタップしたときに詳細がその上へ出る向きにしてあるので、ここで詳細を閉じておかないと
      // 開いたままの詳細に隠れて、巻一覧が下にはみ出して見えることになる。
      close();
      window.openSeriesVolumes(id, title, { editHref });
    });
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

  // 作者欄。名前ごとに作者名検索へのリンクにする（public/author-link.js）。このページには
  // 検索フォームが無いので、リンクはトップ（/?q=…&by=creator）へ遷移する。
  function setAuthor(text) {
    const el = $("bdAuthor");
    const shown = window.renderAuthorLinks ? window.renderAuthorLinks(el, text) : ((el.textContent = text), !!text);
    el.style.display = shown ? "" : "none";
  }

  function setRow(rowId, valueId, text) {
    $(rowId).style.display = text ? "" : "none";
    if (text) $(valueId).textContent = text;
  }

  // 「巻一覧を開く」。リンクのままにしておき（Ctrl/⌘ クリックで新しいタブに開ける）、
  // public/series-volumes.js を読んでいるページでは、クリックを奪ってその場で巻一覧を開く。
  // シリーズ ID は href（/?series=<id>&st=…）から取る。?q= 検索へ落ちるケース（マスタに
  // 寄せ先が無い新刊など）は ID が無いので、従来どおりトップへ遷移する。
  function setSeries(href, label) {
    const a = $("bdSeries");
    a.style.display = href ? "" : "none";
    if (!href) return;
    a.href = href;
    a.textContent = label;
    let id = "";
    try {
      id = new URL(href, location.href).searchParams.get("series") || "";
    } catch {
      id = "";
    }
    a.dataset.seriesId = id;
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
    // 表紙は枠に合わせて切り抜いているので、押したら切れていない全体を拡大で出す。
    if (window.attachCoverZoom) {
      window.attachCoverZoom(img, {
        coverUrl: book.cover_url,
        isbn: book.isbn,
        title: book.title,
        meta: () => coverMeta,
      });
    }
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
      setAuthor(data.authors.join("、"));
      coverMeta.author = data.authors.join("、");
    }
    // 渡された値（巻一覧のマスタ）を空の応答で消さない。
    if (data.publisher) {
      setRow("bdPublisherRow", "bdPublisher", data.publisher);
      coverMeta.publisher = data.publisher;
    }
    if (data.pubdate) {
      setRow("bdPubdateRow", "bdPubdate", data.pubdate);
      coverMeta.pubdate = data.pubdate;
    }
    if (window.refreshCoverZoomCredit) window.refreshCoverZoomCredit();
    if (data.label) setRow("bdLabelRow", "bdLabel", data.label);
    if (data.volume_number) setRow("bdVolRow", "bdVol", withSubtitle(data.volume_number, data.subtitle));
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
    current = book;
    coverMeta = {
      pubdate: book.pubdate || "",
      author: book.creators || book.author || "",
      publisher: book.publisher || "",
    };
    onAdd = typeof opts.onAdd === "function" ? opts.onAdd : null;
    const add = $("bdAdd");
    add.style.display = onAdd ? "" : "none";
    add.disabled = !!opts.added;
    add.textContent = opts.added ? "追加済み" : opts.addLabel || "リストに追加";
    $("bdTitle").textContent = book.title || "";
    setAuthor(book.creators || book.author || "");
    setRow("bdVolRow", "bdVol", withSubtitle(book.volume_number || "", book.subtitle));
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
