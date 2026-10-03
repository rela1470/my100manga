// 公開リスト一覧ページ。GET /api/public-lists?sort=&page= を表示する。並びは新着（公開順）と
// アクセス数順の 4 窓。今の並び・ページは URL (?sort=&page=) に持たせ、共有・戻るで復元できるようにする。

const TABS = [
  { key: "new", label: "新着" },
  { key: "today", label: "今日" },
  { key: "d7", label: "7日間" },
  { key: "d30", label: "30日間" },
  { key: "all", label: "累計" },
];
const NOTE = {
  new: "公開された順（新しい順）",
  today: "今日（日本時間）のアクセス数の多い順",
  d7: "過去7日間のアクセス数の多い順",
  d30: "過去30日間のアクセス数の多い順",
  all: "累計アクセス数の多い順",
};

const $ = (id) => document.getElementById(id);
let sort = "new";
let page = 1;

function readUrl() {
  const p = new URLSearchParams(location.search);
  sort = TABS.some((t) => t.key === p.get("sort")) ? p.get("sort") : "new";
  page = Math.max(1, Math.floor(Number(p.get("page"))) || 1);
}

function writeUrl() {
  const p = new URLSearchParams();
  if (sort !== "new") p.set("sort", sort);
  if (page > 1) p.set("page", String(page));
  const q = p.toString();
  history.pushState(null, "", q ? `?${q}` : location.pathname);
}

async function load() {
  renderTabs();
  $("note").textContent = NOTE[sort];
  let data;
  try {
    const res = await fetch(`/api/public-lists?sort=${sort}&page=${page}`);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $("note").textContent = "一覧の取得に失敗しました。時間をおいて再度お試しください。";
    return;
  }
  render(data);
}

function renderTabs() {
  const tabs = $("tabs");
  tabs.textContent = "";
  for (const t of TABS) {
    const btn = document.createElement("button");
    btn.className = "rank-tab" + (t.key === sort ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      if (t.key === sort) return;
      sort = t.key;
      page = 1;
      writeUrl();
      load();
    });
    tabs.appendChild(btn);
  }
}

function render(data) {
  const grid = $("list");
  grid.textContent = "";
  $("empty").hidden = data.lists.length > 0;
  for (const l of data.lists) grid.appendChild(card(l));

  const pages = Math.max(1, Math.ceil(data.total / data.per));
  $("pager").hidden = pages <= 1;
  $("pageInfo").textContent = `${data.page} / ${pages}`;
  $("prev").disabled = data.page <= 1;
  $("next").disabled = data.page >= pages;
}

function card(l) {
  const a = document.createElement("a");
  a.className = "plist-card";
  a.href = `/l/${encodeURIComponent(l.slug)}`;

  const covers = document.createElement("div");
  covers.className = "plist-covers";
  // 小さい枠なので、表紙の無い巻はタイトルを出さず空の枠にする。
  for (const c of l.covers) covers.appendChild(coverNode(c.cover_url, c.title, ""));
  a.appendChild(covers);

  const title = document.createElement("div");
  title.className = "plist-title";
  title.textContent = `${l.owner_name ? `${l.owner_name}さん` : "誰か"}を構成する100の漫画`;
  a.appendChild(title);

  if (l.bio) {
    const bio = document.createElement("div");
    bio.className = "plist-bio";
    bio.textContent = l.bio;
    a.appendChild(bio);
  }

  const meta = document.createElement("div");
  meta.className = "plist-meta";
  const parts = [`${fmtDate(l.created_at)} 公開`];
  if (l.views !== null) parts.push(`${l.views.toLocaleString("ja-JP")}回表示`);
  meta.textContent = parts.join(" ・ ");
  a.appendChild(meta);
  return a;
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

$("prev").addEventListener("click", () => { page--; writeUrl(); load(); scrollTo(0, 0); });
$("next").addEventListener("click", () => { page++; writeUrl(); load(); scrollTo(0, 0); });
addEventListener("popstate", () => { readUrl(); load(); });
readUrl();
load();
