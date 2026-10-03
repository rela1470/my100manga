import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isCrawler, jstDay, purgeListViewSeen, purgePublicListsCache, recordListViews } from "../src/publicLists";
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
  // 一覧はエッジ（Cache API）に 60 秒持つので、テストごとに 1 ページ目のキャッシュを消す。
  beforeEach(() => purgePublicListsCache(env));

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

// キュー（VIEW_QUEUE）の consumer が 100 件ずつまとめて書く本体。D1 への往復は件数に依らず
// 3 回（所有者の照会・重複判定・カウンタ加算）で、1 件ずつ書いていた頃と同じ数え方になる。
describe("recordListViews（ビーコンのまとめ書き）", () => {
  const job = (slug: string, visitor: string, userId: string | null = null) => ({
    slug,
    day: jstDay(Date.now()),
    visitor,
    userId,
  });

  it("同じ batch 内の重複は 1 回、別の訪問者は別に数える", async () => {
    const { slug } = await createList();
    await recordListViews(env, [job(slug, "v1"), job(slug, "v1"), job(slug, "v2"), job(slug, "v3")]);
    expect(await viewsOf(slug)).toBe(3);
    // 次の batch で同じ訪問者が来ても増えない（重複判定は list_view_seen に残っている）。
    await recordListViews(env, [job(slug, "v1"), job(slug, "v4")]);
    expect(await viewsOf(slug)).toBe(4);
  });

  it("存在しないリストと所有者本人の閲覧は数えない", async () => {
    const { slug } = await createList();
    await env.DB.prepare(`UPDATE lists SET user_id = ? WHERE slug = ?`).bind("u1", slug).run();
    await recordListViews(env, [job(slug, "owner", "u1"), job("nonexistent", "v1"), job(slug, "other", "u2")]);
    expect(await viewsOf(slug)).toBe(1);
    expect(await viewsOf("nonexistent")).toBe(0);
  });

  it("空の batch では D1 を触らない", async () => {
    await expect(recordListViews(env, [])).resolves.toBeUndefined();
  });
});

describe("POST /api/lists/:slug/view（アクセス数）", () => {
  it("同じ訪問者（IP）は 1 日 1 回だけ数え、別の IP は別に数える", async () => {
    const { slug } = await createList();
    expect((await beacon(slug)).status).toBe(204);
    await beacon(slug);
    await beacon(slug);
    expect(await viewsOf(slug)).toBe(1);
    await beacon(slug, { ip: "203.0.113.2" });
    expect(await viewsOf(slug)).toBe(2);
    // User-Agent を変えても同じ IP なら数えない（UA を回して水増しできないように）
    await beacon(slug, { ua: BROWSER_UA.replace("Chrome/130", "Chrome/131") });
    await beacon(slug, { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" });
    expect(await viewsOf(slug)).toBe(2);
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

describe("GET /api/public-lists のエッジキャッシュ", () => {
  it("60 秒の間は同じ結果を返し、purgePublicListsCache で作り直す", async () => {
    await purgePublicListsCache(env);
    const a = await createList({ owner_name: "A" });
    expect((await publicLists()).lists.map((l) => l.slug)).toEqual([a.slug]);
    // API を通さない変更（管理者の直接操作など）はキャッシュが効いている間は出ない
    await env.DB.prepare(`UPDATE lists SET unlisted = 1 WHERE slug = ?`).bind(a.slug).run();
    expect((await publicLists()).lists.map((l) => l.slug)).toEqual([a.slug]);
    await purgePublicListsCache(env);
    expect((await publicLists()).lists.map((l) => l.slug)).toEqual([]);
  });

  it("公開・更新の直後は（この colo では）すぐ一覧に出る", async () => {
    await purgePublicListsCache(env);
    const a = await createList({ owner_name: "A" });
    expect((await publicLists()).lists.map((l) => l.slug)).toEqual([a.slug]);
    const b = await createList({ owner_name: "B" });
    expect((await publicLists()).lists.map((l) => l.slug)).toEqual([b.slug, a.slug]);
  });

  it("ブラウザ向けの cache-control はキャッシュから返すときも元のまま", async () => {
    await purgePublicListsCache(env);
    await createList();
    const first = await SELF.fetch("https://example.com/api/public-lists");
    const second = await SELF.fetch("https://example.com/api/public-lists");
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    expect(second.headers.get("cache-control")).toBe("public, max-age=60");
    expect(second.headers.get("x-client-cache-control")).toBeNull();
    expect(await second.json()).toEqual(await first.json());
  });
});
