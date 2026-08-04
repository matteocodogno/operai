-- CreateTable
CREATE TABLE "employee_address" (
    "userId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "houseNumber" TEXT NOT NULL,
    "postalCode" TEXT,
    "region" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "employee_address_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-appended raw SQL (Prisma cannot express CHECKs), same convention as
-- refund-api's migrations and auth's own invitation partial index
-- (prisma/migrations/20260713222008_invitation_lifecycle/migration.sql).
--
-- specs/012-employee-address (T1, plan.md "Data model"). This migration adds
-- ONLY the `employee_address` table and these CHECKs — `audit_log` and the
-- `AuditLog` model are NOT touched anywhere in this file (ADR-0033).

-- AC-1.4: a required component may not be blank/whitespace either.
ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_required_nonblank"
  CHECK (btrim("city") <> '' AND btrim("street") <> '' AND btrim("houseNumber") <> '');

ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_country_alpha2"
  CHECK ("countryCode" ~ '^[A-Z]{2}$');

-- AC-2.5/2.6: coordinates are a pair or nothing.
ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_coords_paired"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_coords_range"
  CHECK ("latitude" IS NULL
         OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180));
