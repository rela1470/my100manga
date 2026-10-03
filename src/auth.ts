import { Env } from "./types";
import { json, randomSlug, randomToken } from "./util";

// ユーザの Google ログイン（任意）。OAuth 2.0 Authorization Code + PKCE を Worker で直接扱う。
// 外部の認証サービスや SDK は使わない（維持費 $0・依存最小の方針、see admin 側は Cloudflare Access）。
//
//   GET  /auth/google/login?return=/path  … state / PKCE verifier を短命 Cookie に置いて Google へ
//   GET  /auth/google/callback            … code を交換 → users を upsert → セッション Cookie を発行
//   POST /auth/logout                     … セッション行を消して Cookie を破棄
// 退会（DELETE /api/me）は src/account.ts。
//
// ID トークンはこちらから TLS で Google のトークンエンドポイントに取りに行ったものなので、
// 署名検証は省き iss / aud / exp だけ確かめる（OIDC Core 3.1.3.7 で許容されている形）。
// セッションは Cookie にランダムトークン、D1 sessions にその SHA-256 を持つ。
//
// 必要な設定（secret）: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET。
// Google Cloud 側でリダイレクト URI <origin>/auth/google/callback を登録する（本番・dev・localhost）。
// ローカルの `wrangler dev` は request.url を routes のドメインに書き換えるので、ログインを試すときは
// `wrangler dev --local-upstream localhost:8787` で起動する（でないと戻り先が本番ドメインになる）。

const SESSION_COOKIE = "m100_sid";
const OAUTH_COOKIE = "m100_oauth";
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 日（期限で再ログイン）
const OAUTH_TTL_SEC = 600;

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string;
}

export function loginEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookie(request: Request, name: string, value: string, maxAgeSec: number, path = "/"): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure}`;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function sessionHash(token: string): Promise<string> {
  return Array.from(await sha256(token), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ログイン後の戻り先。オープンリダイレクトにならないよう同一オリジンのパスだけ許す。
 *  文字列の前方一致だけだと `/\tevil.com` や `/%5Cevil.com` のような変形を見落とすので、
 *  制御文字・バックスラッシュを含むものは捨て、ダミーのオリジンで URL として解決して
 *  オリジンが変わらないことを確かめ、pathname + search + hash を返す。 */
export function safeReturnPath(raw: string | null): string {
  if (!raw || raw.length > 500 || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  const base = "https://x.invalid";
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return "/";
  }
  if (u.origin !== base) return "/";
  const out = u.pathname + u.search + u.hash;
  return out.startsWith("/") && !out.startsWith("//") ? out : "/";
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/** Cookie 認証で状態を変えるリクエストの CSRF よけ。SameSite=Lax に加え、Origin が付いて
 *  いれば自オリジンと一致することを確かめる。 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function loginStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("return"));
  if (!loginEnabled(env)) return redirect(returnTo);

  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = b64url(await sha256(verifier));
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  auth.searchParams.set("redirect_uri", `${url.origin}/auth/google/callback`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("prompt", "select_account");

  const value = `${state}.${verifier}.${b64url(new TextEncoder().encode(returnTo))}`;
  return redirect(auth.toString(), [cookie(request, OAUTH_COOKIE, value, OAUTH_TTL_SEC, "/auth/google")]);
}

interface GoogleIdClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  email?: string;
  name?: string;
  picture?: string;
}

export async function loginCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clearOauth = cookie(request, OAUTH_COOKIE, "", 0, "/auth/google");
  const [state, verifier, rawReturn] = (readCookie(request, OAUTH_COOKIE) ?? "").split(".");
  let returnTo = "/";
  try {
    returnTo = safeReturnPath(rawReturn ? b64urlDecode(rawReturn) : null);
  } catch {}
  const fail = (reason: string) => {
    const back = new URL(returnTo, url.origin);
    back.searchParams.set("login", reason);
    return redirect(back.pathname + back.search, [clearOauth]);
  };

  if (!loginEnabled(env)) return redirect(returnTo, [clearOauth]);
  // キャンセル（access_denied 等）は黙って元の画面へ戻す。
  if (url.searchParams.get("error")) return redirect(returnTo, [clearOauth]);
  const code = url.searchParams.get("code");
  if (!code || !state || !verifier || url.searchParams.get("state") !== state) return fail("failed");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}/auth/google/callback`,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    console.error("google token exchange failed", tokenRes.status, await tokenRes.text().catch(() => ""));
    return fail("failed");
  }
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  let claims: GoogleIdClaims;
  try {
    claims = JSON.parse(b64urlDecode(String(id_token).split(".")[1] ?? "")) as GoogleIdClaims;
  } catch {
    return fail("failed");
  }
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issOk || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub || claims.exp * 1000 < Date.now()) {
    return fail("failed");
  }

  const now = Date.now();
  const email = String(claims.email ?? "").slice(0, 254);
  const name = String(claims.name ?? "").slice(0, 100);
  const picture = /^https:\/\//.test(claims.picture ?? "") ? String(claims.picture).slice(0, 500) : "";
  // 既存なら表示名・アイコンだけ最新に、無ければ作る。id は初回に振ったものを使い続ける。
  await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (google_sub) DO UPDATE SET
       email = excluded.email, name = excluded.name, picture = excluded.picture,
       last_login_at = excluded.last_login_at`
  )
    .bind(randomSlug(16), claims.sub, email, name, picture, now, now)
    .run();
  const user = await env.DB.prepare(`SELECT id FROM users WHERE google_sub = ?`)
    .bind(claims.sub)
    .first<{ id: string }>();
  if (!user) return fail("failed");

  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND expires_at < ?`).bind(user.id, now),
    env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(
      await sessionHash(token),
      user.id,
      now,
      now + SESSION_TTL_MS
    ),
  ]);

  // login=ok は、この端末の編集リンクをアカウントに紐付けるか聞くダイアログの合図（public/account.js）。
  const back = new URL(returnTo, url.origin);
  back.searchParams.set("login", "ok");
  return redirect(back.pathname + back.search, [
    clearOauth,
    cookie(request, SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000)),
  ]);
}

export async function logout(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "不正なリクエストです" }, 403);
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sessionHash(token)).run();
  }
  return json({ ok: true }, 200, {
    "cache-control": "no-store",
    "set-cookie": clearSessionCookie(request),
  });
}

/** セッション Cookie を消す Set-Cookie 値。ログアウトと退会で使う。 */
export function clearSessionCookie(request: Request): string {
  return cookie(request, SESSION_COOKIE, "", 0);
}

/** Cookie のセッションからログイン中のユーザを引く。未ログイン・期限切れ・未設定なら null。 */
export async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !loginEnabled(env)) return null;
  return await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`
  )
    .bind(await sessionHash(token), Date.now())
    .first<User>();
}

/** 期限切れのセッション行を全ユーザ分消す（Cron, src/index.ts scheduled）。ログイン時にも
 *  本人分は消しているが、ログインし直さないユーザの行が残り続けないように。 */
export async function purgeExpiredSessions(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run();
}
