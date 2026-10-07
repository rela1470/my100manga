"use strict";

// X (Twitter) へのシェア。公開後モーダル（app.js）と公開ページ（view.js）で共用。
// - wireShareX(postBtn, imageBtn, getInfo): getInfo() は { slug, owner } を返す。
// - 「Xでポスト」: intent で URL を投稿。カードには og:image の合成画像
//   （/share/<slug>/og.jpg、src/shareImage.ts）が出る。
// - 「画像でポスト」: 合成画像を添付する。押すと種類を選ぶ: 100冊を1枚にした縦長画像
//   （/share/<slug>/full.jpg）か、25冊ずつの4枚（q1〜q4.jpg、X の1投稿に4枚添付できる）。
//   ファイル共有できる端末（主にスマホ）は Web Share API の共有シートへ渡す。できない
//   端末（PC、アプリ内ブラウザ等）は保存・コピーのボタンを出す。どちらも主要 SNS の
//   投稿画面へのリンクを出し、コピー／保存した画像を貼ってもらう（intent では画像を
//   添付できない）。画像がまだサーバに無ければ、出来るまで待つパネルを出す（4 枚版は
//   出来た順にタイルが埋まるので、それがそのまま進捗になる）。下の「生成待ち」を参照。
(function () {
  // サイト名・ハッシュタグはサイト種別（本家 / R18版）で変わるので、サーバが差し込む
  // window.__SITE__（src/analytics.ts analyticsTags）から読む。無ければ本家の値。
  const SITE = window.__SITE__ || {};
  const SITE_NAME = SITE.name || "My 100 Manga";
  const HASHTAG = SITE.hashtag || "my100manga";

  // 表示名が無いときは「私のMy 100 Manga」ではなくサイトの題名どおりの言い回しにする。
  // ハッシュタグ #my100manga は X は hashtags パラメータ、Threads/Bluesky/LINE は本文末尾に付ける。
  function shareText(owner) {
    return owner ? `${owner}の${SITE_NAME}` : "自分を構成する100の漫画";
  }

  // noCard: 画像を添付して投稿するとき用。?i=1 のページはリンクカードのメタタグを
  // 出さない（src/index.ts renderViewPage）ので、カードが添付画像の邪魔をしない。
  function pageUrl(slug, noCard) {
    return `${location.origin}/l/${slug}${noCard ? "?i=1" : ""}`;
  }

  function intentUrl(slug, owner, noCard) {
    const q = new URLSearchParams({ text: shareText(owner), url: pageUrl(slug, noCard), hashtags: HASHTAG });
    // x.com/intent/post はスマホで X アプリに渡らず Web のログイン画面になる。
    // アプリの Universal Link / App Link が拾うのは twitter.com/intent/tweet の方。
    return `https://twitter.com/intent/tweet?${q}`;
  }

  // 新しいタブ（ウィンドウ）で開く。同じタブで遷移すると、公開直後の共有モーダル（編集用URL
  // を表示中）が消えてしまうため。スマホでも X アプリの Universal Link はクリック直後の
  // window.open で拾われる。ポップアップがブロックされた（null が返った）ときだけ同じタブで遷移する。
  // "noopener" を付けると成否に関わらず null が返るので、opener は開いたあとで切る。
  function openIntent(url) {
    const w = window.open(url, "_blank");
    if (w) {
      try {
        w.opener = null;
      } catch (e) {}
    } else {
      location.href = url;
    }
  }

  // 共有シート／保存のあとに出す SNS の投稿画面。テキストは事前に入れておき、画像は
  // ユーザに貼ってもらう。Instagram は Web から投稿画面を開く手段がないので載せない。
  // ?i=1（リンクカードなし）は画像を貼って投稿する X / Threads / Bluesky だけ。Facebook の
  // シェアと LINE は画像を添えられずリンクカードが本体なので、カードの出るふつうの URL にする。
  function snsLinks(slug, owner) {
    const url = pageUrl(slug, true);
    const plainUrl = pageUrl(slug, false);
    const full = `${shareText(owner)} #${HASHTAG} ${url}`;
    const plainFull = `${shareText(owner)} #${HASHTAG} ${plainUrl}`;
    const enc = encodeURIComponent;
    return [
      { label: "𝕏", cls: "sns-x", href: intentUrl(slug, owner, true) },
      { label: "Threads", cls: "sns-threads", href: `https://www.threads.com/intent/post?text=${enc(full)}` },
      { label: "Bluesky", cls: "sns-bluesky", href: `https://bsky.app/intent/compose?text=${enc(full)}` },
      { label: "Facebook", cls: "sns-facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${enc(plainUrl)}` },
      { label: "LINE", cls: "sns-line", href: `https://line.me/R/share?text=${enc(plainFull)}` },
    ];
  }

  // ui-dialog.js の見た目を借りた、SNS リンクを並べるだけのパネル。リンクは <a> にして
  // ユーザのタップで遷移させる（スマホでアプリが起動しやすい。openIntent と同じく同じタブ）。
  // files を渡すと、画像の保存ボタンと、1枚ずつクリップボードに入れるボタンも出す（PC
  // 向け。クリップボードに入る画像は1枚だけなので4枚版はコピーボタンを4つ並べる）。
  let snsHost = null;
  function showSnsPanel(slug, owner, message, files) {
    if (!snsHost) {
      snsHost = document.createElement("div");
      snsHost.className = "ui-dialog-backdrop";
      snsHost.innerHTML =
        '<div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="snsPanelMsg">' +
        '<p class="ui-dialog-msg" id="snsPanelMsg"></p>' +
        '<div class="share-copy" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px"></div>' +
        '<div class="sns-links"></div>' +
        '<div class="ui-dialog-actions"><button type="button">閉じる</button></div>' +
        "</div>";
      document.body.appendChild(snsHost);
      const close = () => snsHost.classList.remove("open");
      snsHost.querySelector(".ui-dialog-actions button").addEventListener("click", close);
      // リンクや背景のクリックでは閉じない。PC は SNS が別タブで開くので、戻ってきて
      // 2枚目以降をコピーできるよう、閉じるのは「閉じる」ボタンと Esc だけにする。
      // preventDefault: 下のモーダル（共有モーダル等）まで Esc で閉じないように（ui-dialog.js）。
      snsHost.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
    }
    snsHost.querySelector(".ui-dialog-msg").textContent = message;
    const copyBox = snsHost.querySelector(".share-copy");
    copyBox.textContent = "";
    if (files) {
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary";
      save.textContent = files.length === 1 ? "画像を保存" : `${files.length}枚まとめて保存`;
      save.addEventListener("click", () => download(files));
      copyBox.appendChild(save);
    }
    if (files && canCopyImage()) {
      files.forEach((file, i) => {
        const b = document.createElement("button");
        b.type = "button";
        const label = files.length === 1 ? "画像をコピー" : `${i + 1}枚目をコピー`;
        b.textContent = label;
        b.addEventListener("click", async () => {
          try {
            await copyImage(file);
            b.textContent = "コピーしました ✓";
          } catch (e) {
            b.textContent = label;
            await uiAlert("コピーできませんでした。保存した画像を添付してください。");
          }
        });
        copyBox.appendChild(b);
      });
    }
    copyBox.style.display = copyBox.childElementCount ? "flex" : "none";
    const box = snsHost.querySelector(".sns-links");
    box.textContent = "";
    const newTab = !window.matchMedia("(pointer: coarse)").matches;
    for (const l of snsLinks(slug, owner)) {
      const a = document.createElement("a");
      a.className = `sns-link ${l.cls}`;
      a.href = l.href;
      a.textContent = l.label;
      if (newTab) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      box.appendChild(a);
    }
    snsHost.classList.add("open");
    snsHost.querySelector(".ui-dialog-actions button").focus();
  }

  function canCopyImage() {
    return !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
  }

  // クリップボードの画像は PNG しか受け付けないブラウザが多いので、JPEG を変換して入れる。
  // Safari はクリック直後に write を呼ぶ必要があるので、変換は Promise のまま渡す。
  function copyImage(file) {
    const png = createImageBitmap(file).then((bmp) => {
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));
    });
    return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }

  // 共有シートを使うのはスマホだけ。Mac 等の PC は共有シートに「コピー」しか無いことが
  // あり、本文＋画像4枚をまとめてコピーすると X に貼れない（添付は最大4件）ので保存にする。
  function canShareFiles() {
    if (!window.matchMedia("(pointer: coarse)").matches) return false;
    try {
      const probe = new File([""], "probe.jpg", { type: "image/jpeg" });
      return !!(navigator.canShare && navigator.canShare({ files: [probe] }));
    } catch (e) {
      return false;
    }
  }

  // 画像の種類。"full" は 100 冊を 1 枚、"quarters" は 25 冊ずつ 4 枚（X は 1 投稿に
  // 4 枚まで添付できる）。サーバ側は src/shareImage.ts の full / q1〜q4。
  const KINDS = {
    full: { label: "100冊を1枚", variants: ["full"] },
    quarters: { label: "25冊ずつ4枚", variants: ["q1", "q2", "q3", "q4"] },
  };

  // ?v=<内容のハッシュ> を付けて取る。付けないとサーバが付きの URL へ 302 するので 1 往復増える
  // （src/index.ts handleShareImage）。
  async function fetchImage(slug, variant, hash) {
    let res;
    try {
      res = await fetch(`/share/${encodeURIComponent(slug)}/${variant}.jpg${hash ? `?v=${encodeURIComponent(hash)}` : ""}`);
    } catch (e) {
      throw Object.assign(new Error("network"), { userMessage: "通信に失敗しました。接続を確認してもう一度お試しください。" });
    }
    if (!res.ok) {
      const msg = (window.apiStatusMessage && window.apiStatusMessage(res.status)) || "";
      throw Object.assign(new Error(`HTTP ${res.status}`), { userMessage: msg });
    }
    const suffix = variant === "full" ? "" : `-${variant.slice(1)}`;
    return new File([await res.blob()], `my100manga-${slug}${suffix}.jpg`, { type: "image/jpeg" });
  }

  /* ---------- 生成待ち ---------- */
  // 画像はサーバが描く（src/shareImage.ts）。公開・更新で先に描かれるのは og と full だけで、
  // 4 枚版（q1–q4）は要求されてから描く。描画はメモリを食うのでサイト全体で 1 枚ずつしか
  // 進まない（wrangler.jsonc の max_concurrency 1）ため、混んでいると数十秒待つことがある。
  //
  // そこで「ボタンを押す → 出来るまで固まったように見える」のをやめて、
  //   1. /api/share-status で何枚できているかを聞く（R2 を見るだけ。描画は起こさない）
  //   2. 足りなければ /api/share-prepare で積んでもらい、出来た順に 1 枚ずつ並べる
  //   3. 待たせたときは、共有へ進むのは利用者のクリックから（Web Share はユーザー操作が要る）
  // という形にしている。4 枚版はタイルが 1 枚ずつ埋まるのがそのまま進捗になる。
  const POLL_MS = 2000;
  const POLL_SLOW_MS = 5000; // 長引いたら間隔を広げる（status は安いが無駄打ちはしない）
  const BACKOFF_AFTER_MS = 30000;
  const SLOW_AFTER_MS = 45000; // これを過ぎたら「画像なしでポスト」を前に出す
  const GIVE_UP_MS = 180000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchStatus(slug) {
    let res;
    try {
      res = await fetch(`/api/share-status?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
    } catch (e) {
      throw Object.assign(new Error("network"), { userMessage: "通信に失敗しました。接続を確認してもう一度お試しください。" });
    }
    if (!res.ok) {
      const msg = (window.apiStatusMessage && window.apiStatusMessage(res.status)) || "";
      throw Object.assign(new Error(`HTTP ${res.status}`), { userMessage: msg });
    }
    return await res.json(); // { hash, ready: [variant, ...] }
  }

  // 「この種類を描いてほしい」という申告。積むだけなので、失敗してもポーリングは続ける
  // （/share/<slug>/<variant>.jpg 自体にその場で描く経路が残っている）。
  function requestPrepare(slug, kind) {
    return fetch("/api/share-prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, kind }),
    }).catch(() => {});
  }

  // 待機パネル。ui-dialog.js の見た目を借りて、タイル・経過・逃げ道（画像なしでポスト）を出す。
  // 1 つを使い回すので、開くたびに中身を作り直す。
  let waitHost = null;
  let waitCancelled = false;
  let waitResolveGo = null; // 「共有する」待ちの resolver
  let waitUrls = []; // タイルに入れた object URL（閉じるときに戻す）

  function waitAct(act, slug, owner) {
    if (act === "nocard") openIntent(intentUrl(slug, owner));
    waitCancelled = true;
    if (waitResolveGo) {
      const r = waitResolveGo;
      waitResolveGo = null;
      r(false);
    }
  }

  function openWaitPanel(kind, slug, owner, hash) {
    if (!waitHost) {
      waitHost = document.createElement("div");
      waitHost.className = "ui-dialog-backdrop";
      waitHost.innerHTML =
        '<div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="shareWaitMsg">' +
        '<p class="ui-dialog-msg" id="shareWaitMsg"></p>' +
        '<div class="share-wait"></div>' +
        '<p class="spinner share-wait-note"></p>' +
        '<p class="hint share-wait-slow" hidden></p>' +
        '<div class="ui-dialog-actions">' +
        '<button type="button" data-act="close">閉じる</button>' +
        '<button type="button" class="x-post share-wait-nocard" data-act="nocard" hidden>𝕏 でポスト（画像なし）</button>' +
        '<button type="button" class="primary share-wait-go" data-act="go" hidden></button>' +
        "</div></div>";
      document.body.appendChild(waitHost);
      waitHost.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-act]");
        if (!b) return;
        if (b.dataset.act === "go") {
          const r = waitResolveGo;
          waitResolveGo = null;
          if (r) r(true);
          return;
        }
        waitAct(b.dataset.act, waitHost._slug, waitHost._owner);
      });
      waitHost.addEventListener("keydown", (e) => {
        // 下のモーダル（共有モーダル）まで Esc で閉じないように止める（ui-dialog.js）。
        if (e.key === "Escape") {
          e.preventDefault();
          waitAct("close", waitHost._slug, waitHost._owner);
        }
      });
    }
    waitHost._slug = slug;
    waitHost._owner = owner;
    waitCancelled = false;
    const variants = KINDS[kind].variants;
    const msg = waitHost.querySelector(".ui-dialog-msg");
    const box = waitHost.querySelector(".share-wait");
    const note = waitHost.querySelector(".share-wait-note");
    const slow = waitHost.querySelector(".share-wait-slow");
    const go = waitHost.querySelector(".share-wait-go");
    const nocard = waitHost.querySelector(".share-wait-nocard");

    function buildTiles(h) {
      for (const u of waitUrls) URL.revokeObjectURL(u);
      waitUrls = [];
      box.textContent = "";
      box.className = `share-wait ${variants.length > 1 ? "quarters" : "single"}`;
      for (let i = 0; i < variants.length; i++) {
        const t = document.createElement("div");
        t.className = "share-wait-tile";
        // 1 枚版は刻みが無いので、必ず出来ている og を下敷きにして「こういう絵ができる」を見せる。
        if (variants.length === 1) {
          t.style.backgroundImage = `url("/share/${encodeURIComponent(slug)}/og.jpg?v=${encodeURIComponent(h)}")`;
          t.classList.add("has-preview");
        }
        const img = document.createElement("img");
        img.alt = "";
        img.hidden = true;
        t.appendChild(img);
        box.appendChild(t);
      }
    }

    msg.textContent = "共有画像を準備しています";
    note.textContent = "画像を作成しています…";
    slow.hidden = true;
    go.hidden = true;
    nocard.hidden = true;
    buildTiles(hash);
    waitHost.classList.add("open");
    waitHost.querySelector('button[data-act="close"]').focus();

    return {
      cancelled: () => waitCancelled,
      reset(h) {
        // 待っている間にリストが編集された。取り直しになるので並べ直す。
        buildTiles(h);
        note.textContent = "リストが更新されました。画像を作り直しています…";
      },
      fill(i, file) {
        const tile = box.children[i];
        if (!tile) return;
        const url = URL.createObjectURL(file);
        waitUrls.push(url);
        const img = tile.querySelector("img");
        img.src = url;
        img.hidden = false;
        tile.classList.add("done");
      },
      tick(done, waited) {
        note.textContent =
          variants.length > 1 && done > 0
            ? `${variants.length}枚中${done}枚できました…`
            : "画像を作成しています…";
        if (waited > SLOW_AFTER_MS && slow.hidden) {
          slow.hidden = false;
          slow.textContent = "混み合っています。画像なしで先にポストすることもできます（リンクのカードには100冊の画像が出ます）。";
          nocard.hidden = false;
        }
      },
      // 揃ったあと。待たせたぶん利用者が画面を離れている可能性があるので、共有へ進むのは
      // ここでのクリックから（それが Web Share のユーザー操作にもなる）。
      done(viaShare) {
        msg.textContent = "共有画像ができました";
        note.hidden = true;
        slow.hidden = true;
        nocard.hidden = true;
        go.hidden = false;
        go.textContent = viaShare ? "共有する" : "投稿先を選ぶ";
        go.focus();
        return new Promise((resolve) => (waitResolveGo = resolve));
      },
      close() {
        waitResolveGo = null;
        note.hidden = false;
        waitHost.classList.remove("open");
        for (const u of waitUrls) URL.revokeObjectURL(u);
        waitUrls = [];
        box.textContent = "";
      },
    };
  }

  /** 選ばれた種類の画像を揃える。揃っていれば待たせず、足りなければ待機パネルを出して
   *  ポーリングする。中断されたら null、揃えば File の配列。 */
  async function collectImages(slug, kind, owner, viaShare) {
    const variants = KINDS[kind].variants;
    const files = new Array(variants.length).fill(null);
    const isReady = (st, v) => (st.ready || []).includes(v);
    let status = await fetchStatus(slug);
    let hash = status.hash;
    // いちばん多い経路: もう全部ある。パネルは出さずそのまま渡す。
    if (variants.every((v) => isReady(status, v))) {
      for (let i = 0; i < variants.length; i++) files[i] = await fetchImage(slug, variants[i], hash);
      return files;
    }
    const ui = openWaitPanel(kind, slug, owner, hash);
    try {
      await requestPrepare(slug, kind);
      const started = Date.now();
      for (;;) {
        for (let i = 0; i < variants.length; i++) {
          if (files[i] || !isReady(status, variants[i])) continue;
          try {
            files[i] = await fetchImage(slug, variants[i], hash);
            ui.fill(i, files[i]);
          } catch (e) {
            // 出来ているはずのものが取れなかった（消された・入れ違い）。次の周回で拾い直す。
            files[i] = null;
          }
          if (ui.cancelled()) return null;
        }
        if (files.every(Boolean)) break;
        const waited = Date.now() - started;
        if (waited > GIVE_UP_MS) {
          throw Object.assign(new Error("timeout"), {
            userMessage: "いま混み合っているようです。時間をおいてもう一度お試しください。",
          });
        }
        ui.tick(files.filter(Boolean).length, waited);
        await sleep(waited > BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_MS);
        if (ui.cancelled()) return null;
        status = await fetchStatus(slug);
        if (status.hash !== hash) {
          hash = status.hash;
          files.fill(null);
          ui.reset(hash);
        }
      }
      return (await ui.done(viaShare)) ? files : null;
    } finally {
      ui.close();
    }
  }

  function download(files) {
    files.forEach((file, i) => {
      // 連続クリックをまとめて弾くブラウザがあるので少しずつずらす。
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(file);
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }, i * 300);
    });
  }

  // どちらの画像にするかを選ぶパネル（ui-dialog.js の見た目）。選んだ種類、閉じたら null。
  let kindHost = null;
  let kindResolve = null;
  function chooseKind(message) {
    if (!kindHost) {
      kindHost = document.createElement("div");
      kindHost.className = "ui-dialog-backdrop";
      kindHost.innerHTML =
        '<div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="shareKindMsg">' +
        '<p class="ui-dialog-msg" id="shareKindMsg"></p>' +
        '<div class="ui-dialog-actions">' +
        '<button type="button" data-kind="">キャンセル</button>' +
        Object.entries(KINDS).map(([k, v]) => `<button type="button" class="primary" data-kind="${k}">${v.label}</button>`).join("") +
        "</div></div>";
      document.body.appendChild(kindHost);
      const settle = (kind) => {
        kindHost.classList.remove("open");
        const r = kindResolve;
        kindResolve = null;
        if (r) r(kind || null);
      };
      kindHost.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-kind]");
        if (b) settle(b.dataset.kind);
        else if (e.target === kindHost) settle(null);
      });
      kindHost.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          settle(null);
        }
      });
    }
    kindHost.querySelector(".ui-dialog-msg").textContent = message;
    kindHost.classList.add("open");
    kindHost.querySelector('button[data-kind="full"]').focus();
    return new Promise((resolve) => (kindResolve = resolve));
  }

  // 取得済みの画像を捨てる。リストを更新したあとに呼ぶ（同じ slug のままなので、
  // 捨てないと更新前の画像を出し続ける）。public/app.js の公開・更新の後から呼んでいる。
  const resets = [];
  function resetImages() {
    // 待っている最中にリストが更新されたら、その待ちは古い内容のものなので畳む。
    if (waitHost && waitHost.classList.contains("open")) waitAct("close", waitHost._slug, waitHost._owner);
    for (const f of resets) f();
  }

  function wireShareX(postBtn, imageBtn, getInfo) {
    postBtn.addEventListener("click", () => {
      const { slug, owner } = getInfo();
      if (slug) openIntent(intentUrl(slug, owner));
    });

    // 画像の生成待ち（初回は数秒）の間にタップの「ユーザー操作」が切れると share() が
    // NotAllowedError になる。そのときは取得済みの画像を持ったまま、次のタップで
    // （種類を聞き直さずに）共有する。
    const cache = {}; // kind -> { slug, files }
    let retry = null; // { slug, kind }: 画像はできたが共有できなかった
    resets.push(() => {
      for (const k of Object.keys(cache)) delete cache[k];
      retry = null;
    });
    async function getImages(slug, kind, owner, viaShare) {
      if (cache[kind] && cache[kind].slug === slug) return cache[kind].files;
      const files = await collectImages(slug, kind, owner, viaShare);
      if (files) cache[kind] = { slug, files };
      return files; // null = 待機パネルで中断された
    }
    const label = imageBtn.textContent;
    imageBtn.addEventListener("click", async () => {
      const { slug, owner } = getInfo();
      if (!slug) return;
      const viaShare = canShareFiles();
      let kind = retry && retry.slug === slug ? retry.kind : null;
      retry = null;
      if (!kind) kind = await chooseKind("投稿する画像を選んでください");
      if (!kind) return;
      imageBtn.disabled = true;
      imageBtn.textContent = "画像を作成中…";
      try {
        const files = await getImages(slug, kind, owner, viaShare);
        imageBtn.textContent = label;
        if (!files) return; // 待機パネルで中断された（ポスト済みか、閉じられた）
        if (!viaShare) {
          // 勝手にダウンロードせず、保存・コピーのボタンと投稿先を出して選んでもらう。
          // リンクのクリックで開くのでポップアップブロックにもかからない。
          const how = canCopyImage() ? "画像を保存して添付するか、コピーして貼り付けてください" : "画像を保存して添付してください";
          const multi = files.length > 1 ? "保存した4枚は、投稿画面のファイル選択でまとめて選ぶかドラッグすると一度に添付できます。" : "";
          showSnsPanel(slug, owner, `投稿するSNSを開いて、${how}。${multi}`, files);
          return;
        }
        // 共有シートから X を直接選ぶと画像だけが投稿される（下の「本文は付けず」のとおり）。
        // 先にその旨と「コピー → あとの投稿リンクで貼り付け」の手順を知らせる。
        // OK のクリックがそのまま次の share() の起点になるので、ユーザー操作は切れない。
        const go = await uiConfirm(
          "共有シートで X を直接選ぶと、画像だけが投稿されます。\n\n" +
            "「コピー」を選んでから、このあと出る投稿リンクで X を開いて貼り付けると、" +
            "本文とリストのURLも一緒に投稿できます。",
          { okLabel: "共有シートを開く" }
        );
        if (!go) {
          imageBtn.textContent = label;
          return;
        }
        try {
          // 本文は付けず画像だけ渡す。付けると、共有シートで「コピー」したとき本文＋画像4枚で
          // 5件になって X に貼れず（添付は最大4件）、X アプリでは後の SNS パネルのリンクと
          // 本文が二重になる。本文はそのリンク側で入る。
          await navigator.share({ files });
          imageBtn.textContent = label;
          // 共有シートで何を選んだかは分からない。コピーした人向けに投稿画面を案内する。
          showSnsPanel(slug, owner, "コピーした場合は、投稿するSNSを開いて貼り付けてください。");
        } catch (e) {
          if (e && e.name === "NotAllowedError") {
            retry = { slug, kind };
            imageBtn.textContent = "画像ができました。タップして共有";
          } else {
            imageBtn.textContent = label; // AbortError: 共有シートを閉じただけ
          }
        }
      } catch (e) {
        imageBtn.textContent = label;
        const why = (e && e.userMessage) || "時間をおいてもう一度お試しください。";
        await uiAlert(`画像の作成に失敗しました。${why}`);
      } finally {
        imageBtn.disabled = false;
      }
    });
  }

  window.wireShareX = wireShareX;
  window.resetShareImages = resetImages;
})();
