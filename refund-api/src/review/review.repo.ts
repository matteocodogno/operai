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
 * in a batch, are excluded. NEWEST-submitted-first, mixed by status — the
 * UI's status badge distinguishes the two.
 *
 * Ordering note: this was oldest-first (FIFO) until 2026-09-08. Accounting
 * works the queue newest-first, so the most recent submissions must be at the
 * top rather than buried under months of already-approved rows. AC-5.1 asks
 * only for "enough summary to prioritize" and pins no order, so this is not a
 * spec deviation.
 *
 * `nulls: "last"` is explicit because the asc→desc flip silently reverses the
 * database default: `submittedAt` is nullable (`schema.prisma`) and Postgres
 * sorts a DESC column NULLS FIRST, so a row that somehow reached
 * `submitted`/`approved` without a timestamp would move from the bottom of
 * the queue to the very top. In practice such a row never reaches a client —
 * `mapQueueItem` (review.service.ts) throws on it rather than serializing a
 * lying timestamp, turning the whole request into a 500 — so this is defence
 * in depth at the query layer, not the thing that keeps the response correct.
 * It is pinned by a repo-level test, deliberately not a route-level one.
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
        orderBy: { submittedAt: { sort: "desc", nulls: "last" } },
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
