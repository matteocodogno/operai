/**
 * Integration tests for the batch terminal transitions — mark-paid (T6) and
 * discard (T8), specs/008-refund-monthly-processing, plan.md § Atomic claim
 * / no-double-pay "mark-paid / discard terminal CAS".
 *
 * Strategy — mirrors `review/decide.routes.test.ts`'s header comment: real
 * Postgres (compose, `refund` database), jwt/authz mocked via
 * test-support/testAuth.ts. `batchDecideRouter` is a NEW router module owned
 * exclusively by this file (testAuth.ts's no-shared-router-specifier rule).
 *
 * Notify verification mocks `globalThis.fetch` directly (NOT
 * `mock.module("../lib/notify", …)`) — same rationale as
 * `review/decide.routes.test.ts`: `src/lib/notify.test.ts` unit-tests the
 * REAL `notify.ts` in the same `bun test` process, so replacing that module
 * here would leak into (and corrupt) that file's tests. Object storage
 * (`../lib/storage`, reached transitively via `pdfLink.ts`'s `resolvePdfLink`
 * for the response's `pdf` field) is also mocked here, mirroring
 * `batches.routes.test.ts`'s own mock — this response field is incidental to
 * T6's CAS/audit/notify behavior, so assertions below only check it is a
 * non-empty presigned-looking URL, never the specific mock call counts
 * (`pdfLink.ts` may already be linked against another test file's mock
 * instance if it loaded first — see storage.test.ts's isolation-order note).
 *
 * AC coverage (T6 done-when)
 * ──────────────────────────
 * AC-4.1 mark-paid flips the batch AND every included request atomically
 * AC-4.2 mark-paid succeeds even when the compilation email failed
 * AC-4.3 terminal CAS: a second mark-paid 409s; concurrent mark-paid vs
 *        mark-paid — exactly one wins
 * AC-4.4 requires `request:approve` (not `review` alone) → 403 otherwise
 * AC-5.1 fans out one `paid` push per included request's owner (mocked)
 * AC-7.2 one `batch_paid` audit row per affected request
 *
 * AC coverage (T8 done-when)
 * ──────────────────────────
 * AC-6.1 discard releases every included request back to the pool
 *        (batchId nulled, status stays approved) — re-eligible immediately
 * AC-6.2 terminal CAS: a second discard, or a discard on a paid batch, 409s
 * AC-6.3 RefundBatchItem membership rows are retained (never deleted)
 * AC-7.3 one `batch_discarded` audit row per affected request
 *
 * AC coverage (T4, specs/011-refund-settings)
 * ──────────────────────────
 * AC-2.5 mark-paid on a `blocked_unconfigured` batch succeeds exactly like
 *        any other failed-delivery batch (AC-4.2) — an unconfigured
 *        accounting-distribution-email setting is never a barrier
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { setupTestAuth } from "../test-support/testAuth";
import { truncateRefundTables } from "../test-support/dbCleanup";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["REFUND_S3_ENDPOINT"] =
  "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

// ─── Mock object storage — no live bucket (mirrors batches.routes.test.ts;
// see file header re: possible cross-file module-cache sharing) ───────────

const storedObjectKeys = new Set<string>();
// Scriptable per test (OWASP A04 fix round) — simulates a genuine object-
// storage outage at the presign step, reached by every `resolvePdfLink`
// call (pdfLink.ts) regardless of hit/miss. Used to prove mark-paid/discard
// still return 200 with the COMMITTED state even when the incidental `pdf`
// field on the response can't be resolved (pdfLink.ts never throws — a
// failure here must never look like the terminal transition itself failed).
let mintPresignedGetShouldFail = false;

mock.module("../lib/storage", () => ({
  putObject: async (objectKey: string) => {
    storedObjectKeys.add(objectKey);
  },
  headObject: async (objectKey: string) =>
    storedObjectKeys.has(objectKey) ? { sizeBytes: 1, contentType: "application/pdf" } : null,
  mintPresignedGet: async (objectKey: string) => {
    if (mintPresignedGetShouldFail) {
      throw new Error("simulated object-storage outage (mintPresignedGet)");
    }
    return `https://mock.example.com/${objectKey}?signed`;
  },
}));

const { batchDecideRouter } = await import("./decide.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

// ─── Fake the notify-api HTTP boundary (global fetch) — no live notify-api
// required, and no module-cache pollution across test files (mirrors
// review/decide.routes.test.ts) ─────────────────────────────────────────────

interface NotifyPaidCall {
  readonly recipientId: string;
  readonly requestId: string;
}

let notifyPaidCalls: NotifyPaidCall[] = [];
let notifyShouldFail = false;
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/notifications")) {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      recipientId: string;
      link?: { href: string };
    };
    const requestId = body.link?.href.split("/").pop() ?? "";
    notifyPaidCalls.push({ recipientId: body.recipientId, requestId });
    if (notifyShouldFail) {
      return new Response("simulated notify-api outage", { status: 500 });
    }
    return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
  }
  if (typeof url === "string" && url.includes("/system/emails")) {
    return new Response(JSON.stringify({ deliveryId: "d1", status: "sent" }), { status: 200 });
  }
  return originalFetch(url, init);
}) as unknown as typeof fetch;

// ─── Fixture permission sets ────────────────────────────────────────────────

const NO_GRANTS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [],
  entity: null,
  jobTitle: null,
};

/** Holds `request:review` but NOT `request:approve` — AC-4.4's negative case. */
const reviewOnlyPerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

const accountingPerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "approve", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

/** Holds `request:approve` but NOT `request:review` — discard's negative case (it's gated on `review`, not `approve`). */
const approveOnlyPerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "approve", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

async function createCompiledBatch(
  requests: readonly { ownerUserId: string; ownerEmail: string; approvedTotalCents?: number }[],
) {
  const batch = await db.refundBatch.create({
    data: {
      cutoff: new Date("2026-07-19T00:00:00.000Z"),
      status: "compiled",
      createdByUserId: "acct-1",
      createdByEmail: "acct1@x.com",
      pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
      recipientEmailSnapshot: "accounting@welld.ch",
    },
  });

  const requestIds: string[] = [];
  for (const r of requests) {
    const cents = r.approvedTotalCents ?? 1000;
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: r.ownerUserId,
        ownerEmail: r.ownerEmail,
        status: "approved",
        decidedAt: new Date("2026-07-01T00:00:00.000Z"),
        decidedByUserId: "acct-1",
        decidedByEmail: "acct1@x.com",
        batchId: batch.id,
      },
    });
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "office_material",
        motivo: "Test line",
        entity: "welld_it",
        currency: "EUR",
        requestedAmountCents: cents,
        approvedTotalCents: cents,
      },
    });
    await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
    requestIds.push(request.id);
  }

  return { batch, requestIds };
}

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  notifyPaidCalls = [];
  notifyShouldFail = false;
  storedObjectKeys.clear();
  mintPresignedGetShouldFail = false;
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── POST /batches/:id/mark-paid ────────────────────────────────────────────

describe("POST /batches/:id/mark-paid", () => {
  it("(AC-4.4) a caller with only `request:review` (no `request:approve`) → 403", async () => {
    harness.setResolve(async () => reviewOnlyPerms);
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchDecideRouter.request("/batches/does-not-exist/mark-paid", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(AC-4.4) no grants at all → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchDecideRouter.request("/batches/does-not-exist/mark-paid", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(404) no batch with that id", async () => {
    harness.setResolve(async () => accountingPerms);
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchDecideRouter.request("/batches/does-not-exist/mark-paid", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("(AC-4.1/4.2/5.1/7.2) flips the batch + every request to paid atomically, fans out notify, writes audit rows — even with a failed email", async () => {
    const { batch, requestIds } = await createCompiledBatch([
      { ownerUserId: "emp-a", ownerEmail: "a@x.com", approvedTotalCents: 500 },
      { ownerUserId: "emp-b", ownerEmail: "b@x.com", approvedTotalCents: 750 },
    ]);
    // AC-4.2 — mark-paid is never gated on the compilation email's delivery status.
    await db.refundBatch.update({ where: { id: batch.id }, data: { emailStatus: "failed" } });

    harness.setResolve(async () => accountingPerms);
    const token = await harness.signToken({ sub: "acct-approver", email: "approver@x.com" });

    const res = await batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      paidAt: string | null;
      paidBy: { email: string } | null;
      employees: { requests: { status: string }[] }[];
      pdf: { url: string };
    };
    expect(body.status).toBe("paid");
    expect(body.paidAt).not.toBeNull();
    expect(body.paidBy).toEqual({ email: "approver@x.com" });
    expect(body.employees.flatMap((e) => e.requests).every((r) => r.status === "paid")).toBe(true);
    expect(body.pdf.url).toMatch(/^https:\/\//);

    const dbRequests = await db.refundRequest.findMany({ where: { id: { in: requestIds } } });
    expect(dbRequests.every((r) => r.status === "paid")).toBe(true);

    // Per-owner notify fan-out (AC-5.1).
    expect(notifyPaidCalls).toHaveLength(2);
    expect(notifyPaidCalls.map((c) => c.recipientId).sort()).toEqual(["emp-a", "emp-b"]);

    // One batch_paid audit row per affected request (AC-7.2).
    const auditRows = await db.refundAuditEntry.findMany({
      where: { batchId: batch.id, action: "batch_paid" },
    });
    expect(auditRows).toHaveLength(2);
    expect(auditRows.every((r) => r.actorUserId === "acct-approver")).toBe(true);
  });

  it("(AC-2.5, specs/011-refund-settings) mark-paid succeeds on a batch whose email was blocked_unconfigured — exactly like any other failed delivery (AC-4.2)", async () => {
    const { batch } = await createCompiledBatch([
      { ownerUserId: "emp-a", ownerEmail: "a@x.com", approvedTotalCents: 500 },
    ]);
    // The setting was unconfigured at compile/send time (ADR-0029) — this
    // is never a barrier to marking the batch paid, exactly as AC-4.2
    // already establishes for an ordinary "failed" delivery above.
    await db.refundBatch.update({
      where: { id: batch.id },
      data: { emailStatus: "blocked_unconfigured", recipientEmailSnapshot: null },
    });

    harness.setResolve(async () => accountingPerms);
    const token = await harness.signToken({ sub: "acct-approver", email: "approver@x.com" });

    const res = await batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("paid");
  });

  it("(OWASP A04 fix round) a failing PDF regen never blocks the COMMITTED mark-paid — still 200 with pdf: null", async () => {
    const { batch, requestIds } = await createCompiledBatch([
      { ownerUserId: "emp-a", ownerEmail: "a@x.com", approvedTotalCents: 500 },
    ]);

    // Simulate a genuine object-storage outage AFTER the mark-paid
    // transaction is guaranteed to run — resolvePdfLink (pdfLink.ts) is
    // reached only from fetchDetailAfterTransition, i.e. strictly after
    // markBatchPaid has already committed. This must never turn an
    // already-applied financial action into a misleading 500.
    mintPresignedGetShouldFail = true;

    harness.setResolve(async () => accountingPerms);
    const token = await harness.signToken({ sub: "acct-approver", email: "approver@x.com" });

    const res = await batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      paidAt: string | null;
      pdf: { url: string } | null;
    };
    expect(body.status).toBe("paid");
    expect(body.paidAt).not.toBeNull();
    expect(body.pdf).toBeNull();

    // The transaction genuinely committed — not just the HTTP response shape.
    const dbRequests = await db.refundRequest.findMany({ where: { id: { in: requestIds } } });
    expect(dbRequests.every((r) => r.status === "paid")).toBe(true);
    const dbBatch = await db.refundBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(dbBatch.status).toBe("paid");
  });

  it("(AC-4.3) a second mark-paid on an already-paid batch → 409", async () => {
    const { batch } = await createCompiledBatch([{ ownerUserId: "emp-a", ownerEmail: "a@x.com" }]);

    harness.setResolve(async () => accountingPerms);
    const token = await harness.signToken({ sub: "acct-approver", email: "approver@x.com" });

    const first = await batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(first.status).toBe(200);

    const second = await batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(second.status).toBe(409);
  });

  it("(AC-4.3) concurrent double mark-paid: exactly one 200, one 409", async () => {
    const { batch } = await createCompiledBatch([{ ownerUserId: "emp-a", ownerEmail: "a@x.com" }]);

    harness.setResolve(async () => accountingPerms);
    const tokenA = await harness.signToken({ sub: "acct-a", email: "acct-a@x.com" });
    const tokenB = await harness.signToken({ sub: "acct-b", email: "acct-b@x.com" });

    const markPaid = (token: string) =>
      batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
        method: "POST",
        headers: authHeaders(token),
      });

    const [resA, resB] = await Promise.all([markPaid(tokenA), markPaid(tokenB)]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const refreshed = await db.refundBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(refreshed.status).toBe("paid");
    // Exactly one batch_paid audit row for the single request, from whichever won.
    const auditRows = await db.refundAuditEntry.findMany({
      where: { batchId: batch.id, action: "batch_paid" },
    });
    expect(auditRows).toHaveLength(1);
  });
});

// ─── POST /batches/:id/discard (T8) ─────────────────────────────────────────

describe("POST /batches/:id/discard", () => {
  it("(request:review required, not approve) a caller with only `request:approve` → 403", async () => {
    harness.setResolve(async () => approveOnlyPerms);
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchDecideRouter.request("/batches/does-not-exist/discard", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("no grants at all → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchDecideRouter.request("/batches/does-not-exist/discard", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(404) no batch with that id", async () => {
    harness.setResolve(async () => reviewOnlyPerms);
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchDecideRouter.request("/batches/does-not-exist/discard", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("(AC-6.1/6.3/7.3) releases every request back to the pool, retains RefundBatchItem, writes audit rows", async () => {
    const { batch, requestIds } = await createCompiledBatch([
      { ownerUserId: "emp-a", ownerEmail: "a@x.com" },
      { ownerUserId: "emp-b", ownerEmail: "b@x.com" },
    ]);

    harness.setResolve(async () => reviewOnlyPerms);
    const token = await harness.signToken({ sub: "acct-discarder", email: "discarder@x.com" });

    const res = await batchDecideRouter.request(`/batches/${batch.id}/discard`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      discardedAt: string | null;
      discardedBy: { email: string } | null;
      requestCount: number;
      employees: { requests: { status: string }[] }[];
    };
    expect(body.status).toBe("discarded");
    expect(body.discardedAt).not.toBeNull();
    expect(body.discardedBy).toEqual({ email: "discarder@x.com" });
    // The batch remains fully inspectable — its (now-released) members still show.
    expect(body.requestCount).toBe(2);
    expect(body.employees.flatMap((e) => e.requests).every((r) => r.status === "approved")).toBe(true);

    // AC-6.1 — released to the pool: batchId nulled, status still approved.
    const dbRequests = await db.refundRequest.findMany({ where: { id: { in: requestIds } } });
    expect(dbRequests.every((r) => r.batchId === null)).toBe(true);
    expect(dbRequests.every((r) => r.status === "approved")).toBe(true);

    // AC-6.3 — RefundBatchItem rows are retained forever, never deleted.
    const items = await db.refundBatchItem.findMany({ where: { batchId: batch.id } });
    expect(items.map((i) => i.requestId).sort()).toEqual([...requestIds].sort());

    // AC-7.3 — one batch_discarded audit row per affected request.
    const auditRows = await db.refundAuditEntry.findMany({
      where: { batchId: batch.id, action: "batch_discarded" },
    });
    expect(auditRows).toHaveLength(2);
    expect(auditRows.every((r) => r.actorUserId === "acct-discarder")).toBe(true);
  });

  it("(OWASP A04 fix round) a failing PDF regen never blocks the COMMITTED discard — still 200 with pdf: null", async () => {
    const { batch, requestIds } = await createCompiledBatch([
      { ownerUserId: "emp-a", ownerEmail: "a@x.com" },
    ]);

    mintPresignedGetShouldFail = true;

    harness.setResolve(async () => reviewOnlyPerms);
    const token = await harness.signToken({ sub: "acct-discarder", email: "discarder@x.com" });

    const res = await batchDecideRouter.request(`/batches/${batch.id}/discard`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      discardedAt: string | null;
      pdf: { url: string } | null;
    };
    expect(body.status).toBe("discarded");
    expect(body.discardedAt).not.toBeNull();
    expect(body.pdf).toBeNull();

    // The release genuinely committed — not just the HTTP response shape.
    const dbRequests = await db.refundRequest.findMany({ where: { id: { in: requestIds } } });
    expect(dbRequests.every((r) => r.batchId === null && r.status === "approved")).toBe(true);
  });

  it("(AC-6.1) a released request is immediately re-eligible for the next compile's candidate set", async () => {
    const { batch, requestIds } = await createCompiledBatch([
      { ownerUserId: "emp-a", ownerEmail: "a@x.com" },
    ]);

    harness.setResolve(async () => reviewOnlyPerms);
    const token = await harness.signToken({ sub: "acct-discarder", email: "discarder@x.com" });

    await batchDecideRouter.request(`/batches/${batch.id}/discard`, {
      method: "POST",
      headers: authHeaders(token),
    });

    // Re-eligible: approved ∧ batchId IS NULL ∧ decidedAt<=now — exactly the
    // candidate predicate T3's compile/candidates use.
    const eligible = await db.refundRequest.findMany({
      where: { status: "approved", batchId: null, id: { in: requestIds } },
    });
    expect(eligible.map((r) => r.id)).toEqual(requestIds);
  });

  it("(AC-6.2) a second discard on an already-discarded batch → 409", async () => {
    const { batch } = await createCompiledBatch([{ ownerUserId: "emp-a", ownerEmail: "a@x.com" }]);

    harness.setResolve(async () => reviewOnlyPerms);
    const token = await harness.signToken({ sub: "acct-discarder", email: "discarder@x.com" });

    const first = await batchDecideRouter.request(`/batches/${batch.id}/discard`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(first.status).toBe(200);

    const second = await batchDecideRouter.request(`/batches/${batch.id}/discard`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(second.status).toBe(409);
  });

  it("(AC-6.2) discard on an already-paid batch → 409", async () => {
    const { batch } = await createCompiledBatch([{ ownerUserId: "emp-a", ownerEmail: "a@x.com" }]);

    harness.setResolve(async () => accountingPerms);
    const approverToken = await harness.signToken({ sub: "acct-approver", email: "approver@x.com" });
    const paidRes = await batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
      method: "POST",
      headers: authHeaders(approverToken),
    });
    expect(paidRes.status).toBe(200);

    harness.setResolve(async () => reviewOnlyPerms);
    const discarderToken = await harness.signToken({ sub: "acct-discarder", email: "discarder@x.com" });
    const discardRes = await batchDecideRouter.request(`/batches/${batch.id}/discard`, {
      method: "POST",
      headers: authHeaders(discarderToken),
    });
    expect(discardRes.status).toBe(409);
  });

  it("(concurrent race) mark-paid vs discard on the same batch: exactly one wins", async () => {
    const { batch } = await createCompiledBatch([{ ownerUserId: "emp-a", ownerEmail: "a@x.com" }]);

    harness.setResolve(async () => accountingPerms); // holds BOTH review and approve
    const token = await harness.signToken({ sub: "acct-both", email: "both@x.com" });

    const [markPaidRes, discardRes] = await Promise.all([
      batchDecideRouter.request(`/batches/${batch.id}/mark-paid`, {
        method: "POST",
        headers: authHeaders(token),
      }),
      batchDecideRouter.request(`/batches/${batch.id}/discard`, {
        method: "POST",
        headers: authHeaders(token),
      }),
    ]);

    const statuses = [markPaidRes.status, discardRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    const refreshed = await db.refundBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(["paid", "discarded"]).toContain(refreshed.status);

    // Exactly one terminal audit trail exists for the batch, not both.
    const paidAudit = await db.refundAuditEntry.count({
      where: { batchId: batch.id, action: "batch_paid" },
    });
    const discardedAudit = await db.refundAuditEntry.count({
      where: { batchId: batch.id, action: "batch_discarded" },
    });
    expect(paidAudit + discardedAudit).toBe(1);
  });
});
