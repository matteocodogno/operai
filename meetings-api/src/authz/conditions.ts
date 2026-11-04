/**
 * Capability lookup over the permissions `auth GET /authz/resolve` returned
 * (specs/021-meetings, ADR-0014 point 3). The `meetings` catalog is entirely
 * unconditioned (plan.md § Authorization), so unlike crm-api there is no entity
 * scope here: a grant is held or it is not.
 */

import type { ResolvedPermission } from "./resolveClient";

/** Whether the resolved set contains `(resource, action)`, whatever its conditions. */
export function hasCapability(
  permissions: readonly ResolvedPermission[],
  resource: string,
  action: string,
): boolean {
  return permissions.some((p) => p.resource === resource && p.action === action);
}
