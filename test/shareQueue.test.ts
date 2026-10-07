import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BROWSER_UA, createList, updateList } from "./helpers";

// 共有画像の事前生成キュー（SHARE_QUEUE）と、待機 UI が使う /api/share-status・
// /api/share-prepare（src/index.ts）。本物の consumer は 1 枚ごとに resvg の描画が走るので、
// ここでは producer を差し替えて「何を積んだか」だけを見る。
interface Sent {
  body: { slug: string; host: string; updated_at?: number; variants?: string[] };
  opts?: { delaySeconds?: number };
}
const sent: Sent[] = [];
(env as { SHARE_QUEUE?: unknown }).SHARE_QUEUE = {
  send: async (body: unknown, opts?: unknown) => void sent.push({ body, opts } as Sent),
};

/** キューに積むのは公開レスポンスのあと（ctx.waitUntil）なので、届くまで少し待つ。 */
async function waitForSend(n = 1): Promise<Sent[]> {
  for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  return sent;
}

function status(slug: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/share-status?slug=${encodeURIComponent(slug)}`);
}

function prepare(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/api/share-prepare", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify(body),
  });
}

beforeEach(() => void sent.splice(0));

describe("共有画像の事前生成", () => {
  it("公開では full だけを積み、4 枚版は積まない", async () => {
    const { slug } = await createList();
    const [job] = await waitForSend();
    expect(job.body.slug).toBe(slug);
    expect(job.body.variants).toEqual(["full"]);
    // 公開直後に「画像でポスト」を押されるので、初回は短い遅延で積む。
    expect(job.opts?.delaySeconds).toBe(5);
  });

  it("更新では遅延を長くとる（連続編集をまとめるため）", async () => {
    const { slug, edit_token } = await createList();
    await waitForSend();
    // full が一度描かれたあとの更新、という状態を作る。
    await env.COVERS.put(`share/${slug}/full-0123456789abcdef.jpg`, new Uint8Array([1]));
    sent.splice(0);
    expect((await updateList(slug, { edit_token, owner_name: "更新後" })).status).toBe(200);
    const [job] = await waitForSend();
    expect(job.body.variants).toEqual(["full"]);
    expect(job.opts?.delaySeconds).toBe(60);
  });

  it("一度 4 枚版が描かれた slug は、更新時に 4 枚版も一緒に積み直す", async () => {
    const { slug, edit_token } = await createList();
    await waitForSend();
    // 古いハッシュのままでよい（「要求されたことがある」印として読む）。
    await env.COVERS.put(`share/${slug}/q1-0123456789abcdef.jpg`, new Uint8Array([1]));
    sent.splice(0);
    expect((await updateList(slug, { edit_token, owner_name: "更新後" })).status).toBe(200);
    const [job] = await waitForSend();
    expect(job.body.variants).toEqual(["full", "q1", "q2", "q3", "q4"]);
  });
});

describe("/api/share-status", () => {
  it("いまの内容のハッシュと、出来ている variant を返す", async () => {
    const { slug } = await createList();
    const res = await status(slug);
    expect(res.status).toBe(200);
    const first = (await res.json()) as { hash: string; ready: string[] };
    expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(first.ready).not.toContain("full");

    // そのハッシュで置けば ready に出る。別ハッシュのものは数えない。
    await env.COVERS.put(`share/${slug}/full-${first.hash}.jpg`, new Uint8Array([1]));
    await env.COVERS.put(`share/${slug}/q1-0123456789abcdef.jpg`, new Uint8Array([1]));
    const after = (await (await status(slug)).json()) as { ready: string[] };
    expect(after.ready).toContain("full");
    expect(after.ready).not.toContain("q1");
  });

  it("内容を変えるとハッシュが変わり、前の画像は ready に出ない", async () => {
    const { slug, edit_token } = await createList();
    const before = (await (await status(slug)).json()) as { hash: string };
    await env.COVERS.put(`share/${slug}/full-${before.hash}.jpg`, new Uint8Array([1]));
    expect(((await (await status(slug)).json()) as { ready: string[] }).ready).toContain("full");

    expect((await updateList(slug, { edit_token, owner_name: "別の名前" })).status).toBe(200);
    const after = (await (await status(slug)).json()) as { hash: string; ready: string[] };
    expect(after.hash).not.toBe(before.hash);
    expect(after.ready).not.toContain("full");
  });

  it("無いリストは 404、slug の形が違えば 400", async () => {
    expect((await status("nosuchlist")).status).toBe(404);
    expect((await status("../etc")).status).toBe(400);
    expect((await status("")).status).toBe(400);
  });
});

describe("/api/share-prepare", () => {
  it("4 枚版を要求すると q1–q4 を遅延なしで積む", async () => {
    const { slug } = await createList();
    await waitForSend();
    sent.splice(0);
    const res = await prepare({ slug, kind: "quarters" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true });
    const [job] = await waitForSend();
    expect(job.body.variants).toEqual(["q1", "q2", "q3", "q4"]);
    expect(job.opts).toBeUndefined();
    // 押した人が待っているので、遅延中の編集を理由に捨てられては困る（updated_at を付けない）。
    expect(job.body.updated_at).toBeUndefined();
  });

  it("種類を指定しなければ full", async () => {
    const { slug } = await createList();
    await waitForSend();
    sent.splice(0);
    await prepare({ slug });
    const [job] = await waitForSend();
    expect(job.body.variants).toEqual(["full"]);
  });

  it("無いリストは 404、slug の形が違えば 400", async () => {
    expect((await prepare({ slug: "nosuchlist", kind: "quarters" })).status).toBe(404);
    expect((await prepare({ slug: "../etc" })).status).toBe(400);
    expect((await prepare({})).status).toBe(400);
  });
});
