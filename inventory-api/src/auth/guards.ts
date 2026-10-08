/**
 * The two guard stacks every inventory-api route picks from (T7, specs/015-
 * hardware-inventory; AC-9.7, ADR-0014, ADR-0045). Making the choice a named
 * export, rather than two middleware calls repeated on each route, is what
 * makes the split between "needs a capability" and "needs only a login"
 * visible in the route table and testable on its own.
 *
 *   authorized     JWT + live authorization (`GET /authz/resolve`). Every route
 *                  except `/me/*` and `/health`. An `auth` outage is a 503.
 *   identityOnly   JWT only. The `/me/*` routes (ADR-0045): a user with no
 *                  inventory grant at all must reach their own devices, so the
 *                  authorization middleware is deliberately NOT in this stack
 *                  and an `auth` outage does not affect them — every query is
 *                  scoped to the verified `sub` instead.
 *
 * Attach per route, through `createRoute({ middleware: authorized })`, never
 * with `router.use("*", …)`: every router is mounted at "/" in src/index.ts and
 * Hono copies a sub-app's `use("*")` onto the whole app, so a wildcard here
 * would guard (or un-guard) the other routers' paths too.
 */

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { jwtMiddleware } from "./jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "./authz.middleware";
import { hasCapability } from "../authz/conditions";
import { problem } from "../lib/problem";

export const authorized: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware];

export const identityOnly: MiddlewareHandler[] = [jwtMiddleware];

/** A `(resource, action)` pair from the inventory catalog. */
export type Capability = readonly [resource: string, action: string];

/** The inventory manager capability (`asset:manage`). */
export const ASSET_MANAGE: Capability = ["asset", "manage"];
/** The hardware accountant capability (`ledger:manage`). */
export const LEDGER_MANAGE: Capability = ["ledger", "manage"];

/**
 * 403 unless the caller holds AT LEAST ONE of `needs` (any scope). Must run
 * after `authzMiddleware`. Whether the caller may touch a particular asset is a
 * separate, record-level question answered with `scopeFor` / `assetInScope`
 * and a 404 — this is the capability gate only (ADR-0014).
 */
export const requireCapability = (
  ...needs: readonly Capability[]
): MiddlewareHandler =>
  createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
    const { permissions } = c.get("authz");
    if (!needs.some(([resource, action]) =>
      hasCapability(permissions, resource, action),
    )) {
      return problem(
        {
          status: 403,
          detail: "You do not have permission to perform this action",
        },
        c.req.path,
      );
    }
    return next();
  });
