/**
 * Prisma data-access layer for accounting decisions (T12,
 * specs/007-refund-service, AC-7.1-7.6, US-8/ADR-0018).
 *
 * `ensureInScopeSubmittedRequest` is the shared gate for every decision
 * mutation (PUT approved-total, POST approve, POST reject) — it evaluates
 * ADR-0015's "at least one line matches" predicate (`requestInScope`,
 * SAME function T6/T11 use) BEFORE the status check, so an out-of-scope
 * caller always gets 404 regardless of the request's status (never a 409,
 * which would leak state to someone who shouldn't even see the request
 * exists — ADR-0005/0015 posture). `scope === null` (T11's fail-closed
 * data-integrity edge case) always denies, matching zero lines.
 *
 * Every mutation writes an append-only audit row (audit.ts, AC-8.1) inside
 * the SAME transaction as the state change it records.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { requestInScope, type EntityScope } from "../authz/conditions";
import { ConflictError, DatabaseError, NotFoundError } from "../lib/errors";
import { lineInclude } from "../requests/lines.repo";
import { writeAuditEntry } from "../requests/audit";
import type { LineRow } from "../requests/requests.service";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

interface ScopeCheckLine {
  readonly id: string;
  readonly entity: string;
}
interface ScopeCheckRow {
  readonly status: string;
  readonly lines: readonly ScopeCheckLine[];
}

function fetchScopeCheckRow(
  requestId: string,
): Effect.Effect<ScopeCheckRow | null, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findUnique({
        where: { id: requestId },
        select: { status: true, lines: { select: { id: true, entity: true } } },
      }),
    catch: toDbErr("Failed to look up refund request"),
  });
}

function ensureInScopeSubmittedRequest(
  requestId: string,
  scope: EntityScope | null,
): Effect.Effect<ScopeCheckRow, DatabaseError | NotFoundError | ConflictError> {
  return fetchScopeCheckRow(requestId).pipe(
    Effect.flatMap(
      (row): Effect.Effect<ScopeCheckRow, NotFoundError | ConflictError> => {
        if (!row || scope === null || !requestInScope(row.lines, scope)) {
          return Effect.fail(
            new NotFoundError({
              message: `Refund request ${requestId} not found`,
            }),
          );
        }
        if (row.status !== "submitted") {
          return Effect.fail(
            new ConflictError({
              message: "Only a submitted request can be reviewed",
            }),
          );
        }
        return Effect.succeed(row);
      },
    ),
  );
}

// ─── PUT .../lines/:lineId/approved-total (AC-7.1) ─────────────────────────

export function setApprovedTotal(
  requestId: string,
  lineId: string,
  approvedTotalCents: number,
  scope: EntityScope | null,
  actorUserId: string,
  actorEmail: string,
): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> {
  return ensureInScopeSubmittedRequest(requestId, scope).pipe(
    Effect.flatMap(
      (
        row,
      ): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> => {
        const lineExists = row.lines.some((l) => l.id === lineId);
        if (!lineExists) {
          return Effect.fail(
            new NotFoundError({ message: `Refund line ${lineId} not found` }),
          );
        }
        return Effect.tryPromise({
          try: () =>
            db.$transaction(async (tx) => {
              const priorLine = await tx.refundLine.findUniqueOrThrow({
                where: { id: lineId },
                select: { approvedTotalCents: true },
              });
              // Re-assert submitted status atomically — a concurrent decision
              // (approve/reject) between the pre-check above and this write
              // must be caught, not silently overwritten (AC-7.4).
              const { count } = await tx.refundRequest.updateMany({
                where: { id: requestId, status: "submitted" },
                data: { updatedAt: new Date() },
              });
              if (count === 0) return null;
              const updated = await tx.refundLine.updateMany({
                where: { id: lineId, requestId },
                data: { approvedTotalCents },
              });
              if (updated.count === 0) return null;
              await writeAuditEntry(tx, {
                requestId,
                lineId,
                actorUserId,
                actorEmail,
                action: "approved_total_set",
                detail: {
                  fromCents: priorLine.approvedTotalCents,
                  toCents: approvedTotalCents,
                },
              });
              return tx.refundLine.findUniqueOrThrow({
                where: { id: lineId },
                include: lineInclude,
              });
            }),
          catch: toDbErr("Failed to set the approved total"),
        }).pipe(
          Effect.flatMap((line) =>
            line
              ? Effect.succeed(line)
              : Effect.fail(
                  new ConflictError({
                    message: "Refund request status changed concurrently — retry",
                  }),
                ),
          ),
        );
      },
    ),
  );
}

// ─── POST .../approve (AC-7.2) ──────────────────────────────────────────────

function approveTransaction(
  requestId: string,
  actorUserId: string,
  actorEmail: string,
): Effect.Effect<void, DatabaseError | ConflictError> {
  return Effect.tryPromise({
    try: () =>
      db.$transaction(async (tx) => {
        const { count } = await tx.refundRequest.updateMany({
          where: { id: requestId, status: "submitted" },
          data: {
            status: "approved",
            decidedAt: new Date(),
            decidedByUserId: actorUserId,
            decidedByEmail: actorEmail,
          },
        });
        if (count === 0) return false;

        // AC-7.2 — default any line LEFT UNTOUCHED (never PUT'd via
        // approved-total) to its requested amount; a line already set is
        // left EXACTLY as set, including an explicit zero.
        const untouched = await tx.refundLine.findMany({
          where: { requestId, approvedTotalCents: null },
          select: { id: true, requestedAmountCents: true },
        });
        for (const line of untouched) {
          await tx.refundLine.update({
            where: { id: line.id },
            data: { approvedTotalCents: line.requestedAmountCents },
          });
        }

        await writeAuditEntry(tx, {
          requestId,
          actorUserId,
          actorEmail,
          action: "approved",
        });
        return true;
      }),
    catch: toDbErr("Failed to approve refund request"),
  }).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.succeed(undefined)
        : Effect.fail(
            new ConflictError({
              message: "Refund request status changed concurrently — retry",
            }),
          ),
    ),
  );
}

export function approveRequest(
  requestId: string,
  scope: EntityScope | null,
  actorUserId: string,
  actorEmail: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> {
  return ensureInScopeSubmittedRequest(requestId, scope).pipe(
    Effect.flatMap(() => approveTransaction(requestId, actorUserId, actorEmail)),
  );
}

// ─── POST .../reject (AC-7.3) ────────────────────────────────────────────────

function rejectTransaction(
  requestId: string,
  actorUserId: string,
  actorEmail: string,
  motivation: string,
): Effect.Effect<void, DatabaseError | ConflictError> {
  return Effect.tryPromise({
    try: () =>
      db.$transaction(async (tx) => {
        const { count } = await tx.refundRequest.updateMany({
          where: { id: requestId, status: "submitted" },
          data: {
            status: "rejected",
            rejectionMotivation: motivation,
            decidedAt: new Date(),
            decidedByUserId: actorUserId,
            decidedByEmail: actorEmail,
          },
        });
        if (count === 0) return false;
        // Per-line approved totals are NOT applicable to a rejected request
        // (AC-7.3) — deliberately left untouched (whatever, if anything, was
        // set via PUT approved-total before the reject).
        await writeAuditEntry(tx, {
          requestId,
          actorUserId,
          actorEmail,
          action: "rejected",
          detail: { rejectionMotivation: motivation },
        });
        return true;
      }),
    catch: toDbErr("Failed to reject refund request"),
  }).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.succeed(undefined)
        : Effect.fail(
            new ConflictError({
              message: "Refund request status changed concurrently — retry",
            }),
          ),
    ),
  );
}

export function rejectRequest(
  requestId: string,
  scope: EntityScope | null,
  actorUserId: string,
  actorEmail: string,
  motivation: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> {
  return ensureInScopeSubmittedRequest(requestId, scope).pipe(
    Effect.flatMap(() =>
      rejectTransaction(requestId, actorUserId, actorEmail, motivation),
    ),
  );
}
