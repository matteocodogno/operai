/**
 * Integration tests for accounting decisions (T12, specs/007-refund-service)
 * + the post-decision notify trigger (T13, AC-3.6, ADR-0017).
 *
 * Strategy — mirrors requests.routes.test.ts's header comment: real Postgres
 * (compose, `refund` database), jwt/authz mocked via test-support/testAuth.ts.
 * `decideRouter` is a NEW router module owned exclusively by this file (see
 * testAuth.ts's doc comment on the no-shared-router-specifier constraint).
 *
 * Notify verification mocks `globalThis.fetch` directly (NOT
 * `mock.module("../lib/notify", …)`) — mirrors storage.test.ts's approach of
 * mocking notify.ts's own external dependency rather than replacing the
 * whole module. `mock.module` registrations are process-global for the rest
 * of the `bun test` run, not scoped to this file; src/lib/notify.test.ts
 * unit-tests the REAL `notify.ts` in the SAME process, so replacing that
 * module here would leak into (and corrupt) that file's tests.
 *
 * AC coverage (T12/T13 done-when)
 * ──────────────────────────────
 * AC-7.1 editable approved-total per line, default=requested on approve
 * AC-7.2 approve → approved, totals recorded, approver+ts
 * AC-7.3 reject requires non-empty motivation (422 empty; 200 + motivation+stamps)
 * AC-7.4 decided decision/totals/motivation immutable → 409
 * AC-7.5 non-accounting cannot set total/decide → 403
 * AC-7.6 decision whole-request incl. out-of-scope lines
 * AC-8.1 audit rows for approved_total_set / approved / rejected
 * AC-3.6 approve/reject each fire notifyDecision with the owner's sub +
 *        correct link; a mocked notify failure still returns 200 (T13)
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

const { decideRouter } = await import("./decide.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

// ─── Fake the notify-api HTTP boundary (global fetch) — no live notify-api
// required, and no module-cache pollution across test files (T13) ─────────

interface NotifyCall {
  readonly recipientId: string;
  readonly requestId: string;
  readonly outcome: "approved" | "rejected";
}

let notifyCalls: NotifyCall[] = [];
let notifyShouldFail = false;
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/notifications")) {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      recipientId: string;
      link?: { href: string };
      severity: string;
    };
    const requestId = body.link?.href.split("/").pop() ?? "";
    notifyCalls.push({
      recipientId: body.recipientId,
      requestId,
      outcome: body.severity === "success" ? "approved" : "rejected",
    });
    if (notifyShouldFail) {
      return new Response("simulated notify-api outage", { status: 500 });
    }
    return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
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
    {
      resource: "request",
      action: "set-approved-total",
      conditions: entity ? { attributes: [{ key: "entity", match: "user" }] } : null,
    },
    {
      resource: "request",
      action: "approve",
      conditions: entity ? { attributes: [{ key: "entity", match: "user" }] } : null,
    },
    {
      resource: "request",
      action: "reject",
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

async function createSubmittedRequest(
  lines: readonly { entity: "welld_it" | "welld_ch"; requestedAmountCents?: number }[],
  overrides: Partial<{ ownerUserId: string; ownerEmail: string }> = {},
) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: overrides.ownerUserId ?? "emp-1",
      ownerEmail: overrides.ownerEmail ?? "emp1@x.com",
      status: "submitted",
      submittedAt: new Date(),
    },
  });
  const created = [];
  for (const line of lines) {
    created.push(
      await db.refundLine.create({
        data: {
          requestId: request.id,
          date: new Date("2026-06-01T00:00:00.000Z"),
          type: "office_material",
          motivo: "Test line",
          entity: line.entity,
          requestedAmountCents: line.requestedAmountCents ?? 1000,
        },
      }),
    );
  }
  return { request, lines: created };
}

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  notifyCalls = [];
  notifyShouldFail = false;
});

afterAll(async () => {
  await truncateRefundTables();
  globalThis.fetch = originalFetch;
});

// ─── PUT .../lines/:lineId/approved-total ──────────────────────────────────

describe("PUT /review/requests/:id/lines/:lineId/approved-total", () => {
  it("(AC-7.5) a non-accounting caller (no request:set-approved-total) → 403", async () => {
    const { request, lines } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await decideRouter.request(
      `/review/requests/${request.id}/lines/${lines[0]!.id}/approved-total`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ approvedTotalCents: 500 }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("(AC-7.1/8.1) sets the approved total and writes an approved_total_set audit row", async () => {
    const { request, lines } = await createSubmittedRequest([
      { entity: "welld_it", requestedAmountCents: 1000 },
    ]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(
      `/review/requests/${request.id}/lines/${lines[0]!.id}/approved-total`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ approvedTotalCents: 700 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; approvedTotalCents: number | null };
    expect(body.approvedTotalCents).toBe(700);

    const auditRows = await db.refundAuditEntry.findMany({ where: { requestId: request.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("approved_total_set");
    expect(auditRows[0]?.lineId).toBe(lines[0]!.id);
    expect(auditRows[0]?.actorUserId).toBe("acct-1");
    expect(auditRows[0]?.detail).toEqual({ fromCents: null, toCents: 700 });
  });

  it("allows setting an approved total of exactly zero (AC-7.1)", async () => {
    const { request, lines } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(
      `/review/requests/${request.id}/lines/${lines[0]!.id}/approved-total`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ approvedTotalCents: 0 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvedTotalCents: number | null };
    expect(body.approvedTotalCents).toBe(0);
  });

  it("(422) a negative or non-integer approvedTotalCents is rejected", async () => {
    const { request, lines } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(
      `/review/requests/${request.id}/lines/${lines[0]!.id}/approved-total`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ approvedTotalCents: -1 }),
      },
    );
    expect(res.status).toBe(422);
  });

  it("(404) out-of-scope accounting caller cannot set an approved total on a request outside their entity", async () => {
    const { request, lines } = await createSubmittedRequest([{ entity: "welld_ch" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(
      `/review/requests/${request.id}/lines/${lines[0]!.id}/approved-total`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ approvedTotalCents: 500 }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("(409, AC-7.4) cannot set an approved total on an already-decided request", async () => {
    const { request, lines } = await createSubmittedRequest([{ entity: "welld_it" }]);
    await db.refundRequest.update({ where: { id: request.id }, data: { status: "approved" } });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(
      `/review/requests/${request.id}/lines/${lines[0]!.id}/approved-total`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ approvedTotalCents: 500 }),
      },
    );
    expect(res.status).toBe(409);
  });

  it("(OWASP A04 fix) oversized raw body → 413 Problem before validation, nothing written", async () => {
    const { request, lines } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    // Not a valid ApprovedTotalBody — bodyLimit must reject on size alone,
    // before zod validation or handler logic ever run.
    const rawBody = `{"junk":"${"X".repeat(8 * 1024)}"}`;

    const res = await decideRouter.request(
      `/review/requests/${request.id}/lines/${lines[0]!.id}/approved-total`,
      {
        method: "PUT",
        headers: authHeaders(token),
        body: rawBody,
      },
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe("https://httpstatuses.com/413");
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);

    const auditRows = await db.refundAuditEntry.findMany({ where: { requestId: request.id } });
    expect(auditRows).toHaveLength(0);
  });
});

// ─── POST .../approve ────────────────────────────────────────────────────────

describe("POST /review/requests/:id/approve", () => {
  it("(AC-7.5) a non-accounting caller (no request:approve) → 403", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/approve`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(403);
  });

  it("(AC-7.2/8.1) approves, defaults untouched lines to their requested amount, stamps decider+ts, writes an audit row", async () => {
    const { request, lines } = await createSubmittedRequest([
      { entity: "welld_it", requestedAmountCents: 1000 },
      { entity: "welld_it", requestedAmountCents: 2000 },
    ]);
    // Explicitly set line[0]'s approved total; leave line[1] untouched.
    await db.refundLine.update({ where: { id: lines[0]!.id }, data: { approvedTotalCents: 400 } });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/approve`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      decidedAt: string | null;
      decidedBy: { email: string } | null;
      lines: { id: string; approvedTotalCents: number | null }[];
    };
    expect(body.status).toBe("approved");
    expect(body.decidedAt).not.toBeNull();
    expect(body.decidedBy).toEqual({ email: "acct1@x.com" });
    const byId = new Map(body.lines.map((l) => [l.id, l.approvedTotalCents]));
    expect(byId.get(lines[0]!.id)).toBe(400); // explicitly set — kept as-is
    expect(byId.get(lines[1]!.id)).toBe(2000); // untouched — defaulted to requested

    const auditRows = await db.refundAuditEntry.findMany({ where: { requestId: request.id } });
    expect(auditRows.map((r) => r.action)).toEqual(["approved"]);
    expect(auditRows[0]?.actorUserId).toBe("acct-1");
  });

  it("(AC-3.6/T13) approve fires notifyDecision with the owner's sub and the correct link", async () => {
    const { request } = await createSubmittedRequest([
      { entity: "welld_it", requestedAmountCents: 1000 },
    ]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/approve`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);

    expect(notifyCalls).toEqual([
      { recipientId: "emp-1", requestId: request.id, outcome: "approved" },
    ]);
  });

  it("(AC-3.6/T13) a notify-api failure is swallowed — the decision still returns 200", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    notifyShouldFail = true;
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/approve`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("approved");

    // The decision itself is the source of truth, independent of the push.
    const row = await db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("approved");
  });

  it("(AC-7.6) approve is whole-request — an out-of-scope line is still finalized", async () => {
    const { request, lines } = await createSubmittedRequest([
      { entity: "welld_it", requestedAmountCents: 1000 },
      { entity: "welld_ch", requestedAmountCents: 500 },
    ]);
    // acct-1 is scoped to welld_it only — matches exactly one of the two lines.
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/approve`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: { id: string; approvedTotalCents: number | null }[] };
    const byId = new Map(body.lines.map((l) => [l.id, l.approvedTotalCents]));
    // BOTH lines finalized, including the welld_ch line outside acct-1's scope.
    expect(byId.get(lines[0]!.id)).toBe(1000);
    expect(byId.get(lines[1]!.id)).toBe(500);
  });

  it("(404) out-of-scope accounting caller cannot approve a request outside their entity", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_ch" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/approve`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("(409, AC-7.4) cannot re-approve an already-decided request", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    await db.refundRequest.update({ where: { id: request.id }, data: { status: "rejected" } });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/approve`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(409);
  });
});

// ─── POST .../reject ──────────────────────────────────────────────────────────

describe("POST /review/requests/:id/reject", () => {
  it("(AC-7.5) a non-accounting caller (no request:reject) → 403", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Missing receipt" }),
    });
    expect(res.status).toBe(403);
  });

  it("(AC-7.3, 422) an empty motivation is refused", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "" }),
    });
    expect(res.status).toBe(422);
  });

  it("(AC-7.3, 422) a whitespace-only motivation is refused", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "   " }),
    });
    expect(res.status).toBe(422);
  });

  it("(AC-7.3/8.1) rejects with a valid motivation, stamps decider+ts, writes an audit row", async () => {
    const { request, lines } = await createSubmittedRequest([
      { entity: "welld_it", requestedAmountCents: 1000 },
    ]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Missing receipt for line 1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      rejectionMotivation: string | null;
      decidedBy: { email: string } | null;
      lines: { id: string; approvedTotalCents: number | null }[];
    };
    expect(body.status).toBe("rejected");
    expect(body.rejectionMotivation).toBe("Missing receipt for line 1");
    expect(body.decidedBy).toEqual({ email: "acct1@x.com" });
    // Not applicable to a rejected request — left untouched (still null, never touched).
    expect(body.lines[0]?.approvedTotalCents).toBeNull();

    const auditRows = await db.refundAuditEntry.findMany({ where: { requestId: request.id } });
    expect(auditRows.map((r) => r.action)).toEqual(["rejected"]);
    expect(auditRows[0]?.detail).toEqual({ rejectionMotivation: "Missing receipt for line 1" });
    void lines;
  });

  it("(AC-3.6/T13) reject fires notifyDecision with the owner's sub and the correct link", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Not eligible" }),
    });
    expect(res.status).toBe(200);

    expect(notifyCalls).toEqual([
      { recipientId: "emp-1", requestId: request.id, outcome: "rejected" },
    ]);
  });

  it("(AC-3.6/T13) a notify-api failure is swallowed — the rejection still returns 200", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    notifyShouldFail = true;
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Not eligible" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("rejected");
  });

  it("(AC-7.6) reject is whole-request — applies even though a line is outside the caller's scope", async () => {
    const { request } = await createSubmittedRequest([
      { entity: "welld_it" },
      { entity: "welld_ch" },
    ]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Not eligible" }),
    });
    expect(res.status).toBe(200);

    const row = await db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("rejected");
  });

  it("(404) out-of-scope accounting caller cannot reject a request outside their entity", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_ch" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Not eligible" }),
    });
    expect(res.status).toBe(404);
  });

  it("(409, AC-7.4) cannot re-reject an already-decided request", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    await db.refundRequest.update({ where: { id: request.id }, data: { status: "approved" } });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Not eligible" }),
    });
    expect(res.status).toBe(409);
  });

  it("(AC-7.4) rejection motivation cannot be altered by a further reject once decided", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const first = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Original reason" }),
    });
    expect(first.status).toBe(200);

    const second = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ motivation: "Changed my mind" }),
    });
    expect(second.status).toBe(409);

    const row = await db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.rejectionMotivation).toBe("Original reason");
  });

  it("(OWASP A04 fix) oversized raw body → 413 Problem before validation, request stays submitted", async () => {
    const { request } = await createSubmittedRequest([{ entity: "welld_it" }]);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    // reject's `motivation` has no schema-level max length — bodyLimit is
    // the only cap on this field; must reject BEFORE validation/handler logic.
    const rawBody = `{"motivation":"${"X".repeat(20 * 1024)}"}`;

    const res = await decideRouter.request(`/review/requests/${request.id}/reject`, {
      method: "POST",
      headers: authHeaders(token),
      body: rawBody,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe("https://httpstatuses.com/413");
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);

    const row = await db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("submitted");
  });
});
