"use strict";

// Registry of lists published from THIS browser, so a creator who lost their
// edit link can still recover it: we keep {slug, token} locally on create and
// update. The edit_token is a capability that was already exposed in the edit
// URL/history of this same browser, so storing it in same-origin localStorage
// adds no new exposure. Never sent anywhere new.
(function () {
  const KEY = "my100manga_mylists_v1";

  function readAll() {
    try {
      const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(arr) ? arr.filter((r) => r && r.slug && r.token) : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) {}
  }

  window.MyLists = {
    all() {
      return readAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    get(slug) {
      return readAll().find((r) => r.slug === slug) || null;
    },
    save({ slug, token, owner }) {
      if (!slug || !token) return;
      const arr = readAll();
      const rec = { slug, token, owner: owner || "", updatedAt: Date.now() };
      const i = arr.findIndex((r) => r.slug === slug);
      if (i >= 0) arr[i] = rec;
      else arr.push(rec);
      writeAll(arr);
    },
    remove(slug) {
      writeAll(readAll().filter((r) => r.slug !== slug));
    },
  };
})();
