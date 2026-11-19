-- specs/20261119-accounting (T24): the contracting half of the move of the ledger
-- accounts, VAT codes and exchange rates to accounting-api. Plan § Data model
-- (refund-api), step 6; ADR 20261119-data-that-moves-from-one-service-to-another-
-- before-the-release-moves-by-an-additive-migration-....
--
-- 20261119090000_accounting_export and 20261119120000_accounting_copies are NOT
-- edited (both are applied on developer and e2e databases). The previous one
-- added the copies, carried Refund's own data into them and replaced the guard
-- refund_line_accounting_guard() so that it no longer names the old FK columns.
-- This one drops what moved, in this order:
--   0. a pre-flight check that nothing is dropped which the copies do not hold;
--   1. the FK constraints and the indexes of refund_line on the old columns,
--      then the columns "ledgerAccountId" and "vatCodeId";
--   2. the tables, referencing tables first: expense_type_default,
--      accounting_catalog_status, then ledger_account and vat_code, then
--      exchange_rate_entry and exchange_rate_fetch_attempt. Their triggers and
--      CHECKs (and the partial unique index exchange_rate_fetched_once) go with
--      them. No CASCADE: a dependency nobody knew of must fail the migration,
--      not be dropped silently;
--   3. the type "ExchangeRateOrigin".
--
-- What stays: "refund_batch_export", "receipt_counter", the two tables of copies,
-- the function accounting_history_immutable() (they use it), the release marker,
-- and the rows of "refund_setting" under the designation key (immutable, left
-- unread, D33). The columns "ledgerAccountIsDefault" and "vatCodeIsDefault" stay.
--
-- One way: there is no down migration. Production holds none of this data (the
-- 20261118 feature was never released), and a developer or e2e database enters
-- its reference data again in accounting-api (seed:welld-ch).

-- ─── 0. Pre-flight: nothing is dropped that the copies do not hold ────────────
-- Since 20261119120000 the application writes only the copy columns. A database
-- on which an OLDER build kept classifying lines or saving defaults after that
-- migration holds rows the drops below would lose without a trace. The migration
-- stops and names them instead; the carrying statements of 20261119120000 (step
-- 3) are the way to catch such a database up before it is run again.
DO $$
DECLARE
  lines TEXT;
  defaults TEXT;
BEGIN
  SELECT string_agg(l."id", ', ' ORDER BY l."id") INTO lines
  FROM "refund_line" AS l
  WHERE (l."ledgerAccountId" IS NOT NULL AND l."accountNumber" IS NULL)
     OR (l."vatCodeId" IS NOT NULL AND l."vatCode" IS NULL);
  IF lines IS NOT NULL THEN
    RAISE EXCEPTION 'refund_line rows % reference the old catalog but hold no copy of it, and the old columns are about to be dropped', lines
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT string_agg(d."id", ', ' ORDER BY d."createdAt", d."id") INTO defaults
  FROM "expense_type_default" AS d
  LEFT JOIN "expense_type_accounting_default" AS c ON c."id" = d."id"
  WHERE c."id" IS NULL;
  IF defaults IS NOT NULL THEN
    RAISE EXCEPTION 'expense_type_default rows % were not carried into expense_type_accounting_default, and the old table is about to be dropped', defaults
      USING ERRCODE = 'raise_exception';
  END IF;
END
$$;

-- ─── 1. The old foreign keys of "refund_line" ─────────────────────────────────
-- DropForeignKey
ALTER TABLE "refund_line" DROP CONSTRAINT "refund_line_ledgerAccountId_fkey";

-- DropForeignKey
ALTER TABLE "refund_line" DROP CONSTRAINT "refund_line_vatCodeId_fkey";

-- DropIndex
DROP INDEX "refund_line_ledgerAccountId_idx";

-- DropIndex
DROP INDEX "refund_line_vatCodeId_idx";

-- AlterTable
ALTER TABLE "refund_line" DROP COLUMN "ledgerAccountId",
DROP COLUMN "vatCodeId";

-- ─── 2. The tables that moved ─────────────────────────────────────────────────
-- DropForeignKey
ALTER TABLE "accounting_catalog_status" DROP CONSTRAINT "accounting_catalog_status_ledgerAccountId_fkey";

-- DropForeignKey
ALTER TABLE "accounting_catalog_status" DROP CONSTRAINT "accounting_catalog_status_vatCodeId_fkey";

-- DropForeignKey
ALTER TABLE "expense_type_default" DROP CONSTRAINT "expense_type_default_ledgerAccountId_fkey";

-- DropForeignKey
ALTER TABLE "expense_type_default" DROP CONSTRAINT "expense_type_default_vatCodeId_fkey";

-- DropTable
DROP TABLE "expense_type_default";

-- DropTable
DROP TABLE "accounting_catalog_status";

-- DropTable
DROP TABLE "ledger_account";

-- DropTable
DROP TABLE "vat_code";

-- DropTable
DROP TABLE "exchange_rate_entry";

-- DropTable
DROP TABLE "exchange_rate_fetch_attempt";

-- ─── 3. The type of the dropped rates ─────────────────────────────────────────
-- DropEnum
DROP TYPE "ExchangeRateOrigin";
