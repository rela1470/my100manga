import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isCrawler, jstDay, purgeListViewSeen } from "../src/publicLists";
import { BROWSER_UA, beacon, createList, view } from "./helpers";
import { SELF } from "cloudflare:test";

async function publicLists(sort = "new") {
  const res = await SELF.fetch(`https://example.com/api/public-lists?sort=${sort}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { total: number; lists: { slug: string; views: number | null; covers: unknown[] }[] };
}

async function viewsOf(slug: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(views), 0) AS n FROM list_views WHERE slug = ?`).bind(slug).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("jstDay", () => {
  it("日本時間の 0 時で日付が変わる", () => {
    expect(jstDay(Date.UTC(2026, 9, 3, 14, 59))).toBe("2026-10-03"); // JST 23:59
    expect(jstDay(Date.UTC(2026, 9, 3, 15, 0))).toBe("2026-10-04"); // JST 翌 0:00
  });
});

describe("isCrawler", () => {
  it("クローラ・リンクプレビュー・空の UA は数えない", () => {
    expect(isCrawler("")).toBe(true);
    expect(isCrawler("Twitterbot/1.0")).toBe(true);
    expect(isCrawler("facebookexternalhit/1.1")).toBe(true);
    expect(isCrawler("curl/8.0")).toBe(true);
  });
  it("ブラウザは数える", () => {
    expect(isCrawler(BROWSER_UA)).toBe(false);
  });
});

describe("GET /api/public-lists", () => {
  it("限定公開は一覧にも件数にも出さない", async () => {
    const a = await createList({ owner_name: "A" });
    const secret = await createList({ owner_name: "S", unlisted: true });
    const data = await publicLists();
    expect(data.total).toBe(1);
    expect(data.lists.map((l) => l.slug)).toEqual([a.slug]);
    expect(data.lists.map((l) => l.slug)).not.toContain(secret.slug);
  });

  it("新着は公開順（新しい順）で、表示回数は返さない", async () => {
    const first = await createList({ owner_name: "first" });
    const second = await createList({ owner_name: "second" });
    const data = await publicLists("new");
    expect(data.lists.map((l) => l.slug)).toEqual([second.slug, first.slug]);
    expect(data.lists[0].views).toBeNull();
    expect(data.lists[0].covers).toHaveLength(5);
  });

  it("アクセス数順は窓内の表示回数の多い順。見られていないリストも後ろに残す", async () => {
    const popular = await createList({ owner_name: "popular" });
    const quiet = await createList({ owner_name: "quiet" });
    const unseen = await createList({ owner_name: "unseen" });
    const today = jstDay(Date.now());
    const old = jstDay(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO list_views (slug, day, views) VALUES (?, ?, ?)`).bind(popular.slug, today, 5),
      env.DB.prepare(`INSERT INTO list_views (slug, day, views) VALUES (?, ?, ?)`).bind(quiet.slug, today, 1),
      // 40 日前の大量アクセスは累計にだけ効く
      env.DB.prepare(`INSERT INTO list_views (slug, day, views) VALUES (?, ?, ?)`).bind(quiet.slug, old, 100),
    ]);

    const d30 = await publicLists("d30");
    expect(d30.lists.map((l) => [l.slug, l.views])).toEqual([
      [popular.slug, 5],
      [quiet.slug, 1],
      [unseen.slug, 0],
    ]);
    const all = await publicLists("all");
    expect(all.lists.map((l) => [l.slug, l.views])).toEqual([
      [quiet.slug, 101],
      [popular.slug, 5],
      [unseen.slug, 0],
    ]);
  });

  it("不正な sort は新着として扱う", async () => {
    await createList();
    const res = await SELF.fetch("https://example.com/api/public-lists?sort=bogus");
    expect(((await res.json()) as { sort: string }).sort).toBe("new");
  });
});

describe("POST /api/lists/:slug/view（アクセス数）", () => {
  it("同じ訪問者は 1 日 1 回だけ数え、別の訪問者は別に数える", async () => {
    const { slug } = await createList();
    expect((await beacon(slug)).status).toBe(204);
    await beacon(slug);
    await beacon(slug);
    expect(await viewsOf(slug)).toBe(1);
    await beacon(slug, { ip: "203.0.113.2" });
    expect(await viewsOf(slug)).toBe(2);
    // 同じ IP でも User-Agent が違えば別の人（携帯キャリアの NAT 共有など）
    await beacon(slug, { ua: BROWSER_UA.replace("Chrome/130", "Chrome/131") });
    expect(await viewsOf(slug)).toBe(3);
  });

  it("クローラ・存在しないリストは数えない（応答は同じ 204）", async () => {
    const { slug } = await createList();
    expect((await beacon(slug, { ua: "Twitterbot/1.0" })).status).toBe(204);
    expect((await beacon("nonexistent")).status).toBe(204);
    expect(await viewsOf(slug)).toBe(0);
    expect(await viewsOf("nonexistent")).toBe(0);
  });

  it("IP そのものは保存しない", async () => {
    const { slug } = await createList();
    await beacon(slug, { ip: "198.51.100.7" });
    const row = await env.DB.prepare(`SELECT visitor FROM list_view_seen WHERE slug = ?`).bind(slug).first<{ visitor: string }>();
    expect(row?.visitor).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.visitor).not.toContain("198.51.100.7");
  });

  it("公開ページの表示そのものでは数えない（ビーコンだけ）", async () => {
    const { slug } = await createList();
    expect((await view(slug)).status).toBe(200);
    expect(await viewsOf(slug)).toBe(0);
  });

  it("日次の掃除で前日より古い重複判定の記録を消し、当日・前日分は残す", async () => {
    const day = (n: number) => jstDay(Date.now() - n * 24 * 60 * 60 * 1000);
    await env.DB.batch(
      [0, 1, 2, 30].map((n) =>
        env.DB.prepare(`INSERT INTO list_view_seen (slug, day, visitor) VALUES ('s', ?, 'v')`).bind(day(n))
      )
    );
    await purgeListViewSeen(env);
    const { results } = await env.DB.prepare(`SELECT day FROM list_view_seen ORDER BY day DESC`).all<{ day: string }>();
    expect(results.map((r) => r.day)).toEqual([day(0), day(1)]);
  });
});
