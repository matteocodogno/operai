/**
 * Prisma data-access layer for the accounting review queue (T11,
 * specs/007-refund-service, AC-5.1/5.2/5.3/5.5/5.6).
 *
 * Deliberately fetches EVERY `submitted` request, regardless of entity — the
 * entity-scope filter is applied afterwards in review.service.ts via the
 * SAME `requestInScope` predicate requests.service.ts's `canReadRequest`
 * already uses for the record-level `GET /requests/:id` check (T7). ADR-0015
 * Risks names this explicitly: the queue's scoping and the record-level
 * gate must never diverge, so both surfaces call the ONE shared predicate
 * function rather than each encoding their own "at least one line matches"
 * logic (e.g. as two independently-written SQL/application checks).
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { DatabaseError } from "../lib/errors";
import type { LineRow } from "../requests/requests.service";

export interface QueueRequestRow {
  readonly id: string;
  readonly status: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly ownerName: string | null;
  readonly submittedAt: Date | null;
  readonly lines: readonly LineRow[];
}

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

/**
 * The review-queue worklist: every request awaiting an accounting decision
 * (`submitted`) PLUS every request already `approved` but not yet pulled into
 * a monthly batch (`batchId IS NULL`) — the "approved but not processed" set
 * the accounting user asked to keep visible here. An approved request drops
 * off the queue the moment it is compiled into a batch (its `batchId` is set,
 * specs/008/ADR-0020). `draft`/`rejected`/`paid`, and `approved` rows already
 * in a batch, are excluded. Oldest-submitted-first (a simple FIFO ordering),
 * mixed by status — the UI's status badge distinguishes the two.
 *
 * NOTE: this widens 007's AC-5.2 ("submitted only"); see the review-queue
 * doc comment / spec 007 amendment. `lines` carries the full `LineRow` field
 * set (not just `entity`) so the SAME `computeSubtotals` helper
 * `requests.service.ts` uses for the employee's own list/detail views can be
 * reused verbatim here too (AC-5.1's "enough summary to prioritize").
 */
export function listReviewQueueRequests(): Effect.Effect<
  QueueRequestRow[],
  DatabaseError
> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findMany({
        where: {
          OR: [
            { status: "submitted" },
            { status: "approved", batchId: null },
          ],
        },
        orderBy: { submittedAt: "asc" },
        select: {
          id: true,
          status: true,
          ownerUserId: true,
          ownerEmail: true,
          ownerName: true,
          submittedAt: true,
          lines: {
            select: {
              id: true,
              date: true,
              type: true,
              motivo: true,
              entity: true,
              currency: true,
              requestedAmountCents: true,
              km: true,
              approvedTotalCents: true,
            },
          },
        },
      }),
    catch: toDbErr("Failed to list the review queue"),
  });
}
