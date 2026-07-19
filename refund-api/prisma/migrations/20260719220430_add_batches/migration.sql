-- specs/008-refund-monthly-processing (T1) — `paid` status, batch tables,
-- audit extension. ADR-0020 (batch/paid lifecycle) + ADR-0022 (audit
-- extension). Never edit 007's 20260716133804_init or
-- 20260717120000_add_line_currency — this is a new, appended migration.
--
-- ── Enum-value-then-DDL ordering (ADR-0020 Risk R6, CRITICAL) ──────────────
-- `ALTER TYPE ... ADD VALUE` adds a value to an EXISTING enum type
-- ("RefundStatus" and "AuditAction" both predate this migration, from
-- 0001_init). PostgreSQL forbids USING a value added this way inside the
-- same transaction that added it (comparisons, DEFAULTs, CASTs, etc.) — and
-- on PostgreSQL 11 and earlier, ADD VALUE cannot run inside a transaction
-- block AT ALL. Both enum-value additions below are therefore emitted as
-- their own statements, BEFORE any table DDL, and neither new value
-- ('paid', 'batch_compiled', 'batch_paid', 'batch_discarded') is referenced
-- by any DEFAULT/INSERT/comparison later in this same file — so this
-- migration is safe to run as a single transaction (verified against local
-- PostgreSQL 17; the ordering below also keeps it correct if a future
-- deploy target ever runs per-statement/autocommit instead).
--
-- `BatchStatus` is a BRAND NEW enum (CREATE TYPE, not ALTER TYPE ADD VALUE)
-- — no such restriction applies to it, so `refund_batch.status DEFAULT
-- 'compiled'` further down is safe even in the same transaction that
-- creates the type.

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('compiled', 'paid', 'discarded');

-- AlterEnum (own statements, before all dependent DDL — see header)
ALTER TYPE "RefundStatus" ADD VALUE 'paid';

-- AlterEnum (own statements, before all dependent DDL — see header)
-- This migration adds more than one value to an enum. With PostgreSQL
-- versions 11 and earlier this cannot happen inside a single transaction —
-- see header comment for why this migration remains one transaction here.
ALTER TYPE "AuditAction" ADD VALUE 'batch_compiled';
ALTER TYPE "AuditAction" ADD VALUE 'batch_paid';
ALTER TYPE "AuditAction" ADD VALUE 'batch_discarded';

-- ── Everything below references only BatchStatus (created above, same tx-
-- safe) and plain TEXT/FK columns — it never uses 'paid'/'batch_*' as a
-- literal value, so it does not trip the "new enum value used in the same
-- transaction it was added" restriction. ──────────────────────────────────

-- AlterTable — live claim pointer (ADR-0020 decision 3)
ALTER TABLE "refund_request" ADD COLUMN     "batchId" TEXT;

-- AlterTable — set on batch_compiled|batch_paid|batch_discarded rows only (ADR-0022)
ALTER TABLE "refund_audit_entry" ADD COLUMN     "batchId" TEXT;

-- CreateTable
CREATE TABLE "refund_batch" (
    "id" TEXT NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'compiled',
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "pdfObjectKey" TEXT NOT NULL,
    "recipientEmailSnapshot" TEXT NOT NULL,
    "emailStatus" TEXT,
    "emailLastAttemptAt" TIMESTAMP(3),
    "emailDeliveryId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidByEmail" TEXT,
    "discardedAt" TIMESTAMP(3),
    "discardedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable — append-only membership snapshot (ADR-0020 decision 3), never
-- deleted, `onDelete: Restrict` on both FKs below.
CREATE TABLE "refund_batch_item" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_batch_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refund_batch_pdfObjectKey_key" ON "refund_batch"("pdfObjectKey");

-- CreateIndex — history list (AC-8.1/8.2)
CREATE INDEX "refund_batch_status_createdAt_idx" ON "refund_batch"("status", "createdAt");

-- CreateIndex — AC-7.3 "which batches has this request ever been in"
CREATE INDEX "refund_batch_item_requestId_idx" ON "refund_batch_item"("requestId");

-- CreateIndex — a request appears once per batch
CREATE UNIQUE INDEX "refund_batch_item_batchId_requestId_key" ON "refund_batch_item"("batchId", "requestId");

-- CreateIndex — AC-7.1 "the full set of request IDs affected" per (batchId, action)
CREATE INDEX "refund_audit_entry_batchId_idx" ON "refund_audit_entry"("batchId");

-- CreateIndex — candidate query: approved ∧ batchId NULL ∧ decidedAt<=cutoff (AC-1.2)
CREATE INDEX "refund_request_status_batchId_decidedAt_idx" ON "refund_request"("status", "batchId", "decidedAt");

-- AddForeignKey — onDelete: Restrict, a claimed request cannot be deleted out from under its batch
ALTER TABLE "refund_request" ADD CONSTRAINT "refund_request_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "refund_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — onDelete: Restrict, a batch with items is undeletable
ALTER TABLE "refund_batch_item" ADD CONSTRAINT "refund_batch_item_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "refund_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — onDelete: Restrict, extends 007's AC-8.3 to batch-touched requests
ALTER TABLE "refund_batch_item" ADD CONSTRAINT "refund_batch_item_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "refund_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — onDelete: Restrict, matches the requestId FK on refund_audit_entry (ADR-0018/0022)
ALTER TABLE "refund_audit_entry" ADD CONSTRAINT "refund_audit_entry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "refund_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
