/**
 * Shared "resolve a batch's downloadable PDF link" helper (T4,
 * specs/008-refund-monthly-processing, ADR-0019 regenerable-cache posture).
 *
 * Used by every surface that must hand back a fresh, short-lived presigned
 * GET for a batch's compiled PDF: `GET /batches/:id`, `GET
 * /batches/:id/pdf-url` (T4), and the `BatchDetail` responses of mark-paid /
 * discard (T6/T8) — all of them need the SAME "HEAD, lazily regenerate on
 * miss, mint" sequence, so it lives in one place rather than four.
 *
 * The PDF object is a regenerable cache, not the source of truth (ADR-0019):
 * if the compile-time `PutObject` ever failed, or the object is otherwise
 * missing, this function deterministically re-renders it from the batch's
 * frozen `RefundBatchItem` membership (via `toBatchPdfEmployees`) — this is
 * what lets a discarded batch's PDF still resolve (AC-1.10/6.3) even though
 * its requests' live `batchId` pointer has been nulled.
 */

import { headObject, mintPresignedGet, putObject } from "../lib/storage";
import { renderBatchPdf } from "./pdf";
import { toBatchPdfEmployees, type BatchPdfLinkInput } from "./batches.service";
import type { BatchWithRequests } from "./batches.repo";

/** Mirrors the ~60s window used by T3's compile response (plan.md § Object storage). */
const PDF_URL_TTL_SECONDS = 60;

export async function resolvePdfLink(
  batch: BatchWithRequests,
): Promise<BatchPdfLinkInput> {
  const existing = await headObject(batch.pdfObjectKey);
  if (!existing) {
    const pdfBuffer = await renderBatchPdf({
      batchId: batch.id,
      cutoff: batch.cutoff,
      generatedAt: batch.createdAt,
      generatedByEmail: batch.createdByEmail,
      employees: toBatchPdfEmployees(batch.requests),
    });
    await putObject(batch.pdfObjectKey, pdfBuffer, "application/pdf");
  }

  const url = await mintPresignedGet(batch.pdfObjectKey, PDF_URL_TTL_SECONDS);
  const expiresAt = new Date(Date.now() + PDF_URL_TTL_SECONDS * 1000).toISOString();
  return { url, expiresAt };
}
