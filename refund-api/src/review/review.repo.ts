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
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly ownerName: string | null;
  readonly submittedAt: Date | null;
  readonly lines: readonly LineRow[];
}

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

/**
 * Every `submitted` request (AC-5.2 — `draft`/`approved`/`rejected` are
 * never mixed in), oldest-submitted-first (a simple FIFO queue ordering).
 * `lines` carries the full `LineRow` field set (not just `entity`) so the
 * SAME `computeSubtotals` helper `requests.service.ts` uses for the
 * employee's own list/detail views can be reused verbatim here too
 * (AC-5.1's "enough summary to prioritize" / AC-6.6's subtotal parity).
 */
export function listSubmittedRequests(): Effect.Effect<
  QueueRequestRow[],
  DatabaseError
> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findMany({
        where: { status: "submitted" },
        orderBy: { submittedAt: "asc" },
        select: {
          id: true,
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
