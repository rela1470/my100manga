import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DRAFT_DEVICE_WINDOW_MS, purgeDraftDevices } from "../src/draftDevices";
import { adminStats } from "../src/admin";

const DEVICE = "0123456789abcdef0123456789abcdef";

function ping(device: unknown) {
  return SELF.fetch("https://example.com/api/draft-ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device }),
  });
}

async function stats() {
  const res = await adminStats(new Request("https://example.com/api/admin/stats"), env);
  return ((await res.json()) as { stats: Record<string, number> }).stats;
}

describe("POST /api/draft-ping", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM draft_devices`).run();
  });

  it("同じ端末は何度知らせても 1 台と数える", async () => {
    expect((await ping(DEVICE)).status).toBe(200);
    expect((await ping(DEVICE)).status).toBe(200);
    expect((await stats()).draft_devices).toBe(1);
  });

  it("形の壊れた ID は受け付けない", async () => {
    for (const bad of ["", "short", "x".repeat(65), "has space 0123456789", 123, null]) {
      expect((await ping(bad)).status).toBe(400);
    }
    expect((await stats()).draft_devices).toBe(0);
  });

  it("30 日より前の知らせは数えず、cron で消える", async () => {
    const old = Date.now() - DRAFT_DEVICE_WINDOW_MS - 1000;
    await env.DB.prepare(`INSERT INTO draft_devices (device, last_seen) VALUES (?, ?)`).bind("old-device-0123456789", old).run();
    await ping(DEVICE);
    expect((await stats()).draft_devices).toBe(1);
    await purgeDraftDevices(env);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM draft_devices`).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("adminStats", () => {
  it("Google アカウント数を返す", async () => {
    expect((await stats()).users).toBe(0);
    await env.DB.prepare(
      `INSERT INTO users (id, google_sub, created_at, last_login_at) VALUES ('u1', 'sub1', 0, 0), ('u2', 'sub2', 0, 0)`
    ).run();
    expect((await stats()).users).toBe(2);
  });
});
