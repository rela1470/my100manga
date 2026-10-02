"use strict";

// Builds Amazon / 楽天 / Yahoo! / メルカリ purchase links for a list item. Reads affiliate ids from
// window.__AFF__ ({ amazon, rakuten }), injected by the Worker on /l/:slug.
// Everything degrades gracefully: no isbn → title search; no affiliate id →
// plain (untagged) link that still opens the right store.
//
// Many older manga volumes are 絶版 (out of print) in paper, so we always offer
// an 電子書籍 (Kindle / 楽天Kobo) option alongside the paper one — the e-book is
// usually still buyable even when the print edition is gone.
(function () {
  function aff() {
    var a = window.__AFF__ || {};
    return {
      amazon: a.amazon || "",
      rakuten: a.rakuten || "",
      mercari: a.mercari || "",
      yahooSid: a.yahooSid || "",
      yahooPid: a.yahooPid || "",
    };
  }

  // "978-4-08-xxxxxx-x" → "9784080000000"; keeps a trailing X for ISBN-10.
  function cleanIsbn(isbn) {
    return String(isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  }

  // Amazon books use the ISBN-10 as the ASIN, so /dp/<isbn10> is a direct product
  // link. Convert 978-prefixed ISBN-13s; 979-prefixed ones have no ISBN-10 (return
  // "" so callers fall back to search).
  function toIsbn10(isbn) {
    var s = cleanIsbn(isbn);
    if (s.length === 10) return s;
    if (s.length === 13 && s.slice(0, 3) === "978") {
      var core = s.slice(3, 12);
      var sum = 0;
      for (var i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
      var check = (11 - (sum % 11)) % 11;
      return core + (check === 10 ? "X" : String(check));
    }
    return "";
  }

  function q(item) {
    // Titles already carry the volume number ("ワカコ酒（27）"), so the title alone
    // is a good store query.
    return String(item && item.title ? item.title : "").trim();
  }

  function amazonPrint(item) {
    var tag = aff().amazon;
    var isbn10 = toIsbn10(item && item.isbn);
    var tagQs = tag ? "?tag=" + encodeURIComponent(tag) : "";
    if (isbn10) return "https://www.amazon.co.jp/dp/" + isbn10 + "/" + tagQs;
    var p = new URLSearchParams({ k: q(item), i: "stripbooks" });
    if (tag) p.set("tag", tag);
    return "https://www.amazon.co.jp/s?" + p.toString();
  }

  function amazonKindle(item) {
    var tag = aff().amazon;
    var p = new URLSearchParams({ k: q(item), i: "digital-text" });
    if (tag) p.set("tag", tag);
    return "https://www.amazon.co.jp/s?" + p.toString();
  }

  // Wrap a target URL in the Rakuten affiliate redirect. Without an affiliate id
  // we just return the target unchanged.
  function rakutenWrap(target) {
    var id = aff().rakuten;
    if (!id) return target;
    var enc = encodeURIComponent(target);
    return "https://hb.afl.rakuten.co.jp/hgc/" + id + "/?pc=" + enc + "&m=" + enc;
  }

  function rakutenPrint(item) {
    var isbn = cleanIsbn(item && item.isbn);
    var term = isbn || q(item);
    // 楽天ブックス（紙の本）検索。ISBN があれば一発で該当巻に当たる。
    return rakutenWrap("https://books.rakuten.co.jp/search?sitem=" + encodeURIComponent(term));
  }

  function rakutenKobo(item) {
    // 楽天Kobo（電子書籍）検索。g=101 が電子書籍ジャンル。ISBN は紙版のものなので
    // 電子版はタイトルで検索する。
    var p = new URLSearchParams({ sitem: q(item), g: "101" });
    return rakutenWrap("https://books.rakuten.co.jp/search?" + p.toString());
  }

  // Yahoo!ショッピング（紙）。バリューコマースの自由テキストリンクに vc_url で遷移先を
  // 渡すと任意ページへのアフィリンクになる。ISBN は JAN と同じなので検索で該当巻に当たる。
  // sid/pid 未設定なら素の検索URL。
  function yahooVc() {
    var a = aff();
    if (!a.yahooSid || !a.yahooPid) return "";
    return "sid=" + encodeURIComponent(a.yahooSid) + "&pid=" + encodeURIComponent(a.yahooPid);
  }

  function yahooPrint(item) {
    var term = cleanIsbn(item && item.isbn) || q(item);
    var target = "https://shopping.yahoo.co.jp/search?p=" + encodeURIComponent(term);
    var vc = yahooVc();
    if (!vc) return target;
    return "https://ck.jp.ap.valuecommerce.com/servlet/referral?" + vc + "&vc_url=" + encodeURIComponent(target);
  }

  // バリューコマースのインプレッション計測用 1x1 ビーコン（広告コードに同梱されているもの）。
  function yahooPixel() {
    var vc = yahooVc();
    return vc ? "https://ad.jp.ap.valuecommerce.com/servlet/gifbanner?" + vc : "";
  }

  // 中古（絶版の紙をどうしても紙で欲しい人向け）。メルカリアンバサダーの afid を
  // 付けた検索ページへ飛ばす。ISBN では中古出品が引きにくいのでタイトル検索。
  // afid 未設定なら素の検索URL。
  function mercariUsed(item) {
    var p = new URLSearchParams({ keyword: q(item) });
    var id = aff().mercari;
    if (id) p.set("afid", id);
    return "https://jp.mercari.com/search?" + p.toString();
  }

  // Returns the buy links for an item, grouped by format. Print entries are
  // omitted when there's nothing to search (no isbn and no title).
  window.buildBuyLinks = function (item) {
    var hasQuery = Boolean(q(item) || cleanIsbn(item && item.isbn));
    if (!hasQuery) return [];
    var links = [
      { format: "print", label: "Amazon（紙）", store: "amazon", url: amazonPrint(item) },
      { format: "print", label: "楽天ブックス（紙）", store: "rakuten", url: rakutenPrint(item) },
      { format: "print", label: "Yahoo!ショッピング（紙）", store: "yahoo", url: yahooPrint(item), pixel: yahooPixel() },
      { format: "ebook", label: "Kindle（電子）", store: "amazon", url: amazonKindle(item) },
      { format: "ebook", label: "楽天Kobo（電子）", store: "rakuten", url: rakutenKobo(item) },
    ];
    // メルカリはタイトルが無いと検索にならないので、タイトルがあるときだけ出す。
    if (q(item)) {
      links.push({ format: "used", label: "メルカリ（中古）", store: "mercari", url: mercariUsed(item) });
    }
    return links;
  };
})();
