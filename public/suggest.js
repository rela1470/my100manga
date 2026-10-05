"use strict";

// 検索欄の入力補完（サジェスト）。入力中の語で前方一致する作品名を /api/suggest から引いて、
// 欄の下に候補を出す。選ぶと欄に入れて、呼び出し側の onPick（＝ふだんの検索）を走らせる。
//
//   attachSuggest(document.getElementById("topSearch"), { onPick: (name) => doSearch(name) });
//
// 候補の一覧は <body> 直下に position:fixed で置き、入力欄の位置に合わせる。入力欄を包む要素を
// 足すとトップのツールバー・検索モーダル・管理画面でそれぞれ既存のレイアウト（flex）が崩れるため。
//
// 日本語入力の途中（IME の変換中）は引かない: 「わんぴ」を打つ途中の未確定文字で候補を出すと
// 変換候補と二重になって読めないうえ、確定のたびに引き直すので無駄打ちになる。compositionend
// （変換確定）で改めて引く。
(function () {
  const MIN = 2;          // この文字数から候補を出す（サーバ側 SUGGEST_MIN と揃える）
  const DEBOUNCE_MS = 150; // 打鍵が止まってから引くまでの待ち
  const CLASS = "suggest-list";
  let uid = 0; // 候補の要素 id（aria-activedescendant 用）の通し番号

  /** 何もしない取っ手（欄が無い等で付けられなかったとき。呼び出し側で null 判定をさせない）。 */
  const NOOP = { refresh() {}, detach() {} };

  /** 入力欄にサジェストを付ける。
   *  @param {HTMLInputElement} input
   *  @param {{ onPick: (name: string) => void, params?: () => string }} opts
   *    onPick … 候補を選んだとき（欄には既に名前が入っている）
   *    params … /api/suggest に足すクエリ文字列（R18版の「全年齢も含める」など。"all=1" 形式）
   *  @returns {{ refresh: () => void, detach: () => void }}
   *    refresh … params の中身が変わったとき、開いている候補を引き直す
   *    detach  … 欄を捨てるときに呼ぶ（箱と listener を片付ける） */
  function attachSuggest(input, opts) {
    if (!input || !opts || typeof opts.onPick !== "function") return NOOP;

    const boxId = "suggest-" + ++uid;
    const box = document.createElement("div");
    box.id = boxId;
    box.className = CLASS;
    box.setAttribute("role", "listbox");
    box.hidden = true;
    // ネイティブの <dialog>（管理画面の寄せ先ダイアログ等）の中の欄に付けるときは、候補も同じ
    // dialog の中に入れる。dialog は top layer に出るので、<body> 直下に置くと後ろに隠れる。
    (input.closest("dialog") || document.body).appendChild(box);

    let items = [];     // 今出ている候補（文字列）
    let active = -1;    // 選択中の候補の位置（-1 = 未選択）
    let seq = 0;        // 応答の取り違え防止（古い応答は捨てる）
    let timer = 0;
    let lastQuery = ""; // 直近に引いた語（同じ語で引き直さない）

    input.setAttribute("autocomplete", "off");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    // 候補の箱は入力欄の子孫ではない（<body> / <dialog> 直下）ので、aria-controls で
    // 結び付けないと aria-activedescendant の参照先が宙に浮く。
    input.setAttribute("aria-controls", boxId);

    function close() {
      if (box.hidden) return;
      box.hidden = true;
      box.replaceChildren();
      items = [];
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    const GAP = 2;   // 欄と候補の隙間
    const EDGE = 8;  // 画面端に寄せすぎない余白
    const MIN_H = 96; // これだけの高さが下に取れなければ上に出す

    /** いま見えている範囲（スマホはソフトキーボードで下が隠れる）。
     *  window.innerHeight はキーボードが出ても縮まないので、あるなら visualViewport を見る。
     *  position:fixed の基準はレイアウトビューポートなので、visualViewport の offsetTop/Left を
     *  足し戻した座標で置く（iOS はキーボードが出ると視覚ビューポートだけがずれる）。 */
    function viewport() {
      const vv = window.visualViewport;
      if (!vv) {
        return { top: 0, left: 0, width: document.documentElement.clientWidth, height: window.innerHeight };
      }
      return { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height };
    }

    // 入力欄の真下（下に入らなければ真上）に幅を合わせて置く。モーダル内で欄ごとスクロールするので、
    // 開いている間はスクロール・リサイズ・キーボードの開閉のたびに置き直す。
    function place() {
      const r = input.getBoundingClientRect();
      const v = viewport();
      const viewBottom = v.top + v.height;
      // 欄が見えている範囲の外に出たら（モーダルを下までスクロールした等）候補も畳む。
      if (r.bottom < v.top || r.top > viewBottom) {
        close();
        return;
      }
      // 幅は欄に合わせるが、画面からはみ出す位置には置かない（狭い画面で右に切れるのを防ぐ）。
      const width = Math.min(r.width, v.width - EDGE * 2);
      box.style.width = width + "px";
      box.style.left = Math.min(Math.max(r.left, v.left + EDGE), v.left + v.width - width - EDGE) + "px";

      const below = viewBottom - r.bottom - GAP - EDGE;
      const above = r.top - v.top - GAP - EDGE;
      // スマホでキーボードを出すと欄のすぐ下がキーボードになり、真下に出した候補が隠れる。
      // 下に入らず上の方が広ければ欄の上に出す。
      const flip = below < MIN_H && above > below;
      box.style.maxHeight = Math.max(MIN_H, flip ? above : below) + "px";
      if (flip) {
        // 上に出すときは実寸が要るので、幅と maxHeight を当てたあとに測って下端を欄に合わせる。
        box.style.top = Math.max(v.top + EDGE, r.top - GAP - box.offsetHeight) + "px";
      } else {
        box.style.top = r.bottom + GAP + "px";
      }
    }

    function setActive(i) {
      const nodes = box.children;
      if (active >= 0 && nodes[active]) {
        nodes[active].classList.remove("on");
        nodes[active].setAttribute("aria-selected", "false");
      }
      active = i;
      if (active >= 0 && nodes[active]) {
        nodes[active].classList.add("on");
        nodes[active].setAttribute("aria-selected", "true");
        input.setAttribute("aria-activedescendant", nodes[active].id);
        if (nodes[active].scrollIntoView) nodes[active].scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function pick(name) {
      input.value = name;
      lastQuery = name; // 選んだ直後に同じ語で引き直さない
      close();
      opts.onPick(name);
    }

    function render(list) {
      items = list;
      active = -1;
      if (!list.length) {
        close();
        return;
      }
      const frag = document.createDocumentFragment();
      list.forEach((name, i) => {
        const el = document.createElement("div");
        el.className = "suggest-item";
        el.id = boxId + "-" + i;
        el.setAttribute("role", "option");
        el.setAttribute("aria-selected", "false");
        el.textContent = name;
        // mousedown で確定する: click を待つと先に input の blur が走って候補が閉じる。
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(name);
        });
        el.addEventListener("mouseenter", () => setActive(i));
        frag.appendChild(el);
      });
      box.replaceChildren(frag);
      box.hidden = false;
      input.setAttribute("aria-expanded", "true");
      place();
    }

    async function fetchSuggest(q) {
      const my = ++seq;
      let url = "/api/suggest?q=" + encodeURIComponent(q);
      const extra = opts.params ? opts.params() : "";
      if (extra) url += "&" + extra;
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (my !== seq) return; // 待っている間に次の打鍵が来た
        render(Array.isArray(data.suggestions) ? data.suggestions : []);
      } catch (e) {
        // 候補はあくまで補助なので、失敗しても画面には出さず黙って畳む。
        if (my === seq) close();
      }
    }

    function schedule() {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < MIN) {
        seq++; // 飛んでいる応答を捨てる
        lastQuery = "";
        close();
        return;
      }
      if (q === lastQuery && !box.hidden) return;
      timer = setTimeout(() => {
        if (!alive()) return;
        lastQuery = q;
        fetchSuggest(q);
      }, DEBOUNCE_MS);
    }

    // 入力欄が画面から消えたら（0 件のときの再検索フォームのように、描き直しで作り直される欄）
    // 候補の箱と document / window に付けた listener も一緒に片付ける。欄ごとに付けっぱなしに
    // すると、検索をやり直すたびに箱と listener が増えていく。
    function teardown() {
      close();
      box.remove();
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onResize);
        window.visualViewport.removeEventListener("scroll", onScroll);
      }
    }

    /** 欄がまだ画面にあるか。無ければ片付けて false。 */
    function alive() {
      if (input.isConnected) return true;
      teardown();
      return false;
    }

    input.addEventListener("input", (e) => {
      if (e.isComposing) return; // IME の変換中。確定時に compositionend で引く
      schedule();
    });
    input.addEventListener("compositionend", schedule);
    input.addEventListener("focus", () => {
      // 一度閉じたあとに欄へ戻ったときは、同じ語でも出し直す。
      if (input.value.trim().length >= MIN) {
        lastQuery = "";
        schedule();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 0));

    // キー操作は document の capture 段で受ける。入力欄に直接付けた listener どうしは登録順に
    // 走るので（capture を付けても同じ）、呼び出し側が先に付けた Enter の検索を横取りできない。
    // capture なら必ず先に動き、候補を選んでいるときだけ stopPropagation で止められる。
    function onKeydown(e) {
      // 生存確認を先にする: 欄が消えたインスタンスは e.target が一致しないので、
      // 順番が逆だといつまでも片付かない（0 件の再検索フォームのように作り直される欄）。
      if (!alive()) return;
      if (e.target !== input) return;
      if (e.isComposing) return; // 変換中の Enter は確定であって決定ではない
      if (box.hidden || !items.length) {
        // 閉じているときの Escape は呼び出し側（モーダルを閉じる等）に渡す。
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(active + 1 >= items.length ? 0 : active + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(active - 1 < 0 ? items.length - 1 : active - 1);
      } else if (e.key === "Enter") {
        // 候補を選んでいるときだけ横取りする。選んでいなければ素の検索（呼び出し側）に任せる。
        if (active >= 0) {
          e.preventDefault();
          e.stopPropagation();
          pick(items[active]);
        } else {
          close();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "Tab") {
        close();
      }
    }
    document.addEventListener("keydown", onKeydown, true);

    // 開いている間だけ位置を追う（capture でモーダル内のスクロールも拾う）。
    // 生存確認を先にする: 消えた欄の候補は閉じているので、box.hidden を先に見ると
    // いつまでも片付かない。
    function onScroll() { if (alive() && !box.hidden) place(); }
    function onResize() { if (alive() && !box.hidden) place(); }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    // スマホのソフトキーボードの開閉・視覚ビューポートのずれは window の scroll/resize では
    // 拾えない（iOS は innerHeight も scrollY も動かないことがある）ので visualViewport も見る。
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", onResize);
      window.visualViewport.addEventListener("scroll", onScroll);
    }

    return {
      // 絞り込み（R18版の「全年齢も含める」）が変わったとき用。出ている候補は古い条件のものなので
      // 引き直す。閉じているときは次の打鍵で正しい条件で引かれるので何もしない。
      refresh() {
        if (!alive() || box.hidden) return;
        lastQuery = "";
        schedule();
      },
      detach: teardown,
    };
  }

  window.attachSuggest = attachSuggest;
})();
