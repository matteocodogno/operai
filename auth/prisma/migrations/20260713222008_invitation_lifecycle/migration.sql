-- AlterTable
ALTER TABLE "user" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByUserId" TEXT;

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "roleIds" TEXT[],
    "departmentIds" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedByUserId" TEXT,
    "acceptedByUserId" TEXT,
    "lastEmailStatus" TEXT,
    "lastEmailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE INDEX "invitation_status_idx" ON "invitation"("status");

-- CreateIndex
CREATE INDEX "user_deletedAt_idx" ON "user"("deletedAt");

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreatePartialIndex (hand-written — Prisma schema cannot express a partial
-- unique index, docs/adr/0013): enforces "at most one LIVE pending
-- invitation per email" (AC-1.4) at the database layer using the physical
-- `status` column. The invite-create transaction reconciles any of that
-- email's past-expiry `status='pending'` rows to a terminal status BEFORE
-- inserting (see src/invitations/), so this index never blocks a
-- legitimately fresh invitation for an address whose only prior invitation
-- is dead (AC-1.5/AC-1.14).
CREATE UNIQUE INDEX invitation_pending_email_key ON invitation (email) WHERE status = 'pending';
