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
import { Effect } from "effect";
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

const { requestsRouter } = await import("./requests.routes");
const { db } = await import("../lib/db");
// Dynamically imported AFTER requests.routes (which itself imports
// authz.middleware) so this shares the SAME module instance/cache — a
// static top-level import would resolve before setupTestAuth()'s
// mock.module("../authz/resolveClient") is registered.
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
// Real submit/withdraw transitions (T10) — used to drive the "retain-once-
// submitted" fixture below through the SAME code path production traffic
// uses (writes a real 'submitted' audit row), rather than hand-crafting a
// draft-with-audit-row state directly.
const { submitRequest, withdrawRequest } = await import("./lifecycle.repo");

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

// Default currency mirrors the OLD derivation (welld_it→EUR, welld_ch→CHF)
// purely as a fixture convenience — production code no longer derives
// currency from entity (2026-07-17 amendment); tests that care about
// currency pass it explicitly (e.g. the (entity, currency) independence and
// mixed-currency subtotal tests below).
const DEFAULT_CURRENCY_FOR_ENTITY: Record<"welld_it" | "welld_ch", "EUR" | "CHF"> = {
  welld_it: "EUR",
  welld_ch: "CHF",
};

async function createLineDirect(
  requestId: string,
  overrides: Partial<{
    entity: "welld_it" | "welld_ch";
    currency: "EUR" | "CHF" | "USD" | "GBP";
    requestedAmountCents: number;
    approvedTotalCents: number | null;
    type: string;
    motivo: string;
  }> = {},
) {
  const entity = overrides.entity ?? "welld_it";
  return db.refundLine.create({
    data: {
      requestId,
      date: new Date("2026-06-01T00:00:00.000Z"),
      type: (overrides.type ?? "office_material") as never,
      motivo: overrides.motivo ?? "Test line",
      entity: entity as never,
      currency: (overrides.currency ?? DEFAULT_CURRENCY_FOR_ENTITY[entity]) as never,
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

  it("(AC-3.5/6.6) subtotals are grouped purely by currency — never blended, for a mixed-entity request", async () => {
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
      subtotals: { currency: string; requestedCents: number; approvedCents: number | null }[];
      lines: unknown[];
    };
    expect(body.lines).toHaveLength(3);
    expect(body.subtotals).toEqual([
      { currency: "CHF", requestedCents: 500, approvedCents: null },
      { currency: "EUR", requestedCents: 3500, approvedCents: null },
    ]);
  });

  it("(2026-07-17 amendment) currency is INDEPENDENT of entity — a mixed-CURRENCY request (EUR + CHF + USD lines, some sharing the SAME entity) produces three subtotals", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "draft" },
    });
    // Two welld_it lines paid in two DIFFERENT currencies, plus a welld_ch
    // line paid in a THIRD currency — proves grouping is by currency alone,
    // never by entity, and that (entity, currency) is unconstrained.
    await createLineDirect(request.id, {
      entity: "welld_it",
      currency: "EUR",
      requestedAmountCents: 1000,
    });
    await createLineDirect(request.id, {
      entity: "welld_it",
      currency: "CHF",
      requestedAmountCents: 300,
    });
    await createLineDirect(request.id, {
      entity: "welld_ch",
      currency: "USD",
      requestedAmountCents: 700,
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subtotals: { currency: string; requestedCents: number; approvedCents: number | null }[];
      lines: { entity: string; currency: string }[];
    };
    expect(body.lines).toHaveLength(3);
    expect(body.lines.map((l) => ({ entity: l.entity, currency: l.currency })).sort((a, b) =>
      a.currency.localeCompare(b.currency),
    )).toEqual([
      { entity: "welld_it", currency: "CHF" },
      { entity: "welld_it", currency: "EUR" },
      { entity: "welld_ch", currency: "USD" },
    ]);
    expect(body.subtotals).toEqual([
      { currency: "CHF", requestedCents: 300, approvedCents: null },
      { currency: "EUR", requestedCents: 1000, approvedCents: null },
      { currency: "USD", requestedCents: 700, approvedCents: null },
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

  // ─── T11 additions (specs/007-refund-service) ──────────────────────────
  //
  // These exercise the SAME shared GET /requests/:id route accounting uses
  // (canReadRequest, requests.service.ts) — added here rather than in a new
  // src/review/ test file because test-support/testAuth.ts's own doc comment
  // warns against two test FILES importing the SAME router specifier
  // (`./requests.routes`); this file already owns it.

  it("(AC-6.5) an in-scope single-entity reviewer sees ALL lines of a mixed-entity request, including the out-of-scope entity's line", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "submitted" },
    });
    await createLineDirect(request.id, { entity: "welld_it", requestedAmountCents: 1000 });
    await createLineDirect(request.id, { entity: "welld_ch", requestedAmountCents: 500 });

    // Scoped to welld_it only — matches exactly ONE of the request's two lines.
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: { entity: string }[];
      subtotals: { currency: string; requestedCents: number; approvedCents: number | null }[];
    };
    // Never filtered down to the caller's own scope — both entities present.
    expect(body.lines.map((l) => l.entity).sort()).toEqual(["welld_ch", "welld_it"]);
    expect(body.subtotals).toEqual([
      { currency: "CHF", requestedCents: 500, approvedCents: null },
      { currency: "EUR", requestedCents: 1000, approvedCents: null },
    ]);
  });

  it("(AC-6.3) a decided (approved) request remains readable, read-only, for an in-scope accounting reviewer", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "emp-1",
        ownerEmail: "emp1@x.com",
        status: "approved",
        decidedByUserId: "acct-1",
        decidedByEmail: "acct1@x.com",
        decidedAt: new Date(),
      },
    });
    await createLineDirect(request.id, {
      entity: "welld_it",
      requestedAmountCents: 1000,
      approvedTotalCents: 800,
    });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      decidedBy: { email: string } | null;
      lines: { approvedTotalCents: number | null }[];
    };
    expect(body.status).toBe("approved");
    expect(body.decidedBy).toEqual({ email: "acct1@x.com" });
    expect(body.lines[0]?.approvedTotalCents).toBe(800);
  });

  // ─── AC-5.2 (specs/008-refund-monthly-processing) additions ────────────
  //
  // A `paid` request's batch claim (RefundRequest.batchId → RefundBatch)
  // carries the "when it was paid" (AC-5.2) — surfaced here as paidAt/paidBy
  // on the SAME GET /requests/:id shape refund-ui's RequestDetailPage
  // (employee, paidAt only) and ReviewDetailPage (accounting, + paidBy)
  // already render (T13, merged).

  it("(AC-5.2) a paid request returns paidAt/paidBy matching its batch's paidAt/paidByEmail", async () => {
    const paidAt = new Date("2026-07-18T09:30:00.000Z");
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date("2026-07-15T00:00:00.000Z"),
        status: "paid",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
        paidAt,
        paidByEmail: "acct1@x.com",
      },
    });
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "emp-1",
        ownerEmail: "emp1@x.com",
        status: "paid",
        decidedByUserId: "acct-1",
        decidedByEmail: "acct1@x.com",
        decidedAt: new Date("2026-07-14T00:00:00.000Z"),
        batchId: batch.id,
      },
    });
    await createLineDirect(request.id, {
      entity: "welld_it",
      requestedAmountCents: 1000,
      approvedTotalCents: 1000,
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      paidAt: string | null;
      paidBy: string | null;
    };
    expect(body.status).toBe("paid");
    expect(body.paidAt).toBe(paidAt.toISOString());
    expect(body.paidBy).toBe("acct1@x.com");
  });

  it("(AC-5.2) an approved (not yet paid) request returns null paidAt/paidBy", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "emp-1",
        ownerEmail: "emp1@x.com",
        status: "approved",
        decidedByUserId: "acct-1",
        decidedByEmail: "acct1@x.com",
        decidedAt: new Date(),
      },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; paidAt: string | null; paidBy: string | null };
    expect(body.status).toBe("approved");
    expect(body.paidAt).toBeNull();
    expect(body.paidBy).toBeNull();
  });

  it("(AC-5.2) a draft request returns null paidAt/paidBy", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "draft" },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; paidAt: string | null; paidBy: string | null };
    expect(body.status).toBe("draft");
    expect(body.paidAt).toBeNull();
    expect(body.paidBy).toBeNull();
  });

  // QE addition (specs/008-refund-monthly-processing verification pass,
  // adversarial focus item): AC-5.5 — "any request regardless of status
  // (including `paid`)" must still deny a non-owner, non-accounting caller.
  // The plan/tasks AC→test map only exercised this on a `draft` request
  // (line ~231 above); `paid` is a NEW status this spec introduces and
  // `canReadRequest`'s ownership/scope predicate is status-independent, but
  // that had no direct regression test pinning it for the new terminal
  // value specifically — added here rather than assumed from the generic
  // case.
  it("(AC-5.5) a non-owner, non-accounting user gets 404 on a PAID request — never 403 or 200", async () => {
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date("2026-07-15T00:00:00.000Z"),
        status: "paid",
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
        paidAt: new Date("2026-07-18T09:30:00.000Z"),
        paidByEmail: "acct1@x.com",
      },
    });
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "owner-1",
        ownerEmail: "owner1@x.com",
        status: "paid",
        decidedByUserId: "acct-1",
        decidedByEmail: "acct1@x.com",
        decidedAt: new Date("2026-07-14T00:00:00.000Z"),
        batchId: batch.id,
      },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });
});

// ─── GET /requests/:id — travel_km mileage (specs/009-mileage-rate, T5) ────

async function addMileageRate(
  entity: "welld_ch" | "welld_it",
  ratePerKmMicros: number,
  validFrom: string,
) {
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

describe("GET /requests/:id — draft travel_km live recompute (specs/009-mileage-rate)", () => {
  it("(AC-2.4/AC-3.2) recomputes live after a rate change with no line edit; subtotals agree", async () => {
    await addMileageRate("welld_ch", 700000, "2026-01-01");
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-mileage-1", ownerEmail: "emp-mileage-1@x.com", status: "draft" },
    });
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "travel_km",
        motivo: "Client visit",
        entity: "welld_ch",
        currency: "CHF",
        requestedAmountCents: 7000, // last write-time computed value (100km x 0.70)
        km: 100,
      },
    });

    // Admin adds a NEW, higher rate — no edit to the line itself.
    await addMileageRate("welld_ch", 800000, "2026-05-01");

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-mileage-1", email: "emp-mileage-1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      lines: {
        requestedAmountCents: number;
        mileage: {
          computedAmountCents: number | null;
          appliedRate: { ratePerKmMicros: number } | null;
        } | null;
      }[];
      subtotals: { requestedCents: number }[];
    };
    const line = detail.lines[0]!;
    expect(line.requestedAmountCents).toBe(8000); // 100km x 0.80 — LIVE recompute
    expect(line.mileage?.appliedRate?.ratePerKmMicros).toBe(800000);
    // Subtotals reflect the SAME live-recomputed value (no divergence).
    expect(detail.subtotals[0]?.requestedCents).toBe(8000);
  });

  it("(AC-1.7) a pre-existing draft travel_km line (manual-amount, 007-era) adopts the computed UI on read", async () => {
    await addMileageRate("welld_ch", 700000, "2026-01-01");
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-mileage-2", ownerEmail: "emp-mileage-2@x.com", status: "draft" },
    });
    // Simulate a line created BEFORE this feature shipped — manual amount,
    // no appliedRate columns, inserted directly.
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "travel_km",
        motivo: "Legacy manual entry",
        entity: "welld_ch",
        currency: "USD", // legacy manually-chosen currency, pre-AC-1.6
        requestedAmountCents: 12345, // legacy hand-typed amount
        km: 240,
      },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-mileage-2", email: "emp-mileage-2@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    const detail = (await res.json()) as {
      lines: { requestedAmountCents: number; mileage: { computedAmountCents: number | null } | null }[];
    };
    const line = detail.lines[0]!;
    // The legacy manual amount is SUPERSEDED the moment it's next read
    // (AC-1.7) — computed value wins, not the old 12345.
    expect(line.requestedAmountCents).toBe(16800); // 240km x 0.70
    expect(line.mileage?.computedAmountCents).toBe(16800);
  });
});

describe("GET /requests/:id — frozen (ever-submitted) travel_km lines (specs/009-mileage-rate)", () => {
  async function makeFrozenLine(status: "submitted" | "approved" | "rejected" | "paid") {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-mileage-3", ownerEmail: "emp-mileage-3@x.com", status },
    });
    const rate = await addMileageRate("welld_ch", 700000, "2026-01-01");
    // Simulate T6's submit-time snapshot write directly (T6 lands in a later
    // task) — this is exactly the shape T6 writes inside its submit
    // transaction.
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "travel_km",
        motivo: "Client visit",
        entity: "welld_ch",
        currency: "CHF",
        requestedAmountCents: 16800,
        km: 240,
        appliedRateMicros: rate.ratePerKmMicros,
        appliedRateValidFrom: rate.validFrom,
        appliedRateEntryId: rate.id,
      },
    });
    return request;
  }

  it("(AC-3.1/AC-3.3) shows the frozen snapshot, unaffected by a later rate change", async () => {
    const request = await makeFrozenLine("submitted");

    // A backdated rate change AFTER submission must never move the frozen amount.
    await addMileageRate("welld_ch", 900000, "2026-05-01");

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      lines: {
        requestedAmountCents: number;
        mileage: {
          computedAmountCents: number | null;
          appliedRate: { ratePerKmMicros: number } | null;
          snapshotted: boolean;
        } | null;
      }[];
    };
    const line = detail.lines[0]!;
    expect(line.requestedAmountCents).toBe(16800); // unchanged
    expect(line.mileage?.computedAmountCents).toBe(16800);
    expect(line.mileage?.appliedRate?.ratePerKmMicros).toBe(700000); // the ORIGINAL rate, not 900000
    expect(line.mileage?.snapshotted).toBe(true);
  });

  it("(R3) a legacy submitted line with null appliedRate renders gracefully — amount shown, no breakdown", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-mileage-4", ownerEmail: "emp-mileage-4@x.com", status: "submitted" },
    });
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "travel_km",
        motivo: "Pre-feature submitted line",
        entity: "welld_ch",
        currency: "USD", // legacy currency, never touched by this migration (AC-1.7 non-goal)
        requestedAmountCents: 5000, // legacy manually-entered amount, permanently retained
        km: 100,
        // appliedRateMicros/appliedRateValidFrom/appliedRateEntryId all null (legacy)
      },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-mileage-4", email: "emp-mileage-4@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      headers: authHeaders(token),
    });
    const detail = (await res.json()) as {
      lines: {
        currency: string;
        requestedAmountCents: number;
        mileage: {
          rateInEffect: boolean;
          appliedRate: unknown;
          computedAmountCents: number | null;
          snapshotted: boolean;
        } | null;
      }[];
    };
    const line = detail.lines[0]!;
    expect(line.currency).toBe("USD"); // permanently retained, never touched
    expect(line.requestedAmountCents).toBe(5000); // permanently retained
    expect(line.mileage?.rateInEffect).toBe(false);
    expect(line.mileage?.appliedRate).toBeNull();
    expect(line.mileage?.computedAmountCents).toBe(5000); // amount still shown
    expect(line.mileage?.snapshotted).toBe(true);
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

  // ─── Amended AC-1.4/AC-2.2/AC-8.4: "retain once submitted" ─────────────
  //
  // A request that has been submitted at least once — even after being
  // withdrawn back to `draft` — must stay undeletable, because its
  // submission audit entry (AC-8.1) is permanent (AC-8.4). Status alone is
  // NOT the right guard here: after withdraw the row's status genuinely IS
  // `draft` again, so this exercises attemptDeleteMany's P2003 (FK
  // onDelete:Restrict) catch path in requests.repo.ts, not the simpler
  // `status !== "draft"` branch the "409 when the request is not a draft"
  // test above already covers. Drives the fixture through the REAL
  // submit/withdraw repo functions (T10) — the same code path the
  // lifecycle HTTP routes use — then exercises the actual DELETE route.
  it("(AC-1.4/2.2/8.4) a draft that was submitted-then-withdrawn still cannot be hard-deleted — 409, not 204", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp1@x.com", status: "draft" },
    });
    await createLineDirect(request.id, { requestedAmountCents: 1000 });

    await Effect.runPromise(submitRequest(request.id, "emp-1", "emp1@x.com"));
    await Effect.runPromise(withdrawRequest(request.id, "emp-1", "emp1@x.com"));

    // Sanity check: withdraw really did put it back in `draft`.
    const withdrawn = await db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(withdrawn.status).toBe("draft");

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestsRouter.request(`/requests/${request.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/prior submission history/i);

    // The request (and its audit trail) must still exist, untouched.
    expect(await db.refundRequest.findUnique({ where: { id: request.id } })).not.toBeNull();
    const auditRows = await db.refundAuditEntry.findMany({ where: { requestId: request.id } });
    expect(auditRows.map((r) => r.action).sort()).toEqual(["submitted", "withdrawn"]);

    // It must still be fully editable/re-submittable (AC-1.4/2.2) — deletion
    // is the ONLY thing refused, everything else about being a draft holds.
    const editRes = await db.refundLine.updateMany({
      where: { requestId: request.id },
      data: { motivo: "Edited after withdraw" },
    });
    expect(editRes.count).toBe(1);
  });
});

// ─── bodyLimit middleware — OWASP A04 fix ───────────────────────────────────

describe("bodyLimit middleware — raw request body > 4 KiB → 413 before handler logic", () => {
  it("POST /requests with an oversized raw body → 413 Problem (fires before jwtMiddleware/handler)", async () => {
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    // POST /requests takes no body at all — bodyLimit must still reject an
    // oversized payload before jwtMiddleware/authzMiddleware or the handler
    // (which never reads the body) ever run.
    const rawBody = `{"junk":"${"X".repeat(8 * 1024)}"}`;

    const res = await requestsRouter.request("/requests", {
      method: "POST",
      headers: authHeaders(token),
      body: rawBody,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe("https://httpstatuses.com/413");
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);

    // Nothing must have been created despite the oversized body.
    expect(await db.refundRequest.count()).toBe(0);
  });
});
