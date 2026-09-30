"use strict";

const TARGET = 100; // must have exactly this many to publish
const MAX_ITEMS = 1000; // soft cap while curating (drafts are localStorage-only, so this is safe)
const DRAFT_KEY = "my100manga_draft_v1";

// A Worker restart mid-request (wrangler dev hot-reload) or an origin failure can
// return a non-JSON body — e.g. the plain-text "Your worker restarted…" 503 — which
// res.json() surfaces as a cryptic "Unexpected token" parse error. Swallow the parse
// failure so callers fall back to res.ok and show a clean, actionable message.
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

const state = {
  owner: "",
  items: [], // dynamic list of {isbn,title,author,cover_url,comment,spoiler}
  editIndex: -1, // -1 = adding a new item; >=0 = editing items[editIndex]
  pending: null, // selected book before saving
  fixIndex: -1, // -1 = not in guided missing-cover mode; >=0 = fixing items[fixIndex]
  editSlug: null, // set when editing an existing published list
  editToken: null,
  published: null, // {owner, items} snapshot of the server (公開) state, for diff/もとに戻す

  customSlug: "", // user-chosen slug for a new list ("" = random)
  fetchingCovers: false, // true while the "表紙を取得" bulk fill is running
  coverTried: new Set(), // isbns already fetched this session (miss or hit) — don't re-offer
  reorder: false, // true while in reorder mode (tap = select, not edit)
  selected: new Set(), // indices of cards picked to move; valid only between renders
  sortAsc: true, // direction the "名前順" button will apply next
};

const $ = (id) => document.getElementById(id);

/* ---------- init ---------- */
async function init() {
  const params = new URLSearchParams(location.search);
  const slug = params.get("edit");
  const token = params.get("t");
  if (slug && token) {
    await loadExisting(slug, token);
  } else {
    loadDraft();
  }
  render();
  renderMyLists();
  wireEvents();
}

/* ---------- "lists published from this browser" recovery section ---------- */
function renderMyLists() {
  const box = $("myLists");
  if (!box || !window.MyLists) return;
  // Hide the one we're currently editing — its edit link is already the page.
  const recs = window.MyLists.all().filter((r) => r.slug !== state.editSlug);
  box.innerHTML = "";
  if (!recs.length) { box.style.display = "none"; return; }
  box.style.display = "";

  const h = document.createElement("h2");
  h.className = "mylists-title";
  h.textContent = "このブラウザで公開したリスト";
  box.appendChild(h);

  const note = document.createElement("p");
  note.className = "mylists-note";
  note.textContent = "編集リンクを無くしても、ここから編集画面に戻れます。";
  box.appendChild(note);

  const ul = document.createElement("ul");
  ul.className = "mylists-list";
  recs.forEach((r) => {
    const li = document.createElement("li");

    const view = document.createElement("a");
    view.className = "ml-view";
    view.href = `/l/${r.slug}`;
    view.textContent = r.owner ? `${r.owner}さんの100作品` : "無題の100作品";

    const edit = document.createElement("a");
    edit.className = "ml-edit";
    edit.href = `/?edit=${r.slug}&t=${encodeURIComponent(r.token)}`;
    edit.textContent = "編集する";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "ml-del";
    del.textContent = "この端末から削除";
    del.title = "公開リストは消えません。この端末に保存した編集リンクだけを削除します。";
    del.addEventListener("click", () => {
      const name = r.owner ? `${r.owner}さんの100作品` : "無題の100作品";
      if (!confirm(`「${name}」の編集リンクをこの端末から削除します。\n公開リストは消えませんが、編集リンクを別で保存していないと二度と編集できなくなります。よろしいですか？`)) return;
      window.MyLists.remove(r.slug);
      renderMyLists();
    });

    li.appendChild(view);
    li.appendChild(edit);
    li.appendChild(del);
    ul.appendChild(li);
  });
  box.appendChild(ul);
}

function normItem(it) {
  return {
    isbn: it.isbn || "",
    title: it.title || "",
    author: it.author || "",
    cover_url: it.cover_url || "",
    comment: it.comment || "",
    spoiler: !!it.spoiler,
  };
}

async function loadExisting(slug, token) {
  try {
    const res = await fetch(`/api/lists/${slug}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    state.owner = data.owner_name || "";
    state.editSlug = slug;
    state.editToken = token;
    state.items = (data.items || []).map(normItem);
    // Snapshot the server (公開) state before any draft restore so we can show a
    // diff count and offer もとに戻す while editing.
    state.published = { owner: state.owner, items: state.items.map(normItem) };
    restoreEditDraft(slug, data.updated_at || 0);
  } catch (e) {
    alert("既存リストの読み込みに失敗しました。新規作成モードで開きます。");
  }
}

// If this browser has unsaved edits for `slug` (autosaved by saveDraft but never
// 更新-ed), restore them over the server copy so a reload doesn't lose the work.
// Only when the draft is newer than the server's last update — a successful 更新
// clears the draft, and a newer server updated_at (e.g. published from another
// device) should win, so the stale draft is discarded.
function restoreEditDraft(slug, serverUpdatedAt) {
  try {
    const raw = localStorage.getItem(editDraftKey(slug));
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || typeof d.savedAt !== "number" || d.savedAt <= serverUpdatedAt) {
      clearEditDraft(slug);
      return;
    }
    if (typeof d.owner === "string") state.owner = d.owner;
    if (Array.isArray(d.items)) state.items = d.items.filter(Boolean).map(normItem);
  } catch (e) {}
}

/* ---------- diff vs 公開状態 ---------- */
function itemsEqual(a, b) {
  if (!a || !b) return false;
  return a.isbn === b.isbn && a.title === b.title && a.author === b.author &&
    a.cover_url === b.cover_url && a.comment === b.comment && !!a.spoiler === !!b.spoiler;
}

// Identity of a book, so we can tell "the same book, edited" from "a different
// book". ISBN is the strong key; fall back to title+author for ISBN-less items.
function itemKey(it) {
  return it.isbn ? "i:" + it.isbn : "t:" + it.title + "" + it.author;
}

// How many entries differ from the last-published state. Uses an LCS over item
// identities so a delete/insert only counts the touched book(s) — not every book
// that shifted position after it. Counts = added + removed + content-changed
// (cover swap, comment, spoiler…) among books present in both, plus the display
// name if it changed. 0 = current view matches 公開状態.
function diffCount() {
  if (!state.editSlug || !state.published) return 0;
  const A = state.published.items, B = state.items;
  const ak = A.map(itemKey), bk = B.map(itemKey);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = ak[i] === bk[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, matched = 0, changed = 0;
  while (i < n && j < m) {
    if (ak[i] === bk[j]) {
      if (!itemsEqual(A[i], B[j])) changed++;
      matched++; i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  let count = (n - matched) + (m - matched) + changed; // removed + added + changed
  if ((state.published.owner || "") !== (state.owner || "")) count++;
  return count;
}

function renderEditDiff() {
  const bar = $("diffBar");
  if (!bar) return;
  const n = (state.editSlug && state.published) ? diffCount() : 0;
  if (n === 0) { bar.style.display = "none"; return; }
  bar.style.display = "";
  $("diffCount").textContent = `公開状態との差分：${n}件（未保存）`;
}

// Throw away in-progress edits and return to exactly what's published.
function revertToPublished() {
  if (!state.editSlug || !state.published || diffCount() === 0) return;
  if (!confirm("編集中の変更を破棄して、公開されている状態にもどします。よろしいですか？")) return;
  state.owner = state.published.owner || "";
  state.items = state.published.items.map(normItem);
  clearEditDraft(state.editSlug); // reverted view == server, so no unsaved draft
  render();
}

/* ---------- draft persistence ---------- */
// Edits to a published list are held only in memory until the user completes the
// two-step 更新 (公開ボタン → 更新する). A reload before that would silently drop the
// work (cover swaps, comments, reorders). So while editing we autosave to a
// slug-scoped draft and restore it on reload — see loadExisting. Cleared on a
// successful update. Kept separate from the new-list draft so neither clobbers
// the other.
function editDraftKey(slug) {
  return `${DRAFT_KEY}_edit_${slug}`;
}
function saveDraft() {
  try {
    if (state.editSlug) {
      localStorage.setItem(
        editDraftKey(state.editSlug),
        JSON.stringify({ owner: state.owner, items: state.items, savedAt: Date.now() })
      );
      return;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ owner: state.owner, items: state.items }));
  } catch (e) {}
}
function clearEditDraft(slug) {
  try {
    localStorage.removeItem(editDraftKey(slug));
  } catch (e) {}
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    state.owner = d.owner || "";
    // filter(Boolean) also migrates the old fixed-100 array (which stored nulls for empty slots).
    if (Array.isArray(d.items)) state.items = d.items.filter(Boolean).map(normItem);
  } catch (e) {}
}

/* ---------- grid ---------- */
function render() {
  const grid = $("grid");
  grid.innerHTML = "";
  grid.classList.toggle("reorder", state.reorder);
  state.items.forEach((it, i) => grid.appendChild(filledSlot(it, i)));
  // No adding while reordering — the add slot would confuse the "tap = select" mode.
  if (!state.reorder && state.items.length < MAX_ITEMS) grid.appendChild(addSlot(state.items.length));

  const filled = state.items.length;
  updatePublishButton(filled);
  renderReorderBar(filled);
  renderEditDiff();

  // Cover buttons are two-stage: first auto-fetch (表紙を取得) for items whose ISBN
  // hasn't been tried yet; once nothing is left to auto-fetch, offer manual specify
  // (表紙がない本を指定) for whatever's still missing (no ISBN, or Rakuten had none).
  const missing = state.items.filter((it) => !it.cover_url).length;
  const fetchable = state.items.filter((it) => !it.cover_url && it.isbn && !state.coverTried.has(it.isbn)).length;
  const fetchBtn = $("fetchCovers");
  const fixBtn = $("fixMissing");
  const showFetch = fetchable > 0 && !state.fetchingCovers;
  const showFix = !showFetch && missing > 0 && !state.fetchingCovers;
  fetchBtn.textContent = `表紙を取得（${fetchable}件）`;
  fetchBtn.style.display = showFetch ? "" : "none";
  fixBtn.textContent = `表紙がない本を指定（${missing}）`;
  fixBtn.style.display = showFix ? "" : "none";

  // The action row only takes space when it has something to show.
  $("actionBar").style.display = missing > 0 || state.fetchingCovers ? "" : "none";

  const clearBtn = $("clearAll");
  clearBtn.textContent = `編集中の漫画を全削除（${filled}）`;
  clearBtn.style.display = filled > 0 ? "" : "none";
}

function clearAll() {
  if (state.items.length === 0) return;
  if (!confirm(`編集中の${state.items.length}作品をすべて削除します。よろしいですか？`)) return;
  state.items = [];
  render();
  saveDraft();
}

// Progress counter and publish CTA are merged into one button: it only becomes
// an enabled "公開する" at exactly TARGET, otherwise it shows how far off you are.
function updatePublishButton(filled) {
  const btn = $("publish");
  const verb = state.editSlug ? "更新" : "公開";
  btn.disabled = filled !== TARGET;
  if (filled === TARGET) {
    btn.textContent = `${TARGET}作品を${verb}する ✓`;
    btn.className = "primary exact";
  } else if (filled < TARGET) {
    btn.textContent = `あと${TARGET - filled}作品（${filled} / ${TARGET}）`;
    btn.className = "primary";
  } else {
    btn.textContent = `${filled - TARGET}作品オーバー（${filled} / ${TARGET}）`;
    btn.className = "primary over";
  }
}

function addSlot(index) {
  const slot = document.createElement("button");
  slot.className = "slot empty";
  slot.appendChild(numBadge(index));
  const plus = document.createElement("span");
  plus.className = "plus";
  plus.textContent = "＋";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "追加";
  slot.appendChild(plus);
  slot.appendChild(label);
  slot.addEventListener("click", openAdd);
  return slot;
}

function filledSlot(it, i) {
  const slot = document.createElement("button");
  slot.className = "slot";
  // 公開はちょうど100作品まで。101番目以降（超過分）は赤く警告する。
  if (i >= TARGET) slot.classList.add("over-limit");
  slot.appendChild(numBadge(i));
  if (state.reorder) {
    const isSel = state.selected.has(i);
    if (isSel) slot.classList.add("selected");
    const check = document.createElement("span");
    check.className = "slot-check";
    check.textContent = "✓";
    slot.appendChild(check);
    // Insertion caret on the leading edge: appears only once something is selected,
    // and never on a selected card (you can't drop a card before itself). Tapping it
    // moves the whole selection to just before this card.
    if (state.selected.size > 0 && !isSel) {
      const caret = document.createElement("span");
      caret.className = "ins-caret";
      caret.title = "ここに挿入（この前に移動）";
      caret.setAttribute("aria-label", `${i + 1}番目の前に移動`);
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        moveSelectedBefore(i);
      });
      slot.appendChild(caret);
    }
    appendCoverMeta(slot, it);
    slot.addEventListener("click", () => toggleSelect(i));
    return slot;
  }
  const rm = document.createElement("span");
  rm.className = "slot-remove";
  rm.textContent = "×";
  rm.title = "削除";
  rm.setAttribute("aria-label", `${i + 1}番目を削除`);
  rm.addEventListener("click", (e) => {
    e.stopPropagation();
    removeAt(i);
  });
  slot.appendChild(rm);
  appendCoverMeta(slot, it);
  slot.addEventListener("click", () => openEdit(i));
  return slot;
}

// Cover, spoiler/comment badges and title/comment meta — shared by the normal and
// reorder renderings of a filled slot.
function appendCoverMeta(slot, it) {
  const badges = document.createElement("div");
  badges.className = "badges";
  if (it.spoiler) {
    const b = document.createElement("span");
    b.className = "badge badge-spoiler";
    b.textContent = "ネタバレ";
    badges.appendChild(b);
  }
  if (it.comment && !it.spoiler) {
    const b = document.createElement("span");
    b.className = "badge badge-comment";
    b.textContent = "コメントあり";
    badges.appendChild(b);
  }
  if (badges.children.length) slot.appendChild(badges);
  if (it.cover_url) {
    const img = document.createElement("img");
    img.className = "cover";
    img.loading = "lazy";
    img.src = it.cover_url;
    img.alt = it.title;
    img.onerror = () => { img.replaceWith(placeholderCover(it.title)); };
    slot.appendChild(img);
  } else {
    slot.appendChild(placeholderCover(it.title));
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = it.title;
  meta.appendChild(t);
  if (it.comment) {
    const c = document.createElement("div");
    c.className = "c";
    c.textContent = it.comment;
    meta.appendChild(c);
  }
  slot.appendChild(meta);
}

function removeAt(i) {
  state.items.splice(i, 1);
  render();
  saveDraft();
}

/* ---------- reorder mode ---------- */
function toggleReorder() {
  state.reorder = !state.reorder;
  state.selected.clear();
  render();
}

function toggleSelect(i) {
  if (state.selected.has(i)) state.selected.delete(i);
  else state.selected.add(i);
  render();
}

// Move every selected item to just before items[targetIndex], keeping the selection's
// own relative order. Selection indices are read against the pre-move array, so we
// resolve them to objects first, then rebuild around the (unselected) target.
function moveSelectedBefore(targetIndex) {
  if (state.selected.size === 0) return;
  const idx = [...state.selected].sort((a, b) => a - b);
  const picked = idx.map((i) => state.items[i]);
  const target = state.items[targetIndex]; // always unselected — caret isn't drawn on selected cards
  const rest = state.items.filter((_, i) => !state.selected.has(i));
  let pos = rest.indexOf(target);
  if (pos < 0) pos = rest.length;
  rest.splice(pos, 0, ...picked);
  finishMove(rest);
}

function moveSelectedToEnd(atStart) {
  if (state.selected.size === 0) return;
  const idx = [...state.selected].sort((a, b) => a - b);
  const picked = idx.map((i) => state.items[i]);
  const rest = state.items.filter((_, i) => !state.selected.has(i));
  finishMove(atStart ? picked.concat(rest) : rest.concat(picked));
}

function finishMove(next) {
  state.items = next;
  state.selected.clear();
  render();
  saveDraft();
}

// Bulk sort the whole list by title. Toggles direction each press. Confirms first,
// since it discards any manual arrangement (which can't be recovered).
function sortByName() {
  if (state.items.length < 2) return;
  if (!confirm("現在の並び順を破棄して、作品名で並べ替えます。よろしいですか？")) return;
  const dir = state.sortAsc ? 1 : -1;
  const coll = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  state.items.sort((a, b) => dir * coll.compare(a.title || "", b.title || ""));
  state.sortAsc = !state.sortAsc;
  finishMove(state.items);
}

function renderReorderBar(filled) {
  const toggle = $("reorderToggle");
  // Nothing to reorder with fewer than 2 items.
  toggle.style.display = filled >= 2 ? "" : "none";
  toggle.textContent = state.reorder ? "並べ替えを終了" : "並べ替え";
  toggle.classList.toggle("active", state.reorder);

  const bar = $("reorderControls");
  bar.style.display = state.reorder ? "" : "none";
  if (!state.reorder) return;

  const n = state.selected.size;
  const count = $("reorderCount");
  count.textContent = n === 0
    ? "動かしたい作品をタップで選択"
    : `${n}件を選択中 ・ 挿入したい位置（カード左端）をタップ`;
  for (const id of ["moveStart", "moveEnd", "reorderClear"]) $(id).disabled = n === 0;
  $("sortName").textContent = state.sortAsc ? "名前順 ↓" : "名前順 ↑";
}

function numBadge(index) {
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(index + 1);
  return num;
}

function placeholderCover(title) {
  const d = document.createElement("div");
  d.className = "cover placeholder";
  d.textContent = title;
  return d;
}

/* ---------- edit slot modal ---------- */
function openEdit(index) { openModal(index); }
function openAdd() { openModal(-1); }

function openModal(index) {
  state.editIndex = index;
  state.pending = null;
  $("searchInput").value = "";
  $("results").innerHTML = "";
  $("comment").value = "";
  $("spoiler").checked = false;
  const existing = index >= 0 ? state.items[index] : null;
  if (existing) {
    $("editTitle").textContent = `${index + 1}番目の作品`;
    state.pending = { ...existing };
    showSelected(existing);
    $("comment").value = existing.comment || "";
    $("spoiler").checked = !!existing.spoiler;
    $("removeSlot").style.display = "";
    $("saveSlot").disabled = false;
    $("saveSlot").textContent = "更新する";
  } else {
    $("editTitle").textContent = "作品を追加";
    $("selectedBox").style.display = "none";
    $("removeSlot").style.display = "none";
    $("saveSlot").disabled = true;
    $("saveSlot").textContent = "追加する";
  }
  $("editModal").classList.add("open");
  $("searchInput").focus();
}

function showSelected(book) {
  const box = $("selectedBox");
  box.style.display = "";
  $("selectedLabel").textContent = book.author ? `選択中: ${book.title} / ${book.author}` : `選択中: ${book.title}`;
  renderSelCover(book);
}

function renderSelCover(book) {
  const thumb = $("selCoverThumb");
  thumb.innerHTML = "";
  if (book.cover_url) {
    const img = document.createElement("img");
    img.src = book.cover_url;
    img.alt = book.title;
    img.onerror = () => { img.replaceWith(noimg()); };
    thumb.appendChild(img);
  } else {
    thumb.appendChild(noimg());
  }
}

/* ---------- cover picker ---------- */
// Shared loader: opens the picker modal and fills it with cover candidates for `it`.
async function loadCandidates(it) {
  $("candGrid").innerHTML = "";
  $("urlInput").value = "";
  $("coverSearch").value = it.title || "";
  $("pickModal").classList.add("open");
  $("pickSpinner").style.display = "";
  try {
    const qs = new URLSearchParams();
    if (it.isbn) qs.set("isbn", it.isbn);
    if (it.title) qs.set("title", it.title);
    const res = await fetch(`/api/cover-candidates?${qs.toString()}`);
    const data = await res.json();
    renderCandidates(data.candidates || []);
  } catch (e) {
    renderCandidates([]);
  } finally {
    $("pickSpinner").style.display = "none";
  }
}

// Re-run the picker with an owner-typed keyword (`q`): literal Rakuten search,
// bypassing the auto title-broadening that surfaces unrelated books.
async function runCoverSearch() {
  const q = $("coverSearch").value.trim();
  if (!q) return;
  $("candGrid").innerHTML = "";
  $("pickSpinner").style.display = "";
  try {
    const res = await fetch(`/api/cover-candidates?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderCandidates(data.candidates || []);
  } catch (e) {
    renderCandidates([]);
  } finally {
    $("pickSpinner").style.display = "none";
  }
}

// From the edit modal: edits the in-progress selection (state.pending).
async function openCoverPicker() {
  if (!state.pending) return;
  state.fixIndex = -1;
  $("skipFix").style.display = "none";
  const it = state.pending;
  $("pickTitle").textContent = it.isbn ? `${it.title}（ISBN: ${it.isbn}）` : it.title;
  await loadCandidates(it);
}

/* ---------- guided missing-cover flow ---------- */
function startFixMissing() {
  const first = state.items.findIndex((it) => !it.cover_url);
  if (first < 0) { alert("表紙がない本はありません。"); return; }
  openFixPicker(first);
}

async function openFixPicker(index) {
  state.fixIndex = index;
  state.pending = null;
  $("skipFix").style.display = "";
  const it = state.items[index];
  const remaining = state.items.filter((x) => !x.cover_url).length;
  const base = it.isbn ? `${it.title}（ISBN: ${it.isbn}）` : it.title;
  $("pickTitle").textContent = `${index + 1}番目・${base} ／ 残り${remaining}件`;
  await loadCandidates(it);
}

// Advance to the next book (after `from`) that still has no cover; finish when none remain.
function advanceFix(from) {
  const next = state.items.findIndex((it, i) => i > from && !it.cover_url);
  if (next >= 0) { openFixPicker(next); return; }
  closeCoverPicker();
  alert("表紙がない本の指定が完了しました。");
}

function renderCandidates(cands) {
  const grid = $("candGrid");
  grid.innerHTML = "";
  if (cands.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "候補が見つかりませんでした。下のURL指定を使ってください。";
    grid.appendChild(p);
    return;
  }
  for (const c of cands) {
    const cell = document.createElement("button");
    cell.className = "cand";
    cell.type = "button";
    const img = document.createElement("img");
    img.src = c.src;
    img.alt = c.label;
    img.loading = "lazy";
    img.onerror = () => cell.remove();
    const srcTag = document.createElement("span");
    srcTag.className = "src";
    srcTag.textContent = c.source || "";
    const cap = document.createElement("span");
    cap.className = "cap";
    cap.textContent = c.label;
    cell.appendChild(img);
    cell.appendChild(srcTag);
    cell.appendChild(cap);
    cell.addEventListener("click", () => applyPickedCover(c.src));
    grid.appendChild(cell);
  }
}

function applyPickedCover(url) {
  if (state.fixIndex >= 0) {
    const it = state.items[state.fixIndex];
    suggestCover(it.isbn, url, it.cover_url);
    it.cover_url = url;
    saveDraft();
    render();
    advanceFix(state.fixIndex);
    return;
  }
  if (!state.pending) return;
  suggestCover(state.pending.isbn, url, state.pending.cover_url);
  state.pending.cover_url = url;
  renderSelCover(state.pending);
  $("saveSlot").disabled = false;
  closeCoverPicker();
}

// 「表紙を変更」で選び直した表紙は、このリストの items_json にしか保存されない（＝本人の
// リストにしか反映されない）。同じ本の正しい表紙を全体へ波及させるため、キャッシュと違う表紙を
// 選んだ瞬間に admin の承認キューへ送る。承認されると covers キャッシュが上書きされ、全リスト/
// シリーズ閲覧に反映される。ISBN の無い本（キャッシュのキーが無い）やクリア/無変更は送らない。
// 送信失敗は握りつぶす（表紙選択自体は成功させる）。
function suggestCover(isbn, url, prevUrl) {
  if (!isbn || !url || url === prevUrl) return;
  try {
    fetch("/api/cover-suggestions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbn, cover_url: url }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}

function closeCoverPicker() {
  $("pickModal").classList.remove("open");
  state.fixIndex = -1;
  $("skipFix").style.display = "none";
}

// Toolbar search: opens the add modal and runs the search with the typed query.
function topSearch() {
  const q = $("topSearch").value.trim();
  if (q.length < 2) { alert("2文字以上で検索してください"); return; }
  openAdd();
  $("searchInput").value = q;
  doSearch();
}

async function doSearch() {
  const q = $("searchInput").value.trim();
  if (q.length < 2) {
    alert("2文字以上で検索してください");
    return;
  }
  lastQuery = q;
  $("searchSpinner").style.display = "";
  $("results").innerHTML = "";
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "検索に失敗しました");
    renderResults(data.results || []);
  } catch (e) {
    $("results").innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = e.message || "検索に失敗しました";
    $("results").appendChild(p);
  } finally {
    $("searchSpinner").style.display = "none";
  }
}

let lastResults = [];
let lastQuery = "";

// Search returns series-level results. Clicking one drills into its volumes.
function renderResults(results) {
  lastResults = results;
  const box = $("results");
  box.innerHTML = "";

  // 常設: マスタ(月次ダンプ)に無い作品を live MADB からキーワードで取得する導線。
  // マスタ検索が0件でも手詰まりにならないよう、結果の有無にかかわらず先頭に出す。
  box.appendChild(buildLiveBar());

  if (results.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "見つかりませんでした。別の語か、上の「最新DBから取得」を試してください。";
    box.appendChild(p);
    return;
  }
  const pending = [];
  for (const r of results) box.appendChild(buildResultCard(r, pending));
  if (pending.length) {
    const bar = document.createElement("div");
    bar.className = "vol-bar";
    mountCoverFetch(bar, pending);
    box.insertBefore(bar, box.querySelector(".result"));
  }
}

// Keyword live-fetch bar shown atop every result set. Probes MADB SPARQL for the
// whole query (works absent from the master), dedupes against what's already shown,
// and merges the finds in as `live` cards.
function buildLiveBar() {
  const bar = document.createElement("div");
  bar.className = "vol-bar live-bar";
  const label = document.createElement("span");
  label.className = "hint";
  label.textContent = "見つからない / 巻が足りないとき:";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sup-btn";
  btn.textContent = `「${lastQuery}」を最新DBから取得`;
  btn.addEventListener("click", () => liveFetch(lastQuery, btn));
  bar.appendChild(label);
  bar.appendChild(btn);
  return bar;
}

function buildResultCard(r, pending) {
  const row = document.createElement("div");
  row.className = "result";
  let cell = coverImg(r.cover_url, r.title);
  row.appendChild(cell);
  const info = document.createElement("div");
  info.className = "info";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = r.title;
  if (r.live) {
    const badge = document.createElement("span");
    badge.className = "live-badge";
    badge.textContent = "最新DB";
    t.appendChild(badge);
  }
  const a = document.createElement("div");
  a.className = "a";
  a.textContent = [r.creator, r.publisher].filter(Boolean).join(" / ");
  info.appendChild(t);
  info.appendChild(a);
  if (r.volume_count) {
    const countDiv = document.createElement("div");
    countDiv.className = "a";
    // "＋" = 最新巻が未取得（server: unconfirmed）。開いて「最新巻を取得」で確定する。
    countDiv.textContent = r.unconfirmed ? `全${r.volume_count}巻＋` : `全${r.volume_count}巻`;
    if (r.unconfirmed) countDiv.title = "最新巻は未取得です。開いて「最新巻を取得」で確認できます";
    info.appendChild(countDiv);
  }
  row.appendChild(info);
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "›";
  row.appendChild(chev);
  row.addEventListener("click", () => openSeries(r));
  if (!r.cover_url && r.first_isbn) {
    pending.push({
      isbns: [r.first_isbn],
      set: (url) => { r.cover_url = url; const img = coverImg(url, r.title); cell.replaceWith(img); cell = img; },
    });
  }
  return row;
}

// Normalize like the server's name_norm (strip spaces, lowercase).
function normKey(s) {
  return (s || "").replace(/[\s　]+/g, "").toLowerCase();
}

// Find the on-screen card a live result should merge into. Both titles come from
// the same MADB schema:name, so exact normalized-title equality means "same series"
// — we do NOT key on creator, because multi-author works disagree on which name to
// show (e.g. 原作リュート vs 作画鍋島テツヒロ) and that spuriously blocked the merge.
// Creator only breaks ties when several distinct same-titled series are listed
// (新装版・総集編 等); failing that, the largest (canonical) one wins.
function findMergeTarget(existing, lr) {
  const t = normKey(lr.title);
  const same = existing.filter((r) => normKey(r.title) === t);
  if (same.length <= 1) return same[0] || null;
  const c = normKey(lr.creator);
  return same.find((r) => normKey(r.creator) === c) ||
    same.reduce((a, b) => (b.volume_count > a.volume_count ? b : a));
}

async function liveFetch(q, btn) {
  if (!q || q.length < 2) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "最新DBを検索中…";
  try {
    const res = await fetch(`/api/live-search?q=${encodeURIComponent(q)}`);
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "取得に失敗しました。少し待って再度お試しください。");
    const live = data.results || [];
    if (!live.length) {
      btn.disabled = false;
      btn.textContent = orig;
      alert("最新DBに該当するシリーズは見つかりませんでした。");
      return;
    }
    // 既存カード(マスタ由来)と一致した live 結果は「捨てず」に上書きマージする。live は
    // 全巻を持つので巻数・巻一覧をそちらへ差し替え、開くと埋め込み巻で全巻表示する。
    // 一致しなかったものだけ新規カードとして追加。
    const additions = [];
    for (const lr of live) {
      const ex = findMergeTarget(lastResults, lr);
      if (ex) {
        ex.volumes = lr.volumes;
        ex.volume_count = lr.volume_count;
        ex.unconfirmed = false;
        ex.live = true; // 以降は埋め込み巻で開く（サーバの部分的な一覧に戻さない）
        if (!ex.cover_url) ex.cover_url = lr.cover_url;
        if (!ex.first_isbn) ex.first_isbn = lr.first_isbn;
      } else if (!additions.some((a) => normKey(a.title) === normKey(lr.title))) {
        additions.push(lr);
      }
    }
    renderResults(lastResults.concat(additions));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    alert(e.message || "取得に失敗しました");
  }
}

function coverImg(url, alt) {
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = alt || "";
    img.loading = "lazy";
    img.onerror = () => { img.replaceWith(noimg()); };
    return img;
  }
  return noimg();
}

function noimg() {
  const d = document.createElement("div");
  d.className = "noimg";
  d.textContent = "No Image";
  return d;
}

// Lists come back with cache-only covers (instant). Uncached covers are resolved
// here in one background call so the list renders immediately and images fill in.
async function fetchCovers(isbns) {
  const uniq = [...new Set((isbns || []).filter(Boolean))];
  if (!uniq.length) return {};
  try {
    const res = await fetch("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns: uniq }),
    });
    if (!res.ok) return {};
    return (await res.json()).covers || {};
  } catch {
    return {};
  }
}

function firstCoverFrom(isbns, map) {
  for (const i of isbns || []) if (map[i]) return map[i];
  return "";
}

// Rakuten's 1 req/s limiter grants ~7 slots inside the per-request budget, so a
// single POST can only fetch a handful of uncached covers before the rest give
// up (and get cached as "no cover"). Bulk cover fills chunk to this size so each
// request stays within that budget and covers fill in progressively.
const COVER_CHUNK = 6;

// Browsing no longer auto-fetches covers (Rakuten's 1 req/s makes bulk fills
// slow), so search results and volume lists offer an explicit button instead.
// Mounts "表紙を取得（N件）" into `barEl`; clicking fills the uncached covers in
// chunks and swaps the placeholders in, ticking a "残りN件" status down.
// entries: [{ isbns, set(url) }] — set() replaces the placeholder with the cover.
function mountCoverFetch(barEl, entries) {
  if (!entries.length) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.textContent = `表紙を取得（${entries.length}件）`;
  const status = document.createElement("span");
  status.className = "cover-status";
  status.style.display = "none";
  barEl.appendChild(btn);
  barEl.appendChild(status);

  btn.addEventListener("click", async () => {
    btn.style.display = "none";
    let remaining = entries.length;
    const paint = () => {
      status.style.display = remaining > 0 ? "" : "none";
      if (remaining > 0) status.textContent = `表紙を取得中… 残り${remaining}件`;
    };
    paint();
    for (let i = 0; i < entries.length; i += COVER_CHUNK) {
      const chunk = entries.slice(i, i + COVER_CHUNK);
      const isbns = [];
      for (const e of chunk) isbns.push(...e.isbns);
      const map = await fetchCovers(isbns);
      for (const e of chunk) {
        const url = firstCoverFrom(e.isbns, map);
        if (url) e.set(url);
      }
      remaining -= chunk.length;
      paint();
    }
  });
}

async function openSeries(series) {
  // live 検索の結果、および series に未リンクの巻（マスタで schema:isPartOf 欠落）は
  // ローカルに C-id が無く、巻がカードに埋め込まれている。サーバを叩かずそのまま表示する
  // （追加は ISBN ベースなので C-id 不要。補完/訂正/通報も C-id 前提なので出さない）。
  if (series.live || series.unlinked) {
    renderVolumes(series, series.volumes || [], { probed: true, live: true });
    return;
  }
  const box = $("results");
  box.innerHTML = "";
  const spin = document.createElement("p");
  spin.className = "hint";
  spin.textContent = "巻を読み込み中...";
  box.appendChild(spin);
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(series.series_id)}/volumes`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "取得に失敗しました");
    renderVolumes(series, data.volumes || [], {
      probed: !!data.supplement_probed,
      checkedAt: data.supplement_checked_at || 0,
      masterAt: data.master_updated_at || 0,
    });
  } catch (e) {
    box.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = e.message || "取得に失敗しました";
    box.appendChild(p);
  }
}

// live MADB を probe して未リンクの新刊を補完する。補完後の巻一覧を含む /volumes 相当の
// レスポンス全体（volumes・supplement_checked_at・master_updated_at）を返す。
async function probeSupplement(seriesId) {
  const res = await fetch(`/api/series/${encodeURIComponent(seriesId)}/supplement`, {
    method: "POST",
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.error || "取得に失敗しました。少し待って再度お試しください。");
  return data;
}

// シリーズ詳細（巻一覧）画面の取得ボタン。probe 後に一覧を再描画する。
async function fetchSupplement(series, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "取得中…";
  try {
    const data = await probeSupplement(series.series_id);
    series.unconfirmed = false;
    renderVolumes(series, data.volumes || [], {
      probed: true,
      checkedAt: data.supplement_checked_at || Date.now(),
      masterAt: data.master_updated_at || 0,
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    alert(e.message || "取得に失敗しました");
  }
}

// Re-fetch a live (keyword-derived) series' volumes. The server /supplement path
// matches on the master creator, which disagrees with live for multi-author works
// (原作 vs 作画) and would shrink the list — so we re-run the live keyword search by
// title and swap in the refreshed embedded volumes instead.
async function refetchLiveSeries(series, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "取得中…";
  try {
    const res = await fetch(`/api/live-search?q=${encodeURIComponent(series.title)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "取得に失敗しました");
    const match = (data.results || []).find((r) => normKey(r.title) === normKey(series.title));
    if (!match) {
      btn.disabled = false;
      btn.textContent = orig;
      alert("最新DBに該当するシリーズは見つかりませんでした。");
      return;
    }
    series.volumes = match.volumes;
    series.volume_count = match.volume_count;
    if (!series.cover_url) series.cover_url = match.cover_url;
    renderVolumes(series, match.volumes || [], { probed: true, live: true });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    alert(e.message || "取得に失敗しました");
  }
}

// Format an epoch-ms timestamp as YYYY-MM-DD in local time.
function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderVolumes(series, volumes, opts) {
  opts = opts || {};
  const box = $("results");
  box.innerHTML = "";

  // 自分が「間違っています」と通報した巻は、ソース(マスタ/補完/手動)を問わずこの端末では
  // 表示しない。ただし本人が誤タップを戻せるよう full list(volumes)は保持したまま、表示用の
  // visible と非表示中の hidden に分けるだけにする。（通報はサーバに件数だけ記録され、他の
  // 閲覧者には管理者が確定するまで見え続ける。）
  const visible = volumes.filter((v) => !isReportedVolume(series.series_id, v.isbn));
  const hidden = volumes.filter((v) => isReportedVolume(series.series_id, v.isbn));

  const bar = document.createElement("div");
  bar.className = "vol-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "linkbtn";
  back.textContent = "‹ 検索結果へ戻る";
  back.addEventListener("click", () => renderResults(lastResults));
  bar.appendChild(back);
  if (visible.length > 0) {
    const addAll = document.createElement("button");
    addAll.type = "button";
    addAll.className = "primary";
    addAll.textContent = `全${visible.length}巻を追加`;
    addAll.addEventListener("click", () => bulkAddSeries(visible));
    bar.appendChild(addAll);
  }
  // マスタ(月次ダンプ)に未リンクの新刊を、このボタンを押したときだけ取得する（閲覧を SPARQL
  // 往復でブロックしないため）。取得済みでも「再取得」として常に押せるようにする。
  // ・通常のマスタ series … サーバの /supplement を叩き、最終確認日を併記する。
  // ・live 由来（キーワード取得でマージした／live-only）… サーバ補完はマスタ著者で照合するため
  //   巻数が減りうる。代わりにキーワードライブ検索をやり直して埋め込み巻を更新する。
  if (opts.live) {
    const fetchNew = document.createElement("button");
    fetchNew.type = "button";
    fetchNew.className = "sup-btn";
    fetchNew.textContent = "最新DBから再取得";
    fetchNew.addEventListener("click", () => refetchLiveSeries(series, fetchNew));
    bar.appendChild(fetchNew);
  } else {
    const parts = [];
    if (opts.masterAt) parts.push(`マスター更新 ${fmtDate(opts.masterAt)}`);
    if (opts.probed && opts.checkedAt) parts.push(`最終確認 ${fmtDate(opts.checkedAt)}`);
    if (parts.length) {
      const stamp = document.createElement("span");
      stamp.className = "hint sup-stamp";
      stamp.textContent = parts.join("・");
      bar.appendChild(stamp);
    }
    const fetchNew = document.createElement("button");
    fetchNew.type = "button";
    fetchNew.className = "sup-btn";
    fetchNew.textContent = opts.probed ? "最新巻を再取得" : "最新巻を取得";
    fetchNew.addEventListener("click", () => fetchSupplement(series, fetchNew));
    bar.appendChild(fetchNew);
  }
  box.appendChild(bar);

  // この端末で「間違っています」と非表示にした巻を、本人が戻せる導線（誤タップ救済）。
  if (hidden.length) box.appendChild(buildHiddenRestore(series, volumes, hidden, opts));

  const head = document.createElement("p");
  head.className = "hint";
  head.textContent = `${series.title}`;
  // マスタのシリーズ名が壊れている場合（例: 「ハレグゥ」が「ｖ」で取り込まれている）に、
  // 閲覧者が名前の誤りを通報できる導線。live シリーズは C-id が無く通報先が無いので出さない。
  // 通報はサーバに件数だけ記録し、全体反映（名前の修正）は管理者が確定するまで行わない。
  if (!opts.live && series.series_id) {
    const nameFlag = document.createElement("button");
    nameFlag.type = "button";
    nameFlag.className = "report-flag name-report-flag";
    nameFlag.title = "このシリーズ名が誤っている場合に通報（管理者が確認して修正します）";
    nameFlag.setAttribute("aria-label", "このシリーズ名は間違っています");
    const nIcon = document.createElement("span");
    nIcon.className = "flag-icon";
    nIcon.textContent = "⚐";
    const nText = document.createElement("span");
    nText.className = "flag-text";
    const reported = isReportedSeries(series.series_id);
    nText.textContent = reported ? "シリーズ名の誤りを通報済み" : "シリーズ名が違う？";
    if (reported) nameFlag.classList.add("reported");
    nameFlag.appendChild(nIcon);
    nameFlag.appendChild(nText);
    nameFlag.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isReportedSeries(series.series_id)) return;
      if (noHover() && !nameFlag.classList.contains("revealed")) {
        nameFlag.classList.add("revealed");
        return;
      }
      reportWrongSeriesName(series, nameFlag, nText);
    });
    head.appendChild(document.createTextNode(" "));
    head.appendChild(nameFlag);
  }
  box.appendChild(head);

  // マスタに欠けている巻（例: ONE PIECE 巻110）を検出して手動追加の導線を出す。
  // live シリーズは C-id が無く訂正保存(/corrections)できないので抜け巻ピッカーは出さない。
  const gaps = opts.live ? [] : detectGaps(visible);
  if (gaps.length) {
    const gapBox = document.createElement("div");
    gapBox.className = "gap-box";
    const label = document.createElement("span");
    label.className = "gap-label";
    label.textContent = "DBから抜けていそうな巻:";
    gapBox.appendChild(label);
    for (const g of gaps) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "linkbtn gap-btn";
      btn.textContent = `＋${g.disp}を追加`;
      btn.addEventListener("click", () => openGapPicker(series, g, volumes));
      gapBox.appendChild(btn);
    }
    box.appendChild(gapBox);
  }

  const pending = [];
  for (const v of visible) {
    const row = document.createElement("div");
    row.className = "result";
    let cell = coverImg(v.cover_url, v.title);
    row.appendChild(cell);
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = volLabel(v);
    const a = document.createElement("div");
    a.className = "a";
    a.textContent = [v.author, v.pubdate].filter(Boolean).join(" / ");
    info.appendChild(t);
    info.appendChild(a);
    row.appendChild(info);
    // どの巻にも「間違っています」通報導線を出す（マスタ自体が誤っている場合もあるため）。
    // 旗アイコンだけを右端に置き、ホバー/タップで文言を展開する。押すとこの端末では即座に
    // 消えるが、全体反映は管理者が確定するまで行わない（他の閲覧者には表示され続ける）。
    const wrong = document.createElement("button");
    wrong.type = "button";
    wrong.className = "report-flag";
    wrong.title = "この巻を誤りとして通報（あなたの画面からのみ非表示になります）";
    wrong.setAttribute("aria-label", "この巻は間違っています");
    const flagIcon = document.createElement("span");
    flagIcon.className = "flag-icon";
    flagIcon.textContent = "⚐";
    const flagText = document.createElement("span");
    flagText.className = "flag-text";
    flagText.textContent = "間違っています";
    wrong.appendChild(flagIcon);
    wrong.appendChild(flagText);
    wrong.addEventListener("click", (e) => {
      e.stopPropagation();
      // ホバー不可(タッチ)端末では初回タップで文言を展開し、2回目のタップで通報する。
      if (noHover() && !wrong.classList.contains("revealed")) {
        wrong.classList.add("revealed");
        return;
      }
      reportWrongVolume(series, v, volumes, wrong, opts);
    });
    row.appendChild(wrong);
    row.addEventListener("click", () => selectVolume(v));
    box.appendChild(row);
    if (!v.cover_url && v.isbns && v.isbns.length) {
      pending.push({
        isbns: v.isbns,
        set: (url) => { v.cover_url = url; const img = coverImg(url, v.title); cell.replaceWith(img); cell = img; },
      });
    }
  }
  if (pending.length) {
    const fetchBar = document.createElement("div");
    fetchBar.className = "vol-bar";
    mountCoverFetch(fetchBar, pending);
    box.insertBefore(fetchBar, box.querySelector(".result"));
  }
}

function volLabel(v) {
  return v.volume_number ? `${v.title} ${v.volume_number}` : v.title;
}

// Interior gaps in a series' volume numbering. Tolerates a few oddly-labeled volumes
// (e.g. ゴルゴ13 mixes "50巻" / "第100巻" / "volume. 155" in among bare "1".."202"):
// their embedded number still counts as present, so those aren't reported as gaps.
// The trusted range comes from the dominant clean format (巻N or N); odd labels only
// mark presence, never extend the range (so a stray "2020年版" can't invent gaps).
// Bails on genuinely mixed formats or when there's no clean numbering to trust.
// Returns [{ n, vol, disp }] where `vol` is the server-accepted volume_number to
// store ("巻110" / "110") and `disp` is the human label ("110巻").
function detectGaps(volumes) {
  let kan = 0;
  let num = 0;
  const cleanInts = [];
  const present = new Set();
  for (const v of volumes) {
    const s = (v.volume_number || "").trim();
    if (!s) continue;
    let m;
    if ((m = /^巻(\d+)$/.exec(s))) {
      kan++;
      cleanInts.push(parseInt(m[1], 10));
      present.add(parseInt(m[1], 10));
    } else if ((m = /^(\d+)$/.exec(s))) {
      num++;
      cleanInts.push(parseInt(m[1], 10));
      present.add(parseInt(m[1], 10));
    } else {
      const mm = s.match(/\d+/); // odd label: count its number as present only
      if (mm) present.add(parseInt(mm[0], 10));
    }
  }
  if (kan > 0 && num > 0) return []; // genuinely mixed formats ⇒ ambiguous
  if (cleanInts.length < 2) return []; // no trustworthy numbering to judge gaps
  const fmt = kan > 0 ? "KAN" : "NUM";
  const min = Math.min(...cleanInts);
  const max = Math.max(...cleanInts);
  const gaps = [];
  for (let i = min + 1; i < max; i++) {
    if (!present.has(i)) {
      gaps.push({ n: i, vol: fmt === "KAN" ? `巻${i}` : `${i}`, disp: `${i}巻` });
    }
  }
  return gaps;
}

// Assisted search (Rakuten by title+volume) for one missing volume. Renders the
// candidates inline; picking one stages it exactly like selectVolume.
async function openGapPicker(series, gap, volumes) {
  const box = $("results");
  box.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "vol-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "linkbtn";
  back.textContent = "‹ 巻一覧へ戻る";
  back.addEventListener("click", () => renderVolumes(series, volumes));
  bar.appendChild(back);
  box.appendChild(bar);

  const head = document.createElement("p");
  head.className = "hint";
  head.textContent = `${series.title} ${gap.disp} の候補を検索中...`;
  box.appendChild(head);

  let candidates = [];
  try {
    const res = await fetch(
      `/api/volume-candidates?title=${encodeURIComponent(series.title)}&volume=${gap.n}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "検索に失敗しました");
    candidates = data.candidates || [];
  } catch (e) {
    head.textContent = e.message || "検索に失敗しました";
    return;
  }

  if (!candidates.length) {
    head.textContent = `${series.title} ${gap.disp} の候補が見つかりませんでした。`;
    return;
  }
  head.textContent = `${series.title} ${gap.disp} の候補（該当するものを選んで追加）`;

  for (const c of candidates) {
    const row = document.createElement("div");
    row.className = "result";
    row.appendChild(coverImg(c.cover_url, c.title));
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = c.title;
    const a = document.createElement("div");
    a.className = "a";
    a.textContent = [c.volume ? `${c.volume}巻` : "", c.isbn].filter(Boolean).join(" / ");
    info.appendChild(t);
    info.appendChild(a);
    row.appendChild(info);
    row.addEventListener("click", () => pickManualVolume(series, gap, c, volumes));
    box.appendChild(row);
  }
}

// Fill a missing volume: persist it as a correction (so it's cached for everyone),
// then splice it into the in-memory volume list and return to the volume view so it
// can be selected individually or included in "全巻を追加".
async function pickManualVolume(series, gap, c, volumes) {
  let vol = {
    isbn: c.isbn || "",
    isbns: c.isbn ? [c.isbn] : [],
    volume_number: gap.vol,
    vol_sort: gap.n,
    title: series.title,
    author: series.creator || "",
    publisher: "",
    label: "",
    pubdate: "",
    cover_url: c.cover_url || "",
  };
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(series.series_id)}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbn: c.isbn, volume_number: gap.vol }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "保存に失敗しました");
    if (data.volume) vol = data.volume;
  } catch (e) {
    alert(e.message || "保存に失敗しました");
    return;
  }

  // 抜け巻の申請は DB(correction)に補完して巻一覧へ差し込むだけ。100冊シェルフ
  // (state.items)には勝手に入れない。ユーザが巻一覧で選んで初めて追加される。
  if (!volumes.some((v) => v.isbn && v.isbn === vol.isbn)) {
    volumes.push(vol);
    volumes.sort((a, b) => (a.vol_sort || 0) - (b.vol_sort || 0));
  }
  renderVolumes(series, volumes);
}

// ユーザ投稿の巻を「間違っています」と通報する。サーバには通報件数だけが記録され、他の
// 閲覧者には管理者がパージするまで表示され続ける。確定反映は管理者の判断（パージ）に委ねる
// ので、この端末では localStorage に記録して自分の画面からだけ即座に消す。
async function reportWrongVolume(series, v, volumes, btn, opts) {
  if (!confirm(`「${volLabel(v)}」を誤りとして通報します。あなたの画面では非表示になります（他の人には管理者が確認するまで表示されます）。誤って通報しても「非表示にした巻」からいつでも戻せます。よろしいですか？`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(
      `/api/series/${encodeURIComponent(series.series_id)}/corrections/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isbn: v.isbn }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "通報に失敗しました");
  } catch (e) {
    alert(e.message || "通報に失敗しました");
    btn.disabled = false;
    return;
  }
  // localStorage に記録して再描画。full list(volumes)はそのまま渡すので、非表示化した巻は
  // 「非表示にした巻」の復帰導線に回り、本人はいつでも戻せる。
  markReportedVolume(series.series_id, v.isbn);
  renderVolumes(series, volumes, opts);
}

// 「間違っています」で非表示にした巻を本人が戻せる導線。通報はサーバに件数が残ったまま（全体
// 反映は管理者のパージ確定）で、ここで消すのは自分の端末ローカル台帳の記録だけ。<details>で
// 折りたたみ、開くと巻ごとに「戻す」を出す。
function buildHiddenRestore(series, allVolumes, hidden, opts) {
  const det = document.createElement("details");
  det.className = "hidden-restore";
  const sum = document.createElement("summary");
  sum.textContent = `この端末で非表示にした巻 ${hidden.length}件`;
  det.appendChild(sum);
  const list = document.createElement("div");
  list.className = "hidden-list";
  for (const v of hidden) {
    const rowH = document.createElement("div");
    rowH.className = "hidden-row";
    const label = document.createElement("span");
    label.className = "hidden-label";
    label.textContent = volLabel(v);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "linkbtn";
    restore.textContent = "戻す";
    restore.addEventListener("click", () => {
      unmarkReportedVolume(series.series_id, v.isbn);
      renderVolumes(series, allVolumes, opts);
    });
    rowH.appendChild(label);
    rowH.appendChild(restore);
    list.appendChild(rowH);
  }
  det.appendChild(list);
  return det;
}

// シリーズ名の誤りを通報する。巻の通報と同じ collect-only 方針: サーバは件数だけ記録し、
// 名前の修正（全体反映）は管理者が確定するまで行わない。この端末では通報済みとして覚え、
// ボタンを「通報済み」表示に切り替える（名前自体はこの端末でも変わらない）。
async function reportWrongSeriesName(series, btn, textEl) {
  if (!confirm(`このシリーズ名「${series.title}」が誤っていると通報します。管理者が確認して修正します。よろしいですか？`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(series.series_id)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "通報に失敗しました");
  } catch (e) {
    alert(e.message || "通報に失敗しました");
    btn.disabled = false;
    return;
  }
  markReportedSeries(series.series_id);
  btn.classList.add("reported");
  btn.disabled = false;
  textEl.textContent = "シリーズ名の誤りを通報済み";
}

// シリーズ名を通報した端末ローカル台帳（localStorage）。二重通報を防ぎ、通報済み表示に使う。
const REPORTED_SERIES_KEY = "my100manga_reported_series_v1";
function reportedSeriesSet() {
  try {
    const raw = localStorage.getItem(REPORTED_SERIES_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}
function isReportedSeries(seriesId) {
  if (!seriesId) return false;
  return reportedSeriesSet().has(seriesId);
}
function markReportedSeries(seriesId) {
  if (!seriesId) return;
  const s = reportedSeriesSet();
  s.add(seriesId);
  try {
    localStorage.setItem(REPORTED_SERIES_KEY, JSON.stringify([...s]));
  } catch {}
}

// ホバー不可(タッチ主体)の端末か。旗の文言をタップで展開するかの判定に使う。
function noHover() {
  return window.matchMedia && window.matchMedia("(hover: none)").matches;
}

// 「間違っています」と通報したユーザ投稿巻の端末ローカル台帳（localStorage）。通報は本人の
// 画面でだけ即反映し、全体反映は管理者のパージまで行わないため、ここで自分の通報だけ覚える。
const REPORTED_VOL_KEY = "my100manga_reported_corrections_v1";
function reportedVolKey(seriesId, isbn) {
  return `${seriesId}/${isbn}`;
}
function reportedVolSet() {
  try {
    const raw = localStorage.getItem(REPORTED_VOL_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}
function isReportedVolume(seriesId, isbn) {
  if (!seriesId || !isbn) return false;
  return reportedVolSet().has(reportedVolKey(seriesId, isbn));
}
function markReportedVolume(seriesId, isbn) {
  if (!seriesId || !isbn) return;
  const s = reportedVolSet();
  s.add(reportedVolKey(seriesId, isbn));
  try {
    localStorage.setItem(REPORTED_VOL_KEY, JSON.stringify([...s]));
  } catch {}
}
// 通報で非表示にした巻を本人が戻すとき、この端末の台帳からだけ削除する（サーバの通報件数は
// 触らない。全体反映は管理者のパージ確定に委ねる方針のため）。
function unmarkReportedVolume(seriesId, isbn) {
  if (!seriesId || !isbn) return;
  const s = reportedVolSet();
  s.delete(reportedVolKey(seriesId, isbn));
  try {
    localStorage.setItem(REPORTED_VOL_KEY, JSON.stringify([...s]));
  } catch {}
}

// A book counts as a duplicate only when it has an ISBN that already exists in
// the list (books with no ISBN are never treated as dupes of each other).
function isDuplicate(isbn, exceptIndex = -1) {
  if (!isbn) return false;
  return state.items.some((it, idx) => idx !== exceptIndex && it.isbn === isbn);
}

async function selectVolume(v) {
  // The background fill usually resolves the cover before the user clicks; if not,
  // resolve it now so it's baked into the item.
  if (!v.cover_url && v.isbns && v.isbns.length) {
    v.cover_url = firstCoverFrom(v.isbns, await fetchCovers(v.isbns));
  }
  state.pending = {
    isbn: v.isbn || "",
    title: volLabel(v),
    author: v.author || "",
    cover_url: v.cover_url || "",
    comment: $("comment").value,
    spoiler: $("spoiler").checked,
  };
  showSelected(state.pending);
  $("saveSlot").disabled = false;
  $("selectedBox").scrollIntoView({ block: "nearest" });
}

// Append every volume to the list (no per-slot placement — the list is now dynamic).
// Volumes already in the list (by ISBN) are skipped so a series can't be double-added.
function bulkAddSeries(volumes) {
  // A large series (ゴルゴ13 ≈ 200 巻) has hundreds of covers to resolve over the
  // network. Adding to the shelf must not wait on that: push the volumes first,
  // then backfill covers asynchronously.
  const existing = new Set(state.items.map((it) => it.isbn).filter(Boolean));
  // Dedup against the current list AND within this batch, so two volume entries
  // that carry the same ISBN can't both slip in and create an in-list duplicate.
  const fresh = volumes.filter((v) => {
    if (!v.isbn) return true;
    if (existing.has(v.isbn)) return false;
    existing.add(v.isbn);
    return true;
  });
  const skipped = volumes.length - fresh.length;
  if (fresh.length === 0) {
    alert("この巻はすべて追加済みです。");
    return;
  }
  const room = MAX_ITEMS - state.items.length;
  if (room <= 0) {
    alert(`これ以上追加できません（上限${MAX_ITEMS}作品）。`);
    return;
  }
  const n = Math.min(room, fresh.length);
  const toAdd = fresh.slice(0, n);
  // Push everything immediately with whatever cover we already have. Covers aren't
  // fetched here — the "表紙を取得" button (fetchMissingCovers) does it on demand.
  for (const v of toAdd) {
    state.items.push({
      isbn: v.isbn || "",
      title: volLabel(v),
      author: v.author || "",
      cover_url: v.cover_url || "",
      comment: "",
      spoiler: false,
    });
  }
  closeEdit();
  render();
  saveDraft();
  const notes = [];
  if (skipped > 0) notes.push(`追加済み${skipped}巻はスキップ`);
  if (fresh.length > n) notes.push(`上限のため残り${fresh.length - n}巻は未追加`);
  if (notes.length) alert(`${n}巻を追加しました（${notes.join("、")}）。`);
}

// Fetch covers for grid items that still lack one, in chunks sized to the Rakuten
// limiter budget (COVER_CHUNK), re-rendering after each so covers pop in
// progressively. Triggered by the "表紙を取得" button rather than automatically,
// since Rakuten's 1 req/s makes a large series' fill slow. A status line above the
// grid ticks the remaining count down.
async function fetchMissingCovers() {
  const targets = state.items.filter((it) => !it.cover_url && it.isbn && !state.coverTried.has(it.isbn));
  if (!targets.length) return;
  state.fetchingCovers = true;
  render();
  const statusEl = $("coverStatus");
  let remaining = targets.length;
  const paint = () => {
    if (!statusEl) return;
    statusEl.style.display = remaining > 0 ? "" : "none";
    if (remaining > 0) statusEl.textContent = `表紙を取得中… 残り${remaining}件`;
  };
  paint();
  for (let i = 0; i < targets.length; i += COVER_CHUNK) {
    const batch = targets.slice(i, i + COVER_CHUNK);
    const map = await fetchCovers(batch.map((it) => it.isbn));
    let changed = false;
    for (const it of batch) {
      state.coverTried.add(it.isbn);
      const url = map[it.isbn];
      if (url) {
        it.cover_url = url;
        changed = true;
      }
    }
    remaining -= batch.length;
    if (changed) {
      render();
      saveDraft();
    }
    paint();
  }
  state.fetchingCovers = false;
  render();
}

function saveSlot() {
  if (!state.pending) return;
  const commentText = $("comment").value;
  // コメントは匿名公開の自由入力なので URL は不可（スパム・誘導リンク対策）。
  if (/https?:\/\/|www\./i.test(commentText)) {
    alert("コメントにURLは入力できません。URLを削除してください。");
    return;
  }
  const item = {
    isbn: state.pending.isbn || "",
    title: state.pending.title || "",
    author: state.pending.author || "",
    cover_url: state.pending.cover_url || "",
    comment: commentText.slice(0, 200),
    spoiler: $("spoiler").checked,
  };
  // When editing a slot, keeping the same book (unchanged ISBN) isn't a new
  // duplicate — this is what makes "表紙を変更 → 更新" work even if the list
  // already contains another copy of this ISBN.
  const isbnUnchanged = state.editIndex >= 0 && (state.items[state.editIndex]?.isbn || "") === item.isbn;
  if (!isbnUnchanged && isDuplicate(item.isbn, state.editIndex)) {
    alert("この本はすでに追加されています。");
    return;
  }
  if (state.editIndex >= 0) {
    state.items[state.editIndex] = item;
  } else {
    if (state.items.length >= MAX_ITEMS) {
      alert(`追加できるのは${MAX_ITEMS}作品までです。`);
      return;
    }
    state.items.push(item);
  }
  closeEdit();
  render();
  saveDraft();
}

function removeSlot() {
  if (state.editIndex >= 0) state.items.splice(state.editIndex, 1);
  closeEdit();
  render();
  saveDraft();
}

function closeEdit() {
  $("editModal").classList.remove("open");
  state.editIndex = -1;
  state.pending = null;
}

/* ---------- publish ---------- */
function collectItems() {
  return state.items.map((it) => ({
    isbn: it.isbn,
    title: it.title,
    author: it.author,
    cover_url: it.cover_url,
    comment: it.comment,
    spoiler: it.spoiler,
  }));
}

// Publish button: ask for the display name first, then publish/update.
function openPublishModal() {
  if (state.items.length !== TARGET) {
    alert(`公開にはちょうど${TARGET}作品が必要です（現在${state.items.length}作品）。`);
    return;
  }
  $("ownerInput").value = state.owner || "";
  // お好みURLは新規公開時のみ。既存リストの更新では slug は変えられない。
  const slugField = $("slugField");
  if (slugField) {
    slugField.style.display = state.editSlug ? "none" : "";
    if (!state.editSlug) {
      $("slugInput").value = "";
      $("slugPrefix").textContent = `${location.host}/l/`;
    }
  }
  $("publishModal").classList.add("open");
  $("ownerInput").focus();
}

function confirmPublish() {
  const name = $("ownerInput").value.trim();
  // 表示名も匿名公開の自由入力なので URL は不可（スパム・誘導リンク対策）。
  if (/https?:\/\/|www\./i.test(name)) {
    alert("表示名にURLは入力できません。URLを削除してください。");
    return;
  }
  if (!state.editSlug) {
    const slug = $("slugInput").value.trim();
    if (slug && !/^[a-zA-Z0-9_-]{1,15}$/.test(slug)) {
      alert("URLは英数字・ハイフン・アンダースコアのみ、15文字以内で入力してください。");
      return;
    }
    state.customSlug = slug;
  }
  state.owner = name.slice(0, 40);
  $("publishModal").classList.remove("open");
  doPublish();
}

async function doPublish() {
  const items = collectItems();
  if (items.length !== TARGET) {
    alert(`公開にはちょうど${TARGET}作品が必要です（現在${items.length}作品）。`);
    return;
  }
  $("publish").disabled = true;
  try {
    let res;
    if (state.editSlug) {
      res = await fetch(`/api/lists/${state.editSlug}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_name: state.owner, items, edit_token: state.editToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新に失敗しました");
      clearEditDraft(state.editSlug);
      // What we just PUT is now the 公開状態 — rebase the diff on it.
      state.published = { owner: state.owner, items: items.map(normItem) };
      window.MyLists?.save({ slug: state.editSlug, token: state.editToken, owner: state.owner });
      showShare(state.editSlug, state.editToken);
    } else {
      const payload = { owner_name: state.owner, items };
      if (state.customSlug) payload.slug = state.customSlug;
      res = await fetch(`/api/lists`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "公開に失敗しました");
      state.editSlug = data.slug;
      state.editToken = data.edit_token;
      state.customSlug = "";
      window.MyLists?.save({ slug: data.slug, token: data.edit_token, owner: state.owner });
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
      showShare(data.slug, data.edit_token);
    }
  } catch (e) {
    alert(e.message || "エラーが発生しました");
  } finally {
    render();
    renderMyLists();
  }
}

function showShare(slug, token) {
  const shareUrl = `${location.origin}/l/${slug}`;
  const editUrl = `${location.origin}/?edit=${slug}&t=${token}`;
  $("shareUrl").value = shareUrl;
  $("editUrl").value = editUrl;
  $("openShare").href = shareUrl;
  $("shareModal").classList.add("open");
}

/* ---------- events ---------- */
function wireEvents() {
  $("topSearchBtn").addEventListener("click", topSearch);
  $("topSearch").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) topSearch(); });
  $("fetchCovers").addEventListener("click", fetchMissingCovers);
  $("fixMissing").addEventListener("click", startFixMissing);
  $("clearAll").addEventListener("click", clearAll);
  $("revertPublished").addEventListener("click", revertToPublished);
  $("reorderToggle").addEventListener("click", toggleReorder);
  $("moveStart").addEventListener("click", () => moveSelectedToEnd(true));
  $("moveEnd").addEventListener("click", () => moveSelectedToEnd(false));
  $("reorderClear").addEventListener("click", () => { state.selected.clear(); render(); });
  $("sortName").addEventListener("click", sortByName);
  $("reorderDone").addEventListener("click", toggleReorder);
  $("publish").addEventListener("click", openPublishModal);
  $("confirmPublish").addEventListener("click", confirmPublish);
  $("cancelPublish").addEventListener("click", () => $("publishModal").classList.remove("open"));
  $("ownerInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) confirmPublish(); });
  $("searchBtn").addEventListener("click", doSearch);
  $("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) doSearch(); });
  $("saveSlot").addEventListener("click", saveSlot);
  $("removeSlot").addEventListener("click", removeSlot);
  $("cancelEdit").addEventListener("click", closeEdit);
  $("comment").addEventListener("input", () => { if (state.pending) $("saveSlot").disabled = false; });

  $("changeCoverBtn").addEventListener("click", openCoverPicker);
  $("cancelPick").addEventListener("click", closeCoverPicker);
  $("useUrl").addEventListener("click", () => {
    const url = $("urlInput").value.trim();
    if (!/^https?:\/\//i.test(url)) { alert("http(s) の画像URLを指定してください。"); return; }
    applyPickedCover(url);
  });
  $("clearCover").addEventListener("click", () => applyPickedCover(""));
  $("coverSearchBtn").addEventListener("click", runCoverSearch);
  $("coverSearch").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) runCoverSearch(); });
  $("skipFix").addEventListener("click", () => { if (state.fixIndex >= 0) advanceFix(state.fixIndex); });
  $("pickModal").addEventListener("click", (e) => { if (e.target.id === "pickModal") closeCoverPicker(); });

  $("copyShare").addEventListener("click", () => copy($("shareUrl")));
  $("copyEdit").addEventListener("click", () => copy($("editUrl")));
  $("closeShare").addEventListener("click", () => $("shareModal").classList.remove("open"));

  for (const id of ["editModal", "shareModal", "publishModal"]) {
    $(id).addEventListener("click", (e) => { if (e.target.id === id) $(id).classList.remove("open"); });
  }
}

function copy(input) {
  input.select();
  navigator.clipboard?.writeText(input.value).then(
    () => { input.blur(); },
    () => { document.execCommand("copy"); }
  );
}

init();
