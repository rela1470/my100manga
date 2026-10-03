"use strict";

// X (Twitter) へのシェア。公開後モーダル（app.js）と公開ページ（view.js）で共用。
// - wireShareX(postBtn, imageBtn, getInfo): getInfo() は { slug, owner } を返す。
// - 「Xでポスト」: intent で URL を投稿。カードには og:image の合成画像
//   （/share/<slug>/og.jpg、src/shareImage.ts）が出る。
// - 「画像でポスト」: 100冊を1枚にした縦長画像（/share/<slug>/full.jpg）を添付する。
//   ファイル共有できる端末（主にスマホ）は Web Share API で X アプリへ渡す。PC は
//   intent を開いて画像を保存し、手で添付してもらう（intent では画像を添付できない）。
(function () {
  const HASHTAG = "私を構成する100の漫画";

  function shareText(owner) {
    return `${owner ? `${owner}さん` : "私"}を構成する100の漫画`;
  }

  function pageUrl(slug) {
    return `${location.origin}/l/${slug}`;
  }

  function intentUrl(slug, owner) {
    const q = new URLSearchParams({ text: shareText(owner), url: pageUrl(slug), hashtags: HASHTAG });
    return `https://x.com/intent/post?${q}`;
  }

  function canShareFiles() {
    try {
      const probe = new File([""], "probe.jpg", { type: "image/jpeg" });
      return !!(navigator.canShare && navigator.canShare({ files: [probe] }));
    } catch (e) {
      return false;
    }
  }

  async function fetchImage(slug) {
    const res = await fetch(`/share/${encodeURIComponent(slug)}/full.jpg`);
    if (!res.ok) throw new Error(res.status === 429 ? "混み合っています。少し待ってから再試行してください" : `HTTP ${res.status}`);
    return new File([await res.blob()], `my100manga-${slug}.jpg`, { type: "image/jpeg" });
  }

  function download(file) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function wireShareX(postBtn, imageBtn, getInfo) {
    postBtn.addEventListener("click", () => {
      const { slug, owner } = getInfo();
      if (slug) window.open(intentUrl(slug, owner), "_blank", "noopener");
    });

    // 画像の生成待ち（初回は数秒）の間にタップの「ユーザー操作」が切れると share() が
    // NotAllowedError になる。そのときは取得済みの画像を持ったまま、次のタップで共有する。
    let ready = null; // { slug, file }
    const label = imageBtn.textContent;
    imageBtn.addEventListener("click", async () => {
      const { slug, owner } = getInfo();
      if (!slug) return;
      const viaShare = canShareFiles();
      // ポップアップブロックを避けるため、intent はクリック直後に同期で開く。
      if (!viaShare) window.open(intentUrl(slug, owner), "_blank", "noopener");
      imageBtn.disabled = true;
      imageBtn.textContent = "画像を作成中…";
      try {
        const file = ready && ready.slug === slug ? ready.file : await fetchImage(slug);
        ready = { slug, file };
        if (!viaShare) {
          download(file);
          imageBtn.textContent = label;
          await uiAlert("画像を保存しました。開いたXの投稿画面で、保存した画像を添付してください。");
          return;
        }
        try {
          await navigator.share({ files: [file], text: `${shareText(owner)} ${pageUrl(slug)} #${HASHTAG}` });
          imageBtn.textContent = label;
        } catch (e) {
          if (e && e.name === "NotAllowedError") {
            imageBtn.textContent = "画像ができました。タップして共有";
          } else {
            imageBtn.textContent = label; // AbortError: 共有シートを閉じただけ
          }
        }
      } catch (e) {
        imageBtn.textContent = label;
        await uiAlert("画像の作成に失敗しました: " + e.message);
      } finally {
        imageBtn.disabled = false;
      }
    });
  }

  window.wireShareX = wireShareX;
})();
