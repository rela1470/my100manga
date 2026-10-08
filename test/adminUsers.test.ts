import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminListUsers, parsePage } from "../src/admin";
import { createList } from "./helpers";

async function addUser(id: string, email: string, lastLogin: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, '', ?, ?)`
  )
    .bind(id, `sub-${id}`, email, `name-${id}`, lastLogin, lastLogin)
    .run();
}

async function listUsers(q = "") {
  const res = await adminListUsers(env, parsePage(new URL("https://example.com/api/admin/users")), q);
  expect(res.status).toBe(200);
  return res.json<{
    total: number;
    users: { email: string; lists: { slug: string; item_count: number; unlisted: boolean }[] }[];
  }>();
}

describe("adminListUsers（Googleアカウント一覧）", () => {
  it("メールアドレスと紐付いた公開リストを直近ログイン順に返す", async () => {
    await addUser("t1-u1", "a@t1.example", 1000);
    await addUser("t1-u2", "b@t1.example", 2000);
    const a = await createList();
    const b = await createList({ unlisted: true });
    await createList(); // 誰にも紐付かないリストは出ない
    await env.DB.prepare(`UPDATE lists SET user_id = 't1-u1' WHERE slug IN (?, ?)`).bind(a.slug, b.slug).run();

    const data = await listUsers("@t1.example");
    expect(data.total).toBe(2);
    expect(data.users.map((u) => u.email)).toEqual(["b@t1.example", "a@t1.example"]);
    expect(data.users[0].lists).toEqual([]);
    expect(data.users[1].lists.map((l) => l.slug).sort()).toEqual([a.slug, b.slug].sort());
    expect(data.users[1].lists.every((l) => l.item_count === 100)).toBe(true);
    // 内部 ID・google_sub は返さない
    expect(Object.keys(data.users[0]).sort()).toEqual(["created_at", "email", "last_login_at", "lists", "name"]);
  });

  it("q でメールアドレスを部分一致で絞り込む（% はワイルドカードにしない）", async () => {
    await addUser("t2-u1", "alice@t2.example", 1000);
    await addUser("t2-u2", "bob@t2.example", 2000);
    expect((await listUsers("alice@t2")).users.map((u) => u.email)).toEqual(["alice@t2.example"]);
    expect((await listUsers("%")).total).toBe(0);
  });
});
