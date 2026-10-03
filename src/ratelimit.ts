import { Env } from "./types";
import { clientIp, json } from "./util";

// 公開書き込み系エンドポイントの濫用よけ。Cloudflare の Rate Limiting binding を使う。
// binding 未設定（ローカル dev や secret 未注入）では fail-open し、機能自体は止めない。
// per-colo カウントなので厳密なグローバル制限ではなく、あくまで連投・自動化の抑止が目的。
export async function rateLimit(
  request: Request,
  limiter: RateLimit | undefined,
  bucket: string
): Promise<Response | null> {
  if (!limiter) return null;
  const ip = clientIp(request);
  try {
    const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
    if (success) return null;
  } catch {
    return null;
  }
  return json(
    { error: "リクエストが多すぎます。少し時間をおいて再試行してください。" },
    429,
    { "cache-control": "no-store", "retry-after": "60" }
  );
}
