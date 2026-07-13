import type { MiddlewareHandler } from "hono";

/**
 * Request logger — method + PATH ONLY (no query string) + status + duration.
 *
 * hono/logger's stock implementation derives the logged "path" via
 * `url.slice(url.indexOf("/", 8))`, which keeps everything after the origin —
 * INCLUDING the query string. That leaks live credentials into application
 * logs whenever a query param carries one. No current estimai-api route puts
 * a credential in a query string, but notify-api's structurally identical
 * `GET /notifications/stream?ticket=<t>` (ADR-0008) does, and this logger
 * module is shared verbatim across both services (same posture as
 * jwtMiddleware) to establish one pattern rather than a per-service opt-out:
 * any future query-string-authenticated route is safe by default.
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
