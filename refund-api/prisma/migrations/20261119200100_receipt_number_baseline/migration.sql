-- specs/20261118-refund-accounting-export (T58, sign-off round); plan 20261118 § "Accounting
-- sign-off delta (2026-11-19)", decision SO-13 and § Data model step 2 (AC-4.11 to AC-4.13,
-- AC-7.4).
--
-- The 2026 numbering baseline: per employee EMAIL (lower-cased) and year, the last receipt
-- sequence that was issued by hand before Refund took over. Append-only: the current value is
-- the latest row per ("emailKey", "year"). Read when an employee's 2026 counter is created
-- (T63), so it also serves an employee who has no Refund request yet.
--
-- Additive: a new table, nothing applied is edited. `receipt_counter."startAfterSetBy"` gains
-- the value 'baseline' in application code only (free text today, no DDL).

-- CreateTable
CREATE TABLE "receipt_number_baseline" (
    "id" TEXT NOT NULL,
    "emailKey" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastIssuedSeq" INTEGER NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_number_baseline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_number_baseline_emailKey_year_createdAt_idx" ON "receipt_number_baseline"("emailKey", "year", "createdAt");

-- ─── Hand-written SQL (Prisma cannot express any of this) ─────────────────────
-- Drift between this block and schema.prisma is guarded by
-- src/lib/db.accounting-signoff.test.ts and src/lib/migration.accounting-signoff.test.ts.
-- Never edit this migration after it has been applied anywhere.

-- The key is the lower-cased email, so a lookup by lower(ownerEmail) is exact (AC-4.11).
-- Only 2026 is ever continued from the paper register (AC-4.12; 2027 starts at 001, AC-4.13).
-- 1..99999: a receipt number carries at most five digits of sequence.
ALTER TABLE "receipt_number_baseline"
  ADD CONSTRAINT "receipt_number_baseline_email_key_lower" CHECK ("emailKey" = lower("emailKey") AND "emailKey" LIKE '%@%'),
  ADD CONSTRAINT "receipt_number_baseline_year_2026" CHECK ("year" = 2026),
  ADD CONSTRAINT "receipt_number_baseline_seq_range" CHECK ("lastIssuedSeq" BETWEEN 1 AND 99999);

-- Append-only, like the other accounting history tables: the existing raising trigger function
-- (created by 20261119090000) is reused. TRUNCATE does not fire it, which is what lets test
-- cleanup reset the table.
CREATE TRIGGER receipt_number_baseline_no_update BEFORE UPDATE ON "receipt_number_baseline"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER receipt_number_baseline_no_delete BEFORE DELETE ON "receipt_number_baseline"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
