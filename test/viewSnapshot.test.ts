import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminDeleteList, adminRedactReport } from "../src/admin";
import { deleteAccount } from "../src/account";
import { coverSource, creditLine, isLinkPreviewBot, shareCoverUrl } from "../src/shareImage";
import { bumpViewEpoch, getListSnapshot, ogpWorkTitles, SNAPSHOT_MAX_AGE_MS, snapshotKey } from "../src/viewSnapshot";
import type { ListItem, MangaList } from "../src/types";
import { BROWSER_UA, createList, updateList, view } from "./helpers";

const bucket = () => env.COVERS!;

async function readSnapshot(slug: string): Promise<{ v: number; built_at: number; list: MangaList } | null> {
  const obj = await bucket().get(snapshotKey(slug));
  return obj ? obj.json() : null;
}

async function getJson(slug: string) {
  return SELF.fetch(`https://example.com/api/lists/${slug}`, { headers: { "user-agent": BROWSER_UA } });
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) };
}

describe("閲覧スナップショット（R2 view/<slug>.json）", () => {
  it("作成時に作られ、公開 JSON に edit_token を含まない", async () => {
    const { slug, edit_token } = await createList({ owner_name: "作成者" });
    const snap = await readSnapshot(slug);
    expect(snap?.list.owner_name).toBe("作成者");
    expect(snap?.list.items).toHaveLength(100);
    const res = await getJson(slug);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("edit_token");
    expect(text).not.toContain(edit_token);
  });

  it("更新するとスナップショットと閲覧キャッシュがすぐ新しい内容になる", async () => {
    const { slug, edit_token } = await createList({ owner_name: "前の名前" });
    // 閲覧ページと JSON を一度読んで colo キャッシュに載せる
    expect(await (await view(slug)).text()).toContain("前の名前");
    expect(((await (await getJson(slug)).json()) as MangaList).owner_name).toBe("前の名前");

    expect((await updateList(slug, { edit_token, owner_name: "新しい名前" })).status).toBe(200);
    expect((await readSnapshot(slug))?.list.owner_name).toBe("新しい名前");
    const html = await (await view(slug)).text();
    expect(html).toContain("新しい名前");
    expect(html).not.toContain("前の名前");
    expect(((await (await getJson(slug)).json()) as MangaList).owner_name).toBe("新しい名前");
  });

  it("スナップショットが無ければ D1 から作り直して置く", async () => {
    const { slug } = await createList({ owner_name: "再作成" });
    await bucket().delete(snapshotKey(slug));
    const { ctx, settle } = fakeCtx();
    expect((await getListSnapshot(env, ctx, slug))?.owner_name).toBe("再作成");
    await settle();
    expect((await readSnapshot(slug))?.list.owner_name).toBe("再作成");
  });

  it("24 時間を過ぎたスナップショットは返しつつ裏で作り直す", async () => {
    const { slug } = await createList({ owner_name: "最新" });
    const snap = (await readSnapshot(slug))!;
    snap.list.owner_name = "古い";
    snap.built_at = Date.now() - SNAPSHOT_MAX_AGE_MS - 1000;
    await bucket().put(snapshotKey(slug), JSON.stringify(snap));

    const { ctx, settle } = fakeCtx();
    expect((await getListSnapshot(env, ctx, slug))?.owner_name).toBe("古い");
    await settle();
    const fresh = await readSnapshot(slug);
    expect(fresh?.list.owner_name).toBe("最新");
    expect(fresh!.built_at).toBeGreaterThan(snap.built_at);
  });

  it("管理者の変更で世代が上がると、新しいスナップショットでもすぐ作り直す", async () => {
    const { slug } = await createList({ owner_name: "最新" });
    const snap = (await readSnapshot(slug))!;
    snap.list.owner_name = "管理者変更前";
    await bucket().put(snapshotKey(slug), JSON.stringify(snap));
    const { ctx } = fakeCtx();
    expect((await getListSnapshot(env, ctx, slug))?.owner_name).toBe("管理者変更前");

    await bumpViewEpoch(env);
    expect((await getListSnapshot(env, ctx, slug))?.owner_name).toBe("最新");
    expect((await readSnapshot(slug))?.list.owner_name).toBe("最新");
  });

  it("管理者削除でスナップショットと共有画像を消し、閲覧ページは 404 のページになる", async () => {
    const { slug } = await createList();
    await bucket().put(`share/${slug}/og-0000.jpg`, new Uint8Array([1, 2, 3]));
    await view(slug); // colo キャッシュに載せる

    expect((await adminDeleteList(env, slug, "https://example.com")).status).toBe(200);
    expect(await bucket().head(snapshotKey(slug))).toBeNull();
    expect(await bucket().head(`share/${slug}/og-0000.jpg`)).toBeNull();

    const res = await view(slug);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(`href="/"`);
    expect((await getJson(slug)).status).toBe(404);
  });

  it("存在しない slug の削除では他のリストの R2 を触らない", async () => {
    const { slug } = await createList();
    expect((await adminDeleteList(env, "no-such-list")).status).toBe(404);
    expect(await bucket().head(snapshotKey(slug))).not.toBeNull();
  });

  it("退会でリストを消すとき、消したリストのスナップショット・共有画像も消す", async () => {
    const { slug } = await createList();
    const { slug: other } = await createList();
    await env.DB.prepare(`UPDATE lists SET user_id = 'u-snap' WHERE slug = ?`).bind(slug).run();
    await bucket().put(`share/${slug}/full-0000.jpg`, new Uint8Array([1]));
    const req = new Request("https://example.com/api/me", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_lists: true }),
    });
    const res = await deleteAccount(req, env, { id: "u-snap", email: "", name: "", picture: "" });
    expect(res.status).toBe(200);
    expect(await bucket().head(snapshotKey(slug))).toBeNull();
    expect(await bucket().head(`share/${slug}/full-0000.jpg`)).toBeNull();
    expect(await bucket().head(snapshotKey(other))).not.toBeNull();
  });

  it("表示名の伏字でスナップショットを消し、次の閲覧に反映する", async () => {
    const { slug } = await createList({ owner_name: "けしたい名前" });
    expect(await (await view(slug)).text()).toContain("けしたい名前");
    const now = Date.now();
    const ins = await env.DB.prepare(
      `INSERT INTO reports (slug, target_type, position, reported_text, first_at, last_at) VALUES (?, 'owner_name', 0, ?, ?, ?)`
    )
      .bind(slug, "けしたい名前", now, now)
      .run();
    const id = Number(ins.meta.last_row_id);
    expect((await adminRedactReport(env, id, "https://example.com")).status).toBe(200);
    expect(await bucket().head(snapshotKey(slug))).toBeNull();
    expect(await (await view(slug)).text()).not.toContain("けしたい名前");
  });
});

describe("閲覧ページ", () => {
  it("表示名の $& や $` をテンプレート置換の特殊パターンとして解釈しない", async () => {
    const { slug } = await createList({ owner_name: "a$&b$`c$'d" });
    const html = await (await view(slug)).text();
    expect(html).toContain("a$&amp;b$`c$&#39;d");
    expect(html).not.toMatch(/<!--(OGP_META|LIST_DATA|ANALYTICS|GTM_BODY|HEADER_LINKS|FOOTER_AFF)-->/);
  });

  it("カード版にも canonical を付ける", async () => {
    const { slug } = await createList();
    const html = await (await view(slug)).text();
    expect(html).toContain(`<link rel="canonical" href="https://example.com/l/${slug}">`);
    expect(html).toContain(`property="og:image"`);
  });
});

describe("共有画像の生成", () => {
  it("同梱フォントで描いて JPEG を返し、R2 に置く", async () => {
    const { slug } = await createList({ owner_name: "描画テスト" });
    const res = await SELF.fetch(`https://example.com/share/${slug}/og.jpg`, { headers: { "user-agent": "Twitterbot/1.0" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    const listed = await bucket().list({ prefix: `share/${slug}/og-` });
    expect(listed.objects.length).toBe(1);
  });
});

describe("OGP の説明文", () => {
  const item = (title: string, series_title = ""): ListItem => ({
    position: 1,
    isbn: "9784000000000",
    comment: "",
    spoiler: false,
    title,
    author: "",
    cover_url: "",
    series_title,
  });
  it("同じシリーズの巻は 1 つにまとめ、シリーズの無い本は書名を使う", () => {
    const list = {
      items: [
        item("ONE PIECE 1", "ONE PIECE"),
        item("ONE PIECE 2", "ONE PIECE"),
        item("短編集"),
        item("ISBN 9784000000000"),
        item("NARUTO 3", "NARUTO"),
      ],
    } as MangaList;
    expect(ogpWorkTitles(list)).toEqual(["ONE PIECE", "短編集", "NARUTO"]);
  });
});

describe("共有画像の出典クレジット", () => {
  it("表紙 URL から出典を判定する", () => {
    expect(coverSource("https://thumbnail.image.rakuten.co.jp/@0_pdb/@0_6/1234/x.jpg?_ex=300x300")).toBe("楽天ブックス");
    expect(coverSource("https://thumbnail.image.rakuten.co.jp/@0_mall/shop/cabinet/x.jpg")).toBe("楽天市場");
    expect(coverSource("https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/2977/9784403622977.jpg?_ex=300x300")).toBe("楽天ブックス");
    expect(coverSource("https://item-shopping.c.yimg.jp/i/n/store_x")).toBe("Yahoo!ショッピング");
    expect(coverSource("https://books.google.com/books/content?id=x")).toBe("Google Books");
    expect(coverSource("https://example.org/x.jpg")).toBe("各販売サイト");
    expect(coverSource("")).toBeNull();
  });

  it("描くセルにある出典だけを固定順で並べ、© 各著作権者を付ける", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      cover_url: i < 25 ? "https://item-shopping.c.yimg.jp/i/n/a" : i === 99 ? "https://thumbnail.image.rakuten.co.jp/@0_pdb/a.jpg" : "",
    }));
    const list = { items } as unknown as MangaList;
    expect(creditLine(list, "q1")).toBe("書影: Yahoo!ショッピング　© 各著作権者");
    expect(creditLine(list, "q2")).toBe("© 各著作権者");
    expect(creditLine(list, "og")).toBe("書影: 楽天ブックス / Yahoo!ショッピング　© 各著作権者");
  });

  it("楽天の表紙はセルに見合う大きさで取り、もったいない本舗は触らない", () => {
    expect(shareCoverUrl("https://thumbnail.image.rakuten.co.jp/@0_pdb/a.jpg?_ex=300x300", 40)).toContain("_ex=150x150");
    const m = "https://thumbnail.image.rakuten.co.jp/@0_mall/mottainaihonpo/cabinet/a.jpg?_ex=600x600";
    expect(shareCoverUrl(m, 40)).toBe(m);
    expect(shareCoverUrl("https://item-shopping.c.yimg.jp/i/n/a", 40)).toBe("https://item-shopping.c.yimg.jp/i/n/a");
  });

  it("リンクプレビューのクローラを判定する", () => {
    expect(isLinkPreviewBot("Twitterbot/1.0")).toBe(true);
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; Discordbot/2.0)")).toBe(true);
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; Bluesky Cardyb/1.1)")).toBe(true);
    expect(isLinkPreviewBot(BROWSER_UA)).toBe(false);
    expect(isLinkPreviewBot(null)).toBe(false);
  });
});
