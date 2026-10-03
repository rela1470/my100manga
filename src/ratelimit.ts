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
  const ip = rateKeyIp(clientIp(request));
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

/** レート制限のキーに使う IP。IPv6 は利用者ごとに /64 が割り当てられ、その中のアドレスを
 *  自由に替えられるので、/64 に丸めて 1 人として数える。IPv4 はそのまま。 */
export function rateKeyIp(ip: string): string {
  if (!ip.includes(":")) return ip;
  // ドットを含むものは IPv4 として扱う: IPv4 射影（"::ffff:203.0.113.1"）とポート付き
  // （"203.0.113.1:54321"、cf-connecting-ip が無く x-forwarded-for に倒れたとき）。
  // 前者を /64 に丸めると射影アドレス全部が同じキーになり、無関係な利用者が巻き添えで
  // 429 になる。後者はポートを変えるだけで別キーになり、制限が素通しになる。
  const v4 = ip.match(/\d{1,3}(?:\.\d{1,3}){3}/);
  if (v4) return v4[0];
  // "fe80::1%eth0" のゾーン識別子は落としてから、"::" の省略を展開して先頭 4 グループ（64 bit）。
  const addr = ip.split("%")[0];
  const [head, tail = ""] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = addr.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = addr.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
