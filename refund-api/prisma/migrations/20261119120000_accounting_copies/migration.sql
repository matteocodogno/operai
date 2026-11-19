-- specs/20261119-accounting (T16): the additive half of the move of the ledger
-- accounts, VAT codes and exchange rates to accounting-api. Plan § Data model
-- (refund-api), steps 1-5 and 7; ADR 20261119-data-that-moves-from-one-service-
-- to-another-before-the-release-moves-by-an-additive-migration-....
--
-- 20261119090000_accounting_export is NOT edited (it is applied on developer and
-- e2e databases). This migration, in this order:
--   1. adds the copy columns to "refund_line";
--   2. creates the two append-only history tables of copies (+ their triggers);
--   3. carries Refund's own data into the copies (a no-op in production, where
--      20261118 never ran: it matters for developer and e2e databases);
--   4. replaces refund_line_accounting_guard() BEFORE any column it names could
--      go: the new body names only the copy columns;
--   5. adds the CHECKs, each NOT VALID and then VALIDATEd, so an odd hand-made
--      row fails the migration loudly with the name of the constraint;
--   7. adds the AuditAction value `line_rate_copied`, last and unused here.
-- Step 6 (the drops of what moved) is NOT here: the old tables, FK columns and
-- the ExchangeRateOrigin type SURVIVE this migration, because the old code still
-- reads them. T24 drops them (<ts2>_accounting_reference_moved_out).
--
-- Every write of step 3 touches only the new columns, so the existing guard,
-- which watches the old ones, does not fire and no trigger is disabled. A run
-- that needed a trigger disabled would mean the order is wrong.

-- ─── 1. The copy columns of "refund_line" ─────────────────────────────────────
-- AlterTable
ALTER TABLE "refund_line" ADD COLUMN     "accountName" TEXT,
ADD COLUMN     "accountNumber" TEXT,
ADD COLUMN     "fxRateCopiedAt" TIMESTAMP(3),
ADD COLUMN     "fxRateMicros" INTEGER,
ADD COLUMN     "fxRateMonth" DATE,
ADD COLUMN     "vatCode" TEXT,
ADD COLUMN     "vatRateBasisPoints" INTEGER;

-- ─── 2. The two append-only tables of copies ──────────────────────────────────
-- CreateTable
CREATE TABLE "expense_type_accounting_default" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "type" "ExpenseType" NOT NULL,
    "accountNumber" TEXT,
    "accountName" TEXT,
    "vatCode" TEXT,
    "vatLabel" TEXT,
    "vatRateBasisPoints" INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_type_accounting_default_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "foreign_currency_vat_designation" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "vatCode" TEXT,
    "vatLabel" TEXT,
    "vatRateBasisPoints" INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "foreign_currency_vat_designation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_type_accounting_default_entity_type_createdAt_idx" ON "expense_type_accounting_default"("entity", "type", "createdAt");

-- CreateIndex
CREATE INDEX "foreign_currency_vat_designation_entity_createdAt_idx" ON "foreign_currency_vat_designation"("entity", "createdAt");

-- ─── Hand-written SQL (Prisma cannot express any of this) ─────────────────────
-- Drift between this block and schema.prisma is guarded by the
-- src/lib/db.accounting-*.test.ts files. Never edit this migration after it has
-- been applied anywhere.

-- Append-only, like the tables they replace: the existing raising trigger
-- function (created by 20261119090000) is reused. TRUNCATE does not fire it,
-- which is what lets test cleanup reset the tables.
CREATE TRIGGER expense_type_accounting_default_no_update BEFORE UPDATE ON "expense_type_accounting_default"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER expense_type_accounting_default_no_delete BEFORE DELETE ON "expense_type_accounting_default"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER foreign_currency_vat_designation_no_update BEFORE UPDATE ON "foreign_currency_vat_designation"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER foreign_currency_vat_designation_no_delete BEFORE DELETE ON "foreign_currency_vat_designation"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

-- ─── 3. Carry Refund's own data ───────────────────────────────────────────────
-- 3a. The line copies, from the old catalog joined on the old FK columns. The
--     FKs are enforced, so every join matches. The "is default" flags stay as
--     they are.
UPDATE "refund_line" AS l
SET "accountNumber" = a."number", "accountName" = a."name"
FROM "ledger_account" AS a
WHERE l."ledgerAccountId" = a."id";

UPDATE "refund_line" AS l
SET "vatCode" = v."code", "vatRateBasisPoints" = v."rateBasisPoints"
FROM "vat_code" AS v
WHERE l."vatCodeId" = v."id";

-- 3b. The defaults history, with the same ids, actors and times. A null half
--     ("no default") stays null.
INSERT INTO "expense_type_accounting_default"
  ("id", "entity", "type", "accountNumber", "accountName", "vatCode", "vatLabel", "vatRateBasisPoints",
   "createdByUserId", "createdByEmail", "createdAt")
SELECT d."id", d."entity", d."type", a."number", a."name", v."code", v."label", v."rateBasisPoints",
       d."createdByUserId", d."createdByEmail", d."createdAt"
FROM "expense_type_default" AS d
LEFT JOIN "ledger_account" AS a ON a."id" = d."ledgerAccountId"
LEFT JOIN "vat_code" AS v ON v."id" = d."vatCodeId";

-- 3c. The designation history: the rows of the refund_setting key, whose value is
--     a VAT code id (null = cleared). A value that names no WellD CH VAT code
--     cannot be copied, and turning it into "cleared" would silently rewrite the
--     history: the migration stops and names the rows instead.
DO $$
DECLARE
  dangling TEXT;
BEGIN
  SELECT string_agg(s."id", ', ' ORDER BY s."createdAt") INTO dangling
  FROM "refund_setting" AS s
  LEFT JOIN "vat_code" AS v ON v."id" = s."value" AND v."entity" = 'welld_ch'
  WHERE s."key" = 'accounting.welld_ch.foreign-currency-vat-code'
    AND s."value" IS NOT NULL
    AND v."id" IS NULL;
  IF dangling IS NOT NULL THEN
    RAISE EXCEPTION 'refund_setting rows % of key accounting.welld_ch.foreign-currency-vat-code name no welld_ch VAT code and cannot be carried', dangling
      USING ERRCODE = 'raise_exception';
  END IF;
END
$$;

INSERT INTO "foreign_currency_vat_designation"
  ("id", "entity", "vatCode", "vatLabel", "vatRateBasisPoints", "createdByUserId", "createdByEmail", "createdAt")
SELECT s."id", 'welld_ch', v."code", v."label", v."rateBasisPoints", s."createdByUserId", s."createdByEmail", s."createdAt"
FROM "refund_setting" AS s
LEFT JOIN "vat_code" AS v ON v."id" = s."value" AND v."entity" = 'welld_ch'
WHERE s."key" = 'accounting.welld_ch.foreign-currency-vat-code';

-- 3d. The legacy rate copies: every numbered, non-rejected, non-CHF WellD CH line
--     of an `approved` or `paid` request takes the rate in effect for its expense
--     month: the latest `corrected` row, else the `fetched` one. Without a rate
--     the line stays rate pending (all three columns null). The copy time is the
--     time of this migration, in UTC like every TIMESTAMP(3) Prisma writes.
UPDATE "refund_line" AS l
SET "fxRateMicros" = r."rateMicros",
    "fxRateMonth" = r."month",
    "fxRateCopiedAt" = (now() AT TIME ZONE 'UTC')
FROM "refund_request" AS q,
     (
       SELECT DISTINCT ON ("currency", "month") "currency", "month", "rateMicros"
       FROM "exchange_rate_entry"
       ORDER BY "currency", "month", ("origin" = 'corrected') DESC, "createdAt" DESC, "id" DESC
     ) AS r
WHERE q."id" = l."requestId"
  AND q."status" IN ('approved', 'paid')
  AND l."entity" = 'welld_ch'
  AND l."currency" <> 'CHF'
  AND l."receiptNumber" IS NOT NULL
  AND l."rejectionReason" IS NULL
  AND r."currency" = l."currency"
  AND r."month" = date_trunc('month', l."date"::timestamp)::date;

-- ─── 4. refund_line_accounting_guard v2 ───────────────────────────────────────
-- Replaced BEFORE the old FK columns can be dropped (the old body names
-- "ledgerAccountId" and "vatCodeId"). The new body names only the copy columns.
--
-- (a) Receipt immutability, unchanged: once a line has a receipt number its five
--     receipt columns never change and it cannot be deleted.
-- (b) Once a line has a receipt number AND its request is `paid`, its copies
--     (account number and name, VAT code and rate, both "is default" flags) are
--     locked: defense in depth behind the route's 409 classification_locked. A
--     line with NO receipt number yet (a legacy line the release script has to
--     classify) stays editable: the IS-1 condition of 20261118 is kept.
-- (c) The exchange-rate copy is WRITE-ONCE, whatever the status: null -> set is
--     allowed (approval, or the pending copy at the first export, also for a
--     paid batch), set -> anything else is refused.
CREATE OR REPLACE FUNCTION refund_line_accounting_guard() RETURNS TRIGGER AS $$
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
       NEW."accountNumber"          IS DISTINCT FROM OLD."accountNumber"
    OR NEW."accountName"            IS DISTINCT FROM OLD."accountName"
    OR NEW."ledgerAccountIsDefault" IS DISTINCT FROM OLD."ledgerAccountIsDefault"
    OR NEW."vatCode"                IS DISTINCT FROM OLD."vatCode"
    OR NEW."vatRateBasisPoints"     IS DISTINCT FROM OLD."vatRateBasisPoints"
    OR NEW."vatCodeIsDefault"       IS DISTINCT FROM OLD."vatCodeIsDefault"
  ) THEN
    SELECT "status" INTO parent_status FROM "refund_request" WHERE id = OLD."requestId";
    IF parent_status = 'paid' THEN
      RAISE EXCEPTION 'refund_line % belongs to a paid request: its classification is locked', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF OLD."fxRateMicros" IS NOT NULL AND (
       NEW."fxRateMicros"   IS DISTINCT FROM OLD."fxRateMicros"
    OR NEW."fxRateMonth"    IS DISTINCT FROM OLD."fxRateMonth"
    OR NEW."fxRateCopiedAt" IS DISTINCT FROM OLD."fxRateCopiedAt"
  ) THEN
    RAISE EXCEPTION 'refund_line % exchange rate copy is write-once and cannot change', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 5. CHECK constraints, NOT VALID first, then VALIDATEd ────────────────────
ALTER TABLE "refund_line"
  ADD CONSTRAINT "refund_line_account_copy_pair" CHECK (("accountNumber" IS NULL) = ("accountName" IS NULL)) NOT VALID,
  ADD CONSTRAINT "refund_line_vat_copy_pair" CHECK (("vatCode" IS NULL) = ("vatRateBasisPoints" IS NULL)) NOT VALID,
  ADD CONSTRAINT "refund_line_vat_rate_range" CHECK ("vatRateBasisPoints" BETWEEN 0 AND 10000) NOT VALID,
  ADD CONSTRAINT "refund_line_fx_all_or_none" CHECK (num_nonnulls("fxRateMicros", "fxRateMonth", "fxRateCopiedAt") IN (0, 3)) NOT VALID,
  ADD CONSTRAINT "refund_line_fx_rate_range" CHECK ("fxRateMicros" > 0 AND "fxRateMicros" < 1000000000) NOT VALID,
  -- The rate is the expense month's. timestamp (not timestamptz) keeps the expression immutable.
  ADD CONSTRAINT "refund_line_fx_month_is_expense_month" CHECK ("fxRateMonth" = date_trunc('month', "date"::timestamp)::date) NOT VALID,
  ADD CONSTRAINT "refund_line_fx_foreign_ch_only" CHECK ("fxRateMicros" IS NULL OR ("currency" <> 'CHF' AND "entity" = 'welld_ch')) NOT VALID,
  -- Closes follow-up FU-S4 of 20261118: no classification or rate copy on a line of another entity.
  ADD CONSTRAINT "refund_line_classification_ch_only" CHECK (
    "entity" = 'welld_ch'
    OR num_nonnulls("accountNumber", "accountName", "vatCode", "vatRateBasisPoints", "fxRateMicros", "fxRateMonth", "fxRateCopiedAt") = 0
  ) NOT VALID;

ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_account_copy_pair";
ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_vat_copy_pair";
ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_vat_rate_range";
ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_fx_all_or_none";
ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_fx_rate_range";
ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_fx_month_is_expense_month";
ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_fx_foreign_ch_only";
ALTER TABLE "refund_line" VALIDATE CONSTRAINT "refund_line_classification_ch_only";

-- The two tables of copies: WellD CH only; a halved copy is refused.
ALTER TABLE "expense_type_accounting_default"
  ADD CONSTRAINT "expense_type_accounting_default_ch_only" CHECK ("entity" = 'welld_ch') NOT VALID,
  ADD CONSTRAINT "expense_type_accounting_default_account_pair" CHECK (("accountNumber" IS NULL) = ("accountName" IS NULL)) NOT VALID,
  ADD CONSTRAINT "expense_type_accounting_default_vat_all_or_none" CHECK (num_nonnulls("vatCode", "vatLabel", "vatRateBasisPoints") IN (0, 3)) NOT VALID,
  ADD CONSTRAINT "expense_type_accounting_default_vat_rate_range" CHECK ("vatRateBasisPoints" BETWEEN 0 AND 10000) NOT VALID;

ALTER TABLE "expense_type_accounting_default" VALIDATE CONSTRAINT "expense_type_accounting_default_ch_only";
ALTER TABLE "expense_type_accounting_default" VALIDATE CONSTRAINT "expense_type_accounting_default_account_pair";
ALTER TABLE "expense_type_accounting_default" VALIDATE CONSTRAINT "expense_type_accounting_default_vat_all_or_none";
ALTER TABLE "expense_type_accounting_default" VALIDATE CONSTRAINT "expense_type_accounting_default_vat_rate_range";

ALTER TABLE "foreign_currency_vat_designation"
  ADD CONSTRAINT "foreign_currency_vat_designation_ch_only" CHECK ("entity" = 'welld_ch') NOT VALID,
  ADD CONSTRAINT "foreign_currency_vat_designation_vat_all_or_none" CHECK (num_nonnulls("vatCode", "vatLabel", "vatRateBasisPoints") IN (0, 3)) NOT VALID,
  ADD CONSTRAINT "foreign_currency_vat_designation_vat_rate_range" CHECK ("vatRateBasisPoints" BETWEEN 0 AND 10000) NOT VALID;

ALTER TABLE "foreign_currency_vat_designation" VALIDATE CONSTRAINT "foreign_currency_vat_designation_ch_only";
ALTER TABLE "foreign_currency_vat_designation" VALIDATE CONSTRAINT "foreign_currency_vat_designation_vat_all_or_none";
ALTER TABLE "foreign_currency_vat_designation" VALIDATE CONSTRAINT "foreign_currency_vat_designation_vat_rate_range";

-- ─── 7. The new audit action ──────────────────────────────────────────────────
-- Last, and not used inside this migration ("unsafe use of new enum value").
-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'line_rate_copied';
