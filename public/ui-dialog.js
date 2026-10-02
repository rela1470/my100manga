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
