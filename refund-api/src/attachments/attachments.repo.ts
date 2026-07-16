/**
 * Prisma data-access layer for Attachment (T9, specs/007-refund-service,
 * ADR-0016).
 *
 * Storage I/O (presigned URLs, HEAD, delete) lives in `../lib/storage.ts` and
 * is orchestrated by `attachments.routes.ts` — this module is DB-only, same
 * separation as `requests.repo.ts`/`lines.repo.ts`.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { ConflictError, DatabaseError, NotFoundError } from "../lib/errors";
import { ensureOwnedDraftRequest } from "../requests/lines.repo";

export interface AttachmentRow {
  readonly id: string;
  readonly lineId: string;
  readonly objectKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadStatus: string;
}

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

function ensureLineInRequest(
  requestId: string,
  lineId: string,
): Effect.Effect<void, DatabaseError | NotFoundError> {
  return Effect.tryPromise({
    try: () =>
      db.refundLine.findFirst({
        where: { id: lineId, requestId },
        select: { id: true },
      }),
    catch: toDbErr("Failed to look up refund line"),
  }).pipe(
    Effect.flatMap(
      (line): Effect.Effect<void, NotFoundError> =>
        line
          ? Effect.succeed(undefined)
          : Effect.fail(
              new NotFoundError({ message: `Refund line ${lineId} not found` }),
            ),
    ),
  );
}

/**
 * Draft-only ownership+existence guard shared by mint/confirm/delete
 * (attachments only ever mutate on a draft request — plan.md § API
 * contracts).
 */
export function ensureOwnedDraftLine(
  requestId: string,
  lineId: string,
  ownerUserId: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ConflictError> {
  return ensureOwnedDraftRequest(requestId, ownerUserId).pipe(
    Effect.flatMap(() => ensureLineInRequest(requestId, lineId)),
  );
}

export function createPendingAttachment(data: {
  readonly id: string;
  readonly lineId: string;
  readonly objectKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}): Effect.Effect<AttachmentRow, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.attachment.create({
        data: {
          id: data.id,
          lineId: data.lineId,
          objectKey: data.objectKey,
          fileName: data.fileName,
          contentType: data.contentType,
          sizeBytes: data.sizeBytes,
          uploadStatus: "pending",
        },
      }),
    catch: toDbErr("Failed to create attachment record"),
  });
}

export function findAttachmentInLine(
  lineId: string,
  attachmentId: string,
): Effect.Effect<AttachmentRow | null, DatabaseError> {
  return Effect.tryPromise({
    try: () => db.attachment.findFirst({ where: { id: attachmentId, lineId } }),
    catch: toDbErr("Failed to look up attachment"),
  });
}

export function markAttachmentStored(
  attachmentId: string,
): Effect.Effect<AttachmentRow, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.attachment.update({
        where: { id: attachmentId },
        data: { uploadStatus: "stored" },
      }),
    catch: toDbErr("Failed to mark attachment stored"),
  });
}

export function deleteAttachmentRow(
  attachmentId: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.tryPromise({
    try: () => db.attachment.delete({ where: { id: attachmentId } }),
    catch: toDbErr("Failed to delete attachment record"),
  }).pipe(Effect.map(() => undefined));
}
