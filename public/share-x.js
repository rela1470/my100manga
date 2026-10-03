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
//   添付できない）。
(function () {
  const HASHTAG = "my100manga";

  // 表示名が無いときは「私のMy 100 Manga」ではなくサイトの題名どおりの言い回しにする。
  // ハッシュタグ #my100manga は X は hashtags パラメータ、Threads/Bluesky/LINE は本文末尾に付ける。
  function shareText(owner) {
    return owner ? `${owner}のMy 100 Manga` : "自分を構成する100の漫画";
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

  async function fetchImage(slug, variant) {
    let res;
    try {
      res = await fetch(`/share/${encodeURIComponent(slug)}/${variant}.jpg`);
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

  // 4 枚は順に取る（同時だとサーバの生成が重なって遅くなる）。
  async function fetchImages(slug, kind) {
    const files = [];
    for (const v of KINDS[kind].variants) files.push(await fetchImage(slug, v));
    return files;
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
    async function getImages(slug, kind) {
      if (!(cache[kind] && cache[kind].slug === slug)) cache[kind] = { slug, files: await fetchImages(slug, kind) };
      return cache[kind].files;
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
        const files = await getImages(slug, kind);
        if (!viaShare) {
          imageBtn.textContent = label;
          // 勝手にダウンロードせず、保存・コピーのボタンと投稿先を出して選んでもらう。
          // リンクのクリックで開くのでポップアップブロックにもかからない。
          const how = canCopyImage() ? "画像を保存して添付するか、コピーして貼り付けてください" : "画像を保存して添付してください";
          const multi = files.length > 1 ? "保存した4枚は、投稿画面のファイル選択でまとめて選ぶかドラッグすると一度に添付できます。" : "";
          showSnsPanel(slug, owner, `投稿するSNSを開いて、${how}。${multi}`, files);
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
})();
