import { Env } from "./types";
import { json } from "./util";

// Cloudflare Access（Zero Trust）による admin 認証。/admin と /api/admin/* を
// エッジで Access アプリの背後に置き、ログイン（Google / メール OTP / MFA）は
// Cloudflare 側に任せる。Worker はここで発行済み JWT を再検証して「直叩き」を塞ぐ
// 多重防御を担う（workers.dev 経由など、Access を通らない経路の保険）。
//
// 検証する JWT は Access が origin リクエストに載せる `Cf-Access-Jwt-Assertion`
// ヘッダ（無ければ CF_Authorization cookie）。RS256 署名を JWKS で検証し、
// aud（アプリの Audience タグ）/ iss（チームドメイン）/ exp を確認する。
//
// 必要な設定（wrangler.jsonc vars）:
//   ACCESS_TEAM_DOMAIN … 例 "kyash.cloudflareaccess.com"（スキームなし）
//   ACCESS_AUD          … Access アプリの Application Audience (AUD) タグ
//   ADMIN_EMAILS        … 許可メール（カンマ区切り、任意の追加チェック）
// ローカル `wrangler dev` 用:
//   ADMIN_DEV_BYPASS="true" … Access が無いローカルで検証をスキップ（.dev.vars のみ）
//
// 方針は fail-closed。設定が欠けていれば 403 を返し、決して素通りさせない。

interface AccessClaims {
  aud: string[];
  iss: string;
  exp: number;
  iat?: number;
  email?: string;
  sub?: string;
}

// JWKS はチームドメインごとにモジュールスコープでキャッシュ（cold start 間は保持）。
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
const jwksCache = new Map<string, { keys: Map<string, CryptoKey>; fetchedAt: number }>();

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(seg: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as T;
}

async function getJwks(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Array<JsonWebKey & { kid: string }> };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    keys.set(jwk.kid, key);
  }
  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

/** Cf-Access-Jwt-Assertion ヘッダ（無ければ CF_Authorization cookie）を取り出す。 */
function extractToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** JWT を検証し、失敗時は null を返す。 */
async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string
): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  let header: { kid?: string; alg?: string };
  let claims: AccessClaims;
  try {
    header = decodeJson(headerSeg);
    claims = decodeJson<AccessClaims>(payloadSeg);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const keys = await getJwks(teamDomain);
  const key = keys.get(header.kid);
  if (!key) return null;

  const data = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sigSeg),
    data
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) return null;
  if (claims.iss !== `https://${teamDomain}`) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;

  return claims;
}

/**
 * admin ルートのガード。認可 OK なら null、NG ならそのまま返す Response
 * （401/403）を返す。呼び出し側は `const denied = await requireAdmin(...); if (denied) return denied;`。
 */
export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  // ローカル dev のみ: Access が存在しないので明示フラグでバイパス。
  if (env.ADMIN_DEV_BYPASS === "true") return null;

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  // 設定漏れは fail-closed（素通りさせない）。
  if (!teamDomain || !aud) {
    return json({ error: "管理機能は未設定です" }, 403, { "cache-control": "no-store" });
  }

  const token = extractToken(request);
  if (!token) {
    return json({ error: "認証が必要です" }, 401, { "cache-control": "no-store" });
  }

  let claims: AccessClaims | null;
  try {
    claims = await verifyAccessJwt(token, teamDomain, aud);
  } catch {
    return json({ error: "認証の検証に失敗しました" }, 403, { "cache-control": "no-store" });
  }
  if (!claims) {
    return json({ error: "認証が無効です" }, 403, { "cache-control": "no-store" });
  }

  // Access ポリシーで許可メールは既に絞れるが、多重防御として Worker でも照合。
  const allow = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length > 0) {
    const email = (claims.email ?? "").toLowerCase();
    if (!email || !allow.includes(email)) {
      return json({ error: "権限がありません" }, 403, { "cache-control": "no-store" });
    }
  }

  return null;
}
