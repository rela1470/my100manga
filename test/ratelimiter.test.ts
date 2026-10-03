import { describe, expect, it } from "vitest";
import { awaitSlot } from "../src/ratelimiter";
import type { Env } from "../src/types";

// RAKUTEN_LIMITER（Durable Object）の代わりに、acquire の戻り値と呼ばれ方を記録する偽物を使う。
function fakeEnv(acquire: (cap: number, priority: string) => Promise<number>) {
  const calls: { instance: string; cap: number; priority: string }[] = [];
  const env = {
    RAKUTEN_LIMITER: {
      getByName: (instance: string) => ({
        acquire: (cap: number, priority: string) => {
          calls.push({ instance, cap, priority });
          return acquire(cap, priority);
        },
      }),
    },
  } as unknown as Env;
  return { env, calls };
}

describe("awaitSlot", () => {
  it("リミッタが無い環境（ローカル等）は待たずに通す", async () => {
    expect(await awaitSlot({} as Env, "global", "low")).toBe(true);
  });

  it("API ごとのインスタンスと優先度の既定の待ち上限で枠を取る", async () => {
    const { env, calls } = fakeEnv(async () => 0);
    expect(await awaitSlot(env, "yahoo", "high")).toBe(true);
    expect(await awaitSlot(env, "global", "low")).toBe(true);
    expect(calls).toEqual([
      { instance: "yahoo", cap: 15000, priority: "high" },
      { instance: "global", cap: 8000, priority: "low" },
    ]);
  });

  it("待ち上限が 0 以下なら枠を取らずに諦める", async () => {
    const { env, calls } = fakeEnv(async () => 0);
    expect(await awaitSlot(env, "global", "low", 0)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("枠が上限を超える（-1）なら諦める", async () => {
    const { env } = fakeEnv(async () => -1);
    expect(await awaitSlot(env, "global", "low")).toBe(false);
  });

  it("リミッタの障害では表紙取得を止めない", async () => {
    const { env } = fakeEnv(async () => {
      throw new Error("down");
    });
    expect(await awaitSlot(env, "global", "low")).toBe(true);
  });
});
