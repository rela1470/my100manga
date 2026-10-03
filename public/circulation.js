// 発行部数ランキングのページ。GET /api/circulation で作品の一覧（部数の降順）を受け取って
// 並べる。集計は src/circulation.ts、元データは英語版 Wikipedia「List of best-selling manga」
// （取り込みは scripts/wikipedia-circulation.mjs）。
//
// 出典・ライセンスの表示は renderAttribution が API の source からその場で組み立てる。
// 取り込み直したときに版（oldid）と取得日が自動で追従するよう、HTML には直書きしない。

const $ = (id) => document.getElementById(id);
let data = null;

/** 600000000 → "6億部"、157200000 → "1億5720万部"、20400000 → "2040万部"。 */
function copiesLabel(copies) {
  const man = Math.round(copies / 10000);
  if (man < 10000) return `${man}万部`;
  const oku = Math.floor(man / 10000);
  const rest = man % 10000;
  return rest ? `${oku}億${rest}万部` : `${oku}億部`;
}

/** "2026-03" → "2026年3月時点"。空なら時点が分からないことをそのまま出す。 */
function asOfLabel(asOf) {
  if (!asOf) return "時点不明";
  const [y, m] = asOf.split("-");
  return m ? `${Number(y)}年${Number(m)}月時点` : `${Number(y)}年時点`;
}

async function load() {
  try {
    data = await apiFetch("/api/circulation");
  } catch (e) {
    $("note").textContent = apiErrorMessage(e, "ランキングの取得に失敗しました。時間をおいて再度お試しください。");
    return;
  }
  render();
  renderAttribution();
  fillMissingCovers();
}

function render() {
  const entries = data.entries || [];
  const grid = $("list");
  grid.textContent = "";
  $("empty").hidden = entries.length > 0;
  $("note").textContent = entries.length ? `累計 2000 万部以上の ${entries.length} 作品` : "";

  for (const e of entries) {
    // 寄せ先があれば巻一覧、無ければ作品名での検索結果へ（売上ランキングと同じ）。
    const slot = document.createElement("a");
    slot.className = "slot view rank-slot";
    slot.href = e.series_id
      ? `/?series=${encodeURIComponent(e.series_id)}&st=${encodeURIComponent(e.title)}`
      : `/?q=${encodeURIComponent(e.search_q || e.title)}`;
    slot.dataset.coverIsbn = e.cover_url ? "" : e.cover_isbn || "";
    slot.title = `${e.title}（${copiesLabel(e.copies)}・${asOfLabel(e.as_of)}）`;

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
    // 部数は作品ごとに時点が違うので、順位の根拠として必ず時点を添える。
    const c = document.createElement("div");
    c.className = "c";
    c.textContent = `${copiesLabel(e.copies)}・${asOfLabel(e.as_of)}`;
    meta.appendChild(c);
    slot.appendChild(meta);

    grid.appendChild(slot);
  }
}

// 出典・ライセンス・改変の明示。CC BY-SA 4.0 の帰属表示として、記事（取り込んだ版）への
// リンク、ライセンスへのリンク、加えた変更、この一覧自体が同じライセンスであることを出す。
// 詳しくは db/add-circulation.sql と /terms の該当条項。
function renderAttribution() {
  const s = data.source;
  const p = $("attribution");
  p.textContent = "";
  if (!s) return;

  const a = (href, text) => {
    const el = document.createElement("a");
    el.href = href;
    el.textContent = text;
    el.rel = "noopener";
    el.target = "_blank";
    return el;
  };
  const text = (t) => document.createTextNode(t);

  p.append(text("出典: ウィキペディア "));
  p.append(a(s.url, `「${s.title}」`));
  p.append(text(`（${s.retrieved} 取得の版）／ `));
  p.append(a(s.license_url, s.license));
  p.append(
    text(
      "。この一覧は同記事から作品名・著者・出版社・累計発行部数・その時点を取り出し、" +
        "日本語の作品名に対応付けて当サイトの巻の一覧と結び付けたものです（注記などの文章は含みません）。" +
        "この一覧の内容は同じく CC BY-SA 4.0 で利用できます。"
    )
  );
}

// 表紙の無い作品は、寄せ先の最新巻（cover_isbn）の表紙を /api/covers で引いて差し込む。
async function fillMissingCovers() {
  const entries = data.entries || [];
  const covers = await lookupCovers(entries.filter((e) => !e.cover_url && e.cover_isbn).map((e) => e.cover_isbn));
  for (const slot of document.querySelectorAll(".rank-slot")) {
    const url = covers[slot.dataset.coverIsbn];
    const ph = slot.querySelector(".cover.placeholder");
    if (!url || !ph) continue;
    ph.replaceWith(coverNode(url, slot.querySelector(".meta .t")?.textContent || ""));
  }
}

load();
