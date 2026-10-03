import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { consumeViewBatch } from "../src/publicLists";

export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36";

/** チェックディジットまで正しい ISBN-13 を n 個（978 + 連番）。 */
export function makeIsbns(n: number, offset = 0): string[] {
  return Array.from({ length: n }, (_, i) => {
    const core = "978" + String(400000000 + offset + i).padStart(9, "0");
    let sum = 0;
    for (let j = 0; j < 12; j++) sum += (j % 2 === 0 ? 1 : 3) * Number(core[j]);
    return core + ((10 - (sum % 10)) % 10);
  });
}

export function items(n = 100, offset = 0) {
  return makeIsbns(n, offset).map((isbn) => ({ isbn, comment: "", spoiler: false }));
}

export async function createList(body: Record<string, unknown> = {}): Promise<{ slug: string; edit_token: string }> {
  const res = await SELF.fetch("https://example.com/api/lists", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify({ owner_name: "テスト", items: items(), ...body }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function updateList(slug: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://example.com/api/lists/${slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
    body: JSON.stringify({ items: items(), ...body }),
  });
}

export function view(slug: string, ua = BROWSER_UA): Promise<Response> {
  return SELF.fetch(`https://example.com/l/${slug}`, { headers: { "user-agent": ua }, redirect: "manual" });
}

// 閲覧ビーコンのキュー（VIEW_QUEUE）。本物の consumer はテストでは走らない（max_batch_timeout
// が 10 秒）ので、積まれたメッセージを控えておいて beacon() が同じ consumer に渡す。
const queuedViews: unknown[] = [];
(env as { VIEW_QUEUE?: unknown }).VIEW_QUEUE = {
  send: async (body: unknown) => void queuedViews.push(body),
};

/** 積まれた閲覧ビーコンを consumer（src/publicLists.ts consumeViewBatch）に流す。 */
export async function flushViewQueue(): Promise<void> {
  const messages = queuedViews.splice(0).map((body) => ({ body }));
  if (!messages.length) return;
  await consumeViewBatch({ queue: "my100manga-views", messages } as unknown as MessageBatch<unknown>, env);
}

/** 閲覧ページのアクセス数ビーコン。ip / ua で訪問者を変えられる。キューに積まれた分は
 *  そのまま consumer に流すので、呼んだ時点で数え終わっている。 */
export async function beacon(slug: string, opts: { ip?: string; ua?: string } = {}): Promise<Response> {
  const res = await SELF.fetch(`https://example.com/api/lists/${slug}/view`, {
    method: "POST",
    headers: { "user-agent": opts.ua ?? BROWSER_UA, "cf-connecting-ip": opts.ip ?? "203.0.113.1" },
  });
  await flushViewQueue();
  return res;
}
