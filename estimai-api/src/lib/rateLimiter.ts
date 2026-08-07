/**
 * In-process sliding-window rate limiter (T5, specs/013-estimate-sharing,
 * plan.md "Rate limiting (the share dialog is now a probe endpoint)").
 *
 * The suite has no rate limiting anywhere today — this and `auth`'s own
 * `POST /authz/app-access-check` limiter (specs/013 T1) are the first. A
 * `Map<sub, timestamps[]>` sliding window, no new dependency, with a
 * periodic sweep so long-idle keys don't leak memory forever.
 *
 * Written behind the `RateLimiter` interface specifically so a shared store
 * (Redis or similar) is a later SWAP, not a rewrite, when estimai-api scales
 * beyond a single instance (plan.md R7 — the same constraint notify-api's
 * SSE fan-out already carries; estimai-api and auth run single-instance on
 * Railway today).
 *
 * Counting is the CALLER's responsibility to invoke on every outcome (success,
 * duplicate, self-add, generic rejection alike) — a limiter that is only
 * consulted on failure would leave a valid-email prober unthrottled
 * (plan.md's explicit reasoning for `POST /estimates/{id}/collaborators`).
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Only set when `allowed` is false — milliseconds until the caller may retry. */
  readonly retryAfterMs?: number;
}

export interface RateLimiter {
  /**
   * Records one attempt for `key` and reports whether it is within the
   * configured limit for the current sliding window. Every call — allowed
   * or not — counts toward the window.
   */
  attempt(key: string): RateLimitResult;
}

export interface RateLimiterOptions {
  /** Maximum attempts admitted within `windowMs` for a single key. */
  readonly limit: number;
  /** Sliding window length in milliseconds. */
  readonly windowMs: number;
  /**
   * How often to sweep stale keys whose entire window has expired, so the
   * backing Map doesn't grow unbounded under many distinct callers. Defaults
   * to `windowMs` — a key is swept at most one window after its last hit.
   * Set to `0` to disable the periodic sweep (used by tests that want full
   * control over timers).
   */
  readonly sweepIntervalMs?: number;
}

/**
 * Creates a new, independent sliding-window rate limiter. Each call site
 * (e.g. `estimai-api POST /estimates/{id}/collaborators`) should hold its
 * own instance — the window and limit are per-instance, not shared globally.
 */
export function createSlidingWindowRateLimiter(
  options: RateLimiterOptions,
): RateLimiter {
  const { limit, windowMs } = options;
  const sweepIntervalMs = options.sweepIntervalMs ?? windowMs;

  const hits = new Map<string, number[]>();

  const prune = (timestamps: number[], now: number): number[] =>
    timestamps.filter((t) => now - t < windowMs);

  if (sweepIntervalMs > 0) {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamps] of hits) {
        const pruned = prune(timestamps, now);
        if (pruned.length === 0) {
          hits.delete(key);
        } else {
          hits.set(key, pruned);
        }
      }
    }, sweepIntervalMs);
    // Never keep the process alive just for housekeeping (Bun/Node both
    // support Timer#unref; guarded for environments/tests that don't).
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  return {
    attempt(key: string): RateLimitResult {
      const now = Date.now();
      const pruned = prune(hits.get(key) ?? [], now);

      if (pruned.length >= limit) {
        const oldest = pruned[0]!;
        hits.set(key, pruned);
        return { allowed: false, retryAfterMs: windowMs - (now - oldest) };
      }

      pruned.push(now);
      hits.set(key, pruned);
      return { allowed: true };
    },
  };
}
