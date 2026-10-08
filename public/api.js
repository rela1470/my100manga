"use strict";

// API 呼び出しの共通ヘルパ。エラー文言をユーザ向けの日本語にそろえ、ブラウザの
// "Failed to fetch" や JSON パース失敗の "Unexpected token" をそのまま画面に出さない。
//   const data = await apiFetch("/api/...", { method: "POST", ... });
//   } catch (e) { uiAlert(apiErrorMessage(e, "保存に失敗しました")); }
// - 通信自体の失敗（オフライン等で fetch が TypeError）→ 接続確認を促す文言
// - 本文は JSON として読み、読めなければ {} 扱い（Worker 再起動時のプレーンテキスト 503 等）
// - 2xx 以外 → サーバの日本語 error があればそれ、無ければ 429 / 5xx ごとの文言
//   （それ以外の 4xx で error が無いときは呼び出し側の fallback を使う）
// 投げる Error は userMessage（画面に出してよい文言）と status / data（応答本文）を持つ。
(function () {
  const NETWORK = "通信に失敗しました。接続を確認してもう一度お試しください。";
  const BUSY = "混み合っています。少し時間をおいてお試しください。";
  const SERVER = "サーバでエラーが発生しました。時間をおいてもう一度お試しください。";

  function statusMessage(status) {
    if (status === 429) return BUSY;
    if (status >= 500) return SERVER;
    return "";
  }

  function apiError(userMessage, status, data) {
    const e = new Error(userMessage || `HTTP ${status}`);
    e.userMessage = userMessage;
    e.status = status;
    e.data = data || {};
    return e;
  }

  // サーバの error は基本日本語。英語だけの内部的な文言（"not found" 等）は出さない。
  function serverMessage(data) {
    const m = data && typeof data.error === "string" ? data.error.trim() : "";
    return /[^\x00-\x7f]/.test(m) ? m : "";
  }

  async function apiFetch(url, opts) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw apiError(NETWORK, 0, {});
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(serverMessage(data) || statusMessage(res.status), res.status, data);
    return data;
  }

  // catch した例外から画面に出す文言を選ぶ。apiFetch 以外の例外（コードの不具合等）の
  // 生のメッセージは出さず fallback にする。
  function apiErrorMessage(e, fallback) {
    if (e && e.userMessage) return e.userMessage;
    if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message || "")) return NETWORK;
    return fallback || "エラーが発生しました。もう一度お試しください。";
  }

  // 本棚の下書き（localStorage）がこの端末にあることを 1 日 1 回だけサーバに知らせる
  // （管理画面の「ローカル保存の端末数」用, src/draftDevices.ts）。送るのは端末のランダム ID
  // だけで、下書きの中身は送らない。下書きが空なら送らない。失敗しても何もしない。
  const DEVICE_KEY = "my100manga_device_v1";
  const PING_DAY_KEY = "my100manga_draft_ping_v1";
  function draftPing(itemCount) {
    if (!itemCount) return;
    try {
      const d = new Date();
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (localStorage.getItem(PING_DAY_KEY) === today) return;
      let device = localStorage.getItem(DEVICE_KEY);
      if (!device || !/^[A-Za-z0-9_-]{16,64}$/.test(device)) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        device = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        localStorage.setItem(DEVICE_KEY, device);
      }
      localStorage.setItem(PING_DAY_KEY, today);
      fetch("/api/draft-ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device }),
        keepalive: true,
      }).catch(() => {});
    } catch (e) {}
  }

  window.apiFetch = apiFetch;
  window.draftPing = draftPing;
  window.apiErrorMessage = apiErrorMessage;
  window.apiStatusMessage = statusMessage;
})();
