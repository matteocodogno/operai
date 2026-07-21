/**
 * Schema/migration integration tests for T1 (specs/008-refund-monthly-processing,
 * ADR-0020/0022). T1 is schema + migration only — no routes/services exist
 * yet (T2+ land those) — so this file exercises the Prisma client + raw SQL
 * directly against real Postgres, the same strategy as
 * `db.audit-immutability.test.ts`.
 *
 * AC coverage (T1 done-when: "a test asserts the new enum/table shape")
 * ───────────────────────────────────────────────────────────────────
 * - RefundStatus gains `paid`; BatchStatus (`compiled`/`paid`/`discarded`)
 *   and the three new AuditAction values exist and are usable.
 * - RefundBatch / RefundBatchItem exist with the shape plan.md § Data model
 *   specifies: pdfObjectKey uniqueness, @@unique([batchId,requestId]),
 *   onDelete: Restrict on every new FK (RefundRequest.batchId,
 *   RefundBatchItem.batchId/requestId, RefundAuditEntry.batchId).
 * - the candidate-query index (status, batchId, decidedAt) is present.
 * - (ADR-0020 decision 1) `paid` inherits 007's mutation immunity for free —
 *   a `paid` request rejects edit (lines.repo's draft-only guard) and
 *   decide (decide.repo's submitted-only guard) exactly like
 *   approved/rejected, with ZERO guard-code changes required.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { Effect } from "effect";
import { db } from "./db";
import { Prisma } from "./generated/prisma/client";
import { ensureOwnedDraftRequest } from "../requests/lines.repo";
import { approveRequest } from "../review/decide.repo";
import { GLOBAL_ENTITY_SCOPE } from "../authz/conditions";

const asPromise = <T>(value: PromiseLike<T>): Promise<T> =>
  Promise.resolve(value);

async function makeApprovedRequest(ownerUserId: string) {
  return db.refundRequest.create({
    data: {
      ownerUserId,
      ownerEmail: `${ownerUserId}@example.com`,
      status: "approved",
      decidedAt: new Date(),
      decidedByUserId: "acct-1",
      decidedByEmail: "acct-1@example.com",
    },
  });
}

async function makeBatch(pdfObjectKey: string) {
  return db.refundBatch.create({
    data: {
      cutoff: new Date("2026-07-19T00:00:00.000Z"),
      createdByUserId: "acct-1",
      createdByEmail: "acct-1@example.com",
      pdfObjectKey,
      recipientEmailSnapshot: "accounting@welld.ch",
    },
  });
}

describe("RefundBatch / RefundBatchItem schema (specs/008 T1, ADR-0020/0022)", () => {
  afterAll(async () => {
    // Children first (Restrict FKs), CASCADE handles the rest — TRUNCATE
    // does not fire the refund_audit_entry row-level trigger (ADR-0018),
    // mirroring db.audit-immutability.test.ts's own cleanup.
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "refund_batch_item", "refund_audit_entry", "attachment", "refund_line", "refund_batch", "refund_request" RESTART IDENTITY CASCADE',
    );
  });

  it("RefundStatus has a fifth value, 'paid', and it round-trips through Prisma", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "schema-paid-1",
        ownerEmail: "schema-paid-1@example.com",
        status: "paid",
      },
    });
    expect(request.status).toBe("paid");

    const reread = await db.refundRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(reread.status).toBe("paid");
  });

  it("BatchStatus has exactly compiled|paid|discarded and defaults to 'compiled'", async () => {
    const batch = await makeBatch("refund/batches/schema-test-1/compiled.pdf");
    expect(batch.status).toBe("compiled");

    const paidBatch = await db.refundBatch.update({
      where: { id: batch.id },
      data: { status: "paid", paidAt: new Date(), paidByEmail: "acct-1@example.com" },
    });
    expect(paidBatch.status).toBe("paid");

    const other = await makeBatch("refund/batches/schema-test-2/compiled.pdf");
    const discarded = await db.refundBatch.update({
      where: { id: other.id },
      data: {
        status: "discarded",
        discardedAt: new Date(),
        discardedByEmail: "acct-1@example.com",
      },
    });
    expect(discarded.status).toBe("discarded");
  });

  it("pdfObjectKey is unique", async () => {
    await makeBatch("refund/batches/schema-test-dup/compiled.pdf");

    let caught: unknown;
    try {
      await makeBatch("refund/batches/schema-test-dup/compiled.pdf");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
  });

  it("RefundBatchItem: @@unique([batchId, requestId]) rejects a duplicate membership row", async () => {
    const batch = await makeBatch("refund/batches/schema-test-3/compiled.pdf");
    const request = await makeApprovedRequest("schema-item-1");

    await db.refundBatchItem.create({
      data: { batchId: batch.id, requestId: request.id },
    });

    let caught: unknown;
    try {
      await db.refundBatchItem.create({
        data: { batchId: batch.id, requestId: request.id },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
  });

  it("RefundRequest.batchId is the live claim pointer and survives a round-trip", async () => {
    const batch = await makeBatch("refund/batches/schema-test-4/compiled.pdf");
    const request = await makeApprovedRequest("schema-claim-1");

    const claimed = await db.refundRequest.update({
      where: { id: request.id },
      data: { batchId: batch.id },
    });
    expect(claimed.batchId).toBe(batch.id);

    // Discard-style release: nulling batchId (AC-6.1) is a plain update, not
    // a delete — proves the FK/column accepts NULL again after being set.
    const released = await db.refundRequest.update({
      where: { id: request.id },
      data: { batchId: null },
    });
    expect(released.batchId).toBeNull();
  });

  it("onDelete: Restrict — a RefundBatch with a claiming RefundRequest cannot be deleted", async () => {
    const batch = await makeBatch("refund/batches/schema-test-5/compiled.pdf");
    const request = await makeApprovedRequest("schema-restrict-1");
    await db.refundRequest.update({
      where: { id: request.id },
      data: { batchId: batch.id },
    });

    let caught: unknown;
    try {
      await db.refundBatch.delete({ where: { id: batch.id } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2003");
  });

  it("onDelete: Restrict — a RefundBatchItem makes both its batch and its request physically undeletable", async () => {
    const batch = await makeBatch("refund/batches/schema-test-6/compiled.pdf");
    const request = await makeApprovedRequest("schema-restrict-2");
    await db.refundBatchItem.create({
      data: { batchId: batch.id, requestId: request.id },
    });

    let batchDeleteErr: unknown;
    try {
      await db.refundBatch.delete({ where: { id: batch.id } });
    } catch (err) {
      batchDeleteErr = err;
    }
    expect(batchDeleteErr).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((batchDeleteErr as Prisma.PrismaClientKnownRequestError).code).toBe(
      "P2003",
    );

    let requestDeleteErr: unknown;
    try {
      await db.refundRequest.delete({ where: { id: request.id } });
    } catch (err) {
      requestDeleteErr = err;
    }
    expect(requestDeleteErr).toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(
      (requestDeleteErr as Prisma.PrismaClientKnownRequestError).code,
    ).toBe("P2003");
  });

  it("(AC-6.3/7.3) a RefundBatchItem survives even after its request's live batchId is released/reclaimed elsewhere", async () => {
    const batchA = await makeBatch("refund/batches/schema-test-7a/compiled.pdf");
    const batchB = await makeBatch("refund/batches/schema-test-7b/compiled.pdf");
    const request = await makeApprovedRequest("schema-history-1");

    // Claimed by A, permanently recorded in A's items.
    await db.refundRequest.update({
      where: { id: request.id },
      data: { batchId: batchA.id },
    });
    await db.refundBatchItem.create({
      data: { batchId: batchA.id, requestId: request.id },
    });

    // Discard A: release the live pointer, but the item row must remain.
    await db.refundRequest.update({
      where: { id: request.id },
      data: { batchId: null },
    });

    // Re-claimed by B.
    await db.refundRequest.update({
      where: { id: request.id },
      data: { batchId: batchB.id },
    });
    await db.refundBatchItem.create({
      data: { batchId: batchB.id, requestId: request.id },
    });

    const items = await db.refundBatchItem.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: "asc" },
    });
    expect(items.map((i) => i.batchId)).toEqual([batchA.id, batchB.id]);
  });

  it("RefundAuditEntry accepts the three new batch AuditAction values with a batchId", async () => {
    const batch = await makeBatch("refund/batches/schema-test-8/compiled.pdf");
    const request = await makeApprovedRequest("schema-audit-1");

    for (const action of ["batch_compiled", "batch_paid", "batch_discarded"] as const) {
      const entry = await db.refundAuditEntry.create({
        data: {
          requestId: request.id,
          batchId: batch.id,
          actorUserId: "acct-1",
          actorEmail: "acct-1@example.com",
          action,
        },
      });
      expect(entry.action).toBe(action);
      expect(entry.batchId).toBe(batch.id);
    }

    // AC-7.1: "the full set of request IDs affected" is the set of rows
    // sharing a given (batchId, action).
    const compiledRows = await db.refundAuditEntry.findMany({
      where: { batchId: batch.id, action: "batch_compiled" },
    });
    expect(compiledRows).toHaveLength(1);
    expect(compiledRows[0]?.requestId).toBe(request.id);
  });

  it("onDelete: Restrict — a RefundBatch with an audit entry cannot be deleted", async () => {
    const batch = await makeBatch("refund/batches/schema-test-9/compiled.pdf");
    const request = await makeApprovedRequest("schema-audit-restrict-1");
    await db.refundAuditEntry.create({
      data: {
        requestId: request.id,
        batchId: batch.id,
        actorUserId: "acct-1",
        actorEmail: "acct-1@example.com",
        action: "batch_compiled",
      },
    });

    let caught: unknown;
    try {
      await db.refundBatch.delete({ where: { id: batch.id } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2003");
  });

  it("the candidate-query index @@index([status, batchId, decidedAt]) exists on refund_request", async () => {
    const rows = await db.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'refund_request' AND indexname = 'refund_request_status_batchId_decidedAt_idx'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("(ADR-0020 decision 1) a `paid` request rejects a line edit exactly like approved/rejected — zero new guard code", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "schema-immune-1",
        ownerEmail: "schema-immune-1@example.com",
        status: "paid",
      },
    });

    const exit = await Effect.runPromiseExit(
      ensureOwnedDraftRequest(request.id, "schema-immune-1"),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ConflictError");
    }
  });

  it("(ADR-0020 decision 1) a `paid` request rejects a decision (approve) exactly like a non-submitted request", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "schema-immune-2",
        ownerEmail: "schema-immune-2@example.com",
        status: "paid",
        decidedAt: new Date(),
        decidedByUserId: "acct-1",
        decidedByEmail: "acct-1@example.com",
      },
    });

    const exit = await Effect.runPromiseExit(
      approveRequest(request.id, GLOBAL_ENTITY_SCOPE, "acct-2", "acct-2@example.com", false),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ConflictError");
    }
  });

  it("(control) a draft request with no batch history CAN still be deleted — Restrict only blocks batch-touched requests", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "schema-control-1",
        ownerEmail: "schema-control-1@example.com",
        status: "draft",
      },
    });

    await expect(
      asPromise(db.refundRequest.delete({ where: { id: request.id } })),
    ).resolves.toBeTruthy();
  });
});
