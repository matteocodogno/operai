-- CreateTable
CREATE TABLE "estimate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "estimate_userId_updatedAt_idx" ON "estimate"("userId", "updatedAt" DESC);
