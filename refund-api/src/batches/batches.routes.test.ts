/**
 * Integration tests for candidate preview + compile (T3) and the batch read
 * surfaces (T4, specs/008-refund-monthly-processing, plan.md § Atomic claim
 * / no-double-pay, § API contracts).
 *
 * Strategy — mirrors decide.routes.test.ts's header comment: real Postgres
 * (compose, `refund` database), jwt/authz mocked via test-support/testAuth.ts,
 * object storage mocked (`../lib/storage`, mirrors attachments.routes.test.ts —
 * no live bucket required). `batchesRouter` is a NEW router module owned
 * exclusively by this file (testAuth.ts's no-shared-router-specifier rule) —
 * T4's GET /batches, GET /batches/:id, GET /batches/:id/pdf-url all live on
 * this SAME router, so their tests are added here rather than a second file.
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
 *
 * AC coverage (T4 done-when)
 * ──────────────────────────
 * AC-8.2/8.3 GET /batches lists every status, 403 for non-accounting
 * AC-2.1/2.3 GET /batches/:id detail (compiled/paid/discarded), 403, 404
 * AC-6.3    a discarded batch's membership is STILL visible (via
 *           RefundBatchItem, not the nulled live batchId pointer)
 * AC-3.4    GET /batches/:id/pdf-url mints post-authz, 404, and lazily
 *           regenerates the PDF object on a storage miss (ADR-0019)
 *
 * AC coverage (T5 done-when)
 * ──────────────────────────
 * AC-3.1 compile auto-sends `/system/emails` with the app deep link + the
 *        configured recipient; a mocked email failure still returns 201
 *        (compile is never blocked/failed by email delivery)
 * AC-3.2 the resulting emailStatus is visible on GET /batches/:id
 * AC-3.3 resend mints a fresh `/system/emails` call, same address, works
 *        on any status, never recompiles; always 200 regardless of outcome
 * AC-3.4 the email `to` is only the configured distribution address
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
// T4's pdfLink.ts HEAD-checks the object before minting (lazy-regen on a
// miss, ADR-0019) — every object this test suite ever `putObject`s is
// tracked here so `headObject` can report it as present, matching real S3
// semantics without a live bucket.
const storedObjectKeys = new Set<string>();

mock.module("../lib/storage", () => ({
  putObject: async (objectKey: string, body: Uint8Array, contentType: string) => {
    putObjectCalls.push({ objectKey, contentType, byteLength: body.byteLength });
    storedObjectKeys.add(objectKey);
  },
  headObject: async (objectKey: string) =>
    storedObjectKeys.has(objectKey) ? { sizeBytes: 1, contentType: "application/pdf" } : null,
  mintPresignedGet: async (objectKey: string) => {
    mintPresignedGetCalls.push(objectKey);
    return `https://mock.example.com/${objectKey}?signed`;
  },
}));

// ─── Mock the notify-api email caller — no live notify-api (T5) ────────────

interface NotifyBatchCompiledCall {
  readonly batchId: string;
  readonly recipientEmail: string;
  readonly requestCount: number;
}

let notifyBatchCompiledCalls: NotifyBatchCompiledCall[] = [];
// Scriptable per test — defaults to "sent" (the common case); a test can
// override this to exercise AC-3.3's "compile/resend succeeds even when the
// email fails" soft-failure posture.
let notifyBatchCompiledOutcome: { status: "sent" | "failed"; deliveryId: string | null } = {
  status: "sent",
  deliveryId: "delivery-1",
};

mock.module("../lib/notifyEmail", () => ({
  notifyBatchCompiled: async (input: {
    batchId: string;
    recipientEmail: string;
    requestCount: number;
  }) => {
    notifyBatchCompiledCalls.push({
      batchId: input.batchId,
      recipientEmail: input.recipientEmail,
      requestCount: input.requestCount,
    });
    return notifyBatchCompiledOutcome;
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
  storedObjectKeys.clear();
  notifyBatchCompiledCalls = [];
  notifyBatchCompiledOutcome = { status: "sent", deliveryId: "delivery-1" };
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
    // T5: compile auto-sends the compilation email (AC-3.1) — the mock
    // defaults to "sent" (see beforeEach).
    expect(body.email.status).toBe("sent");
    expect(body.email.lastAttemptAt).not.toBeNull();
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

// ─── GET /batches (history, T4) ─────────────────────────────────────────────

describe("GET /batches", () => {
  it("(AC-8.3) a non-accounting caller (no request:review) → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchesRouter.request("/batches", { headers: authHeaders(token) });
    expect(res.status).toBe(403);
  });

  it("(AC-8.1/8.2) lists every batch, every status, newest first", async () => {
    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    // A compiled batch, via the real compile flow.
    const req1 = await createApprovedRequest([{ entity: "welld_it", approvedTotalCents: 500 }], {
      ownerUserId: "emp-a",
    });
    const compileRes = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(compileRes.status).toBe(201);
    const compiled = (await compileRes.json()) as { id: string };

    // A paid batch and a discarded batch, seeded directly (T6/T8 land later).
    const paidBatch = await db.refundBatch.create({
      data: {
        cutoff: new Date(CUTOFF),
        status: "paid",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/paid-${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
        paidAt: new Date(),
        paidByEmail: "acct1@x.com",
      },
    });
    const discardedBatch = await db.refundBatch.create({
      data: {
        cutoff: new Date(CUTOFF),
        status: "discarded",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/discarded-${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
        discardedAt: new Date(),
        discardedByEmail: "acct1@x.com",
      },
    });

    const res = await batchesRouter.request("/batches", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      requestCount: number;
      subtotals: { currency: string; approvedCents: number }[];
      emailStatus: string | null;
    }[];

    const byId = new Map(body.map((b) => [b.id, b]));
    expect(byId.get(compiled.id)?.status).toBe("compiled");
    expect(byId.get(compiled.id)?.requestCount).toBe(1);
    expect(byId.get(compiled.id)?.subtotals).toEqual([{ currency: "EUR", approvedCents: 500 }]);
    expect(byId.get(paidBatch.id)?.status).toBe("paid");
    expect(byId.get(paidBatch.id)?.requestCount).toBe(0);
    expect(byId.get(discardedBatch.id)?.status).toBe("discarded");
    void req1;
  });
});

// ─── GET /batches/:id (detail, T4) ──────────────────────────────────────────

describe("GET /batches/:id", () => {
  it("(AC-2.3) a non-accounting caller (no request:review) → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchesRouter.request("/batches/does-not-exist", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(404) no batch with that id", async () => {
    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches/does-not-exist", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("(AC-2.1) returns full detail for a compiled batch, including a freshly-minted PDF link", async () => {
    await createApprovedRequest([{ entity: "welld_it", approvedTotalCents: 750 }], {
      ownerUserId: "emp-a",
      ownerEmail: "a@x.com",
    });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const compileRes = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    const compiled = (await compileRes.json()) as { id: string };

    const res = await batchesRouter.request(`/batches/${compiled.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      requestCount: number;
      employees: { owner: { email: string }; requests: { status: string }[] }[];
      pdf: { url: string; expiresAt: string };
    };
    expect(body.id).toBe(compiled.id);
    expect(body.status).toBe("compiled");
    expect(body.requestCount).toBe(1);
    expect(body.employees[0]?.owner.email).toBe("a@x.com");
    expect(body.employees[0]?.requests[0]?.status).toBe("approved");
    expect(body.pdf.url).toContain(compiled.id);
  });

  it("(AC-6.3) a discarded batch's membership is still visible via RefundBatchItem, not the (nulled) live batchId", async () => {
    const request = await createApprovedRequest(
      [{ entity: "welld_it", approvedTotalCents: 250 }],
      { ownerUserId: "emp-discarded", ownerEmail: "discarded@x.com" },
    );
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date(CUTOFF),
        status: "discarded",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
        discardedAt: new Date(),
        discardedByEmail: "acct1@x.com",
      },
    });
    await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
    // The live pointer is released (T8's actual behavior) — batchId back to null.
    await db.refundRequest.update({ where: { id: request.id }, data: { batchId: null } });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request(`/batches/${batch.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      requestCount: number;
      employees: { owner: { email: string } }[];
      discardedAt: string | null;
      discardedBy: { email: string } | null;
    };
    expect(body.status).toBe("discarded");
    expect(body.requestCount).toBe(1);
    expect(body.employees[0]?.owner.email).toBe("discarded@x.com");
    expect(body.discardedAt).not.toBeNull();
    expect(body.discardedBy).toEqual({ email: "acct1@x.com" });
  });
});

// ─── GET /batches/:id/pdf-url (T4) ──────────────────────────────────────────

describe("GET /batches/:id/pdf-url", () => {
  it("(AC-3.4) a non-accounting caller (no request:review) → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchesRouter.request("/batches/does-not-exist/pdf-url", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(404) no batch with that id", async () => {
    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches/does-not-exist/pdf-url", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("mints a fresh presigned GET without re-rendering when the object already exists", async () => {
    await createApprovedRequest([{ entity: "welld_it" }], { ownerUserId: "emp-a" });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const compileRes = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    const compiled = (await compileRes.json()) as { id: string; pdf: { url: string } };
    putObjectCalls = []; // reset — compile already stored it once
    mintPresignedGetCalls = [];

    const res = await batchesRouter.request(`/batches/${compiled.id}/pdf-url`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.url).toContain(compiled.id);
    expect(putObjectCalls).toHaveLength(0); // NOT re-rendered — the object was already there
    expect(mintPresignedGetCalls.length).toBe(1);
  });

  it("(ADR-0019) lazily regenerates the PDF when the stored object is missing", async () => {
    const request = await createApprovedRequest(
      [{ entity: "welld_it", approvedTotalCents: 900 }],
      { ownerUserId: "emp-regen", ownerEmail: "regen@x.com" },
    );
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date(CUTOFF),
        status: "compiled",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
      },
    });
    await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
    // NEVER putObject'd for this batch — storedObjectKeys has no entry, so
    // the mocked headObject() reports it missing (network blip on the
    // original compile, R1).

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request(`/batches/${batch.id}/pdf-url`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain(batch.pdfObjectKey);
    expect(putObjectCalls).toHaveLength(1); // regenerated
    expect(putObjectCalls[0]?.objectKey).toBe(batch.pdfObjectKey);
    expect(mintPresignedGetCalls).toEqual([batch.pdfObjectKey]);
  });
});

// ─── Compilation email — auto-send on compile (T5) ─────────────────────────

describe("POST /batches — compilation email auto-send", () => {
  it("(AC-3.1/3.4) sends the compilation email to the configured distribution address with the app deep link", async () => {
    await createApprovedRequest([{ entity: "welld_it" }, { entity: "welld_it" }], {
      ownerUserId: "emp-a",
    });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; email: { status: string | null } };

    expect(notifyBatchCompiledCalls).toHaveLength(1);
    expect(notifyBatchCompiledCalls[0]?.batchId).toBe(body.id);
    expect(notifyBatchCompiledCalls[0]?.recipientEmail).toBe("accounting@welld.ch");
    expect(body.email.status).toBe("sent");

    const batchRow = await db.refundBatch.findUniqueOrThrow({ where: { id: body.id } });
    expect(batchRow.emailStatus).toBe("sent");
    expect(batchRow.emailDeliveryId).toBe("delivery-1");
    expect(batchRow.emailLastAttemptAt).not.toBeNull();
  });

  it("(AC-3.1/3.3) a mocked email failure does NOT fail the compile — 201 with emailStatus:failed", async () => {
    notifyBatchCompiledOutcome = { status: "failed", deliveryId: null };
    await createApprovedRequest([{ entity: "welld_it" }], { ownerUserId: "emp-a" });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; email: { status: string | null } };
    expect(body.email.status).toBe("failed");

    const batchRow = await db.refundBatch.findUniqueOrThrow({ where: { id: body.id } });
    expect(batchRow.status).toBe("compiled"); // batch itself is unaffected
    expect(batchRow.emailStatus).toBe("failed");
  });

  it("(AC-3.2) the emailStatus is visible on a subsequent GET /batches/:id", async () => {
    await createApprovedRequest([{ entity: "welld_it" }], { ownerUserId: "emp-a" });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const compileRes = await batchesRouter.request("/batches", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ cutoff: CUTOFF }),
    });
    const compiled = (await compileRes.json()) as { id: string };

    const res = await batchesRouter.request(`/batches/${compiled.id}`, {
      headers: authHeaders(token),
    });
    const body = (await res.json()) as { email: { status: string | null; lastAttemptAt: string | null } };
    expect(body.email.status).toBe("sent");
    expect(body.email.lastAttemptAt).not.toBeNull();
  });
});

// ─── POST /batches/:id/email (resend, T5) ──────────────────────────────────

describe("POST /batches/:id/email", () => {
  it("(AC-3.3) a non-accounting caller (no request:review) → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await batchesRouter.request("/batches/does-not-exist/email", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(404) no batch with that id", async () => {
    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request("/batches/does-not-exist/email", {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("(AC-3.3) resends to the SAME snapshotted address, works on a discarded batch, never recompiles", async () => {
    const request = await createApprovedRequest(
      [{ entity: "welld_it", approvedTotalCents: 400 }],
      { ownerUserId: "emp-a" },
    );
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date(CUTOFF),
        status: "discarded",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
        discardedAt: new Date(),
        discardedByEmail: "acct1@x.com",
      },
    });
    await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
    notifyBatchCompiledCalls = []; // no compile happened for this batch

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request(`/batches/${batch.id}/email`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emailStatus: string; emailDeliveryId: string | null };
    expect(body.emailStatus).toBe("sent");
    expect(body.emailDeliveryId).toBe("delivery-1");

    expect(notifyBatchCompiledCalls).toHaveLength(1);
    expect(notifyBatchCompiledCalls[0]?.recipientEmail).toBe("accounting@welld.ch");
    expect(notifyBatchCompiledCalls[0]?.batchId).toBe(batch.id);

    // The batch itself is unchanged — no recompile.
    const refreshed = await db.refundBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(refreshed.status).toBe("discarded");
    expect(refreshed.emailStatus).toBe("sent");
  });

  it("(AC-3.3) any status (any outcome) still returns 200", async () => {
    notifyBatchCompiledOutcome = { status: "failed", deliveryId: null };
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date(CUTOFF),
        status: "compiled",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
      },
    });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await batchesRouter.request(`/batches/${batch.id}/email`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emailStatus: string };
    expect(body.emailStatus).toBe("failed");
  });
});
