/**
 * Prisma data-access layer for expense lines (T8, specs/007-refund-service).
 *
 * Every mutation is draft-only (409 otherwise) and ownership-scoped (404
 * otherwise) — see `ensureOwnedDraftRequest` below, shared by create/update/
 * delete. Each mutation also "touches" the parent request's `updatedAt`
 * (inside the same transaction) so `GET /requests` list ordering reflects
 * recent line edits, not just request-level changes.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { ConflictError, DatabaseError, NotFoundError } from "../lib/errors";
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

const toLineData = (body: LineBody) => ({
  date: new Date(`${body.date}T00:00:00.000Z`),
  type: body.type as never,
  motivo: body.motivo,
  entity: body.entity as never,
  requestedAmountCents: body.requestedAmountCents,
  km: body.km ?? null,
});

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
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () =>
          db.$transaction(async (tx) => {
            const { count } = await tx.refundRequest.updateMany({
              where: { id: requestId, ownerUserId, status: "draft" },
              data: { updatedAt: new Date() },
            });
            if (count === 0) return null;
            return tx.refundLine.create({
              data: { requestId, ...toLineData(body) },
              include: lineInclude,
            });
          }),
        catch: toDbErr("Failed to create refund line"),
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
        return Effect.tryPromise({
          try: () =>
            db.$transaction(async (tx) => {
              const { count } = await tx.refundRequest.updateMany({
                where: { id: requestId, ownerUserId, status: "draft" },
                data: { updatedAt: new Date() },
              });
              if (count === 0) return null;
              const updated = await tx.refundLine.updateMany({
                where: { id: lineId, requestId },
                data: toLineData(body),
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
              ? Effect.succeed(line)
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
