/**
 * Shared test-only cleanup helper (T7+, specs/007-refund-service; +
 * `refund_batch`, T3, specs/008-refund-monthly-processing).
 *
 * TRUNCATE, not DELETE — TRUNCATE does not fire the row-level `BEFORE DELETE`
 * trigger on `refund_audit_entry` (ADR-0018), so cleanup is never blocked by
 * the very immutability guarantee under test elsewhere in the suite (mirrors
 * `src/lib/db.audit-immutability.test.ts`'s own `afterAll`).
 *
 * `refund_batch` is listed explicitly (not just left to CASCADE): it sits on
 * the "referenced" side of `refund_request.batchId`/`refund_batch_item.
 * batchId`/`refund_audit_entry.batchId` (all `onDelete: Restrict`), so
 * CASCADE-truncating the tables that point AT it does not, by itself, also
 * truncate it — a prior version of this helper omitted it, which left
 * `RefundBatch` rows (and their `pdfObjectKey` uniqueness) accumulating
 * across test runs (specs/008 T3 fix).
 */

import { db } from "../lib/db";

export async function truncateRefundTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "refund_audit_entry", "attachment", "refund_line", "refund_batch_item", "refund_request", "refund_batch" RESTART IDENTITY CASCADE',
  );
}
