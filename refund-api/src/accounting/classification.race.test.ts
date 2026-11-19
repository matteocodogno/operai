/**
 * A classification PUT racing the approval and the payment (T19, specs/20261118-
 * refund-accounting-export; reworked by T19 and T20, specs/20261119-accounting; AC-5.2, AC-5.7, AC-6.2; plan R7 and
 * § Test strategy "Extra tests", row 3; ADR 20261118-accounting-classification-is-live-until-approval-then-frozen-and-
 * changing-it-afterwards-needs-request-reclassify-and-is-refused-by-the-database-once-paid, as amended).
 *
 * The decision of `PUT …/classification` is taken on the request's status read
 * AFTER `SELECT … FOR UPDATE`, and approve and mark-paid both update that row, so
 * every race has exactly two outcomes. Each is fired with `Promise.all`, 20 times,
 * with a small different stagger per round so both orders are explored:
 *
 *   PUT vs approve, a caller WITHOUT `request:reclassify`
 *     before the freeze: 200, cause `review`, and the approval freezes THAT value;
 *     after it: 403 (the status needs `reclassify`), and the default stays.
 *     NEVER an override written on an approved line under `set-approved-total`.
 *   PUT vs approve, a caller WITH `request:reclassify`
 *     200 either way, final value the override; the cause says which side of the
 *     freeze it landed on (`review` / `post_approval`), and the freeze row of the
 *     approval agrees with it (it freezes the override, or the default, accordingly).
 *   PUT vs mark-paid
 *     before the payment: 200 and saved; after it: 409 `classification_locked`
 *     and the stored value is the one the payment saw. Never a 5xx, which would
 *     be the database trigger refusing a write the application let through.
 *
 * The reference data is read from a FAKE `AccountingPort`, so the PUT's live read and the approval's pre-read sit on either
 * side of the lock exactly as in production. Real Postgres, jwt/authz mocked, object storage mocked, no network.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["ACCOUNTING_INTERNAL_URL"] = "http://localhost:8089";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

// Object storage is mocked: mark-paid re-reads the batch and resolves its PDF link after committing.
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const realStorage = (await import("../lib/storage?real")) as typeof import("../lib/storage");
const storedObjectKeys = new Set<string>();
mock.module("../lib/storage", () => ({
  ...realStorage,
  putObject: async (objectKey: string) => {
    storedObjectKeys.add(objectKey);
  },
  headObject: async (objectKey: string) =>
    storedObjectKeys.has(objectKey) ? { sizeBytes: 1, contentType: "application/pdf" } : null,
  mintPresignedGet: async (objectKey: string) => `https://mock.example.com/${objectKey}?signed`,
}));

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?race")) as typeof import("./classification.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("../review/decide.routes?race")) as typeof import("../review/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { batchDecideRouter } = (await import("../batches/decide.routes?race")) as typeof import("../batches/decide.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { notifyTransport } = await import("../lib/notifyPost");
const { createFakeAccounting, useFakeAccounting, restoreAccounting } = await import("../test-support/fakeAccounting");

const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

const perms = (...actions: string[]): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    ...actions.map((action) => ({ resource: "request", action, conditions: null })),
  ],
  entity: null,
  jobTitle: null,
});
/** Reviews, sets approved totals and approves, but may NOT reclassify once approved. */
const WITHOUT_RECLASSIFY = perms("review", "set-approved-total", "approve");
const WITH_RECLASSIFY = perms("review", "set-approved-total", "approve", "reclassify");
const as = (resolve: ResolveResponse) => {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => resolve);
};

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const ROUNDS = 20;

const fake = createFakeAccounting();

beforeEach(async () => {
  await truncateRefundTables();
  as(WITH_RECLASSIFY);
  fake.failWith(null).failReferenceDataWith(null).failRatesWith(null).setDelayMs(0).onRead(null).resetCalls();
  fake.setAccount("5901", "Treno").setAccount("6101", "Ufficio").setVatCode("IMP81", "IVA 8.1%", 810);
  useFakeAccounting(fake);
  await db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type: "travel_train", accountNumber: "5901", accountName: "Treno", ...by } });
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

async function call(router: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, path: string, init: RequestInit = {}) {
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  const res = await router.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: Record<string, any> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
const putAccount = (requestId: string, lineId: string, accountNumber: string) =>
  call(classificationRouter, `/review/requests/${requestId}/lines/${lineId}/classification`, {
    method: "PUT",
    body: JSON.stringify({ accountNumber }),
  });
const approve = (requestId: string) => call(decideRouter, `/review/requests/${requestId}/approve`, { method: "POST" });
const markPaid = (batchId: string) => call(batchDecideRouter, `/batches/${batchId}/mark-paid`, { method: "POST" });

const sleep = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
/** Round `i` staggers one side by -2..+2 ms (and the other by 0), so the two orders are both explored. */
const stagger = (i: number): [number, number] => {
  const offset = (i % 5) - 2;
  return offset >= 0 ? [0, offset] : [-offset, 0];
};

async function submittedRequest(owner: string) {
  const request = await db.refundRequest.create({
    data: { ownerUserId: owner, ownerEmail: `${owner}@welld.ch`, ownerName: "Matteo Codogno", status: "submitted", submittedAt: new Date() },
  });
  const line = await db.refundLine.create({
    data: { requestId: request.id, date: new Date("2026-03-02"), type: "travel_train", motivo: "m", entity: "welld_ch", currency: "CHF", requestedAmountCents: 2080 },
  });
  return { requestId: request.id, lineId: line.id };
}

/** An approved, numbered, classified request in a compiled batch: what mark-paid acts on. */
async function compiledRequest(owner: string, seq: number) {
  const batch = await db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31T21:59:59.000Z"), status: "compiled", createdByUserId: "a", createdByEmail: "a@welld.ch", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: owner,
      ownerEmail: `${owner}@welld.ch`,
      ownerName: "Matteo Codogno",
      status: "approved",
      decidedAt: new Date("2026-03-20"),
      decidedByUserId: "a",
      decidedByEmail: "a@welld.ch",
      batchId: batch.id,
    },
  });
  const line = await db.refundLine.create({
    data: {
      requestId: request.id,
      date: new Date("2026-03-02"),
      type: "travel_train",
      motivo: "m",
      entity: "welld_ch",
      currency: "CHF",
      requestedAmountCents: 2080,
      approvedTotalCents: 2080,
      accountNumber: "5901",
      accountName: "Treno",
      ledgerAccountIsDefault: true,
      vatCodeCopy: "IMP81",
      vatRateBasisPoints: 810,
      vatCodeIsDefault: false,
      receiptNumber: `MC26/${String(seq).padStart(3, "0")}`,
      receiptOwnerUserId: owner,
      receiptYear: 2026,
      receiptSeq: seq,
      numberedAt: new Date(),
    },
  });
  await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
  return { batchId: batch.id, requestId: request.id, lineId: line.id };
}

const classifiedAudit = async (lineId: string) =>
  (await db.refundAuditEntry.findMany({ where: { lineId, action: "line_classified" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(
    (row) => row.detail as { cause: string; account: { from: { number: string } | null; to: { number: string } | null; fromDefault: boolean; toDefault: boolean } },
  );

/** Fails with the round and the observed outcomes, so a flaky race is diagnosable rather than just red. */
const check = (round: number, observed: unknown, assertion: () => void) => {
  try {
    assertion();
  } catch (error) {
    throw new Error(`round ${round}: ${(error as Error).message}\nobserved: ${JSON.stringify(observed)}`);
  }
};

// ═════════════════════════════════════════════════════════════════════════════

describe("PUT classification racing approve, a caller without request:reclassify (20 rounds)", () => {
  it("the PUT lands before the freeze (and the approval freezes it, cause review) or is refused after it; never an override on an approved line", async () => {
    as(WITHOUT_RECLASSIFY);
    const seen = { before: 0, after: 0 };
    for (let i = 0; i < ROUNDS; i++) {
      const r = await submittedRequest(`owner-a-${i}`);
      const [putDelay, approveDelay] = stagger(i);
      const [put, approved] = await Promise.all([
        sleep(putDelay).then(() => putAccount(r.requestId, r.lineId, "6101")),
        sleep(approveDelay).then(() => approve(r.requestId)),
      ]);
      const observed = { put: [put.status, put.body?.["code"]], approve: approved.status };

      check(i, observed, () => {
        expect(approved.status).toBe(200);
        expect([200, 403]).toContain(put.status);
      });
      const line = await db.refundLine.findUniqueOrThrow({ where: { id: r.lineId } });
      const audit = await classifiedAudit(r.lineId);
      check(i, { observed, audit }, () => {
        // Never an override written after the freeze: no `post_approval` row exists for a caller who may not reclassify.
        expect(audit.map((a) => a.cause)).not.toContain("post_approval");
        expect(line.numberedAt).not.toBeNull();
        if (put.status === 200) {
          seen.before++;
          expect(line).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false });
          expect(audit.map((a) => a.cause).sort()).toEqual(["approval", "review"]);
          const freeze = audit.find((a) => a.cause === "approval")!;
          expect(freeze.account.to?.number).toBe("6101");
          expect(freeze.account.toDefault).toBe(false);
        } else {
          seen.after++;
          expect(line).toMatchObject({ accountNumber: "5901", accountName: "Treno", ledgerAccountIsDefault: true });
          expect(audit.map((a) => a.cause)).toEqual(["approval"]);
          expect(audit[0]!.account.to?.number).toBe("5901");
        }
      });
      // Whatever happened, the approved total, the status and the decision are what approve wrote.
      const request = await db.refundRequest.findUniqueOrThrow({ where: { id: r.requestId } });
      expect(request.status).toBe("approved");
      expect(request.decidedByUserId).toBe("acct-1");
    }
    expect(seen.before + seen.after).toBe(ROUNDS);
  });

  it("(sanity of the classification of outcomes) a PUT strictly before is 200 and frozen; strictly after is 403 and not applied", async () => {
    as(WITHOUT_RECLASSIFY);
    const before = await submittedRequest("owner-before");
    expect((await putAccount(before.requestId, before.lineId, "6101")).status).toBe(200);
    expect((await approve(before.requestId)).status).toBe(200);
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: before.lineId } })).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false });

    const after = await submittedRequest("owner-after");
    expect((await approve(after.requestId)).status).toBe(200);
    const refused = await putAccount(after.requestId, after.lineId, "6101");
    expect(refused.status).toBe(403);
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: after.lineId } })).toMatchObject({ accountNumber: "5901", accountName: "Treno", ledgerAccountIsDefault: true });
  });
});

describe("PUT classification racing approve, a caller with request:reclassify (20 rounds)", () => {
  it("is 200 on either side and the override always ends up stored; the cause and the approval's freeze row agree on which side it was", async () => {
    as(WITH_RECLASSIFY);
    const seen = { review: 0, post_approval: 0 };
    for (let i = 0; i < ROUNDS; i++) {
      const r = await submittedRequest(`owner-b-${i}`);
      const [putDelay, approveDelay] = stagger(i);
      const [put, approved] = await Promise.all([
        sleep(putDelay).then(() => putAccount(r.requestId, r.lineId, "6101")),
        sleep(approveDelay).then(() => approve(r.requestId)),
      ]);
      const line = await db.refundLine.findUniqueOrThrow({ where: { id: r.lineId } });
      const audit = await classifiedAudit(r.lineId);
      const observed = { put: put.status, approve: approved.status, causes: audit.map((a) => a.cause) };
      check(i, observed, () => {
        expect(approved.status).toBe(200);
        expect(put.status).toBe(200);
        expect(line).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false });
        expect(audit).toHaveLength(2);
        const freeze = audit.find((a) => a.cause === "approval")!;
        const change = audit.find((a) => a.cause !== "approval")!;
        expect(freeze).toBeDefined();
        expect(["review", "post_approval"]).toContain(change.cause);
        if (change.cause === "review") {
          // The change was in before the freeze, so the approval froze the override.
          seen.review++;
          expect(freeze.account.to?.number).toBe("6101");
          expect(freeze.account.toDefault).toBe(false);
          expect(change.account.from?.number).toBe("5901");
        } else {
          // The approval froze the default; the change then came from `reclassify`, from that frozen default.
          seen.post_approval++;
          expect(freeze.account.to?.number).toBe("5901");
          expect(freeze.account.toDefault).toBe(true);
          expect(change.account.from?.number).toBe("5901");
          expect(change.account.fromDefault).toBe(true);
        }
        expect(change.account.to?.number).toBe("6101");
      });
    }
    expect(seen.review + seen.post_approval).toBe(ROUNDS);
  });
});

describe("PUT classification racing mark-paid (20 rounds)", () => {
  it("is saved before the payment, or 409 classification_locked after it; never a 5xx (that would be the database trigger)", async () => {
    as(WITH_RECLASSIFY);
    const seen = { saved: 0, locked: 0 };
    for (let i = 0; i < ROUNDS; i++) {
      const c = await compiledRequest(`owner-c-${i}`, i + 1);
      const [putDelay, payDelay] = stagger(i);
      const [put, paid] = await Promise.all([
        sleep(putDelay).then(() => putAccount(c.requestId, c.lineId, "6101")),
        sleep(payDelay).then(() => markPaid(c.batchId)),
      ]);
      const line = await db.refundLine.findUniqueOrThrow({ where: { id: c.lineId } });
      const audit = await classifiedAudit(c.lineId);
      const observed = { put: [put.status, put.body?.["code"]], paid: paid.status, causes: audit.map((a) => a.cause) };
      check(i, observed, () => {
        expect(paid.status).toBe(200);
        expect([200, 409]).toContain(put.status);
        if (put.status === 200) {
          seen.saved++;
          expect(line).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false });
          expect(audit.map((a) => a.cause)).toEqual(["post_approval"]);
        } else {
          seen.locked++;
          expect(put.body).toMatchObject({ code: "classification_locked" });
          expect(line).toMatchObject({ accountNumber: "5901", accountName: "Treno", ledgerAccountIsDefault: true });
          expect(audit).toEqual([]);
        }
      });
      const request = await db.refundRequest.findUniqueOrThrow({ where: { id: c.requestId } });
      expect(request.status).toBe("paid");
      expect((await db.refundBatch.findUniqueOrThrow({ where: { id: c.batchId } })).status).toBe("paid");
    }
    expect(seen.saved + seen.locked).toBe(ROUNDS);
  });

  it("once paid, the database itself refuses the write that the application would also refuse (AC-3.7)", async () => {
    const c = await compiledRequest("owner-c-final", 99);
    expect((await markPaid(c.batchId)).status).toBe(200);
    expect((await putAccount(c.requestId, c.lineId, "6101")).body).toMatchObject({ code: "classification_locked" });
    // T16 (specs/20261119-accounting): guard v2 watches the COPY columns, no longer the old FK columns.
    await expect(
      Promise.resolve(db.refundLine.update({ where: { id: c.lineId }, data: { accountNumber: "6101", accountName: "Ufficio" } })),
    ).rejects.toThrow(/locked/);
    const reread = await db.refundLine.findUniqueOrThrow({ where: { id: c.lineId } });
    expect(reread.accountNumber).toBe("5901");
    expect(reread.accountName).toBe("Treno");
  });
});
