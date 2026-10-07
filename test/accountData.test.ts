import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAccountApi } from "../src/account";
import { createList } from "./helpers";

// GET /api/me/data — 「当サイトが保存している情報」（/account の表示、src/account.ts getMyData）。
// 個人情報保護法33条の開示請求を待たずに本人が自分で見られるようにするためのものなので、
// (1) 保存しているものが漏れなく出ること、(2) 認証情報（セッションの鍵・編集用トークン）は
// 出ないこと、(3) 他人のぶんが混ざらないこと、の 3 点を見る。

const loginEnv = { ...env, GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function login(userId: string): Promise<string> {
  const now = Date.now();
  const token = `tok-${userId}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, `sub-${userId}`, `${userId}@example.com`, `名前 ${userId}`, `https://example.com/${userId}.png`, now, now),
    env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(
      await sha256Hex(token),
      userId,
      now,
      now + 60_000
    ),
  ]);
  return `m100_sid=${token}`;
}

interface MyData {
  account: { id: string; google_sub: string; email: string; name: string; picture: string } | null;
  sessions: { created_at: number; expires_at: number }[];
  draft: { owner_name: string; bio: string; item_count: number } | null;
  lists: { slug: string; owner_name: string; item_count: number; unlisted: boolean }[];
  publish_audit: { slug: string; action: string; ip: string | null; user_agent: string | null }[];
  audit_truncated: boolean;
}

async function myData(cookie: string): Promise<{ status: number; body: MyData; raw: string }> {
  const req = new Request("https://example.com/api/me/data", { headers: { cookie } });
  const res = await handleAccountApi(req, loginEnv, "/api/me/data");
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : ({} as MyData), raw };
}

beforeEach(async () => {
  await env.DB.batch(
    ["users", "sessions", "user_drafts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`))
  );
});

describe("GET /api/me/data", () => {
  it("未ログインなら 401", async () => {
    const { status } = await myData("m100_sid=nope");
    expect(status).toBe(401);
  });

  it("users / sessions / user_drafts / lists / publish_audit を返す", async () => {
    const cookie = await login("d1");
    await env.DB.prepare(
      `INSERT INTO user_drafts (user_id, owner_name, bio, items_json, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind("d1", "下書きの名前", "ひとこと", JSON.stringify([{ isbn: "9784000000000" }]), Date.now())
      .run();
    const { slug } = await createList({ owner_name: "公開の名前" });
    await env.DB.prepare(`UPDATE lists SET user_id = ? WHERE slug = ?`).bind("d1", slug).run();

    const { status, body } = await myData(cookie);
    expect(status).toBe(200);

    expect(body.account).toMatchObject({
      id: "d1",
      google_sub: "sub-d1",
      email: "d1@example.com",
      name: "名前 d1",
      picture: "https://example.com/d1.png",
    });
    expect(body.sessions).toHaveLength(1);
    expect(body.draft).toMatchObject({ owner_name: "下書きの名前", bio: "ひとこと", item_count: 1 });
    expect(body.lists).toHaveLength(1);
    expect(body.lists[0]).toMatchObject({ slug, owner_name: "公開の名前", item_count: 100, unlisted: false });
    // createList が POST /api/lists を通るので、公開の記録が 1 行できている。
    expect(body.publish_audit.map((a) => [a.slug, a.action])).toEqual([[slug, "create"]]);
    expect(body.audit_truncated).toBe(false);
  });

  it("セッションの鍵（id_hash）とリストの編集用トークンは返さない", async () => {
    const cookie = await login("d2");
    const { slug, edit_token } = await createList();
    await env.DB.prepare(`UPDATE lists SET user_id = ? WHERE slug = ?`).bind("d2", slug).run();

    const { raw } = await myData(cookie);
    expect(raw).not.toContain(edit_token);
    expect(raw).not.toContain(await sha256Hex("tok-d2"));
    expect(raw).not.toContain("id_hash");
    expect(raw).not.toContain("edit_token");
  });

  it("他人のアカウントのものは混ざらない", async () => {
    const mine = await login("d3");
    await login("d4");
    const a = await createList({ owner_name: "自分の" });
    const b = await createList({ owner_name: "他人の" });
    await env.DB.batch([
      env.DB.prepare(`UPDATE lists SET user_id = ? WHERE slug = ?`).bind("d3", a.slug),
      env.DB.prepare(`UPDATE lists SET user_id = ? WHERE slug = ?`).bind("d4", b.slug),
    ]);

    const { body } = await myData(mine);
    expect(body.account?.id).toBe("d3");
    expect(body.sessions).toHaveLength(1);
    expect(body.lists.map((l) => l.slug)).toEqual([a.slug]);
    expect(body.publish_audit.map((x) => x.slug)).toEqual([a.slug]);
  });

  it("下書きもリストも無いアカウントでも落ちない", async () => {
    const cookie = await login("d5");
    const { status, body } = await myData(cookie);
    expect(status).toBe(200);
    expect(body.draft).toBeNull();
    expect(body.lists).toEqual([]);
    expect(body.publish_audit).toEqual([]);
  });
});
