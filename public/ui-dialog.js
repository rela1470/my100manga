"use strict";

// スマホで扱いづらいブラウザ標準の alert/confirm/prompt を、サイト内モーダルに置き換える。
// Promise ベースで、呼び出し側は await uiConfirm(...) のように同期的な見た目で書ける。
// window.uiAlert / uiConfirm / uiPrompt として公開する。
(function () {
  let host = null;
  let msgEl = null;
  let inputEl = null;
  let okBtn = null;
  let cancelBtn = null;
  let current = null; // { resolve, mode }

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.className = "ui-dialog-backdrop";
    host.innerHTML =
      '<div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="uiDialogMsg">' +
      '<p class="ui-dialog-msg" id="uiDialogMsg"></p>' +
      '<input type="text" class="ui-dialog-input" style="display:none">' +
      '<div class="ui-dialog-actions">' +
      '<button type="button" class="ui-dialog-cancel"></button>' +
      '<button type="button" class="ui-dialog-ok"></button>' +
      "</div></div>";
    document.body.appendChild(host);
    msgEl = host.querySelector(".ui-dialog-msg");
    inputEl = host.querySelector(".ui-dialog-input");
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
      } else if (e.key === "Enter" && current && current.mode !== "alert") {
        // textarea は無いので Enter は常に決定でよい。
        e.preventDefault();
        settle(true);
      }
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        settle(true);
      }
    });
  }

  function settle(ok) {
    if (!current) return;
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
      current = { resolve, mode };
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
