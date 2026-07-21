/**
 * Integration tests for the accounting review queue (T11,
 * specs/007-refund-service).
 *
 * Strategy — mirrors requests.routes.test.ts's header comment: real Postgres
 * (compose, `refund` database), jwt/authz mocked via test-support/testAuth.ts.
 * `reviewRouter` is a NEW router module (see testAuth.ts's own doc comment on
 * why no two test FILES may import the SAME router specifier — this file
 * owns `./review.routes` exclusively).
 *
 * AC coverage (T11 done-when)
 * ──────────────────────────
 * AC-5.1/5.2 queue = submitted ∧ in scope, with owner/date/subtotal summary
 * AC-5.4 non-accounting (no request:review) → 403
 * AC-5.5 global (unconditioned) reviewer sees every submitted request
 * AC-5.6 single-entity reviewer: an other-entity-only request is absent
 * (plus: draft/approved/rejected never appear in the queue — AC-5.2/5.3)
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

const { reviewRouter } = await import("./review.routes");
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
// currency from entity (2026-07-17 amendment).
const DEFAULT_CURRENCY_FOR_ENTITY: Record<"welld_it" | "welld_ch", "EUR" | "CHF"> = {
  welld_it: "EUR",
  welld_ch: "CHF",
};

async function createRequestWithLines(
  status: "draft" | "submitted" | "approved" | "rejected",
  lines: readonly {
    entity: "welld_it" | "welld_ch";
    currency?: "EUR" | "CHF" | "USD" | "GBP";
    requestedAmountCents?: number;
  }[],
  overrides: Partial<{ ownerUserId: string; ownerEmail: string; ownerName: string | null; batchId: string }> = {},
) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: overrides.ownerUserId ?? "emp-1",
      ownerEmail: overrides.ownerEmail ?? "emp1@x.com",
      ownerName: overrides.ownerName ?? null,
      status,
      submittedAt: status === "draft" ? null : new Date(),
      batchId: overrides.batchId ?? null,
    },
  });
  for (const line of lines) {
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-06-01T00:00:00.000Z"),
        type: "office_material",
        motivo: "Test line",
        entity: line.entity,
        currency: line.currency ?? DEFAULT_CURRENCY_FOR_ENTITY[line.entity],
        requestedAmountCents: line.requestedAmountCents ?? 1000,
      },
    });
  }
  return request;
}

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /review/requests", () => {
  it("(AC-5.4) a caller with no request:review grant at all → 403", async () => {
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(403);
  });

  it("no Bearer token → 401", async () => {
    const res = await reviewRouter.request("/review/requests");
    expect(res.status).toBe(401);
  });

  it("(AC-5.1/5.2, amended) lists submitted AND approved-not-yet-batched in-scope requests, excluding draft/rejected", async () => {
    const submitted = await createRequestWithLines("submitted", [{ entity: "welld_it", requestedAmountCents: 2000 }], {
      ownerUserId: "emp-a",
      ownerEmail: "a@x.com",
      ownerName: "Employee A",
    });
    const approved = await createRequestWithLines("approved", [{ entity: "welld_it", requestedAmountCents: 500 }]);
    await createRequestWithLines("draft", [{ entity: "welld_it" }]);
    await createRequestWithLines("rejected", [{ entity: "welld_it" }]);

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      owner: { userId: string; email: string; name: string | null };
      submittedAt: string;
      subtotals: { currency: string; requestedCents: number; approvedCents: number | null }[];
    }[];

    // Both the pending (submitted) and the decided-but-unbatched (approved) request appear.
    expect(body.map((r) => r.id).sort()).toEqual([submitted.id, approved.id].sort());
    const submittedRow = body.find((r) => r.id === submitted.id);
    const approvedRow = body.find((r) => r.id === approved.id);
    expect(submittedRow?.status).toBe("submitted");
    expect(approvedRow?.status).toBe("approved");
    expect(submittedRow?.owner).toEqual({ userId: "emp-a", email: "a@x.com", name: "Employee A" });
    expect(submittedRow?.subtotals).toEqual([{ currency: "EUR", requestedCents: 2000, approvedCents: null }]);
  });

  it("an approved request already compiled into a batch (batchId set) is excluded from the queue", async () => {
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date(),
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `batches/test-${Date.now()}.pdf`,
        recipientEmailSnapshot: "accounting@welld.ch",
      },
    });
    const unbatched = await createRequestWithLines("approved", [{ entity: "welld_it" }]);
    await createRequestWithLines("approved", [{ entity: "welld_it" }], { batchId: batch.id });

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((r) => r.id)).toEqual([unbatched.id]);
  });

  it("(2026-07-17 amendment) queue subtotals group by currency, not entity — a mixed-currency request shows three subtotals", async () => {
    const mixed = await createRequestWithLines("submitted", [
      { entity: "welld_it", currency: "EUR", requestedAmountCents: 1000 },
      { entity: "welld_it", currency: "CHF", requestedAmountCents: 300 },
      { entity: "welld_ch", currency: "USD", requestedAmountCents: 700 },
    ]);

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      subtotals: { currency: string; requestedCents: number; approvedCents: number | null }[];
    }[];

    expect(body.map((r) => r.id)).toEqual([mixed.id]);
    expect(body[0]?.subtotals).toEqual([
      { currency: "CHF", requestedCents: 300, approvedCents: null },
      { currency: "EUR", requestedCents: 1000, approvedCents: null },
      { currency: "USD", requestedCents: 700, approvedCents: null },
    ]);
  });

  it("(AC-5.3) a request that was submitted then withdrawn (back to draft) is absent", async () => {
    // Withdraw is modeled as a status transition back to draft (ADR-0015/R6)
    // — a request with a prior 'submitted' audit history is indistinguishable
    // in the queue query from one that was never submitted; both are simply
    // status=draft and excluded.
    await createRequestWithLines("draft", [{ entity: "welld_it" }]);

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("(AC-5.6) a single-entity reviewer never sees a request whose lines are ALL the other entity", async () => {
    await createRequestWithLines("submitted", [{ entity: "welld_ch" }]);

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("(AC-5.1/5.6) a single-entity reviewer DOES see a mixed-entity request with at least one matching line", async () => {
    const mixed = await createRequestWithLines("submitted", [
      { entity: "welld_it", requestedAmountCents: 1000 },
      { entity: "welld_ch", requestedAmountCents: 500 },
    ]);

    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((r) => r.id)).toEqual([mixed.id]);
  });

  it("(AC-5.5) a global (unconditioned) reviewer sees every submitted request regardless of entity", async () => {
    await createRequestWithLines("submitted", [{ entity: "welld_it" }]);
    await createRequestWithLines("submitted", [{ entity: "welld_ch" }]);

    harness.setResolve(async () => accountingPerms(null));
    const token = await harness.signToken({ sub: "acct-global", email: "acctg@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body).toHaveLength(2);
  });

  it("a conditioned grant with no resolved caller entity matches nothing (fail-closed) — 200 empty, not 403", async () => {
    await createRequestWithLines("submitted", [{ entity: "welld_it" }]);

    harness.setResolve(async () => accountingPerms("welld_it"));
    // Deliberately mismatch: the fixture below has a conditioned grant but no
    // entity attribute at all (data-integrity edge case, ADR-0015).
    harness.setResolve(async () => ({
      sub: "",
      epoch: 1,
      permissions: [
        { resource: "refund", action: "access", conditions: null },
        {
          resource: "request",
          action: "review",
          conditions: { attributes: [{ key: "entity", match: "user" }] },
        },
      ],
      entity: null,
      jobTitle: null,
    }));
    const token = await harness.signToken({ sub: "acct-broken", email: "acctb@x.com" });

    const res = await reviewRouter.request("/review/requests", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
