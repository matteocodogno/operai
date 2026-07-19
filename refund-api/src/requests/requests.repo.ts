/**
 * Prisma data-access layer for RefundRequest (T7, specs/007-refund-service).
 *
 * SECURITY: `ownerUserId` is always taken from the caller's verified JWT
 * `sub` (never the request body — ADR-0005 pattern). Only `stored`
 * attachments are ever included (ADR-0016 reconcile-on-read posture — a
 * `pending` attachment whose upload never completed is invisible).
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { ConflictError, DatabaseError, NotFoundError } from "../lib/errors";
import type { RequestRow } from "./requests.service";

// ─── Shared include shapes ──────────────────────────────────────────────────

const linesWithStoredAttachments = {
  orderBy: { createdAt: "asc" as const },
  include: {
    attachments: {
      where: { uploadStatus: "stored" as const },
      orderBy: { createdAt: "asc" as const },
    },
  },
};

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

// ─── Create ──────────────────────────────────────────────────────────────────

export function createDraftRequest(
  ownerUserId: string,
  ownerEmail: string,
  ownerName: string | null,
): Effect.Effect<RequestRow, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.create({
        data: { ownerUserId, ownerEmail, ownerName },
        include: { lines: linesWithStoredAttachments },
      }),
    catch: toDbErr("Failed to create refund request"),
  });
}

// ─── List (own only, AC-3.1) ────────────────────────────────────────────────

export function listOwnRequests(
  ownerUserId: string,
): Effect.Effect<RequestRow[], DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findMany({
        where: { ownerUserId },
        orderBy: { updatedAt: "desc" },
        include: {
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
    catch: toDbErr("Failed to list refund requests"),
  });
}

// ─── Get by id (owner OR in-scope accounting — access checked by the caller) ──

export function findRequestWithLines(
  id: string,
): Effect.Effect<RequestRow | null, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findUnique({
        where: { id },
        include: {
          lines: linesWithStoredAttachments,
          // AC-5.2 (specs/008-refund-monthly-processing): the claimed
          // batch's paid provenance, surfaced as paidAt/paidBy on the
          // response (requests.service.ts mapRequestDetail) — null for a
          // request never claimed by a batch, or one claimed by a batch not
          // yet marked paid.
          batch: { select: { paidAt: true, paidByEmail: true } },
        },
      }),
    catch: toDbErr("Failed to fetch refund request"),
  });
}

// ─── Delete (draft-only, AC-1.4/2.3) ────────────────────────────────────────
//
// Two-step: a pre-check read shapes the 404-vs-409 response, then an atomic
// deleteMany re-asserts (id, ownerUserId, status: draft) so the delete itself
// is race-safe. If the pre-check said "draft" but the atomic delete affects
// zero rows, the status changed concurrently between the two steps — surfaced
// as 409 (never a false 404, since existence+ownership were already
// confirmed).
//
// NOTE (drift candidate — see final report): a request that was `submitted`
// then withdrawn back to `draft` already has `submitted`/`withdrawn` audit
// rows (AC-2.2/8.1). `RefundAuditEntry.request` is `onDelete: Restrict`
// (ADR-0018) — a currently-`draft` request with prior audit history will pass
// the application-level status guard here but still be refused by the
// database's foreign-key constraint (Postgres P2003). That FK violation is
// caught below and mapped to 409, not a 500 — but it means AC-1.4's "a draft
// is entirely disposable working state" does not literally hold for a
// withdrawn-then-draft request, only for one that was NEVER submitted. This
// reads as consistent with ADR-0018's own broader framing ("any request that
// ever transitioned past draft... becomes physically undeletable"), but spec
// AC-1.4/AC-2.2 don't call out the exception explicitly — surfaced as a drift
// candidate for the architect to reconcile (update AC-1.4's wording, or
// relax the FK) rather than silently special-cased here.
const attemptDeleteMany = (
  id: string,
  ownerUserId: string,
): Effect.Effect<void, DatabaseError | ConflictError> =>
  Effect.tryPromise({
    try: () =>
      db.refundRequest.deleteMany({
        where: { id, ownerUserId, status: "draft" },
      }),
    catch: (cause: unknown) => {
      // P2003 = FK violation (ADR-0018 onDelete: Restrict) — a draft with
      // prior audit history (submitted-then-withdrawn). Not a crash.
      const isFkViolation =
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        (cause as { code?: unknown }).code === "P2003";
      if (isFkViolation) {
        return new ConflictError({
          message:
            "This request has prior submission history and cannot be deleted",
          cause,
        });
      }
      return new DatabaseError({
        message: "Failed to delete refund request",
        cause,
      });
    },
  }).pipe(
    Effect.flatMap(({ count }) =>
      count > 0
        ? Effect.succeed(undefined)
        : Effect.fail(
            new ConflictError({
              message: "Refund request status changed concurrently — retry",
            }),
          ),
    ),
  );

export function deleteDraftRequest(
  id: string,
  ownerUserId: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findFirst({
        where: { id, ownerUserId },
        select: { status: true },
      }),
    catch: toDbErr("Failed to look up refund request"),
  }).pipe(
    Effect.flatMap(
      (
        row,
      ): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> => {
        if (!row) {
          return Effect.fail(
            new NotFoundError({ message: `Refund request ${id} not found` }),
          );
        }
        if (row.status !== "draft") {
          return Effect.fail(
            new ConflictError({
              message: "Only a draft refund request can be deleted",
            }),
          );
        }
        return attemptDeleteMany(id, ownerUserId);
      },
    ),
  );
}
