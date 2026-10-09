import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSlackPayload, formatError, sendAlert } from "../src/alert";
import type { Env } from "../src/types";

const HOOK = "https://hooks.slack.test/services/T/B/x";

function makeEnv(extra: Partial<Env> = {}): Env {
  return { SLACK_WEBHOOK_URL: HOOK, ALERT_ENV: "test", ...extra } as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("sendAlert", () => {
  it("SLACK_WEBHOOK_URL が無ければ送らない", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await sendAlert(makeEnv({ SLACK_WEBHOOK_URL: undefined }), { level: "info", title: "x" })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Webhook に JSON を POST する", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const ok = await sendAlert(makeEnv(), { level: "error", title: `post-${crypto.randomUUID()}`, throttleSec: 0 });
    expect(ok).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(HOOK);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).text).toContain("[test]");
  });

  it("同じキーは抑止期間中 1 回だけ送る", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const title = `throttle-${crypto.randomUUID()}`;
    expect(await sendAlert(makeEnv(), { level: "warning", title })).toBe(true);
    expect(await sendAlert(makeEnv(), { level: "warning", title })).toBe(false);
    expect(await sendAlert(makeEnv(), { level: "warning", title: `${title}-other` })).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("Slack の失敗や例外は投げずに false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("no", { status: 500 }));
    expect(await sendAlert(makeEnv(), { level: "error", title: "a", throttleSec: 0 })).toBe(false);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    expect(await sendAlert(makeEnv(), { level: "error", title: "b", throttleSec: 0 })).toBe(false);
  });
});

describe("buildSlackPayload", () => {
  it("環境名・色・fields を組み、null/undefined の項目と制御文字を処理する", () => {
    const p = buildSlackPayload(makeEnv(), {
      level: "error",
      title: "a<b>&c",
      text: "body",
      fields: { slug: "abc", count: 3, none: undefined, nil: null },
    }) as { text: string; attachments: { color: string; text: string; fields: { title: string; value: string }[] }[] };
    expect(p.text).toBe(":rotating_light: [test] a&lt;b&gt;&amp;c");
    expect(p.attachments[0].color).toBe("#d0021b");
    expect(p.attachments[0].fields.map((f) => f.title)).toEqual(["slug", "count"]);
    expect(p.attachments[0].fields[1].value).toBe("3");
  });
});

describe("formatError", () => {
  it("Error は name: message とスタック、それ以外は文字列化", () => {
    const e = new TypeError("boom");
    expect(formatError(e)).toMatch(/^TypeError: boom/);
    expect(formatError("plain")).toBe("plain");
  });
});
