"use strict";

// 本の詳細ポップアップの作者欄（.dauthor）を、作者名ごとの検索リンクにする。
// トップ（/）の検索を作者名検索（?by=creator, src/search.ts searchByCreator）で開くので、
// 「この人の他の作品」へ一手で行ける。
//
// window.renderAuthorLinks(el, text, opts)
//   el:   作者欄の要素（中身は毎回入れ替える）
//   text: 表示用の作者表記。"原作：A、作画：B" のように役割付き・複数人のことがある。
//   opts.onPick(name): トップの検索フォームを持っているページ（public/app.js）が渡す。
//         渡されたら遷移せずその場で検索する（修飾キー・中クリックは従来どおりリンク）。
//   戻り値: 何か出したか（作者欄の表示/非表示の判定に使う）
//
// 区切りと役割の落とし方は取り込み側（src/masterFix.ts creatorsNormOf）と揃える。検索用の
// creators_norm が同じ規則で名前を割っているので、ここで割った 1 人分がそのまま当たる。
(function () {
  const SEP = /([、,，／/・])/; // 分割しても区切り文字を残す（表示はそのまま）
  const ROLE = /^([^：:]{1,10}[：:])\s*/; // 「原作：」「作画：」。名前だけをリンクにする

  window.renderAuthorLinks = function (el, text, opts = {}) {
    if (!el) return false;
    el.textContent = "";
    const src = String(text || "").trim();
    if (!src) return false;
    for (const part of src.split(SEP)) {
      if (!part) continue;
      if (SEP.test(part) && part.length === 1) {
        el.appendChild(document.createTextNode(part));
        continue;
      }
      const m = part.match(ROLE);
      const name = (m ? part.slice(m[0].length) : part).trim();
      if (m) el.appendChild(document.createTextNode(m[0]));
      // 1 文字の語は検索できない（トップの検索欄と同じ 2 文字以上）ので素のまま出す。
      if (name.length < 2) {
        el.appendChild(document.createTextNode(name || part));
        continue;
      }
      const a = document.createElement("a");
      a.className = "author-link";
      a.href = `/?q=${encodeURIComponent(name)}&by=creator`;
      a.textContent = name;
      a.title = `${name}の作品を探す`;
      if (typeof opts.onPick === "function") {
        a.addEventListener("click", (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
          ev.preventDefault();
          opts.onPick(name);
        });
      }
      el.appendChild(a);
    }
    return true;
  };
})();
