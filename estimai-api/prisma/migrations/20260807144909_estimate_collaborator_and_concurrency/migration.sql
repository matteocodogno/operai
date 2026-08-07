-- CreateEnum
CREATE TYPE "EstimateAccessLevel" AS ENUM ('viewer', 'editor');

-- AlterTable
ALTER TABLE "estimate" ADD COLUMN     "lastModifiedByUserId" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "estimate_collaborator" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "accessLevel" "EstimateAccessLevel" NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_collaborator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "estimate_collaborator_userId_estimateId_idx" ON "estimate_collaborator"("userId", "estimateId");

-- CreateIndex
CREATE INDEX "estimate_collaborator_estimateId_email_idx" ON "estimate_collaborator"("estimateId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_collaborator_estimateId_userId_key" ON "estimate_collaborator"("estimateId", "userId");

-- AddForeignKey
ALTER TABLE "estimate_collaborator" ADD CONSTRAINT "estimate_collaborator_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
