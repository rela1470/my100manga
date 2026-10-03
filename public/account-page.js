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
  });
})();
