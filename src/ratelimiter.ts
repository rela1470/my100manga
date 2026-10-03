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
// caps how deep each lane's queue grows. High = user-initiated (correction picker):
// generous, so it's essentially always served and, being on its own lane, jumps ahead
// of background backlog. Low = background bulk cover fill: bounded so it doesn't book
// minutes ahead.
const MAX_WAIT_MS: Record<Priority, number> = { high: 15000, low: 8000 };

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
    const stub = env.RAKUTEN_LIMITER.getByName(instance);
    const wait = await stub.acquire(cap, priority);
    if (wait < 0) return false;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return true;
  } catch {
    return true; // limiter failure shouldn't block covers entirely
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

export class RakutenRateLimiter extends DurableObject<Env> {
  // Two reservation lanes, both persisted so an eviction doesn't reset pacing:
  //  - highNext: tail of the user-initiated (high-priority) timeline.
  //  - lowNext:  tail of the background (bulk cover fill) timeline.
  // High-priority work is spaced only against other high-priority work, so it
  // jumps ahead of a deep background backlog. Low-priority work is scheduled
  // behind BOTH lanes, so it never books a slot a high-priority reservation
  // already holds. The single 1/s budget is preserved within the limiter's own
  // accounting; the only way >1/s can briefly happen is an already-dispatched
  // low-pri sleep overlapping a fresh high-pri jump, which the 429 retry absorbs.
  private highNext = 0;
  private lowNext = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.highNext = (await ctx.storage.get<number>("highNext")) ?? 0;
      // Migrate the old single-lane key ("next") into the low lane.
      this.lowNext = (await ctx.storage.get<number>("lowNext"))
        ?? (await ctx.storage.get<number>("next"))
        ?? 0;
    });
  }

  /**
   * Reserve the next 1/s slot and return how long (ms) the caller must wait
   * before issuing its Rakuten request. If the wait would exceed `maxWaitMs`,
   * reserves nothing and returns -1 — the caller should skip Rakuten (cover
   * callers then fall back to Google / give up). The budget also caps how deep
   * each lane's queue can grow.
   */
  async acquire(maxWaitMs: number, priority: Priority = "low"): Promise<number> {
    const now = Date.now();
    if (priority === "high") {
      const slot = Math.max(now, this.highNext);
      const wait = slot - now;
      if (wait > maxWaitMs) return -1;
      this.highNext = slot + INTERVAL_MS;
      await this.ctx.storage.put("highNext", this.highNext);
      return wait;
    }
    // Low priority: schedule behind whichever lane is further out.
    const slot = Math.max(now, this.lowNext, this.highNext);
    const wait = slot - now;
    if (wait > maxWaitMs) return -1;
    this.lowNext = slot + INTERVAL_MS;
    await this.ctx.storage.put("lowNext", this.lowNext);
    return wait;
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
