/**
 * Response headers of the user routes `/v1/*` (security-review F-07, specs/20261119-accounting; D2 "read live, keep nothing").
 *
 * A user answer holds the catalog, the rates and the caller's own capabilities, for a Bearer caller: no shared cache may keep a
 * copy (`no-store`; the `/system/v1` routes already say it, `readers.ts`), and a browser must not guess a type other than the
 * `application/json` it is told (`nosniff`).
 *
 * Set AFTER the handler, so the header reaches every answer built under it: a 401 of the login, a 403, a 404, a 422, and the
 * 500 of the global error handler (which is an `onError` result that replaces the response, not an exception here).
 */

import { createMiddleware } from "hono/factory";

export const userRouteHeaders = createMiddleware(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});
