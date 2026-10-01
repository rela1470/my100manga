"use strict";

const $ = (id) => document.getElementById(id);

// 1ページあたりの表示件数。サーバ側は ?page / ?per を受け取り COUNT で total を返す。
const PER = 50;

// 一覧ごとの現在ページ（1-origin）。再読み込み・変更後の再取得で位置を保つ。
const pageState = {
  reports: 1,
  lists: 1,
  audit: 1,
  volReports: 1,
  seriesReports: 1,
  corr: 1,
  coverSuggest: 1,
  sup: 1,
  bookMeta: 1,
  volHidden: 1,
  corrReviewed: 1,
  nameOverrides: 1,
  volTitleReports: 1,
  titleOverrides: 1,
  reportResolved: 1,
  coverSuggestResolved: 1,
};

const STAT_LABELS = [
  ["lists", "公開リスト"],
  ["reports", "通報"],
  ["volume_reports", "巻の通報"],
  ["series_reports", "シリーズ名の通報"],
  ["series", "シリーズ"],
  ["volumes", "巻(ISBN)"],
  ["covers", "表紙キャッシュ"],
  ["corrections", "巻の修正"],
  ["cover_suggestions", "表紙の修正"],
];

function fmtDate(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function daysBetween(fromMs, toMs) {
  if (!fromMs || !toMs || toMs <= fromMs) return 0;
  return Math.floor((toMs - fromMs) / (24 * 60 * 60 * 1000));
}

// ISBN の実在・正誤をその場で確認するための外部リンク（別タブ）。
function isbnConfirmCell(isbn) {
  const mk = (href, text) =>
    el("a", { href, target: "_blank", rel: "noopener", textContent: text });
  return el("td", { className: "report-actions" }, [
    mk(`https://books.google.co.jp/books?vid=ISBN${encodeURIComponent(isbn)}`, "Google"),
    mk(`https://search.rakuten.co.jp/search/mall/${encodeURIComponent(isbn)}/`, "楽天"),
    mk(`https://ndlsearch.ndl.go.jp/search?cs=bib&keyword=${encodeURIComponent(isbn)}`, "NDL"),
  ]);
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      // node.dataset は getter のみ。strict モードでは代入すると throw するので
      // 中身を個別に流し込む。
      if (k === "dataset") Object.assign(node.dataset, v);
      else node[k] = v;
    }
  }
  for (const c of children || []) node.append(c);
  return node;
}

// 汎用ページャー。total（総件数）と現在ページから前へ/次へと位置表示を描く。
// go(nextPage) は該当一覧の loader を呼ぶ。1ページに収まるなら非表示。
function renderPager(pagerId, page, total, go) {
  const box = $(pagerId);
  if (!box) return;
  box.textContent = "";
  const pages = Math.max(1, Math.ceil(total / PER));
  if (total <= PER && page <= 1) {
    box.style.display = "none";
    return;
  }
  box.style.display = "";

  const prev = el("button", { textContent: "← 前へ", disabled: page <= 1 });
  prev.addEventListener("click", () => go(page - 1));
  const next = el("button", { textContent: "次へ →", disabled: page >= pages });
  next.addEventListener("click", () => go(page + 1));

  const from = total === 0 ? 0 : (page - 1) * PER + 1;
  const to = Math.min(page * PER, total);
  const info = el("span", {
    className: "pager-info",
    textContent: `${total.toLocaleString("ja-JP")}件中 ${from.toLocaleString("ja-JP")}–${to.toLocaleString("ja-JP")}（${page}/${pages}ページ）`,
  });

  box.append(prev, info, next);
}

async function loadStats() {
  const grid = $("statGrid");
  grid.textContent = "";
  try {
    const res = await fetch("/api/admin/stats");
    const data = await res.json();
    const stats = data.stats || {};
    for (const [key, label] of STAT_LABELS) {
      grid.append(
        el("div", { className: "stat-card" }, [
          el("div", { className: "n", textContent: (stats[key] ?? 0).toLocaleString("ja-JP") }),
          el("div", { className: "k", textContent: label }),
        ])
      );
    }
  } catch {
    grid.append(el("p", { className: "admin-empty", textContent: "統計の取得に失敗しました" }));
  }
}

async function loadLists(page = pageState.lists) {
  const table = $("listTable");
  const body = $("listBody");
  const hint = $("listHint");
  const count = $("listCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("listPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/lists?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "一覧の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const lists = data.lists || [];
  const total = data.total ?? lists.length;
  // 末尾ページで全削除された等でページが空になったら1つ前へ戻る。
  if (lists.length === 0 && page > 1 && total > 0) {
    return loadLists(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.lists = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "まだ公開されたリストはありません。";
    hint.style.display = "";
    return;
  }

  for (const it of lists) {
    const owner = it.owner_name ? it.owner_name : "（名前なし）";
    const coverWarn = it.cover_count < it.item_count;

    const delBtn = el("button", { className: "danger", textContent: "削除" });
    delBtn.addEventListener("click", () => deleteList(it.slug, owner, delBtn));

    const detailLink = el("a", {
      className: "slug detail",
      textContent: it.slug,
      title: "詳細（公開履歴つき）を表示",
    });
    detailLink.addEventListener("click", () => openDetail(it.slug));

    // 直近の公開元 IP（国）と公開回数。IP をクリックすると監査ログをこの slug で絞り込む。
    let publisherCell;
    if (it.publish_count > 0) {
      const ipText = it.last_ip || "(不明)";
      const label = it.last_country ? `${ipText}（${it.last_country}）` : ipText;
      const ipLink = el("a", {
        className: "slug detail",
        textContent: label,
        title: "このリストの監査ログを表示",
      });
      ipLink.addEventListener("click", () => filterAuditBySlug(it.slug));
      const children = [ipLink];
      if (it.publish_count > 1) {
        children.push(el("span", { className: "count", textContent: ` ×${it.publish_count}` }));
      }
      publisherCell = el("td", null, children);
    } else {
      publisherCell = el("td", { className: "muted", textContent: "記録なし" });
    }

    body.append(
      el("tr", { dataset: { slug: it.slug } }, [
        el("td", null, [detailLink]),
        el("td", { className: "owner", textContent: owner }),
        el("td", { className: "num", textContent: String(it.item_count) }),
        el("td", { className: "num" + (coverWarn ? " warn" : ""), textContent: `${it.cover_count}/${it.item_count}` }),
        el("td", { textContent: fmtDate(it.created_at) }),
        el("td", { textContent: fmtDate(it.updated_at) }),
        publisherCell,
        el("td", null, [delBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("listPager", page, total, loadLists);
}

function coverThumb(url, cls, noimgCls, alt) {
  if (url) {
    const img = el("img", { className: cls, loading: "lazy", alt: alt || "" });
    applyCover(img, url);
    return img;
  }
  return el("div", { className: noimgCls, textContent: "No Image" });
}

// coverThumb を、画像があればクリックで拡大オーバーレイを開けるようにしたもの。表紙の修正で
// 現在の表紙と提案表紙を小さいサムネイルのまま見比べづらいので、押すと重ねて拡大表示する。
function zoomableCover(url, alt) {
  const node = coverThumb(url, "corr-thumb", "corr-noimg", alt);
  if (url) {
    node.classList.add("zoomable");
    node.title = "クリックで拡大";
    node.addEventListener("click", () => openCoverZoom(url));
  }
  return node;
}

function openCoverZoom(url) {
  $("coverZoomImg").src = url;
  $("coverZoom").hidden = false;
}

function closeCoverZoom() {
  $("coverZoom").hidden = true;
  $("coverZoomImg").src = "";
}

// 通報テーブルのセル。cover 通報で値が画像URLなら、クリックで原寸を開けるサムネイルを出す。
// それ以外（コメント文・「（空）」等の状態テキスト）はそのままテキスト表示。
function reportValueCell(value, cls, isCover) {
  const td = el("td", { className: cls });
  if (isCover && typeof value === "string" && /^https?:\/\//.test(value)) {
    const link = el("a", { href: value, target: "_blank", rel: "noopener", title: value });
    link.append(el("img", { className: "report-cover", src: value, loading: "lazy", alt: "" }));
    td.append(link);
  } else {
    td.textContent = value;
  }
  return td;
}

async function openDetail(slug) {
  const modal = $("detailModal");
  const grid = $("detailGrid");
  const meta = $("detailMeta");
  const titleEl = $("detailTitle");
  grid.textContent = "";
  $("detailAudit").textContent = "";
  meta.textContent = "読み込み中…";
  titleEl.textContent = slug;
  modal.classList.add("open");

  renderDetailAudit(slug);

  let list;
  try {
    const res = await fetch(`/api/admin/lists/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = (await res.json()).list;
  } catch (e) {
    meta.textContent = "読み込みに失敗しました: " + e.message;
    return;
  }

  const owner = list.owner_name || "（名前なし）";
  titleEl.textContent = `${owner} — ${list.slug}`;
  const editUrl = `${location.origin}/?edit=${encodeURIComponent(list.slug)}&t=${encodeURIComponent(list.edit_token)}`;
  meta.textContent = "";
  meta.append(
    document.createTextNode(`${list.items.length}作品 ｜ 作成 ${fmtDate(list.created_at)} ｜ 更新 ${fmtDate(list.updated_at)} ｜ `),
    el("a", { href: `/l/${encodeURIComponent(list.slug)}`, target: "_blank", rel: "noopener", textContent: "公開ページ" }),
    document.createTextNode(" ｜ "),
    el("a", { href: editUrl, target: "_blank", rel: "noopener", textContent: "編集リンク" })
  );

  for (const it of list.items) {
    const flags = [];
    if (it.spoiler) flags.push("ネタバレ");
    if (it.comment) flags.push("コメント有");
    grid.append(
      el("div", { className: "detail-item" }, [
        coverThumb(it.cover_url, "di-cover", "di-noimg", it.title),
        el("div", { className: "di-body" }, [
          el("div", { className: "di-pos", textContent: `#${it.position}` }),
          el("div", { className: "di-title", textContent: it.title }),
          el("div", { className: "di-author", textContent: it.author || "" }),
          flags.length ? el("div", { className: "di-flags", textContent: flags.join(" / ") }) : "",
        ].filter(Boolean)),
      ])
    );
  }
}

const AUDIT_ACTION_LABEL = { create: "新規公開", update: "更新公開" };

// 公開リスト一覧から監査ログページへ移動し、その slug で絞り込む。
function filterAuditBySlug(slug) {
  $("auditSlug").value = slug || "";
  if (location.hash === "#audit") loadAudit(1);
  else location.hash = "#audit"; // hashchange → showPage('audit') → loadAudit(1) が input を読む
}

// リスト詳細モーダルに公開履歴の件数と、監査ログページへのリンクだけ出す。
// 一覧（デカい表）はモーダルに展開せず、監査ログページ側で slug 絞り込みして見る。
async function renderDetailAudit(slug) {
  const box = $("detailAudit");
  box.textContent = "";
  let data;
  try {
    const res = await fetch(`/api/admin/publish-audit?slug=${encodeURIComponent(slug)}&per=1`);
    data = await res.json();
  } catch {
    box.append(el("p", { className: "hint warn", textContent: "公開履歴の取得に失敗しました" }));
    return;
  }
  const total = data.total ?? (data.audit || []).length;
  if (total === 0) {
    box.append(el("p", { className: "hint", textContent: "公開の記録はありません。" }));
    return;
  }
  const link = el("a", {
    className: "slug detail",
    textContent: "監査ログを表示",
    title: "このリストの監査ログをログページで表示",
  });
  link.addEventListener("click", () => {
    closeDetail();
    filterAuditBySlug(slug);
  });
  box.append(
    el("p", { className: "hint" }, [
      document.createTextNode(`公開履歴 ${total.toLocaleString("ja-JP")}件 ｜ `),
      link,
    ])
  );
}

async function loadAudit(page = pageState.audit) {
  const table = $("auditTable");
  const body = $("auditBody");
  const hint = $("auditHint");
  const count = $("auditCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("auditPager").style.display = "none";

  const slug = $("auditSlug").value.trim();
  const slugQs = slug ? `&slug=${encodeURIComponent(slug)}` : "";

  let data;
  try {
    const res = await fetch(`/api/admin/publish-audit?page=${page}&per=${PER}${slugQs}`);
    data = await res.json();
  } catch {
    hint.textContent = "監査ログの取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const audit = data.audit || [];
  const total = data.total ?? audit.length;
  if (audit.length === 0 && page > 1 && total > 0) {
    return loadAudit(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.audit = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = slug ? "この slug の公開履歴はありません。" : "公開の記録はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const a of audit) {
    const slugLink = el("a", { className: "slug detail", textContent: a.slug, title: "詳細を表示" });
    slugLink.addEventListener("click", () => openDetail(a.slug));

    body.append(
      el("tr", null, [
        el("td", { textContent: fmtDate(a.created_at) }),
        el("td", { textContent: AUDIT_ACTION_LABEL[a.action] || a.action }),
        el("td", null, [slugLink]),
        el("td", { className: "owner", textContent: a.owner_name || "（名前なし）" }),
        el("td", { className: "slug", textContent: a.ip || "-" }),
        el("td", { textContent: a.country || "-" }),
        el("td", { className: "report-text", textContent: a.user_agent || "-" }),
      ])
    );
  }

  table.style.display = "";
  renderPager("auditPager", page, total, loadAudit);
}

async function loadCorrections(page = pageState.corr) {
  const table = $("corrTable");
  const body = $("corrBody");
  const hint = $("corrHint");
  const count = $("corrCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("corrPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/corrections?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "巻の修正の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const corrections = data.corrections || [];
  const total = data.total ?? corrections.length;
  if (corrections.length === 0 && page > 1 && total > 0) {
    return loadCorrections(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.corr = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "ユーザ投稿による巻の修正はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const c of corrections) {
    const seriesName = c.series_name || "（不明なシリーズ）";
    const seriesLabel = c.series_creator ? `${seriesName}（${c.series_creator}）` : seriesName;

    // 確定=承認（公開維持・レビュー済みにしてキューから外す）、却下=誤投稿として削除。
    const approveBtn = el("button", { className: "ok", textContent: "確定" });
    approveBtn.addEventListener("click", () =>
      approveCorrection(c.series_id, c.isbn, seriesName, approveBtn)
    );
    const delBtn = el("button", { className: "danger", textContent: "却下" });
    delBtn.addEventListener("click", () => deleteCorrection(c.series_id, c.isbn, seriesName, delBtn));

    // シリーズ名クリックで、その series の巻一覧をモーダル表示（修正の妥当性を実物で確認）。
    const seriesLink = el("a", {
      className: "slug detail",
      textContent: seriesLabel,
      title: "このシリーズの巻一覧を表示",
    });
    seriesLink.addEventListener("click", () => openSeriesVolumes(c.series_id, seriesLabel));

    body.append(
      el("tr", { dataset: { key: `${c.series_id}/${c.isbn}` } }, [
        el("td", null, [coverThumb(c.cover_url, "corr-thumb", "corr-noimg", seriesName)]),
        el("td", { className: "owner", title: c.series_id }, [seriesLink]),
        el("td", { textContent: c.volume_number }),
        el("td", { textContent: c.isbn }),
        el("td", { className: "slug", textContent: c.series_id }),
        el("td", { textContent: fmtDate(c.created_at) }),
        el("td", { className: "report-actions" }, [approveBtn, delBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("corrPager", page, total, loadCorrections);
}

async function loadCoverSuggestions(page = pageState.coverSuggest) {
  const table = $("coverSuggestTable");
  const body = $("coverSuggestBody");
  const hint = $("coverSuggestHint");
  const count = $("coverSuggestCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("coverSuggestPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/cover-suggestions?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "表紙の修正の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const suggestions = data.suggestions || [];
  const total = data.total ?? suggestions.length;
  if (suggestions.length === 0 && page > 1 && total > 0) {
    return loadCoverSuggestions(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.coverSuggest = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "ユーザが選び直した表紙の提案はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const s of suggestions) {
    const label = s.creator ? `${s.title}（${s.creator}）` : s.title || "（不明な作品）";

    const approveBtn = el("button", { className: "ok", textContent: "承認" });
    approveBtn.addEventListener("click", () => approveCoverSuggestion(s.isbn, s.cover_url, approveBtn));
    const dismissBtn = el("button", { className: "danger", textContent: "却下" });
    dismissBtn.addEventListener("click", () => dismissCoverSuggestion(s.isbn, s.cover_url, dismissBtn));

    body.append(
      el("tr", { dataset: { key: `${s.isbn}/${s.cover_url}` } }, [
        el("td", null, [zoomableCover(s.old_cover_url, "現在の表紙")]),
        el("td", null, [zoomableCover(s.cover_url, "提案された表紙")]),
        el("td", { className: "owner", title: s.series_id || "" }, [seriesVolumesLink(s.series_id, label, label)]),
        el("td", null, [seriesVolumesLink(s.series_id, s.volume_number || "-", label)]),
        el("td", { textContent: s.isbn }),
        isbnConfirmCell(s.isbn),
        el("td", { className: "num", textContent: String(s.suggest_count) }),
        el("td", { textContent: fmtDate(s.last_at) }),
        el("td", { className: "report-actions" }, [approveBtn, dismissBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("coverSuggestPager", page, total, loadCoverSuggestions);
}

const COVER_RESOLUTION = { approved: "承認", superseded: "差し替え", dismissed: "却下" };

// 処理済み(承認/差し替え/却下)の表紙の修正の履歴（cover_suggestion.resolved_at > 0）。
async function loadResolvedCoverSuggestions(page = pageState.coverSuggestResolved) {
  const table = $("coverSuggestResolvedTable");
  const body = $("coverSuggestResolvedBody");
  const hint = $("coverSuggestResolvedHint");
  const count = $("coverSuggestCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("coverSuggestResolvedPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/cover-suggestions?resolved=1&page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "処理済みの取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const suggestions = data.suggestions || [];
  const total = data.total ?? suggestions.length;
  if (suggestions.length === 0 && page > 1 && total > 0) {
    return loadResolvedCoverSuggestions(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.coverSuggestResolved = page;
  count.textContent = `処理済み ${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "処理済みの表紙の修正はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const s of suggestions) {
    const label = s.creator ? `${s.title}（${s.creator}）` : s.title || "（不明な作品）";
    body.append(
      el("tr", { dataset: { key: `${s.isbn}/${s.cover_url}` } }, [
        el("td", null, [zoomableCover(s.cover_url, "提案された表紙")]),
        el("td", { className: "owner", title: s.series_id || "" }, [seriesVolumesLink(s.series_id, label, label)]),
        el("td", null, [seriesVolumesLink(s.series_id, s.volume_number || "-", label)]),
        el("td", { textContent: s.isbn }),
        el("td", { className: "num", textContent: String(s.suggest_count) }),
        el("td", { textContent: COVER_RESOLUTION[s.resolution] || s.resolution || "-" }),
        el("td", { textContent: fmtDate(s.resolved_at) }),
      ])
    );
  }

  table.style.display = "";
  renderPager("coverSuggestResolvedPager", page, total, loadResolvedCoverSuggestions);
}

async function approveCoverSuggestion(isbn, coverUrl, btn) {
  if (!(await uiConfirm(`この表紙を承認し、表紙キャッシュ（ISBN ${isbn}）を上書きします。同じ本を載せた全リスト・シリーズ閲覧に反映されます。よろしいですか？`, { okLabel: "承認する" }))) return;
  btn.disabled = true;
  btn.textContent = "承認中…";
  try {
    const res = await fetch(`/api/admin/cover-suggestions/${encodeURIComponent(isbn)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cover_url: coverUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadCoverSuggestions(pageState.coverSuggest);
  } catch (e) {
    uiAlert("承認に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "承認";
  }
}

async function dismissCoverSuggestion(isbn, coverUrl, btn) {
  if (!(await uiConfirm(`この表紙の提案（ISBN ${isbn}）を却下し削除します。表紙キャッシュは変更しません。よろしいですか？`, { danger: true, okLabel: "却下する" }))) return;
  btn.disabled = true;
  btn.textContent = "却下中…";
  try {
    const res = await fetch(`/api/admin/cover-suggestions/${encodeURIComponent(isbn)}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cover_url: coverUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadCoverSuggestions(pageState.coverSuggest);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "却下";
  }
}

async function loadVolumeReports(page = pageState.volReports) {
  const table = $("volReportTable");
  const body = $("volReportBody");
  const hint = $("volReportHint");
  const count = $("volReportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("volReportPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/volume-reports?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "巻の通報の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const reports = data.reports || [];
  const total = data.total ?? reports.length;
  if (reports.length === 0 && page > 1 && total > 0) {
    return loadVolumeReports(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.volReports = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "「間違っています」の通報はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const r of reports) {
    const seriesName = r.series_name || "（不明なシリーズ）";
    const seriesLabel = r.series_creator ? `${seriesName}（${r.series_creator}）` : seriesName;
    const originCell = r.is_correction
      ? el("td", { textContent: "ユーザ投稿" })
      : el("td", { className: "muted", textContent: "マスター/補完" });

    // 由来を問わず全行に「確定」を出す。確定すると volume_hidden に記録され、全閲覧者から
    // 非表示になる（ユーザ投稿なら元データも削除）。却下は通報だけ消して巻は残す。
    const actions = [];
    const confirmBtn = el("button", { className: "ok", textContent: "確定" });
    confirmBtn.addEventListener("click", () =>
      confirmVolumeReport(r.series_id, r.isbn, seriesName, confirmBtn)
    );
    actions.push(confirmBtn);
    const dismissBtn = el("button", { className: "danger", textContent: "却下" });
    dismissBtn.addEventListener("click", () =>
      dismissVolumeReport(r.series_id, r.isbn, dismissBtn)
    );
    actions.push(dismissBtn);

    // シリーズ名クリックで、その series の巻一覧をモーダル表示（通報の妥当性を実物で確認）。
    const seriesLink = el("a", {
      className: "slug detail",
      textContent: seriesLabel,
      title: "このシリーズの巻一覧を表示",
    });
    seriesLink.addEventListener("click", () => openSeriesVolumes(r.series_id, seriesLabel));

    // 通報件数を段階で強調: 1件=注意(warn)、3件以上=強め(hot)。放置の重さが一目で分かる。
    const countCls = "num" + (r.report_count >= 3 ? " hot" : r.report_count > 0 ? " warn" : "");
    // 最終通報日時に、初回からの経過（N日継続）を併記して単発か継続かを判断できるようにする。
    const spanDays = daysBetween(r.first_reported_at, r.last_reported_at);
    const dateCell = el("td", {
      textContent:
        fmtDate(r.last_reported_at) + (spanDays > 0 ? `（${spanDays}日継続）` : ""),
    });

    body.append(
      el("tr", { dataset: { vrkey: `${r.series_id}/${r.isbn}` } }, [
        el("td", null, [coverThumb(r.cover_url, "corr-thumb", "corr-noimg", seriesName)]),
        el("td", { className: "owner", title: r.series_id }, [seriesLink]),
        el("td", { textContent: r.volume_number || "-" }),
        el("td", { textContent: r.isbn }),
        isbnConfirmCell(r.isbn),
        originCell,
        el("td", { className: countCls, textContent: String(r.report_count) }),
        dateCell,
        el("td", { className: "report-actions" }, actions),
      ])
    );
  }

  table.style.display = "";
  renderPager("volReportPager", page, total, loadVolumeReports);
}

async function confirmVolumeReport(seriesId, isbn, seriesName, btn) {
  if (!(await uiConfirm(`「${seriesName}」のこの巻（ISBN ${isbn}）を確定し、全ての閲覧者から非表示にします。ユーザ投稿の巻の場合は元データも削除されます。よろしいですか？`, { danger: true, okLabel: "確定する" }))) return;
  btn.disabled = true;
  btn.textContent = "確定中…";
  try {
    const res = await fetch(
      `/api/admin/volume-reports/${encodeURIComponent(seriesId)}/${encodeURIComponent(isbn)}?confirm=1`,
      { method: "DELETE" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadVolumeReports(pageState.volReports);
  } catch (e) {
    uiAlert("確定に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "確定";
  }
}

async function dismissVolumeReport(seriesId, isbn, btn) {
  if (!(await uiConfirm("この通報を却下（削除）します。巻データはそのまま残ります。よろしいですか？", { okLabel: "却下する" }))) return;
  btn.disabled = true;
  btn.textContent = "却下中…";
  try {
    const res = await fetch(
      `/api/admin/volume-reports/${encodeURIComponent(seriesId)}/${encodeURIComponent(isbn)}`,
      { method: "DELETE" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadVolumeReports(pageState.volReports);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "却下";
  }
}

async function loadSeriesReports(page = pageState.seriesReports) {
  const table = $("seriesReportTable");
  const body = $("seriesReportBody");
  const hint = $("seriesReportHint");
  const count = $("seriesReportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("seriesReportPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/series-reports?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "シリーズ名の通報の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const reports = data.reports || [];
  const total = data.total ?? reports.length;
  if (reports.length === 0 && page > 1 && total > 0) {
    return loadSeriesReports(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.seriesReports = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "シリーズ名の通報はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const r of reports) {
    const overrideBtn = el("button", {
      className: "ok",
      textContent: r.override_name ? "名前を再修正" : "名前を修正",
    });
    overrideBtn.addEventListener("click", () =>
      overrideSeriesName(r, overrideBtn)
    );
    const dismissBtn = el("button", { className: "danger", textContent: "却下" });
    dismissBtn.addEventListener("click", () => dismissSeriesReport(r.series_id, dismissBtn));

    // C-id クリックでその巻一覧を表示（実物のタイトルを確認できる）。
    const cidLink = el("a", {
      className: "slug detail",
      textContent: r.series_id,
      title: "このシリーズの巻一覧を表示",
    });
    cidLink.addEventListener("click", () =>
      openSeriesVolumes(r.series_id, r.current_name || r.reported_name || r.series_id)
    );

    // 正しい名前のヒント: かな読みと収録巻タイトル。
    const hints = [r.name_kana, r.vol_title].filter(Boolean).join(" / ") || "-";

    // 現在名が既に上書き済みならその旨を添える。
    const currentText = r.override_name
      ? `${r.override_name}（修正済み）`
      : r.current_name || "-";

    const countCls = "num" + (r.report_count >= 3 ? " hot" : r.report_count > 0 ? " warn" : "");
    const spanDays = daysBetween(r.first_reported_at, r.last_reported_at);
    const dateCell = el("td", {
      textContent:
        fmtDate(r.last_reported_at) + (spanDays > 0 ? `（${spanDays}日継続）` : ""),
    });

    body.append(
      el("tr", { dataset: { srkey: r.series_id } }, [
        el("td", { className: "owner" }, [cidLink]),
        el("td", { textContent: r.reported_name || "-" }),
        el("td", { textContent: currentText }),
        el("td", { className: "muted", textContent: hints }),
        el("td", { className: countCls, textContent: String(r.report_count) }),
        dateCell,
        el("td", { className: "report-actions" }, [overrideBtn, dismissBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("seriesReportPager", page, total, loadSeriesReports);
}

async function overrideSeriesName(r, btn) {
  const suggested = r.override_name || r.name_kana || r.vol_title || "";
  const name = await uiPrompt(
    `シリーズ「${r.reported_name || r.series_id}」の正しい名前を入力してください。\n全ての閲覧者の検索/詳細表示に反映されます。`,
    suggested
  );
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    uiAlert("名前を入力してください");
    return;
  }
  btn.disabled = true;
  btn.textContent = "修正中…";
  try {
    const res = await fetch(`/api/admin/series-reports/${encodeURIComponent(r.series_id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadSeriesReports(pageState.seriesReports);
  } catch (e) {
    uiAlert("名前の修正に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "名前を修正";
  }
}

async function dismissSeriesReport(seriesId, btn) {
  if (!(await uiConfirm("この通報を却下（削除）します。シリーズ名は変更されません。よろしいですか？", { okLabel: "却下する" }))) return;
  btn.disabled = true;
  btn.textContent = "却下中…";
  try {
    const res = await fetch(`/api/admin/series-reports/${encodeURIComponent(seriesId)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadSeriesReports(pageState.seriesReports);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "却下";
  }
}

async function loadVolumeTitleReports(page = pageState.volTitleReports) {
  const table = $("volTitleReportTable");
  const body = $("volTitleReportBody");
  const hint = $("volTitleReportHint");
  const count = $("volTitleReportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("volTitleReportPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/volume-title-reports?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "本のタイトルの通報の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const reports = data.reports || [];
  const total = data.total ?? reports.length;
  if (reports.length === 0 && page > 1 && total > 0) {
    return loadVolumeTitleReports(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.volTitleReports = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "本のタイトルの通報はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const r of reports) {
    // 「揃える」: そのシリーズで最多の巻タイトルへ統一。common_title が無ければ押せない。
    const commonBtn = el("button", {
      className: "ok",
      textContent: "揃える",
      disabled: !r.common_title,
      title: r.common_title ? `「${r.common_title}」に揃えます` : "最多タイトルを特定できません",
    });
    commonBtn.addEventListener("click", () => applyCommonTitle(r, commonBtn));
    // 「修正」: 正しいタイトルを手入力して上書き。
    const overrideBtn = el("button", {
      textContent: r.override_title ? "再修正" : "修正",
    });
    overrideBtn.addEventListener("click", () => overrideVolumeTitle(r, overrideBtn));
    const dismissBtn = el("button", { className: "danger", textContent: "却下" });
    dismissBtn.addEventListener("click", () => dismissVolumeTitleReport(r.isbn, dismissBtn));

    const seriesName = r.series_name || "（不明なシリーズ）";
    const seriesCell = seriesVolumesLink(r.series_id, seriesName, seriesName);

    const currentText = r.override_title
      ? `${r.override_title}（修正済み）`
      : r.current_title || r.reported_title || "-";

    const countCls = "num" + (r.report_count >= 3 ? " hot" : r.report_count > 0 ? " warn" : "");
    const spanDays = daysBetween(r.first_reported_at, r.last_reported_at);
    const dateCell = el("td", {
      textContent:
        fmtDate(r.last_reported_at) + (spanDays > 0 ? `（${spanDays}日継続）` : ""),
    });

    body.append(
      el("tr", { dataset: { vtkey: r.isbn } }, [
        el("td", null, [coverThumb(r.cover_url, "corr-thumb", "corr-noimg", currentText)]),
        el("td", { textContent: r.isbn }),
        el("td", { textContent: currentText }),
        el("td", { className: "owner", title: r.series_id }, [seriesCell]),
        el("td", { className: "muted", textContent: r.common_title || "-" }),
        el("td", { className: countCls, textContent: String(r.report_count) }),
        dateCell,
        el("td", { className: "report-actions" }, [commonBtn, overrideBtn, dismissBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("volTitleReportPager", page, total, loadVolumeTitleReports);
}

async function applyCommonTitle(r, btn) {
  if (
    !(await uiConfirm(
      `この巻（ISBN ${r.isbn}）のタイトルを、シリーズで最多の「${r.common_title}」に揃えます。全ての閲覧者の表示に反映されます。よろしいですか？`,
      { okLabel: "揃える" }
    ))
  )
    return;
  btn.disabled = true;
  btn.textContent = "処理中…";
  try {
    const res = await fetch(
      `/api/admin/volume-title-reports/${encodeURIComponent(r.isbn)}/common`,
      { method: "POST" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadVolumeTitleReports(pageState.volTitleReports);
  } catch (e) {
    uiAlert("揃えるのに失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "揃える";
  }
}

async function overrideVolumeTitle(r, btn) {
  const suggested = r.override_title || r.common_title || r.current_title || "";
  const title = await uiPrompt(
    `この巻（ISBN ${r.isbn}）の正しいタイトルを入力してください。\n全ての閲覧者の巻一覧/詳細表示に反映されます。`,
    suggested
  );
  if (title === null) return;
  const trimmed = title.trim();
  if (!trimmed) {
    uiAlert("タイトルを入力してください");
    return;
  }
  btn.disabled = true;
  btn.textContent = "修正中…";
  try {
    const res = await fetch(`/api/admin/volume-title-reports/${encodeURIComponent(r.isbn)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadVolumeTitleReports(pageState.volTitleReports);
  } catch (e) {
    uiAlert("タイトルの修正に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "修正";
  }
}

async function dismissVolumeTitleReport(isbn, btn) {
  if (!(await uiConfirm("この通報を却下（削除）します。タイトルは変更されません。よろしいですか？", { okLabel: "却下する" }))) return;
  btn.disabled = true;
  btn.textContent = "却下中…";
  try {
    const res = await fetch(`/api/admin/volume-title-reports/${encodeURIComponent(isbn)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadVolumeTitleReports(pageState.volTitleReports);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "却下";
  }
}

// --- 確定済み（処理済み）履歴のビュー ----------------------------------------
// 各 moderation ページは通常「未処理キュー」だけを出す。確定するとキューから消えて
// 追跡できなくなるため、永続記録が残る 3 種（巻の通報→volume_hidden、巻の修正→
// reviewed_at、シリーズ名の通報→series_name_override）を後から振り返る読み取り専用の一覧。

// 確定して全体から非表示にした巻（volume_hidden）。
async function loadHiddenVolumes(page = pageState.volHidden) {
  const table = $("volHiddenTable");
  const body = $("volHiddenBody");
  const hint = $("volHiddenHint");
  const count = $("volReportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("volHiddenPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/volume-hidden?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "確定済みの取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const rows = data.hidden || [];
  const total = data.total ?? rows.length;
  if (rows.length === 0 && page > 1 && total > 0) {
    return loadHiddenVolumes(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.volHidden = page;
  count.textContent = `確定済み ${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "確定して全体から非表示にした巻はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const h of rows) {
    const seriesName = h.series_name || "（不明なシリーズ）";
    const seriesLabel = h.series_creator ? `${seriesName}（${h.series_creator}）` : seriesName;
    const seriesLink = el("a", {
      className: "slug detail",
      textContent: seriesLabel,
      title: "このシリーズの巻一覧を表示",
    });
    seriesLink.addEventListener("click", () => openSeriesVolumes(h.series_id, seriesLabel));

    body.append(
      el("tr", { dataset: { key: `${h.series_id}/${h.isbn}` } }, [
        el("td", null, [coverThumb(h.cover_url, "corr-thumb", "corr-noimg", seriesName)]),
        el("td", { className: "owner", title: h.series_id }, [seriesLink]),
        el("td", { textContent: h.volume_number || "-" }),
        el("td", { textContent: h.isbn }),
        el("td", { textContent: fmtDate(h.created_at) }),
      ])
    );
  }

  table.style.display = "";
  renderPager("volHiddenPager", page, total, loadHiddenVolumes);
}

// 確定(承認)済みの巻の修正（series_correction.reviewed_at > 0）。
async function loadReviewedCorrections(page = pageState.corrReviewed) {
  const table = $("corrReviewedTable");
  const body = $("corrReviewedBody");
  const hint = $("corrReviewedHint");
  const count = $("corrCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("corrReviewedPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/corrections?reviewed=1&page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "確定済みの取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const corrections = data.corrections || [];
  const total = data.total ?? corrections.length;
  if (corrections.length === 0 && page > 1 && total > 0) {
    return loadReviewedCorrections(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.corrReviewed = page;
  count.textContent = `確定済み ${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "確定(承認)した修正はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const c of corrections) {
    const seriesName = c.series_name || "（不明なシリーズ）";
    const seriesLabel = c.series_creator ? `${seriesName}（${c.series_creator}）` : seriesName;
    const seriesLink = el("a", {
      className: "slug detail",
      textContent: seriesLabel,
      title: "このシリーズの巻一覧を表示",
    });
    seriesLink.addEventListener("click", () => openSeriesVolumes(c.series_id, seriesLabel));

    body.append(
      el("tr", { dataset: { key: `${c.series_id}/${c.isbn}` } }, [
        el("td", null, [coverThumb(c.cover_url, "corr-thumb", "corr-noimg", seriesName)]),
        el("td", { className: "owner", title: c.series_id }, [seriesLink]),
        el("td", { textContent: c.volume_number }),
        el("td", { textContent: c.isbn }),
        el("td", { className: "slug", textContent: c.series_id }),
        el("td", { textContent: fmtDate(c.reviewed_at) }),
      ])
    );
  }

  table.style.display = "";
  renderPager("corrReviewedPager", page, total, loadReviewedCorrections);
}

// 名前修正で確定したシリーズ名の上書き（series_name_override）。
async function loadNameOverrides(page = pageState.nameOverrides) {
  const table = $("nameOverrideTable");
  const body = $("nameOverrideBody");
  const hint = $("nameOverrideHint");
  const count = $("seriesReportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("nameOverridePager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/series-overrides?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "確定済みの取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const overrides = data.overrides || [];
  const total = data.total ?? overrides.length;
  if (overrides.length === 0 && page > 1 && total > 0) {
    return loadNameOverrides(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.nameOverrides = page;
  count.textContent = `確定済み ${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "名前修正で確定した上書きはまだありません。";
    hint.style.display = "";
    return;
  }

  for (const o of overrides) {
    const nameLink = el("a", {
      className: "slug detail",
      textContent: o.name,
      title: "このシリーズの巻一覧を表示",
    });
    nameLink.addEventListener("click", () => openSeriesVolumes(o.series_id, o.name));

    body.append(
      el("tr", { dataset: { key: o.series_id } }, [
        el("td", { className: "slug", textContent: o.series_id }),
        el("td", { className: "owner" }, [nameLink]),
        el("td", { className: "muted", textContent: o.current_name || "-" }),
        el("td", { textContent: fmtDate(o.created_at) }),
      ])
    );
  }

  table.style.display = "";
  renderPager("nameOverridePager", page, total, loadNameOverrides);
}

// タイトル修正で確定した巻タイトル上書き（volume_title_override）。
async function loadTitleOverrides(page = pageState.titleOverrides) {
  const table = $("titleOverrideTable");
  const body = $("titleOverrideBody");
  const hint = $("titleOverrideHint");
  const count = $("volTitleReportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("titleOverridePager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/volume-title-overrides?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "確定済みの取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const overrides = data.overrides || [];
  const total = data.total ?? overrides.length;
  if (overrides.length === 0 && page > 1 && total > 0) {
    return loadTitleOverrides(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.titleOverrides = page;
  count.textContent = `確定済み ${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "タイトル修正で確定した上書きはまだありません。";
    hint.style.display = "";
    return;
  }

  for (const o of overrides) {
    const seriesName = o.series_name || "（不明なシリーズ）";
    body.append(
      el("tr", { dataset: { key: o.isbn } }, [
        el("td", null, [coverThumb(o.cover_url, "corr-thumb", "corr-noimg", o.title)]),
        el("td", { className: "slug", textContent: o.isbn }),
        el("td", { className: "owner", textContent: o.title }),
        el("td", { className: "muted", textContent: o.current_title || "-" }),
        el("td", { title: o.series_id }, [seriesVolumesLink(o.series_id, seriesName, seriesName)]),
        el("td", { textContent: fmtDate(o.created_at) }),
      ])
    );
  }

  table.style.display = "";
  renderPager("titleOverridePager", page, total, loadTitleOverrides);
}

// 未処理キュー ⇄ 確定済み履歴の切り替え。一度に片方だけを表示する。
const HISTORY = {
  volReports: {
    btn: "toggleVolHidden",
    pending: ["volReportTable", "volReportPager", "volReportHint"],
    history: ["volHiddenTable", "volHiddenPager", "volHiddenHint"],
    load: () => loadHiddenVolumes(1),
    reload: () => loadVolumeReports(pageState.volReports),
    onLabel: "確定して非表示にした巻を表示",
    offLabel: "未処理の通報に戻る",
    on: false,
  },
  seriesReports: {
    btn: "toggleNameOverrides",
    pending: ["seriesReportTable", "seriesReportPager", "seriesReportHint"],
    history: ["nameOverrideTable", "nameOverridePager", "nameOverrideHint"],
    load: () => loadNameOverrides(1),
    reload: () => loadSeriesReports(pageState.seriesReports),
    onLabel: "修正した名前を表示",
    offLabel: "未処理の通報に戻る",
    on: false,
  },
  volumeTitleReports: {
    btn: "toggleTitleOverrides",
    pending: ["volTitleReportTable", "volTitleReportPager", "volTitleReportHint"],
    history: ["titleOverrideTable", "titleOverridePager", "titleOverrideHint"],
    load: () => loadTitleOverrides(1),
    reload: () => loadVolumeTitleReports(pageState.volTitleReports),
    onLabel: "修正したタイトルを表示",
    offLabel: "未処理の通報に戻る",
    on: false,
  },
  corrections: {
    btn: "toggleCorrReviewed",
    pending: ["corrTable", "corrPager", "corrHint"],
    history: ["corrReviewedTable", "corrReviewedPager", "corrReviewedHint"],
    load: () => loadReviewedCorrections(1),
    reload: () => loadCorrections(pageState.corr),
    onLabel: "確定した修正を表示",
    offLabel: "未処理の修正に戻る",
    on: false,
  },
  reports: {
    btn: "toggleReportResolved",
    pending: ["reportTable", "reportPager", "reportHint"],
    history: ["reportResolvedTable", "reportResolvedPager", "reportResolvedHint"],
    load: () => loadResolvedReports(1),
    reload: () => loadReports(pageState.reports),
    onLabel: "処理済みを表示",
    offLabel: "未処理の通報に戻る",
    on: false,
  },
  coverSuggestions: {
    btn: "toggleCoverSuggestResolved",
    pending: ["coverSuggestTable", "coverSuggestPager", "coverSuggestHint"],
    history: ["coverSuggestResolvedTable", "coverSuggestResolvedPager", "coverSuggestResolvedHint"],
    load: () => loadResolvedCoverSuggestions(1),
    reload: () => loadCoverSuggestions(pageState.coverSuggest),
    onLabel: "処理済みを表示",
    offLabel: "未処理の修正に戻る",
    on: false,
  },
};

function toggleHistory(key) {
  const c = HISTORY[key];
  c.on = !c.on;
  const toHide = c.on ? c.pending : c.history;
  for (const id of toHide) {
    const e = $(id);
    if (e) e.style.display = "none";
  }
  $(c.btn).textContent = c.on ? c.offLabel : c.onLabel;
  (c.on ? c.load : c.reload)();
}

// ページ表示（タブ切替）時は未処理キューに戻す。履歴テーブルを畳んでボタン表記を初期化。
function resetHistory(key) {
  const c = HISTORY[key];
  if (!c) return;
  c.on = false;
  for (const id of c.history) {
    const e = $(id);
    if (e) e.style.display = "none";
  }
  $(c.btn).textContent = c.onLabel;
}

// series_id が引けた行はクリックで巻一覧モーダルを開くリンク、引けない行は素のテキストを返す。
function seriesVolumesLink(seriesId, text, label) {
  if (!seriesId) return el("span", { textContent: text });
  const link = el("a", {
    className: "slug detail",
    textContent: text,
    title: "このシリーズの巻一覧を表示",
  });
  link.addEventListener("click", () => openSeriesVolumes(seriesId, label || text));
  return link;
}

// シリーズの巻一覧をリスト詳細モーダルに流用して表示する。covers はキャッシュのみなので
// 未解決分は空のまま（管理用途では十分）。ユーザ投稿巻は「ユーザ投稿」フラグを併記する。
async function openSeriesVolumes(seriesId, label) {
  const modal = $("detailModal");
  const grid = $("detailGrid");
  const meta = $("detailMeta");
  const titleEl = $("detailTitle");
  grid.textContent = "";
  $("detailAudit").textContent = "";
  meta.textContent = "読み込み中…";
  titleEl.textContent = label || seriesId;
  modal.classList.add("open");

  let data;
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(seriesId)}/volumes`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    meta.textContent = "読み込みに失敗しました: " + e.message;
    return;
  }

  const vols = data.volumes || [];
  const creator = data.creator ? `（${data.creator}）` : "";
  titleEl.textContent = `${data.title || label || seriesId}${creator}`;
  meta.textContent = `${vols.length}巻 ｜ series_id: ${seriesId}`;

  if (vols.length === 0) {
    grid.append(el("p", { className: "hint", textContent: "巻が見つかりませんでした。" }));
    return;
  }

  for (const v of vols) {
    const body = [
      el("div", { className: "di-pos", textContent: v.volume_number || "-" }),
      el("div", { className: "di-title", textContent: v.title || "（タイトルなし）" }),
      el("div", { className: "di-author", textContent: v.isbn || "" }),
    ];
    if (v.correction) body.push(el("div", { className: "di-flags", textContent: "ユーザ投稿" }));
    grid.append(
      el("div", { className: "detail-item" }, [
        coverThumb(v.cover_url, "di-cover", "di-noimg", v.title),
        el("div", { className: "di-body" }, body),
      ])
    );
  }
}

async function approveCorrection(seriesId, isbn, seriesName, btn) {
  btn.disabled = true;
  btn.textContent = "確定中…";
  try {
    const res = await fetch(
      `/api/admin/corrections/${encodeURIComponent(seriesId)}/${encodeURIComponent(isbn)}/approve`,
      { method: "POST" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadCorrections(pageState.corr);
  } catch (e) {
    uiAlert("確定に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "確定";
  }
}

async function deleteCorrection(seriesId, isbn, seriesName, btn) {
  if (!(await uiConfirm(`「${seriesName}」の修正（ISBN ${isbn}）を却下し、完全に削除します。元に戻せません。よろしいですか？`, { danger: true, okLabel: "削除する" }))) return;
  btn.disabled = true;
  btn.textContent = "却下中…";
  try {
    const res = await fetch(`/api/admin/corrections/${encodeURIComponent(seriesId)}/${encodeURIComponent(isbn)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadCorrections(pageState.corr);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "却下";
  }
}

async function deleteList(slug, owner, btn) {
  if (!(await uiConfirm(`リスト「${owner}」(${slug}) を削除します。元に戻せません。よろしいですか？`, { danger: true, okLabel: "削除する" }))) return;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch(`/api/admin/lists/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadLists(pageState.lists);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "削除";
  }
}

const TARGET_LABEL = { owner_name: "ユーザー名", comment: "コメント", cover: "表紙画像" };

async function loadReports(page = pageState.reports) {
  const table = $("reportTable");
  const body = $("reportBody");
  const hint = $("reportHint");
  const count = $("reportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("reportPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/reports?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "通報の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const reports = data.reports || [];
  const total = data.total ?? reports.length;
  if (reports.length === 0 && page > 1 && total > 0) {
    return loadReports(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.reports = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "未対応の通報はありません。";
    hint.style.display = "";
    return;
  }

  for (const r of reports) {
    const targetLabel =
      r.target_type === "comment" || r.target_type === "cover"
        ? `${TARGET_LABEL[r.target_type]}（#${r.position}${r.item_title ? " " + r.item_title : ""}）`
        : TARGET_LABEL[r.target_type] || r.target_type;

    // 通報時と現在でテキストが変わっていれば注記（作成者が既に直したケース）。
    const changed = r.current_text !== r.reported_text;
    const isCover = r.target_type === "cover";
    const reportedCell = reportValueCell(r.reported_text, "report-text", isCover);
    const currentCell = r.list_exists
      ? reportValueCell(r.current_text || "（空）", "report-text" + (changed ? " warn" : ""), isCover)
      : el("td", { className: "report-text warn", textContent: "（リスト削除済み）" });

    const slugLink = el("a", { className: "slug detail", textContent: r.slug, title: "詳細を表示" });
    slugLink.addEventListener("click", () => openDetail(r.slug));

    const redactBtn = el("button", {
      className: "danger",
      textContent: r.target_type === "cover" ? "画像を削除" : "文字を削除",
    });
    redactBtn.addEventListener("click", () => redactReport(r.id, targetLabel, redactBtn));
    const dismissBtn = el("button", { textContent: "却下" });
    dismissBtn.addEventListener("click", () => dismissReport(r.id, dismissBtn));

    if (!r.list_exists || !r.current_text) redactBtn.disabled = true;

    body.append(
      el("tr", { dataset: { rid: String(r.id) } }, [
        el("td", { textContent: targetLabel }),
        reportedCell,
        currentCell,
        el("td", { className: "num", textContent: String(r.report_count) }),
        el("td", { textContent: fmtDate(r.last_at) }),
        el("td", null, [slugLink]),
        el("td", { className: "report-actions" }, [redactBtn, dismissBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("reportPager", page, total, loadReports);
}

const REPORT_RESOLUTION = { dismissed: "却下", redacted: "伏字" };

// 処理済み(却下/伏字)の通報の履歴（reports.resolved_at > 0）。
async function loadResolvedReports(page = pageState.reportResolved) {
  const table = $("reportResolvedTable");
  const body = $("reportResolvedBody");
  const hint = $("reportResolvedHint");
  const count = $("reportCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("reportResolvedPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/reports?resolved=1&page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "処理済みの取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const reports = data.reports || [];
  const total = data.total ?? reports.length;
  if (reports.length === 0 && page > 1 && total > 0) {
    return loadResolvedReports(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.reportResolved = page;
  count.textContent = `処理済み ${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "処理済みの通報はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const r of reports) {
    const targetLabel =
      r.target_type === "comment" || r.target_type === "cover"
        ? `${TARGET_LABEL[r.target_type]}（#${r.position}${r.item_title ? " " + r.item_title : ""}）`
        : TARGET_LABEL[r.target_type] || r.target_type;
    const isCover = r.target_type === "cover";
    const slugLink = el("a", { className: "slug detail", textContent: r.slug, title: "詳細を表示" });
    slugLink.addEventListener("click", () => openDetail(r.slug));

    body.append(
      el("tr", { dataset: { rid: String(r.id) } }, [
        el("td", { textContent: targetLabel }),
        reportValueCell(r.reported_text, "report-text", isCover),
        el("td", { className: "num", textContent: String(r.report_count) }),
        el("td", { textContent: REPORT_RESOLUTION[r.resolution] || r.resolution || "-" }),
        el("td", { textContent: fmtDate(r.resolved_at) }),
        el("td", null, [slugLink]),
      ])
    );
  }

  table.style.display = "";
  renderPager("reportResolvedPager", page, total, loadResolvedReports);
}

async function redactReport(id, targetLabel, btn) {
  if (!(await uiConfirm(`${targetLabel}のテキストを削除します（リスト・作品自体は残ります）。よろしいですか？`, { danger: true, okLabel: "削除する" }))) return;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch(`/api/admin/reports/${id}/redact`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadReports(pageState.reports);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "文字を削除";
  }
}

async function dismissReport(id, btn) {
  if (!(await uiConfirm("この通報を却下（削除）します。テキストはそのままです。よろしいですか？", { okLabel: "却下する" }))) return;
  btn.disabled = true;
  btn.textContent = "却下中…";
  try {
    const res = await fetch(`/api/admin/reports/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadReports(pageState.reports);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "却下";
  }
}

async function loadCoverSummary() {
  const out = $("coverSummary");
  try {
    const res = await fetch("/api/admin/covers/summary");
    const s = (await res.json()).summary || {};
    out.textContent = `全${(s.total ?? 0).toLocaleString("ja-JP")}件（書影あり ${(s.with_cover ?? 0).toLocaleString("ja-JP")} / No Image ${(s.empty ?? 0).toLocaleString("ja-JP")}）`;
  } catch {
    out.textContent = "取得失敗";
  }
}

async function loadCoverR2Summary() {
  const out = $("coverR2Summary");
  if (!out) return;
  try {
    const res = await fetch("/api/admin/covers/r2/summary");
    const r2 = (await res.json()).r2 || {};
    if (!r2.bound) {
      out.textContent = "R2 未設定";
      return;
    }
    const mb = (r2.bytes || 0) / (1024 * 1024);
    out.textContent = `${(r2.count ?? 0).toLocaleString("ja-JP")} 件（${mb.toFixed(1)} MB）`;
  } catch {
    out.textContent = "取得失敗";
  }
}

async function purgeCoverR2(btn) {
  if (
    !(await uiConfirm(
      "R2 のトリム済み表紙画像を全削除します。D1 の表紙キャッシュは残り、次回アクセス時に同じ元画像から再トリムされます。よろしいですか？",
      { danger: true, okLabel: "削除する" }
    ))
  )
    return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch("/api/admin/covers/r2/purge", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiAlert(`R2 のトリム画像を ${(data.r2Covers ?? 0).toLocaleString("ja-JP")} 件削除しました。`);
    await loadCoverR2Summary();
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function purgeCovers(mode, btn) {
  const label =
    mode === "all"
      ? "表紙キャッシュを全削除します。R2 のトリム済み画像も消え、全ての本が次回アクセス時に再探索・再トリムされます。よろしいですか？"
      : "No Image のキャッシュを削除します。該当の本は次回アクセス時に再探索されます。よろしいですか？";
  if (!(await uiConfirm(label, { danger: true, okLabel: "削除する" }))) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch("/api/admin/covers/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const r2 = data.r2Covers ? `（トリム済み画像 R2 ${data.r2Covers} 件も削除）` : "";
    uiAlert(`${data.deleted} 件削除しました。${r2}`);
    await loadCoverSummary();
    await loadCoverR2Summary();
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function deleteCover(btn) {
  const input = $("coverIsbn");
  const isbn = input.value.replace(/[^0-9Xx]/g, "");
  if (!isbn) {
    uiAlert("ISBN を入力してください。");
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "削除中…";
  try {
    const res = await fetch(`/api/admin/covers/${encodeURIComponent(isbn)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiAlert(`ISBN ${isbn} のキャッシュを削除しました。`);
    input.value = "";
    await loadCoverSummary();
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function loadSupSummary() {
  const out = $("supSummary");
  try {
    const res = await fetch("/api/admin/supplements/summary");
    const s = (await res.json()).summary || {};
    out.textContent = `全${(s.total ?? 0).toLocaleString("ja-JP")}件（補完あり ${(s.with_vols ?? 0).toLocaleString("ja-JP")} / 該当なし ${(s.empty ?? 0).toLocaleString("ja-JP")}）`;
  } catch {
    out.textContent = "取得失敗";
  }
}

async function purgeSupplements(mode, btn) {
  const label =
    mode === "all"
      ? "補完キャッシュを全削除します。全シリーズが次回アクセス時にライブMADBを引き直します。よろしいですか？"
      : "「該当なし」の補完キャッシュを削除します。該当シリーズは次回アクセス時に引き直します。よろしいですか？";
  if (!(await uiConfirm(label, { danger: true, okLabel: "削除する" }))) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch("/api/admin/supplements/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiAlert(`${data.deleted} 件削除しました。`);
    await loadSupSummary();
    await loadSupplements(1);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

const SUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let supCache = [];

async function loadSupplements(page = pageState.sup) {
  const table = $("supTable");
  const body = $("supBody");
  const hint = $("supHint");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("supPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/supplements?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "補完キャッシュ一覧の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const supplements = data.supplements || [];
  const total = data.total ?? supplements.length;
  if (supplements.length === 0 && page > 1 && total > 0) {
    return loadSupplements(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.sup = page;
  // 詳細モーダル用に現在ページ分だけキャッシュ（series_id で引く）。
  supCache = supplements;

  if (total === 0) {
    hint.textContent = "補完キャッシュはまだありません。";
    hint.style.display = "";
    return;
  }

  const now = Date.now();
  for (const sp of supplements) {
    const seriesName = sp.series_name || "（不明なシリーズ）";
    const seriesLabel = sp.series_creator ? `${seriesName}（${sp.series_creator}）` : seriesName;
    const expired = now > sp.checked_at + SUP_TTL_MS;
    const empty = sp.vol_count === 0;

    const countCell = empty
      ? el("td", { className: "num muted", textContent: "0（該当なし）" })
      : el("td", { className: "num", textContent: String(sp.vol_count) });

    const stateCell = el("td", {
      className: expired ? "warn" : "",
      textContent: expired ? "期限切れ" : "有効",
    });

    const detailBtn = el("button", { textContent: "詳細", title: "補完巻を表示" });
    if (empty) detailBtn.disabled = true;
    else detailBtn.addEventListener("click", () => openSupDetail(sp.series_id));

    const delBtn = el("button", { className: "danger", textContent: "削除" });
    delBtn.addEventListener("click", () => deleteSupplementRow(sp.series_id, seriesName, delBtn));

    body.append(
      el("tr", { dataset: { sid: sp.series_id } }, [
        el("td", { className: "owner", textContent: seriesLabel }),
        el("td", { className: "slug", textContent: sp.series_id }),
        countCell,
        el("td", { textContent: fmtDate(sp.checked_at) }),
        stateCell,
        el("td", null, [detailBtn]),
        el("td", null, [delBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("supPager", page, total, loadSupplements);
}

function openSupDetail(seriesId) {
  const sp = supCache.find((s) => s.series_id === seriesId);
  if (!sp) return;
  const modal = $("detailModal");
  const grid = $("detailGrid");
  const meta = $("detailMeta");
  const titleEl = $("detailTitle");
  grid.textContent = "";
  $("detailAudit").textContent = "";

  const seriesName = sp.series_name || "（不明なシリーズ）";
  titleEl.textContent = `${seriesName} — ${sp.series_id}`;
  meta.textContent = `${sp.vol_count}巻を補完キャッシュ ｜ 最終確認 ${fmtDate(sp.checked_at)}`;

  const vols = (sp.volumes || [])
    .slice()
    .sort((a, b) => (a.vol_sort ?? 0) - (b.vol_sort ?? 0));
  for (const v of vols) {
    grid.append(
      el("div", { className: "detail-item" }, [
        el("div", { className: "di-noimg", textContent: v.volume_number || "-" }),
        el("div", { className: "di-body" }, [
          el("div", { className: "di-title", textContent: v.title || "（タイトルなし）" }),
          el("div", { className: "di-author", textContent: v.author || "" }),
          v.pubdate ? el("div", { className: "di-pos", textContent: v.pubdate }) : "",
          el("div", { className: "di-pos", textContent: v.isbn || "" }),
        ].filter(Boolean)),
      ])
    );
  }
  modal.classList.add("open");
}

// 一覧の行から削除。入力欄版は deleteSupplement。
async function deleteSupplementRow(seriesId, seriesName, btn) {
  if (!(await uiConfirm(`「${seriesName}」(${seriesId}) の補完キャッシュを削除します。次回アクセス時に再取得します。よろしいですか？`, { danger: true, okLabel: "削除する" }))) return;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch(`/api/admin/supplements/${encodeURIComponent(seriesId)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadSupSummary();
    await loadSupplements(pageState.sup);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "削除";
  }
}

async function deleteSupplement(btn) {
  const input = $("supSeriesId");
  const seriesId = input.value.trim();
  if (!seriesId) {
    uiAlert("series_id を入力してください。");
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "削除中…";
  try {
    const res = await fetch(`/api/admin/supplements/${encodeURIComponent(seriesId)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiAlert(`series_id ${seriesId} の補完キャッシュを削除しました。`);
    input.value = "";
    await loadSupSummary();
    await loadSupplements(pageState.sup);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function loadBookMetaSummary() {
  const out = $("bookMetaSummary");
  try {
    const res = await fetch("/api/admin/book-meta/summary");
    const s = (await res.json()).summary || {};
    out.textContent = `全${(s.total ?? 0).toLocaleString("ja-JP")}件（あらすじあり ${(s.with_caption ?? 0).toLocaleString("ja-JP")} / あらすじ無し ${(s.empty ?? 0).toLocaleString("ja-JP")}）`;
  } catch {
    out.textContent = "取得失敗";
  }
}

async function purgeBookMeta(mode, btn) {
  const label =
    mode === "all"
      ? "楽天データキャッシュを全削除します。全ての本が次回ポップアップ表示時に楽天を引き直します。よろしいですか？"
      : "「あらすじ無し」の楽天データキャッシュを削除します。該当の本は次回ポップアップ表示時に引き直します。よろしいですか？";
  if (!(await uiConfirm(label, { danger: true, okLabel: "削除する" }))) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch("/api/admin/book-meta/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiAlert(`${data.deleted} 件削除しました。`);
    await loadBookMetaSummary();
    await loadBookMeta(1);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

let bookMetaCache = [];
let bookMetaQuery = "";

async function loadBookMeta(page = pageState.bookMeta) {
  const table = $("bookMetaTable");
  const body = $("bookMetaBody");
  const hint = $("bookMetaHint");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("bookMetaPager").style.display = "none";
  $("bookMetaClear").style.display = bookMetaQuery ? "" : "none";

  let data;
  try {
    const qs = bookMetaQuery ? `&q=${encodeURIComponent(bookMetaQuery)}` : "";
    const res = await fetch(`/api/admin/book-meta?page=${page}&per=${PER}${qs}`);
    data = await res.json();
  } catch {
    hint.textContent = "楽天データ一覧の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const books = data.books || [];
  const total = data.total ?? books.length;
  if (books.length === 0 && page > 1 && total > 0) {
    return loadBookMeta(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.bookMeta = page;
  bookMetaCache = books;

  if (total === 0) {
    hint.textContent = bookMetaQuery
      ? `「${bookMetaQuery}」に一致する楽天データはありません。`
      : "楽天データキャッシュはまだありません。";
    hint.style.display = "";
    return;
  }

  for (const b of books) {
    const titleText = b.title || "（マスター未登録）";
    const titleCell = b.series_id
      ? seriesVolumesLink(b.series_id, titleText, titleText)
      : el("span", { textContent: titleText });

    const captionCell = el("td", { className: "book-meta-caption" });
    if (b.caption) {
      const link = el("button", {
        className: "linkish",
        textContent: "あり",
        title: "クリックで全文を表示",
      });
      link.addEventListener("click", () => openBookMetaDetail(b.isbn));
      captionCell.append(link);
    } else {
      captionCell.classList.add("muted");
      captionCell.textContent = "なし";
    }

    const delBtn = el("button", { className: "danger", textContent: "削除" });
    delBtn.addEventListener("click", () => deleteBookMetaRow(b.isbn, delBtn));

    body.append(
      el("tr", { dataset: { isbn: b.isbn } }, [
        el("td", null, [zoomableCover(b.cover_url, titleText)]),
        el("td", { className: "book-title" }, [titleCell]),
        el("td", { className: "book-authors", textContent: b.authors.join("、") }),
        el("td", { className: "book-publisher", textContent: b.publisher || "-" }),
        el("td", { textContent: b.pubdate || "-" }),
        captionCell,
        isbnConfirmCell(b.isbn),
        el("td", { textContent: fmtDate(b.checked_at) }),
        el("td", null, [delBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("bookMetaPager", page, total, loadBookMeta);
}

function openBookMetaDetail(isbn) {
  const b = bookMetaCache.find((x) => x.isbn === isbn);
  if (!b) return;
  const modal = $("detailModal");
  const grid = $("detailGrid");
  const meta = $("detailMeta");
  const titleEl = $("detailTitle");
  grid.textContent = "";
  $("detailAudit").textContent = "";

  const titleText = b.title || "（マスター未登録）";
  titleEl.textContent = `${titleText} — ${b.isbn}`;
  const bits = [b.authors.join("、"), b.publisher, b.pubdate].filter(Boolean);
  meta.textContent = `${bits.join(" ｜ ")} ｜ 最終確認 ${fmtDate(b.checked_at)}`;

  grid.append(
    el("div", { className: "book-meta-full", textContent: b.caption || "（あらすじなし）" })
  );
  modal.classList.add("open");
}

// 一覧の行から削除。入力欄版は deleteBookMeta。
async function deleteBookMetaRow(isbn, btn) {
  if (!(await uiConfirm(`ISBN ${isbn} の楽天データキャッシュを削除します。次回ポップアップ表示時に再取得します。よろしいですか？`, { danger: true, okLabel: "削除する" }))) return;
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await fetch(`/api/admin/book-meta/${encodeURIComponent(isbn)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadBookMetaSummary();
    await loadBookMeta(pageState.bookMeta);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "削除";
  }
}

async function deleteBookMeta(btn) {
  const input = $("delBookMetaIsbn");
  const isbn = input.value.replace(/[^0-9Xx]/g, "");
  if (!isbn) {
    uiAlert("ISBN を入力してください。");
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "削除中…";
  try {
    const res = await fetch(`/api/admin/book-meta/${encodeURIComponent(isbn)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiAlert(`ISBN ${isbn} の楽天データキャッシュを削除しました。`);
    input.value = "";
    await loadBookMetaSummary();
    await loadBookMeta(pageState.bookMeta);
  } catch (e) {
    uiAlert("削除に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// --- 開発ツール（ローカル dev 限定: ADMIN_DEV_BYPASS）------------------------
// マスターデータ以外を全削除して DB を初期化する破壊的操作。本番では /api/admin/stats の
// dev=false でナビ自体を隠し、サーバ側でも 403 で fail-closed する。
let devEnabled = false;

async function initDevTools() {
  try {
    const res = await fetch("/api/admin/stats");
    const data = await res.json();
    devEnabled = !!data.dev;
  } catch {
    devEnabled = false;
  }
  $("navDevTools").hidden = !devEnabled;
  // dev 無効環境で #dev-tools に直接来ていたら概要へ戻す。
  if (!devEnabled && currentPageName() === "dev-tools") location.hash = "#dashboard";
}

async function devReset(btn) {
  if (
    !(await uiConfirm(
      "マスターデータ（シリーズ・巻・メタ情報）以外の全テーブルを削除し、DB を開発用に初期化します。公開リスト・各種キャッシュ・通報・監査ログ、R2 のトリム済み表紙画像が全て消えます。元に戻せません。よろしいですか？",
      { danger: true, okLabel: "次へ" }
    ))
  )
    return;
  const typed = await uiPrompt("確認のため RESET と入力してください。", "", {
    okLabel: "初期化する",
    placeholder: "RESET",
    danger: true,
  });
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== "RESET") {
    uiAlert("入力が一致しませんでした。初期化を中止しました。");
    return;
  }
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "初期化中…";
  try {
    const res = await fetch("/api/admin/dev/reset", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const total = Object.values(data.deleted || {}).reduce((a, b) => a + b, 0);
    const r2 = data.r2Covers ? `＋トリム済み画像 R2 ${data.r2Covers.toLocaleString("ja-JP")} 件` : "";
    uiAlert(`DB を初期化しました（${total.toLocaleString("ja-JP")} 行削除${r2}）。`);
  } catch (e) {
    uiAlert("初期化に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// --- ハッシュルーティング（各セクションを個別ページに分割）------------------
// ページ切替時にそのページのデータだけをロードする。ページャーで大量データでも破綻しない。
const PAGES = {
  dashboard: () => loadStats(),
  reports: () => {
    resetHistory("reports");
    loadReports(1);
  },
  lists: () => loadLists(1),
  audit: () => loadAudit(1),
  "volume-reports": () => {
    resetHistory("volReports");
    loadVolumeReports(1);
  },
  "series-reports": () => {
    resetHistory("seriesReports");
    loadSeriesReports(1);
  },
  "volume-title-reports": () => {
    resetHistory("volumeTitleReports");
    loadVolumeTitleReports(1);
  },
  corrections: () => {
    resetHistory("corrections");
    loadCorrections(1);
  },
  "cover-suggestions": () => {
    resetHistory("coverSuggestions");
    loadCoverSuggestions(1);
  },
  covers: () => {
    loadCoverSummary();
    loadCoverR2Summary();
  },
  supplements: () => {
    loadSupSummary();
    loadSupplements(1);
  },
  "book-meta": () => {
    bookMetaQuery = "";
    $("bookMetaQuery").value = "";
    loadBookMetaSummary();
    loadBookMeta(1);
  },
  "dev-tools": () => {},
};

function currentPageName() {
  const h = (location.hash || "").replace(/^#/, "");
  return Object.prototype.hasOwnProperty.call(PAGES, h) ? h : "dashboard";
}

function showPage(name) {
  for (const key of Object.keys(PAGES)) {
    const sec = $(`page-${key}`);
    if (sec) sec.hidden = key !== name;
  }
  document.querySelectorAll("#adminNav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === name);
  });
  PAGES[name]();
}

function closeDetail() {
  $("detailModal").classList.remove("open");
}

// 再読み込みボタンは現在ページを保ったまま取り直す。
$("reload").addEventListener("click", () => loadLists(pageState.lists));
$("reloadReport").addEventListener("click", () =>
  HISTORY.reports.on ? loadResolvedReports(pageState.reportResolved) : loadReports(pageState.reports)
);
$("reloadAudit").addEventListener("click", () => loadAudit(1));
$("auditSlug").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadAudit(1);
});
$("reloadVolReport").addEventListener("click", () =>
  HISTORY.volReports.on ? loadHiddenVolumes(pageState.volHidden) : loadVolumeReports(pageState.volReports)
);
$("reloadSeriesReport").addEventListener("click", () =>
  HISTORY.seriesReports.on ? loadNameOverrides(pageState.nameOverrides) : loadSeriesReports(pageState.seriesReports)
);
$("reloadVolTitleReport").addEventListener("click", () =>
  HISTORY.volumeTitleReports.on ? loadTitleOverrides(pageState.titleOverrides) : loadVolumeTitleReports(pageState.volTitleReports)
);
$("reloadCorr").addEventListener("click", () =>
  HISTORY.corrections.on ? loadReviewedCorrections(pageState.corrReviewed) : loadCorrections(pageState.corr)
);
$("toggleVolHidden").addEventListener("click", () => toggleHistory("volReports"));
$("toggleNameOverrides").addEventListener("click", () => toggleHistory("seriesReports"));
$("toggleTitleOverrides").addEventListener("click", () => toggleHistory("volumeTitleReports"));
$("toggleCorrReviewed").addEventListener("click", () => toggleHistory("corrections"));
$("toggleReportResolved").addEventListener("click", () => toggleHistory("reports"));
$("toggleCoverSuggestResolved").addEventListener("click", () => toggleHistory("coverSuggestions"));
$("reloadCoverSuggest").addEventListener("click", () =>
  HISTORY.coverSuggestions.on
    ? loadResolvedCoverSuggestions(pageState.coverSuggestResolved)
    : loadCoverSuggestions(pageState.coverSuggest)
);
$("reloadCover").addEventListener("click", loadCoverSummary);
$("reloadCoverR2").addEventListener("click", loadCoverR2Summary);
$("purgeCoverR2").addEventListener("click", (e) => purgeCoverR2(e.currentTarget));
$("purgeEmpty").addEventListener("click", (e) => purgeCovers("empty", e.currentTarget));
$("purgeAll").addEventListener("click", (e) => purgeCovers("all", e.currentTarget));
$("delCover").addEventListener("click", (e) => deleteCover(e.currentTarget));
$("reloadSup").addEventListener("click", () => {
  loadSupSummary();
  loadSupplements(pageState.sup);
});
$("purgeSupEmpty").addEventListener("click", (e) => purgeSupplements("empty", e.currentTarget));
$("purgeSupAll").addEventListener("click", (e) => purgeSupplements("all", e.currentTarget));
$("delSup").addEventListener("click", (e) => deleteSupplement(e.currentTarget));
$("reloadBookMeta").addEventListener("click", () => {
  loadBookMetaSummary();
  loadBookMeta(pageState.bookMeta);
});
function runBookMetaSearch() {
  bookMetaQuery = $("bookMetaQuery").value.trim();
  loadBookMeta(1);
}
$("bookMetaSearch").addEventListener("click", runBookMetaSearch);
$("bookMetaQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runBookMetaSearch();
});
$("bookMetaClear").addEventListener("click", () => {
  bookMetaQuery = "";
  $("bookMetaQuery").value = "";
  loadBookMeta(1);
});
$("purgeBookMetaEmpty").addEventListener("click", (e) => purgeBookMeta("empty", e.currentTarget));
$("purgeBookMetaAll").addEventListener("click", (e) => purgeBookMeta("all", e.currentTarget));
$("delBookMeta").addEventListener("click", (e) => deleteBookMeta(e.currentTarget));
$("detailClose").addEventListener("click", closeDetail);
$("detailModal").addEventListener("click", (e) => {
  if (e.target === $("detailModal")) closeDetail();
});
$("coverZoom").addEventListener("click", closeCoverZoom);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeCoverZoom();
    closeDetail();
  }
});

$("devResetBtn").addEventListener("click", (e) => devReset(e.currentTarget));

window.addEventListener("hashchange", () => showPage(currentPageName()));

initDevTools();
showPage(currentPageName());

// デプロイ更新の検知: 自分が読み込んだ版（<meta app-version>）とサーバ現行版（/api/version）が
// 食い違ったら再読み込みを促すバナーを出す。開きっぱなしのタブが古い admin.js を使い続ける対策。
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
