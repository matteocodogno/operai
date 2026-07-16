/**
 * Integration tests for the employee request-level endpoints (T7,
 * specs/007-refund-service).
 *
 * Strategy
 * ────────
 * - Real Postgres (compose, `refund` database) — no DB mocking.
 * - `jwt.middleware` and `authz/resolveClient` are mocked via
 *   `../test-support/testAuth.ts` (see that file's own doc comment for why).
 * - Lines are inserted directly via `db.refundLine.create` (T8's line
 *   endpoints don't exist yet within this file's scope) — this is also how
 *   the mixed-entity subtotal-grouping fixture is built.
 *
 * AC coverage (T7 done-when)
 * ──────────────────────────
 * AC-1.1  POST /requests → draft, private, not queued
 * AC-2.5  non-owner non-accounting → 404 on GET/DELETE by id
 * AC-3.1  GET /requests — own only, foreign requests absent
 * AC-3.5  per-currency subtotals, never blended, on a mixed-entity request
 * (plus: capability-absent 403 on POST/GET; draft-only DELETE 409 otherwise;
 * in-scope accounting CAN read via GET /requests/:id; out-of-scope cannot)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
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

const { requestsRouter } = await import("./requests.routes");
const { db } = await import("../lib/db");
// Dynamically imported AFTER requests.routes (which itself imports
// authz.middleware) so this shares the SAME module instance/cache — a
// static top-level import would resolve before setupTestAuth()'s
// mock.module("../authz/resolveClient") is registered.
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

// ─── Fixture permission sets ────────────────────────────────────────────────

const EMPLOYEE_PERMS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    {
      resource: "request",
      action: "read",
      conditions: { ownership: "own" },
    },
  ],
  entity: "welld_it",
  jobTitle: null,
};

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
      conditions: entity
        ? { attributes: [{ key: "entity", match: "user" }] }
        : null,
    },
  ],
  entity,
  jobTitle: null,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createLineDirect(
  requestId: string,
  overrides: Partial<{
    entity: "welld_it" | "welld_ch";
    requestedAmountCents: number;
    approvedTotalCents: number | null;
    type: string;
    motivo: string;
  }> = {},
) {
  return db.refundLine.create({
    data: {
      requestId,
      date: new Date("2026-06-01T00:00:00.000Z"),
      type: (overrides.type ?? "office_material") as never,
      motivo: overrides.motivo ?? "Test line",
      entity: (overrides.entity ?? "welld_it") as never,
      requestedAmountCents: overrides.requestedAmountCents ?? 1000,
      approvedTotalCents: overrides.approvedTotalCents ?? null,
    },
  });
}

beforeAll(async () => {
  await truncateRefundTables();
});

beforeEach(async () => {
  await truncateRefundTables();
  // The authzMiddleware cache is keyed by (sub, perm_epoch) — several tests
  // below reuse the same sub with different fixture permission sets, which
  // would otherwise read stale cached permissions from an earlier test.
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /requests", () => {
  it("(AC-1.1) creates a draft owned by the caller — private, not queued", async () => {
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request("/requests", {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string; owner: { userId: string } };
    expect(body.status).toBe("draft");
    expect(body.owner.userId).toBe("emp-1");

    const row = await db.refundRequest.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.status).toBe("draft");
  });

  it("missing request:create capability → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-2", email: "emp2@x.com" });

    const res = await requestsRouter.request("/requests", {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(403);
  });

  it("no Bearer token → 401", async () => {
    const res = await requestsRouter.request("/requests", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("GET /requests (list, own only — AC-3.1)", () => {
  it("returns only the caller's own requests; a foreign request is absent", async () => {
    const owner = await db.refundRequest.create({
      data: { ownerUserId: "emp-a", ownerEmail: "a@x.com", status: "draft" },
    });
    await db.refundRequest.create({
      data: { ownerUserId: "emp-b", ownerEmail: "b@x.com", status: "draft" },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-a", email: "a@x.com" });

    const res = await requestsRouter.request("/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(owner.id);
  });

  it("a fresh user with no requests gets an empty array, not an error", async () => {
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-fresh", email: "fresh@x.com" });

    const res = await requestsRouter.request("/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("missing request:read capability → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-c", email: "c@x.com" });

    const res = await requestsRouter.request("/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(403);
  });
});

describe("GET /requests/:id", () => {
  it("(AC-2.5) a non-owner, non-accounting user gets 404 — never 403 or 200", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "owner-1", ownerEmail: "owner1@x.com", status: "draft" },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("a non-existent id → 404 (indistinguishable from 'not yours')", async () => {
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request("/requests/does-not-exist", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("the owner can read their own request", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "draft" },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(request.id);
  });

  it("(AC-3.5/6.6) subtotals are grouped per-currency by entity — never blended, for a mixed-entity request", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "draft" },
    });
    await createLineDirect(request.id, { entity: "welld_it", requestedAmountCents: 1000 });
    await createLineDirect(request.id, { entity: "welld_it", requestedAmountCents: 2500 });
    await createLineDirect(request.id, { entity: "welld_ch", requestedAmountCents: 500 });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subtotals: { entity: string; currency: string; requestedCents: number; approvedCents: number | null }[];
      lines: unknown[];
    };
    expect(body.lines).toHaveLength(3);
    expect(body.subtotals).toEqual([
      { entity: "welld_ch", currency: "CHF", requestedCents: 500, approvedCents: null },
      { entity: "welld_it", currency: "EUR", requestedCents: 3500, approvedCents: null },
    ]);
  });

  it("an in-scope accounting reviewer (entity match) CAN read a submitted request", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "submitted" },
    });
    await createLineDirect(request.id, { entity: "welld_it" });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
  });

  it("an out-of-scope accounting reviewer (entity mismatch) gets 404, never 403", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "submitted" },
    });
    await createLineDirect(request.id, { entity: "welld_ch" });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("a global (unconditioned) accounting reviewer sees every request regardless of entity", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "submitted" },
    });
    await createLineDirect(request.id, { entity: "welld_ch" });

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-global", email: "acctg@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /requests/:id (draft-only — AC-1.4/2.3)", () => {
  it("204 when the request is a draft", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "draft" },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(204);
    expect(await db.refundRequest.findUnique({ where: { id: request.id } })).toBeNull();
  });

  it("409 when the request is not a draft", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "submitted" },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(409);
    expect(await db.refundRequest.findUnique({ where: { id: request.id } })).not.toBeNull();
  });

  it("(AC-2.5) a non-owner gets 404, never able to delete someone else's draft", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "owner-1", ownerEmail: "owner1@x.com", status: "draft" },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
    expect(await db.refundRequest.findUnique({ where: { id: request.id } })).not.toBeNull();
  });

  it("a non-existent id → 404", async () => {
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request("/requests/does-not-exist", {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });
});
