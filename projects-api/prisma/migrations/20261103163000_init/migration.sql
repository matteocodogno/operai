
-- CreateEnum
CREATE TYPE "Entity" AS ENUM ('welld_ch', 'welld_it');

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('t_and_m', 'fixed_price', 'maintenance', 'saas', 'internal');

-- CreateEnum
CREATE TYPE "ProjectState" AS ENUM ('planned', 'active', 'on_hold', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "ContractOrigin" AS ENUM ('manual', 'deal');

-- CreateEnum
CREATE TYPE "HourPackageKind" AS ENUM ('capacity', 'yearly');

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "type" "ProjectType" NOT NULL,
    "state" "ProjectState" NOT NULL DEFAULT 'planned',
    "stateBeforeHold" "ProjectState",
    "entity" "Entity" NOT NULL,
    "companyId" TEXT,
    "projectManagerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_member" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "contract" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ProjectType" NOT NULL,
    "companyId" TEXT NOT NULL,
    "origin" "ContractOrigin" NOT NULL DEFAULT 'manual',
    "dealId" TEXT,
    "bexioOrderId" VARCHAR(64),
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deadline" DATE,
    "estimatedManDays" DECIMAL(6,1),
    "maxEffortManDays" DECIMAL(6,1),
    "slaHighDays" INTEGER,
    "slaNormalDays" INTEGER,
    "hourPackageHours" INTEGER,
    "hourPackageKind" "HourPackageKind",
    "hourPackageStart" DATE,
    "hourPackageExpiry" DATE,

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_position" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "profile" VARCHAR(120) NOT NULL,
    "plannedManDays" DECIMAL(6,1) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "contract_position_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_projectManagerId_idx" ON "project"("projectManagerId");

-- CreateIndex
CREATE INDEX "project_state_idx" ON "project"("state");

-- CreateIndex
CREATE INDEX "project_type_idx" ON "project"("type");

-- CreateIndex
CREATE INDEX "project_companyId_idx" ON "project"("companyId");

-- CreateIndex
CREATE INDEX "project_member_userId_idx" ON "project_member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_dealId_key" ON "contract"("dealId");

-- CreateIndex
CREATE INDEX "contract_projectId_idx" ON "contract"("projectId");

-- CreateIndex
CREATE INDEX "contract_companyId_idx" ON "contract"("companyId");

-- CreateIndex
CREATE INDEX "contract_position_contractId_idx" ON "contract_position"("contractId");

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_position" ADD CONSTRAINT "contract_position_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── CHECK constraints (Prisma cannot express them; specs/021 tasks.md § Data model) ───
-- Every expression is written so a NULL operand fails it: a CHECK passes on NULL, and the
-- NULL-able terms (max effort, expiry, kind) are exactly where that would let a row through.

-- A client project has a company, and only a client project does (AC-1.1). `stateBeforeHold`
-- is the state an on-hold project returns to: set iff on hold, and only a planned or active
-- project can be put on hold (AC-1.3).
ALTER TABLE "project"
  ADD CONSTRAINT "project_name_not_blank" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "project_company_iff_client_type"
    CHECK (("type" IN ('t_and_m', 'fixed_price', 'maintenance')) = ("companyId" IS NOT NULL)),
  ADD CONSTRAINT "project_state_before_hold_iff_on_hold"
    CHECK (("state" = 'on_hold') = ("stateBeforeHold" IS NOT NULL)),
  ADD CONSTRAINT "project_state_before_hold_from_open_state"
    CHECK ("stateBeforeHold" IS NULL OR "stateBeforeHold" IN ('planned', 'active'));

ALTER TABLE "contract"
  -- AC-2.1: a contract never ends before it starts.
  ADD CONSTRAINT "contract_dates_ordered" CHECK ("endDate" IS NULL OR "endDate" >= "startDate"),
  -- AC-2.3: a fixed price contract has its deadline and a max effort above zero; the
  -- estimate is optional but never negative.
  ADD CONSTRAINT "contract_fixed_price_terms"
    CHECK ("type" <> 'fixed_price'
           OR ("deadline" IS NOT NULL AND "maxEffortManDays" IS NOT NULL AND "maxEffortManDays" > 0)),
  ADD CONSTRAINT "contract_estimated_man_days_non_negative"
    CHECK ("estimatedManDays" IS NULL OR "estimatedManDays" >= 0),
  -- AC-2.4: a maintenance contract has an SLA, an hour package, or both.
  ADD CONSTRAINT "contract_maintenance_needs_sla_or_hours"
    CHECK ("type" <> 'maintenance' OR "slaHighDays" IS NOT NULL OR "hourPackageHours" IS NOT NULL),
  -- AC-2.5: an SLA is both priorities or neither, each 0-60 working days.
  ADD CONSTRAINT "contract_sla_pair" CHECK (("slaHighDays" IS NULL) = ("slaNormalDays" IS NULL)),
  ADD CONSTRAINT "contract_sla_range"
    CHECK (("slaHighDays" IS NULL OR "slaHighDays" BETWEEN 0 AND 60)
           AND ("slaNormalDays" IS NULL OR "slaNormalDays" BETWEEN 0 AND 60)),
  -- AC-2.6: an hour package is hours, kind and start together or none of them; more than
  -- zero hours; an expiry only on a capacity package.
  ADD CONSTRAINT "contract_hour_package_group"
    CHECK (("hourPackageHours" IS NULL) = ("hourPackageKind" IS NULL)
           AND ("hourPackageHours" IS NULL) = ("hourPackageStart" IS NULL)),
  ADD CONSTRAINT "contract_hour_package_hours_positive"
    CHECK ("hourPackageHours" IS NULL OR "hourPackageHours" > 0),
  ADD CONSTRAINT "contract_hour_package_expiry_capacity_only"
    CHECK ("hourPackageExpiry" IS NULL OR ("hourPackageKind" IS NOT NULL AND "hourPackageKind" = 'capacity'));

-- AC-2.7: a position has planned man-days above zero and a profile name.
ALTER TABLE "contract_position"
  ADD CONSTRAINT "contract_position_man_days_positive" CHECK ("plannedManDays" > 0),
  ADD CONSTRAINT "contract_position_profile_not_blank" CHECK (length(btrim("profile")) > 0);
