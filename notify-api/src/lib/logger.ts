import type { MiddlewareHandler } from "hono";

/**
 * Request logger — method + PATH ONLY (no query string) + status + duration.
 *
 * hono/logger's stock implementation derives the logged "path" via
 * `url.slice(url.indexOf("/", 8))`, which keeps everything after the origin —
 * INCLUDING the query string. That leaks live credentials into application
 * logs whenever a query param carries one: notify-api's
 * `GET /notifications/stream?ticket=<t>` (ADR-0008) puts the single-use SSE
 * ticket in the query string, so the stock logger would write a live,
 * still-valid (up to its ~30s TTL) ticket into every log line for that
 * request — a log reader within the TTL could replay it, contradicting
 * ADR-0008's "never logged" posture. This also matters for estimai-api, which
 * shares this same logger module: no current route puts a credential in a
 * query string, but establishing the pattern here means any future
 * query-string-authenticated route (streaming or otherwise) is safe by
 * default rather than by remembering to opt out of hono/logger.
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
