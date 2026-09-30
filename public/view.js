"use strict";

const $ = (id) => document.getElementById(id);

let currentSlug = null;

function getSlug() {
  const m = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

// 自由入力（ユーザー名・コメント）の通報。控えめなワンクリック（確認ダイアログのみ）。
async function sendReport(slug, target, position, btn) {
  if (!slug) return;
  const label =
    target === "owner_name" ? "このユーザー名" : target === "cover" ? "この表紙画像" : "このコメント";
  if (!confirm(`${label}を不適切として通報します。よろしいですか？`)) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "通報中…";
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
    btn.textContent = "通報しました";
  } catch (e) {
    alert("通報に失敗しました: " + e.message);
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
  document.title = `${owner}を構成する100の漫画 | my100manga`;

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

  const reportOwner = $("reportOwner");
  if (data.owner_name) {
    reportOwner.style.display = "";
    reportOwner.addEventListener("click", () => sendReport(data.slug, "owner_name", 0, reportOwner));
  }

  const grid = $("grid");
  grid.innerHTML = "";
  $("filled").textContent = String(data.items.length);

  data.items.forEach((it, i) => {
    const slot = document.createElement("div");
    slot.className = "slot view";

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1);
    slot.appendChild(num);

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
      img.onerror = () => img.replaceWith(placeholder(it.title));
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
    slot.addEventListener("click", () => openDetail(it));
    grid.appendChild(slot);
  });
}

function openDetail(it) {
  $("dTitle").textContent = it.title || "";
  $("dAuthor").textContent = it.author || "";
  $("dAuthor").style.display = it.author ? "" : "none";

  const box = $("dCoverBox");
  box.innerHTML = "";
  if (it.cover_url) {
    const img = document.createElement("img");
    img.className = "dcover";
    img.src = it.cover_url;
    img.alt = it.title || "";
    img.onerror = () => {
      const d = document.createElement("div");
      d.className = "dnoimg";
      d.textContent = "No Image";
      img.replaceWith(d);
    };
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

// Top-right ⚐ menu: one entry per reportable target present on this item.
// Hidden entirely when there's nothing to report.
function wireReportMenu(it) {
  const menu = $("reportMenu");
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

  setItem(cover, "cover", !!it.cover_url, "この表紙を通報");
  setItem(comment, "comment", !!it.comment, "このコメントを通報");

  closeReportMenu();
  menu.style.display = it.cover_url || it.comment ? "" : "none";
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
    (groups[l.format] || groups.print).appendChild(a);
  });
  box.style.display = "";
}

function wireDetailModal() {
  const modal = $("detailModal");
  const close = () => { closeReportMenu(); modal.classList.remove("open"); };
  $("dClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

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
