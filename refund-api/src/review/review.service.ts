/**
 * Pure, DB-free helpers backing every accounting review/decide surface (T11,
 * specs/007-refund-service, ADR-0015).
 *
 * `scopeForReviewAction` is the ONE place a caller's entity scope is derived
 * for a given `request` action (`review`, `set-approved-total`, `approve`,
 * `reject`) — reused verbatim by the queue (T11), the per-line total edit,
 * and approve/reject (T12), so all four surfaces evaluate scope identically
 * (ADR-0015 Risks: "a single shared predicate/query fragment backing both
 * surfaces"). It composes the SAME two building blocks
 * requests.service.ts's `canReadRequest` already uses for its accounting
 * branch: `findPermission` (which specific grant, if any) +
 * `entityScopeForPermission` (conditioned vs. global).
 */

import type { AuthzContext } from "../auth/authz.middleware";
import {
  entityScopeForPermission,
  findPermission,
  hasCapability,
  requestInScope,
  type EntityScope,
} from "../authz/conditions";
import { computeSubtotals } from "../requests/requests.service";
import type { QueueRequestRow } from "./review.repo";
import type { ReviewQueueItem } from "./review.schemas";

export type ReviewAction =
  | "review"
  | "set-approved-total"
  | "approve"
  | "reject";

/**
 * Resolves the caller's entity scope for one `request` action.
 *
 * Returns:
 *  - `undefined` — the caller holds NO grant for `(request, action)` at all
 *    → capability-absent → **403** (ADR-0014 point 3).
 *  - `null` — the caller holds a conditioned grant but has no resolved
 *    `entity` attribute → matches nothing (ADR-0015's fail-closed
 *    data-integrity edge case) → treated as a record-level **404** (or an
 *    empty queue), never a 403 (the capability itself IS present).
 *  - an `EntityScope` — the caller's real scope: either a specific entity
 *    value, or `GLOBAL_ENTITY_SCOPE` for an unconditioned grant (AC-5.5).
 */
export function scopeForReviewAction(
  authz: AuthzContext,
  action: ReviewAction,
): EntityScope | null | undefined {
  if (!hasCapability(authz.permissions, "request", action)) return undefined;
  const grant = findPermission(authz.permissions, "request", action);
  return entityScopeForPermission(grant?.conditions ?? null, authz.entity);
}

/** Filters queue rows to those in scope — reuses `requestInScope` verbatim (ADR-0015). */
export function filterQueueInScope(
  rows: readonly QueueRequestRow[],
  scope: EntityScope,
): QueueRequestRow[] {
  return rows.filter((row) => requestInScope(row.lines, scope));
}

export function mapQueueItem(row: QueueRequestRow): ReviewQueueItem {
  if (!row.submittedAt) {
    // Invariant: every row this function receives is `submitted` or `approved`
    // (review.repo.ts) — both are stamped with `submittedAt` in
    // lifecycle.repo.ts's `submitTransaction`, and approval never clears it —
    // so this should be unreachable. Defensive throw (→ the global 500
    // handler) rather than emitting a lying timestamp.
    throw new Error(
      `Review-queue refund request ${row.id} is missing its submittedAt timestamp`,
    );
  }
  return {
    id: row.id,
    status: row.status as ReviewQueueItem["status"],
    owner: {
      userId: row.ownerUserId,
      email: row.ownerEmail,
      name: row.ownerName,
    },
    submittedAt: row.submittedAt.toISOString(),
    subtotals: computeSubtotals(row.lines),
  };
}
