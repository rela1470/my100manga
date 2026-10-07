// アカウント設定ページ（/account）。ログイン中ならアカウント情報・ログアウト・退会を出す。
// 退会ボタンはヘッダーのメニューに直接置かず、このページの一番下（折りたたみの中）に置いている。
// 処理本体は public/account.js（window.Account.withdraw / logout）。
(function () {
  const $ = (id) => document.getElementById(id);
  if (!window.Account) return;
  window.Account.ready.then((me) => {
    $("accountLoading").hidden = true;
    if (!me.enabled || !me.user) {
      $("accountGuest").hidden = false;
      if (me.enabled) $("accountLoginLink").href = window.Account.loginUrl();
      else $("accountGuest").textContent = "このサイトではログイン機能を利用できません。";
      return;
    }
    $("accountUser").hidden = false;
    $("accountName").textContent = me.user.name || "（未設定）";
    $("accountEmail").textContent = me.user.email;
    $("accountLogout").addEventListener("click", () => window.Account.logout());
    $("accountWithdraw").addEventListener("click", () => window.Account.withdraw());
    renderData();
  });

  // 「当サイトが保存している情報」。/api/me/data（src/account.ts getMyData）が返す
  // users / sessions / user_drafts / lists / publish_audit を、そのまま表で出す。
  // 個人情報保護法33条の開示請求を待たずに本人が見られるようにするためのものなので、
  // 項目を間引いたり言い換えたりせず、保存しているとおりの粒度で出す。
  async function renderData() {
    const box = $("accountData");
    let d;
    try {
      const res = await fetch("/api/me/data", { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      d = await res.json();
    } catch {
      box.textContent = "";
      box.appendChild(el("p", "hint", "情報を読み込めませんでした。時間をおいて再度お試しください。"));
      return;
    }
    box.textContent = "";
    box.appendChild(section("アカウント（users）", d.account ? rows(accountRows(d.account)) : none()));
    box.appendChild(
      section(
        "作成中のリスト（user_drafts）",
        d.draft
          ? rows([
              ["表示名", d.draft.owner_name || "（未入力）"],
              ["ひとこと", d.draft.bio || "（未入力）"],
              ["選んだ本", d.draft.item_count + " 件"],
              ["最終更新", when(d.draft.updated_at)],
            ])
          : none("保存されている下書きはありません。")
      )
    );
    box.appendChild(
      section(
        "公開したリスト（lists）",
        d.lists.length
          ? table(
              ["URL", "表示名", "ひとこと", "本の数", "公開範囲", "作成", "最終更新"],
              d.lists.map((l) => [
                link("/l/" + l.slug, "/l/" + l.slug),
                l.owner_name || "（未入力）",
                l.bio || "（未入力）",
                l.item_count + " 件",
                l.unlisted ? "限定公開" : "みんなに公開",
                when(l.created_at),
                when(l.updated_at),
              ])
            )
          : none("公開したリストはありません。")
      )
    );
    box.appendChild(
      section(
        "公開・更新の記録（publish_audit）",
        d.publish_audit.length
          ? table(
              ["日時", "対象", "操作", "表示名", "IPアドレス", "ブラウザ（User-Agent）", "国"],
              d.publish_audit.map((a) => [
                when(a.created_at),
                a.slug,
                a.action === "create" ? "新規公開" : "更新公開",
                a.owner_name || "（未入力）",
                a.ip || "（記録なし）",
                el("span", "ua", a.user_agent || "（記録なし）"),
                a.country || "（記録なし）",
              ])
            )
          : none("記録はありません。"),
        "リストを公開・更新したときの接続元の記録です。不正利用への対応のために残しており、1 年を過ぎたものは削除します。" +
          (d.audit_truncated ? "（新しいものから一定件数までを表示しています）" : "")
      )
    );
    box.appendChild(
      section(
        "ログインの記録（sessions）",
        d.sessions.length
          ? table(
              ["ログイン日時", "有効期限"],
              d.sessions.map((x) => [when(x.created_at), when(x.expires_at)])
            )
          : none("有効なログインはありません。"),
        "ログイン状態を保つための記録です。合い言葉そのものは元に戻せない形（ハッシュ値）で保存しているため表示できません。"
      )
    );
  }

  function accountRows(a) {
    return [
      ["アカウントID（当サイト内）", a.id],
      ["Google アカウントの識別子", a.google_sub],
      ["メールアドレス", a.email],
      ["名前", a.name],
      ["プロフィール画像", a.picture ? link(a.picture, a.picture) : "（なし）"],
      ["登録日時", when(a.created_at)],
      ["最終ログイン", when(a.last_login_at)],
    ];
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function link(href, text) {
    const a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }
  function none(text) {
    return el("p", "hint", text || "保存されている情報はありません。");
  }
  function section(title, content, note) {
    const d = el("section", "account-data");
    d.appendChild(el("h4", null, title));
    if (note) d.appendChild(el("p", "hint", note));
    d.appendChild(content);
    return d;
  }
  /** 2 列の定義リスト。値は文字列か、link() が返すノード。 */
  function rows(pairs) {
    const dl = el("dl", "account-dl");
    for (const [k, v] of pairs) {
      dl.appendChild(el("dt", null, k));
      const dd = el("dd");
      if (typeof v === "string") dd.textContent = v;
      else dd.appendChild(v);
      dl.appendChild(dd);
    }
    return dl;
  }
  function table(head, body) {
    const wrap = el("div", "account-table");
    const t = el("table");
    const tr = el("tr");
    for (const h of head) tr.appendChild(el("th", null, h));
    t.appendChild(el("thead")).appendChild(tr);
    const tb = el("tbody");
    for (const r of body) {
      const row = el("tr");
      for (const c of r) {
        const td = el("td");
        if (typeof c === "string") td.textContent = c;
        else td.appendChild(c);
        row.appendChild(td);
      }
      tb.appendChild(row);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }
  function when(ms) {
    if (!ms) return "（記録なし）";
    const d = new Date(ms);
    if (isNaN(d)) return "（記録なし）";
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }
})();
