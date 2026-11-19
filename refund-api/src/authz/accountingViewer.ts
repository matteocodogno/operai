/**
 * `viewer.canOpenAccountingRates`: whether the caller may follow a link to Accounting's exchange rates of WellD CH
 * (specs/20261119-accounting T19; AC-7.3, plan D17, ADR 20261117-an-app-is-reachable-through-a-capability-it-administers).
 *
 * Decided HERE, from the caller's resolved permissions, because a browser never evaluates conditions: it is `true` when
 * the caller holds `accounting:read` or `accounting:manage` covering WellD CH. `manage` includes `read` (AC-3.2). It is
 * the same rule accounting-api applies on every route and auth applies to derive the Accounting menu entry, so the three
 * cannot drift: all three read one set of vectors, auth's `entity-coverage-vectors.json` (accountingViewer.test.ts reads
 * the file, read-only).
 *
 * The coverage rule, fail closed:
 * - an UNCONDITIONED grant (`conditions` null, or with neither `ownership` nor `attributes`) covers both entities,
 *   whatever the user's own entity;
 * - `{attributes:[{key:"entity", match:"user"}]}` and nothing else covers the user's OWN entity, compared exactly, and only
 *   when it is one of the two legal entities; a user with no entity is covered by nothing;
 * - ANY other condition (an ownership, another attribute, another match, the entity condition next to one of those)
 *   covers nothing, and does not hide a recognised grant next to it.
 *
 * This answers a presentation question (show a link or not). Accounting enforces every route itself, so a wrong `true`
 * here costs a 403 on the other side, never access.
 */

import type { ResolveConditions, ResolvedPermission } from "./resolveClient";

/** The legal entities Accounting keeps data for. */
export const ACCOUNTING_ENTITIES = ["welld_ch", "welld_it"] as const;
export type AccountingEntity = (typeof ACCOUNTING_ENTITIES)[number];

type GrantKind = "unrestricted" | "entity" | "unrecognised";

function grantKind(conditions: ResolveConditions | null): GrantKind {
  if (conditions === null) return "unrestricted";
  const attributes = conditions.attributes ?? [];
  if (conditions.ownership === undefined && attributes.length === 0) return "unrestricted";
  const onlyEntity = attributes.every((attribute) => attribute["key"] === "entity" && attribute.match === "user");
  return conditions.ownership === undefined && onlyEntity ? "entity" : "unrecognised";
}

/** Whether a grant of `(resource, action)` in `permissions` covers `entity` for `user`. */
function covers(
  permissions: readonly ResolvedPermission[],
  resource: string,
  action: string,
  user: { readonly entity: string | null },
  entity: AccountingEntity,
): boolean {
  let covered = false;
  for (const permission of permissions) {
    if (permission.resource !== resource || permission.action !== action) continue;
    const kind = grantKind(permission.conditions);
    if (kind === "unrestricted") return true;
    if (kind === "entity" && user.entity !== null && user.entity === entity) covered = true;
  }
  return covered;
}

/** The entities `accounting:read` OR `accounting:manage` covers for `user` (manage includes read, AC-3.2). */
export function accountingReadCoverage(
  permissions: readonly ResolvedPermission[],
  user: { readonly entity: string | null },
): AccountingEntity[] {
  return ACCOUNTING_ENTITIES.filter(
    (entity) =>
      covers(permissions, "accounting", "read", user, entity) || covers(permissions, "accounting", "manage", user, entity),
  );
}

/** AC-7.3: may this caller open Accounting's exchange rates of WellD CH (link) rather than be told to ask a manager? */
export function canOpenAccountingRates(
  permissions: readonly ResolvedPermission[],
  user: { readonly entity: string | null },
): boolean {
  return accountingReadCoverage(permissions, user).includes("welld_ch");
}
