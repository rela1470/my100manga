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

// 100 冊の閲覧画面（view.js）と同じ表紙グリッド。左上に順位、下にタイトルと選んだ人数。
function render(key) {
  const entries = windows[key] || [];
  const grid = $("list");
  grid.textContent = "";
  $("empty").hidden = entries.length > 0;

  const unit = key === "cumulative" ? "累計" : TABS.find((t) => t.key === key).label;
  $("note").textContent = entries.length
    ? `${unit}で選ばれた回数の多い順（選んだ人数）`
    : "";

  for (const e of entries) {
    // リンク先: ISBN で検索した結果（その巻のシリーズ。public/app.js openSearchFromUrl）。
    // 本の詳細の「巻一覧を開く」にも使う。
    const slot = document.createElement("a");
    slot.className = "slot view rank-slot";
    slot.href = `/?q=${encodeURIComponent(e.isbn)}`;
    slot.dataset.isbn = e.isbn;
    // タップはページに残って本の詳細（book-detail.js）を開く。Ctrl/⌘ クリック等は通常のリンク。
    slot.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      ev.preventDefault();
      openBookDetail(
        { isbn: e.isbn, title: e.title, author: e.author, cover_url: e.cover_url },
        { seriesHref: slot.href }
      );
    });
    if (e.author) slot.title = `${e.title}（${e.author}）`;

    const num = document.createElement("span");
    num.className = "num" + (e.rank <= 3 ? ` top${e.rank}` : "");
    num.textContent = e.rank;
    slot.appendChild(num);

    slot.appendChild(coverNode(e.cover_url, e.title));

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = e.title;
    meta.appendChild(t);
    const c = document.createElement("div");
    c.className = "c";
    c.textContent = `${e.count}人が選択`;
    meta.appendChild(c);
    slot.appendChild(meta);

    grid.appendChild(slot);
  }
}

// スナップショットに表紙が無いエントリだけ、/api/covers で遅延解決して差し込む。
async function fillMissingCovers() {
  const missing = [];
  for (const key of Object.keys(windows)) {
    for (const e of windows[key] || []) if (!e.cover_url && e.isbn) missing.push(e.isbn);
  }
  const covers = await lookupCovers(missing);
  // 取得できた表紙をデータと現在表示中の行へ反映する。
  for (const key of Object.keys(windows)) {
    for (const e of windows[key] || []) if (!e.cover_url && covers[e.isbn]) e.cover_url = covers[e.isbn];
  }
  for (const slot of document.querySelectorAll(".rank-slot")) {
    const url = covers[slot.dataset.isbn];
    const ph = slot.querySelector(".cover.placeholder");
    if (!url || !ph) continue;
    ph.replaceWith(coverNode(url, slot.querySelector(".meta .t")?.textContent || ""));
  }
}
load();
