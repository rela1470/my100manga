// メンテナンスモード。D1 を Time Travel で過去の時点へ戻すような作業の間、サイトを止める。
//
// 書き込みだけでなく読み取りも止める。restore 中の D1 は過去の状態を返すので、そこから作った
// 応答（withEdgeCache の Cache API・R2 の閲覧スナップショット・共有画像）が作業後まで残ってしまう。
// D1 に触る経路をまるごと止めれば、作業前に作ったキャッシュはそのまま正しく残る。
//   - HTML ページ → 503 のメンテナンスページ
//   - /api/*・/auth/*・/cover・admin → 503（API は JSON の日本語 error。public/api.js がそのまま出す）
//   - 静的な非 HTML（css/js/画像/フォント）→ 通す（メンテナンスページ自体は外部資産に頼らない）
//   - Cron → 何もしない。キュー → 処理せずに遅らせて積み直す（作業中に処理すると restore で消える）
// 切り替えは secret の MAINTENANCE（src/types.ts）。

import type { Env } from "./types";
import { site } from "./site";
import { escapeHtml, json } from "./util";

/** キューのメッセージを積み直すまでの秒数。max_retries（3）を使い切ると捨てられるので、
 *  4 回 × 10 分 = 40 分ぶんは持つ。それより長いメンテでは閲覧ビーコン等の一部が落ちる。 */
export const MAINTENANCE_QUEUE_DELAY_SEC = 600;

const RETRY_AFTER_SEC = "600";

/** メンテナンス中か。値は "1" か画面に出す一言。 */
export function maintenanceOn(env: Env): boolean {
  const v = (env.MAINTENANCE ?? "").trim();
  return v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** 画面に足す一言（"1"/"true" なら無し）。 */
function maintenanceNote(env: Env): string {
  const v = (env.MAINTENANCE ?? "").trim();
  return v === "1" || v.toLowerCase() === "true" ? "" : v;
}

// 拡張子付きで HTML 以外のもの（public/ の css/js/画像/フォント等）は D1 に触らないので通す。
// /cover は R2・外部 API を引くので止める（メンテナンスページは表紙を出さない）。
function isStaticAsset(path: string): boolean {
  if (path === "/cover") return false;
  const m = path.match(/\.([A-Za-z0-9]+)$/);
  return !!m && m[1].toLowerCase() !== "html";
}

/** メンテナンス中ならその応答を返す。通常運転・止めなくてよいリクエストは null。 */
export function maintenanceResponse(request: Request, env: Env): Response | null {
  if (!maintenanceOn(env)) return null;
  const path = new URL(request.url).pathname;
  if (isStaticAsset(path)) return null;
  const headers = { "cache-control": "no-store", "retry-after": RETRY_AFTER_SEC };
  const note = maintenanceNote(env);
  if (path.startsWith("/api/")) {
    const error = `ただいまメンテナンス中です。${note ? `${note}。` : ""}しばらくしてからもう一度お試しください。`;
    return json({ error, maintenance: true }, 503, headers);
  }
  const name = escapeHtml(site(env).name);
  const noteHtml = note ? `<p class="note">${escapeHtml(note)}</p>` : "";
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>メンテナンス中 | ${name}</title>
<style>body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;margin:0;color:#222;background:#f7f8fb}header{padding:12px 16px;background:#fff;border-bottom:1px solid #e3e6ee;font-weight:bold}main{max-width:560px;margin:48px auto;padding:0 16px;line-height:1.7}.note{font-weight:bold}</style>
</head>
<body>
<header>${name}</header>
<main>
<h1>ただいまメンテナンス中です</h1>
${noteHtml}<p>ご不便をおかけしてすみません。作業が終わりしだい再開します。しばらくしてから再読み込みしてください。</p>
<p>作成中の本棚はこの端末に残っています。</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}
