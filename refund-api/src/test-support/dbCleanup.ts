/**
 * Shared test-only cleanup helper (T7+, specs/20260716-refund-service; +
 * `refund_batch`, T3, specs/20260719-refund-monthly-processing; + `mileage_rate`,
 * T2, specs/20260720-mileage-rate; + `refund_setting`, T2, specs/20260722-refund-settings).
 *
 * TRUNCATE, not DELETE — TRUNCATE does not fire the row-level `BEFORE DELETE`
 * trigger on `refund_audit_entry`/`mileage_rate`/`refund_setting` (ADR 20260716-immutable-financial-audit-trail-refund/
 * 0024/0027), so cleanup is never blocked by the very immutability guarantee
 * under test elsewhere in the suite (mirrors `src/lib/db.audit-immutability.
 * test.ts`'s own `afterAll`).
 *
 * specs/20261118-refund-accounting-export (T1): the accounting tables are
 * listed for the same reason; the triggers on them are likewise not fired by
 * TRUNCATE.
 *
 * specs/20261119-accounting (T16, T24): the two append-only tables of copies
 * (`expense_type_accounting_default`, `foreign_currency_vat_designation`) are
 * listed for the same reason. The catalog, its status history, the type
 * defaults, the exchange rates and the fetch attempts moved to accounting-api
 * and their tables were dropped by T24, so they are no longer listed.
 *
 * specs/20261119-accounting (T58): `foreign_currency_vat_designation` was dropped by
 * `20261119200200_vat_defaults_retired` and is no longer listed; the append-only
 * `receipt_number_baseline` (20261119200100) is, for the same reason as the others.
 *
 * specs/20261118-refund-accounting-export (T12): the cleanup puts the accounting
 * release marker back (see `accountingRelease.ts`), because approving is refused
 * without it; `truncateRefundTables({ released: false })` leaves it out.
 *
 * `refund_batch`, `mileage_rate`, and `refund_setting` are all listed
 * explicitly (not just left to CASCADE): each sits on the "referenced" side
 * of an `onDelete: Restrict` FK, or has no incoming FK at all
 * (`refund_setting` is a standalone key/value table with no relations), so
 * CASCADE-truncating the tables that point AT them does not, by itself, also
 * truncate them — a prior version of this helper omitted `refund_batch`,
 * which left `RefundBatch` rows (and their `pdfObjectKey` uniqueness)
 * accumulating across test runs (specs/20260719-refund-monthly-processing T3 fix); `mileage_rate`/
 * `refund_setting` are added up front here to avoid the same class of bug.
 */

import { db } from "../lib/db";
import { markAccountingReleased } from "./accountingRelease";

export interface TruncateOptions {
  /**
   * Put the accounting release marker back after emptying the tables (default
   * `true`), so that approvals are accepted in a test that is not about the
   * release (T12, specs/20261118-refund-accounting-export, plan R14). Pass
   * `false` for a test of the gate or of the release script itself.
   */
  readonly released?: boolean;
}

export async function truncateRefundTables(options: TruncateOptions = {}): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "refund_audit_entry", "attachment", "refund_line", "refund_batch_item", "refund_request", "refund_batch", "mileage_rate", "refund_setting", "receipt_counter", "refund_batch_export", "expense_type_accounting_default", "receipt_number_baseline" RESTART IDENTITY CASCADE',
  );
  if (options.released !== false) await markAccountingReleased();
}
