import { describe, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { awaitSlot } from "../src/ratelimiter";
import type { Env } from "../src/types";

// RAKUTEN_LIMITER（Durable Object）の代わりに、acquire の戻り値と呼ばれ方を記録する偽物を使う。
// 本体は idFromName + get（置き場所ヒント付き）で引くので、その形で受ける。
function fakeEnv(acquire: (cap: number, priority: string) => Promise<number>) {
  const calls: { instance: string; cap: number; priority: string; hint?: string }[] = [];
  const env = {
    RAKUTEN_LIMITER: {
      idFromName: (instance: string) => instance,
      get: (instance: string, opts?: { locationHint?: string }) => ({
        acquire: (cap: number, priority: string) => {
          calls.push({ instance, cap, priority, hint: opts?.locationHint });
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
      // hint: DO は最初に触れた場所に作られるので、アジア太平洋に作るよう指定する。
      { instance: "yahoo", cap: 4000, priority: "high", hint: "apac" },
      { instance: "global", cap: 8000, priority: "low", hint: "apac" },
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

  // リミッタが落ちているときに素通しすると、障害中は全 Worker が無制限に楽天/Yahoo を叩く
  // （＝API キーごと止められうる）。表紙・あらすじは任意なので呼ばない側に倒す。
  it("リミッタの障害では外部 API を呼ばない（fail closed）", async () => {
    const { env } = fakeEnv(async () => {
      throw new Error("down");
    });
    expect(await awaitSlot(env, "global", "low")).toBe(false);
  });
});

// RakutenRateLimiter（Durable Object）本体。acquire は待たずに「いつ投げてよいか」だけを
// 返すので、実時間を使わずに予約の並びを見られる。インスタンス名はテストごとに分ける。
describe("RakutenRateLimiter.acquire", () => {
  const limiter = (name: string) => (workerEnv as unknown as Env).RAKUTEN_LIMITER!.getByName(name);
  const INTERVAL = 1100;

  it("同じレーンの予約は 1 秒強ずつ空き、先の枠までは取れない", async () => {
    const dur = limiter("pace");
    // 待ちは「今から何ミリ秒後か」なので、実時間の経過に影響されない絶対時刻で見る。
    const first = Date.now() + (await dur.acquire(8000, "low"));
    const second = Date.now() + (await dur.acquire(8000, "low"));
    expect(second - first).toBeGreaterThanOrEqual(INTERVAL - 50);
    // 背景のレーンは 2.2 秒先までしか予約できない（MAX_BOOK_AHEAD）。待ち上限を長くしても
    // 深く積めないので、あとから来た高優先が先の枠に入れる。
    expect(await dur.acquire(8000, "low")).toBe(-1);
  });

  it("待ち上限に収まらなければ予約せず -1（キューが際限なく伸びない）", async () => {
    const dur = limiter("cap");
    const waits: number[] = [];
    let refused = false;
    for (let i = 0; i < 20; i++) {
      const w = await dur.acquire(4000, "high");
      if (w < 0) {
        refused = true;
        break;
      }
      waits.push(w);
    }
    expect(refused).toBe(true); // 何回呼んでも予約が伸び続けることはない
    expect(waits.length).toBeGreaterThan(1);
    expect(Math.max(...waits)).toBeLessThanOrEqual(4000);
    // 待ち上限を広げても、レーンごとの予約の深さ（MAX_BOOK_AHEAD）は超えられない。
    // ここが伸びると、あとから来たもう片方のレーンが自分の待ち上限を超えて弾かれる。
    expect(await dur.acquire(30000, "high")).toBe(-1);
    // 埋めたのと別のレーンなら、空けてある枠を取れる。
    expect(await dur.acquire(8000, "low")).toBeGreaterThanOrEqual(0);
  });

  it("レーンをまたいでも 1 秒に 1 回を超えない（全体で 1 本の予約列）", async () => {
    const dur = limiter("budget");
    const at: number[] = [];
    for (const p of ["low", "high", "low", "high", "low", "high", "low", "high"] as const) {
      const wait = await dur.acquire(8000, p);
      if (wait >= 0) at.push(Date.now() + wait); // 断られた分（-1）は予約していない
    }
    expect(at.length).toBeGreaterThanOrEqual(4);
    const sorted = [...at].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(INTERVAL - 50);
    }
  });

  // 連続して取れるのは MAX_RUN(2) 枠までなので、予約列には 3 枠ごとに空きが残る。どれだけ
  // 片方が埋めても、もう片方は 3 枠（約 3.3 秒）以内に枠を取れる。位置で決める規則なので、
  // 埋める側の呼び出しが速くても遅くても保証は変わらない。
  const MAX_OTHER_LANE_WAIT = 3 * INTERVAL;

  it("片方のレーンが埋めても、もう片方は 3 枠以内に枠を取れる（相互に飢えさせない）", async () => {
    const dur = limiter("fairness");
    // 背景（low）の取り込みで待ち上限いっぱいまで予約する。
    for (let i = 0; i < 20; i++) if ((await dur.acquire(8000, "low")) < 0) break;
    const high = await dur.acquire(4000, "high");
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(MAX_OTHER_LANE_WAIT);
  });

  it("逆向きも同じ（利用者の操作が続いても背景の取り込みが止まらない）", async () => {
    const dur = limiter("fairness-rev");
    for (let i = 0; i < 20; i++) if ((await dur.acquire(4000, "high")) < 0) break;
    const low = await dur.acquire(8000, "low");
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(MAX_OTHER_LANE_WAIT);
  });

  // 空けた枠を後から同じレーンが埋められると、連続した予約がいくらでも伸びて上の保証が
  // 崩れる（時間で決める規則にしていたときの実際の不具合）。間を空けて何度も取り直す。
  it("時間が経っても同じレーンが連続して埋め尽くせない", async () => {
    const dur = limiter("no-creep");
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++) if ((await dur.acquire(8000, "low")) < 0) break;
      await new Promise((r) => setTimeout(r, 1200)); // 枠が 1 つ過ぎるのを待つ
    }
    const high = await dur.acquire(4000, "high");
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(MAX_OTHER_LANE_WAIT);
  });

  it("両方のレーンが使っているときは枠を捨てずに互い違いに詰まる", async () => {
    const dur = limiter("interleave");
    const at: number[] = [];
    for (let i = 0; i < 4; i++) {
      const wait = await dur.acquire(8000, i % 2 === 0 ? "low" : "high");
      expect(wait).toBeGreaterThanOrEqual(0); // 互い違いなら連続の上限に当たらない
      at.push(Date.now() + wait);
    }
    // 4 枠が 1.1 秒間隔で詰まっている（片方だけのときのように 3 枠に 1 つ空けない）。
    const sorted = [...at].sort((a, b) => a - b);
    expect(sorted[3] - sorted[0]).toBeLessThanOrEqual(3 * INTERVAL + 100);
  });
});
