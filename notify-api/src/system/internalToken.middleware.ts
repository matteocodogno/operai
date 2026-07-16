/**
 * internalTokenMiddleware (T3, specs/006-user-invitations, ADR-0011; reused
 * by T3, specs/007-refund-service, ADR-0017 for a second internal caller).
 *
 * Authenticates `POST /system/emails` (service-to-service call from `auth`)
 * and `POST /system/notifications` (service-to-service call from
 * `refund-api`) — neither is an end-user request. Deliberately NOT
 * jwtMiddleware: neither caller has a `sub` of its own to verify (and, for
 * /system/emails, the invitee has no User row yet either). Checks the
 * `X-Internal-Token` header against `NOTIFY_INTERNAL_TOKEN` (a strong,
 * 1Password-sourced shared secret, identical value configured in `auth`,
 * `refund-api`, and `notify-api` — ADR-0017 knowingly reuses the same secret
 * for both internal callers rather than provisioning a second one).
 *
 * CRITICAL invariant (Security R2, ADR-0011; ADR-0017 §3): this is the ONLY
 * middleware `/system/*` routes may use. `jwtMiddleware`-protected routes
 * must never accept this token, and `/system/*` must never accept a user
 * JWT — the two mechanisms are mutually exclusive by route, never layered. A
 * valid user JWT presented here is simply not the credential this middleware
 * checks, so it is rejected exactly like any other missing/wrong token (see
 * emails.routes.test.ts "a user JWT is rejected on /system/emails" and
 * notifications.routes.test.ts's equivalent case).
 *
 * The comparison is constant-time (`timingSafeEqual`) — a naive `!==` string
 * comparison on a secret this consequential (leak = arbitrary email over
 * wellD's Resend domain, ADR-0011 Risks) would leak timing information about
 * how many leading bytes matched.
 */

import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { env } from "@/lib/env";

const unauthorized = (detail: string, path: string) =>
  Response.json(
    {
      type: "https://httpstatuses.com/401",
      title: "Unauthorized",
      status: 401,
      detail,
      instance: path,
    },
    { status: 401 },
  );

/** Constant-time string equality — returns false (not a throw) on length mismatch. */
const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

export const internalTokenMiddleware = createMiddleware(async (c, next) => {
  const token = c.req.header("X-Internal-Token");

  if (!token || !safeEqual(token, env.NOTIFY_INTERNAL_TOKEN)) {
    // Never log the presented or expected token value (ADR-0011: "never
    // logged by either service").
    return unauthorized(
      "A valid X-Internal-Token header is required",
      c.req.path,
    );
  }

  return next();
});
