/**
 * Constant-time comparison for the transition-only shared `X-Internal-Token`
 * (ADR-0011/0017/0040). The route guard that used to live here is
 * systemAuth.middleware.ts (specs/016 T3, ADR-0049), which accepts the shared
 * token only while NOTIFY_INTERNAL_TOKEN is set. This file leaves with the
 * token in specs/016 T14.
 *
 * The comparison is constant-time (`timingSafeEqual`) — a naive `!==` on a
 * secret this consequential (leak = arbitrary email over wellD's Resend
 * domain, ADR-0011 Risks) would leak how many leading bytes matched.
 */

import { timingSafeEqual } from "node:crypto";

/** Constant-time string equality — returns false (not a throw) on length mismatch. */
export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};
