/**
 * Who may read Accounting's reference data and rates over `/system/v1/*` (T13, specs/20261119-accounting, plan D8; ADR
 * 20261119-accounting-reference-data-belongs-to-accounting-api-…, the narrow-channel rule of ADR 20261103).
 *
 * One scope and one allow-list for both routes: the scope `accounting.reference.read` minted by `auth` for a registered
 * service client, and `sub` in {@link SYSTEM_READERS}. A second consumer is a deliberate change here AND a scope on its
 * client in `auth`, never a configuration value. Every failure of the check is the same 401 (`systemAuth.middleware.ts`),
 * and the routes are attached one by one (`createRoute({ middleware })`), never `app.use("*")`, so a method with no route
 * is the app's 404 whoever asks.
 */

import { createMiddleware } from "hono/factory";
import { createSystemAuthMiddleware } from "../auth/systemAuth.middleware";

export const REFERENCE_READ_SCOPE = "accounting.reference.read";

/** The service principals that read Accounting: Refund only (D8). */
export const SYSTEM_READERS = ["system:refund-api"] as const;

/** Verifies the service JWT: `aud` = SERVICE_AUDIENCE, the scope above, `sub` in {@link SYSTEM_READERS}; one 401 for every failure. */
export const systemReader = createSystemAuthMiddleware({ scope: REFERENCE_READ_SCOPE, allowedSubs: SYSTEM_READERS });

/**
 * `Cache-Control: no-store` on every answer of a system route, the 401 included: the consumer reads live and keeps nothing across
 * requests (D2), and no intermediary may keep a copy either. Set after the handler so it also reaches a response built elsewhere.
 */
export const noStore = createMiddleware(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
