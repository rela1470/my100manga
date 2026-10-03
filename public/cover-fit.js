// Route Yahoo!ショッピング covers through our /cover endpoint, which trims the
// white bars baked into 正方形 seller images (notably netoff) server-side and
// persists the result in R2. もったいない本舗 (楽天市場) covers go the same way to
// have their logo frame cropped off. We can't trim in the browser: Yahoo's CDN sends no
// CORS headers, so a canvas read would taint. And object-fit alone can't remove
// bars this wide (~30% a side) on a 3:4 frame.
//
// Primary path is applyCover() below: renderers point a Yahoo cover's src straight
// at /cover, so the untrimmed original is never fetched. The MutationObserver at the
// bottom is only a fallback for any Yahoo <img> that slipped through with a raw src
// (it pre-loads /cover then swaps, which leaves a canceled original request — the
// very thing applyCover exists to avoid). First ever /cover view triggers the
// server-side trim (~1s); after that it's served from R2/edge instantly.
(function () {
  var COVER_CLASSES = ["cover", "dcover", "di-cover", "corr-thumb"];

  function isCoverImg(el) {
    if (!el || el.tagName !== "IMG") return false;
    for (var i = 0; i < COVER_CLASSES.length; i++) {
      if (el.classList.contains(COVER_CLASSES[i])) return true;
    }
    // Cover-picker candidates are bare <img> inside a .cand button.
    if (el.parentElement && el.parentElement.classList.contains("cand")) return true;
    return false;
  }

  // もったいない本舗's 楽天 storefronts frame the cover with a logo band + mascot; /cover
  // crops it out (src/covertrim.ts trimShopFrame). Same list as MOTTAINAI_PATH in src/index.ts.
  var MOTTAINAI_RE = /^\/@0_mall\/(comicset|mottainaihonpo|mottainaihonpo-omatome)\/cabinet\//;

  // Covers served through /cover: Yahoo (white bars) and もったいない本舗 (logo frame).
  function needsTrim(src) {
    var u;
    try { u = new URL(src, location.href); } catch (e) { return false; }
    if (/(^|\.)yimg\.jp$/.test(u.hostname)) return true;
    return u.hostname === "thumbnail.image.rakuten.co.jp" && MOTTAINAI_RE.test(u.pathname);
  }

  // Primary path: renderers call this instead of `img.src = url` so a Yahoo cover
  // points straight at /cover (trimmed, R2-backed) and the untrimmed original is
  // never requested by the browser. Setting the raw original first and swapping
  // later (the MutationObserver path below) leaves a *canceled* fetch to Yahoo's
  // CDN on every view — enough of those looks like abuse and risks a block.
  // Marking cfDone lets the observer skip elements already handled here.
  window.applyCover = function (img, url) {
    if (url && needsTrim(url)) {
      img.dataset.cfDone = "1";
      img.src = "/cover?u=" + encodeURIComponent(url);
    } else {
      img.src = url;
    }
  };

  // 表紙 1 枚の要素。URL があれば <img>（読み込み失敗でプレースホルダに差し替え）、無ければ
  // プレースホルダ。label はプレースホルダに出す文字（小さい枠では "" にする）。既定は title。
  window.coverPlaceholder = function (label) {
    var d = document.createElement("div");
    d.className = "cover placeholder";
    d.textContent = label || "";
    return d;
  };
  window.coverNode = function (url, title, label) {
    if (label === undefined) label = title;
    if (!url) return window.coverPlaceholder(label);
    var img = document.createElement("img");
    img.className = "cover";
    img.loading = "lazy";
    img.alt = title || "";
    img.onerror = function () { img.replaceWith(window.coverPlaceholder(label)); };
    window.applyCover(img, url);
    return img;
  };

  // ISBN → 表紙 URL を /api/covers で引く（失敗時は {}）。cacheOnly はサイト共通の表紙
  // キャッシュだけを読む（ストア API を叩かない）。エディタの取得待ち列つきの呼び出しは
  // app.js の fetchCovers が別に持つ。
  window.lookupCovers = function (isbns, opts) {
    var uniq = Array.from(new Set((isbns || []).filter(Boolean))).slice(0, 400);
    if (!uniq.length) return Promise.resolve({});
    var body = { isbns: uniq };
    if (opts && opts.cacheOnly) body.cache_only = true;
    return fetch("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (data) { return data.covers || {}; })
      .catch(function () { return {}; });
  };

  function consider(img) {
    if (!isCoverImg(img) || img.dataset.cfDone) return;
    var src = img.currentSrc || img.src;
    if (!src || !needsTrim(src)) return;
    img.dataset.cfDone = "1";
    var trimmed = "/cover?u=" + encodeURIComponent(src);
    var probe = new Image();
    probe.onload = function () {
      // Swap to the trimmed cover; frames use object-fit:contain so it's never clipped.
      img.src = trimmed;
    };
    probe.src = trimmed; // onerror: leave the original in place
  }

  function scanRoot(root) {
    if (root.tagName === "IMG") { consider(root); return; }
    if (root.querySelectorAll) {
      var imgs = root.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) consider(imgs[i]);
    }
  }

  function start() {
    scanRoot(document);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) scanRoot(added[j]);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
