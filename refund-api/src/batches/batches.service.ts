/**
 * Pure, DB-free mapping/grouping helpers for the compiled-batch surfaces
 * (T3, specs/008-refund-monthly-processing).
 *
 * Reuses `computeSubtotals` (requests.service.ts, 007's "never blended"
 * per-currency rule) as the ONE place money is summed, both for the
 * reduced `BatchSubtotal` shape (currency + non-nullable approvedCents —
 * every line in an `approved` request has its `approvedTotalCents`
 * finalized by 007's approve handler, AC-7.2) and for the full per-request
 * `Subtotal` shape BatchDetail's `employees[].requests[]` carries.
 *
 * `scopeForReviewAction`/`requestInScope` are reused VERBATIM from
 * review.service.ts / authz/conditions.ts — candidate-set visibility must
 * never diverge from the review queue's own entity-scope predicate
 * (ADR-0015 Risks, carried forward by this feature per plan.md).
 */

import { requestInScope, type EntityScope } from "../authz/conditions";
import { computeSubtotals, type LineRow } from "../requests/requests.service";
import type { Subtotal } from "../requests/requests.schemas";
import type { BatchPdfEmployee } from "./pdf";
import type { CandidateRow, CompiledBatch } from "./batches.repo";
import type {
  BatchDetail,
  BatchSubtotal,
  CandidateEmployee,
  CandidatePreview,
} from "./batches.schemas";

export { scopeForReviewAction, type ReviewAction } from "../review/review.service";

/** Filters candidate rows to those in the caller's entity scope (mirrors review.service.ts's `filterQueueInScope`). */
export function filterCandidatesInScope(
  rows: readonly CandidateRow[],
  scope: EntityScope,
): CandidateRow[] {
  return rows.filter((row) => requestInScope(row.lines, scope));
}

/** `Subtotal[]` (nullable approvedCents) → `BatchSubtotal[]` (non-nullable) — see module doc. */
function toBatchSubtotals(subtotals: readonly Subtotal[]): BatchSubtotal[] {
  return subtotals.map((s) => ({
    currency: s.currency,
    approvedCents: s.approvedCents ?? 0,
  }));
}

function groupByOwner<T extends { readonly ownerUserId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const group = map.get(row.ownerUserId);
    if (group) {
      group.push(row);
    } else {
      map.set(row.ownerUserId, [row]);
    }
  }
  return map;
}

/** Sorted by owner email so grouped output is deterministic (mirrors pdf.ts's own ordering rationale). */
function sortedOwnerGroups<T extends { readonly ownerEmail: string; readonly ownerUserId: string }>(
  grouped: Map<string, T[]>,
): [string, T[]][] {
  return Array.from(grouped.entries()).sort(([, a], [, b]) => {
    const byEmail = (a[0]?.ownerEmail ?? "").localeCompare(b[0]?.ownerEmail ?? "");
    if (byEmail !== 0) return byEmail;
    return (a[0]?.ownerUserId ?? "").localeCompare(b[0]?.ownerUserId ?? "");
  });
}

// ─── CandidatePreview (GET /batches/candidates, dry run) ───────────────────

export function mapCandidatePreview(
  cutoff: Date,
  rows: readonly CandidateRow[],
): CandidatePreview {
  const allLines: LineRow[] = rows.flatMap((r) => [...r.lines]);
  const employees: CandidateEmployee[] = sortedOwnerGroups(groupByOwner(rows)).map(
    ([, requests]) => {
      const first = requests[0]!;
      const lines = requests.flatMap((r) => [...r.lines]);
      return {
        owner: {
          userId: first.ownerUserId,
          email: first.ownerEmail,
          name: first.ownerName,
        },
        requestIds: requests.map((r) => r.id).sort((a, b) => a.localeCompare(b)),
        subtotals: toBatchSubtotals(computeSubtotals(lines)),
      };
    },
  );

  return {
    cutoff: cutoff.toISOString(),
    requestCount: rows.length,
    subtotals: toBatchSubtotals(computeSubtotals(allLines)),
    employees,
  };
}

// ─── BatchDetail (compiled — this module's shared mapping, reused by T4's reads) ──

/** `CompiledBatch.requests` (batches.repo.ts) → `BatchPdfInput.employees` (pdf.ts), for the post-commit render. */
export function toBatchPdfEmployees(
  requests: readonly CandidateRow[],
): BatchPdfEmployee[] {
  return sortedOwnerGroups(groupByOwner(requests)).map(([, reqs]) => ({
    owner: {
      userId: reqs[0]!.ownerUserId,
      email: reqs[0]!.ownerEmail,
      name: reqs[0]!.ownerName,
    },
    requests: reqs.map((r) => ({ id: r.id, lines: r.lines })),
  }));
}

export interface BatchPdfLinkInput {
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * Shared BatchDetail mapper — used by POST /batches' 201 response (T3) and,
 * once T4 lands, by GET /batches/:id and the post-mark-paid/discard
 * responses. `status`/`paidAt`/`paidBy`/`discardedAt`/`discardedBy`/`email`
 * are the CALLER's job to fill from the batch row's current state; this
 * function only ever sees a `compiled` batch as of T3 (mark-paid/discard
 * land in T6/T8), so those fields are fixed to their just-created values
 * here.
 */
export function mapBatchDetail(
  batch: CompiledBatch,
  pdf: BatchPdfLinkInput,
): BatchDetail {
  const allLines: LineRow[] = batch.requests.flatMap((r) => [...r.lines]);
  const employees = sortedOwnerGroups(groupByOwner(batch.requests)).map(
    ([, requests]) => {
      const first = requests[0]!;
      const lines = requests.flatMap((r) => [...r.lines]);
      return {
        owner: {
          userId: first.ownerUserId,
          email: first.ownerEmail,
          name: first.ownerName,
        },
        requests: requests
          .map((r) => ({
            id: r.id,
            status: "approved",
            subtotals: computeSubtotals(r.lines),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        subtotals: toBatchSubtotals(computeSubtotals(lines)),
      };
    },
  );

  return {
    id: batch.id,
    cutoff: batch.cutoff.toISOString(),
    status: batch.status,
    requestCount: batch.requests.length,
    createdBy: { userId: batch.createdByUserId, email: batch.createdByEmail },
    createdAt: batch.createdAt.toISOString(),
    subtotals: toBatchSubtotals(computeSubtotals(allLines)),
    employees,
    email: { status: null, lastAttemptAt: null },
    paidAt: null,
    paidBy: null,
    discardedAt: null,
    discardedBy: null,
    pdf,
  };
}
