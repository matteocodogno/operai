/**
 * Integration tests for `GET /rates/effective` (T4, specs/009-mileage-rate,
 * AC-1.2/1.3, AC-2.1, AC-2.2, Decision 2).
 *
 * AC coverage
 * ───────────
 * AC-2.1 resolves the latest validFrom <= date entry
 * AC-2.2 inEffect:false + no rate/history fields when nothing qualifies
 * Decision 2 gated by refund:access only — a plain refund user (no
 *            rate:read) can still resolve it; missing refund:access -> 403
 * Security   leaks nothing beyond entity/date/currency/inEffect/the rate
 *            itself (no createdBy, no history)
 * Contract   400 (not 422) on a bad/missing entity or date
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
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
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_ACCOUNTING_DISTRIBUTION_EMAIL"] = "accounting@welld.ch";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

const { rateEffectiveRouter } = await import("./effective.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const NO_GRANTS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [],
  entity: null,
  jobTitle: null,
};

// A plain employee — refund:access ONLY, deliberately NOT rate:read (Decision 2).
const employeePerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [{ resource: "refund", action: "access", conditions: null }],
  entity: null,
  jobTitle: null,
};

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

describe("GET /rates/effective", () => {
  it("403 without refund:access", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => NO_GRANTS);

    const res = await rateEffectiveRouter.request(
      "/rates/effective?entity=welld_ch&date=2026-07-15",
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(403);
  });

  it("(Decision 2) refund:access alone (no rate:read) is sufficient", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => employeePerms);

    const res = await rateEffectiveRouter.request(
      "/rates/effective?entity=welld_ch&date=2026-07-15",
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
  });

  it("(AC-2.2) inEffect:false and no rate fields when nothing qualifies", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => employeePerms);

    const res = await rateEffectiveRouter.request(
      "/rates/effective?entity=welld_it&date=2026-07-15",
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["inEffect"]).toBe(false);
    expect(body["entity"]).toBe("welld_it");
    expect(body["currency"]).toBe("EUR");
    // Leaks nothing beyond entity/date/currency/inEffect.
    expect(body["ratePerKmMicros"]).toBeUndefined();
    expect(body["ratePerKm"]).toBeUndefined();
    expect(body["validFrom"]).toBeUndefined();
    expect(body["createdByEmail"]).toBeUndefined();
  });

  it("(AC-2.1) resolves the latest validFrom <= date", async () => {
    await db.mileageRate.create({
      data: {
        entity: "welld_ch",
        currency: "CHF",
        ratePerKmMicros: 700000,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        createdByUserId: "admin-1",
        createdByEmail: "admin@welld.ch",
      },
    });
    await db.mileageRate.create({
      data: {
        entity: "welld_ch",
        currency: "CHF",
        ratePerKmMicros: 720000,
        validFrom: new Date("2026-06-01T00:00:00.000Z"),
        createdByUserId: "admin-1",
        createdByEmail: "admin@welld.ch",
      },
    });

    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => employeePerms);

    const res = await rateEffectiveRouter.request(
      "/rates/effective?entity=welld_ch&date=2026-07-15",
      { headers: authHeaders(token) },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["inEffect"]).toBe(true);
    expect(body["ratePerKmMicros"]).toBe(720000);
    expect(body["ratePerKm"]).toBe("0.72");
    expect(body["validFrom"]).toBe("2026-06-01");
    // Never leaks the actor/audit fields, even when a rate IS in effect.
    expect(body["createdByEmail"]).toBeUndefined();

    const earlierRes = await rateEffectiveRouter.request(
      "/rates/effective?entity=welld_ch&date=2026-02-01",
      { headers: authHeaders(token) },
    );
    const earlierBody = (await earlierRes.json()) as Record<string, unknown>;
    expect(earlierBody["ratePerKmMicros"]).toBe(700000);
  });

  it("(AC-2.3) welld_it's independent series is unaffected by welld_ch's history", async () => {
    await db.mileageRate.create({
      data: {
        entity: "welld_ch",
        currency: "CHF",
        ratePerKmMicros: 700000,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        createdByUserId: "admin-1",
        createdByEmail: "admin@welld.ch",
      },
    });

    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => employeePerms);

    const res = await rateEffectiveRouter.request(
      "/rates/effective?entity=welld_it&date=2026-07-15",
      { headers: authHeaders(token) },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["inEffect"]).toBe(false);
  });

  it("400 (not 422) on a bad entity", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => employeePerms);

    const res = await rateEffectiveRouter.request(
      "/rates/effective?entity=not-an-entity&date=2026-07-15",
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(400);
  });

  it("400 (not 422) on a missing date", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => employeePerms);

    const res = await rateEffectiveRouter.request("/rates/effective?entity=welld_ch", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(400);
  });
});
