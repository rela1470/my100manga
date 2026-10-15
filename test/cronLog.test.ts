import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminCronRuns, purgeCronRuns, recordCronTick, runLogged } from "../src/cronLog";

// cron の実行履歴（cron_runs, src/cronLog.ts）と管理画面の API（GET /api/admin/cron-runs）。

describe("runLogged", () => {
  it("成功・失敗を 1 行ずつ残し、失敗は握りつぶす。skip なら残さない", async () => {
    const ok = await runLogged(env, "0 20 * * *", "t-ok", async () => ({ n: 3 }));
    expect(ok).toEqual({ n: 3 });
    const ng = await runLogged(env, "0 20 * * *", "t-ng", async () => {
      throw new Error("こわれた");
    });
    expect(ng).toBeUndefined();
    await runLogged(env, "*/2 * * * *", "t-skip", async () => ({ idle: true }), (r) => r.idle);

    const rows = (
      await env.DB.prepare(`SELECT job, ok, detail FROM cron_runs WHERE job LIKE 't-%' ORDER BY id`).all<any>()
    ).results;
    expect(rows).toEqual([
      { job: "t-ok", ok: 1, detail: '{"n":3}' },
      { job: "t-ng", ok: 0, detail: "こわれた" },
    ]);
  });

  it("30 日より古い履歴を消す", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO cron_runs (cron, job, started_at, finished_at, ok, detail) VALUES ('x', 't-old', ?, ?, 1, '')`
    )
      .bind(now - 31 * 86400_000, now - 31 * 86400_000)
      .run();
    expect((await purgeCronRuns(env, now)).deleted).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare(`SELECT 1 FROM cron_runs WHERE job = 't-old'`).first()).toBeNull();
  });
});

describe("GET /api/admin/cron-runs", () => {
  it("仕事ごとのまとめ・履歴・最後に起動した時刻を返し、job で絞り込める", async () => {
    await recordCronTick(env, "*/2 * * * *", 1234);
    await runLogged(env, "0 20 * * *", "t-api", async () => "done");
    // 認証（Cloudflare Access）は test/security.test.ts で見ているので、ここでは関数を直接呼ぶ。
    const res = await adminCronRuns(env, new URL("https://example.com/api/admin/cron-runs?job=t-api"));
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.runs.every((r: any) => r.job === "t-api")).toBe(true);
    expect(d.jobs.find((j: any) => j.job === "t-api")).toMatchObject({ runs: 1, errors: 0 });
    expect(d.ticks).toContainEqual({ cron: "*/2 * * * *", at: 1234 });
  });
});

describe("scheduled の振り分け", () => {
  it("2 分ごとの起動は数え直しだけ（日次の掃除は走らない）、日次の起動は掃除を記録する", async () => {
    const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import("cloudflare:test");
    const worker = (await import("../src/index")).default;
    const run = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
      await waitOnExecutionContext(ctx);
    };
    const jobs = async () =>
      ((await env.DB.prepare(`SELECT DISTINCT job FROM cron_runs`).all<{ job: string }>()).results ?? []).map((r) => r.job);

    await env.DB.prepare(`DELETE FROM cron_runs`).run();
    await run("*/2 * * * *");
    expect((await jobs()).filter((j) => j.startsWith("purge-"))).toEqual([]);
    const tick = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'cron_tick:*/2 * * * *'`).first();
    expect(tick).not.toBeNull();

    await run("0 20 * * *");
    expect(await jobs()).toEqual(expect.arrayContaining(["purge-publish-audit", "purge-cron-runs", "purge-sessions"]));
  });
});
