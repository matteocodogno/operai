-- Post-close amendment (2026-07-17, specs/007-refund-service): make an
-- expense line's currency an INDEPENDENTLY-STORED field, decoupled from
-- `entity`. This reverses the 0001_init decision "currency derived from
-- entity, never stored" — the employee now records what was actually paid
-- in (e.g. a welld_it line paid in CHF or USD), and subtotals group purely
-- by the stored currency, never by entity.
--
-- Three-step NOT NULL rollout so this applies cleanly against existing rows:
--   1. add the column NULLABLE
--   2. backfill every existing row from its `entity` (welld_it → EUR,
--      welld_ch → CHF) — the same mapping the old derivation used, so no
--      existing line's displayed currency changes as a result of this
--      migration
--   3. set NOT NULL now that every row has a value
--
-- Never edit 0001_init — this is a NEW migration, appended after it. The
-- audit-immutability trigger from 0001_init is untouched by this migration.

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('EUR', 'CHF', 'USD', 'GBP');

-- AlterTable (1/3): add nullable
ALTER TABLE "refund_line" ADD COLUMN "currency" "Currency";

-- Backfill (2/3): derive from entity, matching the pre-amendment mapping
UPDATE "refund_line"
SET "currency" = CASE "entity"
  WHEN 'welld_it' THEN 'EUR'::"Currency"
  WHEN 'welld_ch' THEN 'CHF'::"Currency"
END
WHERE "currency" IS NULL;

-- AlterTable (3/3): enforce NOT NULL now that every row has a value
ALTER TABLE "refund_line" ALTER COLUMN "currency" SET NOT NULL;
