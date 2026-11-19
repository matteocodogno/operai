-- specs/20261119-accounting (T5): the init migration of accounting-api. Five tables (ledger accounts,
-- VAT codes, their status changes, exchange rates, fetch attempts), all append-only, with the
-- immutability triggers, CHECKs, the status-entity trigger and the fetched-once index of plan
-- § Data model. The Prisma-generated statements come first, then the hand-written block.

-- CreateEnum
CREATE TYPE "Entity" AS ENUM ('welld_it', 'welld_ch');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('CHF', 'EUR', 'USD', 'GBP');

-- CreateEnum
CREATE TYPE "RateOrigin" AS ENUM ('fetched', 'corrected');

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
CREATE TABLE "catalog_status_change" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "ledgerAccountId" TEXT,
    "vatCodeId" TEXT,
    "active" BOOLEAN NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_status_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rate_entry" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "currency" "Currency" NOT NULL,
    "month" DATE NOT NULL,
    "rateMicros" INTEGER NOT NULL,
    "origin" "RateOrigin" NOT NULL,
    "replacesRateMicros" INTEGER,
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
    "entity" "Entity" NOT NULL,
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

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_entity_number_key" ON "ledger_account"("entity", "number");

-- CreateIndex
CREATE UNIQUE INDEX "vat_code_entity_code_key" ON "vat_code"("entity", "code");

-- CreateIndex
CREATE INDEX "catalog_status_change_ledgerAccountId_createdAt_idx" ON "catalog_status_change"("ledgerAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "catalog_status_change_vatCodeId_createdAt_idx" ON "catalog_status_change"("vatCodeId", "createdAt");

-- CreateIndex
CREATE INDEX "exchange_rate_entry_entity_currency_month_createdAt_idx" ON "exchange_rate_entry"("entity", "currency", "month", "createdAt");

-- CreateIndex
CREATE INDEX "exchange_rate_fetch_attempt_entity_month_createdAt_idx" ON "exchange_rate_fetch_attempt"("entity", "month", "createdAt");

-- CreateIndex
CREATE INDEX "exchange_rate_fetch_attempt_entity_createdAt_idx" ON "exchange_rate_fetch_attempt"("entity", "createdAt");

-- AddForeignKey
ALTER TABLE "catalog_status_change" ADD CONSTRAINT "catalog_status_change_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_status_change" ADD CONSTRAINT "catalog_status_change_vatCodeId_fkey" FOREIGN KEY ("vatCodeId") REFERENCES "vat_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written SQL (Prisma cannot express any of this) ─────────────────────
-- Drift between this block and schema.prisma is guarded by the src/lib/db.*.test.ts
-- files (plan R11 of 20261118). Never edit generated sources; never edit this
-- migration after it has been deployed (ADR 20261119-data-that-moves-from-one-service-…).

-- ─── 1. Append-only tables (ADR 20260716-immutable-financial-audit-trail-refund) ───────────────
--
-- One raising BEFORE UPDATE / BEFORE DELETE trigger per table, the shape of refund-api's
-- accounting_history_immutable(): a raise, not a silent no-op rule, so an inadvertent write fails
-- loudly. It covers all five tables: an entry is never edited or deleted (AC-1.12, AC-1.7: a VAT
-- code's rate and an entry's entity can never change), and neither is an audit row (AC-1.13), a
-- rate, a correction or a fetch attempt. TRUNCATE does not fire row triggers, which is what lets
-- test cleanup reset the tables.
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

CREATE TRIGGER catalog_status_change_no_update BEFORE UPDATE ON "catalog_status_change"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER catalog_status_change_no_delete BEFORE DELETE ON "catalog_status_change"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER exchange_rate_entry_no_update BEFORE UPDATE ON "exchange_rate_entry"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER exchange_rate_entry_no_delete BEFORE DELETE ON "exchange_rate_entry"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

CREATE TRIGGER exchange_rate_fetch_attempt_no_update BEFORE UPDATE ON "exchange_rate_fetch_attempt"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();
CREATE TRIGGER exchange_rate_fetch_attempt_no_delete BEFORE DELETE ON "exchange_rate_fetch_attempt"
FOR EACH ROW EXECUTE FUNCTION accounting_history_immutable();

-- ─── 2. CHECK constraints ─────────────────────────────────────────────────────
-- The application validates and trims first (AC-1.2, AC-1.5, AC-2.5) and answers with a field-level
-- 422; these are the wall behind it, so no code path and no direct request can store a bad row.

-- AC-1.2: digits separated by single dots, at most 20 characters; a name of 1..120 once trimmed.
ALTER TABLE "ledger_account"
  ADD CONSTRAINT "ledger_account_number_format" CHECK ("number" ~ '^[0-9]+(\.[0-9]+)*$' AND length("number") <= 20),
  ADD CONSTRAINT "ledger_account_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 120);

-- AC-1.5: a code of capital letters, digits, "_" and "-" (the application upper-cases first, so
-- "imp81" and "IMP81" are one code), a label of 1..80, a rate of 0..100 % in basis points.
ALTER TABLE "vat_code"
  ADD CONSTRAINT "vat_code_code_format" CHECK ("code" ~ '^[A-Z0-9_-]{1,16}$'),
  ADD CONSTRAINT "vat_code_label_length" CHECK (length(btrim("label")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "vat_code_rate_range" CHECK ("rateBasisPoints" BETWEEN 0 AND 10000);

-- A status row names exactly one entry.
ALTER TABLE "catalog_status_change"
  ADD CONSTRAINT "catalog_status_change_one_of" CHECK (num_nonnulls("ledgerAccountId", "vatCodeId") = 1);

-- AC-2.5 and the shape of a rate row.
--   * 0 < rate < 1000 (in micros: 0 < x < 1e9); the previous value, when a correction has one, too;
--   * the month is the first day of a month;
--   * the entity's own currency has no rate (CHF for welld_ch, EUR for welld_it);
--   * a fetched row says where and when it was read and replaces nothing; a corrected row carries
--     none of the fetch fields (it may carry the value it replaced; the first has none to replace).
ALTER TABLE "exchange_rate_entry"
  ADD CONSTRAINT "exchange_rate_entry_rate_range" CHECK ("rateMicros" > 0 AND "rateMicros" < 1000000000),
  ADD CONSTRAINT "exchange_rate_entry_replaces_range" CHECK ("replacesRateMicros" IS NULL OR ("replacesRateMicros" > 0 AND "replacesRateMicros" < 1000000000)),
  ADD CONSTRAINT "exchange_rate_entry_month_first_day" CHECK (EXTRACT(DAY FROM "month") = 1),
  ADD CONSTRAINT "exchange_rate_entry_not_own_currency" CHECK (
    ("entity" = 'welld_ch' AND "currency" <> 'CHF') OR ("entity" = 'welld_it' AND "currency" <> 'EUR')
  ),
  ADD CONSTRAINT "exchange_rate_entry_origin_fields" CHECK (
    ("origin" = 'fetched' AND "sourceUrl" IS NOT NULL AND "sourceMonth" IS NOT NULL AND "fetchedAt" IS NOT NULL AND "replacesRateMicros" IS NULL)
    OR
    ("origin" = 'corrected' AND "sourceUrl" IS NULL AND "sourceMonth" IS NULL AND "fetchedAt" IS NULL)
  );

-- ─── 3. A status row names its entry's entity (AC-1.13) ───────────────────────
-- `entity` on catalog_status_change is a copy of the entry's, so each audit row names the entity on
-- its own. BEFORE INSERT: the copy must be the entry's own entity, whatever the caller sends. An
-- unknown entry, or a row with no entry, is left to the foreign key and the one-of CHECK.
CREATE FUNCTION catalog_status_entity_matches() RETURNS TRIGGER AS $$
DECLARE
  entry_entity "Entity";
BEGIN
  IF NEW."ledgerAccountId" IS NOT NULL THEN
    SELECT "entity" INTO entry_entity FROM "ledger_account" WHERE id = NEW."ledgerAccountId";
    IF FOUND AND entry_entity <> NEW."entity" THEN
      RAISE EXCEPTION 'catalog_status_change entity % does not match the entity % of its ledger account', NEW."entity", entry_entity
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF NEW."vatCodeId" IS NOT NULL THEN
    SELECT "entity" INTO entry_entity FROM "vat_code" WHERE id = NEW."vatCodeId";
    IF FOUND AND entry_entity <> NEW."entity" THEN
      RAISE EXCEPTION 'catalog_status_change entity % does not match the entity % of its VAT code', NEW."entity", entry_entity
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER catalog_status_entity_matches BEFORE INSERT ON "catalog_status_change"
FOR EACH ROW EXECUTE FUNCTION catalog_status_entity_matches();

-- ─── 4. A fetched rate is recorded once and never replaced (AC-2.2) ───────────
-- A correction is a further row of origin 'corrected', which is not constrained. Per entity: the
-- same currency and month of two entities are two keys.
CREATE UNIQUE INDEX "exchange_rate_fetched_once"
  ON "exchange_rate_entry" ("entity", "currency", "month") WHERE "origin" = 'fetched';
