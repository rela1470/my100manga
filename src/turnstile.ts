import { Env } from "./types";
import { clientIp, json } from "./util";

// 公開書き込みのうち、ボットに連投されると困るもの（リスト公開・通報・データ修正系）を
// Cloudflare Turnstile で守る。トークンはフロント（public/turnstile.js）が取得して
// `cf-turnstile-response` ヘッダで送る。単回使用なのでリクエストごとに取り直す。
//
// TURNSTILE_SITE_KEY（vars）と TURNSTILE_SECRET（secret）が両方とも未設定なら無効
// （ローカル dev など。フロントもサイトキーが無ければトークンを付けない）。片方だけ
// 設定されている場合は設定漏れとみなして fail-closed で弾く。

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const FEEDBACK_PATH = /^\/api\/series\/[A-Za-z0-9]+\/(corrections|corrections\/report|report|split-request|merge-request|tag-request)$/;
const LIST_REPORT_PATH = /^\/api\/lists\/[A-Za-z0-9_-]+\/reports$/;

// 検証対象のリクエストなら期待する action を返す。フロントの data-action と揃える。
export function turnstileAction(method: string, path: string): string | null {
  if (method !== "POST") return null;
  if (path === "/api/lists") return "publish";
  if (LIST_REPORT_PATH.test(path)) return "report";
  if (
    FEEDBACK_PATH.test(path) ||
    path === "/api/volume-title-reports" ||
    path === "/api/cover-suggestions" ||
    path === "/api/series-register-requests"
  ) {
    return "feedback";
  }
  return null;
}

function forbidden(): Response {
  return json(
    { error: "ボット確認に失敗しました。ページを再読み込みしてもう一度お試しください。" },
    403,
    { "cache-control": "no-store" }
  );
}

// 片方だけ設定されている（例: サイトキーを vars に入れたが secret の投入を忘れた）と公開・通報が
// 全部 403 になるので、運用者が気付けるようアイソレートごとに 1 回だけログに出す。
let misconfigWarned = false;
function warnMisconfigOnce(missing: string): void {
  if (misconfigWarned) return;
  misconfigWarned = true;
  console.error(
    `turnstile misconfigured: ${missing} is not set (TURNSTILE_SITE_KEY と TURNSTILE_SECRET は両方必要)。` +
      `ボット確認対象の書き込み（リスト公開・通報・データ修正）はすべて 403 になります。`
  );
}

// 検証に通れば null、通らなければ 403 のレスポンスを返す。
export async function verifyTurnstile(request: Request, env: Env, action: string): Promise<Response | null> {
  const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
  const secret = (env.TURNSTILE_SECRET ?? "").trim();
  if (!siteKey && !secret) return null;
  if (!siteKey || !secret) {
    warnMisconfigOnce(siteKey ? "TURNSTILE_SECRET" : "TURNSTILE_SITE_KEY");
    return forbidden();
  }

  const token = request.headers.get("cf-turnstile-response") ?? "";
  if (token.length === 0 || token.length > 2048) return forbidden();

  let result: { success?: boolean; action?: string; hostname?: string };
  try {
    const r = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: clientIp(request),
      }),
    });
    if (!r.ok) return forbidden();
    result = await r.json();
  } catch {
    return forbidden();
  }
  // hostname はリクエスト先と一致させる（本番・dev・ローカルで同じウィジェットを共用しても、
  // 別ホストで取得したトークンを流用できない）。
  if (!result.success || result.action !== action || result.hostname !== new URL(request.url).hostname) {
    return forbidden();
  }
  return null;
}
