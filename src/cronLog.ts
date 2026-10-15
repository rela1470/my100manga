import { Env } from "./types";
import { json } from "./util";

// cron（wrangler.jsonc triggers）の実行履歴。管理画面の「cron の履歴」が読む。
//
// 仕事（job）ごとに、終わった時点で 1 行書く（成功・失敗・所要時間・結果の要約）。起動の途中で
// Worker が落ちたものは行が残らないので、「最後に起動した時刻」を cron の式ごとに meta に別に
// 持ち（cron_tick:<式>）、起動そのものが止まっていないかはそちらで見る。
// 2 分ごとの巻数の数え直しは、仕事が無かった回（idle）まで書くと 1 日 720 行になるので、
// 数えた回だけ書く（skip）。履歴は 30 日で消す（日次 cron の purgeCronRuns）。

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_MAX = 500;
const TICK_PREFIX = "cron_tick:";

/** 起動のたびに、その cron の式の「最後に起動した時刻」を残す。失敗しても cron は止めない。 */
export async function recordCronTick(env: Env, cron: string, now = Date.now()): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
      .bind(TICK_PREFIX + cron, String(now))
      .run();
  } catch (err) {
    console.error("cron tick write failed", cron, err);
  }
}

function summarize(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) + "…" : s;
}

/** fn を実行して結果を cron_runs に 1 行書く。失敗は握りつぶして（ログと履歴に残して）
 *  undefined を返す（cron の他の仕事を止めない）。skip(result) が true なら書かない。 */
export async function runLogged<T>(
  env: Env,
  cron: string,
  job: string,
  fn: () => Promise<T>,
  skip?: (result: T) => boolean
): Promise<T | undefined> {
  const started = Date.now();
  let ok = 1;
  let detail = "";
  let result: T | undefined;
  try {
    result = await fn();
    if (skip?.(result)) return result;
    detail = summarize(result);
  } catch (err) {
    ok = 0;
    detail = summarize(err instanceof Error ? err.message : String(err));
    console.error(`cron job failed: ${job}`, err);
  }
  try {
    await env.DB.prepare(
      `INSERT INTO cron_runs (cron, job, started_at, finished_at, ok, detail) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(cron, job, started, Date.now(), ok, detail)
      .run();
  } catch (err) {
    console.error("cron run log write failed", job, err); // 表が無い DB（マイグレーション前）など
  }
  return result;
}

/** 30 日より古い履歴を消す（日次 cron）。 */
export async function purgeCronRuns(env: Env, now = Date.now()): Promise<{ deleted: number }> {
  const r = await env.DB.prepare(`DELETE FROM cron_runs WHERE started_at < ?`).bind(now - RETENTION_MS).run();
  return { deleted: r.meta?.changes ?? 0 };
}

/** GET /api/admin/cron-runs。仕事ごとの最終実行と、履歴（新しい順）。job で絞り込める。 */
export async function adminCronRuns(env: Env, url: URL): Promise<Response> {
  const job = (url.searchParams.get("job") ?? "").slice(0, 64);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const per = Math.min(200, Math.max(1, Number(url.searchParams.get("per")) || 50));
  const where = job ? `WHERE job = ?` : "";
  const binds = job ? [job] : [];
  const total =
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs ${where}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const runs =
    (
      await env.DB.prepare(
        `SELECT id, cron, job, started_at, finished_at, ok, detail FROM cron_runs ${where}
          ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`
      )
        .bind(...binds, per, (page - 1) * per)
        .all()
    ).results ?? [];
  const jobs =
    (
      await env.DB.prepare(
        `SELECT job, cron,
                MAX(started_at) AS last_at,
                MAX(CASE WHEN ok = 1 THEN started_at END) AS last_ok_at,
                MAX(CASE WHEN ok = 0 THEN started_at END) AS last_error_at,
                COUNT(*) AS runs,
                SUM(ok = 0) AS errors
           FROM cron_runs GROUP BY job, cron ORDER BY job`
      ).all()
    ).results ?? [];
  const ticks =
    (
      await env.DB.prepare(`SELECT key, value FROM meta WHERE key LIKE ?`)
        .bind(TICK_PREFIX + "%")
        .all<{ key: string; value: string }>()
    ).results ?? [];
  return json(
    {
      total,
      page,
      per,
      runs,
      jobs,
      ticks: ticks.map((t) => ({ cron: t.key.slice(TICK_PREFIX.length), at: Number(t.value) })),
    },
    200,
    { "cache-control": "no-store" }
  );
}
