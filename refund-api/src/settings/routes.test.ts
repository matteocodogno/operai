/**
 * Integration tests for the refund-settings management endpoints (T3,
 * specs/011-refund-settings, plan.md § API contracts).
 *
 * Strategy — mirrors rates/routes.test.ts's header comment: real Postgres
 * (compose, `refund` database), jwt/authz mocked via test-support/testAuth.ts.
 * `settingsRouter` is a NEW router module owned exclusively by this file
 * (testAuth.ts's no-shared-router-specifier rule).
 *
 * AC coverage
 * ───────────
 * AC-1.1 GET returns value/`configured:false` (never configured) or the
 *        current value + `configured:true`
 * AC-1.2 PUT valid email -> GET round-trips the new value
 * AC-1.3 PUT malformed -> 422, latest row unchanged, no new/audit row
 * AC-1.4 PUT ""/null -> configured:false, new audit row old->null
 * AC-1.5 PUT new value then a later read observes it immediately (no restart)
 * AC-3.1 missing settings:read/settings:manage -> 403 on GET/PUT
 * AC-5.1 each transition (set/change/clear) appends a row with actor/ts/old->new
 * AC-5.3 GET history chronological
 * AC-5.4 PUT identical value -> no new row, no audit, still 200
 * (plus) unknown key -> 404 on GET/PUT
 * Security: createdBy* always come from the JWT (never the body)
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

const { settingsRouter } = await import("./routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const NO_GRANTS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [],
  entity: null,
  jobTitle: null,
};

const settingsReadPerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [{ resource: "settings", action: "read", conditions: null }],
  entity: null,
  jobTitle: null,
};

const settingsManagePerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [{ resource: "settings", action: "manage", conditions: null }],
  entity: null,
  jobTitle: null,
};

// D2 (plan.md): read and manage are gated independently — a `manage` grant
// does NOT imply `read`. Tests that PUT then immediately GET (to prove
// round-tripping, e.g. AC-1.2/1.5) need BOTH, mirroring a real admin grant.
const settingsReadAndManagePerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "settings", action: "read", conditions: null },
    { resource: "settings", action: "manage", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const KEY = "accounting-distribution-email";

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

describe(`GET /settings/${KEY}`, () => {
  it("(AC-3.1) 403 without settings:read", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => NO_GRANTS);

    const res = await settingsRouter.request(`/settings/${KEY}`, { headers: authHeaders(token) });
    expect(res.status).toBe(403);
  });

  it("(AC-1.1) never-configured -> configured:false, value:null, empty history", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => settingsReadPerms);

    const res = await settingsRouter.request(`/settings/${KEY}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      value: string | null;
      configured: boolean;
      updatedAt: string | null;
      updatedByEmail: string | null;
      history: unknown[];
    };
    expect(body.key).toBe(KEY);
    expect(body.value).toBeNull();
    expect(body.configured).toBe(false);
    expect(body.updatedAt).toBeNull();
    expect(body.updatedByEmail).toBeNull();
    expect(body.history).toEqual([]);
  });

  it("(404) unknown key", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => settingsReadPerms);

    const res = await settingsRouter.request("/settings/not-a-real-key", {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("(AC-5.3) history is chronological, oldest -> newest", async () => {
    await db.refundSetting.create({
      data: { key: KEY, value: "first@welld.ch", createdByUserId: "a1", createdByEmail: "a1@welld.ch" },
    });
    await db.refundSetting.create({
      data: { key: KEY, value: "second@welld.ch", createdByUserId: "a2", createdByEmail: "a2@welld.ch" },
    });

    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => settingsReadPerms);

    const res = await settingsRouter.request(`/settings/${KEY}`, { headers: authHeaders(token) });
    const body = (await res.json()) as {
      value: string | null;
      configured: boolean;
      history: { value: string | null; changedByEmail: string }[];
    };
    expect(body.value).toBe("second@welld.ch");
    expect(body.configured).toBe(true);
    expect(body.history.map((h) => h.value)).toEqual(["first@welld.ch", "second@welld.ch"]);
    expect(body.history.map((h) => h.changedByEmail)).toEqual(["a1@welld.ch", "a2@welld.ch"]);
  });
});

describe(`PUT /settings/${KEY}`, () => {
  it("(AC-3.1) 403 without settings:manage", async () => {
    const token = await harness.signToken({ sub: "u1", email: "u1@x.com" });
    harness.setResolve(async () => settingsReadPerms); // read-only, not manage

    const res = await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "accounting@welld.ch" }),
    });
    expect(res.status).toBe(403);
    expect(await db.refundSetting.count()).toBe(0);
  });

  it("(404) unknown key", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => settingsManagePerms);

    const res = await settingsRouter.request("/settings/not-a-real-key", {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "x@x.com" }),
    });
    expect(res.status).toBe(404);
  });

  it("(AC-1.2, AC-5.1) persists a valid email, actor from the JWT (never the body)", async () => {
    const token = await harness.signToken({ sub: "admin-42", email: "admin42@welld.ch" });
    harness.setResolve(async () => settingsReadAndManagePerms);

    const res = await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        value: "accounting@welld.ch",
        // Client attempts to smuggle a spoofed actor — MUST be ignored (Security A01/A08).
        createdByUserId: "attacker",
        createdByEmail: "attacker@evil.com",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      value: string | null;
      configured: boolean;
      updatedByEmail: string | null;
    };
    expect(body.value).toBe("accounting@welld.ch");
    expect(body.configured).toBe(true);
    expect(body.updatedByEmail).toBe("admin42@welld.ch");

    const row = await db.refundSetting.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(row.createdByUserId).toBe("admin-42"); // from the JWT, NEVER the body
    expect(row.createdByEmail).toBe("admin42@welld.ch");

    // AC-1.2 — the value round-trips on a subsequent GET (e.g. after a reload).
    const getRes = await settingsRouter.request(`/settings/${KEY}`, { headers: authHeaders(token) });
    const getBody = (await getRes.json()) as { value: string | null };
    expect(getBody.value).toBe("accounting@welld.ch");
  });

  it("(AC-1.3) a malformed value is rejected with 422 and nothing is persisted", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => settingsManagePerms);

    await db.refundSetting.create({
      data: { key: KEY, value: "existing@welld.ch", createdByUserId: "a1", createdByEmail: "a1@welld.ch" },
    });

    const res = await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "not-an-email" }),
    });
    expect(res.status).toBe(422);

    // Nothing new persisted — the previously stored value is unchanged (AC-1.3).
    expect(await db.refundSetting.count()).toBe(1);
    const row = await db.refundSetting.findFirstOrThrow();
    expect(row.value).toBe("existing@welld.ch");
  });

  it('(AC-1.4) clearing ("" -> null) is a distinct transition — configured:false, audit row old->null', async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => settingsManagePerms);

    await db.refundSetting.create({
      data: { key: KEY, value: "existing@welld.ch", createdByUserId: "a1", createdByEmail: "a1@welld.ch" },
    });

    const res = await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: string | null; configured: boolean };
    expect(body.value).toBeNull();
    expect(body.configured).toBe(false);

    const rows = await db.refundSetting.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.value).toBe("existing@welld.ch");
    expect(rows[1]?.value).toBeNull();
    expect(rows[1]?.createdByEmail).toBe("admin@welld.ch");
  });

  it("(AC-5.4) an identical-value PUT is a no-op — no new row, no audit, still 200", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => settingsManagePerms);

    await db.refundSetting.create({
      data: { key: KEY, value: "same@welld.ch", createdByUserId: "a1", createdByEmail: "a1@welld.ch" },
    });

    const res = await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "same@welld.ch" }),
    });
    expect(res.status).toBe(200);
    expect(await db.refundSetting.count()).toBe(1); // no new row appended
  });

  it("(AC-5.4) clearing an already-unconfigured setting (null -> null) is also a no-op", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => settingsManagePerms);

    const res = await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean };
    expect(body.configured).toBe(false);
    expect(await db.refundSetting.count()).toBe(0); // still no row at all
  });

  it("(AC-1.5) a saved value is immediately visible on the very next read (no restart)", async () => {
    const token = await harness.signToken({ sub: "admin-1", email: "admin@welld.ch" });
    harness.setResolve(async () => settingsReadAndManagePerms);

    await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "first@welld.ch" }),
    });
    await settingsRouter.request(`/settings/${KEY}`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ value: "second@welld.ch" }),
    });

    const res = await settingsRouter.request(`/settings/${KEY}`, { headers: authHeaders(token) });
    const body = (await res.json()) as { value: string | null };
    expect(body.value).toBe("second@welld.ch");
  });
});
