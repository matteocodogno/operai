-- CreateEnum
CREATE TYPE "Entity" AS ENUM ('welld_it', 'welld_ch');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('EUR', 'CHF');

-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('laptop', 'desktop', 'phone', 'tablet', 'monitor', 'peripheral', 'other');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ordered', 'in_stock', 'assigned', 'in_repair', 'lost', 'disposed');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('pending', 'confirmed', 'declined', 'cancelled');

-- CreateEnum
CREATE TYPE "DisposalReason" AS ENUM ('ceded_to_employee', 'sold', 'scrapped', 'returned_to_vendor', 'lost');

-- CreateEnum
CREATE TYPE "FirstYearShare" AS ENUM ('full', 'half');

-- CreateEnum
CREATE TYPE "FigureSource" AS ENUM ('closed', 'imported');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('pending', 'stored');

-- CreateEnum
CREATE TYPE "AssetEventAction" AS ENUM ('registered', 'received', 'edited', 'assignment_created', 'assignment_confirmed', 'assignment_declined', 'assignment_cancelled', 'returned', 'repair_started', 'repair_finished', 'marked_lost', 'marked_found', 'disposed', 'invoice_file_linked', 'verified', 'fiscal_year_closed', 'imported');

-- CreateTable
CREATE TABLE "asset" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "currency" "Currency" NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "serialNumber" TEXT,
    "purchaseDate" DATE NOT NULL,
    "purchasePriceCents" INTEGER NOT NULL,
    "status" "AssetStatus" NOT NULL,
    "holderUserId" TEXT,
    "locationNote" TEXT,
    "supplier" TEXT,
    "invoiceRef" TEXT,
    "invoiceFileId" TEXT,
    "toVerify" BOOLEAN NOT NULL DEFAULT false,
    "legacyImported" BOOLEAN NOT NULL DEFAULT false,
    "disposedOn" DATE,
    "disposalReason" "DisposalReason",
    "salePriceCents" INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assigneeUserId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'pending',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_rule" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "usefulLifeYears" INTEGER NOT NULL,
    "firstYearShare" "FirstYearShare" NOT NULL,
    "lowValueThresholdCents" INTEGER,
    "residualCents" INTEGER NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "depreciation_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_year" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "year" INTEGER NOT NULL,
    "openingCents" INTEGER NOT NULL,
    "disposalsCents" INTEGER NOT NULL,
    "purchasesCents" INTEGER NOT NULL,
    "depreciationCents" INTEGER NOT NULL,
    "closingCents" INTEGER NOT NULL,
    "source" "FigureSource" NOT NULL,
    "closedByUserId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_year_figure" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "year" INTEGER NOT NULL,
    "openingCents" INTEGER NOT NULL,
    "purchaseCents" INTEGER NOT NULL,
    "depreciationCents" INTEGER NOT NULL,
    "disposalCents" INTEGER NOT NULL,
    "closingCents" INTEGER NOT NULL,
    "source" "FigureSource" NOT NULL,

    CONSTRAINT "asset_year_figure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_file" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "invoiceRef" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadStatus" "UploadStatus" NOT NULL DEFAULT 'pending',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_event" (
    "id" TEXT NOT NULL,
    "assetId" TEXT,
    "entity" "Entity" NOT NULL,
    "action" "AssetEventAction" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_entity_status_idx" ON "asset"("entity", "status");

-- CreateIndex
CREATE INDEX "asset_holderUserId_idx" ON "asset"("holderUserId");

-- CreateIndex
CREATE INDEX "asset_entity_invoiceRef_idx" ON "asset"("entity", "invoiceRef");

-- CreateIndex
CREATE INDEX "asset_entity_purchaseDate_idx" ON "asset"("entity", "purchaseDate");

-- CreateIndex
CREATE INDEX "assignment_assigneeUserId_status_idx" ON "assignment"("assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "assignment_assetId_createdAt_idx" ON "assignment"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "depreciation_rule_entity_effectiveFrom_createdAt_idx" ON "depreciation_rule"("entity", "effectiveFrom", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_year_entity_year_key" ON "fiscal_year"("entity", "year");

-- CreateIndex
CREATE INDEX "asset_year_figure_entity_year_idx" ON "asset_year_figure"("entity", "year");

-- CreateIndex
CREATE UNIQUE INDEX "asset_year_figure_assetId_year_key" ON "asset_year_figure"("assetId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_file_objectKey_key" ON "invoice_file"("objectKey");

-- CreateIndex
CREATE INDEX "invoice_file_entity_invoiceRef_idx" ON "invoice_file"("entity", "invoiceRef");

-- CreateIndex
CREATE INDEX "asset_event_assetId_createdAt_idx" ON "asset_event"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "asset_event_entity_createdAt_idx" ON "asset_event"("entity", "createdAt");

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_invoiceFileId_fkey" FOREIGN KEY ("invoiceFileId") REFERENCES "invoice_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Hand-written section (specs/015-hardware-inventory, T2) ─────────────────
-- Everything below is what Prisma cannot express. It is the enforcement, not a
-- duplicate of the models: application code checks the same rules first so it
-- can answer with a friendly Problem JSON, and these are the backstop.

-- Partial unique indexes ------------------------------------------------------

-- AC-1.5: one LIVE asset per (entity, serial number). A disposed asset frees its
-- serial for a replacement unit; a NULL serial (AC-1.4) is never constrained.
CREATE UNIQUE INDEX "asset_serial_live" ON "asset" ("entity", "serialNumber")
  WHERE "serialNumber" IS NOT NULL AND "status" <> 'disposed';

-- AC-2.2: at most one pending assignment per asset. This index, not an
-- application check, is what makes two concurrent assigns yield exactly one
-- winner (the loser's unique violation maps to 409 assignment_pending).
CREATE UNIQUE INDEX "assignment_one_pending" ON "assignment" ("assetId")
  WHERE "status" = 'pending';

-- CHECK constraints -----------------------------------------------------------

-- AC-1.2: the currency follows the entity, always.
ALTER TABLE "asset" ADD CONSTRAINT "asset_currency_follows_entity"
  CHECK (
    ("entity" = 'welld_ch' AND "currency" = 'CHF')
    OR ("entity" = 'welld_it' AND "currency" = 'EUR')
  );

-- AC-1.6: a price is a positive number of cents.
ALTER TABLE "asset" ADD CONSTRAINT "asset_price_positive"
  CHECK ("purchasePriceCents" > 0);

-- AC-6.4: the bounds a depreciation rule must respect.
ALTER TABLE "depreciation_rule" ADD CONSTRAINT "depreciation_rule_life_min"
  CHECK ("usefulLifeYears" >= 1);
ALTER TABLE "depreciation_rule" ADD CONSTRAINT "depreciation_rule_threshold_min"
  CHECK ("lowValueThresholdCents" IS NULL OR "lowValueThresholdCents" >= 0);
ALTER TABLE "depreciation_rule" ADD CONSTRAINT "depreciation_rule_residual_min"
  CHECK ("residualCents" >= 0);

-- Tier 1 immutability (ADR-0018 / 0024 / 0033 / 0046) -------------------------
--
-- depreciation_rule, fiscal_year, asset_year_figure and asset_event are
-- append-only at the DATABASE level (AC-6.5, AC-8.7, AC-11.2: "no user,
-- including an administrator"), not merely by the absence of an UPDATE/DELETE
-- route. A raising BEFORE trigger, not a silent `CREATE RULE ... DO INSTEAD
-- NOTHING`, so a migration mistake, an ad hoc production query or a restore
-- script fails loudly. Same shape as refund-api's mileage_rate_immutable().
--
-- One generic function serves all four tables (TG_TABLE_NAME names the table in
-- the message). Row-level triggers do not fire on TRUNCATE, which is how the
-- tests reset fixtures without being blocked by the guarantee under test.
--
-- None of these tables has an inbound foreign key with a referential action: an
-- FK-initiated SET NULL / CASCADE is an UPDATE / DELETE that a BEFORE trigger
-- would abort (the trap ADR-0033 records for audit_log). asset_event.assetId and
-- asset_year_figure.assetId are therefore plain columns, not FKs, and assets are
-- never deleted anyway.
CREATE FUNCTION "inventory_append_only"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only and cannot be updated or deleted (id=%)', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "depreciation_rule_no_update" BEFORE UPDATE ON "depreciation_rule"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();
CREATE TRIGGER "depreciation_rule_no_delete" BEFORE DELETE ON "depreciation_rule"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();

CREATE TRIGGER "fiscal_year_no_update" BEFORE UPDATE ON "fiscal_year"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();
CREATE TRIGGER "fiscal_year_no_delete" BEFORE DELETE ON "fiscal_year"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();

CREATE TRIGGER "asset_year_figure_no_update" BEFORE UPDATE ON "asset_year_figure"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();
CREATE TRIGGER "asset_year_figure_no_delete" BEFORE DELETE ON "asset_year_figure"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();

CREATE TRIGGER "asset_event_no_update" BEFORE UPDATE ON "asset_event"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();
CREATE TRIGGER "asset_event_no_delete" BEFORE DELETE ON "asset_event"
  FOR EACH ROW EXECUTE FUNCTION "inventory_append_only"();

-- Launch depreciation rules (AC-6.6) -------------------------------------------
--
-- Seeded rows, not code: the wellD IT rule is unconfirmed (spec O1), and a
-- correction before any wellD IT year is closed is a NEW rule row, never an
-- edit (the table is append-only). Both are effective from 2000-01-01, which
-- precedes every purchase date (the earliest imported one included), so every
-- asset resolves to a rule. Fixed ids so the seed is recognisable and
-- re-runnable in reading; the actor is the system, not a person.
INSERT INTO "depreciation_rule"
  ("id", "entity", "effectiveFrom", "usefulLifeYears", "firstYearShare",
   "lowValueThresholdCents", "residualCents", "createdByUserId", "createdByEmail")
VALUES
  -- AC-5.1: 3 years, full first year, no low-value threshold, residual CHF 1.00
  ('rule_launch_welld_ch', 'welld_ch', DATE '2000-01-01', 3, 'full', NULL, 100,
   'system:launch-seed', 'system:launch-seed'),
  -- AC-5.4: 5 years, half first year, EUR 516.46 low-value threshold, no residual
  ('rule_launch_welld_it', 'welld_it', DATE '2000-01-01', 5, 'half', 51646, 0,
   'system:launch-seed', 'system:launch-seed');
