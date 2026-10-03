"use strict";

// Google ログイン（任意）のクライアント側。window.Account として公開する。
//   - ヘッダー右上にログイン / アカウント表示を出す（ログイン機能が無効な環境では何も出さない）
//   - ログイン直後（?login=ok）に、この端末の編集リンク（MyLists）のうちアカウントに無いものを
//     チェックリストで見せ、ユーザが選んだものだけ紐付ける（promptClaim）。claim() は編集 URL を
//     直接開いた時の「アカウントに追加」ボタン（app.js）からも使う
//   - アカウントの公開リスト（編集用 token 付き）を lists() で返す。app.js / view.js が使う
// ログアウトすると、アカウントに保存済みのもの（紐付いたリストの編集リンク・作成中のリスト）は
// この端末から消す。共用 PC で次の人に編集されないように。ログインし直せば戻る。
(function () {
  const DRAFT_KEY = "my100manga_draft_v1"; // public/app.js と同じ

  let listsPromise = null;
  let beforeLogout = null;

  const ready = fetch("/api/me", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : { enabled: false, user: null }))
    .catch(() => ({ enabled: false, user: null }));

  function loginUrl() {
    return `/auth/google/login?return=${encodeURIComponent(location.pathname + location.search)}`;
  }

  async function fetchLists() {
    const me = await ready;
    if (!me.user) return [];
    try {
      const res = await fetch("/api/me/lists", { credentials: "same-origin" });
      if (!res.ok) return [];
      return (await res.json()).lists || [];
    } catch (e) {
      return [];
    }
  }

  function lists() {
    if (!listsPromise) listsPromise = fetchLists();
    return listsPromise;
  }

  /** {slug, token} をアカウントに紐付け、slug ごとの結果（src/account.ts claimLists）を返す。
   *  紐付いたら一覧を取り直し、my100manga:account-lists イベントで画面に描き直しを促す。 */
  async function claim(pairs) {
    let results = {};
    try {
      const res = await fetch("/api/me/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lists: pairs.map((p) => ({ slug: p.slug, token: p.token })) }),
      });
      if (res.ok) results = (await res.json()).results || {};
    } catch (e) {}
    listsPromise = null;
    document.dispatchEvent(new CustomEvent("my100manga:account-lists"));
    return results;
  }

  const REASONS = {
    mismatch: "編集リンクが古くなっています",
    other: "別のアカウントに紐付いています",
    not_found: "削除されたリストです",
  };

  function listName(r) {
    return r.owner ? `${r.owner}さんの100作品` : "無題の100作品";
  }

  // 紐付けるリストを選ぶダイアログ。ui-dialog.js の見た目を借りたチェックリスト版。
  // 全件チェック済みで開き、選んだ配列（キャンセルなら null）を返す。
  function chooseDialog(recs, email) {
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.className = "ui-dialog-backdrop open";
      const box = document.createElement("div");
      box.className = "ui-dialog claim-dialog";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      const msg = document.createElement("p");
      msg.className = "ui-dialog-msg";
      msg.textContent =
        `この端末に、編集リンクが保存されたリストが${recs.length}件あります。` +
        `ログイン中のアカウント（${email}）に紐付けると、どの端末からでも編集できます。`;
      const ul = document.createElement("ul");
      ul.className = "claim-list";
      const boxes = recs.map((r) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        label.append(cb, ` ${listName(r)}`);
        const slug = document.createElement("span");
        slug.className = "claim-slug";
        slug.textContent = `/l/${r.slug}`;
        label.appendChild(slug);
        li.appendChild(label);
        ul.appendChild(li);
        return cb;
      });
      const actions = document.createElement("div");
      actions.className = "ui-dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "今はしない";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "primary";
      const sync = () => {
        const n = boxes.filter((cb) => cb.checked).length;
        ok.textContent = `${n}件を紐付ける`;
        ok.disabled = n === 0;
      };
      boxes.forEach((cb) => cb.addEventListener("change", sync));
      sync();
      const close = (val) => {
        host.remove();
        resolve(val);
      };
      cancel.addEventListener("click", () => close(null));
      ok.addEventListener("click", () => close(recs.filter((_, i) => boxes[i].checked)));
      host.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close(null);
      });
      actions.append(cancel, ok);
      box.append(msg, ul, actions);
      host.appendChild(box);
      document.body.appendChild(host);
      requestAnimationFrame(() => ok.focus());
    });
  }

  /** この端末の編集リンクのうちアカウントに無いものを選ばせて紐付ける。ログイン直後と、
   *  「この端末だけに記録されているリスト」欄のボタン（app.js）から呼ぶ。 */
  async function promptClaim() {
    const me = await ready;
    if (!me.user || !window.MyLists) return;
    const owned = new Set((await lists()).map((l) => l.slug));
    const recs = window.MyLists.all().filter((r) => !owned.has(r.slug));
    if (!recs.length) return;
    const chosen = await chooseDialog(recs, me.user.email);
    if (!chosen || !chosen.length) return;
    const results = await claim(chosen);
    const ok = chosen.filter((r) => results[r.slug] === "claimed" || results[r.slug] === "mine");
    const failed = chosen.filter((r) => !ok.includes(r));
    // 削除済みのリストの記録は持っていても編集できないので、この端末から片付ける。
    failed.filter((r) => results[r.slug] === "not_found").forEach((r) => window.MyLists.remove(r.slug));
    document.dispatchEvent(new CustomEvent("my100manga:account-lists"));
    let text = `${ok.length}件をアカウントに紐付けました。`;
    if (failed.length) {
      text +=
        `\n\n紐付けられなかったリスト（${failed.length}件）:\n` +
        failed.map((r) => `・${listName(r)} … ${REASONS[results[r.slug]] || "通信に失敗しました"}`).join("\n");
      if (failed.some((r) => results[r.slug] === "not_found")) {
        text += "\n\n削除されたリストの記録は、この端末から消しました。";
      }
    }
    await window.uiAlert?.(text);
  }

  async function logout() {
    if (beforeLogout) {
      try {
        await beforeLogout();
      } catch (e) {}
    }
    const owned = await lists();
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch (e) {}
    try {
      for (const l of owned) {
        window.MyLists?.remove(l.slug);
        localStorage.removeItem(`${DRAFT_KEY}_edit_${l.slug}`);
      }
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
    location.href = "/";
  }

  function renderHeader(me) {
    const header = document.querySelector("header.site");
    if (!header || !me.enabled) return;
    const bar = document.createElement("div");
    bar.className = "account-bar";
    if (!me.user) {
      const a = document.createElement("a");
      a.className = "account-login";
      a.href = loginUrl();
      a.textContent = "Googleでログイン";
      bar.appendChild(a);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "account-chip";
      btn.setAttribute("aria-haspopup", "true");
      if (me.user.picture) {
        const img = document.createElement("img");
        img.src = me.user.picture;
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        btn.appendChild(img);
      }
      const name = document.createElement("span");
      name.textContent = me.user.name || "ログイン中";
      btn.appendChild(name);

      const menu = document.createElement("div");
      menu.className = "account-menu";
      menu.hidden = true;
      const email = document.createElement("p");
      email.className = "account-email";
      email.textContent = me.user.email;
      const mine = document.createElement("a");
      mine.href = "/#myLists";
      mine.textContent = "あなたのリスト";
      const out = document.createElement("button");
      out.type = "button";
      out.textContent = "ログアウト";
      out.addEventListener("click", logout);
      menu.append(email, mine, out);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      document.addEventListener("click", (e) => {
        if (!bar.contains(e.target)) menu.hidden = true;
      });
      bar.append(btn, menu);
    }
    header.appendChild(bar);
  }

  ready.then((me) => {
    renderHeader(me);
    const params = new URLSearchParams(location.search);
    const login = params.get("login");
    if (!login) return;
    params.delete("login");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
    if (login === "failed") window.uiAlert?.("ログインに失敗しました。もう一度お試しください。");
    if (login === "ok") promptClaim();
  });

  window.Account = {
    ready,
    loginUrl,
    lists,
    claim,
    promptClaim,
    /** 公開・更新の後に呼ぶ。次の lists() でサーバから取り直す。 */
    refreshLists() {
      listsPromise = null;
    },
    /** ログアウト直前に待つ処理（作成中のリストの未送信分を送る等）を登録する。 */
    onBeforeLogout(fn) {
      beforeLogout = fn;
    },
  };
})();
