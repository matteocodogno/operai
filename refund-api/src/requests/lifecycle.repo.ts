/**
 * Submit / withdraw lifecycle transitions (T10, specs/007-refund-service,
 * AC-1.5/1.6/2.1/2.2/2.3, US-8/ADR-0018).
 *
 * Both transitions write an append-only audit row (`audit.ts`) inside the
 * SAME transaction as the status change (AC-8.1). Editing/deleting a
 * non-draft request or line is already refused by the draft-only guards
 * built in T7/T8 (`ensureOwnedDraftRequest`) — submit flips status away from
 * `draft`, which is sufficient to make those guards start refusing (AC-2.3),
 * no separate enforcement needed here.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import {
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
} from "../lib/errors";
import { isLineComplete } from "./lines.schemas";
import { writeAuditEntry } from "./audit";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

interface SubmitLineRow {
  readonly id: string;
  readonly motivo: string;
  readonly requestedAmountCents: number;
  readonly type: string;
  readonly km: number | null;
}

// ─── Submit (AC-1.5/1.6/2.1) ────────────────────────────────────────────────

export function submitRequest(
  requestId: string,
  ownerUserId: string,
  actorEmail: string,
): Effect.Effect<
  void,
  DatabaseError | NotFoundError | ConflictError | ValidationError
> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findFirst({
        where: { id: requestId, ownerUserId },
        select: {
          status: true,
          lines: {
            select: {
              id: true,
              motivo: true,
              requestedAmountCents: true,
              type: true,
              km: true,
            },
          },
        },
      }),
    catch: toDbErr("Failed to look up refund request"),
  }).pipe(
    Effect.flatMap(
      (
        row,
      ): Effect.Effect<
        void,
        DatabaseError | NotFoundError | ConflictError | ValidationError
      > => {
        if (!row) {
          return Effect.fail(
            new NotFoundError({
              message: `Refund request ${requestId} not found`,
            }),
          );
        }
        if (row.status !== "draft") {
          return Effect.fail(
            new ConflictError({
              message: "Only a draft request can be submitted",
            }),
          );
        }
        // AC-1.5 — zero lines refused with a clear message.
        if (row.lines.length === 0) {
          return Effect.fail(
            new ValidationError({
              message:
                "At least one expense line is required to submit a request",
            }),
          );
        }
        // AC-1.6 — defense-in-depth re-validation against persisted rows
        // (see lines.schemas.ts's isLineComplete doc comment: unreachable
        // via this service's own line endpoints, which already enforce
        // completeness at write time, but still checked here).
        const offendingLineIds = (row.lines as SubmitLineRow[])
          .filter((line) => !isLineComplete(line))
          .map((line) => line.id);
        if (offendingLineIds.length > 0) {
          return Effect.fail(
            new ValidationError({
              message:
                "One or more expense lines are incomplete for their type",
              fields: { offendingLineIds },
            }),
          );
        }
        return submitTransaction(requestId, ownerUserId, actorEmail);
      },
    ),
  );
}

function submitTransaction(
  requestId: string,
  ownerUserId: string,
  actorEmail: string,
): Effect.Effect<void, DatabaseError | ConflictError> {
  return Effect.tryPromise({
    try: () =>
      db.$transaction(async (tx) => {
        const { count } = await tx.refundRequest.updateMany({
          where: { id: requestId, ownerUserId, status: "draft" },
          data: { status: "submitted", submittedAt: new Date() },
        });
        if (count === 0) return false;
        await writeAuditEntry(tx, {
          requestId,
          actorUserId: ownerUserId,
          actorEmail,
          action: "submitted",
        });
        return true;
      }),
    catch: toDbErr("Failed to submit refund request"),
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

// ─── Withdraw (AC-2.2) ───────────────────────────────────────────────────────

export function withdrawRequest(
  requestId: string,
  ownerUserId: string,
  actorEmail: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findFirst({
        where: { id: requestId, ownerUserId },
        select: { status: true },
      }),
    catch: toDbErr("Failed to look up refund request"),
  }).pipe(
    Effect.flatMap(
      (row): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> => {
        if (!row) {
          return Effect.fail(
            new NotFoundError({
              message: `Refund request ${requestId} not found`,
            }),
          );
        }
        if (row.status !== "submitted") {
          return Effect.fail(
            new ConflictError({
              message: "Only a submitted request can be withdrawn",
            }),
          );
        }
        return Effect.tryPromise({
          try: () =>
            db.$transaction(async (tx) => {
              const { count } = await tx.refundRequest.updateMany({
                where: { id: requestId, ownerUserId, status: "submitted" },
                data: { status: "draft" },
              });
              if (count === 0) return false;
              await writeAuditEntry(tx, {
                requestId,
                actorUserId: ownerUserId,
                actorEmail,
                action: "withdrawn",
              });
              return true;
            }),
          catch: toDbErr("Failed to withdraw refund request"),
        }).pipe(
          Effect.flatMap((ok) =>
            ok
              ? Effect.succeed(undefined)
              : Effect.fail(
                  new ConflictError({
                    message:
                      "Refund request status changed concurrently — retry",
                  }),
                ),
          ),
        );
      },
    ),
  );
}
