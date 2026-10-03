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

  function open(mode, message, opts) {
    build();
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
//   preventDefault しなければ背景クリックと同じ扱いにする（各モーダルの既存の閉じ処理に乗る）。
//   背景クリックで閉じないモーダル（公開後の共有モーダル等）は modal-escape を受けて自前で処理する。
// - 閉じたとき: 開く前にフォーカスがあった要素へ戻す。
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

  document.addEventListener("keydown", (e) => {
    const top = stack[stack.length - 1];
    if (!top || !top.el.classList.contains("open")) return;
    if (e.key === "Tab") {
      trap(e, panelOf(top.el));
    } else if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && top.el.matches(MODAL)) {
      e.preventDefault();
      const ev = new CustomEvent("modal-escape", { cancelable: true });
      top.el.dispatchEvent(ev);
      if (!ev.defaultPrevented) top.el.click(); // 背景クリック扱い（target が backdrop 自身）
    }
  });

  function start() {
    document.querySelectorAll(MODAL).forEach(decorate);
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target;
        if (!(el instanceof Element) || !el.matches(ANY)) continue;
        const open = el.classList.contains("open");
        const known = stack.some((s) => s.el === el);
        if (open && !known) onOpen(el);
        else if (!open && known) onClose(el);
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
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
