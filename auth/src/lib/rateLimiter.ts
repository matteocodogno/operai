/**
 * Reusable in-process sliding-window rate limiter (specs/013-estimate-sharing,
 * T1 — the suite's FIRST rate limiter, plan.md "Rate limiting"). Used by
 * `POST /authz/app-access-check` (T2) to bound 40 attempts / 10 min per
 * caller `sub`, and mirrored verbatim by `estimai-api`'s own limiter (T5) for
 * `POST /estimates/{id}/collaborators`'s 20 / 10 min.
 *
 * Design (plan.md R7): `Map<key, timestamps[]>`, no new dependency, with
 * periodic pruning so a long-lived process doesn't accumulate memory for keys
 * that stopped being active. Exposed behind the `RateLimiter` interface
 * SPECIFICALLY so a future horizontal-scale-out can swap in a shared store
 * (Redis, Postgres, …) without touching call sites — R7's named limitation is
 * that in-process counters are per-instance, and both `auth` and
 * `estimai-api` run single-instance today (the same constraint `notify-api`
 * already carries for its SSE ticket store).
 */

export interface RateLimitResult {
  /** Whether this attempt is admitted under the configured window. */
  allowed: boolean;
  /**
   * Milliseconds until the caller's oldest counted attempt ages out of the
   * window — i.e. the earliest time another attempt could be admitted.
   * Always 0 when `allowed` is true. Suitable for a `Retry-After` header
   * (converted to whole seconds, rounded up, by the caller).
   */
  retryAfterMs: number;
}

export interface RateLimiter {
  /**
   * Records one attempt for `key` and reports whether it is admitted under
   * the sliding window. Every attempt must be recorded — including attempts
   * that are subsequently rejected for other reasons (duplicate, self-add,
   * generic ineligibility) — so a caller who probes with already-invalid
   * input cannot dodge the limiter (plan.md: "counted on every attempt").
   *
   * @param now - injectable clock for deterministic tests; defaults to
   *   `Date.now()`.
   */
  consume(key: string, now?: number): RateLimitResult;
}

export interface RateLimiterOptions {
  /** Maximum admitted attempts per key within `windowMs`. */
  limit: number;
  /** Sliding window size, in milliseconds. */
  windowMs: number;
  /**
   * How often (in milliseconds) to sweep the whole map for keys with no
   * timestamps left inside the window, so idle keys don't linger forever.
   * Defaults to `windowMs`. Pruning also happens inline for any key touched
   * by `consume`, so this only affects keys that go permanently quiet.
   */
  pruneIntervalMs?: number;
}

/**
 * Creates an in-process sliding-window `RateLimiter`. Two calls with the same
 * `options` produce two INDEPENDENT limiters (own `Map`) — callers that need
 * a shared limiter across routes must share the same instance.
 */
export function createSlidingWindowRateLimiter(
  options: RateLimiterOptions,
): RateLimiter {
  const { limit, windowMs } = options;
  const pruneIntervalMs = options.pruneIntervalMs ?? windowMs;

  const hits = new Map<string, number[]>();
  let lastPruneAt = Date.now();

  function freshTimestamps(timestamps: number[], now: number): number[] {
    return timestamps.filter((t) => now - t < windowMs);
  }

  function pruneAll(now: number): void {
    for (const [key, timestamps] of hits) {
      const fresh = freshTimestamps(timestamps, now);
      if (fresh.length === 0) {
        hits.delete(key);
      } else if (fresh.length !== timestamps.length) {
        hits.set(key, fresh);
      }
    }
    lastPruneAt = now;
  }

  return {
    consume(key: string, now = Date.now()): RateLimitResult {
      if (now - lastPruneAt >= pruneIntervalMs) {
        pruneAll(now);
      }

      const existing = freshTimestamps(hits.get(key) ?? [], now);

      if (existing.length >= limit) {
        // Reject — do NOT record this attempt as a new timestamp (a rejected
        // attempt must not further delay the caller's recovery). The oldest
        // timestamp still inside the window determines when a slot frees up.
        hits.set(key, existing);
        const oldest = existing[0]!;
        const retryAfterMs = Math.max(0, windowMs - (now - oldest));
        return { allowed: false, retryAfterMs };
      }

      existing.push(now);
      hits.set(key, existing);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
