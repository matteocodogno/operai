-- CreateTable
CREATE TABLE "legal_entity_notice" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipientKind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastReason" TEXT,
    "firstFailedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "givenUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_entity_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_entity_notice_status_nextAttemptAt_idx" ON "legal_entity_notice"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "legal_entity_notice_entity_version_recipient_channel_key" ON "legal_entity_notice"("entity", "version", "recipient", "channel");

-- AddForeignKey
-- RESTRICT: a version that a notice names cannot go (the version table is Tier 1 and refuses DELETE anyway).
ALTER TABLE "legal_entity_notice" ADD CONSTRAINT "legal_entity_notice_entity_version_fkey" FOREIGN KEY ("entity", "version") REFERENCES "legal_entity_version"("entity", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-appended raw SQL (Prisma cannot express CHECKs), same convention as
-- prisma/migrations/20261117100000_legal_entities/migration.sql.
--
-- specs/20261117-legal-entities (T58, plan amendment 2026-11-17 G4). Tier 2 like audit_log (ADR
-- 20260804-two-tier-audit-assurance-auth-audit-log-application-level): the dispatcher (T59) updates status
-- columns, so there is deliberately NO immutability trigger here (that is the version table's Tier 1 guard).
-- The table holds no value of any detail and never the outside address (AC-9.12).
ALTER TABLE legal_entity_notice ADD CONSTRAINT legal_entity_notice_entity CHECK (entity IN ('welld_it','welld_ch'));
ALTER TABLE legal_entity_notice ADD CONSTRAINT legal_entity_notice_recipient_kind CHECK ("recipientKind" IN ('person','outside'));
ALTER TABLE legal_entity_notice ADD CONSTRAINT legal_entity_notice_channel CHECK (channel IN ('in_app','email'));
ALTER TABLE legal_entity_notice ADD CONSTRAINT legal_entity_notice_status CHECK (status IN ('pending','delivered','given_up'));
-- The outside mailbox is the one recipient named "outside"; nobody else may use that name (a user id is a cuid).
ALTER TABLE legal_entity_notice ADD CONSTRAINT legal_entity_notice_outside_is_named_outside
  CHECK (("recipientKind" = 'outside') = (recipient = 'outside'));
-- The outside mailbox has no user id: it cannot receive an in-app notice (AC-9.10: email only).
ALTER TABLE legal_entity_notice ADD CONSTRAINT legal_entity_notice_outside_is_email_only
  CHECK ("recipientKind" <> 'outside' OR channel = 'email');
-- Not an import: a version that is the system's import (AC-9.16) is never the subject of a notice. A CHECK cannot see
-- the other table and a trigger is not worth a second Tier 1 surface (plan G4): the writer (notices/duty.ts) only
-- ever takes action 'save' | 'restore', and a test reads the import's code and database for a notice.
