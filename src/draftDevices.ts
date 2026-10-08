import { Env } from "./types";
import { json } from "./util";

// 本棚の下書きを localStorage に持っている端末の数え上げ。下書きはサーバに送られないので、
// 作成画面（public/api.js draftPing）が「この端末に下書きがある」とだけ 1 日 1 回知らせる。
// 管理画面には「過去 30 日に知らせがあった端末数」を出す（src/admin.ts adminStats）。
// 下書きを消した・ブラウザのデータを消した端末はサーバから見えないので、厳密な「いま保存中」ではない。

const DAY_MS = 24 * 60 * 60 * 1000;
export const DRAFT_DEVICE_WINDOW_MS = 30 * DAY_MS;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** POST /api/draft-ping {device}。端末 ID の最終時刻を更新するだけ。 */
export async function handleDraftPing(request: Request, env: Env): Promise<Response> {
  let body: { device?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const device = typeof body?.device === "string" ? body.device : "";
  if (!DEVICE_RE.test(device)) return json({ error: "invalid device" }, 400);
  await env.DB.prepare(
    `INSERT INTO draft_devices (device, last_seen) VALUES (?, ?)
     ON CONFLICT(device) DO UPDATE SET last_seen = excluded.last_seen`
  )
    .bind(device, Date.now())
    .run();
  return json({ ok: true }, 200, { "cache-control": "no-store" });
}

/** 集計窓（30 日）より古い行を消す。日次 cron から呼ぶ。 */
export async function purgeDraftDevices(env: Env): Promise<void> {
  const before = Date.now() - DRAFT_DEVICE_WINDOW_MS;
  for (let i = 0; i < 200; i++) {
    const res = await env.DB.prepare(
      `DELETE FROM draft_devices WHERE rowid IN (SELECT rowid FROM draft_devices WHERE last_seen < ? LIMIT 5000)`
    )
      .bind(before)
      .run();
    if ((res.meta?.changes ?? 0) < 5000) break;
  }
}
