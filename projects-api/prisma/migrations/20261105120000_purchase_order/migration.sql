-- specs/022-projects-handoff T23: contract → project terms + purchase order.
--
-- A project has 0..1 terms (what the `contract` table held, minus its deal and Bexio columns) and
-- 0..1 purchase order (new: what a won deal brings). Built on specs/021's `*_init`, which ships first
-- and is never edited.
--
-- NO DATA CONVERSION. What the new model cannot represent unambiguously is refused by the guard below
-- and must be handled by hand before this migration runs:
--   - a `contract` row: terms are one row per project, and a contract also carried a company, an origin
--     and a Bexio order id that have no place in them (a purchase order exists only for a won deal);
--   - a `saas` project: it had no company, and `saas` is now a client type that always has one (D40).
-- A database with projects but no contract and no saas project migrates untouched.

DO $$
DECLARE
  contracts integer;
  saas_projects integer;
BEGIN
  SELECT count(*) INTO contracts FROM "contract";
  IF contracts > 0 THEN
    RAISE EXCEPTION 'migration purchase_order refused: table "contract" holds % row(s). Terms are one row per project and a purchase order exists only for a won deal, so contracts cannot be converted automatically: move or delete them by hand, then run the migration again.', contracts;
  END IF;
  SELECT count(*) INTO saas_projects FROM "project" WHERE "type" = 'saas';
  IF saas_projects > 0 THEN
    RAISE EXCEPTION 'migration purchase_order refused: % saas project(s) exist. A saas project now has its own company (one project per licence) and these have none: recreate them with a company, or delete them, by hand, then run the migration again.', saas_projects;
  END IF;
END $$;

-- ─── project ─────────────────────────────────────────────────────────────────
-- A project made from a deal has no project manager until the ops-manager picks one (D42); the API
-- keeps it null only while the project has a purchase order. `saas` is a client type: a company
-- iff the type is not `internal` (D40).
ALTER TABLE "project" ALTER COLUMN "projectManagerId" DROP NOT NULL;

ALTER TABLE "project"
  DROP CONSTRAINT "project_company_iff_client_type",
  ADD CONSTRAINT "project_company_matches_type"
    CHECK (("companyId" IS NULL) = ("type" = 'internal'));

-- ─── contract → project_terms ────────────────────────────────────────────────
ALTER TABLE "contract" RENAME TO "project_terms";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_pkey" TO "project_terms_pkey";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_projectId_fkey" TO "project_terms_projectId_fkey";

-- What a won deal brings moves to `purchase_order`; the company is the project's own. Dropping a column
-- drops the index on it (`contract_companyId_idx`, the unique `contract_dealId_key`).
ALTER TABLE "project_terms"
  DROP COLUMN "companyId",
  DROP COLUMN "origin",
  DROP COLUMN "dealId",
  DROP COLUMN "bexioOrderId";

DROP TYPE "ContractOrigin";

-- One terms row per project (the table is empty: the guard saw to it).
DROP INDEX "contract_projectId_idx";
CREATE UNIQUE INDEX "project_terms_projectId_key" ON "project_terms"("projectId");

-- Every specs/021 CHECK stays, renamed; terms never sit on an internal project (D38, D50).
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_dates_ordered" TO "terms_dates_ordered";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_fixed_price_terms" TO "terms_fixed_price_terms";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_estimated_man_days_non_negative" TO "terms_estimated_man_days_non_negative";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_maintenance_needs_sla_or_hours" TO "terms_maintenance_needs_sla_or_hours";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_sla_pair" TO "terms_sla_pair";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_sla_range" TO "terms_sla_range";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_hour_package_group" TO "terms_hour_package_group";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_hour_package_hours_positive" TO "terms_hour_package_hours_positive";
ALTER TABLE "project_terms" RENAME CONSTRAINT "contract_hour_package_expiry_capacity_only" TO "terms_hour_package_expiry_capacity_only";
ALTER TABLE "project_terms" ADD CONSTRAINT "terms_not_internal" CHECK ("type" <> 'internal');

-- ─── contract_position → project_terms_position ──────────────────────────────
ALTER TABLE "contract_position" RENAME TO "project_terms_position";
ALTER TABLE "project_terms_position" RENAME COLUMN "contractId" TO "termsId";
ALTER TABLE "project_terms_position" RENAME CONSTRAINT "contract_position_pkey" TO "project_terms_position_pkey";
ALTER TABLE "project_terms_position" RENAME CONSTRAINT "contract_position_contractId_fkey" TO "project_terms_position_termsId_fkey";
ALTER INDEX "contract_position_contractId_idx" RENAME TO "project_terms_position_termsId_idx";
ALTER TABLE "project_terms_position" RENAME CONSTRAINT "contract_position_man_days_positive" TO "terms_position_man_days_positive";
ALTER TABLE "project_terms_position" RENAME CONSTRAINT "contract_position_profile_not_blank" TO "terms_position_profile_not_blank";

-- ─── purchase_order ──────────────────────────────────────────────────────────
-- The delivery-side record of one won deal, 0..1 per project, born with its project in the take of a
-- deal (D38). One per deal (AC-1.6, the database half) and one per project; an ops-manager always.
CREATE TABLE "purchase_order" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "estimateId" TEXT,
    "bexioOrderId" VARCHAR(64),
    "referentContactId" TEXT,
    "opsManagerId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_order_projectId_key" ON "purchase_order"("projectId");

CREATE UNIQUE INDEX "purchase_order_dealId_key" ON "purchase_order"("dealId");

ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
