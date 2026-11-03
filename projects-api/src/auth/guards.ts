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
 * contract, D13). Writing is record-level: `assertCanManage(c, entity)` after the
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

/** Tool access: read every project and contract. */
export const PROJECTS_ACCESS: Capability = ["projects", "access"];
/** Create and edit projects, teams and contracts and move states — entity-scoped (ADR-0015). */
export const PROJECT_MANAGE: Capability = ["project", "manage"];
/** Write a contract's Bexio order id (held by `accounting`, D35). */
export const CONTRACT_BEXIO: Capability = ["contract", "bexio"];

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

/** Whether the caller may write a contract's Bexio order id. */
export const canSetBexio = (c: AuthzSource): boolean =>
  hasCapability(c.get("authz").permissions, CONTRACT_BEXIO[0], CONTRACT_BEXIO[1]);

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

export const authorized: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware, requireCapability(PROJECTS_ACCESS)];
