/**
 * Prisma data-access layer for expense lines (T8, specs/007-refund-service;
 * + specs/009-mileage-rate travel_km write derivation, T5).
 *
 * Every mutation is draft-only (409 otherwise) and ownership-scoped (404
 * otherwise) — see `ensureOwnedDraftRequest` below, shared by create/update/
 * delete. Each mutation also "touches" the parent request's `updatedAt`
 * (inside the same transaction) so `GET /requests` list ordering reflects
 * recent line edits, not just request-level changes.
 *
 * specs/009-mileage-rate (AC-1.6, Security A04): for a `travel_km` line,
 * `currency` and `requestedAmountCents` are ALWAYS server-derived —
 * `resolveLineWriteData` looks up the effective rate for (entity, date)
 * BEFORE the write transaction opens (a plain read of the append-only
 * `mileage_rate` table; no lock/consistency concern), computes the amount
 * via the canonical `computeMileageAmountCents` (Decision 3), and forces
 * `currency` from `ENTITY_CURRENCY[entity]`. Any client-sent
 * `currency`/`requestedAmountCents` on a travel_km line is silently ignored,
 * never honored. When no rate is in effect (AC-2.2), the line is still
 * created/updated (submission is what refuses it, T6) — `requestedAmountCents`
 * is written as `0`, a denormalized placeholder the NEXT read
 * (mileageHydration.ts) or submit (lifecycle.repo.ts) always re-resolves
 * fresh; it is never treated as authoritative.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { ConflictError, DatabaseError, NotFoundError } from "../lib/errors";
import { ENTITY_CURRENCY, type CurrencyValue, type EntityValue } from "./requests.schemas";
import { fetchEffectiveRate } from "../rates/repo";
import { computeMileageAmountCents } from "../rates/computeMileageAmountCents";
import type { LineBody } from "./lines.schemas";
import type { LineRow } from "./requests.service";

// Exported so decide.repo.ts (T12) can re-fetch a full LineRow-shaped line
// after PUT approved-total, without duplicating this stored-only attachment
// filter shape.
export const lineInclude = {
  attachments: {
    where: { uploadStatus: "stored" as const },
    orderBy: { createdAt: "asc" as const },
  },
};

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

interface LineWriteData {
  readonly date: Date;
  readonly type: string;
  readonly motivo: string;
  readonly entity: string;
  readonly currency: CurrencyValue;
  readonly requestedAmountCents: number;
  readonly km: number | null;
  // The live rate just resolved (travel_km only) — `null` for every
  // non-travel_km line. Attached to the response afterward
  // (lines.routes.ts) so mapLine's draft branch never needs a SECOND rate
  // lookup for the very rate it just used to compute the amount above.
  // Always present (never `undefined`) so the `{ ...line, liveRate }` spread
  // at each call site below never runs afoul of `exactOptionalPropertyTypes`.
  readonly liveRate: { readonly ratePerKmMicros: number; readonly validFrom: string } | null;
}

/**
 * Resolves the final, server-authoritative field values for a line write —
 * pure passthrough for non-travel_km types (007 behavior, unchanged); for
 * travel_km, resolves the effective rate for (entity, date) and computes
 * the amount (specs/009-mileage-rate, AC-1.6).
 */
function resolveLineWriteData(body: LineBody): Effect.Effect<LineWriteData, DatabaseError> {
  const date = new Date(`${body.date}T00:00:00.000Z`);

  if (body.type !== "travel_km") {
    return Effect.succeed({
      date,
      type: body.type,
      motivo: body.motivo,
      entity: body.entity,
      // Guaranteed present by LineBodySchema's superRefine for every
      // non-travel_km type.
      currency: body.currency as CurrencyValue,
      requestedAmountCents: body.requestedAmountCents as number,
      km: body.km ?? null,
      liveRate: null,
    });
  }

  const km = body.km as number; // guaranteed > 0 by LineBodySchema for travel_km
  const currency = ENTITY_CURRENCY[body.entity as EntityValue];

  return fetchEffectiveRate(body.entity, body.date).pipe(
    Effect.map((rate) => ({
      date,
      type: body.type,
      motivo: body.motivo,
      entity: body.entity,
      currency,
      requestedAmountCents: rate ? computeMileageAmountCents(km, rate.ratePerKmMicros) : 0,
      km,
      liveRate: rate
        ? { ratePerKmMicros: rate.ratePerKmMicros, validFrom: rate.validFrom }
        : null,
    })),
  );
}

/**
 * Shared draft-only ownership guard (AC-1.4/2.3/2.5). Resolves to `void` on
 * success; fails `NotFoundError` (not found / not owned) or `ConflictError`
 * (status !== draft) — callers map these to 404/409 respectively.
 */
export function ensureOwnedDraftRequest(
  requestId: string,
  ownerUserId: string,
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
      (row): Effect.Effect<void, NotFoundError | ConflictError> => {
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
              message: "Lines can only be modified while the request is a draft",
            }),
          );
        }
        return Effect.succeed(undefined);
      },
    ),
  );
}

// ─── Create ──────────────────────────────────────────────────────────────────

export function createLine(
  requestId: string,
  ownerUserId: string,
  body: LineBody,
): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> {
  return ensureOwnedDraftRequest(requestId, ownerUserId).pipe(
    Effect.flatMap(() => resolveLineWriteData(body)),
    Effect.flatMap((writeData) =>
      Effect.tryPromise({
        try: () =>
          db.$transaction(async (tx) => {
            const { count } = await tx.refundRequest.updateMany({
              where: { id: requestId, ownerUserId, status: "draft" },
              data: { updatedAt: new Date() },
            });
            if (count === 0) return null;
            const { liveRate: _liveRate, ...data } = writeData;
            return tx.refundLine.create({
              data: { requestId, ...data } as never,
              include: lineInclude,
            });
          }),
        catch: toDbErr("Failed to create refund line"),
      }).pipe(
        Effect.flatMap((line) =>
          line
            ? Effect.succeed({ ...line, liveRate: writeData.liveRate })
            : Effect.fail(
                new ConflictError({
                  message: "Refund request status changed concurrently — retry",
                }),
              ),
        ),
      ),
    ),
  );
}

// ─── Update (PUT — same shape as POST, commits the whole line object) ──────

export function updateLine(
  requestId: string,
  lineId: string,
  ownerUserId: string,
  body: LineBody,
): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> {
  return ensureOwnedDraftRequest(requestId, ownerUserId).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () =>
          db.refundLine.findFirst({
            where: { id: lineId, requestId },
            select: { id: true },
          }),
        catch: toDbErr("Failed to look up refund line"),
      }),
    ),
    Effect.flatMap(
      (
        existing,
      ): Effect.Effect<LineRow, DatabaseError | NotFoundError | ConflictError> => {
        if (!existing) {
          return Effect.fail(
            new NotFoundError({ message: `Refund line ${lineId} not found` }),
          );
        }
        return resolveLineWriteData(body).pipe(
          Effect.flatMap((writeData) =>
            Effect.tryPromise({
              try: () =>
                db.$transaction(async (tx) => {
                  const { count } = await tx.refundRequest.updateMany({
                    where: { id: requestId, ownerUserId, status: "draft" },
                    data: { updatedAt: new Date() },
                  });
                  if (count === 0) return null;
                  const { liveRate: _liveRate, ...data } = writeData;
                  const updated = await tx.refundLine.updateMany({
                    where: { id: lineId, requestId },
                    data: data as never,
                  });
                  if (updated.count === 0) return null;
                  return tx.refundLine.findUniqueOrThrow({
                    where: { id: lineId },
                    include: lineInclude,
                  });
                }),
              catch: toDbErr("Failed to update refund line"),
            }).pipe(
              Effect.flatMap((line) =>
                line
                  ? Effect.succeed({ ...line, liveRate: writeData.liveRate })
                  : Effect.fail(
                      new ConflictError({
                        message:
                          "Refund request status changed concurrently — retry",
                      }),
                    ),
              ),
            ),
          ),
        );
      },
    ),
  );
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export function deleteLine(
  requestId: string,
  lineId: string,
  ownerUserId: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> {
  return ensureOwnedDraftRequest(requestId, ownerUserId).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () =>
          db.refundLine.findFirst({
            where: { id: lineId, requestId },
            select: { id: true },
          }),
        catch: toDbErr("Failed to look up refund line"),
      }),
    ),
    Effect.flatMap(
      (existing): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> => {
        if (!existing) {
          return Effect.fail(
            new NotFoundError({ message: `Refund line ${lineId} not found` }),
          );
        }
        return Effect.tryPromise({
          try: () =>
            db.$transaction(async (tx) => {
              const { count } = await tx.refundRequest.updateMany({
                where: { id: requestId, ownerUserId, status: "draft" },
                data: { updatedAt: new Date() },
              });
              if (count === 0) return false;
              const deleted = await tx.refundLine.deleteMany({
                where: { id: lineId, requestId },
              });
              return deleted.count > 0;
            }),
          catch: toDbErr("Failed to delete refund line"),
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
