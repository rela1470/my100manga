"use strict";

// スマホで扱いづらいブラウザ標準の alert/confirm/prompt を、サイト内モーダルに置き換える。
// Promise ベースで、呼び出し側は await uiConfirm(...) のように同期的な見た目で書ける。
// window.uiAlert / uiConfirm / uiPrompt として公開する。
// uiPrompt は opts.validate(value) を渡すと、エラー文言（文字列）を返す間は決定できない。
(function () {
  let host = null;
  let msgEl = null;
  let inputEl = null;
  let errorEl = null;
  let okBtn = null;
  let cancelBtn = null;
  let current = null; // { resolve, mode, validate }

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.className = "ui-dialog-backdrop";
    host.innerHTML =
      '<div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="uiDialogMsg">' +
      '<p class="ui-dialog-msg" id="uiDialogMsg"></p>' +
      '<input type="text" class="ui-dialog-input" style="display:none">' +
      '<p class="ui-dialog-error" role="alert" style="display:none"></p>' +
      '<div class="ui-dialog-actions">' +
      '<button type="button" class="ui-dialog-cancel"></button>' +
      '<button type="button" class="ui-dialog-ok"></button>' +
      "</div></div>";
    document.body.appendChild(host);
    msgEl = host.querySelector(".ui-dialog-msg");
    inputEl = host.querySelector(".ui-dialog-input");
    errorEl = host.querySelector(".ui-dialog-error");
    okBtn = host.querySelector(".ui-dialog-ok");
    cancelBtn = host.querySelector(".ui-dialog-cancel");

    okBtn.addEventListener("click", () => settle(true));
    cancelBtn.addEventListener("click", () => settle(false));
    // 背景クリックで閉じる（キャンセル扱い）。
    host.addEventListener("click", (e) => {
      if (e.target === host) settle(false);
    });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      }
      // Enter での決定はしない（IME 確定や編集中の誤送信を防ぐ）。決定は OK ボタンのみ。
      // confirm/alert は OK ボタンにフォーカスがあるので、ブラウザ標準の Enter=クリックは効く。
    });
    inputEl.addEventListener("input", validate);
  }

  // prompt の入力値を検証し、エラー表示と OK ボタンの可否を更新する。決定してよければ true。
  function validate() {
    const msg = current && current.validate ? current.validate(inputEl.value) || "" : "";
    errorEl.textContent = msg;
    errorEl.style.display = msg ? "" : "none";
    okBtn.disabled = !!msg;
    return !msg;
  }

  function settle(ok) {
    if (!current) return;
    if (ok && current.mode === "prompt" && !validate()) return;
    const { resolve, mode } = current;
    current = null;
    host.classList.remove("open");
    let result;
    if (mode === "alert") result = undefined;
    else if (mode === "confirm") result = ok;
    else result = ok ? inputEl.value : null; // prompt
    resolve(result);
  }

  // ネイティブの <dialog>（showModal）が開いていると、その外の要素は top layer の下に隠れ、
  // 操作もできない（inert）。管理画面の補正ダイアログから uiPrompt 等を呼ぶとこうなるので、
  // 最前面のモーダル dialog（フォーカスのあるもの。無ければ文書順で最後）の中に移して出す。
  // 無ければ body に戻す。
  function placeHost() {
    let modal = null;
    try {
      const active = document.activeElement;
      modal = (active && active.closest("dialog:modal")) || [...document.querySelectorAll("dialog:modal")].pop() || null;
    } catch (e) {
      modal = null; // :modal 未対応のブラウザ
    }
    const parent = modal || document.body;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function open(mode, message, opts) {
    build();
    placeHost();
    opts = opts || {};
    msgEl.textContent = message == null ? "" : String(message);

    if (mode === "prompt") {
      inputEl.style.display = "";
      inputEl.value = opts.defaultValue != null ? String(opts.defaultValue) : "";
      if (opts.placeholder) inputEl.placeholder = opts.placeholder;
      else inputEl.removeAttribute("placeholder");
    } else {
      inputEl.style.display = "none";
    }

    const showCancel = mode !== "alert";
    cancelBtn.style.display = showCancel ? "" : "none";
    cancelBtn.textContent = opts.cancelLabel || "キャンセル";
    okBtn.textContent = opts.okLabel || "OK";
    okBtn.className = "ui-dialog-ok" + (opts.danger ? " danger" : " primary");

    host.classList.add("open");

    return new Promise((resolve) => {
      current = { resolve, mode, validate: mode === "prompt" ? opts.validate : null };
      validate();
      // フォーカスを移す。prompt は入力欄、それ以外は OK ボタン。
      requestAnimationFrame(() => {
        if (mode === "prompt") {
          inputEl.focus();
          inputEl.select();
        } else {
          okBtn.focus();
        }
      });
    });
  }

  window.uiAlert = (message, opts) => open("alert", message, opts);
  window.uiConfirm = (message, opts) => open("confirm", message, opts);
  window.uiPrompt = (message, defaultValue, opts) =>
    open("prompt", message, Object.assign({ defaultValue }, opts));
})();

// 背面スクロールのロック。モーダルが1つでも開いている間は <body> を position:fixed で
// 固定し、閉じたら元のスクロール位置へ戻す。iOS Safari は overflow:hidden だけでは背面
// スクロールを止められないため JS で固定する。class の付け外しを監視して自動で適用する。
(function () {
  const SELECTOR = ".modal-backdrop.open, .ui-dialog-backdrop.open";
  let lockedY = 0;
  let locked = false;

  function apply() {
    const open = !!document.querySelector(SELECTOR);
    if (open === locked) return;
    const body = document.body;
    if (open) {
      lockedY = window.scrollY || window.pageYOffset || 0;
      body.style.position = "fixed";
      body.style.top = `-${lockedY}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      locked = true;
    } else {
      body.style.position = "";
      body.style.top = "";
      body.style.left = "";
      body.style.right = "";
      body.style.width = "";
      window.scrollTo(0, lockedY);
      locked = false;
    }
  }

  function start() {
    new MutationObserver(apply).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    apply();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

// モーダル（.modal-backdrop）のアクセシビリティを各ページ共通でそろえる。開閉は各ページの
// JS が class "open" を付け外しするだけなので、背面スクロールのロックと同じく class の変化を
// 監視して後付けする。
// - 開いたとき: 中のパネル（.modal）に role="dialog" / aria-modal / aria-labelledby（最初の
//   h2）を付け、フォーカスをパネルへ移す（入力欄に移すとスマホでキーボードが勝手に開くので
//   パネル自体。開く側がすでに入力欄などへ移していればそのまま）。
// - 開いている間: Tab / Shift+Tab を最前面のダイアログ内で循環させる。
// - Esc: 最前面の .modal-backdrop に "modal-escape" イベント（cancelable）を投げ、誰も
//   preventDefault しなければ、各モーダルが持つ閉じ処理（backdrop 自身への click を合図に
//   しているもの）に乗せる。Esc で閉じたくないモーダル（公開後の共有モーダル等）は
//   modal-escape を受けて自前で処理する。
// - 背景クリック: 閉じない（サイト全体。下の capture の click で人のクリックだけ止めている）。
// - 閉じたとき: 開く前にフォーカスがあった要素へ戻す。
// - ブラウザバック: 開いている間だけ履歴を積み、戻る操作で最前面から閉じる（下の syncHistory）。
// ui-dialog（uiAlert 等）や share-x.js のパネル（.ui-dialog-backdrop）も重なり順と Tab の
// 循環・フォーカスの戻しには含めるが、フォーカス移動と Esc はそれぞれが自前で行う。
(function () {
  const MODAL = ".modal-backdrop";
  const ANY = ".modal-backdrop, .ui-dialog-backdrop";
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const stack = []; // 開いた順。[{ el: backdrop, restore: 開く前のフォーカス }]
  let uid = 0;

  const panelOf = (backdrop) => backdrop.querySelector(".modal, .ui-dialog") || backdrop;
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  function decorate(backdrop) {
    if (!backdrop.matches(MODAL)) return;
    const panel = panelOf(backdrop);
    if (panel.getAttribute("role") === "dialog") return;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("tabindex", "-1");
    const h = panel.querySelector("h2");
    if (h) {
      if (!h.id) h.id = `modalTitle${++uid}`;
      panel.setAttribute("aria-labelledby", h.id);
    }
  }

  function onOpen(backdrop) {
    decorate(backdrop);
    stack.push({ el: backdrop, restore: document.activeElement });
    if (!backdrop.matches(MODAL)) return;
    const panel = panelOf(backdrop);
    if (panel.contains(document.activeElement)) return;
    panel.focus({ preventScroll: true });
  }

  function onClose(backdrop) {
    const i = stack.findIndex((s) => s.el === backdrop);
    if (i < 0) return;
    const { restore } = stack.splice(i, 1)[0];
    if (i !== stack.length) return; // 最前面ではなかった（上のダイアログにフォーカスを残す）
    if (restore && restore !== document.body && document.contains(restore) && visible(restore)) {
      restore.focus({ preventScroll: true });
    }
  }

  function trap(e, panel) {
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter(visible);
    const active = document.activeElement;
    if (!items.length) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  // 背景（モーダルの外）のクリックでは閉じない。サイト全体でこの扱いにそろえる（押し間違いで
  // 書きかけの入力ごと閉じてしまうのを防ぐ）。閉じ処理そのものは各モーダルが backdrop 自身への
  // click を合図に持っているので、ここでは人のクリックだけを止める。Esc とブラウザバックは
  // el.click() でその合図を作って同じ閉じ処理に乗せており、そちらは isTrusted が false なので通す。
  // mousedown も既定の動作を止める: 背景を押すとフォーカスが <body> へ抜けてしまい、自前の
  // keydown で Esc を見ているダイアログ（uiAlert 等・share-x）が Esc で閉じられなくなるため。
  // 例外: backdrop に data-backdrop-close が付いているものは今までどおり背景クリックで閉じる。
  // 失うものが無く、暗いところを押して閉じるのが当たり前の表示（表紙の拡大。cover-zoom.js）用。
  const onBackdrop = (e) =>
    e.isTrusted &&
    e.target instanceof Element &&
    e.target.matches(ANY) &&
    !e.target.hasAttribute("data-backdrop-close");
  document.addEventListener("mousedown", (e) => { if (onBackdrop(e)) e.preventDefault(); }, true);
  document.addEventListener(
    "click",
    (e) => {
      if (!onBackdrop(e)) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    const top = stack[stack.length - 1];
    if (!top || !top.el.classList.contains("open")) return;
    if (e.key === "Tab") {
      trap(e, panelOf(top.el));
    } else if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && top.el.matches(MODAL)) {
      e.preventDefault();
      const ev = new CustomEvent("modal-escape", { cancelable: true });
      top.el.dispatchEvent(ev);
      if (!ev.defaultPrevented) top.el.click(); // 各モーダルの閉じ処理の合図（target が backdrop 自身）
    }
  });

  // ブラウザバック（スマホの「戻る」）でモーダルを閉じる。開いている数だけ同じ URL の履歴を
  // 積み、その深さを state の __modal に書いておく。戻る操作ではその深さまで最前面から順に
  // 閉じ、画面内のボタンで閉じたときは積んだぶんを history.go で戻して履歴に残さない。
  // 閉じ方はモーダルごとに違うので、Esc を投げて各自の閉じ処理（上の keydown 経由の
  // modal-escape / backdrop への click、ui-dialog や share-x の自前 keydown）に乗せる。共有
  // モーダルのように確認を挟んですぐ閉じないものは開いたままになるので、履歴を積み直す。
  const OPEN = ".modal-backdrop.open, .ui-dialog-backdrop.open";
  let pushed = 0; // 自分が積んだ履歴の数
  let awaitingPop = false; // history.go を頼んで popstate 待ち
  let popTimer = 0;

  // 積んでいる間だけスクロール位置の復元を手動にする。背面スクロールのロック（上）は
  // <body> を position:fixed にするので、履歴を積む時点のスクロール位置は 0。auto のままだと、
  // 閉じたときの history.go（と「戻る」操作）でブラウザがその 0 を復元し、ロック解除時の
  // scrollTo を上書きして一番上へ飛ぶ。位置の戻しはロック側に任せる。
  // 復元モードは履歴項目ごとなので、最初に積む前（＝元の項目にいるうち）に manual にする。
  let savedRestoration = null;
  function holdScrollRestoration() {
    if (savedRestoration !== null) return;
    try {
      savedRestoration = history.scrollRestoration;
      history.scrollRestoration = "manual";
    } catch (e) {
      savedRestoration = null;
    }
  }
  function releaseScrollRestoration() {
    if (savedRestoration === null) return;
    const prev = savedRestoration;
    savedRestoration = null;
    // 戻り着いた直後（popstate と同じタスク）に戻すと、そのままブラウザが復元してしまうので
    // 次のタスクで戻す。以後はページ間の「戻る」で元どおり位置が復元される。
    setTimeout(() => {
      try {
        history.scrollRestoration = prev;
      } catch (e) {
        /* 無視 */
      }
    }, 0);
  }

  const openCount = () => document.querySelectorAll(OPEN).length;
  const markedDepth = () => (history.state && history.state.__modal) || 0;

  // 最前面の開いているモーダル。開いた順を覚えている stack の最後を使う。stack に無いもの
  // （開いた状態で作られて body の末尾に足されるダイアログ。account.js）はそれより後なので優先する。
  function topOpen() {
    const open = [...document.querySelectorAll(OPEN)];
    if (!open.length) return null;
    const unknown = open.filter((el) => !stack.some((s) => s.el === el));
    if (unknown.length) return unknown[unknown.length - 1];
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].el.classList.contains("open")) return stack[i].el;
    }
    return open[open.length - 1];
  }

  // 開いている数と積んだ履歴の数を合わせる。開閉のたびに呼ぶ（class 変化の監視から）。
  // history.go は非同期なので、戻している最中は何もしない（着地した popstate でやり直す）。
  // 数合わせを重ねて要求すると、戻りすぎて前のページまで出てしまう。
  function syncHistory() {
    if (awaitingPop) return;
    const open = openCount();
    if (pushed < open) holdScrollRestoration();
    while (pushed < open) {
      const next = pushed + 1;
      try {
        history.pushState(Object.assign({}, history.state, { __modal: next }), "");
      } catch (e) {
        break; // 積めないとき（ブラウザの連打制限など）は数を増やさない
      }
      pushed = next;
    }
    if (pushed > open) {
      const back = pushed - open;
      pushed = open;
      awaitingPop = true;
      // 戻る先が無く popstate が来ない場合に備えて、少し待って解除する。
      clearTimeout(popTimer);
      popTimer = setTimeout(() => {
        awaitingPop = false;
        syncHistory();
      }, 500);
      history.go(-back);
      return;
    }
    if (!open) releaseScrollRestoration();
  }

  addEventListener("popstate", () => {
    // syncHistory が自分で戻したぶんの popstate か、人が「戻る」を押したのか。
    // 自分で戻したぶんは積んだ履歴の後始末でしかないので、モーダルは閉じない。
    // 閉じると、「モーダルを閉じて、すぐ次のモーダルを開く」流れ（共有画像の種類を選ぶ →
    // SNS パネル等）で、開いたばかりのほうに Esc が飛んで消えてしまう。
    const ours = awaitingPop;
    awaitingPop = false;
    clearTimeout(popTimer);
    pushed = markedDepth();
    while (!ours && openCount() > pushed) {
      const el = topOpen();
      if (!el) break;
      const before = openCount();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      if (openCount() >= before) break; // 閉じなかった（確認を挟むモーダル等）
    }
    syncHistory();
  });

  function start() {
    document.querySelectorAll(MODAL).forEach(decorate);
    // 読み込み直しで残った目印は消す。残すと、戻る操作がモーダルを閉じたうえに前のページまで
    // 進んでしまう（閉じた状態で読み込み直した履歴に深さだけが残るため）。
    if (markedDepth()) history.replaceState(Object.assign({}, history.state, { __modal: 0 }), "");
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type !== "attributes") continue;
        const el = r.target;
        if (!(el instanceof Element) || !el.matches(ANY)) continue;
        const open = el.classList.contains("open");
        const known = stack.some((s) => s.el === el);
        if (open && !known) onOpen(el);
        else if (!open && known) onClose(el);
      }
      syncHistory();
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
      // class の付け外しではなく、開いた状態で作って消すダイアログ（account.js）もあるので、
      // 履歴の数合わせのために出し入れも見る（上のループは属性変化だけを扱う）。
      childList: true,
    });
    syncHistory(); // 読み込んだ時点で開いているモーダル（URL から開くもの）のぶん
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

// 画面下に数秒だけ出す通知。opts.actionLabel + opts.onAction で「元に戻す」等のボタンを付ける。
// 次の uiToast で置き換わる。返り値は今すぐ消す関数。
(function () {
  let el = null;
  let timer = null;

  window.uiToast = function (message, opts) {
    opts = opts || {};
    if (!el) {
      el = document.createElement("div");
      el.className = "ui-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    clearTimeout(timer);
    el.textContent = "";
    const hide = () => {
      clearTimeout(timer);
      el.classList.remove("open");
    };
    const msg = document.createElement("span");
    msg.className = "ui-toast-msg";
    msg.textContent = message;
    el.appendChild(msg);
    if (opts.actionLabel && typeof opts.onAction === "function") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-toast-action";
      b.textContent = opts.actionLabel;
      b.addEventListener("click", () => {
        hide();
        opts.onAction();
      });
      el.appendChild(b);
    }
    el.classList.add("open");
    timer = setTimeout(hide, opts.duration || 6000);
    return hide;
  };
})();
