/**
 * Which legal entities a caller may read and manage in Accounting (T6, specs/20261119-accounting, plan D9,
 * AC-3.2, AC-3.4 to AC-3.6, risk R12).
 *
 * The same rule as auth's `entityGrantFor` (auth/src/authz/resolver.ts), which derives the `accounting` entry
 * of `/authz/me` `apps`, and checked against the same vectors (auth/src/authz/entity-coverage-vectors.json, read
 * by `coverage.test.ts`), so the Sidebar's "reachable" and this service's "allowed" cannot drift:
 *
 *   - a grant with `conditions: null` covers both entities, whatever the caller's own entity;
 *   - `{ attributes: [{ key: "entity", match: "user" }] }` (and nothing else) covers the caller's own entity,
 *     and only when that is one of `ENTITIES` (compared exactly, case-sensitively). No entity covers nothing;
 *   - ANY other condition covers nothing (fail closed) and does not hide a recognised grant next to it;
 *   - only `accounting` `read` and `manage` count; `read` coverage is read ∪ manage (AC-3.2), `manage`
 *     coverage is `manage` alone.
 *
 * Where this is stricter than auth's `grantKind`: a conditions object carrying a member this service does not
 * know (`{ department: "x" }`) covers nothing here, where auth would read it as "no restriction". The wire
 * never carries one today; failing closed is the safe side of a disagreement, and the only visible effect of
 * the difference is a Sidebar entry that opens onto a 403.
 *
 * Presentation is the shell's business; this file is the enforcement every user route goes through.
 */

import { ENTITIES, isEntity, type Entity } from "../entities";
import { ProblemError } from "../lib/problem";
import type { AuthzContext } from "./authz.middleware";
import type { ResolvedPermission } from "./resolveClient";

export const ACCOUNTING_RESOURCE = "accounting";

export type AccessLevel = "read" | "manage";

export interface EntityCoverage {
  /** Entities covered by `accounting:read` OR `accounting:manage`, in `ENTITIES` order. */
  readonly read: readonly Entity[];
  /** Entities covered by `accounting:manage` alone, in `ENTITIES` order (always inside `read`). */
  readonly manage: readonly Entity[];
}

type GrantKind = "unrestricted" | "entity" | "unrecognised";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Classifies a grant's conditions. Written against `unknown` because the object came off the wire: whatever its
 * shape, an unexpected one is "unrecognised", never an exception and never wider than it looks.
 */
function grantKind(conditions: unknown): GrantKind {
  if (conditions === null) return "unrestricted";
  if (!isRecord(conditions)) return "unrecognised";
  if (Object.keys(conditions).some((key) => key !== "ownership" && key !== "attributes")) return "unrecognised";
  if (conditions["ownership"] !== undefined) return "unrecognised";
  const attributes = conditions["attributes"] ?? [];
  if (!Array.isArray(attributes)) return "unrecognised";
  // No ownership and no attribute carries no restriction (auth reads `{}` the same way); one other attribute
  // anywhere among them makes the whole grant unrecognised.
  if (attributes.length === 0) return "unrestricted";
  const onlyOwnEntity = attributes.every((a) => isRecord(a) && a["key"] === "entity" && a["match"] === "user");
  return onlyOwnEntity ? "entity" : "unrecognised";
}

/** Whether at least one `accounting:<action>` grant in `actions` covers `entity` for a caller of entity `user`. */
function covers(
  permissions: readonly ResolvedPermission[],
  actions: readonly AccessLevel[],
  user: { readonly entity: string | null },
  entity: Entity,
): boolean {
  for (const permission of permissions) {
    if (permission.resource !== ACCOUNTING_RESOURCE) continue;
    if (!(actions as readonly string[]).includes(permission.action)) continue;
    const kind = grantKind(permission.conditions);
    if (kind === "unrestricted") return true;
    if (kind === "entity" && user.entity !== null && user.entity === entity) return true;
  }
  return false;
}

/** The entities `permissions` let `user` reach at `level`, in `ENTITIES` order. `read` is read ∪ manage (AC-3.2). */
export function coveredEntities(
  permissions: readonly ResolvedPermission[],
  user: { readonly entity: string | null },
  level: AccessLevel,
): Entity[] {
  const actions: readonly AccessLevel[] = level === "read" ? ["read", "manage"] : ["manage"];
  return ENTITIES.filter((entity) => covers(permissions, actions, user, entity));
}

/** Both coverages of the caller, computed from the permissions `authzMiddleware` resolved. */
export function coverageOf(c: { readonly var: { readonly authz: AuthzContext } }): EntityCoverage {
  const { permissions, entity } = c.var.authz;
  const user = { entity };
  return { read: coveredEntities(permissions, user, "read"), manage: coveredEntities(permissions, user, "manage") };
}

// ─── The refusals every user route shares ────────────────────────────────────

/** 403: no `read` coverage for any entity (AC-3.6). Carries no data and does not say which entity was asked. */
export const accountingForbidden = (): ProblemError =>
  new ProblemError({
    status: 403,
    code: "accounting_forbidden",
    detail: "You do not have access to Accounting",
  });

/**
 * 404: the entity does not exist or is outside the caller's read coverage (AC-3.5). One body for both, so an
 * entity the caller does not cover cannot be told from one that does not exist.
 */
export const entityNotFound = (): ProblemError =>
  new ProblemError({ status: 404, code: "not_found", detail: "Not found" });

/** 403: the caller reads the entity but does not manage it (AC-3.4). */
export const accountingManageRequired = (): ProblemError =>
  new ProblemError({
    status: 403,
    code: "accounting_manage_required",
    detail: "Accounting manage is required to change this",
  });

/**
 * For a route that is not about one entity (`GET /v1/me`): the caller's coverage, or 403 `accounting_forbidden`
 * when `read` covers no entity at all.
 */
export function requireAnyAccess(c: { readonly var: { readonly authz: AuthzContext } }): EntityCoverage {
  const coverage = coverageOf(c);
  if (coverage.read.length === 0) throw accountingForbidden();
  return coverage;
}

/**
 * The one gate of every `/v1/entities/{entity}/…` route. `entity` is the raw path segment; the result is the
 * validated entity id. In this order, so a refusal never leaks more than it must:
 *
 *   1. no `read` for any entity            -> 403 `accounting_forbidden` (whatever the path says);
 *   2. unknown entity, or outside `read`   -> 404 `not_found`, the same body for both;
 *   3. a write without `manage(entity)`    -> 403 `accounting_manage_required`.
 *
 * Throws a `ProblemError`, rendered by the app's `onError`; call it before reading a body or touching the
 * database, so a refused request writes and audits nothing.
 */
export function requireEntityAccess(
  c: { readonly var: { readonly authz: AuthzContext } },
  entity: string,
  level: AccessLevel,
): Entity {
  const coverage = requireAnyAccess(c);
  if (!isEntity(entity) || !coverage.read.includes(entity)) throw entityNotFound();
  if (level === "manage" && !coverage.manage.includes(entity)) throw accountingManageRequired();
  return entity;
}
