/**
 * QE addition (specs/008-refund-monthly-processing verification pass) —
 * AC-7.3's full "discarded, then re-included in a different, later batch"
 * scenario: "that fact and the batch's identity remain permanently attached
 * to its audit history, even if the batch was later discarded and the
 * request re-included in a different, later batch."
 *
 * The existing suite (decide.routes.test.ts) proves AC-6.1/6.3 (release +
 * RefundBatchItem retention) and AC-7.1/7.2 (one audit row per action) in
 * isolation, but no test previously drove a request through BOTH a discard
 * AND a subsequent re-compile into a second batch in the same test to prove
 * batch A's `RefundBatchItem`/audit rows survive untouched while batch B's
 * own rows are ALSO created — i.e. `RefundBatchItem` is genuinely
 * many-per-request across different batches, not a single overwritten
 * pointer (that's what `RefundRequest.batchId`, the live claim pointer, is
 * for — see plan.md § "Why two membership representations").
 *
 * Exercises the repo layer directly (`compileBatch`/`discardBatch`) rather
 * than through a Hono router — this test needs no jwt/authz mocking, and
 * testAuth.ts's "one router per file" convention (see batches.routes.test.ts
 * / decide.routes.test.ts headers) means a new file that imported BOTH
 * `batchesRouter` and `batchDecideRouter` would risk exactly the kind of
 * cross-file `mock.module()` collision that produced this suite's own
 * known `storage.test.ts` full-suite-only leakage — calling the repo
 * functions directly sidesteps that risk entirely while still exercising
 * the real transactions against real Postgres.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Effect } from "effect";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { db } from "../lib/db";
import { compileBatch } from "./batches.repo";
import { discardBatch } from "./decide.repo";
import { GLOBAL_ENTITY_SCOPE } from "../authz/conditions";

process.env["NODE_ENV"] = "test";

beforeEach(async () => {
  await truncateRefundTables();
});

afterAll(async () => {
  await truncateRefundTables();
});

describe("AC-7.3 — batch membership permanently attached across discard + re-inclusion", () => {
  it("a request discarded from batch A and re-compiled into batch B carries BOTH batches' RefundBatchItem + audit history forever", async () => {
    const decidedAt = new Date("2026-07-01T00:00:00.000Z");
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "emp-1",
        ownerEmail: "emp1@x.com",
        status: "approved",
        decidedByUserId: "acct-1",
        decidedByEmail: "acct1@x.com",
        decidedAt,
      },
    });
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-15T00:00:00.000Z"),
        type: "office_material",
        motivo: "Re-inclusion fixture",
        entity: "welld_it",
        currency: "EUR",
        requestedAmountCents: 1000,
        approvedTotalCents: 1000,
      },
    });

    const cutoff = new Date("2026-07-10T00:00:00.000Z");

    // ── Compile A: claims the request ────────────────────────────────────
    const batchA = await Effect.runPromise(
      compileBatch(cutoff, GLOBAL_ENTITY_SCOPE, "acct-a", "a@x.com", "accounting@welld.ch"),
    );
    expect(batchA.requests.map((r) => r.id)).toEqual([request.id]);

    // ── Discard A: releases the request back to the pool, A's item/audit
    // rows are KEPT (AC-6.3) ────────────────────────────────────────────
    await Effect.runPromise(discardBatch(batchA.id, "acct-discarder", "discarder@x.com"));

    const releasedRequest = await db.refundRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(releasedRequest.batchId).toBeNull();
    expect(releasedRequest.status).toBe("approved");

    // ── Compile B: the SAME (now-released) request is re-claimed into a
    // DIFFERENT batch ───────────────────────────────────────────────────
    const batchB = await Effect.runPromise(
      compileBatch(cutoff, GLOBAL_ENTITY_SCOPE, "acct-b", "b@x.com", "accounting@welld.ch"),
    );
    expect(batchB.id).not.toBe(batchA.id);
    expect(batchB.requests.map((r) => r.id)).toEqual([request.id]);

    // ── AC-7.3 core assertion: RefundBatchItem now holds TWO rows for this
    // requestId — one per batch, batch A's row untouched by the discard ──
    const items = await db.refundBatchItem.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: "asc" },
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.batchId).sort()).toEqual([batchA.id, batchB.id].sort());

    // ── AC-7.3 audit assertion: batch A's compiled+discarded rows AND
    // batch B's compiled row all persist, permanently attached ──────────
    const auditRows = await db.refundAuditEntry.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: "asc" },
    });
    const byBatchAndAction = auditRows.map((r) => ({ batchId: r.batchId, action: r.action }));
    expect(byBatchAndAction).toContainEqual({ batchId: batchA.id, action: "batch_compiled" });
    expect(byBatchAndAction).toContainEqual({ batchId: batchA.id, action: "batch_discarded" });
    expect(byBatchAndAction).toContainEqual({ batchId: batchB.id, action: "batch_compiled" });
    expect(auditRows).toHaveLength(3);

    // ── Batch A itself remains fully inspectable post-discard (AC-6.3) —
    // its own row is untouched by B's later compile ─────────────────────
    const batchARow = await db.refundBatch.findUniqueOrThrow({ where: { id: batchA.id } });
    expect(batchARow.status).toBe("discarded");
  });
});
