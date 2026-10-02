"use strict";

const $ = (id) => document.getElementById(id);

let currentSlug = null;
// Ordered items currently on screen + which one the detail modal is showing,
// so swipe/navigation can step to the neighbouring book.
let viewItems = [];
let currentIndex = -1;

function getSlug() {
  const m = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

// 自由入力（ユーザー名・ひとこと・コメント）の通報。控えめなワンクリック（確認ダイアログのみ）。
async function sendReport(slug, target, position, btn) {
  if (!slug) return;
  const label =
    target === "owner_name"
      ? "このユーザー名"
      : target === "bio"
        ? "このひとこと"
        : target === "cover"
          ? "この表紙画像"
          : "このコメント";
  if (!(await uiConfirm(`${label}を不適切として通報します。よろしいですか？`))) return;
  // 旗アイコン型（.report-flag）は文言部分だけ差し替えて、アイコンを残す。
  const textEl = btn.querySelector(".flag-text") || btn;
  const orig = textEl.textContent;
  btn.disabled = true;
  textEl.textContent = "通報中…";
  try {
    const res = await fetch(`/api/lists/${encodeURIComponent(slug)}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(position ? { target, position } : { target }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    textEl.textContent = "通報しました";
    btn.classList.add("revealed");
  } catch (e) {
    await uiAlert("通報に失敗しました: " + e.message);
    btn.disabled = false;
    textEl.textContent = orig;
  }
}

// 旗アイコン型の通報ボタン。ホバーの無いタッチ端末では初回タップで文言を展開するだけにし、
// 次のタップで通報する（誤タップでいきなり確認ダイアログを出さない）。
function wireReportFlag(btn, onReport) {
  btn.style.display = "";
  btn.addEventListener("click", () => {
    const noHover = window.matchMedia && window.matchMedia("(hover: none)").matches;
    if (noHover && !btn.classList.contains("revealed")) {
      btn.classList.add("revealed");
      return;
    }
    onReport();
  });
}

// 本のタイトルの通報（巻 ISBN 単位・グローバル）。リストに紐づかないので slug 不要。
async function sendTitleReport(isbn, btn) {
  if (!isbn) return;
  if (!(await uiConfirm("この本のタイトルの修正を依頼します。管理者が確認して修正します。よろしいですか？"))) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "送信中…";
  try {
    const res = await fetch(`/api/volume-title-reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbn }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    btn.textContent = "修正を依頼しました";
  } catch (e) {
    await uiAlert("修正依頼の送信に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function boot() {
  let data = window.__LIST__ || null;
  if (!data) {
    const slug = getSlug();
    if (slug) {
      try {
        const res = await fetch(`/api/lists/${slug}`);
        if (res.ok) data = await res.json();
      } catch (e) {}
    }
  }
  if (!data) {
    $("subtitle").textContent = "リストが見つかりませんでした";
    return;
  }
  render(data);
}

function render(data) {
  currentSlug = data.slug || getSlug();
  const owner = data.owner_name ? `${data.owner_name}さん` : "誰か";
  $("subtitle").textContent = `${owner}を構成する${data.items.length}の漫画`;
  if (data.owner_name) {
    $("ownerTitle").textContent = `${data.owner_name}'s`;
    $("ownerLine").hidden = false;
  }
  document.title = `${owner}を構成する100の漫画 | My 100 Manga`;

  const params = new URLSearchParams(location.search);
  // Prefer the token in the URL; otherwise recover it from this browser's
  // registry so the creator can still edit a list opened without the edit link.
  let token = params.get("t");
  if (!token && window.MyLists) {
    const rec = window.MyLists.get(data.slug);
    if (rec) token = rec.token;
  }
  if (token) {
    const btn = $("editLink");
    btn.style.display = "";
    btn.addEventListener("click", () => {
      location.href = `/?edit=${data.slug}&t=${encodeURIComponent(token)}`;
    });
  }

  if (data.owner_name) {
    const reportOwner = $("reportOwner");
    wireReportFlag(reportOwner, () => sendReport(data.slug, "owner_name", 0, reportOwner));
  }

  if (data.bio) {
    const bio = $("ownerBio");
    bio.textContent = data.bio;
    bio.style.display = "";
    const reportBio = $("reportBio");
    wireReportFlag(reportBio, () => sendReport(data.slug, "bio", 0, reportBio));
  }

  const grid = $("grid");
  grid.innerHTML = "";
  viewItems = data.items;

  data.items.forEach((it, idx) => {
    const slot = document.createElement("div");
    slot.className = "slot view";

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
      img.onerror = () => img.replaceWith(placeholder(it.title));
      applyCover(img, it.cover_url);
      slot.appendChild(img);
    } else {
      slot.appendChild(placeholder(it.title));
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = it.title;
    meta.appendChild(t);

    if (it.comment) {
      const c = document.createElement("div");
      c.className = "c" + (it.spoiler ? " spoiler" : "");
      c.textContent = it.comment;
      meta.appendChild(c);
    }
    slot.appendChild(meta);
    slot.addEventListener("click", () => openDetail(it, idx));
    grid.appendChild(slot);
  });
}

// Bumped on every open so a slow /api/book response for a previously-opened book
// can't overwrite the metadata of the one now showing.
let detailSeq = 0;

function openDetail(it, index) {
  const seq = ++detailSeq;
  currentIndex = typeof index === "number" ? index : viewItems.indexOf(it);
  $("dTitle").textContent = it.title || "";
  $("dAuthor").textContent = it.author || "";
  $("dAuthor").style.display = it.author ? "" : "none";

  // Fill what the stored item already knows; /api/book upgrades these below.
  setMetaRow("dIsbnRow", "dIsbn", it.isbn || "");
  setSourceRow("dSourceRow", "dSource", it.cover_url, it.isbn);
  setMetaRow("dPublisherRow", "dPublisher", "");
  setMetaRow("dPubdateRow", "dPubdate", "");
  $("dSeriesRow").style.display = "none";
  $("dSynopsisBox").style.display = "none";
  $("dSynopsis").textContent = "";
  loadBookMeta(it, seq);

  const box = $("dCoverBox");
  box.innerHTML = "";
  if (it.cover_url) {
    const img = document.createElement("img");
    img.className = "dcover";
    img.alt = it.title || "";
    img.onerror = () => {
      const d = document.createElement("div");
      d.className = "dnoimg";
      d.textContent = "No Image";
      img.replaceWith(d);
    };
    applyCover(img, it.cover_url);
    box.appendChild(img);
  } else {
    const d = document.createElement("div");
    d.className = "dnoimg";
    d.textContent = "No Image";
    box.appendChild(d);
  }

  const c = $("dComment");
  const reveal = $("dReveal");
  if (it.comment) {
    c.textContent = it.comment;
    c.className = "dcomment" + (it.spoiler ? " spoiler" : "");
    if (it.spoiler) {
      reveal.style.display = "";
      const show = () => { c.classList.add("revealed"); reveal.style.display = "none"; };
      c.onclick = show;
      reveal.onclick = show;
    } else {
      reveal.style.display = "none";
      c.onclick = null;
    }
  } else {
    c.textContent = "（コメントなし）";
    c.className = "dcomment empty";
    c.onclick = null;
    reveal.style.display = "none";
  }

  wireReportMenu(it);
  renderBuy(it);

  $("detailModal").classList.add("open");
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

// Fetch richer metadata (all authors, publisher, 発行日, あらすじ) for a book and
// fill the popup — but only if it's still the one on screen (seq guard).
async function loadBookMeta(it, seq) {
  if (!it.isbn) return;
  let data;
  try {
    const res = await fetch(`/api/book?isbn=${encodeURIComponent(it.isbn)}`);
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  if (seq !== detailSeq) return;

  if (Array.isArray(data.authors) && data.authors.length) {
    const authors = data.authors.join("、");
    $("dAuthor").textContent = authors;
    $("dAuthor").style.display = "";
  }
  setMetaRow("dPublisherRow", "dPublisher", data.publisher || "");
  setMetaRow("dPubdateRow", "dPubdate", data.pubdate || "");
  // シリーズの巻一覧へ。巻一覧はトップ（編集画面）の検索モーダルにしか無いので、
  // そこを ?series= 付きで開く（public/app.js openSeriesFromUrl）。
  if (data.series) {
    const a = $("dSeries");
    a.textContent = data.series.title;
    a.href = `/?series=${encodeURIComponent(data.series.id)}&st=${encodeURIComponent(data.series.title)}`;
    $("dSeriesRow").style.display = "";
  }
  if (data.caption) {
    $("dSynopsis").textContent = data.caption;
    $("dSynopsisBox").style.display = "";
  }
}

// Top-right ⚐ menu: one entry per reportable target present on this item.
// Hidden entirely when there's nothing to report.
function wireReportMenu(it) {
  const menu = $("reportMenu");
  const title = $("reportTitle");
  const cover = $("reportCover");
  const comment = $("reportComment");

  const setItem = (btn, target, present, text) => {
    if (present) {
      btn.style.display = "";
      btn.disabled = false;
      btn.textContent = text;
      btn.onclick = () => {
        closeReportMenu();
        sendReport(currentSlug, target, it.position, btn);
      };
    } else {
      btn.style.display = "none";
      btn.onclick = null;
    }
  };

  if (it.isbn) {
    title.style.display = "";
    title.disabled = false;
    title.textContent = "本のタイトルを修正";
    title.onclick = () => {
      closeReportMenu();
      sendTitleReport(it.isbn, title);
    };
  } else {
    title.style.display = "none";
    title.onclick = null;
  }

  setItem(cover, "cover", !!it.cover_url, "この表紙を通報");
  setItem(comment, "comment", !!it.comment, "このコメントを通報");

  closeReportMenu();
  menu.style.display = it.isbn || it.cover_url || it.comment ? "" : "none";
}

function openReportMenu() {
  $("reportPop").hidden = false;
  $("reportToggle").setAttribute("aria-expanded", "true");
}

function closeReportMenu() {
  const pop = $("reportPop");
  if (pop) pop.hidden = true;
  const toggle = $("reportToggle");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function renderBuy(it) {
  const box = $("dBuy");
  const groups = { print: $("dBuyPrint"), ebook: $("dBuyEbook"), used: $("dBuyUsed") };
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

// Step to the neighbouring book (dir=+1 next, -1 previous). Clamped at the ends.
function navigateDetail(dir) {
  const next = currentIndex + dir;
  if (next < 0 || next >= viewItems.length) return false;
  openDetail(viewItems[next], next);
  return true;
}

// Horizontal swipe on the modal card moves to the next/previous book. The card
// follows the finger and snaps back if the drag is too short; vertical drags are
// left alone so the modal still scrolls.
function wireDetailSwipe(content) {
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
    const atStart = currentIndex <= 0 && dx > 0;
    const atEnd = currentIndex >= viewItems.length - 1 && dx < 0;
    if (atStart || atEnd) dx *= 0.3;
    content.style.transform = `translateX(${dx}px)`;
  }, { passive: false });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    content.style.transition = "";
    if (axis === "x" && Math.abs(dx) > 60 && navigateDetail(dx < 0 ? 1 : -1)) {
      content.style.transform = "";
      return;
    }
    content.style.transform = "";
  };
  content.addEventListener("touchend", endDrag);
  content.addEventListener("touchcancel", endDrag);
}

function wireDetailModal() {
  const modal = $("detailModal");
  const close = () => { closeReportMenu(); modal.classList.remove("open"); };
  $("dClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  wireDetailSwipe(modal.querySelector(".modal"));

  const toggle = $("reportToggle");
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if ($("reportPop").hidden) openReportMenu();
    else closeReportMenu();
  });
  // Any click outside the ⚐ menu dismisses the popup.
  document.addEventListener("click", (e) => {
    if (!$("reportMenu").contains(e.target)) closeReportMenu();
  });
}

function placeholder(title) {
  const d = document.createElement("div");
  d.className = "cover placeholder";
  d.textContent = title;
  return d;
}

wireDetailModal();
boot();
