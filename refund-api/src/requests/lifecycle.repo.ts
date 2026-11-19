/**
 * Submit / withdraw lifecycle transitions (T10, specs/20260716-refund-service,
 * AC-1.5/1.6/2.1/2.2/2.3, US-8/ADR 20260716-immutable-financial-audit-trail-refund; + specs/20260720-mileage-rate T6
 * submit-time mileage snapshot, AC-1.4, AC-2.2, AC-3.1, AC-3.2, Decision 1).
 *
 * Both transitions write an append-only audit row (`audit.ts`) inside the
 * SAME transaction as the status change (AC-8.1). Editing/deleting a
 * non-draft request or line is already refused by the draft-only guards
 * built in T7/T8 (`ensureOwnedDraftRequest`) — submit flips status away from
 * `draft`, which is sufficient to make those guards start refusing (AC-2.3),
 * no separate enforcement needed here.
 *
 * specs/20260720-mileage-rate (Decision 1 — "pinned at submit, never during
 * draft"): submit re-resolves each travel_km line's effective rate ONE MORE
 * TIME (never trusts whatever the draft happened to cache — Risk R5, "a rate
 * added between last draft save and submit") and, if every travel_km line
 * has a rate in effect AND `km > 0`, writes `requestedAmountCents` +
 * `appliedRateMicros`/`appliedRateValidFrom`/`appliedRateEntryId` for each
 * inside the SAME transaction as the status flip — this is the ONE and ONLY
 * write that ever freezes a mileage line. A line with no rate in effect
 * (AC-2.2) or `km <= 0` (AC-1.4) refuses the WHOLE submission with a 422
 * naming every offending line id (007's existing `ValidationError
 * { fields.offendingLineIds }` shape, extended to also carry the mileage
 * failure mode). Withdraw clears `appliedRate*` back to null on every
 * travel_km line in the SAME transaction as the status flip — the next
 * submit re-resolves and re-snapshots from scratch (AC-3.2).
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
import { writeAuditEntry, type LineClassifiedDetail } from "./audit";
import { entityDateKey, fetchEffectiveRatesForPairs } from "../rates/repo";
import { computeMileageAmountCents } from "../rates/computeMileageAmountCents";
import type { EntityValue } from "./requests.schemas";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

interface SubmitLineRow {
  readonly id: string;
  readonly motivo: string;
  readonly requestedAmountCents: number;
  readonly type: string;
  readonly km: number | null;
  readonly entity: string;
  readonly date: Date;
}

const isoDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** One travel_km line's resolved submit-time snapshot, keyed by line id. */
interface MileageSnapshot {
  readonly requestedAmountCents: number;
  readonly appliedRateMicros: number;
  readonly appliedRateValidFrom: string;
  readonly appliedRateEntryId: string;
}

/**
 * Re-resolves every travel_km line's effective rate at submit time
 * (Decision 1, Risk R5). Returns EITHER the offending line ids (no rate in
 * effect for that line's (entity, date) — AC-2.2) OR a snapshot map ready
 * to write inside the transaction. Batched — at most one query per distinct
 * entity (rates/repo.ts).
 */
function resolveMileageSnapshots(
  lines: readonly SubmitLineRow[],
): Effect.Effect<
  { readonly offendingLineIds: string[] } | { readonly snapshots: Map<string, MileageSnapshot> },
  DatabaseError
> {
  const mileageLines = lines.filter((l) => l.type === "travel_km");
  if (mileageLines.length === 0) {
    return Effect.succeed({ snapshots: new Map() });
  }

  const pairs = mileageLines.map((l) => ({
    entity: l.entity as EntityValue,
    date: isoDateOnly(l.date),
  }));

  return fetchEffectiveRatesForPairs(pairs).pipe(
    Effect.map((rateMap) => {
      const offendingLineIds: string[] = [];
      const snapshots = new Map<string, MileageSnapshot>();
      for (const line of mileageLines) {
        const key = entityDateKey(line.entity as EntityValue, isoDateOnly(line.date));
        const rate = rateMap.get(key) ?? null;
        if (!rate) {
          offendingLineIds.push(line.id);
          continue;
        }
        const km = line.km as number; // isLineComplete already guaranteed > 0
        snapshots.set(line.id, {
          requestedAmountCents: computeMileageAmountCents(km, rate.ratePerKmMicros),
          appliedRateMicros: rate.ratePerKmMicros,
          appliedRateValidFrom: rate.validFrom,
          appliedRateEntryId: rate.id,
        });
      }
      return offendingLineIds.length > 0 ? { offendingLineIds } : { snapshots };
    }),
  );
}

// ─── Submit (AC-1.5/1.6/2.1; + specs/20260720-mileage-rate AC-1.4/2.2/3.1) ──────

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
              entity: true,
              date: true,
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
        // AC-1.6/AC-1.4 (mileage) — defense-in-depth re-validation against
        // persisted rows (see lines.schemas.ts's isLineComplete doc comment:
        // unreachable via this service's own line endpoints, which already
        // enforce completeness at write time, but still checked here). This
        // already covers a travel_km line's `km <= 0` (AC-1.4).
        const lines = row.lines as SubmitLineRow[];
        const offendingLineIds = lines
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

        // specs/20260720-mileage-rate (AC-2.2, Decision 1) — every travel_km line
        // that IS complete (km > 0) must ALSO have a rate in effect right
        // now, or the whole submission is refused, naming the offending
        // line(s), the SAME 422 shape as the completeness check above.
        return resolveMileageSnapshots(lines).pipe(
          Effect.flatMap(
            (
              resolved,
            ): Effect.Effect<
              void,
              DatabaseError | ConflictError | ValidationError
            > => {
              if ("offendingLineIds" in resolved) {
                return Effect.fail(
                  new ValidationError({
                    message:
                      "One or more travel_km lines have no mileage rate configured for their date",
                    fields: { offendingLineIds: resolved.offendingLineIds },
                  }),
                );
              }
              return submitTransaction(
                requestId,
                ownerUserId,
                actorEmail,
                resolved.snapshots,
              );
            },
          ),
        );
      },
    ),
  );
}

function submitTransaction(
  requestId: string,
  ownerUserId: string,
  actorEmail: string,
  mileageSnapshots: ReadonlyMap<string, MileageSnapshot>,
): Effect.Effect<void, DatabaseError | ConflictError> {
  return Effect.tryPromise({
    try: () =>
      db.$transaction(async (tx) => {
        const { count } = await tx.refundRequest.updateMany({
          where: { id: requestId, ownerUserId, status: "draft" },
          data: { status: "submitted", submittedAt: new Date() },
        });
        if (count === 0) return false;

        // The ONE and ONLY write that ever freezes a travel_km line
        // (Decision 1) — inside the SAME transaction as the status flip.
        for (const [lineId, snapshot] of mileageSnapshots) {
          await tx.refundLine.update({
            where: { id: lineId },
            data: {
              requestedAmountCents: snapshot.requestedAmountCents,
              appliedRateMicros: snapshot.appliedRateMicros,
              appliedRateValidFrom: new Date(`${snapshot.appliedRateValidFrom}T00:00:00.000Z`),
              appliedRateEntryId: snapshot.appliedRateEntryId,
            },
          });
        }

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
              // specs/20260720-mileage-rate (Decision 1, AC-3.2) — withdraw
              // clears the frozen snapshot on every travel_km line of this
              // request, in the SAME transaction as the status flip. The
              // line returns to LIVE mode (mileageHydration.ts recomputes on
              // next read); the next submit re-resolves and re-snapshots
              // from scratch. Non-travel_km lines are untouched (their
              // appliedRate* columns are already always null).
              await tx.refundLine.updateMany({
                where: { requestId, type: "travel_km" },
                data: {
                  appliedRateMicros: null,
                  appliedRateValidFrom: null,
                  appliedRateEntryId: null,
                },
              });
              // specs/20260716-refund-service amendment (2026-11-10) — a line rejected during a
              // review that never concluded does not survive withdraw-to-
              // draft: the employee may now edit the line, and the next
              // submit starts a fresh review. Its approved figure (0) is
              // cleared with it, so no stale zero lingers.
              await tx.refundLine.updateMany({
                where: { requestId, rejectionReason: { not: null } },
                data: {
                  rejectionReason: null,
                  rejectedAt: null,
                  rejectedByUserId: null,
                  rejectedByEmail: null,
                  approvedTotalCents: null,
                },
              });
              // specs/20261118-refund-accounting-export (T14, plan D12), specs/20261119-accounting (A3 point 7, D34) —
              // accounting's hand-made COPIES do not survive withdraw-to-draft either: the employee may now change the
              // line's expense type, and an account picked for the old type would silently stay on the new one. The line
              // goes back to following the live defaults; one `line_classified` row per cleared line (cause `withdrawn`,
              // detail v2) keeps what was set. Nothing is numbered before approval, so the receipt columns are untouched
              // and the database guard has nothing to refuse; and a line under review never holds an exchange-rate copy
              // (that is written at approval or at the first export), which is why the fx columns are not in this clear.
              const overridden = await tx.refundLine.findMany({
                where: { requestId, OR: [{ accountNumber: { not: null } }, { vatCodeCopy: { not: null } }] },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: {
                  id: true,
                  accountNumber: true,
                  accountName: true,
                  ledgerAccountIsDefault: true,
                  vatCodeCopy: true,
                  vatRateBasisPoints: true,
                  vatCodeIsDefault: true,
                },
              });
              if (overridden.length > 0) {
                await tx.refundLine.updateMany({
                  where: { id: { in: overridden.map((l) => l.id) } },
                  data: {
                    accountNumber: null,
                    accountName: null,
                    ledgerAccountIsDefault: null,
                    vatCodeCopy: null,
                    vatRateBasisPoints: null,
                    vatCodeIsDefault: null,
                  },
                });
                for (const line of overridden) {
                  const detail: LineClassifiedDetail = {
                    v: 2,
                    cause: "withdrawn",
                    account: {
                      from:
                        line.accountNumber !== null && line.accountName !== null
                          ? { number: line.accountNumber, name: line.accountName }
                          : null,
                      to: null,
                      fromDefault: line.accountNumber === null ? true : line.ledgerAccountIsDefault === true,
                      toDefault: true,
                    },
                    vatCode: {
                      from:
                        line.vatCodeCopy !== null && line.vatRateBasisPoints !== null
                          ? { code: line.vatCodeCopy, rateBasisPoints: line.vatRateBasisPoints }
                          : null,
                      to: null,
                      fromDefault: line.vatCodeCopy === null ? true : line.vatCodeIsDefault === true,
                      toDefault: true,
                    },
                  };
                  await writeAuditEntry(tx, {
                    requestId,
                    lineId: line.id,
                    actorUserId: ownerUserId,
                    actorEmail,
                    action: "line_classified",
                    detail: detail as unknown as Record<string, unknown>,
                  });
                }
              }
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
