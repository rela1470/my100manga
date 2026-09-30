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
}
