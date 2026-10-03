"use strict";

// ボット確認（Cloudflare Turnstile）。リスト公開・通報・データ修正系の POST に付ける
// トークンを取る。サーバ側の検証は src/turnstile.ts。
//   headers: { "content-type": "application/json", ...(await botHeaders("feedback")) }
// のように使う。サイトキー（<meta name="turnstile-sitekey">）が無ければ {} を返す（無効時）。
// 普段は見えず、Cloudflare が怪しいと判断したときだけ画面下にチェックが出る。
// トークンは単回使用なので、呼ぶたびにウィジェットを描画して取り、取ったら消す。
(function () {
  const API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  const FAIL = "ボット確認に失敗しました。ページを再読み込みしてもう一度お試しください。";
  let apiPromise = null;
  let host = null;
  let queue = Promise.resolve();
  // api.js apiErrorMessage がそのまま画面に出せるよう userMessage を付ける。
  const failError = () => Object.assign(new Error(FAIL), { userMessage: FAIL });

  function siteKey() {
    const m = document.querySelector('meta[name="turnstile-sitekey"]');
    return m ? m.content.trim() : "";
  }

  function loadApi() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!apiPromise) {
      apiPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = API;
        s.async = true;
        s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(failError()));
        s.onerror = () => {
          apiPromise = null;
          s.remove();
          reject(failError());
        };
        document.head.appendChild(s);
      });
    }
    return apiPromise;
  }

  // チェックが必要になったときだけ見せる、画面下中央の小さな枠。
  function ensureHost() {
    if (host) return host;
    host = document.createElement("div");
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-label", "ボット確認");
    host.style.cssText =
      "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10000;" +
      "background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.2);padding:12px;" +
      "display:none;text-align:center;font-size:14px";
    host.innerHTML = '<p style="margin:0 0 8px">送信の前に確認をお願いします</p><div></div>';
    document.body.appendChild(host);
    return host;
  }

  async function fetchToken(action, key) {
    const ts = await loadApi();
    const box = ensureHost();
    const slot = document.createElement("div");
    box.lastElementChild.appendChild(slot);
    let id = null;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(failError()), 120000);
        const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
        id = ts.render(slot, {
          sitekey: key,
          action,
          language: "ja",
          appearance: "interaction-only",
          callback: done(resolve),
          "error-callback": done(() => reject(failError())),
          "expired-callback": done(() => reject(failError())),
          "timeout-callback": done(() => reject(failError())),
          "before-interactive-callback": () => { box.style.display = "block"; },
          "after-interactive-callback": () => { box.style.display = "none"; },
        });
      });
    } finally {
      box.style.display = "none";
      if (id !== null) ts.remove(id);
      slot.remove();
    }
  }

  // 返り値はそのまま fetch の headers に混ぜられる形。複数同時に呼ばれても順に処理する。
  window.botHeaders = function (action) {
    const key = siteKey();
    if (!key) return Promise.resolve({});
    const run = queue.then(() => fetchToken(action, key));
    queue = run.catch(() => {});
    return run.then((token) => ({ "cf-turnstile-response": token }));
  };
})();
