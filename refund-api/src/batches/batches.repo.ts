/**
 * Prisma data-access layer for compiled-batch candidate preview + compile
 * (T3, specs/008-refund-monthly-processing, plan.md § API contracts /
 * § Atomic claim / no-double-pay).
 *
 * Two distinct read paths, deliberately different in shape:
 *
 *  - `fetchCandidateRows` (GET /batches/candidates, a dry run) fetches the
 *    FULL unscoped eligible set — mirrors review.repo.ts's
 *    `listSubmittedRequests` convention ("fetch everything, filter in the
 *    service layer via the ONE shared `requestInScope` predicate") so
 *    candidate-preview visibility can never desync from compile-time claim
 *    visibility (ADR-0015 Risks, reused verbatim by this feature).
 *
 *  - `compileBatch` (POST /batches) pushes the entity-scope filter DOWN INTO
 *    the locking `SELECT … FOR UPDATE` itself (raw SQL — Prisma's query
 *    builder has no lock-clause support), so a global compile and a
 *    DIFFERENT single-entity compile running concurrently never contend for
 *    the same row locks in the first place (plan.md § Atomic claim: "the
 *    `SELECT … FOR UPDATE` locks the EXACT candidate rows"). Postgres's
 *    READ COMMITTED re-check semantics on `SELECT … FOR UPDATE` — a blocked
 *    locker re-evaluates the WHERE clause against the row's post-commit
 *    state once the lock is released — is what makes two overlapping
 *    compiles claim disjoint sets even without any additional locking; the
 *    subsequent `UPDATE … WHERE "batchId" IS NULL` is an extra
 *    compare-and-swap belt (defense in depth, plan.md's own wording).
 *
 * `compileBatch` pre-generates the batch id (`crypto.randomUUID()`) so
 * `pdfObjectKey` (`batches/pdf.ts`'s `batchPdfObjectKey`) can be computed
 * and persisted in the SAME insert — `RefundBatch.pdfObjectKey` is a
 * required, unique column (schema.prisma), so there is no null/placeholder
 * state to paper over.
 */

import { Data, Effect } from "effect";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { Prisma } from "../lib/generated/prisma/client";
import { GLOBAL_ENTITY_SCOPE, type EntityScope } from "../authz/conditions";
import { DatabaseError, ValidationError } from "../lib/errors";
import { writeAuditEntry } from "../requests/audit";
import { batchPdfObjectKey } from "./pdf";
import type { LineRow } from "../requests/requests.service";
import type { BatchStatusValue } from "./batches.schemas";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

export interface CandidateRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly ownerName: string | null;
  readonly status: string;
  readonly decidedAt: Date | null;
  readonly lines: readonly LineRow[];
}

const candidateSelect = {
  id: true,
  ownerUserId: true,
  ownerEmail: true,
  ownerName: true,
  status: true,
  decidedAt: true,
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
} as const;

/**
 * Every `approved ∧ batchId IS NULL ∧ decidedAt<=cutoff` request, regardless
 * of entity (unscoped — filtered afterwards in batches.service.ts via
 * `requestInScope`, the SAME predicate compile-time claiming uses). A dry
 * run: no locking, no writes (AC-1.2's preview half).
 */
export function fetchCandidateRows(
  cutoff: Date,
): Effect.Effect<CandidateRow[], DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findMany({
        where: { status: "approved", batchId: null, decidedAt: { lte: cutoff } },
        orderBy: { decidedAt: "asc" },
        select: candidateSelect,
      }),
    catch: toDbErr("Failed to list batch candidates"),
  });
}

// ─── Batch row shape (general — reused by T3's compile AND T4's reads /
// T6's mark-paid / T8's discard, so every batch surface maps through the SAME
// shape regardless of which action produced/fetched it) ────────────────────

export interface BatchRow {
  readonly id: string;
  readonly cutoff: Date;
  readonly status: BatchStatusValue;
  readonly createdByUserId: string;
  readonly createdByEmail: string;
  readonly createdAt: Date;
  readonly pdfObjectKey: string;
  // specs/011-refund-settings, ADR-0029 — no longer the compile-time-frozen
  // configured address (ADR-0021, superseded); nullable per-attempt
  // delivery PROVENANCE ONLY, null until the first send/resend attempt. The
  // live `accounting-distribution-email` setting (src/settings/) is the
  // actual source of truth, resolved fresh at every attempt.
  readonly recipientEmailSnapshot: string | null;
  readonly emailStatus: string | null;
  readonly emailLastAttemptAt: Date | null;
  readonly emailDeliveryId: string | null;
  readonly paidAt: Date | null;
  readonly paidByEmail: string | null;
  readonly discardedAt: Date | null;
  readonly discardedByEmail: string | null;
}

export interface BatchWithRequests extends BatchRow {
  readonly requests: CandidateRow[];
}

/**
 * Raised (internally, inside the `$transaction` callback below) when the
 * locked candidate set is empty — compile must refuse and create nothing
 * (AC-1.4). Thrown-and-caught rather than an Effect-level `Effect.fail`
 * because it must abort the Prisma transaction itself (any throw inside a
 * `db.$transaction(async tx => …)` callback rolls the transaction back);
 * `compileBatch`'s `Effect.tryPromise` `catch` below converts it to the
 * public `ValidationError` (422, mirrors lifecycle.repo.ts's own
 * `ValidationError` usage for a refused-not-failed precondition).
 */
class EmptyCandidateSetError extends Data.TaggedError("EmptyCandidateSetError")<{
  readonly message: string;
}> {}

/**
 * Locks the exact eligible-and-in-scope candidate rows (`SELECT … FOR
 * UPDATE`, entity filter pushed into the SQL — see module doc), claims them
 * (`batchId` CAS), creates the `RefundBatch` + `RefundBatchItem`s, and
 * writes one `batch_compiled` audit row per claimed request — all inside
 * ONE `db.$transaction` (plan.md § Atomic claim). Empty locked set → the
 * transaction is aborted (throwing `EmptyCandidateSetError` rolls back
 * everything Prisma's `$transaction` callback attempted) and nothing is
 * created (AC-1.4).
 *
 * specs/011-refund-settings, ADR-0029 (D6) — compile no longer takes a
 * recipient email at all: it is now FULLY DECOUPLED from the accounting-
 * distribution-email setting (AC-2.1). `recipientEmailSnapshot` starts
 * `null` on every freshly-compiled batch; the send path (batches/email.ts)
 * resolves the live setting and records its own delivery provenance there.
 */
export function compileBatch(
  cutoff: Date,
  scope: EntityScope,
  actorUserId: string,
  actorEmail: string,
): Effect.Effect<BatchWithRequests, DatabaseError | ValidationError> {
  return Effect.tryPromise({
    try: () =>
      db.$transaction(async (tx) => {
        const entityFilter =
          scope === GLOBAL_ENTITY_SCOPE
            ? Prisma.sql``
            : Prisma.sql`AND EXISTS (
                SELECT 1 FROM "refund_line" rl
                WHERE rl."requestId" = rr.id AND rl.entity = ${scope}::"Entity"
              )`;

        const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT rr.id
          FROM "refund_request" rr
          WHERE rr.status = 'approved'::"RefundStatus"
            AND rr."batchId" IS NULL
            AND rr."decidedAt" <= ${cutoff}
            ${entityFilter}
          FOR UPDATE OF rr
        `);
        const lockedIds = locked.map((row) => row.id);

        if (lockedIds.length === 0) {
          throw new EmptyCandidateSetError({
            message: "No eligible requests to compile for the given cutoff",
          });
        }

        const batchId = randomUUID();
        const pdfObjectKey = batchPdfObjectKey(batchId);

        // The batch row must exist BEFORE any refund_request row can point
        // its batchId FK at it — create it first, then claim.
        const batch = await tx.refundBatch.create({
          data: {
            id: batchId,
            cutoff,
            status: "compiled",
            createdByUserId: actorUserId,
            createdByEmail: actorEmail,
            pdfObjectKey,
            recipientEmailSnapshot: null,
          },
        });

        // Compare-and-swap belt (plan.md): the FOR UPDATE lock + Postgres's
        // READ COMMITTED re-check already guarantee `lockedIds` is disjoint
        // from any other transaction's claim, but this extra
        // `batchId IS NULL` guard is defense in depth.
        const claim = await tx.refundRequest.updateMany({
          where: { id: { in: lockedIds }, batchId: null },
          data: { batchId },
        });
        if (claim.count !== lockedIds.length) {
          // Should be unreachable given the row lock above — surfaced as a
          // hard failure rather than silently claiming a partial set.
          throw new Error(
            `Batch claim CAS mismatch: locked ${lockedIds.length} rows but claimed ${claim.count}`,
          );
        }

        await tx.refundBatchItem.createMany({
          data: lockedIds.map((requestId) => ({ batchId, requestId })),
        });

        for (const requestId of lockedIds) {
          await writeAuditEntry(tx, {
            requestId,
            batchId,
            actorUserId,
            actorEmail,
            action: "batch_compiled",
          });
        }

        const requests = await tx.refundRequest.findMany({
          where: { id: { in: lockedIds } },
          select: candidateSelect,
        });

        return {
          id: batch.id,
          cutoff: batch.cutoff,
          status: batch.status,
          createdByUserId: batch.createdByUserId,
          createdByEmail: batch.createdByEmail,
          createdAt: batch.createdAt,
          pdfObjectKey: batch.pdfObjectKey,
          recipientEmailSnapshot: batch.recipientEmailSnapshot,
          emailStatus: batch.emailStatus,
          emailLastAttemptAt: batch.emailLastAttemptAt,
          emailDeliveryId: batch.emailDeliveryId,
          paidAt: batch.paidAt,
          paidByEmail: batch.paidByEmail,
          discardedAt: batch.discardedAt,
          discardedByEmail: batch.discardedByEmail,
          requests,
        };
      }),
    catch: (cause) => {
      if (cause instanceof EmptyCandidateSetError) {
        return new ValidationError({ message: cause.message });
      }
      return new DatabaseError({
        message: "Failed to compile refund batch",
        cause,
      });
    },
  });
}

// ─── Reads (GET /batches, GET /batches/:id, GET /batches/:id/pdf-url — T4) ──
//
// Membership for a READ is resolved via `RefundBatchItem` (the append-only
// record), NEVER via the live `RefundRequest.batchId` pointer — a discarded
// batch's requests have their `batchId` nulled (released to the pool), but
// the batch itself must remain fully inspectable (AC-6.3/7.3): "which
// requests it once held, who released them, when". `fetchBatchWithRequests`
// and `listBatchSummaries` both join through `items`, then re-fetch each
// member request's CURRENT row (owner/lines/status) by id — this is what
// lets a `paid` batch's detail show `status:"paid"` per request (T6) and a
// `discarded` batch still show its (now-released) members (T8).

/**
 * Full batch + its member requests (current data, joined via
 * `RefundBatchItem`), or `null` if no such batch exists (→ caller returns
 * 404). Backs `GET /batches/:id`, `GET /batches/:id/pdf-url`'s lazy-regen
 * input, and the response re-fetch after mark-paid/discard (T6/T8).
 */
export function fetchBatchWithRequests(
  batchId: string,
): Effect.Effect<BatchWithRequests | null, DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const batch = await db.refundBatch.findUnique({
        where: { id: batchId },
        include: { items: { select: { requestId: true } } },
      });
      if (!batch) return null;

      const requestIds = batch.items.map((item) => item.requestId);
      const requests = requestIds.length
        ? await db.refundRequest.findMany({
            where: { id: { in: requestIds } },
            select: candidateSelect,
          })
        : [];

      return {
        id: batch.id,
        cutoff: batch.cutoff,
        status: batch.status,
        createdByUserId: batch.createdByUserId,
        createdByEmail: batch.createdByEmail,
        createdAt: batch.createdAt,
        pdfObjectKey: batch.pdfObjectKey,
        recipientEmailSnapshot: batch.recipientEmailSnapshot,
        emailStatus: batch.emailStatus,
        emailLastAttemptAt: batch.emailLastAttemptAt,
        emailDeliveryId: batch.emailDeliveryId,
        paidAt: batch.paidAt,
        paidByEmail: batch.paidByEmail,
        discardedAt: batch.discardedAt,
        discardedByEmail: batch.discardedByEmail,
        requests,
      };
    },
    catch: toDbErr("Failed to fetch refund batch"),
  });
}

export interface BatchSummaryRow {
  readonly id: string;
  readonly cutoff: Date;
  readonly status: BatchStatusValue;
  readonly createdAt: Date;
  readonly emailStatus: string | null;
  readonly requestCount: number;
  readonly lines: readonly LineRow[];
}

/**
 * Every batch, every status (AC-8.2), newest first. NOT entity-scoped
 * (§ Resolved decisions D1, plan.md) — the route layer gates this on
 * `request:review` alone, no scope filtering. Per-batch subtotals are
 * computed by the caller (`mapBatchSummary`, batches.service.ts) from the
 * `lines` this function already joins in, one query for the batch rows +
 * one batched query for every member request's lines (avoids N+1).
 */
export function listBatchSummaries(): Effect.Effect<
  BatchSummaryRow[],
  DatabaseError
> {
  return Effect.tryPromise({
    try: async () => {
      const batches = await db.refundBatch.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          cutoff: true,
          status: true,
          createdAt: true,
          emailStatus: true,
          items: { select: { requestId: true } },
        },
      });
      if (batches.length === 0) return [];

      const allRequestIds = Array.from(
        new Set(batches.flatMap((batch) => batch.items.map((item) => item.requestId))),
      );
      const requests = allRequestIds.length
        ? await db.refundRequest.findMany({
            where: { id: { in: allRequestIds } },
            select: candidateSelect,
          })
        : [];
      const linesByRequestId = new Map(requests.map((r) => [r.id, r.lines]));

      return batches.map((batch) => ({
        id: batch.id,
        cutoff: batch.cutoff,
        status: batch.status,
        createdAt: batch.createdAt,
        emailStatus: batch.emailStatus,
        requestCount: batch.items.length,
        lines: batch.items.flatMap(
          (item) => linesByRequestId.get(item.requestId) ?? [],
        ),
      }));
    },
    catch: toDbErr("Failed to list refund batches"),
  });
}

// ─── Email delivery status write-back (T5; widened T4 specs/011) ──────────

/**
 * `"blocked_unconfigured"` (specs/011-refund-settings, ADR-0029) marks a
 * send/resend attempt that never reached notify-api because the
 * `accounting-distribution-email` setting was unconfigured at attempt time
 * — distinguishable from an ordinary `"failed"` notify-api/Resend outage
 * (AC-2.2).
 */
export interface EmailAttemptOutcome {
  readonly status: "sent" | "failed" | "blocked_unconfigured";
  readonly deliveryId: string | null;
  /** The live setting value THIS attempt targeted (D6) — `null` when the attempt was blocked_unconfigured. Persisted as `recipientEmailSnapshot`'s new nullable per-attempt-provenance meaning. */
  readonly recipientEmail: string | null;
}

/**
 * Persists the outcome of a compilation-email send/resend attempt
 * (AC-3.2) — `emailStatus`/`emailLastAttemptAt`/`emailDeliveryId`/
 * `recipientEmailSnapshot` (repurposed to per-attempt provenance, D6).
 * Called AFTER the email send has already been attempted (batches/email.ts);
 * a failure here is itself best-effort-logged by the caller, never allowed
 * to fail the triggering compile/resend response.
 */
export function recordEmailAttempt(
  batchId: string,
  outcome: EmailAttemptOutcome,
): Effect.Effect<void, DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      await db.refundBatch.update({
        where: { id: batchId },
        data: {
          emailStatus: outcome.status,
          emailLastAttemptAt: new Date(),
          emailDeliveryId: outcome.deliveryId,
          recipientEmailSnapshot: outcome.recipientEmail,
        },
      });
    },
    catch: toDbErr("Failed to record batch email delivery status"),
  });
}
