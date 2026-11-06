/**
 * The project-manager pick (specs/022 T27; AC-4.7 – AC-4.9, D42, D46, D47, D48; T18 L5): who may give a
 * project made from a deal its first project manager, and when a project still awaits one.
 *
 * A project made from a deal has no project manager until its purchase order's ops-manager picks one. While
 * it has none, only that ops-manager — or an admin in their place — may set it; once it has one, specs/021's
 * rule applies (any holder of manage projects for the entity). The pick is a `PATCH /projects/{id}` of
 * `projectManagerId`, not a route of its own.
 */

import { PURCHASE_ORDER_RECEIVE, oversees, type AuthzSource } from "../auth/guards";
import { scopeFor, type Entity } from "../authz/conditions";
import type { Prisma } from "../lib/generated/prisma/client";
import { forbidden, unprocessable } from "../lib/problem";

/** What the pick reads of a project row: its project manager and the purchase order it came from, if any. */
export interface AwaitingSource {
  readonly projectManagerId: string | null;
  readonly purchaseOrder: object | null;
}

/** A project awaits its project manager when it has a purchase order and no project manager yet (D42). */
export const isAwaitingProjectManager = (project: AwaitingSource): boolean =>
  project.purchaseOrder !== null && project.projectManagerId === null;

/**
 * The list's project-manager filter value for "none yet" (AC-4.5): the projects that await one. A literal
 * word, not an id: user ids are opaque strings from `auth`, and `none` is never one of them.
 */
export const NO_PROJECT_MANAGER = "none";

/** The `where` of the projects awaiting their project manager: what `isAwaitingProjectManager` says of a row. */
export const AWAITING_PROJECT_MANAGER = { projectManagerId: null, purchaseOrder: { isNot: null } } satisfies Prisma.ProjectWhereInput;

type Caller = AuthzSource & { get(key: "userId"): string };

/**
 * Whether the caller may set the project manager of a project that has none: they `oversees` (hold
 * `purchase-order:receive` for EVERY entity: the admin override, D47), or they are the purchase order's
 * ops-manager as stored on the row and STILL hold `purchase-order:receive` for the project's entity (an
 * assignee who lost the role is refused: T18 L5). Both through `scopeFor`, never the mere presence of a grant.
 */
export function canPickProjectManager(
  c: Caller,
  project: { readonly entity: Entity; readonly purchaseOrder: { readonly opsManagerId: string } | null },
): boolean {
  if (oversees(c)) return true;
  if (project.purchaseOrder === null || project.purchaseOrder.opsManagerId !== c.get("userId")) return false;
  const { permissions, entity } = c.get("authz");
  return scopeFor(permissions, PURCHASE_ORDER_RECEIVE[0], PURCHASE_ORDER_RECEIVE[1], entity).includes(project.entity);
}

/** 403 `not_ops_manager` unless the caller may pick the project manager of this awaiting project. */
export function assertCanPickProjectManager(c: Caller, project: Parameters<typeof canPickProjectManager>[1]): void {
  if (canPickProjectManager(c, project)) return;
  throw forbidden(
    "Only the purchase order's ops-manager, or an admin, can pick this project's project manager",
    "not_ops_manager",
  );
}

/** 422 `project_manager_required`: a project is never left without a project manager once it has one (AC-4.9). */
export const projectManagerRequired = () =>
  unprocessable("A project cannot be left without a project manager", { field: "projectManagerId" }, "project_manager_required");
