/**
 * Shared test-only cleanup helper (T7+, specs/007-refund-service).
 *
 * TRUNCATE, not DELETE — TRUNCATE does not fire the row-level `BEFORE DELETE`
 * trigger on `refund_audit_entry` (ADR-0018), so cleanup is never blocked by
 * the very immutability guarantee under test elsewhere in the suite (mirrors
 * `src/lib/db.audit-immutability.test.ts`'s own `afterAll`).
 */

import { db } from "../lib/db";

export async function truncateRefundTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "refund_audit_entry", "attachment", "refund_line", "refund_request" RESTART IDENTITY CASCADE',
  );
}
