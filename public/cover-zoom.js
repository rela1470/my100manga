"use strict";

// 表紙の拡大表示。詳細ポップアップの表紙（96×132 で object-fit: cover、つまり左右か上下が
// 切れている）をタップすると、画面いっぱいに切らずに出す。表紙は権利者のものなので、
// 著作権表示（発行年・作者・出版社）と書影の出典（どのストアのものか）をその場に添える。
//
// window.attachCoverZoom(img, { coverUrl, isbn, title, meta })
//   詳細の <img class="dcover"> に押せる見た目とキーボード操作を付ける。coverUrl は
//   /cover 経由に差し替える前の元 URL（出典の判定と楽天の大きい版の取得に使う）。meta は
//   { pubdate, author, publisher } か、それを返す関数（/api/book を待って埋まるので、開く
//   たびに読み直せるよう関数で渡す）。
// window.openCoverZoom({ src, coverUrl, isbn, title, meta }) でも直接開ける。
// window.refreshCoverZoomCredit() は開いたままクレジットを書き直す（拡大を先に開いて、
// あとから /api/book が返ったとき用）。
//
// 開閉は他のモーダルと同じく .modal-backdrop の class "open" だけなので、背面スクロールの
// ロック・Esc・フォーカス・ブラウザバックは public/ui-dialog.js がそのまま面倒を見る。
(function () {
  var modal = null;
  var imgEl = null;
  var creditEl = null;
  var sourceEl = null;
  var current = null; // 表示中の opts（クレジットを書き直すときに読む）
  var seq = 0; // 遅れて読み込めた大きい版が、別の表紙を上書きしないように

  // 楽天のサムネイル配信は元画像より大きくは返さない（?_ex=WxH は上限の指定）。詳細の表紙は
  // 300×300 で取っているので、拡大のときだけ大きい版を頼む。読めたら差し替える方式にして、
  // 読めなかったとき（その大きさが無い・失敗）は今出ている表紙のままにする。
  function largerSrc(src) {
    if (!/thumbnail\.image\.rakuten\.co\.jp/.test(src)) return "";
    var big = src.replace(/_ex=\d+x\d+/, "_ex=800x800");
    return big === src ? "" : big;
  }

  // 著作権表示。「© 発行年 作者／出版社」。詳細（/api/book）がまだ返っていなければ分かる
  // ぶんだけ、何も分からなければ「表紙の著作権は各出版社・著作者に帰属します」。© は権利者名が
  // 無いと表示として成立しない（src/shareImage.ts の CREDIT_RIGHTS と同じ理由）。発行日は "2015年3月19日" の形で来るので
  // 先頭の 4 桁を年として使う。
  function copyrightText(meta) {
    var m = (typeof meta === "function" ? meta() : meta) || {};
    var year = ((m.pubdate || "").match(/\d{4}/) || [""])[0];
    var names = [m.author || "", m.publisher || ""].filter(Boolean).join("／");
    var body = [year, names].filter(Boolean).join(" ");
    return body ? "© " + body : "表紙の著作権は各出版社・著作者に帰属します";
  }

  // 書影そのものの出どころ（どのストアの画像か）。詳細の「画像参考元」と同じ判定。
  function sourceText(coverUrl, isbn) {
    var src = window.coverSourceLink ? window.coverSourceLink(coverUrl, isbn) : null;
    return src && src.label ? "書影: " + src.label : "";
  }

  function renderCredit() {
    if (!current) return;
    creditEl.textContent = copyrightText(current.meta);
    var src = sourceText(current.coverUrl || current.src, current.isbn);
    sourceEl.textContent = src;
    sourceEl.style.display = src ? "" : "none";
  }

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    // class は modal-backdrop だけ（"cover-zoom" は管理画面の別の拡大表示が使っている）。
    // 見た目は #coverZoomModal で当てる（public/styles.css）。
    modal.className = "modal-backdrop";
    modal.id = "coverZoomModal";
    modal.innerHTML =
      '<div class="modal" aria-label="表紙の拡大表示">' +
      '<button type="button" class="cz-close" aria-label="閉じる">×</button>' +
      '<figure class="cz-figure">' +
      '<img class="cz-img" id="czImg" alt="">' +
      '<figcaption class="cz-caption">' +
      '<span class="cz-credit" id="czCredit"></span>' +
      '<span class="cz-source" id="czSource"></span>' +
      "</figcaption>" +
      "</figure></div>";
    document.body.appendChild(modal);
    imgEl = modal.querySelector("#czImg");
    creditEl = modal.querySelector("#czCredit");
    sourceEl = modal.querySelector("#czSource");
    // どこを押しても閉じる（拡大表示に他の操作は無く、書きかけの入力も無い）。背景クリックを
    // サイト全体で止めている ui-dialog.js には、この印で例外にしてもらう。
    modal.setAttribute("data-backdrop-close", "");
    modal.addEventListener("click", close);
    return modal;
  }

  function close() {
    seq++;
    if (modal) modal.classList.remove("open");
  }

  window.openCoverZoom = function (opts) {
    opts = opts || {};
    if (!opts.src) return;
    ensureModal();
    var mine = ++seq;
    imgEl.alt = opts.title ? opts.title + " の表紙" : "表紙";
    imgEl.src = opts.src; // 詳細に出ているものと同じ URL＝読み込み済みなのですぐ出る
    current = opts;
    renderCredit();
    var big = largerSrc(opts.coverUrl || opts.src);
    if (big) {
      var probe = new Image();
      probe.onload = function () {
        if (mine === seq) imgEl.src = big;
      };
      probe.src = big;
    }
    modal.classList.add("open");
  };

  // 開いたまま詳細（/api/book）が返ったときに呼ぶ。閉じていれば何もしない。
  window.refreshCoverZoomCredit = function () {
    if (modal && modal.classList.contains("open")) renderCredit();
  };

  window.attachCoverZoom = function (img, opts) {
    opts = opts || {};
    img.classList.add("cz-zoomable");
    img.setAttribute("role", "button");
    img.setAttribute("tabindex", "0");
    img.setAttribute("aria-label", (opts.title ? opts.title + " の" : "") + "表紙を拡大");
    var open = function () {
      window.openCoverZoom({
        src: img.currentSrc || img.src, // /cover 経由（トリミング済み）ならそちら
        coverUrl: opts.coverUrl || img.src,
        isbn: opts.isbn,
        title: opts.title,
        meta: opts.meta,
      });
    };
    img.addEventListener("click", open);
    img.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  };
})();
