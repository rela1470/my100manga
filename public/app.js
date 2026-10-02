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
  bio: "", // 作者のひとこと（100文字まで・公開ページ上部に表示）
  items: [], // dynamic list of {isbn,title,author,cover_url,comment,spoiler}
  editIndex: -1, // -1 = adding a new item; >=0 = editing items[editIndex]
  pending: null, // selected book before saving
  fixIndex: -1, // -1 = not in guided missing-cover mode; >=0 = fixing items[fixIndex]
  editSlug: null, // set when editing an existing published list
  editToken: null,
  published: null, // {owner, bio, items} snapshot of the server (公開) state, for diff/もとに戻す

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
  syncCovers();
  renderMyLists();
  loadSiteStats();
  wireEvents();
  openSeriesFromUrl(params);
  // /l/:slug が見つからなかったときはサーバがここへリダイレクトしてくる。
  if (params.get("notfound") === "list") {
    params.delete("notfound");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
    uiAlert("リストが見つかりませんでした。削除されたか、URLが間違っている可能性があります。");
  }
}

// 閲覧画面の本の詳細の「シリーズ」リンク（/?series=<C-id>&st=<シリーズ名>）。巻一覧を開き、
// リロードで開き直さないようパラメータは消しておく。
function openSeriesFromUrl(params) {
  const sid = params.get("series");
  if (!sid) return;
  const title = params.get("st") || "";
  params.delete("series");
  params.delete("st");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  openSeriesFromBook(sid, title);
}

/* ---------- site stats (収録シリーズ / 巻 / 公開リスト数) ---------- */
// 管理画面の stat-card と同じ見た目。取得に失敗したら枠ごと出さない（装飾なので黙って諦める）。
async function loadSiteStats() {
  const box = document.getElementById("siteStats");
  try {
    const res = await fetch("/api/site-stats");
    if (!res.ok) return;
    const stats = await res.json();
    const cards = [
      ["series", "シリーズ"],
      ["volumes", "巻(ISBN)"],
      ["lists", "公開リスト"],
    ];
    box.replaceChildren(
      ...cards.map(([key, label]) => {
        const card = document.createElement("div");
        card.className = "stat-card";
        const n = document.createElement("div");
        n.className = "n";
        n.textContent = Number(stats[key] ?? 0).toLocaleString("ja-JP");
        const k = document.createElement("div");
        k.className = "k";
        k.textContent = label;
        card.append(n, k);
        return card;
      })
    );
    box.hidden = false;
  } catch {
    // ネットワーク失敗時は非表示のまま
  }
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
    del.addEventListener("click", async () => {
      const name = r.owner ? `${r.owner}さんの100作品` : "無題の100作品";
      if (!(await uiConfirm(`「${name}」の編集リンクをこの端末から削除します。\n公開リストは消えませんが、編集リンクを別で保存していないと二度と編集できなくなります。よろしいですか？`, { danger: true, okLabel: "削除する" }))) return;
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

// ISBN-10 / ハイフン付きを ISBN-13 に揃える（サーバ src/util.ts toIsbn13 と同じ）。公開データの
// ISBN は ISBN-13 で返ってくるので、下書きと比べる差分判定がずれないようこちらでも揃える。
// ISBN として読めない値はそのまま返す（公開時にサーバが弾く）。
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

function normItem(it) {
  return {
    isbn: toIsbn13(it.isbn),
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
    state.bio = data.bio || "";
    state.editSlug = slug;
    state.editToken = token;
    state.items = (data.items || []).map(normItem);
    // Snapshot the server (公開) state before any draft restore so we can show a
    // diff count and offer もとに戻す while editing.
    state.published = { owner: state.owner, bio: state.bio, items: state.items.map(normItem) };
    restoreEditDraft(slug, data.updated_at || 0);
  } catch (e) {
    uiAlert("既存リストの読み込みに失敗しました。新規作成モードで開きます。");
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
    if (typeof d.bio === "string") state.bio = d.bio;
    if (Array.isArray(d.items)) state.items = d.items.filter(Boolean).map(normItem);
  } catch (e) {}
}

/* ---------- diff vs 公開状態 ---------- */
// 公開データとして持つのは ISBN・コメント・ネタバレだけ。タイトル/著者/表紙はサーバが ISBN
// からサイト共通データで引く（src/listItems.ts）ので、表示用の値が違っても差分には数えない。
function itemsEqual(a, b) {
  if (!a || !b) return false;
  return a.isbn === b.isbn && a.comment === b.comment && !!a.spoiler === !!b.spoiler;
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
// name and ひとこと if they changed. 0 = current view matches 公開状態.
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
  if ((state.published.bio || "") !== (state.bio || "")) count++;
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
async function revertToPublished() {
  if (!state.editSlug || !state.published || diffCount() === 0) return;
  if (!(await uiConfirm("編集中の変更を破棄して、公開されている状態にもどします。よろしいですか？"))) return;
  state.owner = state.published.owner || "";
  state.bio = state.published.bio || "";
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
        JSON.stringify({ owner: state.owner, bio: state.bio, items: state.items, savedAt: Date.now() })
      );
      return;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ owner: state.owner, bio: state.bio, items: state.items }));
  } catch (e) {}
}
// ISBN のある本の表紙はサイト共通（covers）なので、下書きに残った表紙は古いことがある
// （提案が管理者に承認されて差し替わった等）。開いた時にサーバの値で揃える。サーバに
// 無い ISBN は下書きの値を残す。編集モードで下書きが無い時は、公開データ自体がサーバ
// 側で表紙を引き直しているので下書きを新しく作らない。
async function syncCovers() {
  const isbns = [...new Set(state.items.map((it) => it.isbn).filter(Boolean))];
  if (!isbns.length) return;
  let covers = {};
  try {
    const res = await fetch("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns, cache_only: true }),
    });
    if (!res.ok) return;
    covers = (await res.json()).covers || {};
  } catch {
    return;
  }
  let changed = false;
  for (const it of state.items) {
    const url = it.isbn && covers[it.isbn];
    if (url && url !== it.cover_url) {
      it.cover_url = url;
      changed = true;
    }
  }
  if (!changed) return;
  const hasDraft = (() => {
    try {
      return !state.editSlug || localStorage.getItem(editDraftKey(state.editSlug)) !== null;
    } catch {
      return false;
    }
  })();
  if (hasDraft) saveDraft();
  render();
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
    state.bio = d.bio || "";
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

async function clearAll() {
  if (state.items.length === 0) return;
  if (!(await uiConfirm(`編集中の${state.items.length}作品をすべて削除します。よろしいですか？`, { danger: true, okLabel: "全削除" }))) return;
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
  slot.addEventListener("click", focusTopSearch);
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
    img.alt = it.title;
    img.onerror = () => { img.replaceWith(placeholderCover(it.title)); };
    applyCover(img, it.cover_url);
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
async function sortByName() {
  if (state.items.length < 2) return;
  if (!(await uiConfirm("現在の並び順を破棄して、作品名で並べ替えます。よろしいですか？"))) return;
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

/* ---------- add / search modal ---------- */
// 本の追加はトップの検索欄から。検索結果をモーダルに出し、1 巻を選ぶと即リストへ追加する。
// コメント/ネタバレ/表紙は追加後に編集ポップアップで設定する（本の差し替えは「削除して再追加」の運用）。
// モーダルに検索欄は置かず、再検索はモーダルを閉じてトップの検索欄から行う。
function openAdd() {
  state.editIndex = -1;
  state.pending = null;
  clearResults();
  $("searchModal").classList.add("open");
}

// 空き枠の「追加」: トップの検索欄へ誘導する。
function focusTopSearch() {
  const input = $("topSearch");
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus({ preventScroll: true });
}

// Empties the modal body, the series title under the heading (searchSubtitle) and
// the footer slot (searchActions) that holds the current view's 表紙を取得 button,
// so neither outlives the view it belongs to.
function clearResults() {
  $("searchActions").innerHTML = "";
  const sub = $("searchSubtitle");
  sub.innerHTML = "";
  sub.hidden = true;
  const box = $("results");
  box.innerHTML = "";
  return box;
}

// 本の詳細（編集ポップアップの「シリーズ」リンク、閲覧画面からの /?series=）から巻一覧を開く。
// 検索を経ていないので「検索結果へ戻る」は出さない（fromBook）。
function openSeriesFromBook(seriesId, title) {
  openAdd();
  openSeries({ series_id: seriesId, title: title || "", fromBook: true });
}

function closeSearch() {
  $("searchModal").classList.remove("open");
  state.pending = null;
}

/* ---------- edit slot modal (閲覧画面と同じ表示) ---------- */
// Bumped on every open so a slow /api/book response for a previously-opened book
// can't overwrite the metadata of the one now showing.
let editSeq = 0;

function openEdit(index) {
  const it = state.items[index];
  if (!it) return;
  state.editIndex = index;
  state.pending = { ...it };
  const seq = ++editSeq;

  $("eTitle").textContent = it.title || "";
  $("eAuthor").textContent = it.author || "";
  $("eAuthor").style.display = it.author ? "" : "none";
  setMetaRow("eIsbnRow", "eIsbn", it.isbn || "");
  setMetaRow("ePublisherRow", "ePublisher", "");
  setMetaRow("ePubdateRow", "ePubdate", "");
  $("eSeriesRow").style.display = "none";
  $("eSynopsisBox").style.display = "none";
  $("eSynopsis").textContent = "";
  renderEditCover(state.pending);
  const refetch = $("refetchBook");
  refetch.style.display = it.isbn ? "" : "none";
  refetch.disabled = false;
  refetch.textContent = "本データを再取得";
  $("comment").value = it.comment || "";
  $("spoiler").checked = !!it.spoiler;
  renderEditBuy(it);
  loadEditMeta(it, seq);
  loadEditCover(index, seq);

  $("editModal").classList.add("open");
}

// The stored item may have no cover yet (lists load with cache-only covers, and
// /api/book carries no image), so resolve it here like the shelf's 表紙を取得 does.
async function loadEditCover(index, seq) {
  const it = state.items[index];
  if (!it || it.cover_url || !it.isbn) return;
  const url = firstCoverFrom([it.isbn], await fetchCovers([it.isbn]));
  if (!url || seq !== editSeq || state.pending.cover_url) return;
  state.pending.cover_url = url;
  renderEditCover(state.pending);
  if (state.items[index] === it && !it.cover_url) {
    it.cover_url = url;
    state.coverTried.add(it.isbn);
    saveDraft();
    render();
  }
}

// 購入リンク（閲覧画面と同じ affiliate.js / buildBuyLinks を使用）。
// `p` is the element-id prefix: "e" = edit modal, "v" = volume detail modal.
function renderEditBuy(it, p = "e") {
  const box = $(p + "Buy");
  const groups = { print: $(p + "BuyPrint"), ebook: $(p + "BuyEbook"), used: $(p + "BuyUsed") };
  Object.values(groups).forEach((g) => (g.innerHTML = ""));

  const links = typeof window.buildBuyLinks === "function" ? window.buildBuyLinks(it) : [];
  if (!links.length) {
    box.style.display = "none";
    return;
  }
  links.forEach((l) => {
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
  });
  box.style.display = "";
}

function renderEditCover(book) {
  renderCoverInto($("eCoverBox"), book);
  setSourceRow("eSourceRow", "eSource", book.cover_url, book.isbn);
}

function renderCoverInto(box, book) {
  box.innerHTML = "";
  if (book.cover_url) {
    const img = document.createElement("img");
    img.className = "dcover";
    img.alt = book.title || "";
    img.onerror = () => {
      const d = document.createElement("div");
      d.className = "dnoimg";
      d.textContent = "No Image";
      img.replaceWith(d);
    };
    applyCover(img, book.cover_url);
    box.appendChild(img);
  } else {
    const d = document.createElement("div");
    d.className = "dnoimg";
    d.textContent = "No Image";
    box.appendChild(d);
  }
}

function setMetaRow(rowId, valueId, text) {
  const has = !!text;
  $(rowId).style.display = has ? "" : "none";
  if (has) $(valueId).textContent = text;
}

// 「画像参考元」の行。出品元が分かればそのページへのリンクにする（public/affiliate.js
// coverSourceLink）。
function setSourceRow(rowId, valueId, coverUrl, isbn) {
  const src = window.coverSourceLink ? window.coverSourceLink(coverUrl, isbn) : null;
  $(rowId).style.display = src ? "" : "none";
  if (!src) return;
  const dd = $(valueId);
  dd.textContent = "";
  if (!src.url) {
    dd.textContent = src.label;
    return;
  }
  const a = document.createElement("a");
  a.href = src.url;
  a.target = "_blank";
  a.rel = "noopener sponsored";
  a.textContent = src.label;
  dd.appendChild(a);
}

// Fetch richer metadata (all authors, publisher, 発行日, あらすじ) and fill the
// popup — but only if it's still the one on screen (seq guard).
async function loadEditMeta(it, seq) {
  if (!it.isbn) return;
  let data;
  try {
    const res = await fetch(`/api/book?isbn=${encodeURIComponent(it.isbn)}`);
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  if (seq !== editSeq) return;
  applyBookMeta(data);
}

// Fill the author / 出版社 / 発行日 / あらすじ rows from an /api/book response.
// `p` is the element-id prefix: "e" = edit modal, "v" = volume detail modal.
function applyBookMeta(data, p = "e") {
  if (Array.isArray(data.authors) && data.authors.length) {
    $(p + "Author").textContent = data.authors.join("、");
    $(p + "Author").style.display = "";
  }
  setMetaRow(p + "PublisherRow", p + "Publisher", data.publisher || "");
  setMetaRow(p + "PubdateRow", p + "Pubdate", data.pubdate || "");
  // シリーズへのリンク（編集ポップアップのみ。巻一覧から開く詳細には行が無い）。
  const seriesRow = $(p + "SeriesRow");
  if (seriesRow && data.series) {
    const a = $(p + "Series");
    a.textContent = data.series.title;
    a.href = `/?series=${encodeURIComponent(data.series.id)}&st=${encodeURIComponent(data.series.title)}`;
    a.dataset.seriesId = data.series.id;
    seriesRow.style.display = "";
  }
  if (data.caption) {
    $(p + "Synopsis").textContent = data.caption;
    $(p + "SynopsisBox").style.display = "";
  } else {
    $(p + "Synopsis").textContent = "";
    $(p + "SynopsisBox").style.display = "none";
  }
}

// 「本データを再取得」: キャッシュを無視して /api/book?refresh=1 を叩き直し、著者・出版社・
// 発行日・あらすじを最新に差し替える。空あらすじで固まった行や、追加時にレート制限でメタが
// 取れなかった本を埋め直すための導線。
async function refetchBook(btn) {
  const it = state.pending;
  if (!it || !it.isbn) return;
  const seq = editSeq;
  btn.disabled = true;
  btn.textContent = "取得中…";
  try {
    const res = await fetch(`/api/book?isbn=${encodeURIComponent(it.isbn)}&refresh=1`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (seq !== editSeq) return; // popup moved to another book / closed
    if (data.status === "unavailable") {
      // Rakuten was rate-limited (1 req/s) — the lookup never ran. Retryable, and we
      // keep any あらすじ already shown rather than blanking it with this empty response.
      btn.textContent = "混み合っています。少し待って再取得";
    } else {
      applyBookMeta(data);
      btn.textContent = data.caption ? "再取得しました" : "この巻のあらすじ情報はありません";
    }
  } catch {
    if (seq === editSeq) btn.textContent = "取得に失敗しました";
  } finally {
    if (seq === editSeq) {
      btn.disabled = false;
      setTimeout(() => {
        if (seq === editSeq) btn.textContent = "本データを再取得";
      }, 2500);
    }
  }
}

/* ---------- cover picker ---------- */
// Whether the "画像URLを直接指定" input is usable this session. Driven solely by the
// server flag (data.url_submit); off by default so an accountless visitor can't post
// an arbitrary image URL (high vandalism risk). The submission endpoint enforces it
// server-side too — this just hides the dead input. See src/corrections.ts.
let urlSubmitEnabled = false;
function setUrlSubmit(on) {
  urlSubmitEnabled = !!on;
  $("urlPickRow").style.display = urlSubmitEnabled ? "" : "none";
  $("urlPickHint").style.display = urlSubmitEnabled ? "" : "none";
}

// Picker searches run in stages (/api/cover-candidates?stage=…) so each source's
// hits show as soon as it answers — the slower ones (title broadening, 楽天市場)
// queue behind the 1 req/s Rakuten/Yahoo limiters. Each stage owns a
// display:contents section of the grid, so results stay in stage order whatever
// order they arrive in. pickSeq drops answers from a search the user has since
// replaced or closed.
let pickSeq = 0;

async function runPickStages(stages) {
  const seq = ++pickSeq;
  const grid = $("candGrid");
  const box = $("pickStages");
  grid.innerHTML = "";
  box.innerHTML = "";
  box.style.display = "";
  const seen = new Set();
  let total = 0;
  let anyOk = false;
  await Promise.all(
    stages.map(async (st) => {
      const section = document.createElement("div");
      section.className = "cand-section";
      grid.appendChild(section);
      const row = document.createElement("div");
      row.className = "spinner pick-stage";
      row.textContent = `${st.label}を検索中…`;
      box.appendChild(row);
      let cands = null;
      try {
        const res = await fetch(`/api/cover-candidates?${st.qs}`);
        const data = await res.json();
        if (res.ok) {
          cands = data.candidates || [];
          if (seq === pickSeq) setUrlSubmit(data.url_submit);
        }
      } catch {}
      if (seq !== pickSeq) return;
      if (cands) anyOk = true;
      const fresh = (cands || []).filter((c) => c.src && !seen.has(c.src));
      for (const c of fresh) {
        seen.add(c.src);
        section.appendChild(candCell(c));
      }
      total += fresh.length;
      row.className = cands ? "pick-stage done" : "pick-stage fail";
      row.textContent = cands ? `${st.label}：${fresh.length}件` : `${st.label}：取得に失敗しました`;
    })
  );
  if (seq !== pickSeq) return;
  box.style.display = "none";
  if (!anyOk) setUrlSubmit(false);
  if (total === 0) renderCandidates([]);
}

// Shared loader: opens the picker modal and fills it with cover candidates for `it`.
async function loadCandidates(it) {
  $("urlInput").value = "";
  $("coverSearch").value = it.title || "";
  $("pickModal").classList.add("open");
  const base = new URLSearchParams();
  if (it.isbn) base.set("isbn", it.isbn);
  if (it.title) base.set("title", it.title);
  const stage = (name, label) => {
    const qs = new URLSearchParams(base);
    qs.set("stage", name);
    return { label, qs: qs.toString() };
  };
  const stages = [];
  if (it.isbn) stages.push(stage("isbn", "ISBN一致（楽天ブックス・Yahoo!）"));
  if (it.title) stages.push(stage("title", "タイトル検索（楽天ブックス）"));
  if (it.isbn) stages.push(stage("ichiba", "楽天市場（中古店など）"));
  await runPickStages(stages);
}

// Re-run the picker with an owner-typed keyword (`q`): literal Rakuten search,
// bypassing the auto title-broadening that surfaces unrelated books.
async function runCoverSearch() {
  const q = $("coverSearch").value.trim();
  if (!q) return;
  await runPickStages([{ label: "キーワード検索（楽天ブックス）", qs: `q=${encodeURIComponent(q)}` }]);
}

// From the edit modal: edits the in-progress selection (state.pending).
async function openCoverPicker() {
  if (!state.pending) return;
  state.fixIndex = -1;
  $("skipFix").style.display = "none";
  const it = state.pending;
  $("pickTitle").textContent = it.isbn ? `${it.title}（ISBN: ${it.isbn}）` : it.title;
  // ISBN のある本の表紙はサイト共通なので、このリストだけ消すことはできない。
  $("clearCover").style.display = it.isbn ? "none" : "";
  await loadCandidates(it);
}

/* ---------- guided missing-cover flow ---------- */
function startFixMissing() {
  const first = state.items.findIndex((it) => !it.cover_url);
  if (first < 0) { uiAlert("表紙がない本はありません。"); return; }
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
  $("clearCover").style.display = it.isbn ? "none" : "";
  await loadCandidates(it);
}

// Advance to the next book (after `from`) that still has no cover; finish when none remain.
function advanceFix(from) {
  const next = state.items.findIndex((it, i) => i > from && !it.cover_url);
  if (next >= 0) { openFixPicker(next); return; }
  closeCoverPicker();
  uiAlert("表紙がない本の指定が完了しました。");
}

function renderCandidates(cands) {
  const grid = $("candGrid");
  grid.innerHTML = "";
  if (cands.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = urlSubmitEnabled
      ? "候補が見つかりませんでした。下のURL指定を使ってください。"
      : "候補が見つかりませんでした。キーワードを変えて検索してみてください。";
    grid.appendChild(p);
    return;
  }
  for (const c of cands) grid.appendChild(candCell(c));
}

function candCell(c) {
  const cell = document.createElement("button");
  cell.className = "cand";
  cell.type = "button";
  const img = document.createElement("img");
  img.alt = c.label;
  img.loading = "lazy";
  img.onerror = () => cell.remove();
  applyCover(img, c.src);
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
  return cell;
}

// 表紙はサイト全体で ISBN ごとに1つ（covers）。リストは表示時にそれを引くので、ISBN の
// ある本の表紙は「全体に反映された時だけ」変わる。サーバは表紙がまだ無い ISBN なら即反映し、
// 既にある ISBN は上書きせず管理者への提案に回す（src/corrections.ts suggestCover）。
// ISBN の無い本は全体のキーが無いので、従来どおりこのリストだけの表紙として持つ。
async function applyPickedCover(url) {
  const fixing = state.fixIndex >= 0;
  const it = fixing ? state.items[state.fixIndex] : state.pending;
  if (!it) return;
  if (it.isbn && url) {
    const res = await submitCover(it.isbn, url);
    if (!res) {
      uiAlert("表紙の保存に失敗しました。時間をおいて再度お試しください。");
      return;
    }
    if (res.applied) {
      it.cover_url = res.cover_url || url;
    } else if (res.cover_url) {
      it.cover_url = res.cover_url; // 全体の表紙に揃える
    }
    // 全体の表紙が決まったので、編集中ポップアップを閉じても棚の本が古い表紙のまま残らないよう揃える。
    if (!fixing && state.editIndex >= 0 && state.items[state.editIndex] && it.cover_url) {
      state.items[state.editIndex].cover_url = it.cover_url;
      saveDraft();
      render();
    }
    if (!res.applied) {
      const has = !!res.cover_url;
      uiAlert(
        res.queued
          ? has
            ? "この本にはすでに表紙があります。変更の提案を送りました（管理者が確認して全体に反映します）。"
            : "この画像は確認が必要なため、提案として送りました（管理者が確認して全体に反映します）。"
          : has
            ? "この本にはすでにサイト共通の表紙があるため、ここでは変更できません。"
            : "この画像はすぐには反映できません。楽天ブックス・ブックオフ・駿河屋・もったいない本舗の画像を選んでください。"
      );
    }
  } else {
    it.cover_url = url;
  }
  if (fixing) {
    saveDraft();
    render();
    advanceFix(state.fixIndex);
    return;
  }
  renderEditCover(state.pending);
  closeCoverPicker();
}

// POST /api/cover-suggestions。{ applied, queued, cover_url } を返す。失敗時は null。
async function submitCover(isbn, url) {
  try {
    const res = await fetch("/api/cover-suggestions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbn, cover_url: url }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function closeCoverPicker() {
  pickSeq++; // drop answers still in flight
  $("pickModal").classList.remove("open");
  state.fixIndex = -1;
  $("skipFix").style.display = "none";
}

// Toolbar search: opens the add modal and runs the search with the typed query.
function topSearch() {
  const q = $("topSearch").value.trim();
  if (q.length < 2) { uiAlert("2文字以上で検索してください"); return; }
  // Drop focus so the mobile soft keyboard folds away while results load.
  $("topSearch").blur();
  openAdd();
  doSearch(q);
}

async function doSearch(q) {
  lastQuery = q;
  liveFetchedQuery = "";
  $("searchSpinner").style.display = "";
  clearResults();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "検索に失敗しました");
    renderResults(data.results || [], data.isbn_miss);
  } catch (e) {
    clearResults();
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
// The query whose live fetch already succeeded. The live bar is rebuilt on every
// renderResults, so this keeps its button in the done state for that query.
let liveFetchedQuery = "";

// Search returns series-level results. Clicking one drills into its volumes.
function renderResults(results, isbnMiss = false) {
  lastResults = results;
  const box = clearResults();

  if (results.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    // 最新DBからの取得は書名で探すので、ISBN で見つからないときは書名検索へ誘導する。
    p.textContent = isbnMiss
      ? "このISBNはまだ収録されていません。書名で検索して、下の「最新DBから取得」を試してください。"
      : "見つかりませんでした。別の語か、下の「最新DBから取得」を試してください。";
    box.appendChild(p);
  }
  const pending = [];
  for (const r of results) box.appendChild(buildResultCard(r, pending));
  mountCoverFetch($("searchActions"), pending);

  // 常設: マスタ(月次ダンプ)に無い作品を live MADB からキーワードで取得する導線。
  // マスタ検索が0件でも手詰まりにならないよう、結果の有無にかかわらず末尾に出す。
  box.appendChild(buildLiveBar());
}

// Keyword live-fetch bar shown below every result set. Probes MADB SPARQL for the
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
  if (liveFetchedQuery === lastQuery) {
    btn.textContent = "取得しました";
    btn.disabled = true;
  } else {
    btn.textContent = `「${lastQuery}」を最新DBから取得`;
    btn.addEventListener("click", () => liveFetch(lastQuery, btn));
  }
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
    badge.textContent = r.source === "rakuten" ? "楽天ブックス" : "最新DB";
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
    liveFetchedQuery = q;
    if (!live.length) {
      btn.textContent = "取得しました";
      uiAlert("最新DBに該当するシリーズは見つかりませんでした。");
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
    uiAlert(e.message || "取得に失敗しました");
  }
}

function coverImg(url, alt) {
  if (url) {
    const img = document.createElement("img");
    img.alt = alt || "";
    img.loading = "lazy";
    img.onerror = () => { img.replaceWith(noimg()); };
    applyCover(img, url);
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
//
// Auto-retry: a single POST only resolves a handful of covers before
// resolveCovers' wall-clock budget cuts off the rest, which come back *absent*
// from the response (undetermined — not cached). We keep re-POSTing just those
// leftovers, pausing between rounds so Rakuten/Yahoo's 1 req/s limiters refill,
// until everything resolves. An isbn that comes back present-but-empty ("") is a
// determined "no cover" and is final — we don't retry it. We stop when a whole
// round makes no progress (server genuinely can't resolve the rest right now), so
// even a long series fills over as many rounds as it takes without looping forever.
const COVER_RETRY_PAUSE_MS = 1200;
const COVER_RETRY_CAP = 40; // hard backstop against a pathological no-progress loop

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
    const total = entries.length;
    let done = 0;
    const paint = () => {
      const left = total - done;
      status.style.display = left > 0 ? "" : "none";
      if (left > 0) status.textContent = `表紙を取得中… 残り${left}件`;
    };
    paint();
    let todo = entries.slice();
    for (let round = 0; round < COVER_RETRY_CAP && todo.length; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, COVER_RETRY_PAUSE_MS));
      const next = [];
      for (let i = 0; i < todo.length; i += COVER_CHUNK) {
        const chunk = todo.slice(i, i + COVER_CHUNK);
        const isbns = [];
        for (const e of chunk) isbns.push(...e.isbns);
        const map = await fetchCovers(isbns);
        for (const e of chunk) {
          const url = firstCoverFrom(e.isbns, map);
          if (url) {
            e.set(url);
            done++;
          } else if (e.isbns.every((x) => x in map)) {
            done++; // determined "no cover" — final, don't retry
          } else {
            next.push(e); // undetermined (budget-skipped) — retry next round
          }
        }
        paint();
      }
      // Stop if a whole round resolved nothing new — retrying further won't help
      // (server can't resolve these right now); leave them as placeholders.
      if (next.length === todo.length) break;
      todo = next;
    }
    status.style.display = "none";
  });
}

// シリーズに属さない巻のまとまり（書名+著者）の疑似 ID。シリーズと同じく巻一覧・結合依頼の
// 対象になるが、C-id 前提の訂正・通報・補完は出さない（src/groups.ts）。
const isGroupId = (id) => /^G\d{13}$/.test(id || "");

async function openSeries(series) {
  // live 検索の結果、および series に未リンクの巻（マスタで schema:isPartOf 欠落）は
  // ローカルに C-id が無く、巻がカードに埋め込まれている。サーバを叩かずそのまま表示する
  // （追加は ISBN ベースなので C-id 不要。補完/訂正/通報も C-id 前提なので出さない）。
  if (series.live || series.unlinked) {
    renderVolumes(series, series.volumes || [], { probed: true, live: true });
    return;
  }
  const box = clearResults();
  const spin = document.createElement("p");
  spin.className = "hint";
  spin.textContent = "巻を読み込み中...";
  box.appendChild(spin);
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(series.series_id)}/volumes`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "取得に失敗しました");
    // 管理者が結合済みのシリーズを開いた場合、サーバは残す側を返す。以降の通報・補完・
    // ID 表示が残す側に向くよう読み替える。
    if (data.series_id && data.series_id !== series.series_id) {
      series.series_id = data.series_id;
      series.title = data.title || series.title;
    }
    if (data.group) {
      renderVolumes(series, data.volumes || [], { probed: true, live: true });
      return;
    }
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
// Series whose 最新巻 fetch already ran in this session. Their button renders as a
// disabled "取得しました" (no re-fetch); keyed by C-id, or title for live series.
const supplementFetched = new Set();
function supKey(series) {
  return series.series_id || `live:${normKey(series.title)}`;
}

async function fetchSupplement(series, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "取得中…";
  try {
    const data = await probeSupplement(series.series_id);
    series.unconfirmed = false;
    supplementFetched.add(supKey(series));
    renderVolumes(series, data.volumes || [], {
      probed: true,
      checkedAt: data.supplement_checked_at || Date.now(),
      masterAt: data.master_updated_at || 0,
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    uiAlert(e.message || "取得に失敗しました");
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
    supplementFetched.add(supKey(series));
    if (!match) {
      btn.textContent = "取得しました";
      uiAlert("最新DBに該当するシリーズは見つかりませんでした。");
      return;
    }
    series.volumes = match.volumes;
    series.volume_count = match.volume_count;
    if (!series.cover_url) series.cover_url = match.cover_url;
    renderVolumes(series, match.volumes || [], { probed: true, live: true });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    uiAlert(e.message || "取得に失敗しました");
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
  const box = clearResults();

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
  if (!series.fromBook) bar.appendChild(back);
  if (visible.length > 0) {
    const addAll = document.createElement("button");
    addAll.type = "button";
    addAll.className = "primary";
    addAll.textContent = `全${visible.length}巻を追加`;
    addAll.addEventListener("click", () => bulkAddSeries(visible));
    bar.appendChild(addAll);
  }
  box.appendChild(bar);

  // この端末で「間違っています」と非表示にした巻を、本人が戻せる導線（誤タップ救済）。
  if (hidden.length) box.appendChild(buildHiddenRestore(series, volumes, hidden, opts));

  const head = $("searchSubtitle");
  const titleEl = document.createElement("span");
  titleEl.className = "st";
  titleEl.textContent = series.title;
  head.appendChild(titleEl);
  head.hidden = false;
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
  if (series.series_id && (!opts.live || isGroupId(series.series_id))) {
    // 同じ作品がマスタ上で別シリーズに分裂している（例: One piece SJR 版が 1巻だけ別 C-id）
    // ときの結合依頼。名前の通報と同じく collect-only で、結合は管理者が確定してから。
    const mergeFlag = document.createElement("button");
    mergeFlag.type = "button";
    mergeFlag.className = "report-flag name-report-flag";
    mergeFlag.title = "同じ作品が別のシリーズに分かれている場合に結合を依頼（管理者が確認して結合します）";
    mergeFlag.setAttribute("aria-label", "シリーズが分かれている");
    const mIcon = document.createElement("span");
    mIcon.className = "flag-icon";
    mIcon.textContent = "⇄";
    const mText = document.createElement("span");
    mText.className = "flag-text";
    mText.textContent = "シリーズが分かれている？";
    mergeFlag.appendChild(mIcon);
    mergeFlag.appendChild(mText);
    mergeFlag.addEventListener("click", (e) => {
      e.stopPropagation();
      if (noHover() && !mergeFlag.classList.contains("revealed")) {
        mergeFlag.classList.add("revealed");
        return;
      }
      openMergeRequest(series, volumes, opts);
    });
    if (!head.querySelector(".name-report-flag")) head.appendChild(document.createTextNode(" "));
    head.appendChild(mergeFlag);
  }
  // 作者・出版社（検索カードと同じ並び）。シリーズに作者が無ければ先頭巻の著者で補う。
  const byline = [series.creator || (visible[0] && visible[0].author), series.publisher].filter(Boolean).join(" / ");
  if (byline) {
    const sa = document.createElement("div");
    sa.className = "sa";
    sa.textContent = byline;
    head.appendChild(sa);
  }

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

  // マスタ(月次ダンプ)に未リンクの新刊を、このボタンを押したときだけ取得する（閲覧を SPARQL
  // 往復でブロックしないため）。巻一覧の末尾に置く。
  // ・通常のマスタ series … サーバの /supplement を叩き、最終確認日を併記する。
  // ・live 由来（キーワード取得でマージした／live-only）… サーバ補完はマスタ著者で照合するため
  //   巻数が減りうる。代わりにキーワードライブ検索をやり直して埋め込み巻を更新する。
  // 1 回取得したら（このセッション中は）「取得しました」で押せなくする。
  const supBar = document.createElement("div");
  supBar.className = "vol-bar sup-bar";
  const fetchNew = document.createElement("button");
  fetchNew.type = "button";
  fetchNew.className = "sup-btn";
  if (supplementFetched.has(supKey(series))) {
    fetchNew.textContent = "取得しました";
    fetchNew.disabled = true;
  } else if (opts.live) {
    fetchNew.textContent = "最新DBから取得";
    fetchNew.addEventListener("click", () => refetchLiveSeries(series, fetchNew));
  } else {
    fetchNew.textContent = "最新巻を取得";
    fetchNew.addEventListener("click", () => fetchSupplement(series, fetchNew));
  }
  supBar.appendChild(fetchNew);
  if (!opts.live) {
    const parts = [];
    if (opts.masterAt) parts.push(`マスター更新 ${fmtDate(opts.masterAt)}`);
    if (opts.probed && opts.checkedAt) parts.push(`最終確認 ${fmtDate(opts.checkedAt)}`);
    if (parts.length) {
      const stamp = document.createElement("span");
      stamp.className = "hint sup-stamp";
      stamp.textContent = parts.join("・");
      supBar.appendChild(stamp);
    }
    // 通報・問い合わせ時に特定しやすいよう、マスタのシリーズID(C-id)を添える。
    // ID 部分だけを選択/コピーできるようにラベルと分け、コピーボタンも付ける。
    if (series.series_id) supBar.appendChild(buildSeriesIdLine(series.series_id));
  } else if (isGroupId(series.series_id)) {
    // まとまりも結合依頼の相手として ID で指定できるよう表示する。
    supBar.appendChild(buildSeriesIdLine(series.series_id));
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
    row.addEventListener("click", () => openVolumeDetail(v));
    box.appendChild(row);
    if (!v.cover_url && v.isbns && v.isbns.length) {
      pending.push({
        isbns: v.isbns,
        set: (url) => { v.cover_url = url; const img = coverImg(url, v.title); cell.replaceWith(img); cell = img; },
      });
    }
  }
  box.appendChild(supBar);
  mountCoverFetch($("searchActions"), pending);
}

function buildSeriesIdLine(id) {
  const line = document.createElement("span");
  line.className = "hint series-id-line";
  line.appendChild(document.createTextNode("ID "));
  const sid = document.createElement("span");
  sid.className = "series-id";
  sid.textContent = id;
  line.appendChild(sid);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "linkbtn copy-id";
  btn.textContent = "コピー";
  btn.addEventListener("click", () => {
    navigator.clipboard?.writeText(id).then(() => {
      btn.textContent = "コピーしました";
      setTimeout(() => { btn.textContent = "コピー"; }, 1500);
    });
  });
  line.appendChild(btn);
  return line;
}

function volLabel(v) {
  return v.volume_number ? `${v.title} ${v.volume_number}` : v.title;
}

// Gaps in a series' volume numbering. Tolerates oddly-labeled volumes (e.g. ゴルゴ13
// mixes "50巻" / "第100巻" / "volume. 155" in among bare "1".."202"): their embedded
// number still counts as present, so those aren't reported as gaps. The range comes
// from clean labels (巻N / N) plus unmistakable volume labels (第N巻 / N巻 / vol. N /
// "170　／　第170巻" / arc-suffixed "2 (東の海編)"), so a series filed mostly as 第N巻
// (こち亀) or entirely with arc labels (One piece SJR 版 C451211) is still judged; any
// other odd label only marks presence, never extends the range (so a stray "2020年版"
// can't invent gaps). Missing leading volumes are reported too when the series starts
// at 2〜3 (こち亀 lacks 1巻 upstream) — a later start is more likely a continuation
// numbering than a hole. Bails on genuinely mixed clean formats or too little numbering.
// Returns [{ n, vol, disp }] where `vol` is the server-accepted volume_number to
// store ("巻110" / "110") and `disp` is the human label ("110巻").
function detectGaps(volumes) {
  let kan = 0;
  let num = 0;
  const rangeInts = [];
  const present = new Set();
  for (const v of volumes) {
    const s = (v.volume_number || "").trim();
    if (!s) continue;
    let m;
    if ((m = /^巻(\d+)$/.exec(s))) {
      kan++;
      rangeInts.push(parseInt(m[1], 10));
    } else if ((m = /^(\d+)$/.exec(s))) {
      num++;
      rangeInts.push(parseInt(m[1], 10));
    } else if (
      (m = /第\s*(\d+)\s*巻/.exec(s)) ||
      (m = /^(\d+)\s*巻$/.exec(s)) ||
      (m = /^vol(?:ume)?\.?\s*(\d+)$/i.exec(s)) ||
      (m = /^(\d+)\s*[(（][^()（）]*[)）]$/.exec(s))
    ) {
      rangeInts.push(parseInt(m[1], 10));
    } else {
      const mm = s.match(/\d+/); // other odd label: count its number as present only
      if (mm) present.add(parseInt(mm[0], 10));
    }
  }
  for (const n of rangeInts) present.add(n);
  if (kan > 0 && num > 0) return []; // genuinely mixed formats ⇒ ambiguous
  if (rangeInts.length < 2) return []; // no trustworthy numbering to judge gaps
  const fmt = kan > 0 ? "KAN" : "NUM";
  const min = Math.min(...rangeInts);
  const max = Math.max(...rangeInts);
  const from = min >= 2 && min <= 3 ? 1 : min + 1;
  const gaps = [];
  for (let i = from; i < max; i++) {
    if (!present.has(i)) {
      gaps.push({ n: i, vol: fmt === "KAN" ? `巻${i}` : `${i}`, disp: `${i}巻` });
    }
  }
  return gaps;
}

// Assisted search (Rakuten by title+volume) for one missing volume. Renders the
// candidates inline; picking one stages it exactly like selectVolume.
async function openGapPicker(series, gap, volumes) {
  const box = clearResults();
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

  // Rakuten's title search can't reach every volume (こち亀 1巻 is stocked but no
  // "<title> 1" phrase lands on it), so always offer a direct ISBN entry as the
  // fallback. The server re-resolves the cover and rejects ISBNs without one.
  const isbnHint = document.createElement("p");
  isbnHint.className = "hint";
  isbnHint.textContent = "候補に無い場合は ISBN を直接指定できます。";
  const isbnRow = document.createElement("div");
  isbnRow.className = "share-url";
  const isbnInput = document.createElement("input");
  isbnInput.type = "text";
  isbnInput.inputMode = "numeric";
  isbnInput.placeholder = "ISBN13（例: 9784088528113）";
  const isbnBtn = document.createElement("button");
  isbnBtn.type = "button";
  isbnBtn.textContent = "このISBNで追加";
  const submitIsbn = () => {
    const isbn = isbnInput.value.replace(/[^0-9]/g, "");
    if (isbn.length !== 13) {
      uiAlert("ISBN は13桁（978…）で入力してください");
      return;
    }
    pickManualVolume(series, gap, { isbn, cover_url: "" }, volumes);
  };
  isbnBtn.addEventListener("click", submitIsbn);
  isbnInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) submitIsbn();
  });
  isbnRow.appendChild(isbnInput);
  isbnRow.appendChild(isbnBtn);
  const appendIsbnRow = () => {
    box.appendChild(isbnHint);
    box.appendChild(isbnRow);
  };

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
    appendIsbnRow();
    return;
  }

  if (!candidates.length) {
    head.textContent = `${series.title} ${gap.disp} の候補が見つかりませんでした。`;
    appendIsbnRow();
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
  appendIsbnRow();
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
    uiAlert(e.message || "保存に失敗しました");
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
  if (!(await uiConfirm(`「${volLabel(v)}」を誤りとして通報します。あなたの画面では非表示になります（他の人には管理者が確認するまで表示されます）。誤って通報しても「非表示にした巻」からいつでも戻せます。よろしいですか？`))) return;
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
    uiAlert(e.message || "通報に失敗しました");
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
  // 正しい名前の提案は任意。入力欄は現在のタイトルを初期値にして部分修正しやすくする。
  // 空にして送れば従来どおり「名前が違う」だけの通報。現在と同じ名前のままでは送れない。
  const normalize = (v) => v.replace(/\s+/g, " ").trim();
  const current = normalize(series.title);
  const input = await uiPrompt(
    `このシリーズ名「${series.title}」が誤っていると通報します。管理者が確認して修正します。\n正しい名前を入力してください（分からなければ空欄のまま送れます）。`,
    series.title,
    {
      placeholder: "正しいシリーズ名（任意・100文字まで）",
      okLabel: "通報する",
      validate: (v) => (normalize(v) === current ? "現在と同じ名前です。正しい名前に修正するか、空欄にしてください。" : ""),
    }
  );
  if (input === null) return;
  const suggested = normalize(input);
  btn.disabled = true;
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(series.series_id)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suggested_name: suggested.slice(0, 100) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "通報に失敗しました");
  } catch (e) {
    uiAlert(e.message || "通報に失敗しました");
    btn.disabled = false;
    return;
  }
  markReportedSeries(series.series_id);
  btn.classList.add("reported");
  btn.disabled = false;
  textEl.textContent = "シリーズ名の誤りを通報済み";
  uiAlert("通報ありがとうございました。管理者が確認して修正します。");
}

// 「シリーズが分かれている？」: 同じ作品の別シリーズを選んで結合を依頼する画面。開いた
// 時点でサーバの候補（同じタイトル・同じ著者）と、タイトルでの通常検索の結果を並べる。
// 検索語は変えられ、候補に無ければシリーズID（巻一覧の右上の C-id）でも追加できる。
// チェックした相手はまとめて 1 回で依頼する（検索し直しても選択は保持）。依頼は件数だけ
// 記録され、結合は管理者が確定する。
const MERGE_REQUEST_MAX = 10;
async function openMergeRequest(series, volumes, opts) {
  const box = clearResults();
  const bar = document.createElement("div");
  bar.className = "vol-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "linkbtn";
  back.textContent = "‹ 巻一覧へ戻る";
  back.addEventListener("click", () => renderVolumes(series, volumes, opts));
  bar.appendChild(back);
  box.appendChild(bar);

  const title = document.createElement("h3");
  title.className = "merge-title";
  title.textContent = series.title;
  const selfId = document.createElement("span");
  selfId.className = "series-id";
  selfId.textContent = `ID ${series.series_id}`;
  title.appendChild(selfId);
  box.appendChild(title);

  const head = document.createElement("p");
  head.className = "hint";
  head.textContent = "同じ作品なのに別シリーズに分かれているものにチェックを入れて、結合を依頼してください（複数まとめて依頼できます）。管理者が確認して1つにまとめます。";
  box.appendChild(head);

  // 選択中の相手（series_id → 表示名）。検索し直しても保持する。
  const selected = new Map();

  const searchRow = document.createElement("div");
  searchRow.className = "share-url";
  const qInput = document.createElement("input");
  qInput.type = "text";
  qInput.value = series.title;
  qInput.placeholder = "タイトル・著者で検索";
  const qBtn = document.createElement("button");
  qBtn.type = "button";
  qBtn.textContent = "検索";
  searchRow.appendChild(qInput);
  searchRow.appendChild(qBtn);
  box.appendChild(searchRow);

  const status = document.createElement("p");
  status.className = "hint";
  box.appendChild(status);

  const list = document.createElement("div");
  box.appendChild(list);

  const idHint = document.createElement("p");
  idHint.className = "hint";
  idHint.textContent = "見つからない場合は、相手のシリーズIDで追加できます（巻一覧の下に「ID C…」「ID G…」などと表示されています）。";
  const idRow = document.createElement("div");
  idRow.className = "share-url";
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.placeholder = "シリーズID（例: C451211）";
  const idBtn = document.createElement("button");
  idBtn.type = "button";
  idBtn.textContent = "選択に追加";
  idRow.appendChild(idInput);
  idRow.appendChild(idBtn);
  box.appendChild(idHint);
  box.appendChild(idRow);

  // 画面下に貼り付く送信欄: 選択中の相手のチップと送信ボタン。
  const footer = document.createElement("div");
  footer.className = "merge-submit";
  const chips = document.createElement("div");
  chips.className = "merge-chips";
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "primary";
  footer.appendChild(chips);
  footer.appendChild(sendBtn);
  box.appendChild(footer);

  const refresh = () => {
    chips.replaceChildren();
    for (const [id, name] of selected) {
      const chip = document.createElement("span");
      chip.className = "merge-chip";
      chip.textContent = name;
      if (name !== `ID ${id}`) {
        const cid = document.createElement("span");
        cid.className = "series-id";
        cid.textContent = id;
        chip.appendChild(cid);
      }
      const x = document.createElement("button");
      x.type = "button";
      x.className = "linkbtn";
      x.textContent = "×";
      x.setAttribute("aria-label", `${name} を選択から外す`);
      x.addEventListener("click", () => {
        selected.delete(id);
        refresh();
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    sendBtn.textContent = selected.size ? `選択した ${selected.size} 件の結合を依頼` : "結合する相手を選んでください";
    sendBtn.disabled = !selected.size;
    for (const cb of list.querySelectorAll("input[data-sid]")) cb.checked = selected.has(cb.dataset.sid);
  };

  // 選択に加える。上限・自分自身・依頼済みはここで弾く。
  const select = (id, name) => {
    if (selected.has(id)) return true;
    if (id === series.series_id) {
      uiAlert("このシリーズ自身です");
      return false;
    }
    if (isMergeRequested(series.series_id, id)) {
      uiAlert("このシリーズとの結合は依頼済みです。");
      return false;
    }
    if (selected.size >= MERGE_REQUEST_MAX) {
      uiAlert(`一度に依頼できるのは ${MERGE_REQUEST_MAX} 件までです`);
      return false;
    }
    selected.set(id, name);
    return true;
  };

  const renderList = (items) => {
    list.replaceChildren();
    for (const c of items) list.appendChild(buildMergeCandRow(series, c, selected, select, refresh));
    refresh();
  };

  const addId = () => {
    const other = idInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(other)) {
      uiAlert("シリーズIDを入力してください（例: C451211）");
      return;
    }
    const shown = [...list.querySelectorAll(".merge-cand")].find((r) => r._cand.series_id === other);
    if (select(other, shown ? shown._cand.title : `ID ${other}`)) {
      idInput.value = "";
      refresh();
    }
  };
  idBtn.addEventListener("click", addId);
  idInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) addId();
  });

  sendBtn.addEventListener("click", async () => {
    const ids = [...selected.keys()];
    if (!(await sendMergeRequest(series, ids, sendBtn))) return;
    selected.clear();
    // 依頼済みの行を無効化して描き直す。
    for (const row of list.querySelectorAll(".merge-cand")) row.replaceWith(buildMergeCandRow(series, row._cand, selected, select, refresh));
    for (const p of list.querySelectorAll(".merge-preview")) p.remove();
    refresh();
  });

  // 検索結果のうち、結合の相手になれるシリーズとまとまり（自分・最新DB由来は除く）。
  const usable = (r) =>
    r.series_id && !r.live && (!r.unlinked || isGroupId(r.series_id)) && r.series_id !== series.series_id;
  let seq = 0;
  const search = async (q, extra) => {
    const my = ++seq;
    status.textContent = "検索中...";
    list.replaceChildren();
    let results = [];
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "検索に失敗しました");
      results = data.results || [];
    } catch (e) {
      if (my !== seq) return;
      status.textContent = e.message || "検索に失敗しました";
      if (extra && extra.length) renderList(extra);
      return;
    }
    if (my !== seq) return;
    const seen = new Set();
    const items = [...(extra || []), ...results.filter(usable)].filter((c) => {
      if (seen.has(c.series_id)) return false;
      seen.add(c.series_id);
      return true;
    });
    status.textContent = items.length
      ? `「${q}」の検索結果（行を押すと巻の表紙を確認できます）:`
      : `「${q}」で別のシリーズは見つかりませんでした。検索語を変えるか、シリーズIDで追加してください。`;
    renderList(items);
  };
  const runSearch = () => {
    const q = qInput.value.trim();
    if (q.length < 2) {
      uiAlert("2文字以上で検索してください");
      return;
    }
    qInput.blur();
    search(q);
  };
  qBtn.addEventListener("click", runSearch);
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) runSearch();
  });

  refresh();
  // 初回: 同じタイトル・同じ著者の候補（巻ラベル付き）を先頭に、タイトル検索の結果を続ける。
  status.textContent = "候補を検索中...";
  let candidates = [];
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(series.series_id)}/merge-candidates`);
    const data = await res.json();
    if (res.ok) candidates = data.candidates || [];
  } catch {
    // 候補が取れなくても検索結果だけで続ける
  }
  if (series.title.trim().length >= 2) await search(series.title.trim(), candidates);
  else {
    status.textContent = candidates.length ? "同じタイトル・同じ著者の別シリーズ:" : "検索語を入力して検索してください。";
    renderList(candidates);
  }
}

// 結合依頼画面の 1 行。左のチェックで選択、行そのものを押すと巻のプレビューを開閉する。
function buildMergeCandRow(series, c, selected, select, refresh) {
  const row = document.createElement("div");
  row.className = "result merge-cand";
  row._cand = c;
  const requested = isMergeRequested(series.series_id, c.series_id);
  const check = document.createElement("label");
  check.className = "merge-check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.sid = c.series_id;
  cb.checked = selected.has(c.series_id);
  cb.disabled = requested;
  cb.setAttribute("aria-label", `${c.title} を選択`);
  cb.addEventListener("change", () => {
    if (cb.checked) {
      if (!select(c.series_id, c.title)) cb.checked = false;
    } else {
      selected.delete(c.series_id);
    }
    refresh();
  });
  check.appendChild(cb);
  check.addEventListener("click", (e) => e.stopPropagation());
  row.appendChild(check);

  const info = document.createElement("div");
  info.className = "info";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = c.title;
  const sid = document.createElement("span");
  sid.className = "series-id";
  sid.textContent = ` ID ${c.series_id}`;
  t.appendChild(sid);
  const a = document.createElement("div");
  a.className = "a";
  a.textContent = [c.creator, c.publisher, c.label].filter(Boolean).join(" / ");
  const v = document.createElement("div");
  v.className = "a merge-vols";
  if (c.labels && c.labels.length) {
    const more = c.volume_count > c.labels.length ? " …" : "";
    v.textContent = `全${c.volume_count}巻: ${c.labels.join(", ")}${more}`;
  } else {
    v.textContent = `全${c.volume_count}巻`;
  }
  info.appendChild(t);
  info.appendChild(a);
  info.appendChild(v);
  row.appendChild(info);
  if (requested) {
    const done = document.createElement("span");
    done.className = "merge-done";
    done.textContent = "依頼済み";
    row.appendChild(done);
  }
  // 行を押すと、その候補の巻（表紙）をすぐ下にプレビューする。もう一度押すと閉じる。
  let preview = null;
  row.addEventListener("click", () => {
    if (preview) {
      preview.remove();
      preview = null;
      row.classList.remove("open");
      return;
    }
    preview = buildMergePreview(c.series_id);
    row.classList.add("open");
    row.after(preview);
  });
  return row;
}

// 結合候補のプレビュー: 巻一覧 API から巻を取り、表紙と巻ラベルを横並びで見せる。表紙は
// キャッシュ分を即表示し、未取得は先頭の数件だけ解決して埋める（閲覧で楽天を叩きすぎない）。
function buildMergePreview(seriesId) {
  const box = document.createElement("div");
  box.className = "merge-preview";
  const msg = document.createElement("p");
  msg.className = "hint";
  msg.textContent = "読み込み中...";
  box.appendChild(msg);
  (async () => {
    let data;
    try {
      const res = await fetch(`/api/series/${encodeURIComponent(seriesId)}/volumes`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || "取得に失敗しました");
    } catch (e) {
      msg.textContent = e.message || "取得に失敗しました";
      return;
    }
    const vols = data.volumes || [];
    if (!vols.length) {
      msg.textContent = "巻が見つかりませんでした。";
      return;
    }
    msg.remove();
    const strip = document.createElement("div");
    strip.className = "merge-preview-strip";
    const missing = [];
    for (const v of vols) {
      const cell = document.createElement("div");
      cell.className = "merge-preview-vol";
      let cover = coverImg(v.cover_url, v.title);
      cell.appendChild(cover);
      const lab = document.createElement("div");
      lab.className = "merge-preview-label";
      lab.textContent = v.volume_number || "-";
      lab.title = v.title;
      cell.appendChild(lab);
      strip.appendChild(cell);
      if (!v.cover_url) {
        missing.push({
          isbns: v.isbns || [v.isbn],
          set: (url) => {
            const img = coverImg(url, v.title);
            cover.replaceWith(img);
            cover = img;
          },
        });
      }
    }
    box.appendChild(strip);
    const first = missing.slice(0, COVER_CHUNK);
    if (first.length) {
      const map = await fetchCovers(first.flatMap((m) => m.isbns));
      for (const m of first) {
        const url = firstCoverFrom(m.isbns, map);
        if (url) m.set(url);
      }
    }
  })();
  return box;
}

// 選んだ相手をまとめて 1 リクエストで依頼する。成功したら true。
async function sendMergeRequest(series, otherIds, btn) {
  if (!otherIds.length) return false;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "送信中…";
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(series.series_id)}/merge-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ other_ids: otherIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "依頼に失敗しました");
  } catch (e) {
    uiAlert(e.message || "依頼に失敗しました");
    btn.textContent = orig;
    btn.disabled = false;
    return false;
  }
  for (const id of otherIds) markMergeRequested(series.series_id, id);
  uiAlert(`${otherIds.length} 件の結合を依頼しました。管理者が確認して反映します。`);
  return true;
}

// 結合を依頼したシリーズの組の端末ローカル台帳（localStorage）。二重依頼を防ぐ。
const MERGE_REQUESTS_KEY = "my100manga_merge_requests_v1";
function mergePairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function mergeRequestedSet() {
  try {
    const raw = localStorage.getItem(MERGE_REQUESTS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}
function isMergeRequested(a, b) {
  return mergeRequestedSet().has(mergePairKey(a, b));
}
function markMergeRequested(a, b) {
  const s = mergeRequestedSet();
  s.add(mergePairKey(a, b));
  try {
    localStorage.setItem(MERGE_REQUESTS_KEY, JSON.stringify([...s]));
  } catch {}
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

/* ---------- volume detail (巻一覧 → 詳細 → 追加) ---------- */
// 巻一覧で本を押しても即追加はせず、詳細（表紙・著者・出版社・発行日・あらすじ）を見せて
// 「リストに追加」を押したときだけ selectVolume する。巻一覧（searchModal）は開いたまま
// 上に重ねるので、閉じれば同じ一覧に戻って別の巻を見られる。
let volSeq = 0;
let volCurrent = null;

function openVolumeDetail(v) {
  volCurrent = v;
  const seq = ++volSeq;
  $("vTitle").textContent = volLabel(v);
  $("vAuthor").textContent = v.author || "";
  $("vAuthor").style.display = v.author ? "" : "none";
  setMetaRow("vPublisherRow", "vPublisher", v.publisher || "");
  setMetaRow("vPubdateRow", "vPubdate", v.pubdate || "");
  setMetaRow("vIsbnRow", "vIsbn", v.isbn || "");
  $("vSynopsis").textContent = "";
  $("vSynopsisBox").style.display = "none";
  renderCoverInto($("vCoverBox"), v);
  renderEditBuy({ isbn: v.isbn || "", title: volLabel(v), author: v.author || "" }, "v");

  const add = $("vAdd");
  const dup = !!(v.isbn && isDuplicate(toIsbn13(v.isbn)));
  add.disabled = dup;
  add.textContent = dup ? "追加済み" : "リストに追加";
  $("volModal").classList.add("open");

  if (!v.cover_url && v.isbns && v.isbns.length) {
    fetchCovers(v.isbns).then((covers) => {
      const url = firstCoverFrom(v.isbns, covers);
      if (!url) return;
      v.cover_url = url;
      if (seq === volSeq) renderCoverInto($("vCoverBox"), v);
    }).catch(() => {});
  }
  if (v.isbn) {
    fetch(`/api/book?isbn=${encodeURIComponent(v.isbn)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && seq === volSeq) applyBookMeta(data, "v");
      })
      .catch(() => {});
  }
}

function closeVolumeDetail() {
  $("volModal").classList.remove("open");
  volCurrent = null;
  volSeq++;
}

async function addFromVolumeDetail() {
  const v = volCurrent;
  if (!v) return;
  closeVolumeDetail();
  await selectVolume(v);
}

// 1 巻をリストへ追加する（巻一覧では詳細ポップアップの「リストに追加」から呼ばれる）。
// コメント/ネタバレ/表紙はあとで編集ポップアップから設定する（本の差し替えは「削除して
// 再追加」の運用）。
async function selectVolume(v) {
  const isbn = toIsbn13(v.isbn);
  if (isbn && isDuplicate(isbn)) { uiAlert("この本はすでに追加されています。"); return; }
  if (state.items.length >= MAX_ITEMS) {
    uiAlert(`追加できるのは${MAX_ITEMS}作品までです。`);
    return;
  }
  // The background fill usually resolves the cover before the user clicks; if not,
  // resolve it now so it's baked into the item.
  if (!v.cover_url && v.isbns && v.isbns.length) {
    v.cover_url = firstCoverFrom(v.isbns, await fetchCovers(v.isbns));
  }
  state.items.push({
    isbn,
    title: volLabel(v),
    author: v.author || "",
    cover_url: v.cover_url || "",
    comment: "",
    spoiler: false,
  });
  render();
  saveDraft();
  closeSearch();
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
    const isbn = toIsbn13(v.isbn);
    if (!isbn) return true;
    if (existing.has(isbn)) return false;
    existing.add(isbn);
    return true;
  });
  const skipped = volumes.length - fresh.length;
  if (fresh.length === 0) {
    uiAlert("この巻はすべて追加済みです。");
    return;
  }
  const room = MAX_ITEMS - state.items.length;
  if (room <= 0) {
    uiAlert(`これ以上追加できません（上限${MAX_ITEMS}作品）。`);
    return;
  }
  const n = Math.min(room, fresh.length);
  const toAdd = fresh.slice(0, n);
  // Push everything immediately with whatever cover we already have. Covers aren't
  // fetched here — the "表紙を取得" button (fetchMissingCovers) does it on demand.
  for (const v of toAdd) {
    state.items.push({
      isbn: toIsbn13(v.isbn),
      title: volLabel(v),
      author: v.author || "",
      cover_url: v.cover_url || "",
      comment: "",
      spoiler: false,
    });
  }
  closeSearch();
  render();
  saveDraft();
  const notes = [];
  if (skipped > 0) notes.push(`追加済み${skipped}巻はスキップ`);
  if (fresh.length > n) notes.push(`上限のため残り${fresh.length - n}巻は未追加`);
  if (notes.length) uiAlert(`${n}巻を追加しました（${notes.join("、")}）。`);
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
  const total = targets.length;
  let done = 0;
  const paint = () => {
    if (!statusEl) return;
    const left = total - done;
    statusEl.style.display = left > 0 ? "" : "none";
    if (left > 0) statusEl.textContent = `表紙を取得中… 残り${left}件`;
  };
  paint();
  // 自動リトライ: 1 回の POST は resolveCovers の予算内に収まる数しか解決できず、残りは
  // レスポンスから *欠落* で返る（未確定・未キャッシュ）。その欠落分だけを再 POST し、
  // レート制限が回復するよう間を置いて全部埋まるまで繰り返す。map に present-but-empty（""）で
  // 返ったものは「確定：表紙なし」なので retry せず coverTried に入れて打ち切る。欠落は
  // coverTried に入れず残すので、丸ごと 1 ラウンド進捗ゼロなら打ち切る（後で再クリック可能）。
  let todo = targets.slice();
  for (let round = 0; round < COVER_RETRY_CAP && todo.length; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, COVER_RETRY_PAUSE_MS));
    const next = [];
    for (let i = 0; i < todo.length; i += COVER_CHUNK) {
      const batch = todo.slice(i, i + COVER_CHUNK);
      const map = await fetchCovers(batch.map((it) => it.isbn));
      let changed = false;
      for (const it of batch) {
        const url = map[it.isbn];
        if (url) {
          it.cover_url = url;
          state.coverTried.add(it.isbn);
          done++;
          changed = true;
        } else if (it.isbn in map) {
          state.coverTried.add(it.isbn); // 確定「表紙なし」— 再試行しない
          done++;
        } else {
          next.push(it); // 予算超過で未確定 — 次ラウンドで再試行（coverTried には入れない）
        }
      }
      if (changed) {
        render();
        saveDraft();
      }
      paint();
    }
    if (next.length === todo.length) break; // 進捗ゼロ — これ以上は解決しない
    todo = next;
  }
  state.fetchingCovers = false;
  render();
}

function saveSlot() {
  if (!state.pending) return false;
  const commentText = $("comment").value;
  // コメントは匿名公開の自由入力なので URL は不可（スパム・誘導リンク対策）。
  if (/https?:\/\/|www\./i.test(commentText)) {
    uiAlert("コメントにURLは入力できません。URLを削除してください。");
    return false;
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
    uiAlert("この本はすでに追加されています。");
    return false;
  }
  if (state.editIndex >= 0) {
    state.items[state.editIndex] = item;
  } else {
    if (state.items.length >= MAX_ITEMS) {
      uiAlert(`追加できるのは${MAX_ITEMS}作品までです。`);
      return false;
    }
    state.items.push(item);
  }
  closeEdit();
  render();
  saveDraft();
  return true;
}

// Swipe on the edit card steps to the neighbouring slot. The current slot's edits
// are committed first (same as 更新), so swiping never loses what was typed; if the
// commit fails validation the move is cancelled. Clamped at the ends (the trailing
// 追加 slot isn't included).
function navigateEdit(dir) {
  const target = state.editIndex + dir;
  if (state.editIndex < 0 || target < 0 || target >= state.items.length) return false;
  if (!saveSlot()) return false;
  openEdit(target);
  return true;
}

function wireEditSwipe(content) {
  let startX = 0, startY = 0, dx = 0, axis = null, dragging = false;

  content.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { dragging = false; return; }
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; dx = 0; axis = null; dragging = true;
    content.style.transition = "none";
  }, { passive: true });

  content.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const mx = t.clientX - startX, my = t.clientY - startY;
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    }
    if (axis !== "x") return;
    e.preventDefault();
    dx = mx;
    const atStart = state.editIndex <= 0 && dx > 0;
    const atEnd = state.editIndex >= state.items.length - 1 && dx < 0;
    if (atStart || atEnd) dx *= 0.3;
    content.style.transform = `translateX(${dx}px)`;
  }, { passive: false });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    content.style.transition = "";
    if (axis === "x" && Math.abs(dx) > 60) navigateEdit(dx < 0 ? 1 : -1);
    content.style.transform = "";
  };
  content.addEventListener("touchend", endDrag);
  content.addEventListener("touchcancel", endDrag);
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

// Publish button: ask for the display name (and ひとこと) first, then publish/update.
function openPublishModal() {
  if (state.items.length !== TARGET) {
    uiAlert(`公開にはちょうど${TARGET}作品が必要です（現在${state.items.length}作品）。`);
    return;
  }
  $("ownerInput").value = state.owner || "";
  $("bioInput").value = state.bio || "";
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
    uiAlert("表示名にURLは入力できません。URLを削除してください。");
    return;
  }
  // ひとことは 1 行表示なので改行は空白に潰す（サーバ側でも同じ正規化をする）。
  const bio = $("bioInput").value.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (/https?:\/\/|www\./i.test(bio)) {
    uiAlert("ひとことにURLは入力できません。URLを削除してください。");
    return;
  }
  if (!state.editSlug) {
    const slug = $("slugInput").value.trim();
    if (slug && !/^[a-zA-Z0-9_-]{1,15}$/.test(slug)) {
      uiAlert("URLは英数字・ハイフン・アンダースコアのみ、15文字以内で入力してください。");
      return;
    }
    state.customSlug = slug;
  }
  state.owner = name.slice(0, 40);
  state.bio = bio.slice(0, 100);
  $("publishModal").classList.remove("open");
  doPublish();
}

async function doPublish() {
  const items = collectItems();
  if (items.length !== TARGET) {
    uiAlert(`公開にはちょうど${TARGET}作品が必要です（現在${items.length}作品）。`);
    return;
  }
  $("publish").disabled = true;
  try {
    let res;
    if (state.editSlug) {
      res = await fetch(`/api/lists/${state.editSlug}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_name: state.owner, bio: state.bio, items, edit_token: state.editToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新に失敗しました");
      clearEditDraft(state.editSlug);
      // What we just PUT is now the 公開状態 — rebase the diff on it.
      state.published = { owner: state.owner, bio: state.bio, items: items.map(normItem) };
      window.MyLists?.save({ slug: state.editSlug, token: state.editToken, owner: state.owner });
      showShare(state.editSlug, state.editToken);
    } else {
      const payload = { owner_name: state.owner, bio: state.bio, items };
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
    uiAlert(e.message || "エラーが発生しました");
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
  $("cancelSearch").addEventListener("click", closeSearch);
  $("saveSlot").addEventListener("click", saveSlot);
  $("removeSlot").addEventListener("click", removeSlot);
  $("cancelEdit").addEventListener("click", closeEdit);

  $("changeCoverBtn").addEventListener("click", openCoverPicker);
  $("refetchBook").addEventListener("click", (e) => refetchBook(e.currentTarget));
  // 同じページ内で巻一覧を開く（遷移すると ?edit= の編集セッションが外れるため）。
  $("eSeries").addEventListener("click", (e) => {
    e.preventDefault();
    const a = e.currentTarget;
    closeEdit();
    openSeriesFromBook(a.dataset.seriesId, a.textContent);
  });
  $("cancelPick").addEventListener("click", closeCoverPicker);
  $("useUrl").addEventListener("click", () => {
    if (!urlSubmitEnabled) return; // input is hidden when disabled; guard the bypass too
    const url = $("urlInput").value.trim();
    if (!/^https?:\/\//i.test(url)) { uiAlert("http(s) の画像URLを指定してください。"); return; }
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

  $("searchModal").addEventListener("click", (e) => { if (e.target.id === "searchModal") closeSearch(); });
  $("volModal").addEventListener("click", (e) => { if (e.target.id === "volModal") closeVolumeDetail(); });
  $("vClose").addEventListener("click", closeVolumeDetail);
  $("vAdd").addEventListener("click", addFromVolumeDetail);
  $("editModal").addEventListener("click", (e) => { if (e.target.id === "editModal") closeEdit(); });
  wireEditSwipe($("editModal").querySelector(".modal"));

  for (const id of ["shareModal", "publishModal"]) {
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

// デプロイ更新の検知: 自分が読み込んだ版（<meta app-version>）とサーバ現行版（/api/version）が
// 食い違ったら「新しいバージョンが公開されました」バナーを出す。長時間開きっぱなしの SPA タブが
// 古い app.js を使い続ける問題への対策。タブ復帰時に 60 秒スロットルで確認する。強制リロードは
// 編集中の入力を失わせうるので避け、再読み込みはユーザのボタン操作に委ねる。
(function watchVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  const boot = meta && meta.content;
  if (!boot || boot === "dev") return;
  let shown = false;
  let last = 0;
  async function check() {
    if (shown || Date.now() - last < 60000) return;
    last = Date.now();
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const cur = (await res.json()).version;
      if (!cur || cur === boot || shown) return;
      shown = true;
      const bar = document.createElement("div");
      bar.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;gap:12px;align-items:center;justify-content:center;padding:10px 16px;background:#1e293b;color:#fff;font-size:14px;box-shadow:0 -2px 8px rgba(0,0,0,.2)";
      bar.textContent = "新しいバージョンが公開されました。";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "再読み込み";
      btn.style.cssText =
        "padding:6px 14px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:14px";
      btn.addEventListener("click", () => location.reload());
      bar.appendChild(btn);
      document.body.appendChild(bar);
    } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("focus", check);
  setInterval(check, 120000);
})();
