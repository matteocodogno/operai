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
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";

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
  currency: "EUR",
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

  it("(entity, currency) are independent — a welld_it line paid in CHF stores and returns CHF, not the derived EUR", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ entity: "welld_it", currency: "CHF" })),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; entity: string; currency: string };
    expect(body.entity).toBe("welld_it");
    expect(body.currency).toBe("CHF");

    const row = await db.refundLine.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.entity).toBe("welld_it");
    expect(row.currency).toBe("CHF");
  });

  it("an invalid currency value → 422", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ currency: "JPY" })),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("currency");
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

// ─── POST /requests/:id/lines — travel_km write derivation (specs/009-mileage-rate, T5) ──

async function addRate(entity: "welld_ch" | "welld_it", ratePerKmMicros: number, validFrom: string) {
  return db.mileageRate.create({
    data: {
      entity,
      currency: entity === "welld_ch" ? "CHF" : "EUR",
      ratePerKmMicros,
      validFrom: new Date(`${validFrom}T00:00:00.000Z`),
      createdByUserId: "admin-1",
      createdByEmail: "admin@welld.ch",
    },
  });
}

describe("POST /requests/:id/lines — travel_km write derivation (specs/009-mileage-rate)", () => {
  it("(AC-1.1/1.8) computes the amount and returns the full mileage breakdown", async () => {
    await addRate("welld_ch", 700000, "2026-01-01");
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        date: "2026-06-01",
        type: "travel_km",
        motivo: "Client visit",
        entity: "welld_ch",
        km: 240,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      currency: string;
      requestedAmountCents: number;
      mileage: {
        rateInEffect: boolean;
        appliedRate: { ratePerKmMicros: number } | null;
        computedAmountCents: number | null;
        snapshotted: boolean;
      } | null;
    };
    expect(body.currency).toBe("CHF");
    expect(body.requestedAmountCents).toBe(16800); // 240km x CHF0.70/km = CHF168.00
    expect(body.mileage?.rateInEffect).toBe(true);
    expect(body.mileage?.appliedRate?.ratePerKmMicros).toBe(700000);
    expect(body.mileage?.computedAmountCents).toBe(16800);
    expect(body.mileage?.snapshotted).toBe(false);
  });

  it("(AC-1.6, Security A04) a client-sent currency/requestedAmountCents on a travel_km line is ignored", async () => {
    await addRate("welld_ch", 700000, "2026-01-01");
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        date: "2026-06-01",
        type: "travel_km",
        motivo: "Client visit",
        entity: "welld_ch",
        km: 100,
        currency: "USD", // attacker/legacy-client attempt — must be ignored
        requestedAmountCents: 999999, // attacker/legacy-client attempt — must be ignored
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { currency: string; requestedAmountCents: number };
    expect(body.currency).toBe("CHF"); // entity-designated, NOT the client's "USD"
    expect(body.requestedAmountCents).toBe(7000); // computed (100km x 0.70), NOT the client's 999999
  });

  it("(AC-2.2) no rate configured -> rateInEffect:false, computedAmountCents:null, amount cached as 0", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        date: "2026-06-01",
        type: "travel_km",
        motivo: "No rate yet",
        entity: "welld_it",
        km: 50,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      requestedAmountCents: number;
      mileage: { rateInEffect: boolean; computedAmountCents: number | null } | null;
    };
    expect(body.mileage?.rateInEffect).toBe(false);
    expect(body.mileage?.computedAmountCents).toBeNull();
    expect(body.requestedAmountCents).toBe(0);
  });

  it("(AC-1.5) a non-travel_km line is completely unaffected — manual amount/currency honored", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        date: "2026-06-01",
        type: "postal",
        motivo: "Stamps",
        entity: "welld_ch",
        currency: "USD",
        requestedAmountCents: 1234,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      currency: string;
      requestedAmountCents: number;
      mileage: unknown;
    };
    expect(body.currency).toBe("USD");
    expect(body.requestedAmountCents).toBe(1234);
    expect(body.mileage).toBeNull();
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
        currency: "EUR",
        requestedAmountCents: 100,
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines/${line.id}`, {
      method: "PUT",
      headers: authHeaders(token),
      // NOT travel_km — a travel_km line's requestedAmountCents/currency are
      // server-derived, never honored from the client (specs/009-mileage-rate,
      // AC-1.6; see this file's separate "travel_km" describe block below for
      // that behavior). This test's own intent is the generic "PUT replaces
      // the whole line object" contract, unrelated to mileage.
      body: JSON.stringify(
        validLineBody({ type: "office_material", motivo: "New", requestedAmountCents: 999 }),
      ),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motivo: string; km: number | null; requestedAmountCents: number };
    expect(body.motivo).toBe("New");
    expect(body.km).toBeNull();
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
        currency: "EUR",
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
        currency: "EUR",
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
        currency: "EUR",
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
        currency: "EUR",
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

// ─── bodyLimit middleware — OWASP A04 fix ───────────────────────────────────

describe("bodyLimit middleware — raw request body > 16 KiB → 413 before validation", () => {
  it("POST /requests/:id/lines with an oversized raw body → 413 Problem (fires before zod validation)", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    // Not a valid LineBody — bodyLimit must reject on size alone, before
    // zod validation or handler logic ever run.
    const rawBody = `{"motivo":"${"X".repeat(20 * 1024)}"}`;

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: rawBody,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe("https://httpstatuses.com/413");
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);
    expect(await db.refundLine.count({ where: { requestId: request.id } })).toBe(0);
  });

  it("a valid in-limit line body still succeeds (bodyLimit does not clip legitimate requests)", async () => {
    const request = await makeRequest();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await linesRouter.request(`/requests/${request.id}/lines`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(validLineBody({ motivo: "X".repeat(2000) })),
    });

    expect(res.status).toBe(201);
  });
});
