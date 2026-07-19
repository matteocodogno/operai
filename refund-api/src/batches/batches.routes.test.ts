/**
 * Integration tests for candidate preview + compile (T3,
 * specs/008-refund-monthly-processing, plan.md § Atomic claim / no-double-pay).
 *
 * Strategy — mirrors decide.routes.test.ts's header comment: real Postgres
 * (compose, `refund` database), jwt/authz mocked via test-support/testAuth.ts,
 * object storage mocked (`../lib/storage`, mirrors attachments.routes.test.ts —
 * no live bucket required). `batchesRouter` is a NEW router module owned
 * exclusively by this file (testAuth.ts's no-shared-router-specifier rule).
 *
 * AC coverage (T3 done-when)
 * ──────────────────────────
 * AC-1.2 candidate set = approved ∧ decidedAt≤cutoff ∧ unbatched ∧ in scope
 *        (single-entity vs global; both the GET preview and the POST claim)
 * AC-1.3 a mixed-entity request enters a scoped compile WHOLE, never split
 * AC-1.4 empty candidate set → 422, nothing created (batch/item/audit/PDF)
 * AC-1.5 the atomic claim: two concurrent compiles never double-claim a
 *        request — the union of what they each claim is an exact partition
 *        of the eligible set
 * AC-1.8 no `request:review` → 403 (both GET candidates and POST compile)
 * AC-7.1 one `batch_compiled` audit row per claimed request
 * (plus: RefundBatchItem rows created, pdfObjectKey follows the T2 key
 * scheme, and the compiled PDF is stored via `putObject`)
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
process.env["REFUND_ACCOUNTING_DISTRIBUTION_EMAIL"] = "accounting@welld.ch";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

// ─── Mock the storage layer — no live bucket (mirrors attachments.routes.test.ts) ──

interface PutObjectCall {
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteLength: number;
}

let putObjectCalls: PutObjectCall[] = [];
let mintPresignedGetCalls: string[] = [];

mock.module("../lib/storage", () => ({
  putObject: async (objectKey: string, body: Uint8Array, contentType: string) => {
    putObjectCalls.push({ objectKey, contentType, byteLength: body.byteLength });
  },
  mintPresignedGet: async (objectKey: string) => {
    mintPresignedGetCalls.push(objectKey);
    return `https://mock.example.com/${objectKey}?signed`;
  },
}));

const { batchesRouter } = await import("./batches.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

// ─── Fixture permission sets ────────────────────────────────────────────────

const NO_GRANTS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [],
  entity: null,
  jobTitle: null,
};

const accountingPerms = (entity: string | null): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    {
      resource: "request",
      action: "review",
      conditions: entity ? { attributes: [{ key: "entity", match: "user" }] } : null,
    },
  ],
  entity,
  jobTitle: null,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const DEFAULT_CURRENCY_FOR_ENTITY: Record<"welld_it" | "welld_ch", "EUR" | "CHF"> = {
  welld_it: "EUR",
  welld_ch: "CHF",
};

interface LineFixture {
  readonly entity: "welld_it" | "welld_ch";
  readonly approvedTotalCents?: number;
  readonly currency?: "EUR" | "CHF" | "USD" | "GBP";
}

async function createApprovedRequest(
  lines: readonly LineFixture[],
  overrides: Partial<{
    ownerUserId: string;
    ownerEmail: string;
    ownerName: string | null;
    decidedAt: Date;
  }> = {},
) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: overrides.ownerUserId ?? "emp-1",
      ownerEmail: overrides.ownerEmail ?? "emp1@x.com",
      ownerName: overrides.ownerName ?? null,
      status: "approved",
      decidedAt: overrides.decidedAt ?? new Date("2026-07-01T00:00:00.000Z"),
      decidedByUserId: "acct-1",
      decidedByEmail: "acct1@x.com",
    },
  });
  for (const line of lines) {
    const cents = line.approvedTotalCents ?? 1000;
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "office_material",
        motivo: "Test line",
        entity: line.entity,
        currency: line.currency ?? DEFAULT_CURRENCY_FOR_ENTITY[line.entity],
        requestedAmountCents: cents,
        approvedTotalCents: cents,
      },
    });
  }
  return request;
}

const CUTOFF = "2026-07-19T00:00:00.000Z";

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  putObjectCalls = [];
  mintPresignedGetCalls = [];
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── GET /batches/candidates ────────────────────────────────────────────────

describe("GET /batches/candidates", () => {
  it("(AC-1.8) a non-accounting caller (no request:review) → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchesRouter.request(`/batches/candidates?cutoff=${CUTOFF}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(AC-1.2) candidate set excludes non-approved, future-decided, and already-batched requests", async () => {
    const eligible = await createApprovedRequest([{ entity: "welld_it" }], {
      ownerUserId: "emp-eligible",
      decidedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    // submitted, not approved — excluded
    const submitted = await db.refundRequest.create({
      data: { ownerUserId: "emp-submitted", ownerEmail: "s@x.com", status: "submitted" },
    });
    // decided AFTER the cutoff — excluded
    await createApprovedRequest([{ entity: "welld_it" }], {
      ownerUserId: "emp-future",
      decidedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    // already claimed by a batch — excluded. Use a raw pre-existing batch row.
    const alreadyBatched = await createApprovedRequest([{ entity: "welld_it" }], {
      ownerUserId: "emp-batched",
      decidedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const priorBatch = await db.refundBatch.create({
      data: {
        cutoff: new Date(CUTOFF),
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/prior-${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
      },
    });
    await db.refundRequest.update({
      where: { id: alreadyBatched.id },
      data: { batchId: priorBatch.id },
    });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request(`/batches/candidates?cutoff=${CUTOFF}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestCount: number; employees: { requestIds: string[] }[] };
    expect(body.requestCount).toBe(1);
    expect(body.employees.flatMap((e) => e.requestIds)).toEqual([eligible.id]);
    void submitted;
  });

  it("(AC-1.2) a single-entity reviewer only sees in-scope candidates; a global reviewer sees all", async () => {
    const itRequest = await createApprovedRequest([{ entity: "welld_it" }], {
      ownerUserId: "emp-it",
    });
    const chRequest = await createApprovedRequest([{ entity: "welld_ch" }], {
      ownerUserId: "emp-ch",
    });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const scopedToken = await harness.signToken({ sub: "acct-it", email: "acct-it@x.com" });
    const scopedRes = await batchesRouter.request(`/batches/candidates?cutoff=${CUTOFF}`, {
      headers: authHeaders(scopedToken),
    });
    expect(scopedRes.status).toBe(200);
    const scopedBody = (await scopedRes.json()) as { requestCount: number };
    expect(scopedBody.requestCount).toBe(1);

    __resetAuthzCacheForTests();
    harness.setResolve(async () => accountingPerms(null));
    const globalToken = await harness.signToken({ sub: "acct-global", email: "acct-global@x.com" });
    const globalRes = await batchesRouter.request(`/batches/candidates?cutoff=${CUTOFF}`, {
      headers: authHeaders(globalToken),
    });
    expect(globalRes.status).toBe(200);
    const globalBody = (await globalRes.json()) as { requestCount: number };
    expect(globalBody.requestCount).toBe(2);
    void itRequest;
    void chRequest;
  });

  it("(422) an invalid cutoff query value is rejected", async () => {
    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches/candidates?cutoff=not-a-date", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(422);
  });
});

// ─── POST /batches (compile) ────────────────────────────────────────────────

describe("POST /batches", () => {
  it("(AC-1.8) a non-accounting caller (no request:review) → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(res.status).toBe(403);
  });

  it("(AC-1.4) an empty candidate set is refused with 422 and creates nothing", async () => {
    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(422);

    expect(await db.refundBatch.count()).toBe(0);
    expect(await db.refundBatchItem.count()).toBe(0);
    expect(await db.refundAuditEntry.count({ where: { action: "batch_compiled" } })).toBe(0);
    expect(putObjectCalls).toHaveLength(0);
  });

  it("(AC-1.6/1.7/1.9/7.1) compiles: creates the batch + items, claims requests, writes audit rows, stores the PDF", async () => {
    const req1 = await createApprovedRequest(
      [{ entity: "welld_it", approvedTotalCents: 1500 }],
      { ownerUserId: "emp-a", ownerEmail: "a@x.com" },
    );
    const req2 = await createApprovedRequest(
      [{ entity: "welld_it", approvedTotalCents: 0 }], // AC-1.9 — a $0-approved request is eligible on the same terms
      { ownerUserId: "emp-b", ownerEmail: "b@x.com" },
    );

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      requestCount: number;
      subtotals: { currency: string; approvedCents: number }[];
      employees: { owner: { userId: string }; requests: { id: string }[] }[];
      pdf: { url: string; expiresAt: string };
      email: { status: string | null; lastAttemptAt: string | null };
      paidAt: string | null;
    };
    expect(body.status).toBe("compiled");
    expect(body.requestCount).toBe(2);
    expect(body.subtotals).toEqual([{ currency: "EUR", approvedCents: 1500 }]);
    expect(body.email).toEqual({ status: null, lastAttemptAt: null });
    expect(body.paidAt).toBeNull();
    expect(body.pdf.url).toContain(body.id);

    const claimedIds = body.employees.flatMap((e) => e.requests.map((r) => r.id)).sort();
    expect(claimedIds).toEqual([req1.id, req2.id].sort());

    // The requests are now claimed (live pointer set).
    const dbReq1 = await db.refundRequest.findUniqueOrThrow({ where: { id: req1.id } });
    const dbReq2 = await db.refundRequest.findUniqueOrThrow({ where: { id: req2.id } });
    expect(dbReq1.batchId).toBe(body.id);
    expect(dbReq2.batchId).toBe(body.id);

    // Immutable membership snapshot.
    const items = await db.refundBatchItem.findMany({ where: { batchId: body.id } });
    expect(items.map((i) => i.requestId).sort()).toEqual([req1.id, req2.id].sort());

    // One batch_compiled audit row per affected request (AC-7.1).
    const auditRows = await db.refundAuditEntry.findMany({
      where: { batchId: body.id, action: "batch_compiled" },
    });
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((r) => r.requestId).sort()).toEqual([req1.id, req2.id].sort());
    expect(auditRows.every((r) => r.actorUserId === "acct-1")).toBe(true);

    // The batch row itself.
    const batchRow = await db.refundBatch.findUniqueOrThrow({ where: { id: body.id } });
    expect(batchRow.status).toBe("compiled");
    expect(batchRow.pdfObjectKey).toBe(`refund/batches/${body.id}/compiled.pdf`);
    expect(batchRow.recipientEmailSnapshot).toBe("accounting@welld.ch");

    // The PDF was rendered and stored post-commit (T2/ADR-0019).
    expect(putObjectCalls).toHaveLength(1);
    expect(putObjectCalls[0]?.objectKey).toBe(batchRow.pdfObjectKey);
    expect(putObjectCalls[0]?.contentType).toBe("application/pdf");
    expect(putObjectCalls[0]!.byteLength).toBeGreaterThan(0);
    expect(mintPresignedGetCalls).toEqual([batchRow.pdfObjectKey]);
  });

  it("(AC-1.3) a mixed-entity request is claimed WHOLE by a scoped compile, never split", async () => {
    const mixed = await createApprovedRequest(
      [
        { entity: "welld_it", approvedTotalCents: 1000, currency: "EUR" },
        { entity: "welld_ch", approvedTotalCents: 2000, currency: "CHF" },
      ],
      { ownerUserId: "emp-mixed" },
    );

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-it", email: "acct-it@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      subtotals: { currency: string; approvedCents: number }[];
    };
    // BOTH currencies present — the whole request (both lines) entered, not
    // just the in-scope welld_it line.
    const byCurrency = new Map(body.subtotals.map((s) => [s.currency, s.approvedCents]));
    expect(byCurrency.get("EUR")).toBe(1000);
    expect(byCurrency.get("CHF")).toBe(2000);

    const item = await db.refundBatchItem.findFirst({ where: { requestId: mixed.id } });
    expect(item).not.toBeNull();
  });

  it("(AC-1.2) a scoped compile leaves an out-of-scope request unclaimed", async () => {
    await createApprovedRequest([{ entity: "welld_it" }], { ownerUserId: "emp-it" });
    const chOnly = await createApprovedRequest([{ entity: "welld_ch" }], {
      ownerUserId: "emp-ch",
    });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-it", email: "acct-it@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { requestCount: number };
    expect(body.requestCount).toBe(1);

    const dbChOnly = await db.refundRequest.findUniqueOrThrow({ where: { id: chOnly.id } });
    expect(dbChOnly.batchId).toBeNull();
  });

  it("cutoff defaults to now when omitted (AC-1.1)", async () => {
    await createApprovedRequest([{ entity: "welld_it" }], {
      ownerUserId: "emp-now",
      decidedAt: new Date(Date.now() - 60_000),
    });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { requestCount: number };
    expect(body.requestCount).toBe(1);
  });

  it("(AC-1.2/1.5) the atomic claim: two concurrent compiles never double-claim a request", async () => {
    const N = 8;
    const requests = [];
    for (let i = 0; i < N; i++) {
      requests.push(
        await createApprovedRequest([{ entity: "welld_it", approvedTotalCents: 100 * i }], {
          ownerUserId: `emp-concurrent-${i}`,
          ownerEmail: `emp-concurrent-${i}@x.com`,
        }),
      );
    }

    harness.setResolve(async () => accountingPerms(null));
    const tokenA = await harness.signToken({ sub: "acct-a", email: "acct-a@x.com" });
    const tokenB = await harness.signToken({ sub: "acct-b", email: "acct-b@x.com" });

    const compile = (token: string) =>
      batchesRouter.request("/batches", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ cutoff: CUTOFF }),
      });

    const [resA, resB] = await Promise.all([compile(tokenA), compile(tokenB)]);

    expect([resA.status, resB.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const status of [resA.status, resB.status]) {
      expect([201, 422]).toContain(status);
    }

    const claimedByBatch: string[][] = [];
    for (const res of [resA, resB]) {
      if (res.status !== 201) continue;
      const body = (await res.json()) as {
        employees: { requests: { id: string }[] }[];
      };
      claimedByBatch.push(body.employees.flatMap((e) => e.requests.map((r) => r.id)));
    }

    // Every claimed id, across BOTH responses, is unique — no request was
    // ever claimed by more than one of the two concurrent compiles.
    const allClaimed = claimedByBatch.flat();
    expect(new Set(allClaimed).size).toBe(allClaimed.length);

    // Together they claim EXACTLY the full eligible set — nothing lost, no
    // request left permanently un-claimable by either (AC-1.5).
    expect(allClaimed.sort()).toEqual(requests.map((r) => r.id).sort());

    // Every request now carries a batchId, and that batchId belongs to
    // exactly one of the (at most two) batches created.
    const refreshed = await db.refundRequest.findMany({
      where: { id: { in: requests.map((r) => r.id) } },
      select: { id: true, batchId: true },
    });
    expect(refreshed.every((r) => r.batchId !== null)).toBe(true);
    expect(new Set(refreshed.map((r) => r.batchId)).size).toBeLessThanOrEqual(2);

    // No RefundBatchItem row is duplicated across batches for the same request.
    const items = await db.refundBatchItem.findMany({
      where: { requestId: { in: requests.map((r) => r.id) } },
    });
    expect(items).toHaveLength(N);
    expect(new Set(items.map((i) => i.requestId)).size).toBe(N);

    // Exactly one batch_compiled audit row per request, total.
    const auditRows = await db.refundAuditEntry.findMany({
      where: { requestId: { in: requests.map((r) => r.id) }, action: "batch_compiled" },
    });
    expect(auditRows).toHaveLength(N);
  });
});
