"use strict";

const $ = (id) => document.getElementById(id);

// 巻の副題（MADB の schema:alternateName）。同じシリーズに「上」「下」しか巻番号を持たない
// 別作品が並ぶとき、巻番号だけでは全部同じ表示になるので足す（public/app.js と同じ）。
function withSubtitle(base, subtitle) {
  if (!subtitle) return base;
  if (!base) return subtitle;
  return base.includes(subtitle) ? base : `${base} ${subtitle}`;
}

let currentSlug = null;
// Ordered items currently on screen + which one the detail modal is showing,
// so swipe/navigation can step to the neighbouring book.
let viewItems = [];
let currentIndex = -1;

const EDIT_TOKEN_KEY = "my100manga_edit_token"; // sessionStorage。index.html / view.html の <head> と共通

function heldEditToken(slug) {
  const held = window.__EDIT_TOKEN__;
  if (held && held.slug === slug && held.t) return held.t;
  try {
    const saved = JSON.parse(sessionStorage.getItem(EDIT_TOKEN_KEY) || "null");
    if (saved && saved.slug === slug && saved.t) return saved.t;
  } catch (e) {}
  return null;
}

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
    await apiFetch(`/api/lists/${encodeURIComponent(slug)}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await botHeaders("report")) },
      body: JSON.stringify(position ? { target, position } : { target }),
    });
    textEl.textContent = "通報しました";
    btn.classList.add("revealed");
  } catch (e) {
    await uiAlert(apiErrorMessage(e, "通報に失敗しました。時間をおいてもう一度お試しください。"));
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
    await apiFetch(`/api/volume-title-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await botHeaders("feedback")) },
      body: JSON.stringify({ isbn }),
    });
    btn.textContent = "修正を依頼しました";
  } catch (e) {
    await uiAlert(apiErrorMessage(e, "修正依頼の送信に失敗しました。時間をおいてもう一度お試しください。"));
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
  // 限定公開のリストは、見ている人にも URL を知っている人向けのページだと分かるようにする。
  if (data.unlisted) {
    const badge = document.createElement("span");
    badge.className = "secret-badge";
    badge.textContent = "ないしょ";
    badge.title = "限定公開：URLを知っている人だけが見られるリストです";
    $("subtitle").append(" ", badge);
  }
  if (data.owner_name) {
    $("ownerTitle").textContent = `${data.owner_name}'s`;
    $("ownerLine").hidden = false;
  }
  document.title = `${owner}を構成する100の漫画 | My 100 Manga`;
  wireShareX($("xPost"), $("xImage"), () => ({ slug: currentSlug, owner: data.owner_name }));

  const params = new URLSearchParams(location.search);
  // Prefer the token in the URL; otherwise recover it from this browser's
  // registry so the creator can still edit a list opened without the edit link.
  // URL の ?t= は view.html <head> のスクリプトが計測タグより先に消して __EDIT_TOKEN__ /
  // sessionStorage に移している。
  let token = params.get("t") || heldEditToken(data.slug);
  if (!token && window.MyLists) {
    const rec = window.MyLists.get(data.slug);
    if (rec) token = rec.token;
  }
  const showEdit = (t) => {
    const btn = $("editLink");
    btn.style.display = "";
    btn.addEventListener("click", () => {
      // token は URL に載せず sessionStorage で編集画面へ渡す（index.html / app.js takeEditToken）。
      // 保存できない環境だけ従来どおり ?t= を付ける（編集画面の <head> ですぐ消える）。
      try {
        sessionStorage.setItem(EDIT_TOKEN_KEY, JSON.stringify({ slug: data.slug, t }));
        location.href = `/?edit=${encodeURIComponent(data.slug)}`;
      } catch (e) {
        location.href = `/?edit=${data.slug}&t=${encodeURIComponent(t)}`;
      }
    });
  };
  // アクセス数のビーコン（src/publicLists.ts）。作者本人の閲覧は数えない。
  const countView = () =>
    fetch(`/api/lists/${encodeURIComponent(data.slug)}/view`, { method: "POST", keepalive: true }).catch(() => {});
  if (token) {
    showEdit(token);
  } else if (window.Account) {
    // ログイン中なら、アカウントに紐付いたリストは別の端末からでも編集できる。
    window.Account.lists().then((lists) => {
      const own = lists.find((l) => l.slug === data.slug);
      if (own) showEdit(own.edit_token);
      else countView();
    }, countView);
  } else {
    countView();
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
    // キーボードでも開けるよう button にする（Enter / Space で詳細）。
    const slot = document.createElement("button");
    slot.type = "button";
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

    slot.appendChild(coverNode(it.cover_url, it.title));

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = it.title;
    meta.appendChild(t);
    // コメントはカードには出さない（タップで開く詳細に入っている）。有無は上のバッジで示す。
    slot.appendChild(meta);
    slot.addEventListener("click", () => openDetail(it, idx));
    grid.appendChild(slot);
  });

  noteJustUpdated(data.slug);
}

// 編集画面で「更新する」を押した直後はこのページへ送られてくる（public/app.js goToPublished）。
// 更新できたことが分かるように通知を出す。印は一度拾ったら消して、再読み込みで再び出ないようにする。
const UPDATED_KEY = "my100manga_updated"; // sessionStorage。public/app.js と共通

function noteJustUpdated(slug) {
  let updated = false;
  try {
    updated = sessionStorage.getItem(UPDATED_KEY) === slug;
    if (updated) sessionStorage.removeItem(UPDATED_KEY);
  } catch (e) {}
  // sessionStorage が使えない端末向けのフォールバック（?updated=1）。URL からは消しておく。
  const url = new URL(location.href);
  if (url.searchParams.get("updated")) {
    updated = true;
    url.searchParams.delete("updated");
    try {
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    } catch (e) {}
  }
  // 通知は 1 行で省略されるので短く（.ui-toast-msg は nowrap + ellipsis）。
  if (updated) uiToast("更新しました。これが公開ページです。");
}

// Bumped on every open so a slow /api/book response for a previously-opened book
// can't overwrite the metadata of the one now showing.
let detailSeq = 0;

// 作者欄。名前ごとに作者名検索へのリンクにする（public/author-link.js）。閲覧画面には検索
// フォームが無いので、リンクはトップ（/?q=…&by=creator）へ遷移する。
function setDetailAuthor(text) {
  const el = $("dAuthor");
  const shown = window.renderAuthorLinks ? window.renderAuthorLinks(el, text) : ((el.textContent = text), !!text);
  el.style.display = shown ? "" : "none";
}

// 表紙の拡大表示に出す著作権表示（発行年・作者・出版社）。/api/book が返るまでは、リストの
// 項目が持っているぶん（作者）だけ。拡大を開いてから返ってきたときは書き直す。
let detailMeta = { pubdate: "", author: "", publisher: "" };

function openDetail(it, index) {
  const seq = ++detailSeq;
  detailMeta = { pubdate: "", author: it.author || "", publisher: "" };
  currentIndex = typeof index === "number" ? index : viewItems.indexOf(it);
  $("dTitle").textContent = it.title || "";
  setDetailAuthor(it.author || "");

  // Fill what the stored item already knows; /api/book upgrades these below.
  setMetaRow("dIsbnRow", "dIsbn", it.isbn || "");
  setSourceRow("dSourceRow", "dSource", it.cover_url, it.isbn);
  setMetaRow("dPublisherRow", "dPublisher", "");
  setMetaRow("dPubdateRow", "dPubdate", "");
  setMetaRow("dVolRow", "dVol", "");
  setMetaRow("dLabelRow", "dLabel", "");
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
    // 表紙は枠に合わせて切り抜いているので、押したら切れていない全体を拡大で出す
    // （public/cover-zoom.js。出典と著作権表示つき）。
    if (window.attachCoverZoom) {
      window.attachCoverZoom(img, {
        coverUrl: it.cover_url,
        isbn: it.isbn,
        title: it.title,
        meta: () => detailMeta,
      });
    }
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
  syncDetailNav();

  // 前の本の位置まで送られた状態で次の本が出ないように、背景（スクロールしているのは
  // .modal-backdrop）を先頭へ戻す。
  $("detailModal").scrollTop = 0;
  $("detailModal").classList.add("open");
}

// 「前の本 / 次の本」の矢印（view.html .detail-nav）。1 冊だけのリストでは出さず、
// 端では押せなくする。
function syncDetailNav() {
  const prev = $("dPrev");
  const next = $("dNext");
  if (!prev || !next) return;
  const many = viewItems.length > 1;
  prev.hidden = next.hidden = !many;
  prev.disabled = currentIndex <= 0;
  next.disabled = currentIndex < 0 || currentIndex >= viewItems.length - 1;
}


// 「画像参考元」の行。出品元が分かればそのページへのリンクにする（public/affiliate.js
// coverSourceLink）。

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
    setDetailAuthor(data.authors.join("、"));
    detailMeta.author = data.authors.join("、");
  }
  detailMeta.publisher = data.publisher || "";
  detailMeta.pubdate = data.pubdate || "";
  // 先に表紙を拡大していたら、そちらのクレジットも書き直す。
  if (window.refreshCoverZoomCredit) window.refreshCoverZoomCredit();
  setMetaRow("dPublisherRow", "dPublisher", data.publisher || "");
  setMetaRow("dPubdateRow", "dPubdate", data.pubdate || "");
  setMetaRow("dVolRow", "dVol", withSubtitle(data.volume_number || "", data.subtitle));
  setMetaRow("dLabelRow", "dLabel", data.label || "");
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

  $("dPrev").addEventListener("click", () => navigateDetail(-1));
  $("dNext").addEventListener("click", () => navigateDetail(1));
  // ←→ でも前後の本へ。上に別のダイアログ（表紙の拡大・uiConfirm 等）が開いているときは
  // そちらの操作なので何もしない。Esc と Tab は public/ui-dialog.js が共通で見ている。
  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("open")) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const t = e.target;
    if (t && (t.isContentEditable || (t.matches && t.matches("input, textarea, select")))) return;
    if (document.querySelector(".modal-backdrop.open:not(#detailModal), .ui-dialog-backdrop.open")) return;
    if (navigateDetail(e.key === "ArrowRight" ? 1 : -1)) e.preventDefault();
  });

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

wireDetailModal();
boot();
