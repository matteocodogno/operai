import type { MiddlewareHandler } from "hono";

/**
 * Request logger — method + PATH ONLY (no query string) + status + duration.
 *
 * hono/logger's stock implementation derives the logged "path" via
 * `url.slice(url.indexOf("/", 8))`, which keeps everything after the origin —
 * INCLUDING the query string. That leaks live credentials into application
 * logs whenever a query param carries one (e.g. notify-api's ticket-authed
 * SSE stream, ADR-0008). refund-api has no query-string credential today, but
 * this module is shared verbatim across every Operai resource server (same
 * posture as jwtMiddleware) to establish one pattern rather than a
 * per-service opt-out: any future query-string-authenticated route is safe
 * by default. It also keeps financial/PII request bodies (the entire point
 * of this service) out of logs unconditionally — nothing here ever logs a
 * body.
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
