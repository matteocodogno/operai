/**
 * Prisma data-access layer for the batch terminal transitions — mark-paid
 * (T6), specs/008-refund-monthly-processing, plan.md § Atomic claim /
 * no-double-pay "mark-paid / discard terminal CAS", ADR-0020.
 *
 * `UPDATE refund_batch SET status=… WHERE id=:B AND status='compiled'` —
 * the `status='compiled'` predicate is the compare-and-swap that makes the
 * transition happen EXACTLY once. A `rowCount` of 0 means either the batch
 * does not exist (checked separately, → 404) or it was already `paid`/
 * `discarded` (→ 409, AC-4.3). A concurrent mark-paid vs discard (T8) on
 * the SAME batch: Postgres's row-level lock on the UPDATE statement
 * serializes the two transactions; whichever commits first wins the CAS,
 * the other's `WHERE status='compiled'` re-evaluates against the
 * now-committed OTHER status and matches 0 rows — exactly one 200, one 409
 * (same technique `review/decide.repo.ts` already uses for
 * `approveTransaction`/`rejectTransaction`).
 *
 * Writes one `batch_paid` audit row PER AFFECTED REQUEST inside the same
 * transaction (`writeAuditEntry`, batchId set — AC-7.1/AC-7.2).
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { ConflictError, DatabaseError, NotFoundError } from "../lib/errors";
import { writeAuditEntry } from "../requests/audit";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

type TransitionOutcome<T> =
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" }
  | ({ readonly kind: "ok" } & T);

function toTransitionEffect<T>(
  outcome: TransitionOutcome<T>,
  batchId: string,
): Effect.Effect<T, NotFoundError | ConflictError> {
  if (outcome.kind === "not-found") {
    return Effect.fail(
      new NotFoundError({ message: `Refund batch ${batchId} not found` }),
    );
  }
  if (outcome.kind === "conflict") {
    return Effect.fail(
      new ConflictError({ message: "Batch is not in a compiled state" }),
    );
  }
  return Effect.succeed(outcome);
}

// ─── Mark-paid (T6, AC-4.1-4.4, AC-7.2) ─────────────────────────────────────

export interface PaidRequestOwner {
  readonly requestId: string;
  readonly ownerUserId: string;
}

export interface MarkPaidResult {
  readonly batchId: string;
  readonly paidRequestOwners: readonly PaidRequestOwner[];
}

/**
 * Terminal CAS `compiled → paid` + the all-or-nothing per-request flip
 * `approved → paid` (AC-4.1), in ONE `$transaction`. Requests are already
 * immutable at `approved` (007), so nothing else can contend for them
 * between the CAS and the flip.
 */
export function markBatchPaid(
  batchId: string,
  actorUserId: string,
  actorEmail: string,
): Effect.Effect<MarkPaidResult, DatabaseError | NotFoundError | ConflictError> {
  return Effect.tryPromise({
    try: () =>
      db.$transaction(async (tx): Promise<TransitionOutcome<MarkPaidResult>> => {
        const existing = await tx.refundBatch.findUnique({
          where: { id: batchId },
          select: { id: true },
        });
        if (!existing) return { kind: "not-found" };

        const claim = await tx.refundBatch.updateMany({
          where: { id: batchId, status: "compiled" },
          data: { status: "paid", paidAt: new Date(), paidByEmail: actorEmail },
        });
        if (claim.count === 0) return { kind: "conflict" };

        const requests = await tx.refundRequest.findMany({
          where: { batchId, status: "approved" },
          select: { id: true, ownerUserId: true },
        });

        const flip = await tx.refundRequest.updateMany({
          where: { batchId, status: "approved" },
          data: { status: "paid" },
        });
        if (flip.count !== requests.length) {
          // Unreachable given the batch-row CAS above already serialized
          // this transaction against any other batch mutation — surfaced as
          // a hard failure rather than silently flipping a partial set.
          throw new Error(
            `Mark-paid CAS mismatch: expected to flip ${requests.length} requests, flipped ${flip.count}`,
          );
        }

        for (const request of requests) {
          await writeAuditEntry(tx, {
            requestId: request.id,
            batchId,
            actorUserId,
            actorEmail,
            action: "batch_paid",
          });
        }

        return {
          kind: "ok",
          batchId,
          paidRequestOwners: requests.map((r) => ({
            requestId: r.id,
            ownerUserId: r.ownerUserId,
          })),
        };
      }),
    catch: toDbErr("Failed to mark refund batch paid"),
  }).pipe(Effect.flatMap((outcome) => toTransitionEffect(outcome, batchId)));
}
