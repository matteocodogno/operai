-- specs/20261119-accounting (T58, sign-off round); plan 20261119 § "Accounting sign-off delta
-- (2026-11-19)", decision SO-18 and § Data model (delta); plan 20261118 SO-2, SO-16.
--
-- The VAT half of Refund's defaults is retired: no VAT code is ever pre-set (AC-3.11 to AC-3.13
-- of 20261118). This migration, in this order:
--   1. drops the designation table of the foreign-currency VAT code (its two immutability
--      triggers go with it);
--   2. on "expense_type_accounting_default", drops the two VAT CHECKs, then the three VAT
--      columns.
-- 20261119120000_accounting_copies and 20261119130000_accounting_reference_moved_out are NOT
-- edited (both are applied on developer and e2e databases).
--
-- Existing rows: production has none (20261118 and 20261119 are unreleased). On developer and
-- e2e databases every default row keeps its id, actor, time and account copy, so the account
-- history reads as before; the VAT values on those rows and every designation row are
-- discarded (spec non-goal: converting test or staging data). A row that once changed only the
-- VAT now repeats the account it already had. The old "refund_setting" designation rows stay
-- unread (D33). Line copies ("refund_line"."vatCode" and friends) are untouched: a line that
-- got a VAT copy from a former default keeps it (AC-5.3).
--
-- DDL does not fire row triggers, so no trigger is disabled. No CASCADE: a dependency nobody
-- knew of must fail the migration, not be dropped silently. One way: no down migration.

-- ─── 1. The designation table ─────────────────────────────────────────────────
-- DropTable
DROP TABLE "foreign_currency_vat_designation";

-- ─── 2. The VAT half of the defaults ──────────────────────────────────────────
ALTER TABLE "expense_type_accounting_default"
  DROP CONSTRAINT "expense_type_accounting_default_vat_all_or_none",
  DROP CONSTRAINT "expense_type_accounting_default_vat_rate_range";

-- AlterTable
ALTER TABLE "expense_type_accounting_default" DROP COLUMN "vatCode",
DROP COLUMN "vatLabel",
DROP COLUMN "vatRateBasisPoints";
