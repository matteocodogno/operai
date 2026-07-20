/**
 * Shared test-only cleanup helper (T7+, specs/007-refund-service; +
 * `refund_batch`, T3, specs/008-refund-monthly-processing; + `mileage_rate`,
 * T2, specs/009-mileage-rate).
 *
 * TRUNCATE, not DELETE — TRUNCATE does not fire the row-level `BEFORE DELETE`
 * trigger on `refund_audit_entry`/`mileage_rate` (ADR-0018), so cleanup is
 * never blocked by the very immutability guarantee under test elsewhere in
 * the suite (mirrors `src/lib/db.audit-immutability.test.ts`'s own
 * `afterAll`).
 *
 * `refund_batch` and `mileage_rate` are both listed explicitly (not just
 * left to CASCADE): each sits on the "referenced" side of an
 * `onDelete: Restrict` FK (`refund_request.batchId`/`refund_batch_item.
 * batchId`/`refund_audit_entry.batchId` → `refund_batch`;
 * `refund_line.appliedRateEntryId` → `mileage_rate`), so CASCADE-truncating
 * the tables that point AT them does not, by itself, also truncate them — a
 * prior version of this helper omitted `refund_batch`, which left
 * `RefundBatch` rows (and their `pdfObjectKey` uniqueness) accumulating
 * across test runs (specs/008 T3 fix); `mileage_rate` is added up front here
 * to avoid the same class of bug.
 */

import { db } from "../lib/db";

export async function truncateRefundTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "refund_audit_entry", "attachment", "refund_line", "refund_batch_item", "refund_request", "refund_batch", "mileage_rate" RESTART IDENTITY CASCADE',
  );
}
