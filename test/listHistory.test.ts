import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminDeleteList, adminGetListHistory, adminListListHistory, adminRedactReport } from "../src/admin";
import { LIST_HISTORY_UPDATE_KEEP } from "../src/lists";
import { LIST_HISTORY_RETENTION_MS, purgeListHistory } from "../src/reports";
import { createList, items, updateList } from "./helpers";

interface HistoryRow {
  id: number;
  slug: string;
  owner_name: string | null;
  bio: string;
  items_json: string;
  reason: string;
  archived_at: number;
}

async function historyRows(slug: string): Promise<HistoryRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM list_history WHERE slug = ? ORDER BY id`)
    .bind(slug)
    .all<HistoryRow>();
  return results;
}

async function currentItemsJson(slug: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT items_json FROM lists WHERE slug = ?`).bind(slug).first<{ items_json: string }>();
  return row!.items_json;
}

function withComment(comment: string) {
  return items().map((it, i) => (i === 0 ? { ...it, comment } : it));
}

const page = { page: 1, per: 50, offset: 0 };

describe("リストの控え（list_history）: 削除", () => {
  it("作成者が消すと、削除した時点の中身が控えに残る", async () => {
    const { slug, edit_token } = await createList({ owner_name: "A", bio: "ひとこと" });
    const before = await currentItemsJson(slug);
    const res = await SELF.fetch(`https://example.com/api/lists/${slug}`, {
      method: "DELETE",
      headers: { "x-edit-token": edit_token },
    });
    expect(res.status).toBe(200);
    const rows = await historyRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_name: "A", bio: "ひとこと", reason: "delete", items_json: before });
  });

  it("管理者が消すと admin_delete で残り、存在しない slug は 404 で何も足さない", async () => {
    const { slug } = await createList();
    expect((await adminDeleteList(new Request("https://example.com/"), env, slug)).status).toBe(200);
    expect((await historyRows(slug)).map((r) => r.reason)).toEqual(["admin_delete"]);
    // 2 回目はもう無いので 404。控えも監査ログも増えない。
    expect((await adminDeleteList(new Request("https://example.com/"), env, slug)).status).toBe(404);
    expect(await historyRows(slug)).toHaveLength(1);
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM publish_audit WHERE slug = ? AND action = 'admin_delete'`)
      .bind(slug)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("控えは公開側からは見えない", async () => {
    const { slug } = await createList();
    await adminDeleteList(new Request("https://example.com/"), env, slug);
    expect((await SELF.fetch(`https://example.com/api/lists/${slug}`)).status).toBe(404);
  });
});

describe("リストの控え（list_history）: 更新・伏字", () => {
  it("更新公開すると、更新前の版が残る", async () => {
    const { slug, edit_token } = await createList({ owner_name: "前の名前" });
    const before = await currentItemsJson(slug);
    const res = await updateList(slug, { edit_token, owner_name: "後の名前", items: withComment("あとで書いた") });
    expect(res.status).toBe(200);
    const rows = await historyRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "update", owner_name: "前の名前", items_json: before });
    expect(await currentItemsJson(slug)).toContain("あとで書いた");
  });

  it("中身が変わらない更新では控えない", async () => {
    const { slug, edit_token } = await createList({ owner_name: "同じ" });
    expect((await updateList(slug, { edit_token, owner_name: "同じ" })).status).toBe(200);
    expect(await historyRows(slug)).toHaveLength(0);
  });

  it("更新前の版は 1 リスト LIST_HISTORY_UPDATE_KEEP 件まで（古いものから消す。削除・伏字の控えは数えない）", async () => {
    const { slug } = await createList();
    const insert = (reason: string, i: number) =>
      env.DB.prepare(
        `INSERT INTO list_history (slug, owner_name, items_json, created_at, updated_at, archived_at, reason)
         VALUES (?, ?, '[]', 0, 0, ?, ?)`
      ).bind(slug, `v${i}`, Date.now(), reason);
    await env.DB.batch([
      insert("admin_redact", -1),
      ...Array.from({ length: LIST_HISTORY_UPDATE_KEEP }, (_, i) => insert("update", i)),
    ]);
    const { edit_token } = (await env.DB.prepare(`SELECT edit_token FROM lists WHERE slug = ?`)
      .bind(slug)
      .first<{ edit_token: string }>())!;
    expect((await updateList(slug, { edit_token, owner_name: "新しい名前" })).status).toBe(200);
    const rows = await historyRows(slug);
    const updates = rows.filter((r) => r.reason === "update");
    expect(updates).toHaveLength(LIST_HISTORY_UPDATE_KEEP);
    expect(updates.some((r) => r.owner_name === "v0")).toBe(false); // いちばん古い版が押し出される
    expect(rows.filter((r) => r.reason === "admin_redact")).toHaveLength(1);
  });

  it("管理者が伏字にすると、伏字前の版が残る", async () => {
    const { slug } = await createList({ owner_name: "けしたい名前" });
    const now = Date.now();
    const ins = await env.DB.prepare(
      `INSERT INTO reports (slug, target_type, position, reported_text, first_at, last_at) VALUES (?, 'owner_name', 0, ?, ?, ?)`
    )
      .bind(slug, "けしたい名前", now, now)
      .run();
    expect((await adminRedactReport(env, Number(ins.meta.last_row_id), "https://example.com")).status).toBe(200);
    const rows = await historyRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "admin_redact", owner_name: "けしたい名前" });
  });
});

describe("リストの控え（list_history）: 管理 API と保持期間", () => {
  it("一覧と詳細で中身を見られる", async () => {
    const { slug } = await createList({ owner_name: "B" });
    await adminDeleteList(new Request("https://example.com/"), env, slug);
    const list = (await (await adminListListHistory(env, page, slug)).json()) as {
      total: number;
      history: { id: number; slug: string; item_count: number; reason: string }[];
    };
    expect(list.total).toBe(1);
    expect(list.history[0]).toMatchObject({ slug, item_count: 100, reason: "admin_delete" });

    const detail = (await (await adminGetListHistory(env, list.history[0].id)).json()) as {
      list: { slug: string; owner_name: string; items: { isbn: string }[] };
    };
    expect(detail.list.slug).toBe(slug);
    expect(detail.list.owner_name).toBe("B");
    expect(detail.list.items).toHaveLength(100);
    expect((await adminGetListHistory(env, 999999)).status).toBe(404);
  });

  it("保持期間（365 日）を過ぎたものだけを消す", async () => {
    const now = Date.now();
    const insert = (slug: string, archivedAt: number) =>
      env.DB.prepare(
        `INSERT INTO list_history (slug, items_json, created_at, updated_at, archived_at, reason)
         VALUES (?, '[]', 0, 0, ?, 'delete')`
      ).bind(slug, archivedAt);
    await env.DB.batch([
      insert("purge-old", now - LIST_HISTORY_RETENTION_MS - 1),
      insert("purge-new", now - LIST_HISTORY_RETENTION_MS + 60_000),
    ]);
    await purgeListHistory(env, now);
    expect(await historyRows("purge-old")).toHaveLength(0);
    expect(await historyRows("purge-new")).toHaveLength(1);
  });
});
