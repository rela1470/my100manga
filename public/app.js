"use strict";

const TARGET = 100; // must have exactly this many to publish
const MAX_ITEMS = 1000; // soft cap while curating (drafts are localStorage-only, so this is safe)
const DRAFT_KEY = "my100manga_draft_v1";
const EDIT_TOKEN_KEY = "my100manga_edit_token"; // sessionStorage。index.html <head> と共通

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
  unlisted: false, // 限定公開: noindex にし、運営からの紹介対象にしない（URL を知っていれば見られる）
  fetchingCovers: false, // true while the "表紙を取得" bulk fill is running
  coverTried: new Set(), // isbns already fetched this session (miss or hit) — don't re-offer
  reorder: false, // true while in reorder mode (tap = select, not edit)
  placing: false, // reorder mode phase 2: selection is fixed, now tap where it goes
  selected: new Set(), // indices of cards picked to move; valid only between renders
};

const $ = (id) => document.getElementById(id);

/* ---------- init ---------- */
async function init() {
  const params = new URLSearchParams(location.search);
  const slug = params.get("edit");
  const token = takeEditToken(params, slug);
  if (slug && token) {
    await loadExisting(slug, token);
  } else {
    loadDraft();
  }
  render();
  syncCovers();
  renderMyLists();
  syncServerDraft();
  watchDraftFromOtherTabs();
  window.Account?.onBeforeLogout(flushServerDraft);
  document.addEventListener("my100manga:account-lists", () => renderMyLists());
  loadSiteStats();
  wireEvents();
  initAllAges();
  initSearchMode();
  openSeriesFromUrl(params);
  openSearchFromUrl(params);
  // /l/:slug が見つからなかったときはサーバがここへリダイレクトしてくる。
  if (params.get("notfound") === "list") {
    params.delete("notfound");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
    uiAlert("リストが見つかりませんでした。削除されたか、URLが間違っている可能性があります。");
  }
}

// 編集用URL（/?edit=<slug>&t=<token>）の token を取り出す。token は計測・広告タグに URL ごと
// 渡らないよう index.html <head> の小さなスクリプトがアドレスバーから消して sessionStorage
// （使えなければ window.__EDIT_TOKEN__）へ移している。ここではそれを読み、URL に残っていれば
// （head のスクリプトが動かなかった場合）同じように消す。どれにも無ければこのブラウザの
// 「作ったリスト」の記録（MyLists）から補う。?edit= は残すので再読み込みしても編集を続けられる。
function takeEditToken(params, slug) {
  if (!slug) return null;
  let token = params.get("t");
  if (token) {
    try {
      sessionStorage.setItem(EDIT_TOKEN_KEY, JSON.stringify({ slug, t: token }));
    } catch (e) {}
    params.delete("t");
    const qs = params.toString();
    history.replaceState(history.state, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
    return token;
  }
  const held = window.__EDIT_TOKEN__;
  if (held && held.slug === slug && held.t) return held.t;
  try {
    const saved = JSON.parse(sessionStorage.getItem(EDIT_TOKEN_KEY) || "null");
    if (saved && saved.slug === slug && saved.t) return saved.t;
  } catch (e) {}
  const rec = window.MyLists?.get(slug);
  return rec ? rec.token : null;
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

// 検索語付きのリンク（/?q=<検索語>。売上ランキングで巻一覧へのリンクが付かなかった作品・
// 管理画面から）。トップの検索欄に入れて検索結果を開く。パラメータは openSeriesFromUrl と同じく消す。
function openSearchFromUrl(params) {
  const q = (params.get("q") || "").trim();
  if (!q) return;
  // by=creator = 作者名検索（詳細ポップアップの作者リンク。public/author-link.js）。
  const by = params.get("by") === "creator" ? "creator" : "title";
  params.delete("q");
  params.delete("by");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  if (q.length < 2) return;
  $("topSearch").value = q;
  syncTopSearchClear();
  openAdd();
  doSearch(q, by);
}

/* ---------- site stats (収録シリーズ / 巻 / 公開リスト数) ---------- */
// 管理画面の stat-card と同じ見た目。取得に失敗したら枠ごと出さない（装飾なので黙って諦める）。
async function loadSiteStats() {
  const box = document.getElementById("siteStats");
  try {
    const res = await fetch("/api/site-stats");
    if (!res.ok) return;
    const stats = await res.json();
    // href があるカードは押すとそのページへ（公開リスト → みんなのリスト）。
    const cards = [
      ["series", "シリーズ"],
      ["volumes", "巻(ISBN)"],
      ["lists", "公開リスト", "/lists"],
    ];
    box.replaceChildren(
      ...cards.map(([key, label, href]) => {
        const card = document.createElement(href ? "a" : "div");
        card.className = href ? "stat-card stat-link" : "stat-card";
        if (href) card.href = href;
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

/* ---------- 自分のリスト（アカウント + このブラウザで公開したもの） ---------- */
// ログイン中はアカウントに紐付いた公開リスト（どの端末からでも編集できる）を出し、
// 紐付かなかったこの端末の記録（別アカウントのもの等）も並べる。未ログインなら従来どおり
// このブラウザの記録だけで、編集リンクを無くしても戻れるようにする。
// 公開済みリストの編集中は、作成中のリスト（新規の下書き）へ戻る導線も出す。
let myListsSeq = 0;
async function renderMyLists() {
  const box = $("myLists");
  if (!box || !window.MyLists) return;
  const seq = ++myListsSeq;
  const me = window.Account ? await window.Account.ready : { enabled: false, user: null };
  const accountLists = me.user ? await window.Account.lists() : [];
  if (seq !== myListsSeq) return; // 待っている間に描き直しが走った

  const owned = new Set(accountLists.map((l) => l.slug));
  renderClaimBar(me, owned);
  const notEditing = (r) => r.slug !== state.editSlug; // 編集中のものはこのページ自体が編集画面
  const accountRecs = accountLists
    .map((l) => ({ slug: l.slug, token: l.edit_token, owner: l.owner_name, account: true }))
    .filter(notEditing);
  // ログイン中にここへ残るのは紐付けられなかった記録（編集リンクが古い・別アカウントのもの等）。
  // アカウントのリストと混ぜると「保存されている」と誤解されるので、ログイン中は別枠で出す。
  const localRecs = window.MyLists.all().filter((r) => !owned.has(r.slug)).filter(notEditing);
  const draft = state.editSlug ? readLocalDraft() : null;
  const draftCount = draft && Array.isArray(draft.items) ? draft.items.length : 0;

  box.innerHTML = "";
  const any = accountRecs.length || localRecs.length || draftCount;
  if (!any && !(me.enabled && !me.user)) { box.style.display = "none"; return; }
  box.style.display = "";

  const heading = (tag, text) => {
    const h = document.createElement(tag);
    h.className = "mylists-title";
    h.textContent = text;
    box.appendChild(h);
  };
  const noteEl = (text) => {
    const note = document.createElement("p");
    note.className = "mylists-note";
    note.textContent = text;
    box.appendChild(note);
    return note;
  };
  const listEl = (recs, withDraft) => {
    const ul = document.createElement("ul");
    ul.className = "mylists-list";
    if (withDraft && draftCount) ul.appendChild(draftRow(draftCount));
    recs.forEach((r) => ul.appendChild(myListRow(r)));
    if (ul.children.length) box.appendChild(ul);
  };

  if (me.user) {
    heading("h2", "あなたのリスト");
    noteEl(
      accountRecs.length || draftCount
        ? "Googleアカウントに保存されています。どの端末からでも編集できます。"
        : "アカウントに保存された公開リストはまだありません。ログイン中に公開したリストはここに出ます。"
    );
    listEl(accountRecs, true);
    if (localRecs.length) {
      heading("h3", "この端末だけに記録されているリスト");
      noteEl(
        "アカウントに紐付いていないリストです。この端末のデータを初期化すると一覧から消えます。"
      );
      const claimBtn = document.createElement("button");
      claimBtn.type = "button";
      claimBtn.className = "ml-claim";
      claimBtn.textContent = "アカウントに紐付ける";
      claimBtn.addEventListener("click", () => window.Account.promptClaim());
      box.appendChild(claimBtn);
      listEl(localRecs, false);
    }
    return;
  }

  heading("h2", localRecs.length ? "このブラウザで公開したリスト" : "あなたのリスト");
  const note = noteEl(localRecs.length ? "編集リンクを無くしても、ここから編集画面に戻れます。" : "");
  if (me.enabled) {
    const login = document.createElement("a");
    login.href = window.Account.loginUrl();
    login.textContent = "Googleでログイン";
    note.append(note.textContent ? " " : "", login, "すると、作成中のリストと公開したリストをどの端末からでも編集できます。");
  }
  listEl(localRecs, true);
}

// 編集 URL を直接開いた時、そのリストがアカウントに無ければ「アカウントに追加」を出す。
// 未ログインならログインへ誘導し、戻ってきた（同じ編集 URL）ところでボタンを押してもらう。
function renderClaimBar(me, owned) {
  const bar = $("claimBar");
  if (!bar) return;
  bar.innerHTML = "";
  const show = me.enabled && state.editSlug && state.editToken && !owned.has(state.editSlug);
  bar.style.display = show ? "" : "none";
  if (!show) return;
  const text = document.createElement("span");
  text.textContent = "このリストはアカウントに入っていません。";
  bar.appendChild(text);
  if (!me.user) {
    const login = document.createElement("a");
    login.className = "ml-edit";
    login.href = window.Account.loginUrl();
    login.textContent = "Googleでログインして追加";
    bar.appendChild(login);
    return;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.textContent = "アカウントに追加";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const slug = state.editSlug;
    const results = await window.Account.claim([{ slug, token: state.editToken }]);
    const r = results[slug];
    if (r === "claimed" || r === "mine") {
      window.MyLists?.save({ slug, token: state.editToken, owner: state.owner });
      uiAlert("アカウントに追加しました。どの端末からでも編集できます。");
    } else {
      btn.disabled = false;
      uiAlert(
        r === "other" ? "このリストは別のアカウントに紐付いています。"
        : r === "mismatch" ? "編集リンクが古くなっているため追加できません。"
        : r === "not_found" ? "このリストは削除されています。"
        : "追加に失敗しました。時間をおいてもう一度お試しください。"
      );
    }
  });
  bar.appendChild(btn);
}

function draftRow(count) {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "ml-view";
  label.textContent = `作成中のリスト（${count}作品）`;
  const cont = document.createElement("a");
  cont.className = "ml-edit";
  cont.href = "/";
  cont.textContent = "続きを作る";
  li.append(label, cont);
  return li;
}

function myListRow(r) {
  const li = document.createElement("li");

  const view = document.createElement("a");
  view.className = "ml-view";
  view.href = `/l/${r.slug}`;
  view.textContent = r.owner ? `${r.owner}さんの100作品` : "無題の100作品";

  const edit = document.createElement("a");
  edit.className = "ml-edit";
  edit.href = `/?edit=${r.slug}&t=${encodeURIComponent(r.token)}`;
  edit.textContent = "編集する";

  li.appendChild(view);
  li.appendChild(edit);
  if (!r.account) {
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
    li.appendChild(del);
  }
  return li;
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
    state.unlisted = !!data.unlisted;
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
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ owner: state.owner, bio: state.bio, items: state.items, savedAt: Date.now() })
    );
  } catch (e) {}
  if (!state.editSlug) scheduleServerDraft();
}

/* ---------- 作成中のリストのサーバ同期（ログイン中のみ, src/account.ts） ---------- */
// 新規作成の下書き（DRAFT_KEY）をアカウントに 1 件だけ保存し、別の端末でも続きを作れる
// ようにする。localStorage が正で、変更のたびに少し待ってまとめて送る。端末間の新旧は
// 下書きの savedAt で決める（サーバも古い savedAt での上書きは無視する）。
// 公開済みリストの編集中の下書き（editDraftKey）は端末ローカルのまま。
const SERVER_DRAFT_DELAY_MS = 2000;
let serverDraftTimer = null;

function readLocalDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  } catch (e) {
    return null;
  }
}

async function loggedIn() {
  return !!(window.Account && (await window.Account.ready).user);
}

function scheduleServerDraft() {
  clearTimeout(serverDraftTimer);
  serverDraftTimer = setTimeout(pushServerDraft, SERVER_DRAFT_DELAY_MS);
}

async function pushServerDraft() {
  clearTimeout(serverDraftTimer);
  serverDraftTimer = null;
  if (!(await loggedIn())) return;
  const d = readLocalDraft();
  if (!d || !d.savedAt) return;
  try {
    await fetch("/api/me/draft", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: d.owner || "", bio: d.bio || "", items: d.items || [], savedAt: d.savedAt }),
    });
  } catch (e) {}
}

// 送信待ちがあれば今すぐ送る（ログアウト前など）。
async function flushServerDraft() {
  if (serverDraftTimer) await pushServerDraft();
}

// 開いた時に、サーバの下書きがこの端末のより新しければそちらを使い、古ければ（または
// サーバに無ければ）この端末の下書きを送る。取得中に編集が始まっていたら savedAt が
// 新しくなるので、この端末の方が勝つ。
async function syncServerDraft() {
  if (state.editSlug || !(await loggedIn())) return;
  let server = null;
  try {
    const res = await fetch("/api/me/draft");
    if (!res.ok) return;
    server = (await res.json()).draft;
  } catch (e) {
    return;
  }
  if (state.editSlug) return;
  const local = readLocalDraft();
  const localAt = (local && local.savedAt) || 0;
  if (server && server.savedAt > localAt) {
    state.owner = server.owner || "";
    state.bio = server.bio || "";
    state.items = (server.items || []).filter(Boolean).map(normItem);
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...server, items: state.items }));
    } catch (e) {}
    render();
    syncCovers();
    renderMyLists();
  } else if (local && localAt && (!server || localAt > server.savedAt)) {
    pushServerDraft();
  }
}

async function deleteServerDraft() {
  clearTimeout(serverDraftTimer);
  serverDraftTimer = null;
  if (!(await loggedIn())) return;
  try {
    await fetch("/api/me/draft", { method: "DELETE" });
  } catch (e) {}
}
// ISBN のある本の表紙はサイト共通（covers）なので、下書きに残った表紙は古いことがある
// （提案が管理者に承認されて差し替わった等）。開いた時にサーバの値で揃える。サーバに
// 無い ISBN は下書きの値を残す。編集モードで下書きが無い時は、公開データ自体がサーバ
// 側で表紙を引き直しているので下書きを新しく作らない。
async function syncCovers() {
  const isbns = [...new Set(state.items.map((it) => it.isbn).filter(Boolean))];
  if (!isbns.length) return;
  const covers = await lookupCovers(isbns, { cacheOnly: true });
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

// 別のタブがこの下書きを書き換えたら、こちらのメモリ上の state を合わせる。ランキングの
// 巻一覧からの追加（public/draft-add.js）は localStorage を直接書くので、合わせずにいると
// このタブで次に saveDraft したときに向こうの追加を巻き戻してしまう。並べ替え中（選択が
// index で決まる）と、公開済みリストの編集中（見ているのが別の下書き）は触らない。
function watchDraftFromOtherTabs() {
  window.addEventListener("storage", (e) => {
    if (e.key !== DRAFT_KEY || !e.newValue || state.editSlug || state.reorder) return;
    let d;
    try {
      d = JSON.parse(e.newValue);
    } catch (err) {
      return;
    }
    if (!d || !Array.isArray(d.items)) return;
    state.items = d.items.filter(Boolean).map(normItem);
    render();
  });
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
  grid.classList.toggle("placing", state.reorder && state.placing);
  // 固定の操作バーの下にカードが隠れないよう、並べ替え中だけ下に余白を足す。
  document.body.classList.toggle("reordering", state.reorder);
  state.items.forEach((it, i) => grid.appendChild(filledSlot(it, i)));
  // No adding while reordering — the add slot would confuse the "tap = select" mode.
  if (!state.reorder && state.items.length < MAX_ITEMS) grid.appendChild(addSlot(state.items.length));
  // 残りの空き枠（No.00x）。100 冊そろう本棚の形を最初から見せる。並べ替え中は出さない
  // （タップ＝選択のモードなので、押せない枠が混ざると紛らわしい）。
  if (!state.reorder) {
    for (let i = state.items.length + 1; i < TARGET; i++) grid.appendChild(placeholderSlot(i));
  }

  const filled = state.items.length;
  // はじめての人向けの説明は、リストが空のときだけ（公開済みリストの編集中は出さない）。
  const guide = $("emptyGuide");
  if (guide) guide.hidden = filled > 0 || !!state.editSlug;
  updatePublishButton(filled);
  renderHeroGauge(filled);
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
  // 取得ボタンの行は、どちらかのボタンが出るときと、取得中（進捗の文言を同じ行に出す）
  // だけ場所を取る。取得中は上の 2 つのボタンがどちらも隠れる。
  $("coverActions").style.display = showFetch || showFix || state.fetchingCovers ? "" : "none";

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
  if (publishing) return; // 送信中は setPublishing の「公開中…」表示を保つ
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

// ヒーロー右の進捗メーター（public/index.html .hero-gauge）。あと何作品かを大きく出し、
// 下の帯で埋まり具合を見せる。ちょうど TARGET になったら公開ボタンと同じ緑にする。
function renderHeroGauge(filled) {
  const dial = $("heroGauge");
  if (!dial) return; // トップ以外のページには無い
  const remaining = Math.max(0, TARGET - filled);
  $("heroRemaining").textContent = String(remaining);
  $("heroCount").textContent = `${filled} / ${TARGET}`;
  $("heroProgress").style.width = `${Math.min(100, (filled / TARGET) * 100)}%`;
  // ちょうど TARGET のときだけ。超過分があると公開できない（updatePublishButton と同じ条件）。
  dial.classList.toggle("ready", filled === TARGET);
}

function placeholderSlot(index) {
  const cell = document.createElement("div");
  cell.className = "slot placeholder";
  // 押せない飾りなので、読み上げからは外す（99 個ぶん読み上げられても意味がない）。
  cell.setAttribute("aria-hidden", "true");
  const no = document.createElement("span");
  no.className = "ph-num";
  no.textContent = `No.${String(index + 1).padStart(3, "0")}`;
  cell.appendChild(no);
  return cell;
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
  label.textContent = "作品を追加";
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
    // Insertion caret: only in the 移動先 phase, and never on a selected card (you
    // can't drop a card before itself). While picking cards there is no caret and no
    // move target at all, so a tap can only ever mean "select" — that's what keeps a
    // slightly-off tap from flinging the selection somewhere.
    if (state.placing && !isSel) {
      const caret = document.createElement("span");
      caret.className = "ins-caret";
      caret.setAttribute("aria-hidden", "true");
      slot.appendChild(caret);
    }
    appendCoverMeta(slot, it);
    if (state.placing) {
      slot.classList.add(isSel ? "moving" : "drop-target");
      if (isSel) {
        slot.disabled = true; // 移動する本そのものは移動先にならない
      } else {
        slot.setAttribute("aria-label", `${i + 1}番目「${it.title || ""}」の前に移動`);
        slot.addEventListener("click", () => moveSelectedBefore(i));
      }
      return slot;
    }
    slot.setAttribute("aria-pressed", String(isSel));
    slot.addEventListener("click", () => toggleSelect(i));
    return slot;
  }
  appendCoverMeta(slot, it);
  slot.addEventListener("click", () => openEdit(i));
  // × はカード（button）の中に入れ子にできないので、外側の .slot-cell に兄弟として置く。
  const cell = document.createElement("div");
  cell.className = "slot-cell";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "slot-remove";
  rm.title = "削除";
  rm.setAttribute("aria-label", `${i + 1}番目「${it.title || ""}」を削除`);
  const x = document.createElement("span");
  x.className = "slot-remove-x";
  x.setAttribute("aria-hidden", "true");
  x.textContent = "×";
  rm.appendChild(x);
  rm.addEventListener("click", () => removeAt(i));
  cell.append(slot, rm);
  return cell;
}

// Cover, spoiler/comment badges and title — shared by the normal and reorder
// renderings of a filled slot.
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
  slot.appendChild(coverNode(it.cover_url, it.title));
  const meta = document.createElement("div");
  meta.className = "meta";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = it.title;
  meta.appendChild(t);
  // コメントはカードには出さない（タップで出る詳細に入っている）。有無は上のバッジで示す。
  slot.appendChild(meta);
}

// 削除はすぐ反映し、数秒だけ「元に戻す」を出す（スマホの × の誤タップ対策）。戻すと同じ位置へ。
function removeAt(i) {
  const [removed] = state.items.splice(i, 1);
  render();
  saveDraft();
  if (removed) offerUndoRemove(removed, i);
}

function offerUndoRemove(item, index) {
  const name = item.title || "作品";
  uiToast(`『${name}』を削除しました`, {
    actionLabel: "元に戻す",
    duration: 6000,
    onAction: () => {
      if (state.items.length >= MAX_ITEMS) return;
      // 戻すまでの間に同じ本を追加し直していたら二重にしない。
      if (item.isbn && state.items.some((x) => x.isbn === item.isbn)) return;
      state.items.splice(Math.min(index, state.items.length), 0, item);
      state.selected.clear();
      render();
      saveDraft();
    },
  });
}

/* ---------- reorder mode ---------- */
// 2 段階にしてある。(1) 選択フェーズ: カードのタップは選択だけ。移動のボタンは画面に出さない。
// (2) 移動先フェーズ: 「移動先を選ぶ」を押して初めて挿入先が出て、カードのタップ＝そこへ移動。
// 選択の途中に移動のトリガが画面上に存在しないので、タップがずれても誤爆しない。
function toggleReorder() {
  state.reorder = !state.reorder;
  state.placing = false;
  state.selected.clear();
  render();
}

function startPlacing() {
  if (state.selected.size === 0) return;
  if (state.selected.size === state.items.length) {
    uiToast("すべて選んでいるので移動先がありません。選択を減らしてください。");
    return;
  }
  state.placing = true;
  render();
}

function cancelPlacing() {
  state.placing = false;
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
  finishMove(rest, `${picked.length}件を移動しました`);
}

function moveSelectedToEnd(atStart) {
  if (state.selected.size === 0) return;
  const idx = [...state.selected].sort((a, b) => a - b);
  const picked = idx.map((i) => state.items[i]);
  const rest = state.items.filter((_, i) => !state.selected.has(i));
  finishMove(
    atStart ? picked.concat(rest) : rest.concat(picked),
    `${picked.length}件を${atStart ? "先頭" : "末尾"}へ移動しました`,
  );
}

// 並びを差し替える唯一の口。label を渡すと数秒だけ「元に戻す」を出す（移動先の押し間違い対策）。
function finishMove(next, label) {
  const prev = state.items; // next は常に別の配列なので、prev はそのまま戻し先に使える
  state.items = next;
  state.placing = false;
  state.selected.clear();
  render();
  saveDraft();
  if (label) offerUndoMove(prev, label);
}

function offerUndoMove(prev, label) {
  uiToast(label, {
    actionLabel: "元に戻す",
    duration: 6000,
    onAction: () => {
      // 戻すまでの間に本が増減していたら、古い並びで上書きしない。
      if (state.items.length !== prev.length) return;
      state.items = prev;
      state.placing = false;
      state.selected.clear();
      render();
      saveDraft();
    },
  });
}

// 一括並べ替え。value は index.html の <select id="sortBy"> の option と揃える。
// field: 並べ替えに使う値（title はリスト項目が必ず持つ。date / author はサーバに聞く）。
const SORTS = {
  "title-asc": { label: "名前順", field: "title", dir: 1 },
  "title-desc": { label: "名前逆順", field: "title", dir: -1 },
  "date-asc": { label: "出版日順", field: "date", dir: 1 },
  "date-desc": { label: "出版日逆順", field: "date", dir: -1 },
  "author-asc": { label: "作者順", field: "author", dir: 1 },
  "author-desc": { label: "作者逆順", field: "author", dir: -1 },
};
const FIELD_NAME = { title: "作品名", date: "発行日", author: "作者" };

// ISBN → {date, author}（/api/sort-keys）。リストの項目は発行日を持たないので、押された
// ときだけ引いてセッション中は覚えておく（同じ本を並べ替え直すたびに往復しない）。
// 引けなかった値は覚えない（詳細ポップアップを開くなどで後から引けるようになることがある）。
const sortKeys = new Map();
let sorting = false;

const sortCollator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

// 並べ替えに使う値。分からなければ ""（どちら向きでも末尾に回る）。
function sortValue(it, field) {
  if (field === "title") return it.title || "";
  const extra = (it.isbn && sortKeys.get(it.isbn)) || null;
  if (field === "author") return it.author || (extra && extra.author) || "";
  return (extra && extra.date) || "";
}

// その並べ替えに要る値（field）が埋まらない本だけ /api/sort-keys に聞く。引けた値だけを
// 覚え、引けなかった本は「分からない」として覚えないので、次に押したときに引き直す
// （サーバ側も分からない巻をそのとき楽天に引きに行く）。通信そのものが失敗したら false。
async function loadSortKeys(items, field) {
  const need = [...new Set(items.filter((it) => it.isbn && !sortValue(it, field)).map((it) => it.isbn))];
  if (!need.length) return true;
  try {
    const res = await fetch("/api/sort-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns: need, field }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const keys = data.keys || {};
    // 発行日順で引いた作者（その逆も）も覚えるので、もう一方で並べ替え直すときに往復しない。
    for (const isbn of need) {
      const got = keys[isbn];
      if (!got) continue;
      const cur = sortKeys.get(isbn) || { date: "", author: "" };
      sortKeys.set(isbn, { date: got.date || cur.date, author: got.author || cur.author });
    }
    return true;
  } catch {
    return false;
  }
}

// 並べ替えを 1 回実行する。並び順を捨てるので先に確認し、「元に戻す」トーストを第 2 の網にする。
async function applySort(value) {
  const spec = SORTS[value];
  if (!spec || sorting || state.items.length < 2) return;
  if (!(await uiConfirm(`現在の並び順を破棄して、${spec.label}に並べ替えます。よろしいですか？`))) return;
  sorting = true;
  $("sortBy").disabled = true;
  try {
    // 値を持たない本が 1 冊でもあればサーバに聞く（作者はリスト項目が持っていることも多い）。
    if (spec.field !== "title" && state.items.some((it) => !sortValue(it, spec.field))) {
      // マスタに無い巻はサーバが楽天まで引きに行くので数秒かかることがある。待たせている
      // 間、押したのに何も起きていないように見せない（並べ替えのトーストで置き換わる）。
      const hide = uiToast(`${FIELD_NAME[spec.field]}を調べています…`, { duration: 30000 });
      const ok = await loadSortKeys(state.items, spec.field);
      hide();
      if (!ok) {
        uiAlert(`${FIELD_NAME[spec.field]}を取得できませんでした。時間をおいてもう一度お試しください。`);
        return;
      }
    }
    // 元の配列は「元に戻す」用に残すので、コピーを並べ替える。値が同じときは作品名で、
    // それも同じなら元の並びのまま（Array.prototype.sort は安定）。
    const sorted = state.items.slice().sort((a, b) => {
      const va = sortValue(a, spec.field);
      const vb = sortValue(b, spec.field);
      // 分からない本は昇順でも降順でも末尾へ（先頭に並ぶと「壊れている」ように見えるため）。
      if (!va !== !vb) return va ? -1 : 1;
      const cmp = spec.field === "date" ? (va < vb ? -1 : va > vb ? 1 : 0) : sortCollator.compare(va, vb);
      if (cmp) return spec.dir * cmp;
      return sortCollator.compare(a.title || "", b.title || "");
    });
    const unknown = sorted.filter((it) => !sortValue(it, spec.field)).length;
    const note = unknown ? `（${FIELD_NAME[spec.field]}が分からない${unknown}件は末尾）` : "";
    finishMove(sorted, `${spec.label}に並べ替えました${note}`);
  } finally {
    sorting = false;
    $("sortBy").disabled = false;
  }
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
  const placing = state.placing;
  $("reorderCount").textContent = placing
    ? `${n}件をどこへ？ 入れたい位置のカードをタップ`
    : n === 0
      ? "動かしたい作品をタップで選択"
      : `${n}件を選択中 ・「移動先を選ぶ」へ`;

  // 選択フェーズには移動を実行するボタンを置かない。移動系は移動先フェーズにだけ出す。
  const shown = placing
    ? ["moveStart", "moveEnd", "placeCancel"]
    : ["sortBy", "reorderClear", "movePick", "reorderDone"];
  for (const id of ["sortBy", "reorderClear", "movePick", "reorderDone", "moveStart", "moveEnd", "placeCancel"]) {
    $(id).style.display = shown.includes(id) ? "" : "none";
  }
  $("reorderClear").disabled = n === 0;
  $("movePick").disabled = n === 0;
}

function numBadge(index) {
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(index + 1);
  return num;
}

/* ---------- add / search modal ---------- */
// 本の追加はトップの検索欄から。検索結果をモーダルに出し、1 巻を選ぶと即リストへ追加する。
// コメント/ネタバレ/表紙は追加後に編集ポップアップで設定する（本の差し替えは「削除して再追加」の運用）。
// モーダルに検索欄は置かず、再検索はモーダルを閉じてトップの検索欄から行う。
function openAdd() {
  // トップの検索欄に候補が出たままモーダルを開くと、候補（position:fixed で z-index が
  // モーダルより上）がモーダルに被さって残る。引き直し待ちもまとめて取り消す。
  topSuggest.close();
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

// 付けていないサジェストの取っ手の代わり（null 判定をあちこちに書かないため）。
const NO_SUGGEST = { refresh() {}, close() {}, detach() {} };
// 今出ている再検索フォーム（buildRetryForm）のサジェスト。clearResults で片付ける。
let retrySuggest = NO_SUGGEST;

/** 検索欄の「×」（入力を消す）を配線する。語が入っている間だけ出す。
 *  @param {HTMLInputElement} input
 *  @param {HTMLButtonElement} btn 欄に重ねて置く × （.search-clear）
 *  @param {() => {close: () => void}} getSuggest 今その欄に付いているサジェストの取っ手
 *  @returns {() => void} コードから欄の値を入れ替えたときに × の出し入れを合わせる関数 */
function wireSearchClear(input, btn, getSuggest) {
  const sync = () => { btn.hidden = !input.value; };
  input.addEventListener("input", sync);
  input.addEventListener("compositionend", sync); // IME の確定は input が出ないことがある
  // mousedown は「フォーカスを外さない」ためだけに止める。消したあとも欄に居たいので
  // （スマホでソフトキーボードが閉じて開き直すのを防ぐ）、実際の処理は click でやる
  // （キーボードの Enter / Space でも押せるように）。
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    input.value = "";
    sync();
    getSuggest().close(); // 消す前の語の候補が残らないように
    input.focus();
  });
  sync();
  return sync;
}

/** トップの検索欄の × の出し入れを合わせる（コードから値を入れたとき）。wireEvents で入る。 */
let syncTopSearchClear = () => {};

// Empties the modal body, the series title under the heading (searchSubtitle), the
// header bar under it (searchBar: 巻一覧の「検索結果へ戻る」「全N巻を追加」) and the
// footer slot (searchActions) that holds the current view's 表紙を取得 button, so
// none of them outlives the view it belongs to.
function clearResults() {
  // 0 件のときの再検索フォーム（buildRetryForm）に付けたサジェストは、この欄と同じ寿命。
  // 箱と document / window の listener を明示的に片付ける（残しても自己修復はするが、
  // 検索をやり直すたびに増えるのを次のスクロールまで待たない）。
  retrySuggest.detach();
  retrySuggest = NO_SUGGEST;
  syncSearchMode(false); // 巻一覧など、結果一覧以外の画面には持ち越さない
  $("searchActions").innerHTML = "";
  const hbar = $("searchBar");
  hbar.innerHTML = "";
  hbar.hidden = true;
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

/* ---------- 詳細ポップアップの作者欄 ---------- */
// 作者名ごとに「その作者の作品を探す」リンクにする（public/author-link.js）。トップには
// 検索フォームがあるので遷移せず、その場で作者名検索（by=creator）に差し替える。
function setDetailAuthor(id, text) {
  const el = $(id);
  const shown = window.renderAuthorLinks
    ? window.renderAuthorLinks(el, text, { onPick: searchCreator })
    : ((el.textContent = text), !!text);
  el.style.display = shown ? "" : "none";
}

// 作者名で引き直す。結果は検索モーダルに出すので、上に開いている詳細（巻詳細・編集）は
// 場所を譲って閉じる（どちらも閉じるだけの操作なので、キャンセルと同じ扱い）。
function searchCreator(name) {
  closeVolumeDetail();
  closeEdit();
  $("topSearch").value = name;
  syncTopSearchClear();
  openAdd();
  doSearch(name, "creator");
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
  setDetailAuthor("eAuthor", it.author || "");
  setMetaRow("eIsbnRow", "eIsbn", it.isbn || "");
  setMetaRow("ePublisherRow", "ePublisher", "");
  setMetaRow("ePubdateRow", "ePubdate", "");
  setMetaRow("eVolRow", "eVol", "");
  setMetaRow("eLabelRow", "eLabel", "");
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
    // 表紙は枠に合わせて切り抜いているので、押したら切れていない全体を拡大で出す
    // （public/cover-zoom.js。出典と著作権表示つき）。meta は /api/book が返ったあとに
    // 埋まることがあるので、開くたびに読み直せるよう関数で渡す。
    if (window.attachCoverZoom) {
      window.attachCoverZoom(img, {
        coverUrl: book.cover_url,
        isbn: book.isbn,
        title: book.title,
        meta: () => ({ pubdate: book.pubdate, author: book.author, publisher: book.publisher }),
      });
    }
    box.appendChild(img);
  } else {
    const d = document.createElement("div");
    d.className = "dnoimg";
    d.textContent = "No Image";
    box.appendChild(d);
  }
}


// 「画像参考元」の行。出品元が分かればそのページへのリンクにする（public/affiliate.js
// coverSourceLink）。

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
  applyBookMeta(data, "e", { item: it });
}

// Fill the author / 出版社 / 発行日 / あらすじ rows from an /api/book response.
// `p` is the element-id prefix: "e" = edit modal, "v" = volume detail modal.
// opts.keepAuthor: 役割付きの全作者（巻一覧の creators）を出していれば上書きしない。
// opts.item: 表示中の本（あらすじの出典リンクを該当巻へ向けるのに isbn を使う）。
function applyBookMeta(data, p = "e", opts = {}) {
  if (!opts.keepAuthor && Array.isArray(data.authors) && data.authors.length) {
    setDetailAuthor(p + "Author", data.authors.join("、"));
  }
  // 巻一覧のマスタ値を先に出している（巻詳細）ので、空の応答では消さない。
  if (data.publisher || p !== "v") setMetaRow(p + "PublisherRow", p + "Publisher", data.publisher || "");
  if (data.pubdate || p !== "v") setMetaRow(p + "PubdateRow", p + "Pubdate", data.pubdate || "");
  if (data.label) setMetaRow(p + "LabelRow", p + "Label", data.label);
  if (data.volume_number) setMetaRow(p + "VolRow", p + "Vol", withSubtitle(data.volume_number, data.subtitle));
  if ($(p + "EditionsRow") && Array.isArray(data.editions) && data.editions.length) {
    setMetaRow(p + "EditionsRow", p + "Editions", data.editions.join("、"));
  }
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
    window.setSynopsisSource($(p + "SynopsisSrcBox"), opts.item || {}, data.caption_truncated); // public/affiliate.js
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
      applyBookMeta(data, "e", { item: it });
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
      headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
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

// R18版の検索は既定で成年向けだけ（src/site.ts adultOnlySearch）。「全年齢の作品も含める」を
// オンにすると all=1 を付けて絞り込みを外す。本家ではトグル自体を出さないので常に素の URL。
let searchAllAges = false;

// 検索の対象。"title" = 今までの検索（書名中心で、作者名は最後の段でしか当たらない）、
// "creator" = 作者名だけ（by=creator, src/search.ts searchByCreator）。結果の上の切り替え
// （#searchMode）で行き来する。トップの検索欄から引き直すときは "title" に戻す
// （欄の文言も入力補完も書名のものなので）。
let searchBy = "title";

/** トップの検索欄のサジェストの取っ手（全年齢トグルで候補を引き直す）。wireEvents で入る。 */
let topSuggest = NO_SUGGEST;

/** サジェスト（public/suggest.js）に渡す追加のクエリ。検索と同じく R18版の絞り込みを合わせる。 */
function suggestParams() {
  return searchAllAges ? "all=1" : "";
}

function searchUrl(q, offset) {
  let u = `/api/search?q=${encodeURIComponent(q)}`;
  if (offset != null) u += `&offset=${offset}`;
  if (searchAllAges) u += "&all=1";
  if (searchBy === "creator") u += "&by=creator";
  return u;
}

/** ISBN で引いた検索か（サーバ src/search.ts isbnQuery と同じ判定）。ISBN は 1 冊を名指しする
 *  操作で作者名に切り替える意味が無いので、そのときは切り替えを出さない。 */
function looksLikeIsbn(q) {
  const s = String(q || "").normalize("NFKC").replace(/[\s\-‐－ー]/g, "");
  return /^(97[89]\d{10}|\d{9}[\dXx])$/.test(s);
}

/** 「作品名 / 作者名」の切り替え。押した側の語で引き直す。 */
function initSearchMode() {
  for (const btn of document.querySelectorAll("#searchMode .search-mode-btn")) {
    btn.addEventListener("click", () => {
      const by = btn.dataset.by;
      if (by === searchBy || !lastQuery) return;
      topSuggest.close(); // 作者名に切り替えた先で書名の候補が残らないように
      doSearch(lastQuery, by);
    });
  }
}

/** 切り替えの見た目を今の対象に合わせ、検索したあと（結果が出ている間）だけ出す。 */
function syncSearchMode(show) {
  const bar = document.getElementById("searchMode");
  if (!bar) return;
  for (const btn of bar.querySelectorAll(".search-mode-btn")) {
    const on = btn.dataset.by === searchBy;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  bar.hidden = !show;
}

function initAllAges() {
  const bar = document.getElementById("allAgesBar");
  const box = document.getElementById("allAges");
  if (!bar || !box || !(window.__SITE__ && window.__SITE__.adultOnlySearch)) return;
  bar.hidden = false;
  box.addEventListener("change", () => {
    searchAllAges = box.checked;
    topSuggest.refresh(); // 出ている候補は古い絞り込みのものなので引き直す
    if (lastQuery) doSearch(lastQuery, searchBy); // 同じ語・同じ対象で引き直す
  });
}

async function doSearch(q, by) {
  lastQuery = q;
  searchBy = by === "creator" ? "creator" : "title";
  liveFetchedQuery = "";
  searchNextOffset = null;
  searchAdult = { blocked: "", hits: "" };
  $("searchSpinner").style.display = "";
  clearResults();
  try {
    const data = await apiFetch(searchUrl(q));
    searchNextOffset = data.next_offset ?? null;
    // 成年向けの作品（サーバの adult_volumes）: ISBN 検索で当たれば blocked、書名検索で当たれば
    // adult_hits。「見つからない」と区別して、追加できない理由を結果欄に出す（src/adult.ts）。
    searchAdult = {
      blocked: data.blocked && data.blocked.reason === "adult" ? data.blocked.message || ADULT_BLOCK_MESSAGE : "",
      hits: data.adult_hits ? data.adult_message || ADULT_BLOCK_MESSAGE : "",
    };
    renderResults(data.results || [], data.isbn_miss);
  } catch (e) {
    clearResults();
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = apiErrorMessage(e, "検索に失敗しました");
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
// 31件目以降があるときの次ページの offset（サーバの next_offset）。無ければ null。
let searchNextOffset = null;
// 直近の検索の成年向け判定（doSearch が設定）。blocked = ISBN が成年向けで追加不可の文言、
// hits = 書名が成年向けの巻にも当たったときの注記。「さらに表示」等の描き直しでも出し続ける。
const ADULT_BLOCK_MESSAGE = "成年向けの作品は、こちら側のサイトでは追加できません。";
// 文言のうち太字にする部分（成年向けは別サイトで扱う予定なので「こちら側の」を強調）。src/adult.ts と揃える。
const ADULT_EMPHASIS = "こちら側のサイトでは";

/** 成年向けの文言を el に入れる。ADULT_EMPHASIS の部分だけ <strong> にする（文言はテキストノードで入れる）。 */
function setAdultText(el, text) {
  const i = text.indexOf(ADULT_EMPHASIS);
  if (i < 0) {
    el.textContent = text;
    return;
  }
  const strong = document.createElement("strong");
  strong.textContent = ADULT_EMPHASIS;
  el.replaceChildren(text.slice(0, i), strong, text.slice(i + ADULT_EMPHASIS.length));
}
let searchAdult = { blocked: "", hits: "" };

// Search returns series-level results. Clicking one drills into its volumes.
function renderResults(results, isbnMiss = false) {
  lastResults = results;
  const box = clearResults();
  // 検索したあとに作品名 ⇔ 作者名を切り替えられるようにする（ISBN で引いたときは出さない）。
  syncSearchMode(!!lastQuery && !looksLikeIsbn(lastQuery));

  if (results.length === 0 && searchAdult.blocked) {
    // 収録漏れではなく成年向けで追加できない ISBN。最新DBからの取得でも出ないので導線は出さない。
    const p = document.createElement("p");
    p.className = "adult-block";
    p.setAttribute("role", "alert");
    setAdultText(p, searchAdult.blocked);
    box.appendChild(p);
    return;
  }
  if (results.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    // 最新DBからの取得は書名で探すので、ISBN で見つからないときは書名検索へ誘導する。
    p.textContent = isbnMiss
      ? "このISBNはまだ収録されていません。書名で検索して、下の「最新DBから取得」を試してください。"
      : searchBy === "creator"
        // 作者名は表記ゆれ（「あだち充」/「安達充」）や共著の役割違いで外れることがあるので、
        // 作品名側に戻す道も示す。
        ? "この作者名では見つかりませんでした。上の「作品名」に切り替えるか、別の表記を試してください。"
        : "見つかりませんでした。別の語か、下の「最新DBから取得」を試してください。";
    box.appendChild(p);
    box.appendChild(buildRetryForm());
  }
  const pending = [];
  const ambiguous = ambiguousEditionKeys(results);
  for (const r of results) box.appendChild(buildResultCard(r, pending, ambiguous));
  mountCoverFetch($("searchActions"), pending);
  if (searchNextOffset != null) box.appendChild(buildMoreButton());
  if (searchAdult.hits) {
    const p = document.createElement("p");
    p.className = "hint adult-note";
    setAdultText(p, searchAdult.hits);
    box.appendChild(p);
  }

  // ISBN で引いたときだけ出す「シリーズとして登録してほしい」依頼の導線。
  // マスタ(MADB)に 1 巻も無い作品は、楽天ブックス由来の 1 冊カードにしかならず
  // (live / source=rakuten / 全1巻)、シリーズとして開けず全巻まとめても追加できない。
  // 0 件(isbn_miss)のときも同じ依頼を受ける。see src/seriesRegister.ts
  const regIsbn = looksLikeIsbn(lastQuery)
    ? lastQuery.normalize("NFKC").replace(/[\s\-\u2010\uff0d\u30fc]/g, "")
    : "";
  if (regIsbn && !searchAdult.blocked) {
    const only = results.length === 1 ? results[0] : null;
    const liveOne = only && only.live && only.source === "rakuten";
    if (isbnMiss || liveOne) box.appendChild(buildRegisterBar(regIsbn, liveOne ? only.title : ""));
  }

  // 常設: マスタ(月次ダンプ)に無い作品を live MADB からキーワードで取得する導線。
  // マスタ検索が0件でも手詰まりにならないよう、結果の有無にかかわらず末尾に出す。
  box.appendChild(buildLiveBar());
}

// 依頼を送った ISBN。描き直し(さらに表示・表紙の後追い)でボタンが未送信に戻らないように。
const registerRequested = new Set();

// 「シリーズとして登録してほしい」依頼のバー。送るのは ISBN だけで、書名・著者は
// サーバが自分の控え(live_volumes / book_meta)から引く。利用者の自由入力は一切通さない。
function buildRegisterBar(isbn, title) {
  const bar = document.createElement("div");
  bar.className = "vol-bar live-bar";
  const p = document.createElement("span");
  p.className = "hint";
  p.textContent = title
    ? `「${title}」は1冊ぶんの情報しかありません。シリーズ(全巻)として登録を依頼できます。`
    : "この本はまだ収録されていません。シリーズとして登録を依頼できます。";
  bar.appendChild(p);

  const done = () => {
    bar.replaceChildren();
    const ok = document.createElement("span");
    ok.className = "hint";
    ok.textContent = "登録の依頼を受け付けました。確認して収録しますので、しばらくお待ちください。";
    bar.appendChild(ok);
  };
  if (registerRequested.has(isbn)) {
    done();
    return bar;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sup-btn";
  btn.textContent = "シリーズとして登録を依頼";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "送信中…";
    try {
      const data = await apiFetch("/api/series-register-requests", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
        body: JSON.stringify({ isbn }),
      });
      if (data.already) {
        uiAlert("この本はもう収録されています。検索し直すとシリーズとして開けます。");
        bar.remove();
        return;
      }
      // queued=false は受付上限に当たった場合。利用者にできることは無いので、
      // 受け付けた場合と同じ文言にして終わる(押し直させない)。
      registerRequested.add(isbn);
      done();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = orig;
      uiAlert(apiErrorMessage(e, "依頼の送信に失敗しました"));
    }
  });
  bar.appendChild(btn);
  return bar;
}

// 0 件のときだけ出す検索語の編集欄。普段はモーダルに検索欄を置かず再検索はトップの検索欄から
// だが、0 件は「語を少し変えて試す」場面なので、閉じずにその場で検索し直せるようにする
// （売上ランキングなどから /?q= で長い書名のまま開いたときにも効く）。
function buildRetryForm() {
  const row = document.createElement("form");
  row.className = "share-url";
  const input = document.createElement("input");
  input.type = "text"; // .modal input[type="text"] のスタイル（iOS のズーム防止の 16px も）に揃える
  input.enterKeyHint = "search";
  input.value = lastQuery;
  input.placeholder = searchBy === "creator" ? "作者名で検索" : "タイトル・著者で検索";
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.textContent = "検索";
  // トップの検索欄と同じ、語を消す ×。欄に重ねるので .search-box で包む。
  const box = document.createElement("div");
  box.className = "search-box";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "search-clear";
  clear.setAttribute("aria-label", "検索欄を空にする");
  clear.title = "消す";
  clear.hidden = true;
  const clearX = document.createElement("span");
  clearX.className = "search-clear-x";
  clearX.setAttribute("aria-hidden", "true");
  clearX.textContent = "×";
  clear.appendChild(clearX);
  box.append(input, clear);
  row.appendChild(box);
  row.appendChild(btn);
  const syncClear = wireSearchClear(input, clear, () => retrySuggest);
  // 入力補完。候補を選んだら、下の submit と同じ経路で検索し直す。サジェスト索引は作品名しか
  // 持たない（src/suggest.ts）ので、作者名で探しているときは付けない。
  if (searchBy !== "creator") {
    retrySuggest = attachSuggest(input, {
      onPick: (name) => {
        syncClear(); // 候補で欄が埋まるので × を出す
        $("topSearch").value = name;
        syncTopSearchClear();
        doSearch(name, searchBy);
      },
      params: suggestParams,
    });
  }
  row.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q.length < 2) { uiAlert("2文字以上で検索してください"); return; }
    input.blur();
    $("topSearch").value = q;
    syncTopSearchClear();
    doSearch(q, searchBy); // 対象（作品名 / 作者名）は変えずに引き直す
  });
  return row;
}

// 「さらに表示」: 次の30件を取ってきて、すでに出ているカード（同じ series_id）を除いて末尾に足す。
// 描き直しても結果欄のスクロール位置は保つ。
function buildMoreButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "more-results";
  btn.textContent = "さらに表示";
  const q = lastQuery;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "読み込み中…";
    try {
      const data = await apiFetch(searchUrl(q, searchNextOffset));
      if (q !== lastQuery) return; // 待っている間に別の語で検索し直した
      searchNextOffset = data.next_offset ?? null;
      const shown = new Set(lastResults.map((r) => r.series_id));
      const box = $("results");
      const top = box.scrollTop;
      renderResults(lastResults.concat((data.results || []).filter((r) => !shown.has(r.series_id))));
      box.scrollTop = top;
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "さらに表示";
      uiAlert(apiErrorMessage(e, "検索に失敗しました"));
    }
  });
  return btn;
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
    btn.textContent = "最新DBから取得";
    btn.addEventListener("click", () => liveFetch(lastQuery, btn));
  }
  bar.appendChild(label);
  bar.appendChild(btn);
  const guide = document.createElement("a");
  guide.className = "hint";
  guide.href = "/books-guide";
  guide.target = "_blank";
  guide.rel = "noopener";
  guide.textContent = "追加できる本について";
  bar.appendChild(guide);
  return bar;
}

// レーベルに付いた運営のタグ（server: label_tag = "廉価版" / "文庫版"）の印。マスタには
// コンビニ廉価版・文庫版の区別が無いので、管理画面でレーベルごとに付けている（src/labels.ts）。
// 版表示（version）と違い書名には混ぜず、独立したバッジで出す。
function labelTagBadge(tag) {
  if (!tag) return null;
  const el = document.createElement("span");
  el.className = "label-tag";
  el.textContent = tag;
  el.title = "レーベルから判定した版（管理者が設定）";
  return el;
}

// 版違いの見分け（MADB は「新装版」「大判」などを同じ schema:name の別シリーズとして持つ）。
// 横山光輝「三国志」は潮出版社だけで 8 シリーズあり、マスタの名前はどれも「三国志」。
// 書名に添える版表示（server: version = schema:version）があればそれを使い、版表示を持たない
// 行が同名で並ぶときだけ、レーベルと初版年をメタ行に足す。see src/search.ts SERIES_COLS
function editionTitle(r) {
  const title = (r && r.title) || "";
  // 書名が既に版を名乗っているときは足さない（「三国志 大判（大判）」を防ぐ）。サーバは
  // 管理者の修正名が出ているときに版表示を返さないが、巻側の最多タイトルが版名を含むことも
  // あるので、こちらでも見る。
  if (!r || !r.version || title.includes(r.version)) return title;
  return `${title}（${r.version}）`;
}

// 版表示を足してもなお同じ「書名＋作者」になるカードの鍵の集合。これに入るカードだけ
// メタ行にレーベルと初版年を出す（1 件しか出ていないときに年を出しても邪魔なだけなので）。
function ambiguousEditionKeys(results) {
  const seen = new Map();
  for (const r of results) {
    const k = normKey(editionTitle(r)) + "|" + normKey(r.creators || r.creator);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dup = new Set();
  for (const [k, n] of seen) if (n > 1) dup.add(k);
  return dup;
}

function buildResultCard(r, pending, ambiguous) {
  const row = document.createElement("div");
  row.className = "result";
  let cell = coverImg(r.cover_url, r.title);
  row.appendChild(cell);
  const info = document.createElement("div");
  info.className = "info";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = editionTitle(r);
  const tagBadge = labelTagBadge(r.label_tag);
  if (tagBadge) t.appendChild(tagBadge);
  if (r.live) {
    const badge = document.createElement("span");
    badge.className = "live-badge";
    badge.textContent = r.source === "rakuten" ? "楽天ブックス" : "最新DB";
    t.appendChild(badge);
  }
  const a = document.createElement("div");
  a.className = "a";
  // creators = 役割付きの全作者（"原作：A、作画：B"）。最新DB検索など無いものは代表作者で。
  // 版表示でも分かれない同名のカードが並んでいるときは、レーベルと初版年まで出して区別する。
  const bits = [r.creators || r.creator, r.publisher];
  if (ambiguous && ambiguous.has(normKey(editionTitle(r)) + "|" + normKey(r.creators || r.creator))) {
    bits.push(r.label, r.first_year ? `${r.first_year}年` : "");
  }
  a.textContent = bits.filter(Boolean).join(" / ");
  info.appendChild(t);
  info.appendChild(a);
  if (r.volume_count) {
    const countDiv = document.createElement("div");
    countDiv.className = "a";
    // "＋" = 最新巻が未取得（server: unconfirmed）。開いて「最新データを取得」で確定する。
    countDiv.textContent = r.unconfirmed ? `全${r.volume_count}巻＋` : `全${r.volume_count}巻`;
    if (r.unconfirmed) countDiv.title = "最新巻は未取得です。開いて「最新データを取得」で確認できます";
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
    const data = await apiFetch(
      `/api/live-search?q=${encodeURIComponent(q)}` + (searchBy === "creator" ? "&by=creator" : "")
    );
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
    uiAlert(apiErrorMessage(e, "取得に失敗しました"));
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

// 表紙取得の待ち状況。取得ループ（表紙を取得ボタン）は POST ごとにこのタブの ID と残り件数を
// 送り、サーバはサイト全体の「取得中の人数・待ち件数」を返す（src/ratelimiter.ts report）。
// ID はページを開くたびに作るランダム値で、保存しない。
const COVER_CLIENT_ID =
  (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2) + Date.now().toString(36);
let coverQueue = null; // { users, pending } — 最新の POST で返った値

// Lists come back with cache-only covers (instant). Uncached covers are resolved
// here in one background call so the list renders immediately and images fill in.
// `pending` (このタブの残り件数) を渡すと待ち状況の報告も兼ねる。
async function fetchCovers(isbns, pending) {
  const uniq = [...new Set((isbns || []).filter(Boolean))];
  if (!uniq.length) return {};
  const body = { isbns: uniq };
  if (typeof pending === "number") Object.assign(body, { client: COVER_CLIENT_ID, pending });
  try {
    const res = await fetch("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // 429（レート制限）は「今は無理」であって「表紙が無い」ではない。retry-after を控えて、
    // 呼び出し側のループがその分だけ待てるようにする（控えないと進捗ゼロのラウンドと
    // 見分けが付かず、そのまま打ち切ってしまう）。
    if (res.status === 429) {
      const sec = Number(res.headers.get("retry-after"));
      coverRetryAfterMs = Math.min(Math.max(Number.isFinite(sec) ? sec : 60, 1), 60) * 1000;
      return {};
    }
    if (!res.ok) return {};
    const data = await res.json();
    if (data.queue) coverQueue = data.queue;
    return data.covers || {};
  } catch {
    return {};
  }
}

// 取得ループの終わりに、待ち人数からすぐ抜ける（送らなくても 20 秒で自然に抜ける）。
function leaveCoverQueue() {
  coverQueue = null;
  fetch("/api/covers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isbns: [], client: COVER_CLIENT_ID, pending: 0 }),
  }).catch(() => {});
}

// 楽天の 1 秒 1 回の枠で 1 件あたり約 1.1 秒。取得中の人どうしで枠を分け合うので、自分の残りは
// 「残り件数 × 人数」ぶん（ただしサイト全体の待ち件数を超えない）かかる目安にする。
const COVER_SEC_PER_ITEM = 1.1;
function coverStatusText(left) {
  const q = coverQueue;
  const users = Math.max(1, q ? q.users : 1);
  const work = q ? Math.min(left * users, Math.max(q.pending, left)) : left;
  const sec = Math.max(1, Math.round(work * COVER_SEC_PER_ITEM));
  const eta = sec < 60 ? `約${sec}秒` : `約${Math.round(sec / 60)}分`;
  let text = `表紙を取得中… 残り${left}件・あと${eta}`;
  if (q) text += `（いま${users}人が取得中・全体で${Math.max(q.pending, left)}件待ち）`;
  return text;
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
// determined "no cover" and is final — we don't retry it. We only give up after
// several consecutive rounds make no progress (one such round usually just means
// someone else is filling covers and has the limiter's slots booked), so even a long
// series fills over as many rounds as it takes without looping forever.
const COVER_RETRY_PAUSE_MS = 1200;
const COVER_RETRY_CAP = 40; // hard backstop against a pathological no-progress loop

// 進捗ゼロのラウンドは「もう解決できない」とは限らない。楽天の枠はサイト全体で 1 秒 1 件なので、
// 他の人が取得中だと枠が全部埋まっていて、サーバは待たずに即「未確定」を返す（実測で 3 人同時
// なら 2 人は 20ms で 0 件）。1 ラウンドで諦めると、その瞬間に誰かが取得していただけで途中で
// 止まってしまうので、進捗ゼロが続いたときだけ、間隔を空けながら数回ねばる。
const COVER_STALL_ROUNDS = 5;
const COVER_STALL_MAX_PAUSE_MS = 8000;
// 429 を受けたときの retry-after（ミリ秒）。fetchCovers が立てて、次の待ち時間で使い切る。
let coverRetryAfterMs = 0;

/** 進捗ゼロが stalls 回続いたあとの待ち時間。429 を受けていればそちらを優先する。 */
function coverRoundPauseMs(stalls) {
  const limited = coverRetryAfterMs;
  coverRetryAfterMs = 0;
  if (!stalls) return Math.max(COVER_RETRY_PAUSE_MS, limited);
  const backoff = Math.min(COVER_RETRY_PAUSE_MS * Math.pow(2, stalls), COVER_STALL_MAX_PAUSE_MS);
  return Math.max(backoff, limited);
}

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
      if (left > 0) status.textContent = coverStatusText(left);
    };
    paint();
    let todo = entries.slice();
    let stalls = 0;
    for (let round = 0; round < COVER_RETRY_CAP && todo.length; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, coverRoundPauseMs(stalls)));
      const next = [];
      for (let i = 0; i < todo.length; i += COVER_CHUNK) {
        const chunk = todo.slice(i, i + COVER_CHUNK);
        const isbns = [];
        for (const e of chunk) isbns.push(...e.isbns);
        const map = await fetchCovers(isbns, total - done);
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
      // 進捗ゼロが続いたときだけ諦める（他の人の取得で枠が埋まっているだけのことがある）。
      stalls = next.length === todo.length ? stalls + 1 : 0;
      if (stalls >= COVER_STALL_ROUNDS) break;
      todo = next;
    }
    leaveCoverQueue();
    // 残したまま終わったら、押し直せるようにボタンを戻す（黙って消すと再開する手段が無い）。
    if (todo.length) {
      btn.textContent = `表紙を取得（残り${todo.length}件）`;
      btn.style.display = "";
      status.textContent = "混み合っています。少し待ってからもう一度お試しください。";
    } else {
      status.style.display = "none";
    }
  });
}

// シリーズに属さない巻のまとまり（書名+著者）の疑似 ID。シリーズと同じく巻一覧・結合依頼・
// 手動追加（抜け巻・新刊）・巻の通報・シリーズ名の通報（まとまりの名前は巻の書名そのもので、
// マスタが壊していることがある）の対象になるが、C-id 前提の分離依頼・補完は出さない
// （src/groups.ts）。
const isGroupId = (id) => /^G\d{13}$/.test(id || "");

async function openSeries(series) {
  // live 検索の結果、および series に未リンクの巻（マスタで schema:isPartOf 欠落）は
  // ローカルに C-id が無く、巻がカードに埋め込まれている。サーバを叩かずそのまま表示する
  // （追加は ISBN ベースなので C-id 不要。補完/訂正/通報も C-id 前提なので出さない）。
  // まとまり(G-id)のカードは手動追加の巻をサーバで混ぜるので、埋め込みを使わず取り直す。
  if (series.live || (series.unlinked && !isGroupId(series.series_id))) {
    renderVolumes(series, series.volumes || [], { probed: true, live: true });
    return;
  }
  const box = clearResults();
  const spin = document.createElement("p");
  spin.className = "hint";
  spin.textContent = "巻を読み込み中...";
  box.appendChild(spin);
  try {
    const data = await apiFetch(`/api/series/${encodeURIComponent(series.series_id)}/volumes`);
    // 管理者が結合済みのシリーズを開いた場合、サーバは残す側を返す。以降の通報・補完・
    // ID 表示が残す側に向くよう読み替える。
    if (data.series_id && data.series_id !== series.series_id) {
      series.series_id = data.series_id;
      series.title = data.title || series.title;
    }
    // 巻ページ・直リンクから開いたカードは版表示を持たないので、サーバの値で埋める。
    if (data.version !== undefined) series.version = data.version;
    // レーベルのタグ（廉価版・文庫版）も同じ理由でサーバの値を優先する。
    if (data.label_tag !== undefined) series.label_tag = data.label_tag;
    // 巻ページから開いた場合など、カードに作者表記が無くてもサーバの creators で補う。
    if (data.creators) series.creators = data.creators;
    if (data.group) {
      renderVolumes(series, data.volumes || [], { probed: true, masterAt: data.master_updated_at || 0 });
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
    p.textContent = apiErrorMessage(e, "取得に失敗しました");
    box.appendChild(p);
  }
}

// live MADB を probe して未リンクの新刊を補完する。補完後の巻一覧を含む /volumes 相当の
// レスポンス全体（volumes・supplement_checked_at・master_updated_at）を返す。
async function probeSupplement(seriesId) {
  const data = await apiFetch(`/api/series/${encodeURIComponent(seriesId)}/supplement`, {
    method: "POST",
  });
  return data;
}

// シリーズ詳細（巻一覧）画面の取得ボタン。probe 後に一覧を再描画する。
// Series whose 最新データ fetch already ran in this session. Their button renders as a
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
      // 抜け巻が別シリーズ・どのシリーズにも属さない巻として DB に在るもの（取得時のみ）。
      elsewhere: data.volumes_elsewhere || [],
      // 抜け巻のうち、MADB には在るが ISBN が無く足しようが無い巻の巻数（取得時のみ）。
      noIsbn: data.volumes_no_isbn || [],
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    uiAlert(apiErrorMessage(e, "取得に失敗しました"));
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
    const data = await apiFetch(`/api/live-search?q=${encodeURIComponent(series.title)}`);
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
    uiAlert(apiErrorMessage(e, "取得に失敗しました"));
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

  // 「検索結果へ戻る」「全N巻を追加」は巻一覧をスクロールしても押せるよう、結果欄の外の
  // ヘッダ（シリーズ名の下の searchBar）に置く。
  const bar = $("searchBar");
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
  bar.hidden = !bar.childElementCount;

  // この端末で「間違っています」と非表示にした巻を、本人が戻せる導線（誤タップ救済）。
  if (hidden.length) box.appendChild(buildHiddenRestore(series, volumes, hidden, opts));

  const head = $("searchSubtitle");
  const titleEl = document.createElement("span");
  titleEl.className = "st";
  titleEl.textContent = editionTitle(series);
  head.appendChild(titleEl);
  const headTag = labelTagBadge(series.label_tag);
  if (headTag) head.appendChild(headTag);
  head.hidden = false;
  // 通報・依頼の旗はタイトルの次の行にまとめる（長いタイトルと同じ行に並べると折り返しが崩れる）。
  const flags = document.createElement("div");
  flags.className = "st-flags";
  // マスタのシリーズ名が壊れている場合（例: 「ハレグゥ」が「ｖ」で取り込まれている）に、
  // 閲覧者が名前の誤りを通報できる導線。live シリーズは C-id が無く通報先が無いので出さない。
  // シリーズに属さない巻のまとまり（G-id）も、巻の書名がそのまま名前になる（「Dr.スランプ」が
  // 「Dr」で入っている等）ので同じ導線で直せる。通報はサーバに件数だけ記録し、全体反映
  // （名前の修正）は管理者が確定するまで行わない。
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
    flags.appendChild(nameFlag);
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
    flags.appendChild(mergeFlag);
  }
  if (series.series_id && !opts.live && !isGroupId(series.series_id) && volumes.length > 1) {
    // 逆に、1 つのシリーズに別の版（復刻版・新装版など）が混ざっている（例: キン肉マン C261524 に
    // 1〜36巻の復刻版が入り、12〜36巻が二重に並ぶ）ときの分離依頼。結合依頼と同じく collect-only。
    const splitFlag = document.createElement("button");
    splitFlag.type = "button";
    splitFlag.className = "report-flag name-report-flag";
    splitFlag.title = "復刻版・新装版など別の版の巻が混ざっている場合に分離を依頼（管理者が確認して別シリーズにします）";
    splitFlag.setAttribute("aria-label", "別の版が混ざっている");
    const sIcon = document.createElement("span");
    sIcon.className = "flag-icon";
    sIcon.textContent = "⑂";
    const sText = document.createElement("span");
    sText.className = "flag-text";
    const requested = isSplitRequested(series.series_id);
    sText.textContent = requested ? "別の版の混在を依頼済み" : "別の版が混ざっている？";
    if (requested) splitFlag.classList.add("reported");
    splitFlag.appendChild(sIcon);
    splitFlag.appendChild(sText);
    splitFlag.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isSplitRequested(series.series_id)) return;
      if (noHover() && !splitFlag.classList.contains("revealed")) {
        splitFlag.classList.add("revealed");
        return;
      }
      openSplitRequest(series, volumes, opts);
    });
    flags.appendChild(splitFlag);
  }
  // 「廉価版・文庫版？」: シリーズ個別のタグの申請。live 検索の結果は ID が無いので出さない。
  // 名前の通報・結合依頼と同じ collect-only で、反映は管理者が確定してから（src/labels.ts）。
  if (series.series_id && !opts.live) {
    flags.appendChild(buildTagRequestFlag(series, head));
  }
  if (flags.childElementCount) head.appendChild(flags);
  // 作者・出版社（検索カードと同じ並び）。シリーズに作者が無ければ先頭巻の著者で補う。
  const byline = [series.creators || series.creator || (visible[0] && visible[0].author), series.publisher]
    .filter(Boolean)
    .join(" / ");
  if (byline) {
    const sa = document.createElement("div");
    sa.className = "sa";
    sa.textContent = byline;
    head.appendChild(sa);
  }

  // マスタに欠けている巻（例: ONE PIECE 巻110）を検出して手動追加の導線を出す。
  // live シリーズは C-id が無く訂正保存(/corrections)できないので抜け巻ピッカーは出さない。
  const gaps = opts.live ? [] : detectGaps(visible);
  // 「最新データを取得」で分かった、MADB には巻として在るのに楽天・Yahoo のどちらでも
  // ISBN を見つけられなかった巻（src/gapFill.ts）。候補検索は空振りするので普通の抜け巻とは
  // 分けて出すが、ISBN が存在しないと断定はできない（C326076『釣りキチ三平』26 巻は講談社の
  // 公式サイトに 9784061735057 が載っている）ので、ボタン ＝ ISBN の直接指定の導線は残す。
  // 取得前は空なので、そのときは従来どおり全部ボタン側に出る。
  const noIsbn = new Set(opts.noIsbn || []);
  const addable = gaps.filter((g) => !noIsbn.has(g.n));
  const unaddable = gaps.filter((g) => noIsbn.has(g.n));
  if (addable.length) {
    const gapBox = document.createElement("div");
    gapBox.className = "gap-box";
    const label = document.createElement("span");
    label.className = "gap-label";
    label.textContent = "DBから抜けていそうな巻:";
    gapBox.appendChild(label);
    // 旧作は抜けが数十巻になることがあるので、先頭だけ出して残りは「…ほかN巻」に畳む。
    // 取得前（noIsbn が空）でも巻一覧がボタンで埋まらないように、こちらは常に効かせる。
    const rest = addable.slice(GAP_BTN_MAX);
    for (const g of addable.slice(0, GAP_BTN_MAX)) {
      gapBox.appendChild(buildGapBtn(series, g, volumes, opts));
    }
    if (rest.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "linkbtn gap-btn";
      more.textContent = `…ほか${rest.length}巻`;
      more.addEventListener("click", () => {
        for (const g of rest) gapBox.insertBefore(buildGapBtn(series, g, volumes, opts), more);
        more.remove();
      });
      gapBox.appendChild(more);
    }
    box.appendChild(gapBox);
  }
  if (unaddable.length) {
    const noBox = document.createElement("div");
    noBox.className = "gap-box";
    const note = document.createElement("span");
    note.className = "gap-label";
    // 断定できるのは「MADB に在る」「このサイトが見ているストアで ISBN を見つけられなかった」
    // の 2 点だけ。「ISBN が無い」とは言わない（出版社のサイトには載っていることがある）。
    note.textContent =
      `${formatVolRanges(unaddable.map((g) => g.n))}巻は最新DBに収録されていますが、` +
      `ISBN が見つかりませんでした（${unaddable.length}巻）。` +
      `ISBN が分かれば直接指定で追加できます。`;
    noBox.appendChild(note);
    // 候補は出ないが、ISBN の直接指定（openGapPicker の入力欄）には行けるようにしておく。
    const rest = unaddable.slice(GAP_BTN_MAX);
    for (const g of unaddable.slice(0, GAP_BTN_MAX)) {
      noBox.appendChild(buildGapBtn(series, g, volumes, opts));
    }
    if (rest.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "linkbtn gap-btn";
      more.textContent = `…ほか${rest.length}巻`;
      more.addEventListener("click", () => {
        for (const g of rest) noBox.insertBefore(buildGapBtn(series, g, volumes, opts), more);
        more.remove();
      });
      noBox.appendChild(more);
    }
    box.appendChild(noBox);
  }

  // 抜け巻が「別のシリーズに紛れている」「どのシリーズにも入っていない」形で DB に既に在る
  // とき、その巻を名指しして結合依頼の導線に送る（src/siblingVolumes.ts が判定）。
  // ここで巻を足すことはしない: 足すと同じ本が 2 つのシリーズに重複して並ぶ。直し方は結合か
  // 分離で、確定は管理者（src/merge.ts）。取得ボタンを押したときだけ出る。
  const elsewhere = (opts.elsewhere || []).filter((v) => v && v.vol_sort > 0);
  if (elsewhere.length) {
    const elseBox = document.createElement("div");
    elseBox.className = "gap-box";
    const elseLabel = document.createElement("span");
    elseLabel.className = "gap-label";
    const loose = elsewhere.filter((v) => !v.series_id).length;
    const inOther = elsewhere.length - loose;
    const where =
      inOther && loose
        ? `${inOther}冊が別のシリーズ、${loose}冊がどこにも入っていません`
        : inOther
          ? "別のシリーズに入っています"
          : "どのシリーズにも入っていません";
    elseLabel.textContent = `この作品の ${elsewhere.map((v) => v.vol_sort + "巻").join("・")} はDBにありますが、${where}:`;
    elseBox.appendChild(elseLabel);
    const mergeBtn = document.createElement("button");
    mergeBtn.type = "button";
    mergeBtn.className = "linkbtn gap-btn";
    mergeBtn.textContent = "シリーズの結合を依頼";
    mergeBtn.addEventListener("click", () => openMergeRequest(series, volumes, opts));
    elseBox.appendChild(mergeBtn);
    box.appendChild(elseBox);
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
  if (isGroupId(series.series_id)) {
    // まとまりは補完（live MADB）の対象外なので、取得ボタンは出さず新刊の入口だけ置く。
  } else if (supplementFetched.has(supKey(series))) {
    fetchNew.textContent = "取得しました";
    fetchNew.disabled = true;
  } else if (opts.live) {
    fetchNew.textContent = "最新DBから取得";
    fetchNew.addEventListener("click", () => refetchLiveSeries(series, fetchNew));
  } else {
    fetchNew.textContent = "最新データを取得";
    fetchNew.addEventListener("click", () => fetchSupplement(series, fetchNew));
  }
  if (!isGroupId(series.series_id)) supBar.appendChild(fetchNew);
  // MADB にまだ載っていない新刊（最新データを取得でも出てこない末尾の巻）を ISBN で足す入口。
  // 欠番ボタンは既存の巻の間しか出さないので、末尾への追加はここから行う。先に最新DBを
  // 見てもらうため「最新データを取得」を押した後（このセッション中）だけ出す（取得ボタンの無い
  // まとまり(G-id)は常に出す）。live は訂正の保存先が無いので出さない。
  if (
    !opts.live && series.series_id &&
    (isGroupId(series.series_id) || supplementFetched.has(supKey(series)))
  ) {
    const newVol = document.createElement("button");
    newVol.type = "button";
    newVol.className = "linkbtn new-vol-btn";
    newVol.textContent = "新刊が出ていますか？";
    newVol.addEventListener("click", () => openNewVolumePicker(series, volumes));
    supBar.appendChild(newVol);
  }
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
    // creators = 役割付きの全作者（"原作：A、作画：B"）。補完の巻など無いものは代表作者で。
    a.textContent = [v.creators || v.author, v.pubdate].filter(Boolean).join(" / ");
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

// 巻の副題（MADB の schema:alternateName）。同じシリーズに「上」「下」しか巻番号を持たない
// 別作品が並ぶとき（金田一少年の事件簿の事件ごとの上下巻）、書名＋巻番号だけでは全部同じ
// 表示になるので足す。書名側に畳み込み済みのときは重ねない。
function withSubtitle(base, subtitle) {
  if (!subtitle) return base;
  if (!base) return subtitle;
  return base.includes(subtitle) ? base : `${base} ${subtitle}`;
}

function volLabel(v) {
  return withSubtitle(v.volume_number ? `${v.title} ${v.volume_number}` : v.title, v.subtitle);
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
// 抜け巻の「＋N巻を追加」ボタンを一度に出す上限。超えた分は「…ほかN巻」で畳む。
// C326076「釣りキチ三平」は抜けが 32 巻あり、全部ボタンにすると巻一覧が埋まる。
const GAP_BTN_MAX = 5;

function buildGapBtn(series, g, volumes, opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "linkbtn gap-btn";
  btn.textContent = `＋${g.disp}を追加`;
  // opts を渡す: 候補ピッカーの「‹ 巻一覧へ戻る」で取得バーの状態・名指し・この抜け巻の
  // 内訳（opts.noIsbn）が戻った時点で消えないように。
  btn.addEventListener("click", () => openGapPicker(series, g, volumes, opts));
  return btn;
}

/** 巻数の並びを連番でまとめて「12〜15・17〜44」にする。抜けが数十巻あっても 1 行で言える。 */
function formatVolRanges(ns) {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}〜${sorted[j]}`);
    i = j + 1;
  }
  return parts.join("・");
}

// ── 部立ての巻ラベル（「第4部[9]」「第2部 4」「第1幕 3」）──────────────────────────
// src/util.ts の parseArcLabel / arcLabelTemplate / formatArcLabel の写し（サーバと同じ規則で
// 既定の巻番号を出し、同じ書式で送るため）。片方だけ直さないこと。並び順のキー vol_sort は
// サーバの volSort と同じ「部 ×1000 + 巻」。
const ARC_LABEL_RE = /^第[\s　]*(\d{1,3})[\s　]*([部幕])([\s　]*\[?)(\d{1,4})(\]?)$/;

function parseArcLabel(label) {
  const m = ARC_LABEL_RE.exec((label || "").trim());
  if (!m) return null;
  return {
    arc: parseInt(m[1], 10),
    n: parseInt(m[4], 10),
    unit: m[2],
    template: `第{a}${m[2]}${m[3]}{n}${m[5]}`,
  };
}

function arcLabelTemplate(labels) {
  const counts = new Map();
  for (const l of labels) {
    const a = parseArcLabel(l);
    if (a) counts.set(a.template, (counts.get(a.template) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [t, n] of counts) if (n > bestN) ((best = t), (bestN = n));
  return best;
}

function formatArcLabel(template, arc, n) {
  return template.replace("{a}", String(arc)).replace("{n}", String(n));
}

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
  // no trustworthy numbering to judge gaps — except a lone 2巻/3巻 (マスタに 3巻だけある
  // まとまりなど), whose earlier volumes are almost surely just missing.
  if (rangeInts.length < 2 && !(rangeInts.length === 1 && rangeInts[0] >= 2 && rangeInts[0] <= 3)) return [];
  const fmt = kan > 0 ? "KAN" : "NUM";
  const min = Math.min(...rangeInts);
  const max = Math.max(...rangeInts);
  const from = min >= 2 && min <= 3 ? 1 : min + 1;
  const gaps = [];
  for (let i = from; i < max; i++) {
    if (!present.has(i)) {
      gaps.push({ n: i, vol: fmt === "KAN" ? `巻${i}` : `${i}`, disp: `${i}巻`, sort: i });
    }
  }
  return gaps;
}

// Assisted search (Rakuten by title+volume) for one missing volume. Renders the
// candidates inline; picking one stages it exactly like selectVolume.
// opts.mkGap があれば新刊の追加（openNewVolumePicker）: 巻番号 n から gap を作る関数で、候補は
// その候補の巻番号で、ISBN の直接指定は編集できる巻番号で追加する。
async function openGapPicker(series, gap, volumes, opts) {
  const mkGap = opts && opts.mkGap;
  const inList = (isbn) => volumes.some((v) => v.isbn === isbn || (v.isbns || []).includes(isbn));
  // 抜け巻では、同じ ISBN が巻番号なしで一覧にある（C269160 の 1巻）なら、その巻に番号を付ける
  // 追加として受け付ける。弾くのは番号付きで一覧にある ISBN だけ。
  const blocked = (isbn) =>
    volumes.some((v) => (v.isbn === isbn || (v.isbns || []).includes(isbn)) && (mkGap || (v.volume_number || "").trim()));
  const box = clearResults();
  const bar = document.createElement("div");
  bar.className = "vol-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "linkbtn";
  back.textContent = "‹ 巻一覧へ戻る";
  // opts をそのまま戻す。捨てると取得バーの状態（「取得しました」・最終確認日）と、
  // 別シリーズ・迷子巻の名指し（opts.elsewhere）が巻一覧に戻った時点で消えてしまう。
  back.addEventListener("click", () => renderVolumes(series, volumes, opts));
  bar.appendChild(back);
  box.appendChild(bar);

  const head = document.createElement("p");
  head.className = "spinner";
  const what = mkGap ? `の新刊（${gap.disp}）` : ` ${gap.disp}`;
  head.textContent = `${series.title}${what} の候補を検索中...`;
  box.appendChild(head);

  // Rakuten's title search can't reach every volume (こち亀 1巻 is stocked but no
  // "<title> 1" phrase lands on it), so always offer a direct ISBN entry as the
  // fallback. The server re-resolves the cover and rejects ISBNs without one.
  const isbnHint = document.createElement("p");
  isbnHint.className = "hint";
  isbnHint.textContent = mkGap
    ? (opts && opts.arc
        ? "候補に無い場合は ISBN13 と、部・巻番号を直接指定できます。書影が見つかる ISBN のみ追加できます。"
        : "候補に無い場合は ISBN13 と巻番号を直接指定できます。書影が見つかる ISBN のみ追加できます。")
    : "候補に無い場合は ISBN を直接指定できます。";
  const isbnRow = document.createElement("div");
  isbnRow.className = mkGap ? "share-url new-vol-row" : "share-url";
  const isbnInput = document.createElement("input");
  isbnInput.type = "text";
  isbnInput.inputMode = "numeric";
  isbnInput.placeholder = "ISBN13（例: 9784088528113）";
  const isbnBtn = document.createElement("button");
  isbnBtn.type = "button";
  isbnBtn.textContent = "このISBNで追加";
  let volInput = null;
  let arcInput = null;
  if (mkGap) {
    // 部立てのシリーズでは部も編集できるようにする（「第4部の9巻」を指すのに巻番号だけでは
    // 足りない）。既定は最後の部。openNewVolumePicker が opts.arc を立てる。
    if (opts && opts.arc) {
      arcInput = document.createElement("input");
      arcInput.type = "text";
      arcInput.inputMode = "numeric";
      arcInput.className = "new-vol-num";
      arcInput.value = String(gap.arc);
      arcInput.setAttribute("aria-label", "部");
    }
    volInput = document.createElement("input");
    volInput.type = "text";
    volInput.inputMode = "numeric";
    volInput.className = "new-vol-num";
    volInput.value = String(gap.n);
    volInput.setAttribute("aria-label", "巻番号");
  }
  const submitIsbn = () => {
    const isbn = isbnInput.value.replace(/[^0-9]/g, "");
    if (isbn.length !== 13) {
      uiAlert("ISBN は13桁（978…）で入力してください");
      return;
    }
    let g = gap;
    if (volInput) {
      const n = parseInt(volInput.value.replace(/[^0-9]/g, ""), 10);
      if (!n) {
        uiAlert("巻番号を数字で入力してください");
        return;
      }
      let a;
      if (arcInput) {
        a = parseInt(arcInput.value.replace(/[^0-9]/g, ""), 10);
        if (!a) {
          uiAlert("部を数字で入力してください");
          return;
        }
      }
      if (inList(isbn)) {
        uiAlert("この ISBN はすでに巻一覧にあります");
        return;
      }
      g = mkGap(n, a);
    }
    pickManualVolume(series, g, { isbn, cover_url: "" }, volumes);
  };
  isbnBtn.addEventListener("click", submitIsbn);
  for (const el of [isbnInput, arcInput, volInput].filter(Boolean)) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) submitIsbn();
    });
  }
  isbnRow.appendChild(isbnInput);
  if (arcInput) {
    const arcUnit = document.createElement("span");
    arcUnit.className = "hint";
    // 「部」か「幕」か。既定のラベル（gap.vol）から拾う。
    arcUnit.textContent = (parseArcLabel(gap.vol) || { unit: "部" }).unit;
    const arcHead = document.createElement("span");
    arcHead.className = "hint";
    arcHead.textContent = "第";
    isbnRow.appendChild(arcHead);
    isbnRow.appendChild(arcInput);
    isbnRow.appendChild(arcUnit);
  }
  if (volInput) {
    const volUnit = document.createElement("span");
    volUnit.className = "hint";
    volUnit.textContent = "巻";
    isbnRow.appendChild(volInput);
    isbnRow.appendChild(volUnit);
  }
  isbnRow.appendChild(isbnBtn);
  const appendIsbnRow = () => {
    box.appendChild(isbnHint);
    box.appendChild(isbnRow);
  };

  let candidates = [];
  try {
    // series を渡すと、別シリーズの巻として既に登録されている ISBN が候補から外れる
    // （選んでもサーバが弾くので出さない。src/candidates.ts）。live 検索の結果には ID が無い。
    const sid = series.series_id ? `&series=${encodeURIComponent(series.series_id)}` : "";
    const data = await apiFetch(
      `/api/volume-candidates?title=${encodeURIComponent(series.title)}&volume=${gap.n}${sid}`
    );
    candidates = data.candidates || [];
    // 新刊の追加では、一覧にある巻（検索に既刊も混ざる）は候補から外す。
    if (mkGap) candidates = candidates.filter((c) => !inList(c.isbn));
  } catch (e) {
    head.className = "hint";
    head.textContent = apiErrorMessage(e, "検索に失敗しました");
    appendIsbnRow();
    return;
  }
  head.className = "hint";

  if (!candidates.length) {
    head.textContent = `${series.title}${what} の候補が見つかりませんでした。`;
    appendIsbnRow();
    return;
  }
  head.textContent = `${series.title}${what} の候補（該当するものを選んで追加）`;

  for (const c of candidates) {
    const row = document.createElement("div");
    row.className = "result";
    row.appendChild(coverImg(c.cover_url, c.title));
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = c.title;
    const author = (c.author || "").split("/").filter(Boolean).join("、");
    const a = document.createElement("div");
    a.className = "a";
    a.textContent = [author, c.publisher, c.pubdate].filter(Boolean).join(" / ");
    const a2 = document.createElement("div");
    a2.className = "a";
    a2.textContent = [c.volume ? `${c.volume}巻` : "", c.isbn ? `ISBN ${c.isbn}` : ""].filter(Boolean).join(" / ");
    info.appendChild(t);
    if (a.textContent) info.appendChild(a);
    info.appendChild(a2);
    row.appendChild(info);
    // 新刊は検索した巻の次の巻なども候補に出るので、候補自身の巻番号で追加する。
    const cn = mkGap ? parseInt(c.volume, 10) : 0;
    const g = cn > 0 ? mkGap(cn) : gap;
    // タップで即追加せず、詳細（表紙・著者・出版社・発行日・あらすじ）を見せて「この巻を追加」で保存する。
    row.addEventListener("click", () =>
      openVolumeDetail(
        { isbn: c.isbn, isbns: [c.isbn], title: c.title, volume_number: "", author, publisher: c.publisher || "",
          pubdate: c.pubdate || "", cover_url: c.cover_url || "" },
        {
          addLabel: `${g.disp}として追加`,
          addedLabel: blocked(c.isbn) ? "巻一覧にあります" : "",
          onAdd: () => pickManualVolume(series, g, c, volumes),
        }
      )
    );
    box.appendChild(row);
  }
  appendIsbnRow();
}

// 末尾の新刊を追加する画面。抜け巻と同じ候補検索の画面（openGapPicker）を、既存の最大巻 + 1 を
// 初期値にして開く。まだ一覧に無い巻を挟んでいることもあるので、候補はその巻番号で、ISBN の
// 直接指定は巻番号を編集して追加できる。
function openNewVolumePicker(series, volumes) {
  const labels = volumes.map((v) => (v.volume_number || "").trim()).filter(Boolean);
  // 数字が 1 つだけのラベルを素の巻番号として読む（"巻110" / "第170巻" / "VOLUME26"、および
  // "170　／　第170巻" のように同じ数を 2 度書く MADB の表記ゆれ）。部立てのラベルはここでは
  // 読まない（"第4部[9]" の最初の数字は部番号）。
  const plainOf = (l) => {
    if (parseArcLabel(l)) return null;
    const nums = l.match(/\d+/g);
    if (!nums) return null;
    const uniq = [...new Set(nums)];
    return uniq.length === 1 ? parseInt(uniq[0], 10) : null;
  };
  // 部立てのシリーズ（本好きの下剋上 等。マスタが部ごとに巻番号を振り直す）は、素の数字では
  // 巻を指せない。最後の部の最大巻 + 1 を既定にし、部と巻の 2 つを編集できる形で開く。
  // 部立てが多数派のときだけそうする（素の巻番号のシリーズに部立てのラベルが 1 つ紛れて
  // いるだけで画面が変わらないように）。
  const arcT = arcLabelTemplate(labels);
  const arcCount = labels.filter((l) => parseArcLabel(l)).length;
  const plainCount = labels.filter((l) => plainOf(l) !== null).length;
  if (arcT && arcCount >= plainCount) {
    let arc = 0;
    let max = 0;
    for (const l of labels) {
      const a = parseArcLabel(l);
      if (!a) continue;
      if (a.arc > arc) ((arc = a.arc), (max = 0));
      if (a.arc === arc) max = Math.max(max, a.n);
    }
    const unit = parseArcLabel(formatArcLabel(arcT, 1, 1)).unit;
    const mkGap = (n, a = arc) => ({
      n,
      arc: a,
      vol: formatArcLabel(arcT, a, n),
      disp: `第${a}${unit}${n}巻`,
      sort: a * 1000 + n,
    });
    openGapPicker(series, mkGap(max + 1), volumes, { mkGap, arc: true });
    return;
  }
  // 素の巻番号のシリーズ。以前は最初の数字列を無条件に採っていたので、"第1部[7]" のような
  // 部立てのラベルから部番号（1）の方を掴み、既定の巻番号が巻一覧と合わなかった。
  let kan = false;
  let max = 0;
  for (const l of labels) {
    if (/^巻\d+$/.test(l)) kan = true;
    const n = plainOf(l);
    if (n !== null) max = Math.max(max, n);
  }
  const mkGap = (n) => ({ n, vol: kan ? `巻${n}` : `${n}`, disp: `${n}巻`, sort: n });
  openGapPicker(series, mkGap(max + 1), volumes, { mkGap });
}

// Fill a missing volume: persist it as a correction (so it's cached for everyone),
// then splice it into the in-memory volume list and return to the volume view so it
// can be selected individually or included in "全巻を追加".
async function pickManualVolume(series, gap, c, volumes) {
  let vol = {
    isbn: c.isbn || "",
    isbns: c.isbn ? [c.isbn] : [],
    volume_number: gap.vol,
    vol_sort: gap.sort != null ? gap.sort : gap.n,
    title: series.title,
    author: series.creator || "",
    publisher: "",
    label: "",
    pubdate: "",
    cover_url: c.cover_url || "",
  };
  // サーバ側で書影・書誌を引き直すので数秒かかる。候補画面の先頭にスピナーを出し、
  // 二重送信しないよう画面内のボタン・入力を止める（失敗したら戻す）。
  const box = $("results");
  const busy = document.createElement("div");
  busy.className = "spinner";
  busy.textContent = `${gap.disp}を追加しています...`;
  const bar = box.querySelector(".vol-bar");
  if (bar) bar.after(busy);
  else box.prepend(busy);
  busy.scrollIntoView({ block: "nearest" });
  const locked = [...box.querySelectorAll("button, input")].filter((el) => !el.disabled);
  for (const el of locked) el.disabled = true;
  try {
    const data = await apiFetch(`/api/series/${encodeURIComponent(series.series_id)}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
      body: JSON.stringify({ isbn: c.isbn, volume_number: gap.vol }),
    });
    if (data.volume) vol = data.volume;
  } catch (e) {
    busy.remove();
    for (const el of locked) el.disabled = false;
    uiAlert(apiErrorMessage(e, "保存に失敗しました"));
    return;
  }

  // 抜け巻の申請は DB(correction)に補完して巻一覧へ差し込むだけ。100冊シェルフ
  // (state.items)には勝手に入れない。ユーザが巻一覧で選んで初めて追加される。
  // 同じ ISBN の巻が巻番号なしで一覧にあれば、新しく足さずにその巻へ番号を付ける（サーバの
  // getSeriesVolumes も同じ扱い）。
  const same = volumes.find((v) => vol.isbn && (v.isbn === vol.isbn || (v.isbns || []).includes(vol.isbn)));
  if (!same) {
    volumes.push(vol);
  } else if (!(same.volume_number || "").trim()) {
    same.volume_number = vol.volume_number;
    same.vol_sort = vol.vol_sort;
  }
  volumes.sort((a, b) => (a.vol_sort || 0) - (b.vol_sort || 0));
  renderVolumes(series, volumes);
}

// ユーザ投稿の巻を「間違っています」と通報する。サーバには通報件数だけが記録され、他の
// 閲覧者には管理者がパージするまで表示され続ける。確定反映は管理者の判断（パージ）に委ねる
// ので、この端末では localStorage に記録して自分の画面からだけ即座に消す。
async function reportWrongVolume(series, v, volumes, btn, opts) {
  if (!(await uiConfirm(`「${volLabel(v)}」を誤りとして通報します。あなたの画面では非表示になります（他の人には管理者が確認するまで表示されます）。誤って通報しても「非表示にした巻」からいつでも戻せます。よろしいですか？`))) return;
  btn.disabled = true;
  try {
    const data = await apiFetch(
      `/api/series/${encodeURIComponent(series.series_id)}/corrections/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
        body: JSON.stringify({ isbn: v.isbn }),
      }
    );
  } catch (e) {
    uiAlert(apiErrorMessage(e, "通報に失敗しました"));
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
    const data = await apiFetch(`/api/series/${encodeURIComponent(series.series_id)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
      body: JSON.stringify({ suggested_name: suggested.slice(0, 100) }),
    });
  } catch (e) {
    uiAlert(apiErrorMessage(e, "通報に失敗しました"));
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

  // 検索結果の絞り込み（出版社・コミックスのレーベル）。同じ作品でも版元・レーベル違いで
  // 何十件も並ぶことがあり（例: ゴルゴ13 は小学館版とリイド社版が混ざる）、検索語は書名と
  // 著者にしか当たらないので分けられない。結果に出ている値だけを選択肢にして絞り込む。
  const filterRow = document.createElement("div");
  filterRow.className = "merge-filters";
  filterRow.hidden = true;
  const filterLabel = document.createElement("span");
  filterLabel.className = "hint";
  filterLabel.textContent = "絞り込み";
  const pubSel = document.createElement("select");
  pubSel.setAttribute("aria-label", "出版社で絞り込む");
  const labSel = document.createElement("select");
  labSel.setAttribute("aria-label", "レーベル（コミックスのシリーズ名）で絞り込む");
  filterRow.appendChild(filterLabel);
  filterRow.appendChild(pubSel);
  filterRow.appendChild(labSel);
  box.appendChild(filterRow);

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

  // 絞り込み前の候補と、いま選んでいる絞り込み。検索し直すと絞り込みは解除する（選択した
  // 相手は下のチップに残るので、絞り込みで隠れても依頼からは落ちない）。
  const FILTER_NONE = "\u0000"; // 出版社・レーベルが空の行（「（なし）」）
  let allCands = [];
  let statusHead = "";
  let pubFilter = "";
  let labFilter = "";

  const fieldOf = (c, which) => (which === "pub" ? c.publisher : c.label) || "";
  const hit = (c, which, f) => !f || (f === FILTER_NONE ? !fieldOf(c, which) : fieldOf(c, which) === f);

  // 片方を選ぶともう片方の選択肢も連動して減らす（リイド社を選んだら小学館のレーベルは消す）。
  const fillSelect = (sel, which, allText) => {
    const other = which === "pub" ? "lab" : "pub";
    const cur = which === "pub" ? pubFilter : labFilter;
    const counts = new Map();
    for (const c of allCands) {
      if (!hit(c, other, other === "pub" ? pubFilter : labFilter)) continue;
      const v = fieldOf(c, which);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const opts = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
    sel.replaceChildren();
    const first = document.createElement("option");
    first.value = "";
    first.textContent = allText;
    sel.appendChild(first);
    for (const [v, n] of opts) {
      const o = document.createElement("option");
      o.value = v || FILTER_NONE;
      o.textContent = `${v || "（なし）"}（${n}）`;
      sel.appendChild(o);
    }
    sel.value = cur;
    if (sel.value !== cur) {
      // 選んでいた値が選択肢から消えた（ありえないが、消えたまま絞り続けないようにする）
      if (which === "pub") pubFilter = "";
      else labFilter = "";
      sel.value = "";
    }
    return opts.length;
  };

  const applyFilters = () => {
    const pubCount = fillSelect(pubSel, "pub", "すべての出版社");
    const labCount = fillSelect(labSel, "lab", "すべてのレーベル");
    // 版元もレーベルも 1 種類しかないなら絞り込む意味がないので出さない。
    filterRow.hidden = allCands.length < 2 || (pubCount < 2 && labCount < 2);
    const shown = allCands.filter((c) => hit(c, "pub", pubFilter) && hit(c, "lab", labFilter));
    const n = shown.length === allCands.length ? `${allCands.length}件` : `${allCands.length}件中 ${shown.length}件`;
    status.textContent = allCands.length ? `${statusHead} ${n}（行を押すと巻の表紙を確認できます）:` : statusHead;
    renderList(shown);
  };

  // 新しい結果を出す。head は件数の前に出す説明（結果が 0 件ならそれだけを出す）。
  const setItems = (items, head) => {
    allCands = items;
    statusHead = head;
    pubFilter = "";
    labFilter = "";
    applyFilters();
  };

  pubSel.addEventListener("change", () => {
    pubFilter = pubSel.value;
    applyFilters();
  });
  labSel.addEventListener("change", () => {
    labFilter = labSel.value;
    applyFilters();
  });

  const addId = () => {
    const other = idInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(other)) {
      uiAlert("シリーズIDを入力してください（例: C451211）");
      return;
    }
    // 絞り込みで隠れている候補でも名前が出せるよう、表示中の行ではなく候補全体から探す。
    const known = allCands.find((c) => c.series_id === other);
    if (select(other, known ? known.title : `ID ${other}`)) {
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
    // 依頼済みの行を無効化して描き直す（絞り込みはそのまま）。
    applyFilters();
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
      const data = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
      results = data.results || [];
    } catch (e) {
      if (my !== seq) return;
      setItems(extra || [], apiErrorMessage(e, "検索に失敗しました") + "（同じタイトル・同じ著者の候補のみ）");
      return;
    }
    if (my !== seq) return;
    const seen = new Set();
    const items = [...(extra || []), ...results.filter(usable)].filter((c) => {
      if (seen.has(c.series_id)) return false;
      seen.add(c.series_id);
      return true;
    });
    setItems(
      items,
      items.length
        ? `「${q}」の検索結果`
        : `「${q}」で別のシリーズは見つかりませんでした。検索語を変えるか、シリーズIDで追加してください。`
    );
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
    setItems(candidates, candidates.length ? "同じタイトル・同じ著者の別シリーズ" : "検索語を入力して検索してください。");
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

// 結合候補のプレビュー: 巻一覧 API から巻を取り、表紙と巻ラベル・発行日を横並びで見せる。表紙は
// キャッシュ分を即表示し、未取得は先頭の数件だけ解決して埋める（閲覧で楽天を叩きすぎない）。
// 巻を押すと巻一覧と同じ本の詳細（作者・出版社・レーベル・発行日・ISBN・他の版・あらすじ）を
// 重ねて開き、同じ作品かを 1 冊ずつ見比べられる（ここからはリストに追加しない）。
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
      data = await apiFetch(`/api/series/${encodeURIComponent(seriesId)}/volumes`);
    } catch (e) {
      msg.textContent = apiErrorMessage(e, "取得に失敗しました");
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
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "merge-preview-vol";
      cell.title = `${volLabel(v)}（押すと詳細）`;
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        openVolumeDetail(v, { viewOnly: true });
      });
      let cover = coverImg(v.cover_url, v.title);
      cell.appendChild(cover);
      const lab = document.createElement("div");
      lab.className = "merge-preview-label";
      lab.textContent = v.volume_number || "-";
      cell.appendChild(lab);
      if (v.pubdate) {
        const date = document.createElement("div");
        date.className = "merge-preview-label";
        date.textContent = v.pubdate;
        cell.appendChild(date);
      }
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
    const data = await apiFetch(`/api/series/${encodeURIComponent(series.series_id)}/merge-request`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
      body: JSON.stringify({ other_ids: otherIds }),
    });
  } catch (e) {
    uiAlert(apiErrorMessage(e, "依頼に失敗しました"));
    btn.textContent = orig;
    btn.disabled = false;
    return false;
  }
  for (const id of otherIds) markMergeRequested(series.series_id, id);
  uiAlert(`${otherIds.length} 件の結合を依頼しました。管理者が確認して反映します。`);
  return true;
}

// 「別の版が混ざっている？」: このシリーズの巻のうち別の版のものを選んで分離を依頼する画面。
// 巻一覧は同じ巻番号の ISBN を 1 巻にまとめているので、別の版が別の巻として並んでいる
// （巻番号の表記が違う）ときに選べる。依頼は ISBN ごとに件数だけ記録され、分離は管理者が確定する。
function openSplitRequest(series, volumes, opts) {
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
  head.textContent = "復刻版・新装版など、このシリーズに混ざっている別の版の巻にチェックを入れて依頼してください。管理者が確認して別のシリーズに分けます。";
  box.appendChild(head);

  const selected = new Set(); // 選んだ巻（volumes の添字）
  const list = document.createElement("div");
  box.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "merge-submit";
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "primary";
  footer.appendChild(sendBtn);
  box.appendChild(footer);
  const refresh = () => {
    sendBtn.textContent = selected.size ? `選択した ${selected.size} 巻を別の版として依頼` : "別の版の巻を選んでください";
    sendBtn.disabled = !selected.size || selected.size >= volumes.length;
  };

  volumes.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "result merge-cand";
    const check = document.createElement("label");
    check.className = "merge-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.setAttribute("aria-label", `${volLabel(v)} を選択`);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(i);
      else selected.delete(i);
      refresh();
    });
    check.appendChild(cb);
    check.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(check);
    if (v.cover_url) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = volLabel(v);
      img.onerror = () => img.remove();
      applyCover(img, v.cover_url);
      row.appendChild(img);
    }
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = volLabel(v);
    const a = document.createElement("div");
    a.className = "a";
    a.textContent = [v.label, v.pubdate, v.correction ? "ユーザ投稿" : ""].filter(Boolean).join(" / ");
    info.appendChild(t);
    info.appendChild(a);
    row.appendChild(info);
    // 行のどこを押しても選択を切り替える（チェックボックスが小さいので）。
    row.addEventListener("click", () => {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });
    list.appendChild(row);
  });

  sendBtn.addEventListener("click", async () => {
    const isbns = [...selected].flatMap((i) => volumes[i].isbns || [volumes[i].isbn]);
    sendBtn.disabled = true;
    sendBtn.textContent = "送信中…";
    try {
      const data = await apiFetch(`/api/series/${encodeURIComponent(series.series_id)}/split-request`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
        body: JSON.stringify({ isbns }),
      });
    } catch (e) {
      uiAlert(apiErrorMessage(e, "依頼に失敗しました"));
      refresh();
      return;
    }
    markSplitRequested(series.series_id);
    uiAlert("別の版の分離を依頼しました。管理者が確認して反映します。");
    renderVolumes(series, volumes, opts);
  });

  refresh();
  return box;
}

// 「廉価版・文庫版？」の旗と、その場で開くタグの選択。マスタにはコンビニ廉価版・文庫版・
// 傑作選の区別が無く、レーベル単位のタグ（管理画面）では拾えないシリーズがあるので、閲覧者から
// 申請してもらう。名前の通報・結合依頼と同じ collect-only で、サーバは件数を積むだけ。
// 反映は管理者が確定してから（src/labels.ts adminConfirmSeriesTagRequest）。
const TAG_CHOICES = ["廉価版", "文庫版", "傑作選"];

function buildTagRequestFlag(series, head) {
  const flag = document.createElement("button");
  flag.type = "button";
  flag.className = "report-flag name-report-flag";
  flag.title = "この作品が廉価版・文庫版・傑作選のときに申請（管理者が確認して反映します）";
  flag.setAttribute("aria-label", "この作品の版を申請する");
  const icon = document.createElement("span");
  icon.className = "flag-icon";
  icon.textContent = "◈";
  const text = document.createElement("span");
  text.className = "flag-text";
  const done = isTagRequested(series.series_id);
  text.textContent = done ? "版を申請済み" : "廉価版・文庫版？";
  if (done) flag.classList.add("reported");
  flag.appendChild(icon);
  flag.appendChild(text);

  flag.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isTagRequested(series.series_id)) return;
    // タップ端末では 1 回目で説明を出し、2 回目で開く（他の旗と同じ）。
    if (noHover() && !flag.classList.contains("revealed")) {
      flag.classList.add("revealed");
      return;
    }
    openTagPicker(series, head, flag, text);
  });
  return flag;
}

// 旗の下にその場で開く選択肢。別画面にしないのは、選ぶ情報が 1 つしかないため。
function openTagPicker(series, head, flag, text) {
  if (head.querySelector(".tag-pick")) return;
  const box = document.createElement("div");
  box.className = "tag-pick";
  const label = document.createElement("span");
  label.className = "hint";
  label.textContent = "この作品はどれですか？";
  box.appendChild(label);

  const send = async (tag, btn) => {
    for (const b of box.querySelectorAll("button")) b.disabled = true;
    btn.textContent = "送信中…";
    try {
      await apiFetch(`/api/series/${encodeURIComponent(series.series_id)}/tag-request`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
        body: JSON.stringify({ tag }),
      });
    } catch (err) {
      uiAlert(apiErrorMessage(err, "申請に失敗しました"));
      box.remove();
      return;
    }
    markTagRequested(series.series_id);
    box.remove();
    flag.classList.add("reported");
    text.textContent = "版を申請済み";
    uiAlert("申請しました。管理者が確認して反映します。");
  };

  for (const tag of TAG_CHOICES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "linkbtn";
    btn.textContent = tag;
    btn.addEventListener("click", () => send(tag, btn));
    box.appendChild(btn);
  }
  // 既に付いている印が間違っているときの申請。tag="" は「外してほしい」の意。
  if (series.label_tag) {
    const off = document.createElement("button");
    off.type = "button";
    off.className = "linkbtn";
    off.textContent = `「${series.label_tag}」ではない`;
    off.addEventListener("click", () => send("", off));
    box.appendChild(off);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "linkbtn";
  cancel.textContent = "やめる";
  cancel.addEventListener("click", () => box.remove());
  box.appendChild(cancel);
  head.appendChild(box);
}

// 版を申請したシリーズの端末ローカル台帳（localStorage）。二重申請を防ぎ、申請済み表示に使う。
const TAG_REQUESTS_KEY = "my100manga_tag_requests_v1";
function tagRequestedSet() {
  try {
    const raw = localStorage.getItem(TAG_REQUESTS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}
function isTagRequested(seriesId) {
  return !!seriesId && tagRequestedSet().has(seriesId);
}
function markTagRequested(seriesId) {
  const s = tagRequestedSet();
  s.add(seriesId);
  try {
    localStorage.setItem(TAG_REQUESTS_KEY, JSON.stringify([...s]));
  } catch {}
}

// 分離を依頼したシリーズの端末ローカル台帳（localStorage）。二重依頼を防ぎ、依頼済み表示に使う。
const SPLIT_REQUESTS_KEY = "my100manga_split_requests_v1";
function splitRequestedSet() {
  try {
    const raw = localStorage.getItem(SPLIT_REQUESTS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}
function isSplitRequested(seriesId) {
  return !!seriesId && splitRequestedSet().has(seriesId);
}
function markSplitRequested(seriesId) {
  const s = splitRequestedSet();
  s.add(seriesId);
  try {
    localStorage.setItem(SPLIT_REQUESTS_KEY, JSON.stringify([...s]));
  } catch {}
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
let volOnAdd = null;

// opts.onAdd があれば「リストに追加」の代わりに使う（抜け巻・新刊の候補を巻一覧へ足す）。
// ボタンの文言は opts.addLabel、追加できないときは opts.addedLabel で無効にする。
// opts.viewOnly は追加ボタンを出さない（結合依頼画面のプレビューから見るだけのとき）。
function openVolumeDetail(v, opts) {
  volCurrent = v;
  volOnAdd = (opts && opts.onAdd) || null;
  const seq = ++volSeq;
  $("vTitle").textContent = volLabel(v);
  // creators = 役割付きの全作者（"原作：A、作画：B"）。巻一覧の行と同じ表記にする。
  setDetailAuthor("vAuthor", v.creators || v.author || "");
  setMetaRow("vVolRow", "vVol", withSubtitle(v.volume_number || "", v.subtitle));
  setMetaRow("vPublisherRow", "vPublisher", v.publisher || "");
  setMetaRow("vLabelRow", "vLabel", v.label || "");
  setMetaRow("vPubdateRow", "vPubdate", v.pubdate || "");
  setMetaRow("vIsbnRow", "vIsbn", v.isbn || "");
  // 同じ巻の別 ISBN（通常版/特装版/重版）。巻一覧は版違いを 1 行にまとめているのでここで見せる。
  setMetaRow("vEditionsRow", "vEditions", (v.isbns || []).filter((x) => x !== v.isbn).join("、"));
  $("vSynopsis").textContent = "";
  $("vSynopsisBox").style.display = "none";
  renderCoverInto($("vCoverBox"), v);
  renderEditBuy({ isbn: v.isbn || "", title: volLabel(v), author: v.author || "" }, "v");

  const add = $("vAdd");
  add.style.display = opts && opts.viewOnly ? "none" : "";
  if (volOnAdd) {
    add.disabled = !!opts.addedLabel;
    add.textContent = opts.addedLabel || opts.addLabel || "追加";
  } else {
    const dup = !!(v.isbn && isDuplicate(toIsbn13(v.isbn)));
    add.disabled = dup;
    add.textContent = dup ? "追加済み" : "リストに追加";
  }
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
        if (data && seq === volSeq) applyBookMeta(data, "v", { keepAuthor: !!v.creators, item: v });
      })
      .catch(() => {});
  }
}

function closeVolumeDetail() {
  $("volModal").classList.remove("open");
  volCurrent = null;
  volOnAdd = null;
  volSeq++;
}

async function addFromVolumeDetail() {
  const v = volCurrent;
  const onAdd = volOnAdd;
  if (!v) return;
  closeVolumeDetail();
  if (onAdd) await onAdd(v);
  else await selectVolume(v);
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
    if (left > 0) statusEl.textContent = coverStatusText(left);
  };
  paint();
  // 自動リトライ: 1 回の POST は resolveCovers の予算内に収まる数しか解決できず、残りは
  // レスポンスから *欠落* で返る（未確定・未キャッシュ）。その欠落分だけを再 POST し、
  // レート制限が回復するよう間を置いて全部埋まるまで繰り返す。map に present-but-empty（""）で
  // 返ったものは「確定：表紙なし」なので retry せず coverTried に入れて打ち切る。欠落は
  // coverTried に入れず残すので、進捗ゼロのラウンドが続いたら打ち切る（後で再クリック可能）。
  let todo = targets.slice();
  let stalls = 0;
  for (let round = 0; round < COVER_RETRY_CAP && todo.length; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, coverRoundPauseMs(stalls)));
    const next = [];
    for (let i = 0; i < todo.length; i += COVER_CHUNK) {
      const batch = todo.slice(i, i + COVER_CHUNK);
      const map = await fetchCovers(batch.map((it) => it.isbn), total - done);
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
    // 進捗ゼロが続いたときだけ諦める。coverTried に入れていないので、ボタンを押し直せば続きから。
    stalls = next.length === todo.length ? stalls + 1 : 0;
    if (stalls >= COVER_STALL_ROUNDS) break;
    todo = next;
  }
  leaveCoverQueue();
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
  const index = state.editIndex;
  const removed = index >= 0 ? state.items.splice(index, 1)[0] : null;
  closeEdit();
  render();
  saveDraft();
  if (removed) offerUndoRemove(removed, index);
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
  $("publicInput").checked = !state.unlisted;
  updatePublicHint();
  // お好みURLは新規公開時のみ。既存リストの更新では slug は変えられない。
  const slugField = $("slugField");
  if (slugField) {
    slugField.style.display = state.editSlug ? "none" : "";
    if (!state.editSlug) {
      $("slugInput").value = "";
      $("slugPrefix").textContent = `${location.host}/l/`;
    }
  }
  $("confirmPublish").textContent = state.editSlug ? "更新する" : "公開する";
  $("publishModal").classList.add("open");
  $("ownerInput").focus();
}

// できるだけ「みんなに公開」を選んでもらいたいので、オンの利点を前に出し、
// オフ（限定公開）は何ができなくなるかを淡々と書く。
function updatePublicHint() {
  const on = $("publicInput").checked;
  $("publicLabel").textContent = on ? "みんなに公開する" : "限定公開（URLを知っている人だけ）";
  $("publicHint").textContent = on
    ? "検索からも見つけてもらえるようになり、運営がサイトやSNSでおすすめのリストとして紹介することがあります。あなたの100冊を、まだ知らない誰かに届けましょう。"
    : "検索エンジンに表示されず、運営からの紹介もしません。URLを送った相手には見てもらえます。";
}

function confirmPublish() {
  if (publishing) return;
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
  state.unlisted = !$("publicInput").checked;
  doPublish();
}

// 公開・更新の送信中。ボット確認（Turnstile）と送信に数秒かかることがあるので、公開モーダルを
// 開いたままボタンを「公開中…」にして二重送信を防ぐ。失敗したらモーダルに戻る（URL の重複など
// 入力を直せばよいエラーもあるため）。成功したらモーダルを閉じて共有モーダルを出す。
let publishing = false;

function setPublishing(on, label) {
  publishing = on;
  const verb = state.editSlug ? "更新" : "公開";
  const btn = $("confirmPublish");
  btn.disabled = on;
  btn.textContent = on ? label || `${verb}中…` : verb === "更新" ? "更新する" : "公開する";
  $("cancelPublish").disabled = on;
  $("publish").disabled = on || state.items.length !== TARGET;
  if (on) $("publish").textContent = label || `${verb}中…`;
}

function closePublishModal() {
  if (publishing) return; // 送信中は閉じない（結果を必ず見せる）
  $("publishModal").classList.remove("open");
}

async function doPublish() {
  if (publishing) return;
  const items = collectItems();
  if (items.length !== TARGET) {
    uiAlert(`公開にはちょうど${TARGET}作品が必要です（現在${items.length}作品）。`);
    return;
  }
  const verb = state.editSlug ? "更新" : "公開";
  let ok = false;
  setPublishing(true);
  try {
    if (state.editSlug) {
      await apiFetch(`/api/lists/${state.editSlug}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_name: state.owner, bio: state.bio, unlisted: state.unlisted, items, edit_token: state.editToken }),
      });
      clearEditDraft(state.editSlug);
      // What we just PUT is now the 公開状態 — rebase the diff on it.
      state.published = { owner: state.owner, bio: state.bio, items: items.map(normItem) };
      window.MyLists?.save({ slug: state.editSlug, token: state.editToken, owner: state.owner });
      window.Account?.refreshLists();
      // 中身が変わったので、取得済みの共有画像は捨てる（同じ slug のままなので、
      // 捨てないと更新前の画像を出し続ける）。
      window.resetShareImages?.();
      ok = true;
      setPublishing(false);
      // モーダルは閉じずにそのまま遷移する。閉じると ui-dialog が「開いているモーダルが
      // 0 になった」のを見て、積んでおいた履歴を戻しに行き（history.go）、直後の
      // location.href の遷移を打ち消してしまう（更新はできているのにページが変わらない）。
      goToPublished(state.editSlug, state.editToken);
    } else {
      const payload = { owner_name: state.owner, bio: state.bio, unlisted: state.unlisted, items };
      if (state.customSlug) payload.slug = state.customSlug;
      // ボット確認は普段は一瞬だが、チェックが出ると操作待ちになる。今どこで待っているかを出す。
      const slow = setTimeout(() => publishing && setPublishing(true, "確認中…"), 1500);
      let headers;
      try {
        headers = await botHeaders("publish");
      } finally {
        clearTimeout(slow);
      }
      setPublishing(true, "公開中…");
      const data = await apiFetch(`/api/lists`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });
      state.editSlug = data.slug;
      state.editToken = data.edit_token;
      state.customSlug = "";
      window.MyLists?.save({ slug: data.slug, token: data.edit_token, owner: state.owner });
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
      deleteServerDraft();
      window.Account?.refreshLists();
      ok = true;
      setPublishing(false);
      // 先に共有モーダルを開いてから公開モーダルを閉じる。「どれも開いていない」瞬間を
      // 作ると、ui-dialog が履歴を戻し、その popstate で開いたばかりの共有モーダルへ
      // Esc が飛んで閉じてしまう。
      await showShare(data.slug, data.edit_token);
      $("publishModal").classList.remove("open");
    }
  } catch (e) {
    uiAlert(apiErrorMessage(e, `${verb}に失敗しました。もう一度お試しください。`));
  } finally {
    if (!ok) setPublishing(false);
    render();
    renderMyLists();
  }
}

// 更新した後は編集画面に留めず、公開ページ（/l/<slug>）へ送る。編集画面と公開ページは
// 見た目が近く、更新できたのかどうかが分かりづらかったため。「更新しました」の通知は
// 遷移先で出す（sessionStorage に印を置いて public/view.js が拾う）。編集トークンも
// 一緒に渡して、公開ページに「編集する」が出る状態にしておく。
const UPDATED_KEY = "my100manga_updated"; // sessionStorage。public/view.js と共通

function goToPublished(slug, token) {
  const url = `/l/${encodeURIComponent(slug)}`;
  try {
    sessionStorage.setItem(UPDATED_KEY, slug);
    sessionStorage.setItem(EDIT_TOKEN_KEY, JSON.stringify({ slug, t: token }));
    location.href = url;
  } catch (e) {
    // sessionStorage が使えない環境。トークンは URL で渡す（遷移先の <head> ですぐ消える）。
    location.href = `${url}?t=${encodeURIComponent(token)}&updated=1`;
  }
}

/* ---------- 公開後の共有モーダル ---------- */
// 編集用URLは失くすと別の端末から編集できなくなるので、背景クリックでは閉じない。
// 編集用URLを一度もコピーしないまま閉じようとしたら確認する（Esc も同じ）。
// ただしログイン中はアカウント側にリストが保存されていて、どの端末からでも
// 「あなたのリスト」から編集に戻れる。控えを取る必要が無いので確認は出さない。
let shareSlug = null;
let editUrlCopied = false;
let shareEditOptional = false;

async function showShare(slug, token) {
  shareSlug = slug;
  editUrlCopied = false;
  const shareUrl = `${location.origin}/l/${slug}`;
  const editUrl = `${location.origin}/?edit=${slug}&t=${token}`;
  $("shareUrl").value = shareUrl;
  $("editUrl").value = editUrl;
  $("openShare").href = shareUrl;
  for (const id of ["copyShare", "copyEdit"]) resetCopyButton($(id));
  // 注意書き: ログイン中はアカウントに保存されるので、警告色ではなく案内にする。
  const warn = $("editUrlWarn");
  const hint = $("editUrlHint");
  if (warn._orig == null) warn._orig = warn.innerHTML; // 未ログイン時の文面（index.html）
  if (hint._orig == null) hint._orig = hint.textContent;
  const me = window.Account ? await window.Account.ready.catch(() => null) : null;
  shareEditOptional = !!(me && me.user);
  if (shareEditOptional) {
    warn.classList.add("safe");
    warn.textContent = "ログイン中のGoogleアカウントに保存されました。どの端末からでもトップの「あなたのリスト」から編集できます。";
    hint.textContent = "編集用URL（あなただけが編集できます。ログアウト中の端末から編集したいときに使えます）";
  } else {
    warn.classList.remove("safe");
    warn.innerHTML = warn._orig;
    hint.textContent = hint._orig;
    $("editUrlWarnLogin").hidden = !(me && me.enabled);
  }
  $("shareModal").classList.add("open");
  stopShareReadyPoll();
  pollShareReady(slug, Date.now());
}

/* ---------- 共有画像の準備状況 ---------- */
// 公開直後は full（100冊を1枚）がまだ描けていないことがある（src/index.ts queueShareImages で
// キューに積み、サイト全体で 1 枚ずつ描くため）。編集用URLを控えている間に出来てしまうことが
// 多いので、ボタンは塞がず 1 行だけ知らせる。/api/share-status は R2 を見るだけで描画を
// 起こさないので、モーダルが開いている間ポーリングしてよい。
const SHARE_READY_POLL_MS = 3000;
const SHARE_READY_SLOW_MS = 45000;
let shareReadyTimer = null;

function stopShareReadyPoll() {
  clearTimeout(shareReadyTimer);
  shareReadyTimer = null;
  $("shareReady").hidden = true;
}

async function pollShareReady(slug, started) {
  const el = $("shareReady");
  if (!$("shareModal").classList.contains("open") || shareSlug !== slug) return;
  let ready = [];
  try {
    const res = await fetch(`/api/share-status?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (res.ok) ready = (await res.json()).ready || [];
  } catch (e) {
    // 取れなければ黙って次の回に回す（準備状況は案内であって機能ではない）。
  }
  if (!$("shareModal").classList.contains("open") || shareSlug !== slug) return;
  if (ready.includes("full")) {
    el.hidden = true; // 揃ったので黙る（ここで止める）
    return;
  }
  // 長引いたら「画像なしで先にポスト」を促す。ボタンの並べ替えはしない（下の「𝕏 でポスト」が
  // そのまま画像なしの投稿なので、文面で指せば足りる）。
  el.textContent =
    Date.now() - started > SHARE_READY_SLOW_MS
      ? "共有画像が混み合っています。下の「𝕏 でポスト」なら画像を待たずに投稿できます。"
      : "共有画像を準備しています…（できてから「画像でポスト」を押すと待たずに済みます）";
  el.hidden = false;
  shareReadyTimer = setTimeout(() => pollShareReady(slug, started), SHARE_READY_POLL_MS);
}

async function requestCloseShare() {
  if (!editUrlCopied && !shareEditOptional) {
    const ok = await uiConfirm(
      "編集用URLをまだコピーしていません。\n失くすと、ほかの端末からはこのリストを編集できなくなります（この端末ではトップから編集に戻れます）。\n閉じてもよいですか？",
      { okLabel: "閉じる", cancelLabel: "戻ってコピーする" }
    );
    if (!ok) {
      $("copyEdit").focus();
      return;
    }
  }
  stopShareReadyPoll();
  $("shareModal").classList.remove("open");
}

const COPY_LABEL = "コピー";
function resetCopyButton(btn) {
  clearTimeout(btn._copiedTimer);
  btn.textContent = COPY_LABEL;
  btn.classList.remove("copied");
}

/* ---------- events ---------- */
function wireEvents() {
  $("topSearchBtn").addEventListener("click", topSearch);
  $("topSearch").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) topSearch(); });
  // 入力補完（public/suggest.js）。候補を選んだらそのまま検索する。
  topSuggest = attachSuggest($("topSearch"), {
    onPick: () => { syncTopSearchClear(); topSearch(); }, // 候補で欄が埋まるので × を出す
    params: suggestParams,
  });
  syncTopSearchClear = wireSearchClear($("topSearch"), $("topSearchClear"), () => topSuggest);
  $("fetchCovers").addEventListener("click", fetchMissingCovers);
  wireShareX($("shareXPost"), $("shareXImage"), () => ({ slug: shareSlug, owner: state.owner }));
  $("fixMissing").addEventListener("click", startFixMissing);
  $("clearAll").addEventListener("click", clearAll);
  $("revertPublished").addEventListener("click", revertToPublished);
  $("reorderToggle").addEventListener("click", toggleReorder);
  $("movePick").addEventListener("click", startPlacing);
  $("placeCancel").addEventListener("click", cancelPlacing);
  $("moveStart").addEventListener("click", () => moveSelectedToEnd(true));
  $("moveEnd").addEventListener("click", () => moveSelectedToEnd(false));
  $("reorderClear").addEventListener("click", () => { state.selected.clear(); render(); });
  $("sortBy").addEventListener("change", (e) => {
    const value = e.target.value;
    // 選んだ時点で見出しに戻す（キャンセルしても同じ項目をもう一度選べるように）。
    e.target.value = "";
    applySort(value);
  });
  $("reorderDone").addEventListener("click", toggleReorder);
  $("publish").addEventListener("click", openPublishModal);
  $("confirmPublish").addEventListener("click", confirmPublish);
  $("publicInput").addEventListener("change", updatePublicHint);
  $("cancelPublish").addEventListener("click", closePublishModal);
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
    // https のみ（サーバ側 src/corrections.ts normalizeCoverUrl と揃える）。承認されると
    // 全員のブラウザが読みに行くので、平文の http は受けない。
    if (!/^https:\/\//i.test(url)) { uiAlert("https:// の画像URLを指定してください。"); return; }
    applyPickedCover(url);
  });
  $("clearCover").addEventListener("click", () => applyPickedCover(""));
  $("coverSearchBtn").addEventListener("click", runCoverSearch);
  $("coverSearch").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) runCoverSearch(); });
  $("skipFix").addEventListener("click", () => { if (state.fixIndex >= 0) advanceFix(state.fixIndex); });
  $("pickModal").addEventListener("click", (e) => { if (e.target.id === "pickModal") closeCoverPicker(); });

  $("copyShare").addEventListener("click", (e) => copy($("shareUrl"), e.currentTarget));
  $("copyEdit").addEventListener("click", (e) => {
    editUrlCopied = true;
    copy($("editUrl"), e.currentTarget);
  });
  $("closeShare").addEventListener("click", requestCloseShare);
  // 背景クリックでは閉じない。Esc は ui-dialog.js から modal-escape で届くので確認付きで閉じる。
  $("shareModal").addEventListener("modal-escape", (e) => {
    e.preventDefault();
    requestCloseShare();
  });

  $("searchModal").addEventListener("click", (e) => { if (e.target.id === "searchModal") closeSearch(); });
  $("volModal").addEventListener("click", (e) => { if (e.target.id === "volModal") closeVolumeDetail(); });
  $("vClose").addEventListener("click", closeVolumeDetail);
  $("vAdd").addEventListener("click", addFromVolumeDetail);
  $("editModal").addEventListener("click", (e) => { if (e.target.id === "editModal") closeEdit(); });
  wireEditSwipe($("editModal").querySelector(".modal"));

  $("publishModal").addEventListener("click", (e) => { if (e.target.id === "publishModal") closePublishModal(); });
}

// URL をクリップボードへ。btn を渡すと数秒「コピーしました ✓」にする。
function copy(input, btn) {
  input.select();
  const done = () => {
    input.blur();
    if (!btn) return;
    clearTimeout(btn._copiedTimer);
    btn.textContent = "コピーしました ✓";
    btn.classList.add("copied");
    btn._copiedTimer = setTimeout(() => resetCopyButton(btn), 3000);
  };
  const legacy = () => {
    try {
      if (document.execCommand("copy")) done();
    } catch (e) {}
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, legacy);
  else legacy();
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
