/**
 * Integration tests for the submit/withdraw lifecycle endpoints (T10,
 * specs/007-refund-service, US-8/ADR-0018).
 *
 * Strategy: real Postgres, jwt/authz mocked — see requests.routes.test.ts's
 * header comment.
 *
 * AC coverage (T10 done-when)
 * ──────────────────────────
 * - full transition matrix: draft→submitted, submitted→draft, terminal 409s
 * - the 422 offending-line-ids payload (AC-1.6) — built by inserting an
 *   incomplete line DIRECTLY via Prisma, bypassing lines.routes.ts's own
 *   write-time validation (defense-in-depth re-check, see lines.schemas.ts's
 *   isLineComplete doc comment)
 * - 0-line submit → 422 (AC-1.5)
 * - an audit row per transition, with actor/action (AC-8.1)
 * - editing/deleting a non-draft (submitted) → 409, already covered by T7/T8
 *   but re-asserted here specifically AFTER a real submit transition
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
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
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";

const harness = setupTestAuth();
await harness.init();

const { lifecycleRouter } = await import("./lifecycle.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
// The draft-only-guard-after-submit assertions below exercise lines.repo
// directly (DB-only, no jwt/authz dependency) rather than lines.routes —
// that module is ALSO imported (and mock.module()-wired against its OWN
// jwt/authz fixtures) by lines.routes.test.ts elsewhere in this same `bun
// test` process; a second import of the same specifier here would return
// THAT file's already-cached instance, bound to a different fixture
// keypair, and any token signed by THIS file's harness would 401 against it.
const { updateLine } = await import("./lines.repo");
const { Effect } = await import("effect");

const EMPLOYEE_PERMS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
  ],
  entity: "welld_it",
  jobTitle: null,
};

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const OWNER_SUB = "emp-lifecycle-1";
const OWNER_EMAIL = "emp-lifecycle-1@x.com";

async function makeRequest(status: "draft" | "submitted" | "approved" | "rejected" = "draft") {
  return db.refundRequest.create({
    data: { ownerUserId: OWNER_SUB, ownerEmail: OWNER_EMAIL, status },
  });
}

async function addCompleteLine(requestId: string) {
  return db.refundLine.create({
    data: {
      requestId,
      date: new Date("2026-06-01T00:00:00.000Z"),
      type: "office_material",
      motivo: "Printer paper",
      entity: "welld_it",
      requestedAmountCents: 1500,
    },
  });
}

/** Bypasses lines.routes.ts's write-time validation entirely (direct Prisma). */
async function addIncompleteLine(requestId: string) {
  return db.refundLine.create({
    data: {
      requestId,
      date: new Date("2026-06-01T00:00:00.000Z"),
      type: "travel_km",
      motivo: "Client visit",
      entity: "welld_it",
      requestedAmountCents: 1500,
      km: null, // required for travel_km — persisted incomplete on purpose
    },
  });
}

beforeEach(async () => {
  await truncateRefundTables();
  harness.setResolve(async () => EMPLOYEE_PERMS);
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── POST /requests/:id/submit ──────────────────────────────────────────────

describe("POST /requests/:id/submit", () => {
  it("(AC-2.1) draft → submitted, and writes a 'submitted' audit row", async () => {
    const request = await makeRequest();
    await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; submittedAt: string | null };
    expect(body.status).toBe("submitted");
    expect(body.submittedAt).not.toBeNull();

    const audit = await db.refundAuditEntry.findMany({ where: { requestId: request.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("submitted");
    expect(audit[0]?.actorUserId).toBe(OWNER_SUB);
    expect(audit[0]?.actorEmail).toBe(OWNER_EMAIL);
  });

  it("(AC-1.5) zero lines → 422, no audit row written", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(422);
    const reread = await db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(reread.status).toBe("draft");
    expect(await db.refundAuditEntry.count({ where: { requestId: request.id } })).toBe(0);
  });

  it("(AC-1.6) an incomplete line → 422 with offendingLineIds naming it, no audit row", async () => {
    const request = await makeRequest();
    const goodLine = await addCompleteLine(request.id);
    const badLine = await addIncompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { offendingLineIds: string[] };
    expect(body.offendingLineIds).toEqual([badLine.id]);
    expect(body.offendingLineIds).not.toContain(goodLine.id);

    const reread = await db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(reread.status).toBe("draft");
    expect(await db.refundAuditEntry.count({ where: { requestId: request.id } })).toBe(0);
  });

  it("409 when the request is not a draft", async () => {
    const request = await makeRequest("submitted");
    await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(409);
  });

  it("a non-owner gets 404", async () => {
    const request = await makeRequest();
    await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(404);
  });

  it("(AC-2.3) editing a line after submit → 409 (draft-only guard now active)", async () => {
    const request = await makeRequest();
    const line = await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const submitRes = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(submitRes.status).toBe(200);

    const exit = await Effect.runPromiseExit(
      updateLine(request.id, line.id, OWNER_SUB, {
        date: "2026-06-02",
        type: "office_material",
        motivo: "Changed",
        entity: "welld_it",
        requestedAmountCents: 1,
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ConflictError");
    }
  });
});

// ─── POST /requests/:id/withdraw ────────────────────────────────────────────

describe("POST /requests/:id/withdraw", () => {
  it("(AC-2.2) submitted → draft round-trip, writes a 'withdrawn' audit row, leaves it editable", async () => {
    const request = await makeRequest();
    const line = await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });

    const withdrawRes = await lifecycleRouter.request(`/requests/${request.id}/withdraw`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(withdrawRes.status).toBe(200);
    const body = (await withdrawRes.json()) as { status: string };
    expect(body.status).toBe("draft");

    const audit = await db.refundAuditEntry.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["submitted", "withdrawn"]);

    // Editable again exactly as in US-1.
    const exit = await Effect.runPromiseExit(
      updateLine(request.id, line.id, OWNER_SUB, {
        date: "2026-06-02",
        type: "office_material",
        motivo: "Edited after withdraw",
        entity: "welld_it",
        requestedAmountCents: 42,
      }),
    );
    expect(exit._tag).toBe("Success");
  });

  it("409 when the request is not currently submitted (still draft)", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/withdraw`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(409);
  });

  it("(AC-2.3) 409 on an already-decided (approved) request — terminal, no audit row added", async () => {
    const request = await makeRequest("approved");
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/withdraw`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(409);
    expect(await db.refundAuditEntry.count({ where: { requestId: request.id } })).toBe(0);
  });

  it("a non-owner gets 404", async () => {
    const request = await makeRequest("submitted");
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await lifecycleRouter.request(`/requests/${request.id}/withdraw`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(404);
  });
});

// ─── Full transition matrix (terminal immutability, AC-2.3/8.3) ────────────

describe("terminal-state immutability", () => {
  it("submit on an approved request → 409", async () => {
    const request = await makeRequest("approved");
    await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(409);
  });

  it("submit on a rejected request → 409", async () => {
    const request = await makeRequest("rejected");
    await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(409);
  });

  it("delete on an approved request → 409 (has an audit row → also FK-restricted)", async () => {
    const request = await makeRequest();
    await addCompleteLine(request.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    await lifecycleRouter.request(`/requests/${request.id}/submit`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await db.refundRequest.update({ where: { id: request.id }, data: { status: "approved" } });

    // Exercises requests.repo directly (DB-only, no jwt/authz mocking)
    // rather than re-importing requests.routes here — that module is
    // ALSO imported (and mock.module()-wired against its OWN jwt/authz
    // fixtures) by requests.routes.test.ts elsewhere in this same `bun
    // test` process (see attachments.routes.test.ts's identical note).
    const { deleteDraftRequest } = await import("./requests.repo");
    const { Effect } = await import("effect");
    const exit = await Effect.runPromiseExit(deleteDraftRequest(request.id, OWNER_SUB));
    expect(exit._tag).toBe("Failure");

    const reread = await db.refundRequest.findUnique({ where: { id: request.id } });
    expect(reread).not.toBeNull();
  });
});
