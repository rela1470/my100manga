// 売上ランキングページ。GET /api/sales-ranking で 4 窓（最新日 / 過去7日 / 過去30日 / 今年）を
// 受け取り、タブで切り替えて表示する。集計は src/salesRanking.ts（1 日 1 回の Cron で更新）。

const $ = (id) => document.getElementById(id);
let data = null;
let active = "d7";

// "2026-10-03" → "10/3"
function md(day) {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function tabsFor(d) {
  return [
    { key: "day", label: d.latest_day ? `日次（${md(d.latest_day)}）` : "日次" },
    { key: "d7", label: "過去7日" },
    { key: "d30", label: "過去30日" },
    { key: "year", label: `${d.year}年` },
  ];
}

async function load() {
  try {
    // 毎回取り直す。古い集計（データが入る前の空の集計を含む）をブラウザのキャッシュから出さない。
    const res = await fetch("/api/sales-ranking", { cache: "no-cache" });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $("note").textContent = "ランキングの取得に失敗しました。時間をおいて再度お試しください。";
    return;
  }
  renderTabs();
  render();
  fillMissingCovers();
}

function renderTabs() {
  const tabs = $("tabs");
  tabs.textContent = "";
  for (const t of tabsFor(data)) {
    const btn = document.createElement("button");
    btn.className = "rank-tab" + (t.key === active ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      active = t.key;
      renderTabs();
      render();
    });
    tabs.appendChild(btn);
  }
}

// 窓の始まりがデータの始まりより前なら、実際の集計開始日を添える（貯め始めの期間）。
function noteFor(key) {
  if (!data.latest_day) return "";
  if (key === "day") return `${md(data.latest_day)} 時点の楽天ブックスの売れ筋`;
  const shift = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const start = key === "d7" ? shift(data.latest_day, -6) : key === "d30" ? shift(data.latest_day, -29) : `${data.year}-01-01`;
  const from = data.first_day > start ? data.first_day : start;
  const partial = data.first_day > start ? "（集計開始日から）" : "";
  return `${md(from)}〜${md(data.latest_day)} の集計${partial}`;
}

// 100 冊の閲覧画面（view.js）と同じ表紙グリッド。左上に順位、下にタイトルと 1 行の補足。
// ポイントは並べ替えにだけ使い、画面には出さない。
function render() {
  const entries = (data.windows && data.windows[active]) || [];
  const grid = $("list");
  grid.textContent = "";
  $("empty").hidden = entries.length > 0;
  $("note").textContent = entries.length ? noteFor(active) : "";

  for (const e of entries) {
    // リンク先: 寄せ先があればエディタの巻一覧（public/app.js openSeriesFromUrl）、無ければ
    // 作品名での検索結果（openSearchFromUrl）。本の詳細の「巻一覧を開く」にも使う。
    const slot = document.createElement("a");
    slot.className = "slot view rank-slot";
    slot.href = e.series_id
      ? `/?series=${encodeURIComponent(e.series_id)}&st=${encodeURIComponent(e.work)}`
      : `/?q=${encodeURIComponent(e.search_q || e.work)}`;
    slot.dataset.coverIsbn = e.cover_url ? "" : e.cover_isbn || "";
    // タップはページに残って本の詳細（book-detail.js）を開く。Ctrl/⌘ クリック等は通常のリンク。
    slot.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      ev.preventDefault();
      openBookDetail(
        { isbn: e.isbn, title: e.title || e.work, author: e.author.replace(/\//g, "、"), cover_url: e.cover_url },
        { seriesHref: slot.href }
      );
    });
    // 代表の巻（最新刊）と発売日はツールチップで。
    if (e.title) slot.title = e.sales_date ? `${e.title}（${e.sales_date}発売）` : e.title;

    const num = document.createElement("span");
    num.className = "num" + (e.rank <= 3 ? ` top${e.rank}` : "");
    num.textContent = e.rank;
    slot.appendChild(num);

    slot.appendChild(coverNode(e));

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = e.work;
    meta.appendChild(t);
    // 日次は著者、期間の窓は「最高◯位・◯日」（どれだけ上位に居続けたか）。
    const sub = active === "day" ? e.author.split("/")[0] : `最高${e.best_rank}位・${e.days}日`;
    if (sub) {
      const c = document.createElement("div");
      c.className = "c";
      c.textContent = sub;
      meta.appendChild(c);
    }
    slot.appendChild(meta);

    grid.appendChild(slot);
  }
}

function coverNode(e) {
  if (e.cover_url) {
    const img = document.createElement("img");
    img.className = "cover";
    img.loading = "lazy";
    img.alt = e.work;
    img.onerror = () => img.replaceWith(placeholder(e.work));
    applyCover(img, e.cover_url);
    return img;
  }
  return placeholder(e.work);
}

function placeholder(title) {
  const d = document.createElement("div");
  d.className = "cover placeholder";
  d.textContent = title;
  return d;
}

// 表紙の無い作品は、寄せ先の最新巻（cover_isbn）の表紙を /api/covers で引いて差し込む。
async function fillMissingCovers() {
  const all = Object.values(data.windows || {}).flat();
  const isbns = [...new Set(all.filter((e) => !e.cover_url && e.cover_isbn).map((e) => e.cover_isbn))];
  if (!isbns.length) return;
  let covers = {};
  try {
    const res = await fetch("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns: isbns.slice(0, 400) }),
    });
    if (res.ok) covers = (await res.json()).covers || {};
  } catch {
    return;
  }
  for (const e of all) if (!e.cover_url && covers[e.cover_isbn]) e.cover_url = covers[e.cover_isbn];
  for (const slot of document.querySelectorAll(".rank-slot")) {
    const url = covers[slot.dataset.coverIsbn];
    const ph = slot.querySelector(".cover.placeholder");
    if (!url || !ph) continue;
    const alt = slot.querySelector(".meta .t")?.textContent || "";
    ph.replaceWith(coverNode({ cover_url: url, work: alt }));
  }
}

load();
