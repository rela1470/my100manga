// 人気ランキングページ。GET /api/ranking で 4 窓 (累計 / 過去30日 / 7日 / 24時間) を受け取り、
// タブで切り替えて表示する。7日・24時間は該当が 0 件ならタブ (導線) ごと隠す。

// 累計と30日は常に出す。7d/24h は件数があるときだけタブを出す。
const TABS = [
  { key: "cumulative", label: "累計", always: true },
  { key: "d30", label: "過去30日", always: true },
  { key: "d7", label: "過去7日", always: false },
  { key: "d24", label: "過去24時間", always: false },
];

const $ = (id) => document.getElementById(id);
let windows = {};
let active = "cumulative";

async function load() {
  let data;
  try {
    const res = await fetch("/api/ranking");
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $("note").textContent = "ランキングの取得に失敗しました。時間をおいて再度お試しください。";
    return;
  }
  windows = data.windows || {};
  renderTabs();
  render(active);
  fillMissingCovers();
}

function renderTabs() {
  const tabs = $("tabs");
  tabs.textContent = "";
  const visible = TABS.filter((t) => t.always || (windows[t.key] || []).length > 0);
  // active が隠れた窓なら先頭 (累計) に戻す。
  if (!visible.some((t) => t.key === active)) active = visible[0].key;
  for (const t of visible) {
    const btn = document.createElement("button");
    btn.className = "rank-tab" + (t.key === active ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      active = t.key;
      renderTabs();
      render(active);
    });
    tabs.appendChild(btn);
  }
}

function render(key) {
  const entries = windows[key] || [];
  const list = $("list");
  list.textContent = "";
  $("empty").hidden = entries.length > 0;

  const unit = key === "cumulative" ? "累計" : TABS.find((t) => t.key === key).label;
  $("note").textContent = entries.length
    ? `${unit}で選ばれた回数の多い順（選んだ人数）`
    : "";

  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "rank-row";
    li.dataset.isbn = e.isbn;

    const num = document.createElement("div");
    num.className = "rank-num" + (e.rank <= 3 ? " top" : "");
    num.textContent = e.rank;
    li.appendChild(num);

    const coverBox = document.createElement("div");
    coverBox.className = "rank-cover";
    coverBox.appendChild(coverNode(e));
    li.appendChild(coverBox);

    const meta = document.createElement("div");
    meta.className = "rank-meta";
    const title = document.createElement("div");
    title.className = "rank-title";
    title.textContent = e.title;
    meta.appendChild(title);
    if (e.author) {
      const author = document.createElement("div");
      author.className = "rank-author";
      author.textContent = e.author;
      meta.appendChild(author);
    }
    li.appendChild(meta);

    const count = document.createElement("div");
    count.className = "rank-count";
    count.innerHTML = `<span class="rank-count-num">${e.count}</span><span class="rank-count-unit">人が選択</span>`;
    li.appendChild(count);

    list.appendChild(li);
  }
}

function coverNode(e) {
  if (e.cover_url) {
    const img = document.createElement("img");
    img.className = "cover";
    img.loading = "lazy";
    img.src = e.cover_url;
    img.alt = e.title;
    img.onerror = () => img.replaceWith(placeholder(e.title));
    return img;
  }
  return placeholder(e.title);
}

function placeholder(title) {
  const d = document.createElement("div");
  d.className = "cover placeholder";
  d.textContent = title;
  return d;
}

// スナップショットに表紙が無いエントリだけ、既存の /api/covers で遅延解決して差し込む。
async function fillMissingCovers() {
  const missing = new Set();
  for (const key of Object.keys(windows)) {
    for (const e of windows[key] || []) if (!e.cover_url && e.isbn) missing.add(e.isbn);
  }
  if (missing.size === 0) return;
  let covers = {};
  try {
    const res = await fetch("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns: [...missing].slice(0, 400) }),
    });
    if (res.ok) covers = (await res.json()).covers || {};
  } catch {
    return;
  }
  // 取得できた表紙をデータと現在表示中の行へ反映する。
  for (const key of Object.keys(windows)) {
    for (const e of windows[key] || []) if (!e.cover_url && covers[e.isbn]) e.cover_url = covers[e.isbn];
  }
  for (const li of document.querySelectorAll(".rank-row")) {
    const isbn = li.dataset.isbn;
    if (!isbn || !covers[isbn]) continue;
    const box = li.querySelector(".rank-cover");
    if (box && box.querySelector(".placeholder")) {
      box.textContent = "";
      const img = document.createElement("img");
      img.className = "cover";
      img.loading = "lazy";
      img.src = covers[isbn];
      img.alt = li.querySelector(".rank-title")?.textContent || "";
      img.onerror = () => img.replaceWith(placeholder(img.alt));
      box.appendChild(img);
    }
  }
}

load();
