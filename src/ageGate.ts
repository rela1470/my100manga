import { isAdminUiPath } from "./adminAuth";
import { safeReturnPath, sameOrigin } from "./auth";
import { isCrawler } from "./publicLists";
import { site, siteVariant } from "./site";
import { escapeHtml, json } from "./util";
import { Env } from "./types";

// 年齢確認ゲート（R18版だけ）。同意が無ければページの中身を返さない。判定は Worker 側で
// Cookie を見るので JS 無効でも効く。本家（SITE_VARIANT="general"）では ageGate() が即 null を
// 返すので、何も変わらない。see docs/r18.md
//
// 置き場所は src/index.ts の fetch の冒頭（レート制限より前）。未確認の相手はゲートの HTML を
// 返すだけで D1 も外部 API も触らないので、書き込み枠を消費させずに弾ける。
//
// 素通りさせるもの:
//   ・ドキュメント以外のリクエスト（css/js/画像/フォント）… 中身は出ないので止める意味がない。
//   ・/cover と /share/<slug>/<variant>.jpg … SNS のカードや他サイトの埋め込みに出る画像。
//     ゲートをかけても相手の端末には画像だけが届くので、止めても年齢確認にはならない。
//     （代わりに R18版の og 画像は表紙を含めない無地のものにする。docs/r18.md 3 節）
//   ・クローラ … ゲートを出すとインデックスも OGP も出ない。年齢ゲートの実務では一般的。
//   ・/auth/… … Google ログインの往復（戻りでゲートを出すと認可が流れる）。
//   ・/admin と /api/admin/… … Cloudflare Access が別途守っている。
// API（/api/…）は 403 を返す。ゲートを通っていない端末から書き込みが通らないようにする。

const COOKIE = "age_ok";
const MAX_AGE_SEC = 60 * 60 * 24 * 365;
export const AGE_GATE_PATH = "/age-gate";

/** 年齢確認の同意がこの端末にあるか。 */
export function ageConfirmed(request: Request): boolean {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE && part.slice(i + 1).trim() === "1") return true;
  }
  return false;
}

function consentCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=1; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secure}`;
}

/** ゲートをかけないパス（上のコメントの理由）。 */
function exempt(path: string): boolean {
  return (
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    path === "/favicon.ico" ||
    path === "/favicon.svg" ||
    path === "/apple-touch-icon.png" ||
    path === "/cover" ||
    /^\/share\/[A-Za-z0-9_-]+\/(og|full|q[1-4])\.jpg$/.test(path) ||
    path.startsWith("/auth/") ||
    path.startsWith("/api/admin/") ||
    isAdminUiPath(path)
  );
}

/** HTML を見に来たリクエストか（ブラウザのページ遷移）。css/js/画像はこれに当たらない。 */
function wantsDocument(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document" || dest === "iframe";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * 年齢確認ゲート。通してよければ null、止めるならその応答を返す。
 * src/index.ts の fetch の冒頭（レート制限より前）で呼ぶ。
 */
export async function ageGate(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (siteVariant(env) !== "adult") return null;
  if (url.pathname === AGE_GATE_PATH) return await confirm(request, url, env);
  if (ageConfirmed(request)) return null;
  if (exempt(url.pathname)) return null;
  const ua = request.headers.get("user-agent") ?? "";
  if (ua && isCrawler(ua)) return null;
  if (url.pathname.startsWith("/api/")) {
    return json({ error: "年齢確認が必要です", age_gate: true }, 403, { "cache-control": "no-store" });
  }
  if (!wantsDocument(request)) return null;
  return gatePage(env, url.pathname + url.search);
}

/** 「18歳以上です」の送信先。同意を Cookie に入れて元のページへ戻す。 */
async function confirm(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "POST") return gatePage(env, safeReturnPath(url.searchParams.get("next")));
  // Cookie を立てるだけだが、他サイトのフォームから押させる意味はないので同一オリジンに限る。
  if (!sameOrigin(request)) return json({ error: "不正なリクエストです" }, 403, { "cache-control": "no-store" });
  let next = "/";
  try {
    const form = await request.formData();
    next = safeReturnPath(typeof form.get("next") === "string" ? (form.get("next") as string) : null);
  } catch {
    // 本文が読めなければトップへ戻す
  }
  return new Response(null, {
    status: 303,
    headers: { location: next, "cache-control": "no-store", "set-cookie": consentCookie(request) },
  });
}

/** ゲートの画面。URL は変えずに 200 で返す（同意後に元のページへ戻すため）。
 *  静的アセットに依存しない 1 枚もの（styles.css を待たずに出す）。配色は
 *  public/styles.css の :root[data-site="adult"] と揃える。 */
function gatePage(env: Env, next: string): Response {
  const name = site(env).name;
  const html = `<!doctype html>
<html lang="ja" data-site="adult">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>年齢確認 | ${escapeHtml(name)}</title>
<style>
  :root { --bg:#fff5f9; --panel:#fff; --border:#f5dbe7; --text:#2a1620; --muted:#6e5562; --accent:#be185d; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px;
         background:var(--bg); color:var(--text);
         font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif; line-height:1.7; }
  main { width:min(480px,100%); background:var(--panel); border:1px solid var(--border);
         border-radius:16px; padding:28px 24px; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 4px; }
  .lead { font-size:.95rem; margin:0 0 20px; }
  .warn { font-weight:700; color:var(--accent); }
  button { width:100%; padding:14px 16px; font-size:1rem; font-weight:700; color:#fff;
           background:var(--accent); border:0; border-radius:10px; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .out { display:inline-block; margin-top:16px; color:var(--muted); font-size:.9rem; }
  .note { margin:20px 0 0; color:var(--muted); font-size:.8rem; text-align:left; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(name)}</h1>
  <p class="lead">このサイトは<span class="warn">成人向け（R18）</span>の作品を扱っています。<br>18歳未満の方は閲覧できません。</p>
  <form method="post" action="${AGE_GATE_PATH}">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button type="submit">18歳以上です（サイトに入る）</button>
  </form>
  <a class="out" href="https://my100manga.com/">18歳未満の方・全年齢版はこちら（My 100 Manga）</a>
  <p class="note">「18歳以上です」を押すと、確認したことをこの端末の Cookie に 1 年間保存します。次からはこの画面は出ません。</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
