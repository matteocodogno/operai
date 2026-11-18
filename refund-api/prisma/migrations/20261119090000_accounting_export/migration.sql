-- specs/20261118-refund-accounting-export (T1): ledger accounts, VAT codes, the
-- default classification, line classification and receipt-number columns,
-- the receipt counter, exchange rates, the export log. ONE migration for the
-- whole feature (plan § Data model). Additive only: no data is written here;
-- the release script (accounting:release, T11) is the backfill. The two new
-- AuditAction values are used by application code only, never inside this
-- migration, so there is no "unsafe use of new enum value".

-- CreateEnum
CREATE TYPE "ExchangeRateOrigin" AS ENUM ('fetched', 'corrected');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'line_classified';
ALTER TYPE "AuditAction" ADD VALUE 'receipt_number_assigned';

-- AlterTable
ALTER TABLE "refund_line" ADD COLUMN     "ledgerAccountId" TEXT,
ADD COLUMN     "ledgerAccountIsDefault" BOOLEAN,
ADD COLUMN     "numberedAt" TIMESTAMP(3),
ADD COLUMN     "receiptNumber" TEXT,
ADD COLUMN     "receiptOwnerUserId" TEXT,
ADD COLUMN     "receiptSeq" INTEGER,
ADD COLUMN     "receiptYear" INTEGER,
ADD COLUMN     "vatCodeId" TEXT,
ADD COLUMN     "vatCodeIsDefault" BOOLEAN;

-- CreateTable
CREATE TABLE "ledger_account" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_code" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vat_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_catalog_status" (
    "id" TEXT NOT NULL,
    "ledgerAccountId" TEXT,
    "vatCodeId" TEXT,
    "active" BOOLEAN NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_catalog_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_type_default" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "type" "ExpenseType" NOT NULL,
    "ledgerAccountId" TEXT,
    "vatCodeId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_type_default_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_counter" (
    "ownerUserId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastSeq" INTEGER NOT NULL,
    "startAfter" INTEGER NOT NULL DEFAULT 0,
    "startAfterSetBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_counter_pkey" PRIMARY KEY ("ownerUserId","year")
);

-- CreateTable
CREATE TABLE "exchange_rate_entry" (
    "id" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "month" DATE NOT NULL,
    "rateMicros" INTEGER NOT NULL,
    "origin" "ExchangeRateOrigin" NOT NULL,
    "sourceUrl" TEXT,
    "sourceMonth" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rate_fetch_attempt" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "recorded" JSONB,
    "discrepancies" JSONB,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_fetch_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_batch_export" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "excludedLineCount" INTEGER NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_batch_export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_entity_number_key" ON "ledger_account"("entity", "number");

-- CreateIndex
CREATE UNIQUE INDEX "vat_code_entity_code_key" ON "vat_code"("entity", "code");

-- CreateIndex
CREATE INDEX "accounting_catalog_status_ledgerAccountId_createdAt_idx" ON "accounting_catalog_status"("ledgerAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "accounting_catalog_status_vatCodeId_createdAt_idx" ON "accounting_catalog_status"("vatCodeId", "createdAt");

-- CreateIndex
CREATE INDEX "expense_type_default_entity_type_createdAt_idx" ON "expense_type_default"("entity", "type", "createdAt");

-- CreateIndex
CREATE INDEX "exchange_rate_entry_currency_month_createdAt_idx" ON "exchange_rate_entry"("currency", "month", "createdAt");

-- CreateIndex
CREATE INDEX "exchange_rate_fetch_attempt_month_createdAt_idx" ON "exchange_rate_fetch_attempt"("month", "createdAt");

-- CreateIndex
CREATE INDEX "exchange_rate_fetch_attempt_createdAt_idx" ON "exchange_rate_fetch_attempt"("createdAt");

-- CreateIndex
CREATE INDEX "refund_batch_export_batchId_createdAt_idx" ON "refund_batch_export"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "refund_line_ledgerAccountId_idx" ON "refund_line"("ledgerAccountId");

-- CreateIndex
CREATE INDEX "refund_line_vatCodeId_idx" ON "refund_line"("vatCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "refund_line_receiptOwnerUserId_receiptYear_receiptSeq_key" ON "refund_line"("receiptOwnerUserId", "receiptYear", "receiptSeq");

-- AddForeignKey
ALTER TABLE "refund_line" ADD CONSTRAINT "refund_line_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_line" ADD CONSTRAINT "refund_line_vatCodeId_fkey" FOREIGN KEY ("vatCodeId") REFERENCES "vat_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_catalog_status" ADD CONSTRAINT "accounting_catalog_status_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_catalog_status" ADD CONSTRAINT "accounting_catalog_status_vatCodeId_fkey" FOREIGN KEY ("vatCodeId") REFERENCES "vat_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_type_default" ADD CONSTRAINT "expense_type_default_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_type_default" ADD CONSTRAINT "expense_type_default_vatCodeId_fkey" FOREIGN KEY ("vatCodeId") REFERENCES "vat_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_batch_export" ADD CONSTRAINT "refund_batch_export_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "refund_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written SQL (Prisma cannot express any of this) ─────────────────────
-- Drift between this block and schema.prisma is guarded by the
-- src/lib/db.accounting-*.test.ts files (plan R11). Never edit generated
-- sources; never edit this migration after it has been deployed.

-- ─── 1. Append-only history tables (ADR 20260716-immutable-financial-audit-trail-refund) ─────
--
-- One raising BEFORE UPDATE/DELETE trigger per table, same shape as
-- "mileage_rate" / "refund_setting": a raise, not a silent no-op rule, so an
-- inadvertent write fails loudly. TRUNCATE does not fire row triggers, which
-- is what lets test cleanup reset the tables. A rate of a VAT code can
-- therefore never change (AC-1.5), nor can a catalog entry, a default, a
-- fetched or corrected rate, a fetch attempt or an export-log row.
CREATE FUNCTION accounting_history_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only and cannot be updated or deleted (id=%)', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_account_no_update BEFORE UPDATE ON "ledger_account"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER ledger_account_no_delete BEFORE DELETE ON "ledger_account"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER vat_code_no_update BEFORE UPDATE ON "vat_code"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER vat_code_no_delete BEFORE DELETE ON "vat_code"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER accounting_catalog_status_no_update BEFORE UPDATE ON "accounting_catalog_status"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER accounting_catalog_status_no_delete BEFORE DELETE ON "accounting_catalog_status"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER expense_type_default_no_update BEFORE UPDATE ON "expense_type_default"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER expense_type_default_no_delete BEFORE DELETE ON "expense_type_default"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER exchange_rate_entry_no_update BEFORE UPDATE ON "exchange_rate_entry"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER exchange_rate_entry_no_delete BEFORE DELETE ON "exchange_rate_entry"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER exchange_rate_fetch_attempt_no_update BEFORE UPDATE ON "exchange_rate_fetch_attempt"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER exchange_rate_fetch_attempt_no_delete BEFORE DELETE ON "exchange_rate_fetch_attempt"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER refund_batch_export_no_update BEFORE UPDATE ON "refund_batch_export"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER refund_batch_export_no_delete BEFORE DELETE ON "refund_batch_export"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

-- ─── 2. receipt_counter: lastSeq only grows, the offset is frozen, no DELETE (AC-4.3, AC-4.7) ───
CREATE FUNCTION receipt_counter_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipt_counter rows cannot be deleted (owner=%, year=%)', OLD."ownerUserId", OLD."year"
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" OR NEW."year" IS DISTINCT FROM OLD."year" THEN
    RAISE EXCEPTION 'receipt_counter key is immutable (owner=%, year=%)', OLD."ownerUserId", OLD."year"
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW."lastSeq" < OLD."lastSeq" THEN
    RAISE EXCEPTION 'receipt_counter lastSeq cannot decrease (owner=%, year=%, % -> %)', OLD."ownerUserId", OLD."year", OLD."lastSeq", NEW."lastSeq"
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW."startAfter" IS DISTINCT FROM OLD."startAfter" OR NEW."startAfterSetBy" IS DISTINCT FROM OLD."startAfterSetBy" THEN
    RAISE EXCEPTION 'receipt_counter startAfter is immutable after insert (owner=%, year=%)', OLD."ownerUserId", OLD."year"
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER receipt_counter_guard_update BEFORE UPDATE ON "receipt_counter"
FOR EACH ROW EXECUTE FUNCTION receipt_counter_guard();
CREATE TRIGGER receipt_counter_no_delete BEFORE DELETE ON "receipt_counter"
FOR EACH ROW EXECUTE FUNCTION receipt_counter_guard();

-- ─── 3. refund_line_accounting_guard (AC-4.7, AC-3.7) ──────────────────────────
--
-- (a) Once a line has a receipt number, its five receipt columns never change
--     and the line cannot be deleted (a discarded or recompiled batch never
--     touches a number).
-- (b) The classification (account, VAT code, both "is default" flags) of a
--     line of a `paid` request cannot change, defense in depth behind the
--     route's 409 classification_locked.
--     One exception: a line with NO receipt number yet. Such a line of a paid
--     request can only be a legacy line approved before this feature, and the
--     release script (accounting:release, AC-7.1) has to classify it. Every
--     line approved after the release is numbered in the same transaction as
--     its classification is frozen, so it is locked as soon as it is paid.
CREATE FUNCTION refund_line_accounting_guard() RETURNS TRIGGER AS $$
DECLARE
  parent_status "RefundStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."receiptNumber" IS NOT NULL THEN
      RAISE EXCEPTION 'refund_line % carries receipt number % and cannot be deleted', OLD.id, OLD."receiptNumber"
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."receiptNumber" IS NOT NULL AND (
       NEW."receiptNumber"      IS DISTINCT FROM OLD."receiptNumber"
    OR NEW."receiptOwnerUserId" IS DISTINCT FROM OLD."receiptOwnerUserId"
    OR NEW."receiptYear"        IS DISTINCT FROM OLD."receiptYear"
    OR NEW."receiptSeq"         IS DISTINCT FROM OLD."receiptSeq"
    OR NEW."numberedAt"         IS DISTINCT FROM OLD."numberedAt"
  ) THEN
    RAISE EXCEPTION 'refund_line % receipt number % is immutable', OLD.id, OLD."receiptNumber"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."receiptNumber" IS NOT NULL AND (
       NEW."ledgerAccountId"        IS DISTINCT FROM OLD."ledgerAccountId"
    OR NEW."vatCodeId"              IS DISTINCT FROM OLD."vatCodeId"
    OR NEW."ledgerAccountIsDefault" IS DISTINCT FROM OLD."ledgerAccountIsDefault"
    OR NEW."vatCodeIsDefault"       IS DISTINCT FROM OLD."vatCodeIsDefault"
  ) THEN
    SELECT "status" INTO parent_status FROM "refund_request" WHERE id = OLD."requestId";
    IF parent_status = 'paid' THEN
      RAISE EXCEPTION 'refund_line % belongs to a paid request: its classification is locked', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refund_line_accounting_guard_update BEFORE UPDATE ON "refund_line"
FOR EACH ROW EXECUTE FUNCTION refund_line_accounting_guard();
CREATE TRIGGER refund_line_accounting_guard_delete BEFORE DELETE ON "refund_line"
FOR EACH ROW EXECUTE FUNCTION refund_line_accounting_guard();

-- ─── 4. CHECK constraints ────────────────────────────────────────────────────
ALTER TABLE "vat_code"
  ADD CONSTRAINT "vat_code_rate_range" CHECK ("rateBasisPoints" BETWEEN 0 AND 10000);

ALTER TABLE "accounting_catalog_status"
  ADD CONSTRAINT "accounting_catalog_status_one_of" CHECK (num_nonnulls("ledgerAccountId", "vatCodeId") = 1);

ALTER TABLE "exchange_rate_entry"
  ADD CONSTRAINT "exchange_rate_entry_not_chf" CHECK ("currency" <> 'CHF'),
  ADD CONSTRAINT "exchange_rate_entry_rate_positive" CHECK ("rateMicros" > 0),
  ADD CONSTRAINT "exchange_rate_entry_month_first_day" CHECK (EXTRACT(DAY FROM "month") = 1);

-- The five receipt columns are written together or not at all.
ALTER TABLE "refund_line"
  ADD CONSTRAINT "refund_line_receipt_all_or_none" CHECK (
    num_nonnulls("receiptNumber", "receiptOwnerUserId", "receiptYear", "receiptSeq", "numberedAt") IN (0, 5)
  );

-- ─── 5. A fetched rate is recorded once and never replaced (AC-5.3, ADR on FX) ─
-- A correction is a second row of origin 'corrected', which is not constrained.
CREATE UNIQUE INDEX "exchange_rate_fetched_once"
  ON "exchange_rate_entry" ("currency", "month") WHERE "origin" = 'fetched';
