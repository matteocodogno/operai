/**
 * Integration tests for POST /system/emails (T3, specs/006-user-invitations,
 * ADR-0011; extended by T7, specs/008-refund-monthly-processing, ADR-0021
 * for the `refund_batch_compiled` template).
 *
 * Strategy mirrors notifications/raise.routes.test.ts: real Postgres
 * (compose, host:5435, database: notify) — no DB mocking. `@/lib/resend` is
 * module-mocked (same technique as channels/email.channel.test.ts) so tests
 * can control the simulated Resend outcome without touching real credentials
 * or the network.
 *
 * NOTE: deliberately does NOT `mock.module("@/lib/env", …)` — see
 * channels/email.channel.test.ts's file header for why: `env` is a
 * process-wide singleton (bun test runs every file in one process) and other
 * files (stream.routes.test.ts) depend on its real fields. This file imports
 * the REAL `env`, reads the REAL `NOTIFY_INTERNAL_TOKEN` (set in the worktree
 * `.env`, loaded below) as the "valid token" for tests, and mutates only
 * `EMAIL_ENABLED` for the Resend-failure test, restoring it in `afterEach`.
 *
 * done when (tasks.md T3): valid token → send (stub/real) 200
 * {deliveryId,status}; missing/wrong token → 401; a user JWT is rejected on
 * /system/*; bad to/template → 400; Resend failure surfaced as
 * {status:"failed"} (never a 5xx that fails the caller).
 *
 * done when (tasks.md T7): `refund_batch_compiled` sends 200 with the deep
 * link + batch reference persisted as `template`; its per-template `data`
 * shape is enforced both ways (invitation data rejected for this template
 * and vice versa); the internal-token gate is unchanged for the new
 * template; escaping itself is covered at the render layer
 * (emailTemplates.test.ts) since this file asserts persistence/status, not
 * rendered HTML content.
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { env } from "@/lib/env";

const ORIGINAL_EMAIL_ENABLED = env.EMAIL_ENABLED;
// The real, valid internal token (worktree .env) — used as the "correct"
// credential throughout; deliberately NOT overridden so this test proves the
// actual middleware/env wiring, not a mock's approximation of it.
const VALID_INTERNAL_TOKEN = env.NOTIFY_INTERNAL_TOKEN;

// ─── @/lib/resend mock — controlled per test via sendEmailImpl ───────────────

type SendEmailResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

let sendEmailImpl: (input: {
  to: string;
  subject: string;
  html: string;
}) => Promise<SendEmailResult> = async () => ({
  ok: true,
  providerId: "unused",
});

mock.module("@/lib/resend", () => ({
  sendEmail: (input: { to: string; subject: string; html: string }) =>
    sendEmailImpl(input),
}));

// ─── Real DB (compose, database: notify) ──────────────────────────────────────

import { config as dotenvConfig } from "dotenv";
dotenvConfig({
  path: new URL("../../.env", import.meta.url).pathname,
  override: true,
});

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");

const realDatabaseUrl = process.env["DATABASE_URL"]!;
const freshAdapter = new PrismaPg({ connectionString: realDatabaseUrl });
const freshDb = new PrismaClient({ adapter: freshAdapter });

mock.module("@/lib/db", () => ({ db: freshDb }));

const { systemEmailsRouter } = await import("./emails.routes");

const testDb = freshDb;
const TEST_ADDRESS_PREFIX = "system-emails-test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  app.route("/", systemEmailsRouter);
  return app;
};

const validBody = (overrides?: Record<string, unknown>) => ({
  to: `${TEST_ADDRESS_PREFIX}-invitee@example.com`,
  template: "invitation",
  data: {
    inviteUrl: "https://auth.operai.welld.io/invite?id=inv_1&token=abc123",
    inviterName: "Admin",
    expiresAt: "2026-07-16T10:00:00Z",
  },
  ...overrides,
});

afterEach(async () => {
  env.EMAIL_ENABLED = ORIGINAL_EMAIL_ENABLED;
  await testDb.emailDelivery.deleteMany({
    where: { to: { contains: TEST_ADDRESS_PREFIX } },
  });
});

// ─── Happy path (T3 done-when) ────────────────────────────────────────────────

describe("POST /system/emails — valid internal token", () => {
  it("200: stub send (EMAIL_ENABLED=false) → {deliveryId, status:'sent'}, EmailDelivery recorded", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveryId: string; status: string };
    expect(json.status).toBe("sent");
    expect(json.deliveryId).toBeTruthy();

    const row = await testDb.emailDelivery.findUnique({
      where: { id: json.deliveryId },
    });
    expect(row?.to).toBe(`${TEST_ADDRESS_PREFIX}-invitee@example.com`);
    expect(row?.template).toBe("invitation");
    expect(row?.status).toBe("sent");
    expect(row?.providerId).toMatch(/^stub_/);
  });

  it("200: invitation_resend template also succeeds", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ template: "invitation_resend" })),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveryId: string; status: string };
    expect(json.status).toBe("sent");

    const row = await testDb.emailDelivery.findUnique({
      where: { id: json.deliveryId },
    });
    expect(row?.template).toBe("invitation_resend");
  });

  it("200: a Resend/network failure is surfaced as {status:'failed'} — never a 5xx", async () => {
    env.EMAIL_ENABLED = true;
    sendEmailImpl = async () => ({ ok: false, error: "simulated network timeout" });

    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      deliveryId: string;
      status: string;
      error?: string;
    };
    expect(json.status).toBe("failed");
    expect(json.error).toBe("simulated network timeout");

    const row = await testDb.emailDelivery.findUnique({
      where: { id: json.deliveryId },
    });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("simulated network timeout");
  });
});

// ─── Auth (Security R2, ADR-0011) ─────────────────────────────────────────────

describe("POST /system/emails — internal-token auth (Security R2, ADR-0011)", () => {
  it("401: missing X-Internal-Token header, nothing persisted", async () => {
    const app = buildApp();
    const before = await testDb.emailDelivery.count({
      where: { to: { contains: TEST_ADDRESS_PREFIX } },
    });

    const res = await app.request("/system/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);

    const after = await testDb.emailDelivery.count({
      where: { to: { contains: TEST_ADDRESS_PREFIX } },
    });
    expect(after).toBe(before);
  });

  it("401: wrong X-Internal-Token value, nothing persisted", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": "definitely-not-the-right-token-but-long-enough",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  it("401: a user JWT (Authorization: Bearer …) is rejected — /system/emails never accepts a user JWT in place of the internal token", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer some.made.up.jwt.value",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    // No X-Internal-Token header at all — internalTokenMiddleware doesn't
    // read Authorization, so a Bearer JWT (however well-formed) is simply not
    // the credential it checks; it is rejected exactly like any other
    // missing/wrong token.
    expect(res.status).toBe(401);
  });

  it("401: a user JWT presented ALONGSIDE a wrong X-Internal-Token is still rejected (the JWT does not substitute for it)", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer some.made.up.jwt.value",
        "X-Internal-Token": "still-the-wrong-token-value-but-long-enough",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });
});

// ─── Validation → 400 ─────────────────────────────────────────────────────────

describe("POST /system/emails — validation failures → 400", () => {
  it("400: `to` is not a valid email address", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ to: "not-an-email" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: unrecognised `template`", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ template: "password_reset" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: missing data.inviteUrl", async () => {
    const app = buildApp();
    const body = validBody();
    const { inviteUrl: _inviteUrl, ...restData } = (
      body as { data: Record<string, unknown> }
    ).data;
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, data: restData }),
    });
    expect(res.status).toBe(400);
  });

  it("400: data.expiresAt is not a valid ISO 8601 datetime", async () => {
    const app = buildApp();
    const body = validBody();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        data: { ...(body as { data: Record<string, unknown> }).data, expiresAt: "not-a-date" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("nothing is persisted after a 400 (no partial write)", async () => {
    const app = buildApp();
    const before = await testDb.emailDelivery.count({
      where: { to: { contains: TEST_ADDRESS_PREFIX } },
    });

    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ to: "not-an-email" })),
    });
    expect(res.status).toBe(400);

    const after = await testDb.emailDelivery.count({
      where: { to: { contains: TEST_ADDRESS_PREFIX } },
    });
    expect(after).toBe(before);
  });
});

// ─── refund_batch_compiled template (T7, specs/008-refund-monthly-processing,
// plan.md §Email, ADR-0021) ────────────────────────────────────────────────

const validRefundBatchBody = (overrides?: Record<string, unknown>) => ({
  to: `${TEST_ADDRESS_PREFIX}-accounting@example.com`,
  template: "refund_batch_compiled",
  data: {
    batchUrl: "https://app.operai.welld.io/refund/batches/batch_abc123",
    batchReference: "batch_abc123",
    cutoff: "2026-07-19T23:59:59Z",
    generatedAt: "2026-07-20T08:00:00Z",
    requestCount: 4,
  },
  ...overrides,
});

describe("POST /system/emails — refund_batch_compiled (T7, ADR-0021)", () => {
  it("200: valid deep-link body → {deliveryId, status:'sent'}, EmailDelivery recorded with the new template", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validRefundBatchBody()),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveryId: string; status: string };
    expect(json.status).toBe("sent");

    const row = await testDb.emailDelivery.findUnique({
      where: { id: json.deliveryId },
    });
    expect(row?.to).toBe(`${TEST_ADDRESS_PREFIX}-accounting@example.com`);
    expect(row?.template).toBe("refund_batch_compiled");
    expect(row?.status).toBe("sent");
  });

  it("400: data.batchUrl missing", async () => {
    const app = buildApp();
    const body = validRefundBatchBody();
    const { batchUrl: _batchUrl, ...restData } = (
      body as { data: Record<string, unknown> }
    ).data;
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, data: restData }),
    });
    expect(res.status).toBe(400);
  });

  it("400: data.batchUrl is not a valid URL", async () => {
    const app = buildApp();
    const body = validRefundBatchBody();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        data: { ...(body as { data: Record<string, unknown> }).data, batchUrl: "not-a-url" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: data.batchReference missing", async () => {
    const app = buildApp();
    const body = validRefundBatchBody();
    const { batchReference: _batchReference, ...restData } = (
      body as { data: Record<string, unknown> }
    ).data;
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, data: restData }),
    });
    expect(res.status).toBe(400);
  });

  it("400: data.cutoff is not a valid ISO 8601 datetime", async () => {
    const app = buildApp();
    const body = validRefundBatchBody();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        data: { ...(body as { data: Record<string, unknown> }).data, cutoff: "not-a-date" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: data.requestCount is negative", async () => {
    const app = buildApp();
    const body = validRefundBatchBody();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        data: { ...(body as { data: Record<string, unknown> }).data, requestCount: -1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: data.requestCount is not an integer", async () => {
    const app = buildApp();
    const body = validRefundBatchBody();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        data: { ...(body as { data: Record<string, unknown> }).data, requestCount: 1.5 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: the invitation `data` shape is rejected for template=refund_batch_compiled (per-template shape is enforced, not just presence of any `data`)", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: `${TEST_ADDRESS_PREFIX}-accounting@example.com`,
        template: "refund_batch_compiled",
        data: {
          inviteUrl: "https://auth.operai.welld.io/invite?id=inv_1&token=abc123",
          inviterName: "Admin",
          expiresAt: "2026-07-16T10:00:00Z",
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: the refund_batch_compiled `data` shape is rejected for template=invitation", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: `${TEST_ADDRESS_PREFIX}-invitee@example.com`,
        template: "invitation",
        data: (validRefundBatchBody() as { data: Record<string, unknown> }).data,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("401: internal-token gate is unchanged for the new template — missing token still rejected", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRefundBatchBody()),
    });
    expect(res.status).toBe(401);
  });
});
