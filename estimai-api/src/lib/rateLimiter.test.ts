/**
 * Unit tests for the in-process sliding-window rate limiter (T5,
 * specs/013-estimate-sharing).
 *
 * Uses a fake, injectable clock is unnecessary here — the window is small
 * (a handful of milliseconds) and `Bun.sleep`/real timers are fast enough
 * for a deterministic admit/reject/re-admit assertion without flaking.
 */

import { describe, it, expect } from "bun:test";
import { createSlidingWindowRateLimiter } from "./rateLimiter";

describe("createSlidingWindowRateLimiter", () => {
  it("admits N attempts and rejects the N+1th within the window", () => {
    const limiter = createSlidingWindowRateLimiter({
      limit: 3,
      windowMs: 10_000,
      sweepIntervalMs: 0,
    });

    expect(limiter.attempt("sub-1")).toEqual({ allowed: true });
    expect(limiter.attempt("sub-1")).toEqual({ allowed: true });
    expect(limiter.attempt("sub-1")).toEqual({ allowed: true });

    const fourth = limiter.attempt("sub-1");
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
    expect(fourth.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it("re-admits after the window elapses", async () => {
    const limiter = createSlidingWindowRateLimiter({
      limit: 1,
      windowMs: 50,
      sweepIntervalMs: 0,
    });

    expect(limiter.attempt("sub-1").allowed).toBe(true);
    expect(limiter.attempt("sub-1").allowed).toBe(false);

    await Bun.sleep(60);

    expect(limiter.attempt("sub-1").allowed).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    const limiter = createSlidingWindowRateLimiter({
      limit: 1,
      windowMs: 10_000,
      sweepIntervalMs: 0,
    });

    expect(limiter.attempt("sub-a").allowed).toBe(true);
    expect(limiter.attempt("sub-a").allowed).toBe(false);
    // A different key has its own independent window.
    expect(limiter.attempt("sub-b").allowed).toBe(true);
  });

  it("every call counts toward the window, even ones the caller will still reject downstream", () => {
    // Mirrors plan.md's requirement: the collaborator-add rate limiter must
    // be consulted on EVERY outcome (success, duplicate, self, generic
    // rejection alike) — a limiter that only records failures would leave a
    // valid-email prober unthrottled. This module itself is outcome-
    // agnostic (it just counts `attempt()` calls); the call-site discipline
    // is what the collaborator route (T8) must uphold, but the module's own
    // contract — count every attempt() regardless of what the caller does
    // with the result — is asserted here.
    const limiter = createSlidingWindowRateLimiter({
      limit: 2,
      windowMs: 10_000,
      sweepIntervalMs: 0,
    });

    expect(limiter.attempt("sub-1").allowed).toBe(true); // e.g. a 409 duplicate
    expect(limiter.attempt("sub-1").allowed).toBe(true); // e.g. a 422 generic rejection
    expect(limiter.attempt("sub-1").allowed).toBe(false); // 3rd attempt regardless of outcome
  });
});
