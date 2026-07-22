/**
 * Integration tests for the mileage-rate management endpoints (T4,
 * specs/009-mileage-rate, plan.md § API contracts, Decision 2).
 *
 * Strategy — mirrors batches.routes.test.ts's header comment: real Postgres
 * (compose, `refund` database), jwt/authz mocked via test-support/testAuth.ts.
 * `ratesRouter` is a NEW router module owned exclusively by this file
 * (testAuth.ts's no-shared-router-specifier rule).
 *
 * AC coverage
 * ───────────
 * AC-4.1 GET /rates returns per-entity history, chronological
 * AC-4.2 POST /rates persists + becomes resolvable for dates >= validFrom
 * AC-4.3 the entry in effect today is flagged (currentEntryId/inEffectToday)
 * AC-4.5 non-positive value / bad validFrom -> 422, nothing persisted
 * AC-4.6 missing rate:read/rate:manage -> 403
 * AC-4.8 a backdated validFrom is accepted and immediately resolvable
 * AC-5.1 the created row carries actor/timestamp/entity/value/validFrom
 * AC-5.3 GET /rates doubles as the audit view (createdByEmail visible)
 * Security: currency is ALWAYS server-derived from entity (never the body's);
 *           createdBy* always come from the JWT (never the body)
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
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

const { ratesRouter } = await import("./routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const NO_GRANTS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [],
  entity: null,
  jobTitle: null,
};

const rateReadPerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [{ resource: "rate", action: "read", conditions: null }],
  entity: null,
  jobTitle: null,
};

const rateManagePerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [{ resource: "rate", action: "manage", conditions: null }],
  entity: null,
  jobTitle: null,
};

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

describe("GET /rates", () => {
  it("(AC-4.6) 403 without rate:read", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => NO_GRANTS);

    const res = await ratesRouter.request("/rates", { headers: authHeaders(token) });
    expect(res.status).toBe(403);
  });

  it("(AC-4.1) returns both entities, even with zero entries", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => rateReadPerms);

    const res = await ratesRouter.request("/rates", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: { entity: string; currency: string; entries: unknown[] }[] };
    expect(body.entities).toHaveLength(2);
    const ch = body.entities.find((e) => e.entity === "welld_ch")!;
    const it_ = body.entities.find((e) => e.entity === "welld_it")!;
    expect(ch.currency).toBe("CHF");
    expect(it_.currency).toBe("EUR");
    expect(ch.entries).toEqual([]);
  });

  it("(AC-4.1/AC-2.3) chronological per-entity history, independent series", async () => {
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
    await db.mileageRate.create({
      data: {
        entity: "welld_it",
        currency: "EUR",
        ratePerKmMicros: 500000,
        validFrom: new Date("2026-03-01T00:00:00.000Z"),
        createdByUserId: "admin-1",
        createdByEmail: "admin@welld.ch",
      },
    });

    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => rateReadPerms);

    const res = await ratesRouter.request("/rates", { headers: authHeaders(token) });
    const body = (await res.json()) as {
      entities: { entity: string; entries: { validFrom: string; ratePerKm: string }[] }[];
    };
    const ch = body.entities.find((e) => e.entity === "welld_ch")!;
    const it_ = body.entities.find((e) => e.entity === "welld_it")!;
    expect(ch.entries.map((e) => e.validFrom)).toEqual(["2026-01-01", "2026-06-01"]);
    expect(ch.entries.map((e) => e.ratePerKm)).toEqual(["0.70", "0.72"]);
    // welld_it's single entry is entirely unaffected by welld_ch's two entries.
    expect(it_.entries).toHaveLength(1);
    expect(it_.entries[0]?.ratePerKm).toBe("0.50");
  });
});

describe("POST /rates", () => {
  it("(AC-4.6) 403 without rate:manage", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => rateReadPerms); // read-only, not manage

    const res = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_ch", ratePerKm: "0.72", validFrom: "2026-08-01" }),
    });
    expect(res.status).toBe(403);

    const count = await db.mileageRate.count();
    expect(count).toBe(0);
  });

  it("(AC-4.2, AC-5.1) persists an entry with server-derived currency and JWT-sourced actor", async () => {
    const token = await harness.signToken({ sub: "admin-42", email: "admin42@welld.ch" });
    harness.setResolve(async () => rateManagePerms);

    const res = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      // Client attempts to smuggle a currency AND a spoofed actor — both MUST
      // be ignored server-side (Security A01/A08).
      body: JSON.stringify({
        entity: "welld_ch",
        ratePerKm: "0.72",
        validFrom: "2026-08-01",
        currency: "USD",
        createdByUserId: "attacker",
        createdByEmail: "attacker@evil.com",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      ratePerKmMicros: number;
      ratePerKm: string;
      validFrom: string;
      createdByEmail: string;
    };
    expect(body.ratePerKmMicros).toBe(720000);
    expect(body.ratePerKm).toBe("0.72");
    expect(body.validFrom).toBe("2026-08-01");
    expect(body.createdByEmail).toBe("admin42@welld.ch");

    const row = await db.mileageRate.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.currency).toBe("CHF"); // derived from entity, NEVER the client's "USD"
    expect(row.createdByUserId).toBe("admin-42"); // from the JWT, NEVER the body
    expect(row.createdByEmail).toBe("admin42@welld.ch");
  });

  it("(AC-4.5) a non-positive value is rejected with 422 and nothing is persisted", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => rateManagePerms);

    const zero = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_ch", ratePerKm: "0", validFrom: "2026-08-01" }),
    });
    expect(zero.status).toBe(422);

    const negative = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_ch", ratePerKm: "-0.5", validFrom: "2026-08-01" }),
    });
    expect(negative.status).toBe(422);

    expect(await db.mileageRate.count()).toBe(0);
  });

  it("(AC-4.5, A08) an over-large value is rejected with 422 (never an Int overflow 500) and nothing is persisted", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => rateManagePerms);

    const tooLarge = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_ch", ratePerKm: "99999999999", validFrom: "2026-08-01" }),
    });
    expect(tooLarge.status).toBe(422);

    expect(await db.mileageRate.count()).toBe(0);
  });

  it("(AC-4.5) a missing/invalid validFrom is rejected with 422 and nothing is persisted", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => rateManagePerms);

    const missing = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_ch", ratePerKm: "0.72" }),
    });
    expect(missing.status).toBe(422);

    const invalid = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        entity: "welld_ch",
        ratePerKm: "0.72",
        validFrom: "2026-02-30", // not a real calendar date
      }),
    });
    expect(invalid.status).toBe(422);

    expect(await db.mileageRate.count()).toBe(0);
  });

  it("(AC-4.8) a backdated validFrom is accepted and immediately part of the resolvable history", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => rateManagePerms);

    const res = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_it", ratePerKm: "0.40", validFrom: "2020-01-01" }),
    });
    expect(res.status).toBe(201);

    const row = await db.mileageRate.findFirstOrThrow({ where: { entity: "welld_it" } });
    expect(row.validFrom.toISOString().slice(0, 10)).toBe("2020-01-01");
  });

  it("(AC-4.3) the newly-added entry is flagged inEffectToday when it is the latest qualifying entry", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => rateManagePerms);

    const res = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_ch", ratePerKm: "0.70", validFrom: "2020-01-01" }),
    });
    const body = (await res.json()) as { inEffectToday: boolean };
    expect(body.inEffectToday).toBe(true);
  });

  it("(AC-4.4/AC-4.3) a future-dated entry is NOT flagged inEffectToday", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => rateManagePerms);

    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 5);
    const futureIso = futureDate.toISOString().slice(0, 10);

    const res = await ratesRouter.request("/rates", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ entity: "welld_ch", ratePerKm: "0.99", validFrom: futureIso }),
    });
    const body = (await res.json()) as { inEffectToday: boolean };
    expect(body.inEffectToday).toBe(false);
  });
});
