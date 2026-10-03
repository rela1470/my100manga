import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAccountApi } from "../src/account";
import { beacon, createList } from "./helpers";

// テストの bindings では GOOGLE_* が空でログイン機能が無効なので、有効にした env で
// handleAccountApi を直接呼ぶ。ログインは users / sessions に行を入れて Cookie を作る。
const loginEnv = { ...env, GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ユーザとセッションを作り、そのセッションの Cookie ヘッダ値を返す。 */
async function login(userId: string): Promise<string> {
  const now = Date.now();
  const token = `tok-${userId}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at) VALUES (?, ?, ?, '', '', ?, ?)`
    ).bind(userId, `sub-${userId}`, `${userId}@example.com`, now, now),
    env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(
      await sha256Hex(token),
      userId,
      now,
      now + 60_000
    ),
    env.DB.prepare(
      `INSERT INTO user_drafts (user_id, owner_name, bio, items_json, updated_at) VALUES (?, '', '', '[]', ?)`
    ).bind(userId, now),
  ]);
  return `m100_sid=${token}`;
}

function withdraw(cookie: string, body: Record<string, unknown> = {}, origin?: string): Promise<Response> {
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };
  if (origin) headers.origin = origin;
  const req = new Request("https://example.com/api/me", { method: "DELETE", headers, body: JSON.stringify(body) });
  return handleAccountApi(req, loginEnv, "/api/me");
}

async function count(sql: string, ...args: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
}

async function link(slug: string, userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE lists SET user_id = ? WHERE slug = ?`).bind(userId, slug).run();
}

beforeEach(async () => {
  await env.DB.batch(["users", "sessions", "user_drafts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("DELETE /api/me（退会）", () => {
  it("アカウント・セッション・下書きを消し、Cookie を破棄する", async () => {
    const cookie = await login("u1");
    const res = await withdraw(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^m100_sid=; .*Max-Age=0/);
    expect(await count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, "u1")).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, "u1")).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM user_drafts WHERE user_id = ?`, "u1")).toBe(0);
    // 同じ Cookie ではもう何もできない。
    expect((await withdraw(cookie)).status).toBe(401);
  });

  it("既定では紐付いたリストを残し、匿名公開に戻す", async () => {
    const cookie = await login("u1");
    const a = await createList({ owner_name: "A" });
    await link(a.slug, "u1");
    const res = await withdraw(cookie);
    expect(((await res.json()) as { deleted_lists: number }).deleted_lists).toBe(0);
    const row = await env.DB.prepare(`SELECT user_id, edit_token FROM lists WHERE slug = ?`)
      .bind(a.slug)
      .first<{ user_id: string | null; edit_token: string }>();
    expect(row).toEqual({ user_id: null, edit_token: a.edit_token });
  });

  it("delete_lists なら本人のリストだけを付随データごと消す", async () => {
    const cookie = await login("u1");
    await login("u2");
    const mine = await createList({ owner_name: "A" });
    const others = await createList({ owner_name: "B" });
    const anon = await createList({ owner_name: "C" });
    await link(mine.slug, "u1");
    await link(others.slug, "u2");
    expect((await beacon(mine.slug)).status).toBe(204);
    expect(await count(`SELECT COUNT(*) AS n FROM list_views WHERE slug = ?`, mine.slug)).toBe(1);

    const res = await withdraw(cookie, { delete_lists: true });
    expect(((await res.json()) as { deleted_lists: number }).deleted_lists).toBe(1);
    for (const t of ["lists", "list_item_events", "list_views", "list_view_seen"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE slug = ?`, mine.slug)).toBe(0);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM lists WHERE slug IN (?, ?)`, others.slug, anon.slug)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, "u2")).toBe(1);
  });

  it("別オリジンからのリクエストは拒否する", async () => {
    const cookie = await login("u1");
    expect((await withdraw(cookie, {}, "https://evil.example")).status).toBe(403);
    expect(await count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, "u1")).toBe(1);
  });

  it("未ログインなら 401", async () => {
    expect((await withdraw("")).status).toBe(401);
  });
});
