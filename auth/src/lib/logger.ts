import type { MiddlewareHandler } from "hono";

/**
 * Request logger — method + PATH ONLY (no query string) + status + duration.
 *
 * Ported verbatim from notify-api's `src/lib/logger.ts` (security-review fix
 * #1, specs/006-user-invitations bounded round): `hono/logger()`'s stock
 * implementation derives the logged "path" via
 * `url.slice(url.indexOf("/", 8))`, which keeps everything after the origin —
 * INCLUDING the query string. That leaks live credentials into application
 * logs whenever a query param carries one: this service's own
 * `GET /invite?id=<invId>&token=<raw>` (T9, specs/006-user-invitations) puts
 * the invite-link token in the query string, so the stock logger would write
 * a live, still-valid (until its 72h TTL) invitation token into every log
 * line for that request — a log reader could replay it as the invitee,
 * contradicting the "token grants landing-view access, never logged" posture
 * (invite.routes.ts's own security-posture doc comment).
 *
 * Deliberately drops the query string entirely (not just known-sensitive
 * params) — the data-residency posture is "no bodies, no query strings", not
 * an allowlist/denylist of which params are safe.
 */
export const requestLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const { method } = c.req;
    const path = new URL(c.req.url).pathname;
    const start = Date.now();

    await next();

    const elapsedMs = Date.now() - start;
    console.log(`${method} ${path} ${c.res.status} ${elapsedMs}ms`);
  };
};
