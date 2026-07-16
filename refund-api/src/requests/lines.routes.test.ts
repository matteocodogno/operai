/**
 * Integration tests for the expense-line endpoints (T8,
 * specs/007-refund-service).
 *
 * Strategy: real Postgres, jwt/authz mocked — see requests.routes.test.ts's
 * header comment (same pattern, own harness instance).
 *
 * AC coverage (T8 done-when)
 * ──────────────────────────
 * AC-1.2  required fields; km required/>0 iff travel_km, rejected otherwise
 * AC-1.6  missing-field 422 with the offending field named
 * (plus: draft-only guards on POST/PUT/DELETE; ownership 404; PUT replaces
 * the whole line object)
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

const harness = setupTestAuth();
await harness.init();

const { linesRouter } = await import("./lines.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

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

const OWNER_SUB = "emp-lines-1";
const OWNER_EMAIL = "emp-lines-1@x.com";

async function makeRequest(status: "draft" | "submitted" = "draft") {
  return db.refundRequest.create({
    data: { ownerUserId: OWNER_SUB, ownerEmail: OWNER_EMAIL, status },
  });
}

const validLineBody = (overrides: Record<string, unknown> = {}) => ({
  date: "2026-06-01",
  type: "office_material",
  motivo: "Printer paper",
  entity: "welld_it",
  requestedAmountCents: 1500,
  ...overrides,
});

beforeEach(async () => {
  await truncateRefundTables();
  harness.setResolve(async () => EMPLOYEE_PERMS);
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── POST /requests/:id/lines ───────────────────────────────────────────────

describe("POST /requests/:id/lines", () => {
  it("creates a line on a draft request", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody()),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; currency: string };
    expect(body.currency).toBe("EUR");

    const row = await db.refundLine.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.requestId).toBe(request.id);
  });

  it("(AC-1.6) missing required field → 422 naming the field", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });
    const { motivo: _drop, ...withoutMotivo } = validLineBody();

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(withoutMotivo),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("motivo");
  });

  it("(AC-1.2) km required and >0 when type is travel_km — missing km → 422", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ type: "travel_km" })),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("km");
  });

  it("(AC-1.2) km === 0 for travel_km → 422 (must be > 0)", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ type: "travel_km", km: 0 })),
    });

    expect(res.status).toBe(422);
  });

  it("(AC-1.2) valid travel_km line with km > 0 succeeds", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ type: "travel_km", km: 42 })),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { km: number };
    expect(body.km).toBe(42);
  });

  it("(AC-1.2) km present on a NON-travel_km type → 422 (rejected)", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ type: "postal", km: 10 })),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("km");
  });

  it("negative requestedAmountCents → 422", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ requestedAmountCents: -5 })),
    });

    expect(res.status).toBe(422);
  });

  it("draft-only guard: 409 on a submitted request", async () => {
    const request = await makeRequest("submitted");
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody()),
    });

    expect(res.status).toBe(409);
  });

  it("ownership guard: a non-owner gets 404, never able to add a line to someone else's draft", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody()),
    });

    expect(res.status).toBe(404);
  });
});

// ─── PUT /requests/:id/lines/:lineId ────────────────────────────────────────

describe("PUT /requests/:id/lines/:lineId", () => {
  it("replaces the whole line object", async () => {
    const request = await makeRequest();
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "postal",
        motivo: "Old",
        entity: "welld_it",
        requestedAmountCents: 100,
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines/${line.id}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify(
        validLineBody({ type: "travel_km", km: 15, motivo: "New", requestedAmountCents: 999 }),
      ),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motivo: string; km: number; requestedAmountCents: number };
    expect(body.motivo).toBe("New");
    expect(body.km).toBe(15);
    expect(body.requestedAmountCents).toBe(999);
  });

  it("draft-only guard: 409 on a submitted request", async () => {
    const request = await makeRequest("submitted");
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "postal",
        motivo: "Old",
        entity: "welld_it",
        requestedAmountCents: 100,
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines/${line.id}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody()),
    });

    expect(res.status).toBe(409);
  });

  it("a non-existent lineId → 404", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines/does-not-exist`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody()),
    });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /requests/:id/lines/:lineId ─────────────────────────────────────

describe("DELETE /requests/:id/lines/:lineId", () => {
  it("deletes a line on a draft request", async () => {
    const request = await makeRequest();
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "postal",
        motivo: "Old",
        entity: "welld_it",
        requestedAmountCents: 100,
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines/${line.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(204);
    expect(await db.refundLine.findUnique({ where: { id: line.id } })).toBeNull();
  });

  it("draft-only guard: 409 on a submitted request, line untouched", async () => {
    const request = await makeRequest("submitted");
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "postal",
        motivo: "Old",
        entity: "welld_it",
        requestedAmountCents: 100,
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines/${line.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(409);
    expect(await db.refundLine.findUnique({ where: { id: line.id } })).not.toBeNull();
  });

  it("ownership guard: a non-owner gets 404", async () => {
    const request = await makeRequest();
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "postal",
        motivo: "Old",
        entity: "welld_it",
        requestedAmountCents: 100,
      },
    });
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await linesRouter.request(`/requests/${request.id}/lines/${line.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(404);
    expect(await db.refundLine.findUnique({ where: { id: line.id } })).not.toBeNull();
  });
});
