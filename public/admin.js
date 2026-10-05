"use strict";

const $ = (id) => document.getElementById(id);

// 承認・却下などの更新系リクエスト（GET 以外）が成功したら上部「やること」の件数を取り直す。
// 更新処理は各所で fetch を直に呼んでいるので、ここで一括して拾う。連続操作は 300ms にまとめる。
let todoTimer = 0;
const fetch = async (input, init) => {
  const res = await window.fetch(input, init);
  const method = ((init && init.method) || "GET").toUpperCase();
  if (method !== "GET" && res.ok) {
    clearTimeout(todoTimer);
    todoTimer = setTimeout(loadTodo, 300);
  }
  return res;
};

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
  mfix: 1,
  coverSuggest: 1,
  sup: 1,
  bookMeta: 1,
  volHidden: 1,
  corrReviewed: 1,
  nameOverrides: 1,
  merge: 1,
  seriesTag: 1,
  volTitleReports: 1,
  titleOverrides: 1,
  reportResolved: 1,
  coverSuggestResolved: 1,
};

const STAT_LABELS = [
  ["lists", "公開リスト"],
  ["reports", "通報"],
  ["volume_reports", "巻の通報"],
  ["series_reports", "シリーズ名の修正"],
  ["series", "シリーズ"],
  ["volumes", "巻(ISBN)"],
  ["covers", "表紙キャッシュ"],
  ["corrections", "シリーズへの手動追加"],
  ["cover_suggestions", "表紙の修正"],
];

// 上部「やること」に出す未処理キュー。[API のキー, 表示名, 遷移先ページ, 結合ページの表示切替]
const TODO_ITEMS = [
  ["reports", "通報", "reports"],
  ["volume_reports", "巻の通報", "volume-reports"],
  ["series_reports", "シリーズ名の修正", "series-reports"],
  ["merge_requests", "シリーズの結合依頼", "series-merges", "requests"],
  ["split_requests", "シリーズの分離依頼", "series-merges", "splitRequests"],
  ["volume_title_reports", "本のタイトルの修正", "volume-title-reports"],
  ["corrections", "シリーズへの手動追加", "corrections"],
  ["cover_suggestions", "表紙の修正", "cover-suggestions"],
  ["series_tag_requests", "シリーズのタグの申請", "series-tags"],
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

// スマホでは .admin-table を 1 行 = 1 カードで縦に並べ、各セルの前に列名を出す（styles.css の
// max-width:640px）。列名は thead の th から td の data-label に写す。表は各所で描き直されるので、
// 描画コードを個別に直さず DOM の追加を拾って一括で付ける。
function labelAdminTables() {
  for (const table of document.querySelectorAll(".admin-table")) {
    const heads = [];
    for (const th of table.querySelectorAll("thead th")) {
      for (let i = 0; i < (th.colSpan || 1); i++) heads.push(th.textContent.trim());
    }
    if (!heads.length) continue;
    for (const tr of table.querySelectorAll("tbody tr")) {
      let col = 0;
      for (const td of tr.children) {
        if (!td.hasAttribute("data-label")) td.setAttribute("data-label", heads[col] || "");
        col += td.colSpan || 1;
      }
    }
  }
}
let labelQueued = false;
new MutationObserver(() => {
  if (labelQueued) return;
  labelQueued = true;
  requestAnimationFrame(() => {
    labelQueued = false;
    labelAdminTables();
  });
}).observe(document.body, { childList: true, subtree: true });

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

// 未処理が 1 件以上あるキューだけをリンクで並べる。押すと該当ページ（の未処理表示）へ飛ぶ。
// 表示中ページのリンクを押したときは hashchange が起きないので直接 showPage で開き直す。
let todoSeq = 0;
async function loadTodo() {
  const bar = $("todoBar");
  const seq = ++todoSeq;
  let todo;
  try {
    const res = await fetch("/api/admin/todo");
    if (!res.ok) return;
    todo = (await res.json()).todo || {};
  } catch {
    return;
  }
  if (seq !== todoSeq) return;
  bar.textContent = "";
  const items = TODO_ITEMS.filter(([key]) => (todo[key] ?? 0) > 0);
  bar.append(el("strong", { className: "admin-todo-title", textContent: "やること" }));
  if (!items.length) {
    bar.append(el("span", { className: "admin-todo-empty", textContent: "未処理はありません" }));
  }
  for (const [key, label, page, mode] of items) {
    const a = el("a", { href: `#${page}` }, [
      el("span", { textContent: label }),
      el("span", { className: "admin-todo-n", textContent: todo[key].toLocaleString("ja-JP") }),
    ]);
    a.addEventListener("click", (e) => {
      if (mode) mergeMode = mode;
      if (currentPageName() === page) {
        e.preventDefault();
        showPage(page);
      }
    });
    bar.append(a);
  }
  bar.hidden = false;
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
        // 限定公開リストは noindex・紹介対象外。おすすめに拾わないよう目印を付ける。
        el("td", null, it.unlisted
          ? [detailLink, el("span", { className: "muted", textContent: " 限定公開", title: "noindex・運営からの紹介対象外" })]
          : [detailLink]),
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

// レーベルに付いた運営のタグ（"廉価版" / "文庫版" / "傑作選"。src/labels.ts）の印。公開側の
// カード（public/app.js labelTagBadge）と同じ見た目・同じ class を使う。タグが無ければ null。
function labelTagBadge(tag) {
  if (!tag) return null;
  return el("span", { className: "label-tag", textContent: tag, title: "レーベルから判定した版（レーベル管理で設定）" });
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
    document.createTextNode(list.unlisted ? "限定公開（noindex・紹介対象外） ｜ " : "みんなに公開 ｜ "),
    document.createTextNode(`${list.items.length}作品 ｜ 作成 ${fmtDate(list.created_at)} ｜ 更新 ${fmtDate(list.updated_at)} ｜ `),
    el("a", { href: `/l/${encodeURIComponent(list.slug)}`, target: "_blank", rel: "noopener", textContent: "公開ページ" }),
    document.createTextNode(" ｜ "),
    el("a", { href: editUrl, target: "_blank", rel: "noopener", textContent: "編集リンク" })
  );
  if (list.bio) {
    meta.append(el("br"), document.createTextNode(`ひとこと: ${list.bio}`));
  }

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
    hint.textContent = "シリーズへの手動追加の取得に失敗しました";
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
    hint.textContent = "ユーザ投稿によるシリーズへの手動追加はまだありません。";
    hint.style.display = "";
    return;
  }

  for (const c of corrections) {
    const seriesName = c.series_name || "（不明なシリーズ）";
    const seriesLabel = c.series_creator ? `${seriesName}（${c.series_creator}）` : seriesName;

    // 確定=承認（公開維持・レビュー済みにしてキューから外す）、却下=誤投稿として削除。
    // 修正=巻そのものは正しいが巻番号や置き場所が違うとき（確定と却下だけでは直せない）。
    const approveBtn = el("button", { className: "ok", textContent: "確定" });
    approveBtn.addEventListener("click", () =>
      approveCorrection(c.series_id, c.isbn, seriesName, approveBtn)
    );
    const editBtn = el("button", { textContent: "修正" });
    editBtn.addEventListener("click", () => editCorrection(c, seriesName, editBtn));
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
        el("td", { className: "report-actions" }, [approveBtn, editBtn, delBtn]),
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
        // 0 = 表紙の自動取得（楽天市場 Tier3）が見つけてレビューに回したもの。
        el("td", { className: "num", textContent: s.suggest_count ? String(s.suggest_count) : "自動" }),
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
    hint.textContent = "シリーズ名の修正の取得に失敗しました";
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
    hint.textContent = "シリーズ名の修正はまだありません。";
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
      openSeriesVolumes(r.series_id, r.display_name || r.current_name || r.reported_name || r.series_id)
    );

    // 正しい名前のヒント: かな読みと収録巻タイトル。表示名が同名シリーズと見分けるために
    // 副題を足したものだと（series.name_display）マスタの素の名前と違うので、それも添える。
    const derived = !r.override_name && r.display_name && r.display_name !== r.current_name;
    const hints =
      [derived ? `マスタ: ${r.current_name}` : null, r.name_kana, r.vol_title].filter(Boolean).join(" / ") || "-";

    // 現在名は閲覧者に見えている名前。上書き済み・副題で区別しているときはその旨を添える。
    const currentText = r.override_name
      ? `${r.override_name}（修正済み）`
      : derived
        ? `${r.display_name}（副題で区別）`
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
        el("td", { className: "wrap", textContent: r.reported_name || "-" }),
        el("td", { className: "wrap", textContent: r.suggested_name || "-" }),
        el("td", { className: "wrap", textContent: currentText }),
        el("td", { className: "muted" }, [el("span", { className: "clip", textContent: hints, title: hints })]),
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
  const suggested = r.suggested_name || r.override_name || r.name_kana || r.vol_title || "";
  const name = await uiPrompt(
    `シリーズ「${r.reported_name || r.series_id}」の正しい名前を入力してください。\n全ての閲覧者の検索/詳細表示に反映され、その名前で検索したときに先頭に出ます。`,
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
    hint.textContent = "本のタイトルの修正の取得に失敗しました";
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
    hint.textContent = "本のタイトルの修正はまだありません。";
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
// 追跡できなくなるため、永続記録が残る 3 種（巻の通報→volume_hidden、シリーズへの手動追加→
// reviewed_at、シリーズ名の修正→series_name_override）を後から振り返る読み取り専用の一覧。

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

// 確定(承認)済みのシリーズへの手動追加（series_correction.reviewed_at > 0）。
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

    const drop = el("button", { className: "danger", textContent: "修正を外す" });
    drop.addEventListener("click", () => dropNameOverride(o, drop));

    // 今このシリーズに出ているタグ。修正名がタグと同じことしか言っていなければ外せる印なので、
    // 名前の隣にも同じバッジを出して見比べられるようにする。
    const tagCell = o.tag
      ? el("td", {}, [
          el("span", {
            className: "label-tag",
            textContent: o.tag,
            title: o.label ? `レーベル「${o.label}」から。公開側のカードにもこの印が出ます` : "",
          }),
        ])
      : el("td", { className: "muted", textContent: "-" });

    body.append(
      el("tr", { dataset: { key: o.series_id } }, [
        el("td", { className: "slug", textContent: o.series_id }),
        el("td", { className: "owner" }, [nameLink]),
        el("td", { className: "muted", textContent: o.current_name || "-" }),
        tagCell,
        el("td", { textContent: fmtDate(o.created_at) }),
        el("td", {}, [drop]),
      ])
    );
  }

  table.style.display = "";
  renderPager("nameOverridePager", page, total, loadNameOverrides);
}

/** 修正を外す（series_name_override の行を消す）。表示名はマスターの名前に戻る。
 *  レーベル/シリーズのタグ（廉価版・文庫版・傑作選）で版の違いが出せるようになり、修正名が
 *  タグと同じことしか言っていないときの片付け用。修正名は検索の照合にも使っているので
 *  （db/add-name-override-search.sql）、マスターの書名が壊れていて修正名でしか引けない
 *  シリーズでは外さないこと。確認ダイアログで戻り先の名前を見せる。 */
async function dropNameOverride(o, btn) {
  const back = o.current_name || "（マスターに名前がありません）";
  const tagNote = o.tag
    ? `版の違いは「${o.tag}」のタグが引き続き示します。`
    : "このシリーズにはタグが付いていないので、版の違いを示すものが無くなります。";
  if (
    !(await uiConfirm(
      `「${o.name}」の修正を外し、表示名を「${back}」に戻します。${tagNote}` +
        `この名前での検索の引き当ても無くなります。よろしいですか？`,
      { okLabel: "外す" }
    ))
  )
    return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/series-overrides/${encodeURIComponent(o.series_id)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadNameOverrides(pageState.nameOverrides);
  } catch (e) {
    uiAlert("修正を外せませんでした: " + e.message);
    btn.disabled = false;
  }
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

// --- シリーズの結合 ------------------------------------------------------
// 依頼（閲覧者の「シリーズが分かれている？」）/ 自動検出の候補 / 結合済み / 巻の紐付け の
// 4 表示と、分離のフォームを切り替える。シリーズに属さない巻のまとまり（ID「G…」）を結合すると、
// 巻をシリーズに紐付ける（残す側がまとまりなら独自シリーズ「U…」を作る）。分離は 1 つのシリーズに
// 混ざった別の版を独自シリーズへ移す。どちらも「巻の紐付け」から解除する。
let mergeMode = "requests";
let mergeSeq = 0; // 表示切替が速いときに古い応答で上書きしないための世代番号

const MERGE_MODES = {
  requests: { url: "/api/admin/merge-requests", key: "requests", empty: "結合の依頼はありません。" },
  candidates: { url: "/api/admin/merge-candidates", key: "candidates", empty: "自動検出の候補はありません。" },
  merges: { url: "/api/admin/series-merges", key: "merges", empty: "結合済みのシリーズはありません。" },
  links: { url: "/api/admin/series-links", key: "links", empty: "紐付けた巻はありません。" },
  splitRequests: { url: "/api/admin/split-requests", key: "requests", empty: "分離の依頼はありません。" },
};

function setMergeMode(mode) {
  mergeMode = mode;
  document.querySelectorAll(".merge-mode").forEach((b) => {
    b.classList.toggle("primary", b.dataset.mergeMode === mode);
  });
  loadMerge(1);
}

async function loadMerge(page = pageState.merge) {
  const list = $("mergeList");
  const hint = $("mergeHint");
  const count = $("mergeCount");
  const mode = MERGE_MODES[mergeMode];
  const seq = ++mergeSeq;
  list.textContent = "";
  $("mergePager").style.display = "none";
  if (mergeMode === "split") {
    hint.style.display = "none";
    count.textContent = "";
    renderSplitForm(list);
    return;
  }
  hint.textContent = "読み込み中…";
  hint.style.display = "";

  let data;
  try {
    const res = await fetch(`${mode.url}?page=${page}&per=${PER}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    if (seq !== mergeSeq) return;
    hint.textContent = "取得に失敗しました: " + e.message;
    return;
  }
  if (seq !== mergeSeq) return;

  const rows = data[mode.key] || [];
  const total = data.total ?? rows.length;
  if (rows.length === 0 && page > 1 && total > 0) {
    return loadMerge(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.merge = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;
  if (total === 0) {
    hint.textContent = mode.empty;
    return;
  }
  hint.style.display = "none";

  if (mergeMode === "merges") {
    renderMergedTable(list, rows);
  } else if (mergeMode === "links") {
    renderLinksTable(list, rows);
  } else if (mergeMode === "splitRequests") {
    renderSplitRequestsTable(list, rows);
  } else {
    for (const r of rows) list.append(mergeGroupCard(r));
  }
  renderPager("mergePager", page, total, loadMerge);
}

// 依頼 1 件 / 候補 1 グループを、シリーズごとの行（残す＝ラジオ、結合する＝チェック）で描く。
function mergeGroupCard(r) {
  const isRequest = mergeMode === "requests";
  const series = r.series || [];
  const name = `merge-${r.group_key}`;
  const body = el("tbody");
  const radios = [];
  const checks = [];
  series.forEach((s, i) => {
    const radio = el("input", { type: "radio", name, value: s.series_id, checked: i === 0 });
    const check = el("input", { type: "checkbox", value: s.series_id, checked: true });
    radios.push(radio);
    checks.push(check);
    const cid = el("a", { className: "slug detail", textContent: s.series_id, title: "このシリーズの巻一覧を表示" });
    cid.addEventListener("click", () => openSeriesVolumes(s.series_id, s.title));
    const titleLink = el("a", { className: "detail", textContent: s.title, title: "このシリーズの巻一覧を表示" });
    titleLink.addEventListener("click", () => openSeriesVolumes(s.series_id, s.title));
    const more = s.volume_count > s.labels.length ? " …" : "";
    body.append(
      el("tr", {}, [
        el("td", {}, [el("label", {}, [radio, " 残す"])]),
        el("td", {}, [el("label", {}, [check, " 含める"])]),
        el("td", { className: "owner" }, [cid]),
        el("td", { className: "wrap" }, [titleLink]),
        el("td", { className: "wrap muted", textContent: [s.creator, s.publisher, s.label].filter(Boolean).join(" / ") }),
        el("td", { className: "wrap", textContent: `全${s.volume_count}巻: ${s.labels.join(", ")}${more}` }),
      ])
    );
  });

  const mergeBtn = el("button", { className: "ok", textContent: "結合" });
  mergeBtn.addEventListener("click", () => {
    const target = radios.find((x) => x.checked)?.value;
    const absorbed = checks.filter((x) => x.checked && x.value !== target).map((x) => x.value);
    mergeSeries(target, absorbed, series, mergeBtn);
  });
  const dismissBtn = el("button", { className: "danger", textContent: isRequest ? "却下" : "却下（別の版）" });
  dismissBtn.addEventListener("click", () =>
    isRequest ? dismissMergeRequest(r, dismissBtn) : dismissMergeCandidate(r, dismissBtn)
  );

  const meta = [];
  if (isRequest) {
    const pairs = r.pairs.length > 1 ? `（${r.pairs.length}組）` : "";
    meta.push(`依頼 ${r.report_count}件${pairs}・最終 ${fmtDate(r.last_reported_at)}`);
    if (r.overlap) {
      const which = r.pairs.filter((p) => p.overlap).map((p) => `${p.series_a}–${p.series_b}`);
      meta.push(`⚠ 巻番号が重なっています（別の版の可能性）: ${which.join(", ")}`);
    }
  } else {
    meta.push(`合計 ${r.total}巻`);
  }

  return el("div", { className: "merge-group" }, [
    el("div", { className: "merge-group-head" }, [
      el("span", { className: r.overlap ? "warn-text" : "muted", textContent: meta.join(" ｜ ") }),
      el("div", { style: "flex:1" }),
      mergeBtn,
      dismissBtn,
    ]),
    el("table", { className: "admin-table" }, [body]),
  ]);
}

async function mergeSeries(target, absorbed, series, btn) {
  if (!target || !absorbed.length) {
    uiAlert("「残す」以外に「含める」シリーズを1つ以上選んでください");
    return;
  }
  const label = (id) => {
    const s = series.find((x) => x.series_id === id);
    return s ? `${id}「${s.title}」` : id;
  };
  // 残す側がまとまり（G…）なら独自シリーズを作るので、その名前を決めてもらう。
  let name = "";
  if (/^G\d{13}$/.test(target)) {
    const s = series.find((x) => x.series_id === target);
    const v = await uiPrompt("作成する独自シリーズの名前", s ? s.title : "", {
      validate: (x) => (x.trim() ? (x.trim().length > 200 ? "200文字以内で入力してください" : "") : "名前を入力してください"),
    });
    if (v == null) return;
    name = v.trim();
  }
  const ok = await uiConfirm(
    `${absorbed.map(label).join("、")} を ${label(target)} に結合します。\n` +
      (/^G\d{13}$/.test(target) ? `残す側はシリーズに属さないまとまりなので、独自シリーズ「${name}」（U…）を作ります。\n` : "") +
      "全ての閲覧者の検索・巻一覧・リスト表示に反映されます。よろしいですか？",
    { okLabel: "結合する" }
  );
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = "結合中…";
  try {
    const res = await fetch("/api/admin/series-merges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_id: target, absorbed_ids: absorbed, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMerge(pageState.merge);
  } catch (e) {
    uiAlert("結合に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "結合";
  }
}

// グループ内の依頼（組）をすべて却下する。
async function dismissMergeRequest(r, btn) {
  if (!(await uiConfirm("このグループの依頼を全て却下（削除）します。シリーズは結合されません。よろしいですか？", { okLabel: "却下する" }))) return;
  btn.disabled = true;
  try {
    await Promise.all(
      r.pairs.map(async (p) => {
        const res = await fetch(
          `/api/admin/merge-requests/${encodeURIComponent(p.series_a)}/${encodeURIComponent(p.series_b)}`,
          { method: "DELETE" }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 404) throw new Error(data.error || `HTTP ${res.status}`);
      })
    );
    await loadMerge(pageState.merge);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
  }
}

async function dismissMergeCandidate(r, btn) {
  if (!(await uiConfirm("この組を別の版として候補から外します。よろしいですか？", { okLabel: "却下する" }))) return;
  btn.disabled = true;
  try {
    const res = await fetch("/api/admin/merge-candidates/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group_key: r.group_key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMerge(pageState.merge);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
  }
}

function renderMergedTable(list, merges) {
  const body = el("tbody");
  for (const m of merges) {
    const btn = el("button", { className: "danger", textContent: "解除" });
    btn.addEventListener("click", () => unmergeSeries(m, btn));
    const link = (id, name) => {
      const a = el("a", { className: "slug detail", textContent: id, title: "このシリーズの巻一覧を表示" });
      a.addEventListener("click", () => openSeriesVolumes(id, name));
      return a;
    };
    body.append(
      el("tr", {}, [
        el("td", { className: "owner" }, [link(m.absorbed_id, m.absorbed_name)]),
        el("td", { className: "wrap", textContent: m.absorbed_name || "-" }),
        el("td", { className: "owner" }, [link(m.target_id, m.target_name)]),
        el("td", { className: "wrap", textContent: m.target_name || "-" }),
        el("td", { textContent: fmtDate(m.created_at) }),
        el("td", { className: "report-actions" }, [btn]),
      ])
    );
  }
  list.append(
    el("table", { className: "admin-table" }, [
      el("thead", {}, [
        el("tr", {}, ["吸収した C-id", "名前", "残した C-id", "名前", "結合日時", ""].map((t) => el("th", { textContent: t }))),
      ]),
      body,
    ])
  );
}

function renderLinksTable(list, links) {
  const body = el("tbody");
  for (const l of links) {
    const btn = el("button", { className: "danger", textContent: "解除" });
    btn.addEventListener("click", () => unlinkVolumes(l, btn));
    const sid = el("a", { className: "slug detail", textContent: l.series_id, title: "このシリーズの巻一覧を表示" });
    sid.addEventListener("click", () => openSeriesVolumes(l.series_id, l.series_name));
    const from = l.from_series_id ? `（${l.from_series_id}「${l.from_series_name || "-"}」から分離）` : "";
    body.append(
      el("tr", {}, [
        el("td", { className: "owner" }, [sid]),
        el("td", { className: "wrap", textContent: (l.series_name || "-") + (l.custom ? "（独自シリーズ）" : "") + from }),
        el("td", { className: "wrap", textContent: l.titles.join(" / ") || "-" }),
        el("td", { textContent: `${l.isbn_count}` }),
        el("td", { textContent: fmtDate(l.created_at) }),
        el("td", { className: "report-actions" }, [btn]),
      ])
    );
  }
  list.append(
    el("table", { className: "admin-table" }, [
      el("thead", {}, [
        el("tr", {}, ["紐付け先", "名前", "紐付けた巻の書名", "ISBN数", "日時", ""].map((t) => el("th", { textContent: t }))),
      ]),
      body,
    ])
  );
}

async function unlinkVolumes(l, btn) {
  const extra = l.custom ? "\n巻も結合も残らなければ独自シリーズも削除します。" : "";
  const back = l.from_series_id ? `分離元の ${l.from_series_id} に戻します。` : "シリーズ無しに戻します。";
  if (!(await uiConfirm(`この回に紐付けた ${l.isbn_count} 件の ISBN を ${l.series_id} から外し、${back}${extra}よろしいですか？`, { okLabel: "解除する" }))) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/series-links/${encodeURIComponent(l.series_id)}/${l.created_at}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMerge(pageState.merge);
  } catch (e) {
    uiAlert("解除に失敗しました: " + e.message);
    btn.disabled = false;
  }
}

// 分離のフォーム: シリーズ ID で巻を ISBN ごとに読み込み、移す巻を選んで独自シリーズを作る。
// 巻一覧は同じ巻番号の ISBN を 1 巻にまとめるので、ここでは 1 ISBN = 1 行で選ばせる。
let splitSeriesId = "";

function renderSplitForm(list) {
  const input = el("input", { type: "text", placeholder: "シリーズID（例: C261524）", value: splitSeriesId });
  const loadBtn = el("button", { textContent: "読み込む" });
  const area = el("div");
  const load = () => {
    const id = input.value.trim();
    if (!/^[A-Za-z0-9]{1,32}$/.test(id)) {
      uiAlert("シリーズIDを入力してください");
      return;
    }
    splitSeriesId = id;
    loadSplitVolumes(id, area);
  };
  loadBtn.addEventListener("click", load);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load();
  });
  list.append(el("div", { className: "cover-single" }, [input, loadBtn]), area);
  if (splitSeriesId) loadSplitVolumes(splitSeriesId, area);
}

async function loadSplitVolumes(id, area) {
  const seq = mergeSeq;
  area.textContent = "読み込み中…";
  let data;
  try {
    const res = await fetch(`/api/admin/series-splits/${encodeURIComponent(id)}/volumes`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    if (seq === mergeSeq) area.textContent = "取得に失敗しました: " + e.message;
    return;
  }
  if (seq !== mergeSeq) return;
  area.textContent = "";

  const vols = data.volumes || [];
  const merged = vols.some((v) => v.series_id !== data.series_id);
  const checks = [];
  const body = el("tbody");
  const selCount = el("span", { className: "count" });
  const updateCount = () => {
    selCount.textContent = `${checks.filter((c) => c.checked).length} / ${vols.length} 件を選択`;
  };
  for (const v of vols) {
    // 閲覧者が「別の版」と依頼した巻は選んだ状態で出す。
    const cb = el("input", { type: "checkbox", value: v.isbn, checked: v.report_count > 0 });
    cb.addEventListener("change", updateCount);
    checks.push(cb);
    body.append(
      el("tr", {}, [
        el("td", {}, [cb]),
        el("td", { className: "owner", textContent: v.isbn }),
        el("td", { className: "wrap", textContent: v.volume_number || "-" }),
        el("td", { className: "wrap", textContent: v.title }),
        el("td", { className: "wrap", textContent: v.label || "-" }),
        el("td", { textContent: v.pubdate || "-" }),
        el("td", { textContent: v.report_count ? `${v.report_count}` : "" }),
        ...(merged ? [el("td", { textContent: v.series_id })] : []),
      ])
    );
  }

  // 「の巻」「復刻」など巻番号・書名に含まれる文字で一括選択する（別の版は表記が揃っていることが多い）。
  const filter = el("input", { type: "text", placeholder: "巻番号・書名に含む文字" });
  const pickBtn = el("button", { textContent: "一致する巻を選択" });
  pickBtn.addEventListener("click", () => {
    const q = filter.value.trim();
    if (!q) return;
    vols.forEach((v, i) => {
      if ((v.volume_number || "").includes(q) || v.title.includes(q)) checks[i].checked = true;
    });
    updateCount();
  });
  const clearBtn = el("button", { textContent: "選択を解除" });
  clearBtn.addEventListener("click", () => {
    checks.forEach((c) => (c.checked = false));
    updateCount();
  });

  const nameInput = el("input", { type: "text", value: `${data.name} 復刻版`, style: "min-width:240px" });
  const splitBtn = el("button", { className: "primary", textContent: "分離" });
  splitBtn.addEventListener("click", () =>
    splitSeries(data, checks.filter((c) => c.checked).map((c) => c.value), nameInput.value.trim(), splitBtn)
  );
  updateCount();

  area.append(
    el("p", { className: "hint", textContent: `${data.series_id}「${data.name}」（${data.label || "レーベル無し"}）の巻 ${vols.length} 件` }),
    el("div", { className: "cover-single" }, [filter, pickBtn, clearBtn, selCount]),
    el("table", { className: "admin-table" }, [
      el("thead", {}, [
        el("tr", {}, ["", "ISBN", "巻番号", "書名", "レーベル", "発売日", "依頼", ...(merged ? ["C-id"] : [])].map((t) =>
          el("th", { textContent: t })
        )),
      ]),
      body,
    ]),
    el("div", { className: "cover-single", style: "margin-top:12px" }, [
      el("span", { textContent: "新しいシリーズの名前" }),
      nameInput,
      splitBtn,
    ])
  );
}

// 分離の依頼（シリーズ単位）。依頼された巻と回数を並べ、「分離する」で分離の画面に読み込む。
function renderSplitRequestsTable(list, requests) {
  const body = el("tbody");
  for (const r of requests) {
    const openBtn = el("button", { className: "primary", textContent: "分離する" });
    openBtn.addEventListener("click", () => {
      splitSeriesId = r.series_id;
      setMergeMode("split");
    });
    const dismissBtn = el("button", { textContent: "却下" });
    dismissBtn.addEventListener("click", () => dismissSplitRequest(r, dismissBtn));
    const sid = el("a", { className: "slug detail", textContent: r.series_id, title: "このシリーズの巻一覧を表示" });
    sid.addEventListener("click", () => openSeriesVolumes(r.series_id, r.name));
    const vols = r.volumes.map((v) => `${v.volume_number || v.isbn}${v.report_count > 1 ? `（${v.report_count}）` : ""}`);
    body.append(
      el("tr", {}, [
        el("td", { className: "owner" }, [sid]),
        el("td", { className: "wrap", textContent: `${r.name || "-"}（${r.label || "レーベル無し"}・全${r.volume_count}冊）` }),
        el("td", { className: "wrap", textContent: `${r.isbn_count}冊: ${vols.join(", ")}` }),
        el("td", { textContent: `${r.report_count}` }),
        el("td", { textContent: fmtDate(r.last_reported_at) }),
        el("td", { className: "report-actions" }, [openBtn, dismissBtn]),
      ])
    );
  }
  list.append(
    el("table", { className: "admin-table" }, [
      el("thead", {}, [
        el("tr", {}, ["シリーズ", "名前", "別の版だと依頼された巻", "依頼回数", "最終依頼", ""].map((t) => el("th", { textContent: t }))),
      ]),
      body,
    ])
  );
}

async function dismissSplitRequest(r, btn) {
  if (!(await uiConfirm(`${r.series_id}「${r.name}」への分離の依頼を却下します（依頼を全て消します）。よろしいですか？`, { okLabel: "却下する" }))) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/split-requests/${encodeURIComponent(r.series_id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMerge(pageState.merge);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
  }
}

async function splitSeries(src, isbns, name, btn) {
  if (!isbns.length) {
    uiAlert("移す巻を1つ以上選んでください");
    return;
  }
  if (!name) {
    uiAlert("新しいシリーズの名前を入力してください");
    return;
  }
  if (name.length > 200) {
    uiAlert("名前は200文字以内で入力してください");
    return;
  }
  const ok = await uiConfirm(
    `${src.series_id}「${src.name}」から ${isbns.length} 件の ISBN を、独自シリーズ「${name}」（U…）に移します。\n` +
      "全ての閲覧者の検索・巻一覧・リスト表示に反映されます。よろしいですか？",
    { okLabel: "分離する" }
  );
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = "分離中…";
  try {
    const res = await fetch("/api/admin/series-splits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_id: src.series_id, isbns, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // 結果は「巻の紐付け」の先頭に出る（解除もそこから）。
    setMergeMode("links");
  } catch (e) {
    uiAlert("分離に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "分離";
  }
}

async function unmergeSeries(m, btn) {
  if (!(await uiConfirm(`${m.absorbed_id} を ${m.target_id} から切り離し、独立したシリーズに戻します。よろしいですか？`, { okLabel: "解除する" }))) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/series-merges/${encodeURIComponent(m.absorbed_id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMerge(pageState.merge);
  } catch (e) {
    uiAlert("解除に失敗しました: " + e.message);
    btn.disabled = false;
  }
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

  // 結合の判断に使えるよう、1 冊ごとに作者・出版社/レーベル・発行日・ISBN（版違いの数）まで
  // 出す。押すと本の詳細（book-detail.js。あらすじ・他の版の ISBN）を重ねて開く。
  for (const v of vols) grid.append(volumeDetailItem(v, () => openBookDetail(v, { noSeries: true })));
}

// 巻 1 冊のカード（巻一覧モーダルと、寄せ先モーダルの巻プレビューで共通）。onClick を渡すと
// 押せるカードになる。dialog の中で使うときは渡さない ー 本の詳細（book-detail.js）は div の
// オーバーレイなので、top layer の dialog の後ろに出てしまう。
function volumeDetailItem(v, onClick) {
  const others = (v.isbns || []).length - 1;
  const body = [
    el("div", { className: "di-pos", textContent: v.volume_number || "-" }),
    el("div", { className: "di-title", textContent: v.title || "（タイトルなし）" }),
    el("div", { className: "di-author", textContent: v.creators || v.author || "" }),
    el("div", { className: "di-meta", textContent: [v.publisher, v.label].filter(Boolean).join(" / ") }),
    el("div", { className: "di-meta", textContent: v.pubdate || "" }),
    el("div", { className: "di-meta di-isbn", textContent: (v.isbn || "") + (others > 0 ? `（他${others}版）` : "") }),
  ];
  if (v.correction) body.push(el("div", { className: "di-flags", textContent: "ユーザ投稿" }));
  const item = el("div", { className: "detail-item" }, [
    coverThumb(v.cover_url, "di-cover", "di-noimg", v.title),
    el("div", { className: "di-body" }, body),
  ]);
  if (onClick) {
    item.classList.add("clickable");
    item.title = "本の詳細を表示";
    item.addEventListener("click", onClick);
  }
  return item;
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

/** 手動追加を直す（PATCH /api/admin/corrections/:series/:isbn）。巻そのものは正しいのに巻番号や
 *  置き場所だけが違う投稿の受け皿。巻番号 → シリーズ ID の順に聞き、どちらも変えなければ何もしない。
 *  巻番号の形式（「N」「巻N」、部立てのシリーズなら「第N部M」）はサーバが移動先のシリーズに
 *  合わせて検査・整形するので、ここでは空かどうかだけ見る。 */
async function editCorrection(c, seriesName, btn) {
  const volume = await uiPrompt(
    `「${seriesName}」ISBN ${c.isbn} の巻番号を入力してください。\n` +
      `部立てのシリーズでは「第4部9」のように部を付けられます（書式はシリーズの他の巻に揃います）。`,
    c.volume_number || ""
  );
  if (volume === null) return;
  if (!volume.trim()) {
    uiAlert("巻番号を入力してください");
    return;
  }
  const seriesId = await uiPrompt(
    `この巻を置くシリーズ ID を入力してください（変えないならそのまま）。\n` +
      `別のシリーズに移すときだけ変更してください。まとまり（G-id）へは移せません。`,
    c.series_id
  );
  if (seriesId === null) return;
  const target = seriesId.trim() || c.series_id;
  if (volume.trim() === (c.volume_number || "") && target === c.series_id) return;

  btn.disabled = true;
  btn.textContent = "修正中…";
  try {
    const res = await fetch(
      `/api/admin/corrections/${encodeURIComponent(c.series_id)}/${encodeURIComponent(c.isbn)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ series_id: target, volume_number: volume.trim() }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadCorrections(pageState.corr);
  } catch (e) {
    uiAlert("修正に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "修正";
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

const TARGET_LABEL = { owner_name: "ユーザー名", bio: "ひとこと", comment: "コメント", cover: "表紙画像" };

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

/* ---------- シリーズのタグの申請（廉価版・文庫版・傑作選） ---------- */
// 閲覧者が巻一覧の「廉価版・文庫版？」から出した申請（collect-only）。確定すると
// series_tag に書いてレーベル単位のタグより優先される。却下は申請を消すだけ。
// タグの選択肢はサーバ（src/labels.ts LABEL_TAGS）が返すものを使う。
let seriesTagOptions = [];

function syncSeriesTagOptions(tags) {
  if (seriesTagOptions.length || !(tags || []).length) return;
  seriesTagOptions = tags;
  const sel = $("seriesTagManualTag");
  sel.textContent = "";
  sel.append(el("option", { value: "", textContent: "タグ無し（レーベル由来を打ち消す）" }));
  for (const t of seriesTagOptions) sel.append(el("option", { value: t, textContent: t }));
  sel.value = seriesTagOptions[0];
}

async function loadSeriesTagRequests(page = pageState.seriesTag) {
  const table = $("seriesTagTable");
  const body = $("seriesTagBody");
  const hint = $("seriesTagHint");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("seriesTagPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/series-tag-requests?page=${page}&per=${PER}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch {
    hint.textContent = "申請一覧の取得に失敗しました";
    hint.style.display = "";
    return;
  }
  syncSeriesTagOptions(data.tags);

  const rows = data.requests || [];
  const total = data.total ?? rows.length;
  if (rows.length === 0 && page > 1 && total > 0) {
    return loadSeriesTagRequests(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.seriesTag = page;
  $("seriesTagCount").textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "未処理の申請はありません。";
    hint.style.display = "";
    return;
  }

  for (const r of rows) {
    // 確定するタグは申請どおりでなくてよい（誤申請をその場で直せる）。既定は申請された値。
    const sel = el("select", { title: "確定するタグ" });
    sel.append(el("option", { value: "", textContent: "タグ無し" }));
    for (const t of seriesTagOptions) sel.append(el("option", { value: t, textContent: t }));
    sel.value = r.tag || "";

    const ok = el("button", { className: "primary", textContent: "確定" });
    ok.addEventListener("click", () => confirmSeriesTag(r, sel.value, ok));
    const no = el("button", { textContent: "却下" });
    no.addEventListener("click", () => dismissSeriesTag(r, no));

    const requested = r.tag ? r.tag : "タグを外して";
    const from = r.current_from === "series" ? "個別" : r.current_from === "label" ? "レーベル" : "";
    const current = r.current_tag ? `${r.current_tag}（${from}）` : "なし";

    body.append(
      el("tr", { dataset: { sid: r.series_id } }, [
        el("td", null, [el("span", { className: "label-tag", textContent: requested })]),
        el("td", { className: "num", textContent: String(r.report_count) }),
        el("td", null, [
          seriesVolumesLink(r.series_id, r.name || "(マスターに無いシリーズ)", r.name || ""),
          el("div", { className: "muted", textContent: r.creator || "" }),
        ]),
        el("td", { className: "muted", textContent: r.label || "-" }),
        el("td", { className: r.current_tag ? "" : "muted", textContent: current }),
        el("td", null, [sel]),
        el("td", { className: "report-actions" }, [ok, no]),
      ])
    );
  }

  table.style.display = "";
  renderPager("seriesTagPager", page, total, loadSeriesTagRequests);
}

async function confirmSeriesTag(r, tag, btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "確定中…";
  try {
    const res = await fetch(`/api/admin/series-tag-requests/${encodeURIComponent(r.series_id)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadSeriesTagRequests(pageState.seriesTag);
  } catch (e) {
    uiAlert("確定に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function dismissSeriesTag(r, btn) {
  if (!(await uiConfirm(`「${r.name || r.series_id}」への申請を却下します（表示は今までどおり）。よろしいですか？`, { okLabel: "却下する" }))) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/series-tag-requests/${encodeURIComponent(r.series_id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadSeriesTagRequests(pageState.seriesTag);
  } catch (e) {
    uiAlert("却下に失敗しました: " + e.message);
    btn.disabled = false;
  }
}

// 申請を待たずに直接設定する / 個別の指定を外してレーベル由来に戻す。
async function applySeriesTagManual(btn, clear) {
  const input = $("seriesTagId");
  const seriesId = input.value.trim();
  if (!seriesId) {
    uiAlert("シリーズ ID を入力してください。");
    return;
  }
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "設定中…";
  try {
    const body = clear ? { series_id: seriesId } : { series_id: seriesId, tag: $("seriesTagManualTag").value };
    const res = await fetch("/api/admin/series-tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    input.value = "";
    uiAlert(
      clear
        ? `${seriesId} の個別指定を外しました（レーベル由来の印に戻ります）。`
        : data.tag
          ? `${seriesId} に「${data.tag}」を設定しました。`
          : `${seriesId} を「タグ無し」に設定しました（レーベル由来の印を打ち消します）。`
    );
    await loadSeriesTagRequests(pageState.seriesTag);
  } catch (e) {
    uiAlert("設定に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

$("reloadSeriesTag").addEventListener("click", () => loadSeriesTagRequests(pageState.seriesTag));
$("seriesTagApply").addEventListener("click", (e) => applySeriesTagManual(e.currentTarget, false));
$("seriesTagClear").addEventListener("click", (e) => applySeriesTagManual(e.currentTarget, true));

/* ---------- レーベル管理（廉価版・文庫版のタグ付け） ---------- */
// マスタ（MADB）には「コンビニ廉価版か」「文庫版か」を表す項目が無いが、レーベル名
// （schema:brand）を見れば分かるものが多い（KPC・講談社プラチナコミックス = 廉価版）。
// ここで付けたタグは label_tag（レーベル名が鍵）に入り、そのレーベルのシリーズ全部の
// 検索カード・巻一覧に出る（src/labels.ts）。毎月の取り込みでは消えない。
let labelQuery = "";
let labelTagOptions = [];
let labelCounts = { tagged: 0, by_tag: {} };
const labelSelected = new Set();

// タグの選択肢はサーバ（src/labels.ts LABEL_TAGS）が返すものをそのまま使う。増やしたときに
// 画面側を直さなくて済むよう、絞り込み・まとめて設定・レーベル名指定の 3 つを一度に埋める。
function syncLabelTagOptions(tags) {
  if (labelTagOptions.length || !(tags || []).length) return;
  labelTagOptions = tags;
  for (const t of labelTagOptions) {
    $("labelFilter").append(el("option", { value: t, textContent: t }));
  }
  for (const id of ["labelBulkTag", "labelManualTag"]) {
    const sel = $(id);
    sel.textContent = "";
    sel.append(el("option", { value: "", textContent: "タグなし（解除）" }));
    for (const t of labelTagOptions) sel.append(el("option", { value: t, textContent: t }));
    sel.value = labelTagOptions[0];
  }
}

// タグが付いている行に色を付ける。行全体を淡く塗って一覧で拾えるようにし、
// プルダウン自体はタグごとの色にする（廉価版・文庫版・傑作選が混ざった一覧でも見分く）。
// 色は styles.css の [data-tag="…"] 側で決める。知らないタグでも「付いている」色にはなる。
function markLabelRow(tr, sel, tag) {
  if (tr) {
    tr.classList.toggle("tagged", !!tag);
    if (tag) tr.dataset.tag = tag;
    else delete tr.dataset.tag;
  }
  if (tag) sel.dataset.tag = tag;
  else delete sel.dataset.tag;
}

function tagSelect(current) {
  const sel = el("select", { title: "このレーベルのタグ" });
  sel.append(el("option", { value: "", textContent: "—" }));
  for (const t of labelTagOptions) sel.append(el("option", { value: t, textContent: t }));
  sel.value = current || "";
  return sel;
}

function renderLabelCounts(total) {
  const breakdown = labelTagOptions
    .map((t) => `${t} ${(labelCounts.by_tag[t] ?? 0).toLocaleString("ja-JP")}`)
    .join(" / ");
  $("labelCount").textContent =
    `${total.toLocaleString("ja-JP")}件` +
    (breakdown ? `（設定済み ${labelCounts.tagged.toLocaleString("ja-JP")}: ${breakdown}）` : "");
}

function updateLabelSelCount() {
  $("labelSelCount").textContent = `選択中 ${labelSelected.size} 件`;
  $("labelBulkApply").disabled = labelSelected.size === 0;
}

async function loadLabels() {
  const table = $("labelTable");
  const body = $("labelBody");
  const hint = $("labelHint");
  const filter = $("labelFilter").value;
  const era = $("labelEra").value;
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("labelClear").style.display = labelQuery || filter || era ? "" : "none";
  $("labelCheckAll").checked = false;
  labelSelected.clear();
  updateLabelSelCount();

  let data;
  try {
    const qs = new URLSearchParams();
    if (labelQuery) qs.set("q", labelQuery);
    if (filter) qs.set("filter", filter);
    if (era) qs.set("era", era);
    const res = await fetch(`/api/admin/labels?${qs}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch {
    hint.textContent = "レーベル一覧の取得に失敗しました";
    hint.style.display = "";
    return;
  }
  syncLabelTagOptions(data.tags);

  const labels = data.labels || [];
  const total = data.total ?? labels.length;
  labelCounts = { tagged: data.tagged ?? 0, by_tag: data.by_tag || {} };
  renderLabelCounts(total);

  if (total === 0) {
    hint.textContent = labelQuery
      ? `「${labelQuery}」に一致するレーベルはありません。`
      : "該当するレーベルはありません。";
    hint.style.display = "";
    return;
  }
  // ページ送りをしないので、上限で切れたことは必ず知らせる（全選択が「全部」に見えてしまうため）。
  if (data.truncated) {
    hint.textContent =
      `該当 ${total.toLocaleString("ja-JP")} 件のうち ${labels.length.toLocaleString("ja-JP")} 件だけ表示しています` +
      `（1 回に出せるのは ${(data.limit ?? labels.length).toLocaleString("ja-JP")} 件まで）。` +
      `検索語や絞り込みで狭めてください。「全選択」は表示中の分だけが対象です。`;
    hint.style.display = "";
  }

  for (const row of labels) {
    const cb = el("input", { type: "checkbox", title: `${row.label} を選択` });
    cb.addEventListener("change", () => {
      if (cb.checked) labelSelected.add(row.label);
      else labelSelected.delete(row.label);
      updateLabelSelCount();
    });

    // 出版社。1 レーベルに複数の表記がぶら下がることがあるので、一番多いものに「ほかN社」を添える。
    const pubCell = row.publisher
      ? el("td", { textContent: row.publisher + (row.publisher_n > 1 ? ` ほか${row.publisher_n - 1}社` : "") })
      : el("td", { className: "muted", textContent: "-" });

    // 発行年。空＝マスタに 1 冊も日付が無い＝昭和の貸本・児童書の線の可能性が高い（一括付与から外す）。
    const yearCell = row.year_from
      ? el("td", { textContent: row.year_from === row.year_to ? row.year_from : `${row.year_from}–${row.year_to}` })
      : el("td", { className: "warn", textContent: "年なし", title: "マスタに発行年が 1 つもありません。判型ではなく叢書の意味の「〜文庫」（昭和の貸本・児童書）の可能性が高いので、一括付与から外してください" });

    const sel = tagSelect(row.tag);
    sel.addEventListener("change", async () => {
      const next = sel.value;
      const prev = row.tag || "";
      if (next === prev) return;
      sel.disabled = true;
      try {
        await setLabelTags([row.label], next);
        // 1 行の付け替えでは一覧を取り直さない（チェック中の選択が消えるため）。件数だけ直す。
        row.tag = next;
        markLabelRow(sel.closest("tr"), sel, next);
        if (prev) labelCounts.by_tag[prev] = Math.max(0, (labelCounts.by_tag[prev] ?? 0) - 1);
        if (next) labelCounts.by_tag[next] = (labelCounts.by_tag[next] ?? 0) + 1;
        labelCounts.tagged += (next ? 1 : 0) - (prev ? 1 : 0);
        renderLabelCounts(total);
      } catch (e) {
        sel.value = prev;
        uiAlert("設定に失敗しました: " + e.message);
      } finally {
        sel.disabled = false;
      }
    });

    // タグ列は操作するものなので、チェックボックスの隣（左端）に置く。右端だと
    // 「そのレーベルの主な作品」に押し出されて横スクロールしないと触れなかった。
    const tr = el("tr", null, [
      el("td", null, [cb]),
      el("td", { className: "label-tag-cell" }, [sel]),
      el("td", { textContent: row.label }),
      el("td", { className: "num", textContent: (row.series_count ?? 0).toLocaleString("ja-JP") }),
      pubCell,
      yearCell,
      el("td", { className: "muted", textContent: row.samples || "-" }),
    ]);
    markLabelRow(tr, sel, row.tag);
    body.append(tr);
  }

  table.style.display = "";
}

/** レーベルにタグを付ける / 外す（tag = "" が解除）。成功しなければ投げる。 */
async function setLabelTags(labels, tag) {
  const res = await fetch("/api/admin/labels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labels, tag }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function applyLabelBulk(btn) {
  const labels = [...labelSelected];
  if (!labels.length) return;
  const tag = $("labelBulkTag").value;
  const what = tag ? `「${tag}」を設定` : "タグを解除";
  if (!(await uiConfirm(`選択した ${labels.length} 件のレーベルに${what}します。よろしいですか？`, { okLabel: "設定する" }))) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "設定中…";
  try {
    await setLabelTags(labels, tag);
    await loadLabels();
  } catch (e) {
    uiAlert("設定に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function applyLabelManual(btn) {
  const input = $("labelManualName");
  const label = input.value.trim();
  if (!label) {
    uiAlert("レーベル名を入力してください。");
    return;
  }
  const tag = $("labelManualTag").value;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "設定中…";
  try {
    await setLabelTags([label], tag);
    input.value = "";
    uiAlert(tag ? `「${label}」に「${tag}」を設定しました。` : `「${label}」のタグを解除しました。`);
    await loadLabels();
  } catch (e) {
    uiAlert("設定に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

$("labelSearch").addEventListener("click", () => {
  labelQuery = $("labelQuery").value.trim();
  loadLabels();
});
$("labelQuery").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  labelQuery = $("labelQuery").value.trim();
  loadLabels();
});
$("labelClear").addEventListener("click", () => {
  labelQuery = "";
  $("labelQuery").value = "";
  $("labelFilter").value = "";
  $("labelEra").value = "";
  loadLabels();
});
$("labelFilter").addEventListener("change", () => loadLabels());
$("labelEra").addEventListener("change", () => loadLabels());
$("reloadLabels").addEventListener("click", () => loadLabels());
// 表示中の全行が対象（上限で切れているときは hint がそう知らせている）。
$("labelCheckAll").addEventListener("change", (e) => {
  for (const cb of $("labelBody").querySelectorAll('input[type="checkbox"]')) {
    if (cb.checked !== e.target.checked) {
      cb.checked = e.target.checked;
      cb.dispatchEvent(new Event("change"));
    }
  }
});
$("labelBulkApply").addEventListener("click", (e) => applyLabelBulk(e.currentTarget));
$("labelManualApply").addEventListener("click", (e) => applyLabelManual(e.currentTarget));

// --- 開発ツール（ローカル dev 限定: ADMIN_DEV_BYPASS）------------------------
// DB 初期化（マスターデータ以外を全削除）と、各キャッシュの「全削除」系ボタン。どちらも
// 一撃で全件消える破壊的操作なので本番からは隠す。/api/admin/stats の dev=false で
// ナビと .dev-only 要素を隠し、サーバ側でも 403 で fail-closed する。
// HTML 側は hidden 付きで書いてあるので、stats が取れなかった時も出てこない。
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
  for (const el of document.querySelectorAll(".dev-only")) el.hidden = !devEnabled;
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

/* ---------- マスタ行の修正（上流が壊している巻を直す, src/masterFix.ts） ---------- */
// MADB は巻の ISBN 自体を取り違えていることがあり、表示名だけの上書きでは直らない
// （シリーズ・巻番号・著者・発行日が別経路で読まれる）。ここでは volume_master_fix に
// 「直した後のマスタ行そのもの」を書き、サーバがその場で volumes へ当てる。月次取り込みの
// あとは scripts/ingest.mjs が同じ行を載せ直す。

// 「調べる」で引いた下書きの材料。フォームの「反映」ボタンが参照する。
let mfixLookup = null;

const MFIX_FIELDS = {
  series_id: "mfixSeriesId",
  title: "mfixTitle",
  subtitle: "mfixSubtitle",
  volume_number: "mfixVolumeNumber",
  vol_sort: "mfixVolSort",
  creator: "mfixCreator",
  creators: "mfixCreators",
  publisher: "mfixPublisher",
  label: "mfixLabel",
  pubdate: "mfixPubdate",
  note: "mfixNote",
};

function mfixSetForm(values) {
  for (const [key, id] of Object.entries(MFIX_FIELDS)) {
    if (key in values) $(id).value = values[key] ?? "";
  }
  if ("is_adult" in values) $("mfixIsAdult").checked = !!values.is_adult;
}

// 指定されたキーだけを今のフォームへ流し込む（材料カードの「反映」）。空の値では上書きしない:
// openBD は副題やレーベルを持たないので、せっかく埋めた欄を消してしまわないように。
function mfixFill(values, keys) {
  const patch = {};
  for (const key of keys) {
    const v = values[key];
    if (v !== undefined && v !== null && v !== "") patch[key] = v;
  }
  mfixSetForm(patch);
}

function mfixSourceCard(title, rows, fillLabel, onFill) {
  const dl = el("dl", null, rows.filter(([, v]) => v).map(([k, v]) =>
    el("div", null, [el("dt", { textContent: k }), el("dd", { textContent: v })])
  ));
  const head = [el("span", { className: "mfix-source-title", textContent: title })];
  if (onFill) {
    const btn = el("button", { type: "button", textContent: fillLabel });
    btn.addEventListener("click", onFill);
    head.push(btn);
  }
  return el("div", { className: "stat-card mfix-source" }, [
    el("div", { className: "mfix-source-head" }, head),
    dl,
  ]);
}

// 「調べる」の結果（今のマスタ行 / openBD の書誌 / 指定シリーズの手本）を材料カードで描く。
function mfixRenderSources() {
  const box = $("mfixSources");
  box.textContent = "";
  if (!mfixLookup) return;
  const { master, openbd, series } = mfixLookup;

  if (master) {
    box.append(
      mfixSourceCard(
        "今のマスタ行（これが壊れている）",
        [
          ["シリーズ", master.series_name ? `${master.series_name}（${master.series_id}）` : master.series_id || "（無し）"],
          ["書名", [master.title, master.subtitle].filter(Boolean).join(" / ")],
          ["巻", master.volume_number],
          ["著者", master.creators || master.creator],
          ["出版社", [master.publisher, master.label].filter(Boolean).join(" / ")],
          ["発行日", master.pubdate],
        ],
        "写す",
        () => mfixFill(master, Object.keys(MFIX_FIELDS))
      )
    );
  } else {
    box.append(
      mfixSourceCard("今のマスタ行", [["", "この ISBN の行は上流に無い（足す側の巻）"]], "", null)
    );
  }

  if (openbd) {
    // openBD の書名は "Rave 9" のように巻数込みのことがある。末尾の数字は巻として分ける。
    const m = /^(.*?)[  ]+(\d{1,4})$/.exec(openbd.title || "");
    const title = m ? m[1] : openbd.title;
    const volume = openbd.volume || (m ? m[2] : "");
    box.append(
      mfixSourceCard(
        "openBD の書誌",
        [
          ["書名", openbd.title],
          ["シリーズ", openbd.series],
          ["著者", openbd.author],
          ["出版社", openbd.publisher],
          ["発行日", openbd.pubdate],
        ],
        "反映",
        () =>
          mfixFill(
            { title, volume_number: volume, creator: openbd.author, publisher: openbd.publisher, pubdate: openbd.pubdate },
            ["title", "volume_number", "creator", "publisher", "pubdate"]
          )
      )
    );
  } else {
    box.append(mfixSourceCard("openBD の書誌", [["", "この ISBN は openBD に無い（取れなかった）"]], "", null));
  }

  if (series) {
    const c = series.common;
    box.append(
      mfixSourceCard(
        `シリーズの手本（${series.name || series.id}・${series.volume_count}巻）`,
        c
          ? [
              ["書名", c.title],
              ["著者", c.creators || c.creator],
              ["出版社", [c.publisher, c.label].filter(Boolean).join(" / ")],
            ]
          : [["", "このシリーズに巻がありません"]],
        "揃える",
        c ? () => mfixFill(c, ["title", "creator", "creators", "publisher", "label"]) : null
      )
    );
  }
}

// ISBN（＋入力済みのシリーズ ID）で下書きの材料を引き直す。既に修正行があればフォームに入れる。
async function mfixDoLookup(opts = {}) {
  const isbn = $("mfixIsbn").value.trim();
  const msg = $("mfixLookupMsg");
  if (!isbn) {
    msg.textContent = "ISBN を入れてください";
    return;
  }
  msg.textContent = "調べています…";
  const series = $("mfixSeriesId").value.trim();
  let data;
  try {
    const res = await fetch(
      `/api/admin/master-fixes/lookup?isbn=${encodeURIComponent(isbn)}${series ? `&series=${encodeURIComponent(series)}` : ""}`
    );
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    msg.textContent = "取得に失敗しました: " + e.message;
    return;
  }

  mfixLookup = data;
  $("mfixIsbn").value = data.isbn;
  $("mfixEditor").hidden = false;
  $("mfixAdultWrap").hidden = !data.allow_adult;
  $("mfixSaveMsg").textContent = "";
  $("mfixSeriesName").textContent = data.series ? `${data.series.name}・${data.series.volume_count}巻` : "";

  // 初回（シリーズ欄の確認ではない）だけフォームを作り直す。既にある修正は編集として開き、
  // 無ければ今のマスタ行を下敷きにする（壊れている欄だけ直せばよくなる）。
  if (!opts.keepForm) {
    const base = data.fix || data.master || {};
    mfixSetForm({
      series_id: base.series_id ?? "",
      title: base.title ?? "",
      subtitle: base.subtitle ?? "",
      volume_number: base.volume_number ?? "",
      vol_sort: base.vol_sort ? String(base.vol_sort) : "",
      creator: base.creator ?? "",
      creators: base.creators ?? "",
      publisher: base.publisher ?? "",
      label: base.label ?? "",
      pubdate: base.pubdate ?? "",
      note: data.fix ? data.fix.note ?? "" : "",
      is_adult: !!base.is_adult,
    });
  }
  mfixRenderSources();
  msg.textContent = data.fix ? "この ISBN には既に修正があります（編集になります）" : "";
}

async function mfixSave(btn) {
  const payload = { isbn: $("mfixIsbn").value.trim(), is_adult: $("mfixIsAdult").checked };
  for (const [key, id] of Object.entries(MFIX_FIELDS)) payload[key] = $(id).value.trim();
  if (!payload.title) {
    $("mfixSaveMsg").textContent = "書名は必須です";
    return;
  }
  const where = payload.series_id ? `シリーズ ${payload.series_id}` : "シリーズ無し";
  if (
    !(await uiConfirm(
      `ISBN ${payload.isbn} のマスタ行を「${payload.title}${payload.volume_number ? ` ${payload.volume_number}` : ""}（${where}）」で差し替えます。` +
        `全ての閲覧者の検索・巻一覧・リスト表示に反映され、月次の取り込みのあとも載せ直されます。よろしいですか？`,
      { okLabel: "差し替える" }
    ))
  )
    return;

  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const res = await fetch("/api/admin/master-fixes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $("mfixEditor").hidden = true;
    $("mfixIsbn").value = "";
    $("mfixLookupMsg").textContent = "";
    mfixLookup = null;
    await loadMasterFixes(pageState.mfix);
  } catch (e) {
    $("mfixSaveMsg").textContent = "保存に失敗しました: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function mfixDelete(fix, btn) {
  const what =
    fix.restores === "restore"
      ? "差し替える前のマスタ行に戻します"
      : "この巻をマスタから消します（上流に無い巻を足した修正のため）";
  if (!(await uiConfirm(`ISBN ${fix.isbn} の修正を取り消し、${what}。よろしいですか？`, { danger: true, okLabel: "取り消す" })))
    return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "取り消し中…";
  try {
    const res = await fetch(`/api/admin/master-fixes/${encodeURIComponent(fix.isbn)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMasterFixes(pageState.mfix);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    uiAlert("取り消しに失敗しました: " + e.message);
  }
}

async function loadMasterFixes(page = pageState.mfix) {
  const table = $("mfixTable");
  const body = $("mfixBody");
  const hint = $("mfixHint");
  const count = $("mfixCount");
  body.textContent = "";
  hint.style.display = "none";
  table.style.display = "none";
  $("mfixPager").style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/admin/master-fixes?page=${page}&per=${PER}`);
    data = await res.json();
  } catch {
    hint.textContent = "マスタ行の修正の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  const fixes = data.fixes || [];
  const total = data.total ?? fixes.length;
  if (fixes.length === 0 && page > 1 && total > 0) {
    return loadMasterFixes(Math.min(page - 1, Math.max(1, Math.ceil(total / PER))));
  }
  pageState.mfix = page;
  count.textContent = `${total.toLocaleString("ja-JP")}件`;

  if (total === 0) {
    hint.textContent = "マスタ行の修正はまだありません。上の「ISBN で調べる」から直せます。";
    hint.style.display = "";
    return;
  }

  for (const f of fixes) {
    const editBtn = el("button", { textContent: "編集" });
    editBtn.addEventListener("click", () => {
      $("mfixIsbn").value = f.isbn;
      $("mfixSeriesId").value = f.series_id;
      mfixDoLookup();
      $("mfixIsbn").scrollIntoView({ block: "center" });
    });
    const delBtn = el("button", { className: "danger", textContent: "取り消し" });
    delBtn.addEventListener("click", () => mfixDelete(f, delBtn));

    const seriesLabel = f.series_name || f.series_id || "（シリーズ無し）";
    const seriesCell = el("td", { className: "owner", title: f.series_id });
    if (f.series_id) {
      const link = el("a", { className: "slug detail", textContent: seriesLabel, title: "このシリーズの巻一覧を表示" });
      link.addEventListener("click", () => openSeriesVolumes(f.series_id, seriesLabel));
      seriesCell.append(link);
    } else {
      seriesCell.textContent = seriesLabel;
    }

    const titleLine = [f.title, f.volume_number].filter(Boolean).join(" ");
    const sub = [f.creator, f.label, f.pubdate].filter(Boolean).join(" / ");

    body.append(
      el("tr", { dataset: { key: f.isbn } }, [
        el("td", null, [coverThumb(f.cover_url, "corr-thumb", "corr-noimg", f.title)]),
        el("td", { className: "slug", textContent: f.isbn }),
        el("td", { className: "owner" }, [
          el("div", { textContent: titleLine }),
          el("div", { className: "muted", textContent: sub }),
        ]),
        seriesCell,
        el("td", { className: "owner", textContent: f.note }),
        // applied=0 は「修正はあるのにマスタがその値になっていない」＝ 取り込みの載せ直しが
        // 抜けている合図。ここで気付けるように出す。
        el("td", { className: f.applied ? "" : "warn", textContent: f.applied ? "済" : "未反映" }),
        el("td", { textContent: fmtDate(f.created_at) }),
        el("td", { className: "report-actions" }, [editBtn, delBtn]),
      ])
    );
  }

  table.style.display = "";
  renderPager("mfixPager", page, total, loadMasterFixes);
}

$("mfixLookup").addEventListener("click", () => mfixDoLookup());
$("mfixIsbn").addEventListener("keydown", (e) => {
  if (e.key === "Enter") mfixDoLookup();
});
// シリーズ欄を直したら、そのシリーズの手本を引き直す（フォームの入力はそのまま）。
$("mfixSeriesCheck").addEventListener("click", () => mfixDoLookup({ keepForm: true }));
$("mfixSave").addEventListener("click", (e) => mfixSave(e.currentTarget));
$("mfixCancel").addEventListener("click", () => {
  $("mfixEditor").hidden = true;
  $("mfixSaveMsg").textContent = "";
  mfixLookup = null;
});
$("reloadMfix").addEventListener("click", () => loadMasterFixes(pageState.mfix));

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
  "series-merges": () => setMergeMode(mergeMode),
  "series-tags": () => loadSeriesTagRequests(1),
  labels: () => loadLabels(),
  "volume-title-reports": () => {
    resetHistory("volumeTitleReports");
    loadVolumeTitleReports(1);
  },
  corrections: () => {
    resetHistory("corrections");
    loadCorrections(1);
  },
  "master-fixes": () => {
    $("mfixEditor").hidden = true;
    $("mfixIsbn").value = "";
    $("mfixLookupMsg").textContent = "";
    loadMasterFixes(1);
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
  "sales-ranking": () => loadSales(),
  circulation: () => loadCirculation(),
  warm: () => loadWarm(),
  "dev-tools": () => {},
};

/* ---------- 売上ランキング ---------- */
// 取得状況（Cron が止まっていないか）・手動の取得/再集計・リンクが付かなかった作品の一覧。
async function loadSales() {
  const stats = $("salesStats");
  const hint = $("salesHint");
  stats.textContent = "";
  hint.style.display = "none";
  $("salesDaysTable").style.display = "none";
  $("salesUnlinkedTable").style.display = "none";
  $("salesDaysBody").textContent = "";
  $("salesUnlinkedBody").textContent = "";

  let data;
  try {
    const res = await fetch("/api/admin/sales-ranking");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    hint.textContent = "売上ランキングの状況の取得に失敗しました";
    hint.style.display = "";
    return;
  }

  // 最新の取得日が今日（JST）でなければ Cron が止まっている可能性がある。
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const stale = data.days.length > 0 && data.days[0].day !== today;
  $("salesSummary").textContent = data.total_days
    ? `${data.first_day} から ${data.total_days} 日分（${data.total_rows.toLocaleString("ja-JP")} 行）`
    : "まだ取得していません";

  const linked = (w) => {
    const [n, total] = data.linked[w] || [0, 0];
    return total ? `${n} / ${total}` : "-";
  };
  const cards = [
    [
      data.days[0]?.day || "-",
      stale
        ? "最新の取得日（今日の分が未取得）"
        : data.cron_day === data.days[0]?.day
          ? "最新の取得日（Cron で取得）"
          : "最新の取得日（手動。05:00 の Cron で置き換え）",
    ],
    [fmtDate(data.computed_at).slice(5), "最後に集計した時刻"],
    [linked("day"), "リンク付き（日次）"],
    [linked("year"), "リンク付き（年間）"],
  ];
  for (const [n, k] of cards) {
    stats.append(
      el("div", { className: "stat-card" + (stale && k.startsWith("最新") ? " warn" : "") }, [
        el("div", { className: "n", textContent: n }),
        el("div", { className: "k", textContent: k }),
      ])
    );
  }

  if (data.days.length) {
    for (const d of data.days) {
      $("salesDaysBody").append(
        el("tr", {}, [
          el("td", { textContent: d.day }),
          el("td", { className: "num", textContent: String(d.count) }),
        ])
      );
    }
    $("salesDaysTable").style.display = "";
  }

  $("salesUnlinkedCount").textContent = `${data.unlinked.length} 件`;
  if (!data.unlinked.length) {
    hint.textContent = data.total_days ? "リンクが付かなかった作品はありません。" : "";
    hint.style.display = data.total_days ? "" : "none";
    return;
  }
  for (const u of data.unlinked) {
    const rank = (w) => el("td", { className: "num" + (u.ranks[w] ? "" : " muted"), textContent: u.ranks[w] ? `${u.ranks[w]}位` : "-" });
    // トップの検索画面を作品名の先頭の語で開く（/?q=）。マスタに居るか・どんな書名で居るかの確認用。
    const search = el("a", {
      href: `/?q=${encodeURIComponent(u.search_q || u.work)}`,
      target: "_blank",
      textContent: "検索",
    });
    $("salesUnlinkedBody").append(
      el("tr", {}, [
        el("td", { className: "wrap" }, [
          el("div", { textContent: u.work }),
          el("div", { className: "muted", style: "font-size:12px", textContent: u.author.replace(/\//g, "・") }),
        ]),
        el("td", { className: "wrap muted", textContent: u.title }),
        rank("day"),
        rank("d7"),
        rank("d30"),
        rank("year"),
        el("td", {}, [search]),
      ])
    );
  }
  $("salesUnlinkedTable").style.display = "";
}

async function runSales(recompute, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = recompute ? "集計中…" : "取得中…（30秒ほど）";
  try {
    const res = await fetch(`/api/admin/sales-ranking/snapshot${recompute ? "?recompute=1" : ""}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.skipped === "cron_done") {
      uiAlert(`${data.day} の分は 05:00 の Cron で取得済みです。データを揃えるため、手動では取り直しません。`);
      return;
    }
    if (!data.ok) throw new Error("楽天から取得できませんでした（レート制限・認証情報を確認してください）");
    uiAlert(recompute ? "再集計しました。" : `${data.day} の分を ${data.count} 件取得して集計しました。`);
    await loadSales();
  } catch (e) {
    uiAlert((recompute ? "再集計" : "取得") + "に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

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
  // スマホではナビが横スクロールなので、選んだページのタブを見える位置へ寄せる。
  const nav = $("adminNav");
  const active = nav.querySelector("a.active");
  if (active && nav.scrollWidth > nav.clientWidth) {
    nav.scrollLeft = active.offsetLeft - nav.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
  }
  PAGES[name]();
  loadTodo();
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
$("reloadMerge").addEventListener("click", () => loadMerge(pageState.merge));
document.querySelectorAll(".merge-mode").forEach((b) => {
  b.addEventListener("click", () => setMergeMode(b.dataset.mergeMode));
});
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
/* ---------- 発行部数ランキング ---------- */
// Wikipedia 由来の累計発行部数（src/circulation.ts）。取り込みそのものはローカルの
// scripts/wikipedia-circulation.mjs → db/circulation-data.sql なので、ここからは
// 寄せ直し（再集計）と、リンクが付かなかった作品の確認だけ。
let circRows = [];
let circPickArticle = "";

async function loadCirculation() {
  const stats = $("circStats");
  stats.textContent = "";
  $("circStates").textContent = "";
  $("circRowsBody").textContent = "";
  $("circRowsTable").style.display = "none";
  $("circSource").textContent = "";

  let data;
  try {
    const res = await fetch("/api/admin/circulation");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    $("circSummary").textContent = "状況の取得に失敗しました";
    return;
  }
  circRows = data.rows || [];

  const [linked, total] = data.linked || [0, 0];
  $("circSummary").textContent = data.works
    ? `${data.works} 作品（取り込み ${fmtDate(data.updated_at).slice(0, 10)}）`
    : "まだ取り込んでいません";
  const cards = [
    [String(data.works), "取り込んだ作品数"],
    [total ? `${linked} / ${total}` : "-", "巻一覧へのリンク付き"],
    [data.computed_at ? fmtDate(data.computed_at).slice(5) : "-", "最後に集計した時刻"],
  ];
  for (const [n, k] of cards) {
    stats.append(
      el("div", { className: "stat-card" }, [
        el("div", { className: "n", textContent: n }),
        el("div", { className: "k", textContent: k }),
      ])
    );
  }

  if (data.source) {
    $("circSource").append(
      document.createTextNode("出典: "),
      el("a", { href: data.source.url, target: "_blank", textContent: data.source.title }),
      document.createTextNode(
        `（oldid ${data.source.revid} / 記事の更新 ${data.source.touched} / 取得 ${data.source.retrieved}・${data.source.license}）`
      )
    );
  }

  // 要確認（auto / none / stale）は目立たせる。
  const st = data.states || {};
  for (const [key, label] of [
    ["manual", "手動で指定"],
    ["suggested", "サジェストのまま"],
    ["auto", "指定なし（自動照合）"],
    ["skipped", "寄せない"],
    ["none", "寄せ先なし"],
    ["stale", "指定先が見つからない"],
  ]) {
    const n = st[key] || 0;
    if (!n && (key === "stale" || key === "none" || key === "skipped")) continue;
    $("circStates").append(
      el("div", { className: "stat-card" + (n && (key === "stale" || key === "none") ? " warn" : "") }, [
        el("div", { className: "n", textContent: String(n) }),
        el("div", { className: "k", textContent: label }),
      ])
    );
  }
  // 寄せ先のレーベルにタグ（廉価版・文庫版・傑作選）が付いている行。状態（manual /
  // suggested …）とは別の軸なので、サーバの states ではなく行から数えて 1 枚足す。
  const tagged = circRows.filter((r) => r.series_label_tag).length;
  if (tagged) {
    $("circStates").append(
      el("div", { className: "stat-card warn" }, [
        el("div", { className: "n", textContent: String(tagged) }),
        el("div", { className: "k", textContent: "寄せ先が廉価版・文庫版・傑作選" }),
      ])
    );
  }
  renderCircRows();
}

const CIRC_STATE_LABEL = {
  manual: "手動",
  suggested: "サジェスト",
  auto: "指定なし",
  none: "寄せ先なし",
  skipped: "寄せない",
  stale: "指定先が見つからない",
};
// 目で確かめたいもの。サジェストのままでも問題は無いので、ここには入れない。
const CIRC_ISSUE = new Set(["auto", "none", "stale"]);

// 「要確認だけ」で残す行。状態のほかに、寄せ先のレーベルにタグ（廉価版・文庫版・傑作選）が
// 付いているものも含める ー 状態としては正常（サジェスト / 手動）でも、ランキングから開きたい
// 本編の単行本ではない可能性が高く、200 行の中から印を目で探すのは現実的でないため。
const circNeedsCheck = (r) => CIRC_ISSUE.has(r.state) || Boolean(r.series_label_tag);

function renderCircRows() {
  const onlyIssues = $("circOnlyIssues").checked;
  const rows = onlyIssues ? circRows.filter(circNeedsCheck) : circRows;
  const body = $("circRowsBody");
  body.textContent = "";
  $("circRowsCount").textContent = onlyIssues ? `${rows.length} / ${circRows.length} 件` : `${circRows.length} 件`;

  for (const r of rows) {
    // 寄せ先のレーベルに付いたタグ（廉価版・文庫版・傑作選）は、寄せ先が本編の単行本かを
    // 疑うしるしなので一覧に出す（ランキングから開きたいのは本編）。
    const targetMeta = el("div", {
      className: "muted",
      style: "font-size:12px",
      textContent: [r.series_label, r.volume_count ? `${r.volume_count}巻` : ""].filter(Boolean).join(" / "),
    });
    const targetTag = labelTagBadge(r.series_label_tag);
    if (targetTag) targetMeta.append(targetTag);
    const target = r.series_id
      ? el("div", {}, [
          el("a", {
            href: `/?series=${encodeURIComponent(r.series_id)}&st=${encodeURIComponent(r.title)}`,
            target: "_blank",
            textContent: r.series_name || r.series_id,
          }),
          targetMeta,
        ])
      : el("a", {
          href: `/?q=${encodeURIComponent(r.search_q || r.title)}`,
          target: "_blank",
          className: "muted",
          textContent: "（検索結果へ）",
        });

    const actions = el("div", { className: "cover-actions", style: "gap:6px;margin:0" }, [
      el("button", { type: "button", textContent: "変更", onclick: () => openCircPick(r) }),
      el("button", {
        type: "button",
        textContent: "寄せない",
        disabled: r.state === "skipped",
        onclick: () => setCircLink(r.article, "", `「${r.title}」を寄せないことにしますか？`),
      }),
      el("button", {
        type: "button",
        textContent: "戻す",
        disabled: r.state === "auto" || r.state === "none",
        title: "指定を外し、自動照合をやり直してサジェストに戻す",
        onclick: () =>
          setCircLink(r.article, null, `「${r.title}」の指定を外して、自動照合の結果（サジェスト）に戻しますか？`),
      }),
    ]);

    body.append(
      el("tr", {}, [
        el("td", { className: "num", textContent: `${r.rank}位` }),
        el("td", { className: "wrap" }, [
          el("div", { textContent: r.title }),
          el("div", { className: "muted", style: "font-size:12px", textContent: `${r.title_en} / ${r.author}` }),
        ]),
        el("td", { className: "wrap" }, [target]),
        el("td", {
          className: circNeedsCheck(r) ? "" : "muted",
          textContent: CIRC_STATE_LABEL[r.state] || r.state,
        }),
        el("td", {}, [actions]),
      ])
    );
  }
  $("circRowsTable").style.display = rows.length ? "" : "none";
}

// 寄せ先を選ぶダイアログ。候補は公開の検索 API（/api/search）をそのまま使う。
function openCircPick(row) {
  circPickArticle = row.article;
  $("circPickTitle").textContent = `「${row.title}」の寄せ先を選ぶ`;
  $("circPickQuery").value = row.title;
  $("circPickHint").textContent = "";
  $("circPickBody").textContent = "";
  $("circPickTable").style.display = "none";
  $("circPickDlg").showModal();
  runCircPickSearch();
}

async function runCircPickSearch() {
  const q = $("circPickQuery").value.trim();
  const hint = $("circPickHint");
  const body = $("circPickBody");
  body.textContent = "";
  $("circPickTable").style.display = "none";
  if (q.length < 2) {
    hint.textContent = "検索語を 2 文字以上で入力してください";
    return;
  }
  hint.textContent = "検索中…";
  let results;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    results = (data.results || []).filter((x) => x.series_id);
  } catch (e) {
    hint.textContent = "検索に失敗しました: " + e.message;
    return;
  }
  hint.textContent = results.length ? "" : "見つかりませんでした。語を短くして試してください。";
  for (const r of results) {
    // レーベルのタグ（廉価版・文庫版・傑作選）は、同名で並ぶ候補のどれが本編かの手がかりに
    // なるので候補にも出す（検索 API がシリーズ行と一緒に返している。src/search.ts）。
    const labelCell = el("td", { className: "wrap muted", textContent: r.label || "" });
    const tag = labelTagBadge(r.label_tag);
    if (tag) labelCell.append(tag);
    body.append(
      el("tr", {}, [
        el("td", { className: "wrap", textContent: r.title }),
        el("td", { className: "wrap muted", textContent: r.creators || r.creator || "" }),
        labelCell,
        el("td", { className: "num", textContent: String(r.volume_count ?? "") }),
        el("td", {}, [
          el("button", {
            type: "button",
            textContent: "巻",
            title: "このシリーズの巻を見る",
            onclick: () => openCircVols(r.series_id, r.title),
          }),
          el("button", {
            type: "button",
            textContent: "これにする",
            style: "margin-left:6px",
            onclick: () => {
              $("circPickDlg").close();
              setCircLink(circPickArticle, r.series_id, "");
            },
          }),
        ]),
      ])
    );
  }
  $("circPickTable").style.display = results.length ? "" : "none";
}

// 候補の巻を、寄せ先モーダルに重ねて見せる。同名のシリーズが並んだときに「どれが本編か」は
// レーベルと巻数だけでは決めきれない（新装版・大判・傑作選が同じ名前で並ぶ）ので、巻の書名と
// 発行日と表紙まで見てから選べるようにしてある。巻一覧は公開 API をそのまま使う（まとまりの
// G-id も同じ経路で開ける）。表紙はキャッシュにあるものだけ（管理用途には十分）。
async function openCircVols(seriesId, label) {
  const grid = $("circVolsGrid");
  const meta = $("circVolsMeta");
  grid.textContent = "";
  meta.textContent = "読み込み中…";
  $("circVolsTitle").textContent = label || seriesId;
  $("circVolsDlg").showModal();

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
  const creator = data.creators || data.creator || "";
  $("circVolsTitle").textContent = data.title || label || seriesId;
  meta.textContent = [creator, `${vols.length}巻`, `series_id: ${seriesId}`].filter(Boolean).join(" ｜ ");
  const tag = labelTagBadge(data.label_tag);
  if (tag) meta.append(tag);
  if (!vols.length) {
    grid.append(el("p", { className: "hint", textContent: "巻が見つかりませんでした。" }));
    return;
  }
  // 本の詳細（div のオーバーレイ）は dialog の後ろに出てしまうので、ここでは押せなくする。
  for (const v of vols) grid.append(volumeDetailItem(v, null));
}

/** series_id: 文字列 = そこへ寄せる / "" = 寄せない / null = 指定を外す。 */
async function setCircLink(article, seriesId, confirmMsg) {
  if (confirmMsg && !(await uiConfirm(confirmMsg))) return;
  try {
    const res = await fetch("/api/admin/circulation/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ article, series_id: seriesId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadCirculation();
  } catch (e) {
    uiAlert("指定に失敗しました: " + e.message);
  }
}

// 既存の指定には触らず、指定の無い作品だけ自動照合で埋める。サジェストのままの行も付け直す
// （マスタを取り込み直して寄せ先が変わったとき）のは、?overwrite=1 を付けて叩く運用にしてある
// ー 画面から押せると、確かめずに全部を入れ直してしまいやすいため。
async function runCirculationSuggest(btn) {
  if (!(await uiConfirm("指定の無い作品を自動照合して埋めます。手動で指定したものは変わりません。"))) return;
  await postAdminAction(
    "/api/admin/circulation/suggest",
    btn,
    "取り込み中…（1分ほど）",
    (d) => `${d.added} 件を埋めました（既存の指定 ${d.kept} 件はそのまま）。リンク付き ${d.linked} / ${d.works}。`,
    loadCirculation
  );
}

async function runCirculationRecompute(btn) {
  await postAdminAction(
    "/api/admin/circulation/recompute",
    btn,
    "集計中…（1分ほど）",
    (d) => `${d.works} 作品を集計し、${d.linked} 件に巻一覧へのリンクが付きました。`,
    loadCirculation
  );
}

// サジェストの前方一致索引（series_suggest）の作り直し。取り込みと同じ SQL を D1 の中で流すので、
// 押してから数秒かかる（13 万シリーズ → 24 万行）。失敗しても今の索引はそのまま残る
// （src/suggest.ts が shadow テーブルに作ってから入れ替えるため）。
async function rebuildSuggestIndex(btn) {
  await postAdminAction(
    "/api/admin/suggest/rebuild",
    btn,
    "再構築中…",
    (d) => `サジェスト索引を作り直しました（${d.rows} 行）。`
  );
}

// 押している間だけボタンを潰す admin の POST 1 回。応答の JSON から出す文言を message(data) で
// 受け取り、終わったら after()（表の読み直しなど。要らなければ省略）を走らせる。
async function postAdminAction(url, btn, busyLabel, message, after) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    const res = await fetch(url, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiAlert(message(data));
    if (after) await after();
  } catch (e) {
    uiAlert("失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/* ---------- キャッシュ暖機 ---------- */
// 楽天の枠（サイト全体で約 1 件/秒）に合わせて「次の数件」を繰り返し頼むループ（src/warm.ts）。
// 進捗は covers 表で判断するので、止めても同じ対象を選び直せば続きから進む。
let warmRunning = false;

async function loadWarm() {
  const stats = $("warmStats");
  stats.textContent = "";
  let data;
  try {
    const res = await fetch("/api/admin/warm");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    $("warmSummary").textContent = "状況の取得に失敗しました";
    return;
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  $("warmSummary").textContent = `${data.covers.toLocaleString("ja-JP")} / ${data.volumes.toLocaleString("ja-JP")} 巻`;
  const cards = [
    [pct(data.scopes.circulation.warmed, data.scopes.circulation.volumes), "発行部数ランキングの巻"],
    [pct(data.scopes.sales.warmed, data.scopes.sales.volumes), "売上ランキングの巻"],
    [data.covers_found.toLocaleString("ja-JP"), "表紙が見つかった巻"],
    [data.book_meta.toLocaleString("ja-JP"), "あらすじ等を取得した巻"],
  ];
  for (const [n, k] of cards) {
    stats.append(
      el("div", { className: "stat-card" }, [
        el("div", { className: "n", textContent: n }),
        el("div", { className: "k", textContent: k }),
      ])
    );
  }
}

async function warmLoop() {
  const scope = $("warmScope").value;
  const progress = $("warmProgress");
  let cursor = "";
  let cached = 0;
  let idle = 0;
  const started = Date.now();

  while (warmRunning) {
    const q = new URLSearchParams({ scope, limit: "8" });
    if (cursor) q.set("cursor", cursor);
    let r;
    try {
      const res = await fetch(`/api/admin/warm?${q}`, { method: "POST" });
      r = await res.json();
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    } catch (e) {
      progress.textContent = `中断しました: ${e.message}`;
      break;
    }
    // 閲覧者が表紙を取得中。暖機は譲って待つ（進捗ゼロとして数えない）。
    if (r.paused) {
      progress.textContent = `${cached} 件 / 表紙を取得中の人がいるので待機中（${r.paused} 人）`;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    cached += r.cached;
    cursor = r.cursor || "";
    if (r.done) {
      progress.textContent = `完了: ${cached} 件を新たにキャッシュしました。`;
      break;
    }
    // 進まない要求が続いたら止める（楽天が落ちている・枠が取れない）。
    idle = r.cached > 0 || (r.attempted === 0 && cursor) ? 0 : idle + 1;
    if (idle >= 5) {
      progress.textContent = `進まなくなったので中断しました（${cached} 件）。時間をおいて再開してください。`;
      break;
    }
    const sec = Math.round((Date.now() - started) / 1000);
    progress.textContent = `${cached} 件 / ${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`;
  }

  warmRunning = false;
  $("warmStart").disabled = false;
  $("warmStop").disabled = true;
  $("warmScope").disabled = false;
  await loadWarm();
}

$("purgeSupAll").addEventListener("click", (e) => purgeSupplements("all", e.currentTarget));
$("delSup").addEventListener("click", (e) => deleteSupplement(e.currentTarget));
$("reloadSales").addEventListener("click", () => loadSales());
$("salesSnapshot").addEventListener("click", (e) => runSales(false, e.currentTarget));
$("salesRecompute").addEventListener("click", (e) => runSales(true, e.currentTarget));
$("reloadCirc").addEventListener("click", () => loadCirculation());
$("suggestRebuild").addEventListener("click", (e) => rebuildSuggestIndex(e.currentTarget));
$("circRecompute").addEventListener("click", (e) => runCirculationRecompute(e.currentTarget));
$("circSuggest").addEventListener("click", (e) => runCirculationSuggest(e.currentTarget));
$("circOnlyIssues").addEventListener("change", () => renderCircRows());
$("circPickSearch").addEventListener("click", () => runCircPickSearch());
$("circPickQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runCircPickSearch();
  }
});
// 寄せ先の検索欄にも入力補完を付ける（public/suggest.js）。候補を選んだらそのまま検索する。
attachSuggest($("circPickQuery"), { onPick: () => runCircPickSearch() });
$("reloadWarm").addEventListener("click", () => loadWarm());
$("warmStart").addEventListener("click", () => {
  if (warmRunning) return;
  warmRunning = true;
  $("warmStart").disabled = true;
  $("warmStop").disabled = false;
  $("warmScope").disabled = true;
  $("warmProgress").textContent = "開始しました…";
  warmLoop();
});
$("warmStop").addEventListener("click", () => {
  warmRunning = false;
  $("warmStop").disabled = true;
  $("warmProgress").textContent += "（停止中…現在の要求が終わるまで待ちます）";
});
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
// 作品名での絞り込みに入力補完を付ける（著者・出版社・ISBN でも引けるので、候補は補助扱い）。
attachSuggest($("bookMetaQuery"), { onPick: () => runBookMetaSearch() });
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
    // 巻一覧の上に本の詳細（book-detail.js）が重なっていれば、そちらだけを閉じる（自前で閉じる）。
    if (!$("bookDetailModal")?.classList.contains("open")) closeDetail();
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
