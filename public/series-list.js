// シリーズ一覧のページ（/series）。GET /api/series-list で巻数の多い順にシリーズを受け取り、
// 「もっと見る」で続きを足す。巻数は巻一覧と同じ数え方の集計（series_stats,
// src/seriesStats.ts）で、cron が巻数の多いシリーズから順に数えて埋める（src/seriesList.ts）。
//
// 表紙を押すとページに残ったまま巻一覧（series-volumes.js）を開き、そこから自分の100に足せる。
// Ctrl/⌘ クリック等は通常のリンク（トップでシリーズを開く）。

const $ = (id) => document.getElementById(id);
let next = null;
let shown = 0;
let loading = false;

function seriesHref(e) {
  return `/?series=${encodeURIComponent(e.series_id)}&st=${encodeURIComponent(e.title)}`;
}

async function load() {
  if (loading) return;
  loading = true;
  const more = $("more");
  more.disabled = true;
  let data;
  try {
    data = await apiFetch(`/api/series-list${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
  } catch (e) {
    $("note").textContent = apiErrorMessage(e, "一覧の取得に失敗しました。時間をおいて再度お試しください。");
    loading = false;
    more.disabled = false;
    return;
  }
  const entries = data.entries || [];
  render(entries);
  next = data.next || null;
  more.hidden = !next;
  more.disabled = false;
  loading = false;
  $("empty").hidden = shown > 0;
  $("note").textContent = shown ? `巻数の多い順に ${shown} シリーズを表示中` : "";
  fillMissingCovers(entries);
}

function render(entries) {
  const grid = $("list");
  for (const e of entries) {
    const name = e.version ? `${e.title}（${e.version}）` : e.title;
    const slot = document.createElement("a");
    slot.className = "slot view rank-slot";
    slot.href = seriesHref(e);
    slot.dataset.coverIsbn = e.cover_url ? "" : e.isbn || "";
    slot.title = `${name}（全${e.vol_count}巻）`;
    slot.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      if (!window.openSeriesVolumes) return;
      ev.preventDefault();
      window.openSeriesVolumes(e.series_id, name, { editHref: slot.href });
    });

    const num = document.createElement("span");
    num.className = "num" + (e.rank <= 3 ? ` top${e.rank}` : "");
    num.textContent = e.rank;
    slot.appendChild(num);

    slot.appendChild(coverNode(e.cover_url, name));

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = name;
    meta.appendChild(t);
    const c = document.createElement("div");
    c.className = "c";
    c.textContent = [`全${e.vol_count}巻`, e.creator].filter(Boolean).join("・");
    meta.appendChild(c);
    // 同じ作品の別の版（ゴルゴ13 の SPコミックス / コンパクト版 …）が並ぶので、レーベルで見分ける。
    const l = e.label || e.publisher;
    if (l) {
      const lb = document.createElement("div");
      lb.className = "c";
      lb.textContent = l;
      meta.appendChild(lb);
    }
    slot.appendChild(meta);

    grid.appendChild(slot);
    shown++;
  }
}

// 表紙の無いシリーズは、先頭の巻の表紙を /api/covers で引いて差し込む（発行部数ランキングと同じ）。
async function fillMissingCovers(entries) {
  const want = entries.filter((e) => !e.cover_url && e.isbn).map((e) => e.isbn);
  if (!want.length) return;
  const covers = await lookupCovers(want);
  for (const slot of document.querySelectorAll(".rank-slot")) {
    const url = covers[slot.dataset.coverIsbn];
    const ph = slot.querySelector(".cover.placeholder");
    if (!url || !ph) continue;
    slot.dataset.coverIsbn = "";
    ph.replaceWith(coverNode(url, slot.querySelector(".meta .t")?.textContent || ""));
  }
}

$("more").addEventListener("click", load);
load();
