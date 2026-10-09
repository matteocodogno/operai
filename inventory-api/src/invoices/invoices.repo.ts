/**
 * Invoice-file persistence (T21, specs/015-hardware-inventory; AC-10.4 to
 * AC-10.7). One `invoice_file` row per uploaded object; an asset points at it
 * through `invoiceFileId`. A file linked to N assets is still ONE row (AC-10.5).
 * Only `stored` rows are ever surfaced; a `pending` row is a mint whose upload
 * was never confirmed and is simply invisible (orphans are reconciled on read,
 * ADR-0016/0013: no cron, no sweep).
 */

import { db } from "../lib/db";
import type { Entity } from "../authz/conditions";
import { conflict, notFound } from "../lib/problem";
import { recordEvent } from "../history/record";
import { lockAsset } from "../assets/lockAsset";
import { ASSET_INCLUDE } from "../assets/view";

export interface InvoiceFileRow {
  readonly id: string;
  readonly entity: Entity;
  readonly invoiceRef: string;
  readonly objectKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadStatus: "pending" | "stored";
  readonly createdByUserId: string;
  /** The object's ETag at confirm; null for a row confirmed before it was recorded. */
  readonly etag: string | null;
}

/** How many unconfirmed mints one user may hold at once (bounds presigned-POST minting). */
export const MAX_PENDING_FILES_PER_USER = 20;
/**
 * Only pending rows younger than this count toward the cap: abandoned mints
 * are never swept (ADR-0013: no cron), so without a window twenty of them would
 * lock a user out for good. Older than the presigned POST's own validity by far.
 */
export const PENDING_WINDOW_MS = 60 * 60 * 1000;

export async function countRecentPendingFiles(userId: string, now: Date = new Date()): Promise<number> {
  return db.invoiceFile.count({
    where: {
      createdByUserId: userId,
      uploadStatus: "pending",
      createdAt: { gt: new Date(now.getTime() - PENDING_WINDOW_MS) },
    },
  });
}

export async function createPendingFile(input: {
  id: string;
  entity: Entity;
  invoiceRef: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdByUserId: string;
}): Promise<void> {
  await db.invoiceFile.create({ data: input });
}

export async function findFile(id: string): Promise<InvoiceFileRow | null> {
  return (await db.invoiceFile.findUnique({ where: { id } })) as InvoiceFileRow | null;
}

/** Flips `pending` -> `stored`. A no-op when it already is; the row's final state is returned. */
export async function markStored(id: string, etag: string | null): Promise<InvoiceFileRow | null> {
  await db.invoiceFile.updateMany({
    where: { id, uploadStatus: "pending" },
    data: { uploadStatus: "stored", etag },
  });
  return findFile(id);
}

/**
 * Removes an unconfirmed row (a rejected upload). Guarded on `pending` so a
 * confirm that raced to `stored` is never undone, and a file an asset points at
 * (necessarily `stored`) is never touched.
 */
export async function deletePendingFile(id: string): Promise<void> {
  await db.invoiceFile.deleteMany({ where: { id, uploadStatus: "pending" } });
}

/**
 * Points each asset at `file`, all or nothing. Per asset: unknown or outside
 * `scope` -> 404 for the whole request (checked for ALL assets before any state
 * is judged, so a 409 never confirms an out-of-scope asset exists); disposed ->
 * 409 `asset_disposed`; another entity or another invoice reference -> 409
 * `invoice_ref_mismatch` (both name the asset). An asset that already points
 * at this file is left alone and writes no event; linking over a different file
 * replaces the link and keeps the old row and object (plan: no unlink, no
 * delete). Each change writes one `invoice_file_linked` event whose field is
 * `invoiceFile` and whose values are file names — the convention
 * `assets/edit.repo.ts` uses when a changed reference clears the link.
 *
 * Returns the requested ids (deduplicated, request order) that now carry the file.
 */
export async function linkFile(input: {
  file: InvoiceFileRow;
  assetIds: readonly string[];
  scope: readonly Entity[];
  actor: { userId: string; email: string };
}): Promise<string[]> {
  const { file, scope, actor } = input;
  const ids = [...new Set(input.assetIds)];

  return db.$transaction(
    async (tx) => {
      // Sorted, so two overlapping requests lock in the same order.
      for (const id of [...ids].sort()) await lockAsset(tx, id);
      const rows = await tx.asset.findMany({ where: { id: { in: ids } }, include: ASSET_INCLUDE });
      const byId = new Map(rows.map((r) => [r.id, r]));

      for (const id of ids) {
        const row = byId.get(id);
        if (!row || !(scope as readonly string[]).includes(row.entity)) throw notFound("Asset not found");
      }
      for (const id of ids) {
        const row = byId.get(id)!;
        if (row.status === "disposed") {
          throw conflict("asset_disposed", "A disposed asset accepts no further changes", { assetId: id });
        }
        if (row.entity !== file.entity || row.invoiceRef !== file.invoiceRef) {
          throw conflict(
            "invoice_ref_mismatch",
            "This asset does not carry the invoice reference the file was uploaded for",
            { assetId: id },
          );
        }
      }
      for (const id of ids) {
        const row = byId.get(id)!;
        if (row.invoiceFileId === file.id) continue;
        await tx.asset.update({ where: { id }, data: { invoiceFileId: file.id } });
        await recordEvent(tx, {
          assetId: id,
          entity: row.entity,
          action: "invoice_file_linked",
          actor,
          changes: [{ field: "invoiceFile", from: row.invoiceFile?.fileName ?? null, to: file.fileName }],
        });
      }
      return ids;
    },
    { timeout: 20_000 },
  );
}
