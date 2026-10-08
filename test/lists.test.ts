import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminDeleteList } from "../src/admin";
import { createList, items, updateList, view } from "./helpers";

async function getList(slug: string) {
  const res = await SELF.fetch(`https://example.com/api/lists/${slug}`);
  return (await res.json()) as { unlisted: boolean; owner_name: string; items: unknown[] };
}

describe("リストの公開範囲（限定公開）", () => {
  it("既定はみんなに公開で、公開ページに noindex を付けない", async () => {
    const { slug } = await createList();
    expect((await getList(slug)).unlisted).toBe(false);
    const res = await view(slug);
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(await res.text()).not.toContain(`name="robots"`);
  });

  it("限定公開は公開ページに noindex（meta と X-Robots-Tag）を付ける", async () => {
    const { slug } = await createList({ unlisted: true });
    expect((await getList(slug)).unlisted).toBe(true);
    const res = await view(slug);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toContain(`<meta name="robots" content="noindex">`);
  });

  it("画像付き投稿用の ?i=1 でも noindex を付ける", async () => {
    const { slug } = await createList({ unlisted: true });
    const res = await SELF.fetch(`https://example.com/l/${slug}?i=1`);
    expect(await res.text()).toContain(`<meta name="robots" content="noindex">`);
  });

  it("unlisted は true のときだけ限定公開（文字列などは公開扱い）", async () => {
    const { slug } = await createList({ unlisted: "true" });
    expect((await getList(slug)).unlisted).toBe(false);
  });

  it("更新で切り替えられ、unlisted を送らない古いクライアントの更新では現状維持", async () => {
    const { slug, edit_token } = await createList();
    expect((await updateList(slug, { edit_token, unlisted: true })).status).toBe(200);
    expect((await getList(slug)).unlisted).toBe(true);
    expect((await updateList(slug, { edit_token })).status).toBe(200);
    expect((await getList(slug)).unlisted).toBe(true);
    expect((await updateList(slug, { edit_token, unlisted: false })).status).toBe(200);
    expect((await getList(slug)).unlisted).toBe(false);
  });

  it("編集トークンが違えば更新できない", async () => {
    const { slug } = await createList();
    expect((await updateList(slug, { edit_token: "wrong", unlisted: true })).status).toBe(403);
    expect((await getList(slug)).unlisted).toBe(false);
  });
});

describe("リストの作成", () => {
  it("ちょうど 100 作品でないと公開できない", async () => {
    const res = await SELF.fetch("https://example.com/api/lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: items(99) }),
    });
    expect(res.status).toBe(400);
  });

  it("表示名・ひとことの URL は取り除く", async () => {
    const { slug } = await createList({ owner_name: "じゅん https://spam.example", bio: "見て www.spam.example ね" });
    const data = (await getList(slug)) as { owner_name: string; bio?: string };
    expect(data.owner_name).toBe("じゅん");
    expect(data.bio).toBe("見て ね");
  });

  it("お好み URL が使用済みなら 409", async () => {
    await createList({ slug: "taken" });
    const res = await SELF.fetch("https://example.com/api/lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "taken", items: items() }),
    });
    expect(res.status).toBe(409);
  });
});

describe("管理画面からのリスト削除", () => {
  it("アクセス数・追加イベントも一緒に消す", async () => {
    const { slug } = await createList();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO list_views (slug, day, views) VALUES (?, '2026-10-01', 3)`).bind(slug),
      env.DB.prepare(`INSERT INTO list_view_seen (slug, day, visitor) VALUES (?, '2026-10-01', 'v')`).bind(slug),
    ]);
    const res = await adminDeleteList(new Request("https://example.com/api/admin/lists"), env, slug);
    expect(res.status).toBe(200);
    for (const table of ["lists", "list_views", "list_view_seen", "list_item_events"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE slug = ?`).bind(slug).first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
    const audit = await env.DB.prepare(`SELECT action FROM publish_audit WHERE slug = ? ORDER BY id`)
      .bind(slug)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["create", "admin_delete"]);
  });
});

function deleteList(slug: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = token === null ? {} : { "x-edit-token": token };
  return SELF.fetch(`https://example.com/api/lists/${slug}`, { method: "DELETE", headers });
}

describe("DELETE /api/lists/:slug（作成者による削除）", () => {
  it("編集トークンが合えば付随データごと消え、監査ログに delete を残す", async () => {
    const { slug, edit_token } = await createList();
    await env.DB.prepare(`INSERT INTO list_views (slug, day, views) VALUES (?, '2026-10-01', 3)`).bind(slug).run();
    const res = await deleteList(slug, edit_token);
    expect(res.status).toBe(200);
    for (const table of ["lists", "list_views", "list_view_seen", "list_item_events"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE slug = ?`).bind(slug).first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
    expect((await SELF.fetch(`https://example.com/api/lists/${slug}`)).status).toBe(404);
    const audit = await env.DB.prepare(`SELECT action FROM publish_audit WHERE slug = ? ORDER BY id`)
      .bind(slug)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["create", "delete"]);
  });

  it("本文の edit_token でも消せる", async () => {
    const { slug, edit_token } = await createList();
    const res = await SELF.fetch(`https://example.com/api/lists/${slug}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edit_token }),
    });
    expect(res.status).toBe(200);
  });

  it("トークンが違う・無いなら 403 で消えない", async () => {
    const { slug } = await createList();
    expect((await deleteList(slug, "wrong")).status).toBe(403);
    expect((await deleteList(slug, null)).status).toBe(403);
    expect((await getList(slug)).items).toHaveLength(100);
  });

  it("存在しないリストは 404", async () => {
    expect((await deleteList("no-such-list", "x")).status).toBe(404);
  });
});
