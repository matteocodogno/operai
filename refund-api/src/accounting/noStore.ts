/**
 * F-07 (security review of specs/20261119-accounting, A05): one middleware for the authenticated Accounting-facing routes
 * (the classification view and write, the options list, the defaults) so that EVERY answer, a refusal or a failure included,
 * is never kept by a cache or a proxy and never sniffed into another type. Their bodies name employees and carry CHF and VAT
 * figures and Refund's accounting defaults; AC-4.8 / D2 ("read live, keep nothing") must not depend on whoever sits between
 * the caller and this service. The export routes set the same two headers by hand (SR-5, S-06).
 *
 * Register it BEFORE `jwtMiddleware`, so a 401 carries the headers too. The headers are set after the handlers have run as well,
 * on whatever response they ended with (an `onError` response, a body-limit 413), so none escapes.
 */

import { createMiddleware } from "hono/factory";

export const NO_STORE_CACHE_CONTROL = "private, no-store";

export const noStoreHeaders = createMiddleware(async (c, next) => {
  c.header("Cache-Control", NO_STORE_CACHE_CONTROL);
  c.header("X-Content-Type-Options", "nosniff");
  await next();
  c.res.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});
