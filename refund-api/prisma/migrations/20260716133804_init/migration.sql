-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "Entity" AS ENUM ('welld_it', 'welld_ch');

-- CreateEnum
CREATE TYPE "ExpenseType" AS ENUM ('travel_highway', 'travel_km', 'travel_parking', 'travel_train', 'travel_other_public_transport', 'company_manuals', 'stationery', 'representation_meals', 'representation_gifts', 'office_material', 'postal', 'telephone');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('submitted', 'withdrawn', 'approved', 'rejected', 'approved_total_set');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('pending', 'stored');

-- CreateTable
CREATE TABLE "refund_request" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "ownerName" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decidedByEmail" TEXT,
    "rejectionMotivation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_line" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "ExpenseType" NOT NULL,
    "motivo" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "requestedAmountCents" INTEGER NOT NULL,
    "km" INTEGER,
    "approvedTotalCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadStatus" "UploadStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_audit_entry" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lineId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_audit_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_request_ownerUserId_status_idx" ON "refund_request"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "refund_request_status_idx" ON "refund_request"("status");

-- CreateIndex
CREATE INDEX "refund_line_requestId_idx" ON "refund_line"("requestId");

-- CreateIndex
CREATE INDEX "refund_line_requestId_entity_idx" ON "refund_line"("requestId", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_objectKey_key" ON "attachment"("objectKey");

-- CreateIndex
CREATE INDEX "attachment_lineId_idx" ON "attachment"("lineId");

-- CreateIndex
CREATE INDEX "refund_audit_entry_requestId_createdAt_idx" ON "refund_audit_entry"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "refund_line" ADD CONSTRAINT "refund_line_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "refund_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "refund_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_audit_entry" ADD CONSTRAINT "refund_audit_entry_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "refund_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Audit-trail immutability (US-8, ADR-0018) ─────────────────────────────
--
-- "refund_audit_entry" is append-only at the DATABASE level, not merely by
-- the absence of an UPDATE/DELETE route in refund-api itself (AC-8.2:
-- "cannot be edited or deleted by ANY user, including accounting or admin").
-- ADR-0018 decision 2 explicitly chose a raising BEFORE trigger over a
-- silent `CREATE RULE ... DO INSTEAD NOTHING`, so any inadvertent write
-- attempt (a migration mistake, an ad hoc production query, a future
-- internal tooling script, a disaster-recovery restore) fails loudly rather
-- than being silently no-op'd.
--
-- Combined with the ON DELETE RESTRICT foreign key above, any
-- "refund_request" row that has at least one audit entry (i.e. every request
-- that ever transitioned past `draft`) is already undeletable via the FK;
-- this trigger additionally makes every existing audit row itself
-- unmodifiable and undeletable, independent of and in addition to the
-- application-level route guards.
--
-- Never add an UPDATE or DELETE route for "refund_audit_entry" — this
-- trigger is the enforcement backstop, not a substitute for that omission.
CREATE FUNCTION refund_audit_entry_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'refund_audit_entry rows are append-only and cannot be updated or deleted (id=%)', OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refund_audit_entry_no_update
BEFORE UPDATE ON "refund_audit_entry"
FOR EACH ROW EXECUTE FUNCTION refund_audit_entry_immutable();

CREATE TRIGGER refund_audit_entry_no_delete
BEFORE DELETE ON "refund_audit_entry"
FOR EACH ROW EXECUTE FUNCTION refund_audit_entry_immutable();
