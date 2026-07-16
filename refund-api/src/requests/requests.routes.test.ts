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
      subtotals: { entity: string; currency: string; requestedCents: number; approvedCents: number | null }[];
    };
    // Never filtered down to the caller's own scope — both entities present.
    expect(body.lines.map((l) => l.entity).sort()).toEqual(["welld_ch", "welld_it"]);
    expect(body.subtotals).toEqual([
      { entity: "welld_ch", currency: "CHF", requestedCents: 500, approvedCents: null },
      { entity: "welld_it", currency: "EUR", requestedCents: 1000, approvedCents: null },
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
