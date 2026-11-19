/**
 * Prisma data-access layer for accounting decisions (T12,
 * specs/20260716-refund-service, AC-7.1-7.6, US-8/ADR 20260716-immutable-financial-audit-trail-refund).
 *
 * `ensureInScopeSubmittedRequest` is the shared gate for every decision
 * mutation (PUT approved-total, POST approve, POST reject) — it evaluates
 * ADR 20260716-entity-scoped-abac-refund-api's "at least one line matches" predicate (`requestInScope`,
 * SAME function T6/T11 use) BEFORE the status check, so an out-of-scope
 * caller always gets 404 regardless of the request's status (never a 409,
 * which would leak state to someone who shouldn't even see the request
 * exists — ADR 20260703-jwt-resource-server-remote-jwks/0015 posture). `scope === null` (T11's fail-closed
 * data-integrity edge case) always denies, matching zero lines.
 *
 * Every mutation writes an append-only audit row (audit.ts, AC-8.1) inside
 * the SAME transaction as the state change it records.
 *
 * specs/20261118-refund-accounting-export (T12): `approveTransaction` is also
 * where a line's accounting is settled. In the one transaction it (1) refuses
 * the approval until the release marker exists (409 `accounting_release_pending`,
 * plan D6), (2) does the CAS and the existing defaulting, (3) calls
 * `classifyAndNumber(cause: "approval")`, which resolves every non-rejected
 * WellD CH line, freezes it, and numbers every non-rejected line of either
 * entity. A line without an account or VAT code rolls the whole transaction
 * back (409 `classification_missing`), so a refused approval changes nothing
 * and consumes no number (AC-3.4, AC-4.3).
 */

import { Data, Effect } from "effect";
import { loadDefaultsSnapshotFk } from "../accounting/legacyFk";
import { classifyAndNumber } from "../accounting/numbering.repo";
import { isAccountingReleased } from "../accounting/release";
import type { MissingPartFk } from "../accounting/legacyFk";
import type { ExpenseType } from "../lib/generated/prisma/enums";
import { db } from "../lib/db";
import { ownershipOwn, requestInScope, type EntityScope } from "../authz/conditions";
import {
  ConflictError,
  DatabaseError,
  NotFoundError,
  SelfApprovalDeniedError,
} from "../lib/errors";
import type { Prisma } from "../lib/generated/prisma/client";
import { lineInclude } from "../requests/lines.repo";
import { writeAuditEntry } from "../requests/audit";
import type { LineRow } from "../requests/requests.service";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

interface ScopeCheckLine {
  readonly id: string;
  readonly entity: string;
  readonly rejectionReason: string | null;
}
interface ScopeCheckRow {
  readonly status: string;
  // specs/20260721-self-approval-control, ADR 20260721-self-approval-condition-and-403-exception — a harmless extra column on
  // the shared scope-check select (plan.md D2); only `approveRequest`'s own
  // self-approval branch below reads it, `ensureInScopeSubmittedRequest`
  // (shared by set-approved-total/reject) never does.
  readonly ownerUserId: string;
  readonly lines: readonly ScopeCheckLine[];
}

function fetchScopeCheckRow(
  requestId: string,
): Effect.Effect<ScopeCheckRow | null, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundRequest.findUnique({
        where: { id: requestId },
        select: {
          status: true,
          ownerUserId: true,
          lines: { select: { id: true, entity: true, rejectionReason: true } },
        },
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
        const line = row.lines.find((l) => l.id === lineId);
        if (!line) {
          return Effect.fail(
            new NotFoundError({ message: `Refund line ${lineId} not found` }),
          );
        }
        // A rejected line's approved figure is 0 by definition — changing it
        // would silently half-undo the rejection. Restore the line first.
        if (line.rejectionReason !== null) {
          return Effect.fail(
            new ConflictError({
              message: "This line is rejected — restore it before changing its approved total",
              code: "line_rejected",
            }),
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

// ─── POST .../approve (AC-7.2; specs/20261118-refund-accounting-export T12) ──

/**
 * 409 `classification_missing` (AC-3.4): at least one non-rejected WellD CH
 * line has no account or no VAT code once resolved. The approval was rolled
 * back, so nothing changed and no number was consumed. `lines` is what the
 * review page needs to point at each value: id, date and type are always
 * present (plan § API contracts).
 */
export class ClassificationMissingError extends Data.TaggedError("ClassificationMissingError")<{
  readonly message: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly date: string;
    readonly type: ExpenseType;
    readonly missing: readonly MissingPartFk[];
  }[];
}> {}

/** Thrown inside the approve transaction to roll it back with a typed refusal. */
class ApprovalRefused extends Error {
  constructor(readonly refusal: ConflictError | ClassificationMissingError) {
    super(refusal.message);
  }
}

function approveTransaction(
  requestId: string,
  actorUserId: string,
  actorEmail: string,
  actorName?: string,
): Effect.Effect<void, DatabaseError | ConflictError | ClassificationMissingError> {
  return Effect.tryPromise({
    try: () =>
      db.$transaction(async (tx) => {
        // D6: nothing is numbered before the release script has numbered the
        // legacy lines (by expense date) and loaded any offsets. Read inside the
        // transaction, before anything is written; the marker only ever appears.
        if (!(await isAccountingReleased(tx))) {
          throw new ApprovalRefused(
            new ConflictError({
              message: "Accounting has not been released yet: approvals are refused until the release script has run",
              code: "accounting_release_pending",
            }),
          );
        }

        // The CAS locks the request row for the rest of the transaction.
        const { count } = await tx.refundRequest.updateMany({
          where: { id: requestId, status: "submitted" },
          data: {
            status: "approved",
            decidedAt: new Date(),
            decidedByUserId: actorUserId,
            decidedByEmail: actorEmail,
            decidedByName: actorName ?? null,
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

        // Freeze the classification and issue the receipt numbers, in this
        // transaction (AC-3.5, AC-4.1 to AC-4.5, AC-4.10). A WellD CH line that
        // cannot be resolved refuses everything: the throw below rolls back the
        // CAS above, the defaulted totals, the counters and the audit rows.
        const owner = await tx.refundRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { ownerUserId: true, ownerEmail: true, ownerName: true },
        });
        const numbered = await classifyAndNumber(tx, {
          owner: { userId: owner.ownerUserId, name: owner.ownerName, email: owner.ownerEmail },
          requestIds: [requestId],
          cause: "approval",
          actor: { userId: actorUserId, email: actorEmail },
          snapshot: await loadDefaultsSnapshotFk(tx),
        });
        if (!numbered.ok) {
          throw new ApprovalRefused(
            new ClassificationMissingError({
              message: "Some lines have no ledger account or VAT code: classify them before approving",
              lines: numbered.missing.map((m) => ({
                lineId: m.lineId,
                date: m.date,
                type: m.type,
                missing: m.missing,
              })),
            }),
          );
        }
        return true;
      }),
    catch: (cause) =>
      cause instanceof ApprovalRefused ? cause.refusal : toDbErr("Failed to approve refund request")(cause),
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

/**
 * specs/20260721-self-approval-control, ADR 20260721-self-approval-condition-and-403-exception — approve gains a dedicated
 * ownership check the SHARED `ensureInScopeSubmittedRequest` gate deliberately
 * does NOT carry (US-4: the restriction is approve-only; putting it in the
 * shared gate would bleed into reject/set-approved-total). Fetches the row
 * itself (reusing `fetchScopeCheckRow`, now selecting `ownerUserId`) so the
 * self-approval branch can run BEFORE the entity-scope 404 and the status
 * 409 (plan.md D2 ordering: capability 403 → self-approval 403 → entity 404
 * → status 409 → approve) — AC-2.4 requires the ownership denial to win
 * regardless of entity match, and the caller provably owns the record (they
 * created it), so a 403 here leaks nothing a 404 would otherwise protect.
 */
export function approveRequest(
  requestId: string,
  scope: EntityScope | null,
  actorUserId: string,
  actorEmail: string,
  selfApprovalRestricted: boolean,
  actorName?: string,
): Effect.Effect<
  void,
  DatabaseError | NotFoundError | ConflictError | SelfApprovalDeniedError | ClassificationMissingError
> {
  return fetchScopeCheckRow(requestId).pipe(
    Effect.flatMap(
      (
        row,
      ): Effect.Effect<
        ScopeCheckRow,
        NotFoundError | ConflictError | SelfApprovalDeniedError
      > => {
        // Guarded by `row &&` — a genuinely non-existent request must still
        // fall through to the ordinary 404 below, never a self-approval 403
        // (no ownerUserId to compare against).
        if (row && selfApprovalRestricted && ownershipOwn(row, actorUserId)) {
          return Effect.fail(
            new SelfApprovalDeniedError({
              message: `Caller ${actorUserId} cannot approve refund request ${requestId} — they are its owner`,
            }),
          );
        }
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
        // specs/20260716-refund-service amendment (2026-11-10) — approving a request whose every
        // line was rejected would put a zero payout into the monthly batch;
        // that request is a rejection and must be decided as one.
        if (row.lines.length > 0 && row.lines.every((l) => l.rejectionReason !== null)) {
          return Effect.fail(
            new ConflictError({
              message: "Every line of this request is rejected — reject the request instead",
              code: "all_lines_rejected",
            }),
          );
        }
        return Effect.succeed(row);
      },
    ),
    Effect.flatMap(() => approveTransaction(requestId, actorUserId, actorEmail, actorName)),
  );
}

// ─── POST .../reject (AC-7.3) ────────────────────────────────────────────────

function rejectTransaction(
  requestId: string,
  actorUserId: string,
  actorEmail: string,
  motivation: string,
  actorName?: string,
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
            decidedByName: actorName ?? null,
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
  actorName?: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> {
  return ensureInScopeSubmittedRequest(requestId, scope).pipe(
    Effect.flatMap(() =>
      rejectTransaction(requestId, actorUserId, actorEmail, motivation, actorName),
    ),
  );
}

// ─── POST/DELETE .../lines/:lineId/reject (specs/20260716-refund-service amendment, 2026-11-10) ──
//
// A reviewer refuses ONE line, with a mandatory reason, instead of the whole
// request. Same gate as every other decision mutation (entity scope → 404,
// not submitted → 409), same re-asserted `status = submitted` inside the
// transaction, same append-only audit row. The rejection sets the line's
// approved total to 0, so approve, subtotals, the batch PDF and the export
// pay nothing for it without knowing about rejection at all. Reversible
// while the request is still `submitted` (restore), frozen once decided.

function lineRejectionMutation(
  requestId: string,
  lineId: string,
  scope: EntityScope | null,
  expectRejected: boolean,
  write: (
    tx: Prisma.TransactionClient,
    prior: { approvedTotalCents: number | null; rejectionReason: string | null },
  ) => Promise<void>,
  failure: string,
): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> {
  return ensureInScopeSubmittedRequest(requestId, scope).pipe(
    Effect.flatMap(
      (row): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> => {
        const line = row.lines.find((l) => l.id === lineId);
        if (!line) {
          return Effect.fail(
            new NotFoundError({ message: `Refund line ${lineId} not found` }),
          );
        }
        if ((line.rejectionReason !== null) !== expectRejected) {
          return Effect.fail(
            new ConflictError({
              message: expectRejected
                ? "This line is not rejected"
                : "This line is already rejected",
              code: expectRejected ? "line_not_rejected" : "line_rejected",
            }),
          );
        }
        return Effect.tryPromise({
          try: () =>
            db.$transaction(async (tx) => {
              const { count } = await tx.refundRequest.updateMany({
                where: { id: requestId, status: "submitted" },
                data: { updatedAt: new Date() },
              });
              if (count === 0) return null;
              const prior = await tx.refundLine.findFirst({
                where: { id: lineId, requestId },
                select: { approvedTotalCents: true, rejectionReason: true },
              });
              if (!prior || (prior.rejectionReason !== null) !== expectRejected) return null;
              await write(tx, prior);
              return tx.refundLine.findUniqueOrThrow({
                where: { id: lineId },
                include: lineInclude,
              });
            }),
          catch: toDbErr(failure),
        }).pipe(
          Effect.flatMap((updated) =>
            updated
              ? Effect.succeed(updated)
              : Effect.fail(
                  new ConflictError({
                    message: "Refund request changed concurrently — retry",
                  }),
                ),
          ),
        );
      },
    ),
  );
}

export function rejectLine(
  requestId: string,
  lineId: string,
  reason: string,
  scope: EntityScope | null,
  actorUserId: string,
  actorEmail: string,
): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> {
  return lineRejectionMutation(
    requestId,
    lineId,
    scope,
    false,
    async (tx, prior) => {
      await tx.refundLine.update({
        where: { id: lineId },
        data: {
          rejectionReason: reason,
          rejectedAt: new Date(),
          rejectedByUserId: actorUserId,
          rejectedByEmail: actorEmail,
          approvedTotalCents: 0,
        },
      });
      await writeAuditEntry(tx, {
        requestId,
        lineId,
        actorUserId,
        actorEmail,
        action: "line_rejected",
        detail: { reason, fromCents: prior.approvedTotalCents },
      });
    },
    "Failed to reject the refund line",
  );
}

export function restoreLine(
  requestId: string,
  lineId: string,
  scope: EntityScope | null,
  actorUserId: string,
  actorEmail: string,
): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> {
  return lineRejectionMutation(
    requestId,
    lineId,
    scope,
    true,
    async (tx, prior) => {
      // Back to "untouched": approve will default it to the requested amount,
      // and the reviewer may set a different figure as for any other line.
      await tx.refundLine.update({
        where: { id: lineId },
        data: {
          rejectionReason: null,
          rejectedAt: null,
          rejectedByUserId: null,
          rejectedByEmail: null,
          approvedTotalCents: null,
        },
      });
      await writeAuditEntry(tx, {
        requestId,
        lineId,
        actorUserId,
        actorEmail,
        action: "line_restored",
        detail: { reason: prior.rejectionReason },
      });
    },
    "Failed to restore the refund line",
  );
}
