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

  // 楽天市場の表紙候補に出てくる主な店舗（src/ichiba.ts SHOP_RANK と同じ顔ぶれ）。
  var RAKUTEN_SHOPS = {
    bookoffonline: "ブックオフ 楽天市場店",
    "surugaya-a-too": "駿河屋 楽天市場店",
    comicset: "もったいない本舗 楽天市場店",
    mottainaihonpo: "もったいない本舗 楽天市場店",
    "mottainaihonpo-omatome": "もったいない本舗 楽天市場店",
  };
  var MOTTAINAI = { comicset: 1, mottainaihonpo: 1, "mottainaihonpo-omatome": 1 };

  // 楽天市場の出品ページ。画像 URL から商品ページを組み立てられる店はそこへ、他は ISBN 検索へ。
  //   ブックオフ: 画像ファイル名 0016309421l.jpg の末尾 l を除いたものが商品番号
  //   もったいない本舗: 商品番号が ISBN-10
  function rakutenShopUrl(shop, path, isbn) {
    if (shop === "bookoffonline") {
      var m = path.match(/\/(\d+)l\.jpg$/i);
      if (m) return "https://item.rakuten.co.jp/bookoffonline/" + m[1] + "/";
    }
    var i10 = toIsbn10(isbn);
    if (MOTTAINAI[shop] && i10) return "https://item.rakuten.co.jp/" + shop + "/" + i10 + "/";
    var s = cleanIsbn(isbn);
    return s ? "https://search.rakuten.co.jp/search/mall/" + encodeURIComponent(s) + "/" : "";
  }

  // 楽天ブックスの該当巻（ISBN 検索）へのアフィリエイトリンク。あらすじの出典表記から
  // 原典へ送るのに使う（public/book-detail.js）。アフィリ ID 未設定なら素の検索 URL。
  window.rakutenBookLink = function (item) {
    return rakutenPrint(item);
  };

  // アフィリエイトリンクの横に出す「PR」の印（ステマ規制）。購入リンクの見出しと同じ見た目。
  // 購入リンクのまとまりの外に置くアフィリンク（あらすじの出典・画像参考元）に付ける。
  // アフィリ ID が 1 つも入っていないとき（dev、および外部ストアを使わない R18版）は、
  // リンクが素の URL で広告ではないので null を返す。R18版の利用規約が「広告は一切ありません」
  // と言っているので、ここで PR が出てしまうと規約と食い違う。
  window.prLabel = function () {
    var a = aff();
    if (!a.amazon && !a.rakuten && !a.mercari && !a.yahooSid) return null;
    var el = document.createElement("span");
    el.className = "pr-label";
    el.textContent = "PR";
    return el;
  };

  // 本の詳細ポップアップの行（エディタ app.js・閲覧 view.js 共通）。値が無ければ行ごと隠す。
  window.setMetaRow = function (rowId, valueId, text) {
    var has = !!text;
    document.getElementById(rowId).style.display = has ? "" : "none";
    if (has) document.getElementById(valueId).textContent = text;
  };
  // 「画像参考元」の行。coverSourceLink の結果を出し、リンク先があればアフィリンクにする。
  window.setSourceRow = function (rowId, valueId, coverUrl, isbn) {
    var src = window.coverSourceLink(coverUrl, isbn);
    document.getElementById(rowId).style.display = src ? "" : "none";
    if (!src) return;
    var dd = document.getElementById(valueId);
    dd.textContent = "";
    if (!src.url) {
      dd.textContent = src.label;
      return;
    }
    var a = document.createElement("a");
    a.href = src.url;
    a.target = "_blank";
    a.rel = "noopener sponsored nofollow";
    a.textContent = src.label;
    dd.appendChild(a);
    var pr = window.prLabel();
    if (pr) dd.appendChild(pr);
  };

  // 「画像参考元」: which site a cover image comes from, inferred from its URL, plus a
  // link to where it's listed (affiliate-wrapped like the buy links when ids are set).
  // { label, url } — url "" when there's nothing sensible to link to; null when no cover.
  window.coverSourceLink = function (coverUrl, isbn) {
    if (!coverUrl) return null;
    var u;
    try { u = new URL(coverUrl, location.href); } catch (e) { return null; }
    var host = u.hostname, path = u.pathname;
    var s = cleanIsbn(isbn);
    if (/rakuten|r10s/.test(host)) {
      // 楽天の画像ホストは全ショップ共通。パスの /@0_mall/<店舗コード>/ で出品元を見分ける。
      var shop = (path.match(/^\/@0_mall\/([^/]+)\//) || [])[1] || "";
      if (shop === "book") {
        return {
          label: "楽天ブックス",
          url: s ? rakutenWrap("https://books.rakuten.co.jp/search?sitem=" + encodeURIComponent(s)) : "",
        };
      }
      var target = rakutenShopUrl(shop, path, isbn);
      return { label: RAKUTEN_SHOPS[shop] || "楽天市場", url: target ? rakutenWrap(target) : "" };
    }
    if (/yimg|yahoo/.test(host)) {
      // 画像 ID は "<ストアID>_<商品コード>"（/i/l/ggking_9784081150625）→ ストアの商品ページ。
      var id = (path.match(/\/i\/[a-z]\/([a-z0-9-]+)_([^/]+)$/i) || []);
      var page = id[1]
        ? "https://store.shopping.yahoo.co.jp/" + id[1] + "/" + id[2] + ".html"
        : s ? "https://shopping.yahoo.co.jp/search?p=" + encodeURIComponent(s) : "";
      var vc = yahooVc();
      return {
        label: "Yahoo!ショッピング",
        url: page && vc
          ? "https://ck.jp.ap.valuecommerce.com/servlet/referral?" + vc + "&vc_url=" + encodeURIComponent(page)
          : page,
      };
    }
    if (/google/.test(host)) {
      return { label: "Google Books", url: s ? "https://books.google.com/books?vid=ISBN" + s : "" };
    }
    return { label: host, url: "" };
  };

  // Returns the buy links for an item, grouped by format. Print entries are
  // omitted when there's nothing to search (no isbn and no title).
  window.buildBuyLinks = function (item) {
    // R18版（src/site.ts の commerce: false）は購入リンクを一切出さない。__SITE__ は
    // src/analytics.ts の analyticsTags が全ページに差し込む。旧いキャッシュの HTML には
    // commerce が無いことがあるので、明示的に false のときだけ止める（本家を巻き込まない）。
    if (window.__SITE__ && window.__SITE__.commerce === false) return [];
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
