/**
 * Shared test-only cleanup helper (T7+, specs/007-refund-service; +
 * `refund_batch`, T3, specs/008-refund-monthly-processing; + `mileage_rate`,
 * T2, specs/009-mileage-rate; + `refund_setting`, T2, specs/011-refund-settings).
 *
 * TRUNCATE, not DELETE — TRUNCATE does not fire the row-level `BEFORE DELETE`
 * trigger on `refund_audit_entry`/`mileage_rate`/`refund_setting` (ADR-0018/
 * 0024/0027), so cleanup is never blocked by the very immutability guarantee
 * under test elsewhere in the suite (mirrors `src/lib/db.audit-immutability.
 * test.ts`'s own `afterAll`).
 *
 * `refund_batch`, `mileage_rate`, and `refund_setting` are all listed
 * explicitly (not just left to CASCADE): each sits on the "referenced" side
 * of an `onDelete: Restrict` FK, or has no incoming FK at all
 * (`refund_setting` is a standalone key/value table with no relations), so
 * CASCADE-truncating the tables that point AT them does not, by itself, also
 * truncate them — a prior version of this helper omitted `refund_batch`,
 * which left `RefundBatch` rows (and their `pdfObjectKey` uniqueness)
 * accumulating across test runs (specs/008 T3 fix); `mileage_rate`/
 * `refund_setting` are added up front here to avoid the same class of bug.
 */

import { db } from "../lib/db";

export async function truncateRefundTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "refund_audit_entry", "attachment", "refund_line", "refund_batch_item", "refund_request", "refund_batch", "mileage_rate", "refund_setting" RESTART IDENTITY CASCADE',
  );
}
