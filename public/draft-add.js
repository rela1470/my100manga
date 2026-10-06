"use strict";

// ランキング系ページ（/ranking・/sales-ranking・/circulation）の巻一覧から、トップ
// （エディタ）へ移動せずに「自分の100」へ本を足すための、下書きの最小操作。
//
// トップ（public/app.js）は作成中のリストを state.items にメモリで持ち、saveDraft() で
// localStorage の新規作成の下書き（my100manga_draft_v1）へ書く。こちらはページが別なので
// state を持てない。呼ばれるたびに下書きを読み、足して、書き戻す。ログイン中なら
// /api/me/draft にも送って端末間で続きを作れるようにする（app.js の pushServerDraft と
// 同じ。匿名だと 401 が返るので、一度返ってきたらそのページでは送るのをやめる）。
//
// 公開済みリストの編集中の下書き（my100manga_draft_v1_edit_<slug>）には足さない。編集
// セッションはトップのタブの sessionStorage にしかなく、ランキングページからはどのリストを
// 編集中なのか分からないため。ここからの追加は常に「作成中のリスト」に入る。
//
// window.Draft.has(isbn) / count() / add(books) → { added, skipped, overflow, total, failed }
//   books: { isbn, title, author, cover_url } の配列（comment/spoiler はトップで付ける）
(function () {
  const DRAFT_KEY = "my100manga_draft_v1"; // public/app.js と同じ
  const MAX_ITEMS = 1000; // public/app.js MAX_ITEMS と同じ

  let serverDraftOff = false; // 匿名（401）と分かったら PUT をやめる

  // public/app.js toIsbn13 と同じ。下書きの中の重複判定がずれないよう ISBN-13 に揃える。
  function toIsbn13(raw) {
    const s = String(raw || "").replace(/[^0-9Xx]/g, "").toUpperCase();
    if (/^\d{13}$/.test(s)) return s;
    if (/^\d{9}[\dX]$/.test(s)) {
      const core = "978" + s.slice(0, 9);
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(core[i]);
      return core + ((10 - (sum % 10)) % 10);
    }
    return String(raw || "");
  }

  function read() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (!d || typeof d !== "object") return { owner: "", bio: "", items: [] };
      return {
        owner: d.owner || "",
        bio: d.bio || "",
        items: Array.isArray(d.items) ? d.items.filter(Boolean) : [],
      };
    } catch (e) {
      return { owner: "", bio: "", items: [] };
    }
  }

  // 書けたら true。localStorage が使えない（プライベートモード等）ときは false を返して
  // 呼び出し側に「追加できなかった」と出してもらう。
  function write(draft) {
    const payload = {
      owner: draft.owner,
      bio: draft.bio,
      items: draft.items,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    } catch (e) {
      return false;
    }
    pushServerDraft(payload);
    return true;
  }

  // ログイン中のアカウントの下書き（1 件）に反映する。サーバ側は savedAt が古い上書きを
  // 無視するので、トップのタブと競合しても新しい方が残る（src/account.ts）。
  function pushServerDraft(payload) {
    if (serverDraftOff) return;
    fetch("/api/me/draft", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (res.status === 401 || res.status === 403) serverDraftOff = true;
      })
      .catch(() => {});
  }

  function has(isbn) {
    const key = toIsbn13(isbn);
    if (!key) return false;
    return read().items.some((it) => toIsbn13(it.isbn) === key);
  }

  function count() {
    return read().items.length;
  }

  // public/app.js の selectVolume / bulkAddSeries と同じ扱い: ISBN が同じものは足さない
  // （ISBN の無い本どうしは重複とみなさない）、上限を超えた分は足さない。
  function add(books) {
    const d = read();
    const before = d.items.length;
    const existing = new Set(d.items.map((it) => toIsbn13(it.isbn)).filter(Boolean));
    const fresh = [];
    let skipped = 0;
    for (const b of books || []) {
      const isbn = toIsbn13(b.isbn);
      if (isbn && existing.has(isbn)) {
        skipped++;
        continue;
      }
      if (isbn) existing.add(isbn);
      fresh.push({
        isbn,
        title: b.title || "",
        author: b.author || "",
        cover_url: b.cover_url || "",
        comment: "",
        spoiler: false,
      });
    }
    const room = Math.max(0, MAX_ITEMS - before);
    const toAdd = fresh.slice(0, room);
    const overflow = fresh.length - toAdd.length;
    if (!toAdd.length) return { added: 0, skipped, overflow, total: before, failed: false };
    d.items = d.items.concat(toAdd);
    if (!write(d)) return { added: 0, skipped, overflow, total: before, failed: true };
    return { added: toAdd.length, skipped, overflow, total: d.items.length, failed: false };
  }

  window.Draft = { has, count, add, MAX_ITEMS, toIsbn13 };
})();
