/**
 * The guard stack and capabilities every projects-api route uses (specs/021-projects,
 * ADR-0014, ADR-0058). Copied in shape from crm-api/src/auth/guards.ts.
 *
 *   authorized   JWT + live authorization (`GET /authz/resolve`) + `projects:access`.
 *                Every route except `/health`. An `auth` outage is a 503.
 *
 * Attach per route, through `createRoute({ middleware: authorized })`, never
 * with `router.use("*", …)`: every router is mounted at "/" in src/index.ts and
 * Hono copies a sub-app's `use("*")` onto the whole app.
 *
 * Reading needs only `projects:access` (every holder reads every project and
 * purchase order, D13). Writing is record-level: `assertCanManage(c, entity)` after the
 * record's entity is known.
 */

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { jwtMiddleware } from "./jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "./authz.middleware";
import { ENTITIES, hasCapability, scopeFor, type Entity } from "../authz/conditions";
import { ProblemError, problem } from "../lib/problem";

/** A `(resource, action)` pair from the `projects` catalog (auth/src/authz/catalogs/projects.ts). */
export type Capability = readonly [resource: string, action: string];

/** Tool access: read every project and purchase order. */
export const PROJECTS_ACCESS: Capability = ["projects", "access"];
/** Create and edit projects, teams and terms and move states — entity-scoped (ADR-0015). */
export const PROJECT_MANAGE: Capability = ["project", "manage"];
/** Write a purchase order's Bexio order id (held by `accounting`, D35; was `contract:bexio` in specs/021). */
export const PURCHASE_ORDER_BEXIO: Capability = ["purchase-order", "bexio"];

/**
 * Read the to-start queue and take a won deal — entity-scoped (specs/022 T24): `sales` for its own
 * entity, an admin unconditioned. Reading the queue needs it for ANY entity; a take, for the deal's.
 */
export const HANDOFF_TAKE: Capability = ["handoff", "take"];
/**
 * Be a purchase order's ops-manager — entity-scoped (`ops-manager` for its own entity, an admin
 * unconditioned). The admin's override of the project-manager pick is this grant held for EVERY entity
 * (`oversees`), never "holds it at all".
 */
export const PURCHASE_ORDER_RECEIVE: Capability = ["purchase-order", "receive"];

/** The resolved permissions and entity the authz middleware put on the context. */
export interface AuthzSource {
  get(key: "authz"): AuthzVariables["authz"];
}

/** Entities the caller manages projects for (ADR-0015). */
export const manageScope = (c: AuthzSource): Entity[] => {
  const { permissions, entity } = c.get("authz");
  return scopeFor(permissions, PROJECT_MANAGE[0], PROJECT_MANAGE[1], entity);
};

/** `project:manage` over every entity: the admin's reach. */
export const managesAll = (c: AuthzSource): boolean => manageScope(c).length === ENTITIES.length;

/** Entities whose won deals the caller may take (`handoff:take`, own entity or unconditioned). */
export const takeScope = (c: AuthzSource): Entity[] => {
  const { permissions, entity } = c.get("authz");
  return scopeFor(permissions, HANDOFF_TAKE[0], HANDOFF_TAKE[1], entity);
};

/**
 * Whether the caller holds `purchase-order:receive` for EVERY entity: the admin override of the
 * project-manager pick (D47). Deliberately `scopeFor(…).length === ENTITIES.length`, never
 * `hasCapability`, which ignores conditions and would make every ops-manager "oversee" (T18 L5).
 */
export const oversees = (c: AuthzSource): boolean => {
  const { permissions, entity } = c.get("authz");
  return scopeFor(permissions, PURCHASE_ORDER_RECEIVE[0], PURCHASE_ORDER_RECEIVE[1], entity).length === ENTITIES.length;
};

/** Whether the caller may write a purchase order's Bexio order id. */
export const canSetBexio = (c: AuthzSource): boolean =>
  hasCapability(c.get("authz").permissions, PURCHASE_ORDER_BEXIO[0], PURCHASE_ORDER_BEXIO[1]);

/**
 * 403 unless the caller holds AT LEAST ONE of `needs` (any scope). Must run
 * after `authzMiddleware`. Whether the caller may touch a particular project is a
 * separate, record-level question: `assertCanManage`.
 */
export const requireCapability = (...needs: readonly Capability[]): MiddlewareHandler =>
  createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
    const { permissions } = c.get("authz");
    if (!needs.some(([resource, action]) => hasCapability(permissions, resource, action))) {
      return problem(
        { status: 403, code: "forbidden", detail: "You do not have permission to perform this action" },
        c.req.path,
      );
    }
    return next();
  });

/**
 * Throws 403 unless the caller may manage a project of `entity`: `forbidden` when they
 * hold `project:manage` for no entity at all, `out_of_scope` when they hold it for the
 * other one only (tasks.md § API contracts).
 */
export function assertCanManage(c: AuthzSource, entity: Entity): void {
  const scope = manageScope(c);
  if (scope.includes(entity)) return;
  throw new ProblemError(
    scope.length === 0
      ? { status: 403, code: "forbidden", detail: "You do not have permission to manage projects" }
      : { status: 403, code: "out_of_scope", detail: "You can manage projects of your own entity only" },
  );
}

/**
 * Throws 403 `out_of_scope` unless the caller may take a deal of `entity`: `handoff:take` AND
 * `project:manage`, both for that entity (tasks.md § API contracts, T24). The route has already
 * refused (`forbidden`) a caller who holds `handoff:take` for no entity at all
 * (`requireCapability(HANDOFF_TAKE)`), so what is left is the other entity.
 */
export function assertCanTake(c: AuthzSource, entity: Entity): void {
  if (takeScope(c).includes(entity) && manageScope(c).includes(entity)) return;
  throw new ProblemError({
    status: 403,
    code: "out_of_scope",
    detail: "You can take deals of your own entity only, and only while you manage its projects",
  });
}

export const authorized: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware, requireCapability(PROJECTS_ACCESS)];
