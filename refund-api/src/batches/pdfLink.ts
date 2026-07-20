/**
 * Shared "resolve a batch's downloadable PDF link" helper (T4,
 * specs/008-refund-monthly-processing, ADR-0019 regenerable-cache posture;
 * fail-soft hardening — OWASP A04 fix round, specs/008 QE/security finding).
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
 *
 * FAIL-SOFT (OWASP A04 fix round): this function used to let ANY failure —
 * a `headObject`/`renderBatchPdf`/`putObject`/`mintPresignedGet` error —
 * propagate up as an uncaught rejection. Combined with the ADR-0019 lazy-
 * regenerate design, that turned a single bad render (the pre-fix
 * `pdf.ts` threw on a non-WinAnsi display name) into a PERMANENTLY
 * unreadable batch: every subsequent `GET /batches/:id` re-attempted the
 * same doomed render and 500'd (breaking AC-1.10), and — much worse — a
 * `mark-paid`/`discard` whose financial transaction had ALREADY COMMITTED
 * would still 500 on this step (`fetchDetailAfterTransition`, decide.
 * routes.ts), misleading the caller into thinking a real money-moving action
 * had failed when it had, in fact, already succeeded. `renderBatchPdf`
 * itself is now a total function (pdf.ts's Unicode-font fix) so this
 * shouldn't fire for that specific cause anymore, but the object-storage
 * calls around it (`headObject`/`putObject`/`mintPresignedGet`) remain
 * genuinely fallible (network, credentials, bucket outage) — so this
 * function now NEVER throws: any failure degrades to `null` (§ "PDF
 * temporarily unavailable"), logged, with the batch's own core state (and
 * every OTHER caller — the HTTP status, the committed transaction) entirely
 * unaffected. Every call site (GET /batches/:id, GET /batches/:id/pdf-url,
 * decide.routes.ts's fetchDetailAfterTransition) must treat `null` as a
 * normal, non-error outcome — see each site's own handling.
 */

import { headObject, mintPresignedGet, putObject } from "../lib/storage";
import { renderBatchPdf } from "./pdf";
import { toBatchPdfEmployees, type BatchPdfLinkInput } from "./batches.service";
import type { BatchWithRequests } from "./batches.repo";

/** Mirrors the ~60s window used by T3's compile response (plan.md § Object storage). */
const PDF_URL_TTL_SECONDS = 60;

/**
 * Resolves a fresh presigned GET for `batch`'s compiled PDF, lazily
 * regenerating the object on a storage miss. Never throws — a render/store/
 * presign failure degrades to `null` (see module doc); callers render that
 * as "PDF temporarily unavailable" rather than failing their own response.
 */
export async function resolvePdfLink(
  batch: BatchWithRequests,
): Promise<BatchPdfLinkInput | null> {
  try {
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
  } catch (error) {
    console.error(
      `[batches] failed to resolve the PDF link for batch ${batch.id} — ` +
        "degrading to pdf: null (OWASP A04 fail-soft posture, pdfLink.ts):",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
