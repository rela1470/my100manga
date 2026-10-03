import { DurableObject } from "cloudflare:workers";
import { Env } from "./types";

// Rakuten's OpenAPI gateway rate-limits an application ID at roughly 1 req/s
// *globally*. Workers are stateless, so per-request concurrency caps can't see
// each other and collectively blow past that. This Durable Object is the single
// coordination point: every Rakuten call reserves a slot here first, so calls
// are spaced across the whole deployment. A single global instance is normally a
// DO anti-pattern (bottleneck) — here the bottleneck IS the goal, and the volume
// is tiny (only cover cache-misses, which are then cached for ~30 days).
const INTERVAL_MS = 1100; // ~0.9 req/s, a small margin under Rakuten's ~1/s cap.

export type Priority = "high" | "low";

// How long a call waits for a rate-limit slot before giving up (returns false). Also
// caps how deep each lane's queue grows. High = user-initiated (book popup, correction
// picker, ISBN search): short, so a burst of junk high-priority requests can only book a
// few seconds ahead and then gets refused instead of piling up. Low = background bulk
// cover fill: bounded so it doesn't book minutes ahead.
const MAX_WAIT_MS: Record<Priority, number> = { high: 4000, low: 8000 };

// レーンごとの「何ミリ秒先まで予約してよいか」。待ち上限（MAX_WAIT_MS や呼び出し側の残り時間）
// とは別に、リミッタ側で必ずこの範囲に収める。深く予約できると、背景の取り込みが先の枠まで
// 埋めてしまい、あとから来た利用者の操作（高優先）が自分の待ち上限を超えて弾かれる。浅く
// しても取りこぼしは起きない: 枠が過ぎれば次が空くので、呼び出し側の再試行で埋まる（1 秒
// あたりの処理量は変わらない。実測: 並列 1〜4 のどれでも 0.92/s）。
const MAX_BOOK_AHEAD: Record<Priority, number> = { high: 4000, low: 2200 };

// 1 つのレーンが続けて取れる枠の数。これを超えて連続させないので、予約列には必ず
// MAX_RUN+1 枠ごとに空きが残り、もう片方のレーンはいつ来ても 3 枠（約 3.3 秒）以内に枠を
// 取れる ＝ どちらのレーンも相手を飢えさせられない。高優先の待ち上限 4 秒に収まる。
//
// 以前は「今から 2 秒以内の枠は早い者勝ち、その先は 1 枠おき」にしていたが、空けた枠も
// 時間が経って 2 秒以内に入れば同じレーンが埋められるので、連続した予約がいくらでも伸び、
// 後から来たレーンが自分の待ち上限を超えて弾かれることがあった（実測）。位置で決める今の
// 規則は時間に依存しないので、呼び出しの速さやサーバの混み具合で保証が崩れない。
//
// 片方しか使っていない間は 3 枠に 1 枠を相手のために空けるので、その間の上限は 1 秒あたり
// 約 0.6 回（1.1 秒間隔の 2/3）になる。両方が使っているときは互い違いに詰まるので満度に出る。
const MAX_RUN = 2;

/** c を priority で予約すると、同じレーンの枠が MAX_RUN より長く連続するか。連続 = 枠と枠の
 *  間に空き枠が無いこと（間隔が 2 * INTERVAL_MS 未満）。c の前後それぞれの連なりを数えて
 *  合算するので、空きを埋めて前後の連なりがつながる場合も拾える。slots は時刻順。 */
function wouldRunTooLong(slots: Slot[], c: number, priority: Priority): boolean {
  let run = 1;
  let t = c;
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (s.t >= c) continue;
    if (s.p !== priority || t - s.t >= 2 * INTERVAL_MS) break;
    run++;
    t = s.t;
  }
  t = c;
  for (const s of slots) {
    if (s.t <= c) continue;
    if (s.p !== priority || s.t - t >= 2 * INTERVAL_MS) break;
    run++;
    t = s.t;
  }
  return run > MAX_RUN;
}

// DO は「最初にそのインスタンスへ触れたリクエスト」に近い場所に作られる。表紙解決・/api/book は
// 枠の確保ごとにこの DO へ RPC が 1 往復するので、置き場所がそのまま応答時間に乗る。利用者は
// ほぼ日本なので、最初の要求がどこから来てもアジア太平洋に作られるようヒントを付ける
// （効くのは作成時だけ。既にあるインスタンスは移動しない）。
const LIMITER_LOCATION_HINT: DurableObjectLocationHint = "apac";

/** 名前付きインスタンスのスタブ。getByName と同じだが、作成時の置き場所ヒントを付ける。 */
export function limiterStub(
  ns: DurableObjectNamespace<RakutenRateLimiter>,
  name: string
): DurableObjectStub<RakutenRateLimiter> {
  return ns.get(ns.idFromName(name), { locationHint: LIMITER_LOCATION_HINT });
}

/** Wait for a 1 req/s slot on `instance`'s priority lane. Each API paces on its own DO
 *  instance: "global" = Rakuten (楽天ブックス・楽天市場 share one applicationId),
 *  "yahoo" = Yahoo!ショッピング (rate-limits aggressively, ~3 req/s observed). Returns
 *  false when the caller should skip the API (slot past budget). `maxWaitMs` overrides
 *  the lane default so a caller with a shrinking wall-clock budget (resolveCovers) can
 *  refuse a slot that would land past its deadline. */
export async function awaitSlot(
  env: Env,
  instance: "global" | "yahoo",
  priority: Priority,
  maxWaitMs?: number
): Promise<boolean> {
  if (!env.RAKUTEN_LIMITER) return true; // limiter unbound (tests/local) → no pacing
  const cap = maxWaitMs ?? MAX_WAIT_MS[priority];
  if (cap <= 0) return false;
  try {
    const wait = await limiterStub(env.RAKUTEN_LIMITER, instance).acquire(cap, priority);
    if (wait < 0) return false;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return true;
  } catch {
    // リミッタ障害時は呼ばない側に倒す（fail closed）。表紙・あらすじは任意で、呼び出し側は
    // false を「未確定」として扱いキャッシュしないので、復旧後の再試行で埋まる。素通しにすると
    // 障害中に全 Worker が無制限に楽天/Yahoo を叩き、API キーごと止められかねない。
    return false;
  }
}

// Cover-fill presence (see report()). A browser that stops POSTing — tab closed, fill
// finished — drops out after this long. Its POSTs are at most ~10s apart (9s resolve
// budget + 1.2s retry pause), so this leaves some slack.
const PRESENCE_TTL_MS = 20000;
const PRESENCE_MAX = 2000; // cap on tracked browsers so junk ids can't grow the map

export interface CoverQueue {
  users: number; // browsers currently filling covers
  pending: number; // covers they still have left, site-wide
}

interface Slot {
  t: number; // reserved send time (epoch ms)
  p: Priority;
}

export class RakutenRateLimiter extends DurableObject<Env> {
  // One shared timeline of reserved send times (both lanes), at least INTERVAL_MS
  // apart — so the 1/s budget holds across lanes too (the old two-lane version let a
  // high-priority reservation land on a slot a low one already held). Persisted so an
  // eviction doesn't reset pacing; pruned on every call, so it only holds the next
  // ~MAX_WAIT_MS worth of reservations (a handful of entries).
  private slots: Slot[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.slots = (await ctx.storage.get<Slot[]>("slots")) ?? [];
    });
  }

  /**
   * Reserve the earliest free 1/s slot and return how long (ms) the caller must wait
   * before issuing its request. If no slot fits within `maxWaitMs` (or the lane's
   * MAX_BOOK_AHEAD, whichever is shorter), reserves nothing
   * and returns -1 — the caller should skip the API (cover callers then fall back /
   * give up). Free slots are found by gap-filling: an earlier gap (e.g. one the other
   * lane had to leave open, see MAX_RUN) is taken before the tail.
   */
  async acquire(maxWaitMs: number, priority: Priority = "low"): Promise<number> {
    const now = Date.now();
    const cap = Math.min(maxWaitMs, MAX_BOOK_AHEAD[priority]);
    const slots = this.slots.filter((s) => s.t > now - INTERVAL_MS).sort((a, b) => a.t - b.t);
    const candidates = [now];
    for (const s of slots) candidates.push(s.t + INTERVAL_MS, s.t + 2 * INTERVAL_MS);
    candidates.sort((a, b) => a - b);
    for (const c of candidates) {
      if (c < now) continue;
      if (c - now > cap) break;
      if (slots.some((s) => Math.abs(s.t - c) < INTERVAL_MS)) continue; // too close to a booking
      if (wouldRunTooLong(slots, c, priority)) continue; // 相手のレーンの分を空けておく
      slots.push({ t: c, p: priority });
      slots.sort((a, b) => a.t - b.t);
      this.slots = slots;
      await this.ctx.storage.put("slots", slots);
      return c - now;
    }
    this.slots = slots;
    return -1;
  }

  /**
   * Cover-fill presence, used on its own instance ("cover-queue") so it never sits in
   * front of the pacing calls. Each fill POST reports its browser's random id and how
   * many covers it still has left; returns the site-wide totals over browsers seen in
   * the last PRESENCE_TTL_MS. In memory only — an eviction just resets the counts.
   */
  private waiters = new Map<string, { pending: number; seen: number }>();

  async report(client: string, pending: number): Promise<CoverQueue> {
    const now = Date.now();
    for (const [id, w] of this.waiters) if (now - w.seen > PRESENCE_TTL_MS) this.waiters.delete(id);
    if (pending <= 0) this.waiters.delete(client);
    else if (this.waiters.has(client) || this.waiters.size < PRESENCE_MAX) {
      this.waiters.set(client, { pending, seen: now });
    }
    let total = 0;
    for (const w of this.waiters.values()) total += w.pending;
    return { users: this.waiters.size, pending: total };
  }
}

// 外部 API 1 回の上限（接続〜本文読み切りまで）。楽天・Yahoo は普段 1 秒未満で返る。
// これを超えたら「未確定」（null）として諦め、キャッシュせず後の再試行に回す。
export const API_TIMEOUT_MS = 5000;
// 表紙画像の存在確認（HEAD / 小さい GET）の上限。
export const PROBE_TIMEOUT_MS = 3000;

/**
 * Rate-limited JSON GET: reserve a slot on `instance`/`priority`, fetch with a timeout,
 * and on 429 pause `retryPauseMs` and retry ONCE — but only after reserving a fresh slot
 * on the same lane (a bare retry outside the limiter would add unpaced load exactly
 * when the API is already saying "too fast"). `maxWaitMs` is a wall-clock budget for
 * the whole call: the retry's slot must fit in what's left of it. Returns the parsed
 * JSON, or null when the call wasn't made / failed (no slot, timeout, network error,
 * HTTP error, bad JSON) — callers treat null as "undetermined" and never cache it.
 */
export async function pacedFetchJson(
  env: Env,
  instance: "global" | "yahoo",
  priority: Priority,
  url: string,
  init: RequestInit = {},
  maxWaitMs?: number,
  retryPauseMs = 1200
): Promise<any | null> {
  const start = Date.now();
  if (!(await awaitSlot(env, instance, priority, maxWaitMs))) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryPauseMs));
      const left = maxWaitMs === undefined ? undefined : maxWaitMs - (Date.now() - start);
      if (!(await awaitSlot(env, instance, priority, left))) return null;
    }
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    } catch {
      return null; // timeout / network error
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await res.json().catch(() => null); // body read is under the same timeout
  }
  return null;
}
