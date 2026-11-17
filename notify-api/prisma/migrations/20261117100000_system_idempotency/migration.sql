-- specs/20261117-legal-entities T56 (AC-9.13, AC-9.14; plan G4): receiver-side repeat protection for the two
-- internal send routes. ADDITIVE ONLY: nullable columns, new indexes, one CHECK on the new columns; existing rows
-- and callers are untouched and a deploy can roll back by ignoring the columns.

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "callerSub" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "email_delivery" ADD COLUMN     "callerSub" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE INDEX "email_delivery_callerSub_idempotencyKey_idx" ON "email_delivery"("callerSub", "idempotencyKey");

-- Hand-written (Prisma cannot express partial indexes): one notification per (caller, key). Two concurrent calls
-- with the same key race on this index; the loser reads the winner. Rows without a key are outside it.
CREATE UNIQUE INDEX "notification_callerSub_idempotencyKey_key"
    ON "notification"("callerSub", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;

-- Hand-written: at most one SENT delivery per (caller, key) (failed attempts may repeat). A key never exists
-- without its caller, so the unique indexes above cannot be sidestepped by a NULL callerSub.
CREATE UNIQUE INDEX "email_delivery_callerSub_idempotencyKey_sent_key"
    ON "email_delivery"("callerSub", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL AND "status" = 'sent';

ALTER TABLE "notification" ADD CONSTRAINT "notification_idempotencyKey_needs_caller"
    CHECK ("idempotencyKey" IS NULL OR "callerSub" IS NOT NULL);
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_idempotencyKey_needs_caller"
    CHECK ("idempotencyKey" IS NULL OR "callerSub" IS NOT NULL);
