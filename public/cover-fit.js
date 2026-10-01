// Route Yahoo!ショッピング covers through our /cover endpoint, which trims the
// white bars baked into 正方形 seller images (notably netoff) server-side and
// persists the result in R2. We can't trim in the browser: Yahoo's CDN sends no
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

  function isYahoo(src) {
    var host;
    try { host = new URL(src, location.href).hostname; } catch (e) { return false; }
    return /(^|\.)yimg\.jp$/.test(host);
  }

  // Primary path: renderers call this instead of `img.src = url` so a Yahoo cover
  // points straight at /cover (trimmed, R2-backed) and the untrimmed original is
  // never requested by the browser. Setting the raw original first and swapping
  // later (the MutationObserver path below) leaves a *canceled* fetch to Yahoo's
  // CDN on every view — enough of those looks like abuse and risks a block.
  // Marking cfDone lets the observer skip elements already handled here.
  window.applyCover = function (img, url) {
    if (url && isYahoo(url)) {
      img.dataset.cfDone = "1";
      img.src = "/cover?u=" + encodeURIComponent(url);
    } else {
      img.src = url;
    }
  };

  function consider(img) {
    if (!isCoverImg(img) || img.dataset.cfDone) return;
    var src = img.currentSrc || img.src;
    if (!src || !isYahoo(src)) return;
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
