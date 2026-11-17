/**
 * Integration tests for POST /system/emails (T3, specs/20260713-user-invitations,
 * ADR 20260714-notify-api-email-channel-service-trust; extended by T7, specs/20260719-refund-monthly-processing, ADR 20260719-refund-batch-signed-link-email-delivery
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
 * the REAL `env`, authenticates with an in-memory scoped service JWT
 * (specs/20261013-notify-service-credentials T14: the only credential), and mutates only
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
import { expectZodIssuesBody } from "@/lib/zodIssuesBody.fixture";
import { env } from "@/lib/env";

const ORIGINAL_EMAIL_ENABLED = env.EMAIL_ENABLED;

// ─── Service credential (specs/20261013-notify-service-credentials T14: the only credential) ──────────────────
// Keys and JWKS are generated in memory and injected into the auth middleware,
// so the test exercises the real middleware without a live auth service.

import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { createSystemAuthMiddleware } from "./systemAuth.middleware";

const SERVICE_AUD = "operai-system-emails-test";
const KID = "emails-kid";
const keyPair = await generateKeyPair("RS256");
const localJwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
});
const serviceToken = (scope: string = "emails.send") =>
  new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(SERVICE_AUD)
    .setSubject("system:refund-api")
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);
const authHeader = async () => ({ Authorization: `Bearer ${await serviceToken()}` });

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

const { createSystemEmailsRouter } = await import("./emails.routes");

const testDb = freshDb;
const TEST_ADDRESS_PREFIX = "system-emails-test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  app.route(
    "/",
    createSystemEmailsRouter(
      createSystemAuthMiddleware({ scope: "emails.send", jwks: localJwks, audience: SERVICE_AUD }),
    ),
  );
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

describe("POST /system/emails — valid service credential", () => {
  it("200: stub send (EMAIL_ENABLED=false) → {deliveryId, status:'sent'}, EmailDelivery recorded", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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

// ─── Auth (Security R2, ADR 20260714-notify-api-email-channel-service-trust) ─────────────────────────────────────────────

describe("POST /system/emails — service-credential auth (Security R2, ADR 20260714-notify-api-email-channel-service-trust, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired)", () => {
  it("401: no credential, nothing persisted", async () => {
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

  it("401: X-Internal-Token (the retired shared header), any value, nothing persisted (AC-5.1)", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        "X-Internal-Token": "x".repeat(48),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  it("401: a user JWT (Authorization: Bearer …) is rejected — /system/emails never accepts a user JWT as a service credential", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer some.made.up.jwt.value",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    // A Bearer that is not a verifiable service JWT is rejected exactly like
    // any other missing credential.
    expect(res.status).toBe(401);
  });

  it("401: a user JWT presented ALONGSIDE an X-Internal-Token is still rejected (neither is a credential)", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer some.made.up.jwt.value",
        "X-Internal-Token": "x".repeat(48),
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
        ...(await authHeader()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ to: "not-an-email" })),
    });
    expect(res.status).toBe(400);
  });

  it("400 body keeps the { success: false, error: { issues, name } } shape (src/lib/zodHook.ts)", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        ...(await authHeader()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ template: "password_reset" })),
    });
    await expectZodIssuesBody(res, ["template"]);
  });

  it("400: unrecognised `template`", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        ...(await authHeader()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ template: "password_reset" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: `notification_notice` is not callable here (its address comes only from auth, specs/20261101-crm-notifications)", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        ...(await authHeader()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: "someone@example.test",
        template: "notification_notice",
        data: {
          title: "t",
          body: "b",
          originApp: "crm",
          appBaseUrl: "https://operai.example.test",
        },
      }),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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

// ─── refund_batch_compiled template (T7, specs/20260719-refund-monthly-processing,
// plan.md §Email, ADR 20260719-refund-batch-signed-link-email-delivery) ────────────────────────────────────────────────

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

describe("POST /system/emails — refund_batch_compiled (T7, ADR 20260719-refund-batch-signed-link-email-delivery)", () => {
  it("200: valid deep-link body → {deliveryId, status:'sent'}, EmailDelivery recorded with the new template", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: {
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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
        ...(await authHeader()),
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

  it("401: the credential gate is unchanged for the new template — a missing credential is still rejected", async () => {
    const app = buildApp();
    const res = await app.request("/system/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRefundBatchBody()),
    });
    expect(res.status).toBe(401);
  });
});

// ─── Decision emails (specs/20260716-refund-service AC-3.6, email channel) ──────

const post = async (body: unknown) =>
  buildApp().request("/system/emails", {
    method: "POST",
    headers: {
      ...(await authHeader()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const validApprovedBody = () => ({
  to: `${TEST_ADDRESS_PREFIX}-employee@example.com`,
  template: "refund_decision_approved",
  data: {
    requestUrl: "https://app.operai.welld.io/refund/requests/req_abc123",
    decidedAt: "2026-09-08T10:00:00Z",
    approvedTotals: [{ currency: "CHF", amountCents: 215600 }],
  },
});

const validRejectedBody = () => ({
  to: `${TEST_ADDRESS_PREFIX}-employee@example.com`,
  template: "refund_decision_rejected",
  data: {
    requestUrl: "https://app.operai.welld.io/refund/requests/req_abc123",
    decidedAt: "2026-09-08T10:00:00Z",
  },
});

describe("POST /system/emails — refund decision templates", () => {
  it("200: approved body → sent, recorded under its own template name", async () => {
    const res = await post(validApprovedBody());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveryId: string; status: string };
    expect(json.status).toBe("sent");

    const row = await testDb.emailDelivery.findUnique({ where: { id: json.deliveryId } });
    expect(row?.template).toBe("refund_decision_approved");
  });

  it("200: rejected body → sent, recorded under its own template name", async () => {
    const res = await post(validRejectedBody());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveryId: string; status: string };

    const row = await testDb.emailDelivery.findUnique({ where: { id: json.deliveryId } });
    expect(row?.template).toBe("refund_decision_rejected");
  });

  it("400: approved with no approvedTotals — an approval email with no figure is meaningless", async () => {
    const body = validApprovedBody();
    const res = await post({ ...body, data: { ...body.data, approvedTotals: [] } });
    expect(res.status).toBe(400);
  });

  it("400: amountCents is a float, not integer minor units (ADR 20260720-mileage-rate-money-precision-integer-micros)", async () => {
    const body = validApprovedBody();
    const res = await post({
      ...body,
      data: { ...body.data, approvedTotals: [{ currency: "CHF", amountCents: 2156.5 }] },
    });
    expect(res.status).toBe(400);
  });

  it("400: an unsupported currency code", async () => {
    const body = validApprovedBody();
    const res = await post({
      ...body,
      data: { ...body.data, approvedTotals: [{ currency: "XYZ", amountCents: 100 }] },
    });
    expect(res.status).toBe(400);
  });

  it("400: requestUrl is not a valid absolute URL", async () => {
    const body = validApprovedBody();
    const res = await post({ ...body, data: { ...body.data, requestUrl: "/refund/requests/x" } });
    expect(res.status).toBe(400);
  });

  // The discriminated union is what keeps each template's field set closed
  // (emails.schemas.ts's stated security property): an approved payload sent
  // under the rejected template must not satisfy the rejected shape's
  // requirements by accident, and vice versa.
  it("400: the rejected template cannot borrow the approved template's required shape", async () => {
    const res = await post({
      to: `${TEST_ADDRESS_PREFIX}-employee@example.com`,
      template: "refund_decision_approved",
      data: validRejectedBody().data, // no approvedTotals
    });
    expect(res.status).toBe(400);
  });
});

// ─── legal_entity_change (specs/20261117-legal-entities T57, AC-9.11-9.13) ──────────────────────────────────
// The PRODUCTION policy table is in force here (no `policy` injected): `system:auth` only, `recipientId` allowed.

const AUTH_SUB = "system:auth";
const tokenFor = (sub: string) =>
  new SignJWT({ scope: "emails.send" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(SERVICE_AUD)
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);

type Lookup = { status: "found"; email: string; name: string } | { status: "inactive" } | { status: "failed" };
let lookups: string[] = [];
let lookupResult: Lookup = {
  status: "found",
  email: `${TEST_ADDRESS_PREFIX}-legal-person@example.com`,
  name: "Person",
};
let sentMails: { to: string; subject: string; html: string }[] = [];

const buildLegalApp = (overrides: { contacts?: null; appBaseUrl?: string | undefined } = {}) => {
  const app = new Hono();
  app.route(
    "/",
    createSystemEmailsRouter(
      createSystemAuthMiddleware({ scope: "emails.send", jwks: localJwks, audience: SERVICE_AUD }),
      {
        contacts:
          "contacts" in overrides
            ? null
            : {
                lookup: async (id) => {
                  lookups.push(id);
                  return lookupResult;
                },
              },
        appBaseUrl: "appBaseUrl" in overrides ? overrides.appBaseUrl : "https://operai.example.test",
      },
    ),
  );
  return app;
};

const postAs = async (app: Hono, body: Record<string, unknown>, sub: string = AUTH_SUB) =>
  app.request("/system/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenFor(sub)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const LEGAL_DATA = {
  entity: "welld_ch",
  action: "save",
  restoredFrom: null,
  actorName: "Anna Rossi",
  storedAt: "2026-11-17T09:12:00.000Z",
  version: 8,
  protectedChanged: ["iban"],
  otherChanged: ["contacts.en"],
  iban: { old: { state: "tail", last4: "5957" }, new: { state: "none" } },
};
const legalBody = (overrides: Record<string, unknown> = {}) => ({
  to: `${TEST_ADDRESS_PREFIX}-legal-outside@example.com`,
  template: "legal_entity_change",
  data: LEGAL_DATA,
  ...overrides,
});
const legalById = (overrides: Record<string, unknown> = {}) => {
  const { to: _to, ...rest } = legalBody();
  return { ...rest, recipientId: "user_1", ...overrides };
};
const withData = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  legalBody({ data: { ...LEGAL_DATA, ...data }, ...extra });
const legalRows = () =>
  testDb.emailDelivery.findMany({ where: { to: { contains: TEST_ADDRESS_PREFIX } }, orderBy: { createdAt: "asc" } });

describe("POST /system/emails — legal_entity_change", () => {
  const priorImpl = sendEmailImpl;
  afterEach(() => {
    lookups = [];
    sentMails = [];
    lookupResult = { status: "found", email: `${TEST_ADDRESS_PREFIX}-legal-person@example.com`, name: "Person" };
    sendEmailImpl = priorImpl;
  });

  const capture = () => {
    env.EMAIL_ENABLED = true; // the real channel path, with `@/lib/resend` mocked: the test sees what would be sent
    sendEmailImpl = async (input) => {
      sentMails.push(input);
      return { ok: true, providerId: "re_fake" };
    };
  };

  it("system:auth sends it to a raw address: 200 sent, one row under the template name, English subject and absolute link", async () => {
    capture();
    const res = await postAs(buildLegalApp(), legalBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deliveryId: string; status: string };
    expect(body.status).toBe("sent");
    const rows = await legalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.template).toBe("legal_entity_change");
    expect(rows[0]?.id).toBe(body.deliveryId);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.subject).toBe("Legal details of WellD CH changed: IBAN");
    expect(sentMails[0]?.html).toContain(
      'href="https://operai.example.test/admin/legal-entities?entity=welld_ch&amp;view=history"',
    );
    expect(lookups).toEqual([]);
  });

  it("system:crm-api (and any other caller) -> 403 template_not_allowed, nothing written, nothing sent", async () => {
    capture();
    for (const sub of ["system:crm-api", "system:refund-api"]) {
      const res = await postAs(buildLegalApp(), legalBody(), sub);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("template_not_allowed");
    }
    expect(await legalRows()).toHaveLength(0);
    expect(sentMails).toHaveLength(0);
  });

  it("recipientId: the address comes from the lookup; the user id is not in the mail or the row", async () => {
    capture();
    const res = await postAs(buildLegalApp(), legalById());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("sent");
    expect(lookups).toEqual(["user_1"]);
    expect(sentMails[0]?.to).toBe(`${TEST_ADDRESS_PREFIX}-legal-person@example.com`);
    expect(sentMails[0]?.html).not.toContain("user_1");
  });

  it("recipientId inactive -> 200 skipped recipient_inactive, no row, no send", async () => {
    capture();
    lookupResult = { status: "inactive" };
    const res = await postAs(buildLegalApp(), legalById());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "skipped", reason: "recipient_inactive" });
    expect(await legalRows()).toHaveLength(0);
    expect(sentMails).toHaveLength(0);
  });

  it("recipientId lookup failure -> 200 failed contact_lookup_failed, no row, no send", async () => {
    capture();
    lookupResult = { status: "failed" };
    const res = await postAs(buildLegalApp(), legalById());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "failed", reason: "contact_lookup_failed" });
    expect(await legalRows()).toHaveLength(0);
    expect(sentMails).toHaveLength(0);
  });

  it("recipientId with the email-notice group unset -> 200 skipped not_configured, no lookup, no row", async () => {
    capture();
    const res = await postAs(buildLegalApp({ contacts: null }), legalById());
    expect(await res.json()).toEqual({ status: "skipped", reason: "not_configured" });
    const noBase = await postAs(buildLegalApp({ appBaseUrl: undefined }), legalById());
    expect(await noBase.json()).toEqual({ status: "skipped", reason: "not_configured" });
    expect(lookups).toEqual([]);
    expect(await legalRows()).toHaveLength(0);
  });

  it("a raw address with no APP_BASE_URL has no link to send: skipped not_configured, nothing written", async () => {
    capture();
    const res = await postAs(buildLegalApp({ appBaseUrl: undefined }), legalBody());
    expect(await res.json()).toEqual({ status: "skipped", reason: "not_configured" });
    expect(await legalRows()).toHaveLength(0);
    expect(sentMails).toHaveLength(0);
  });

  it("`recipientId` stays this template's alone: another template with it -> 400", async () => {
    const { to: _to, ...rest } = validBody();
    const res = await postAs(buildLegalApp(), { ...rest, recipientId: "user_1" }, AUTH_SUB);
    expect(res.status).toBe(400);
    expect(lookups).toEqual([]);
  });

  describe("strict data -> 400, nothing written or sent", () => {
    const rejected = async (body: Record<string, unknown>) => {
      capture();
      const res = await postAs(buildLegalApp(), body);
      expect(res.status).toBe(400);
      expect(await legalRows()).toHaveLength(0);
      expect(sentMails).toHaveLength(0);
    };

    it("an extra member in data", () => rejected(withData({ oldLegalName: "Acme AG" })));
    it("an extra member inside an IBAN token", () =>
      rejected(withData({ iban: { old: { state: "tail", last4: "5957", full: "CH9300762011623852957" }, new: { state: "none" } } })));
    it("an extra member inside the iban object", () =>
      rejected(withData({ iban: { old: { state: "none" }, new: { state: "none" }, full: "CH93" } })));
    it("a last4 that is a whole IBAN", () =>
      rejected(withData({ iban: { old: { state: "tail", last4: "CH9300762011623852957" }, new: { state: "none" } } })));
    it("a last4 of 3 or 5 characters, lower case or with a space", async () => {
      for (const last4 of ["595", "59570", "ab12", "59 7", "59-7", ""]) {
        await rejected(withData({ iban: { old: { state: "tail", last4 }, new: { state: "none" } } }));
      }
    });
    it("a `set` token carrying characters", () =>
      rejected(withData({ iban: { old: { state: "set", last4: "5957" }, new: { state: "none" } } })));
    it("an unknown IBAN state", () => rejected(withData({ iban: { old: { state: "full" }, new: { state: "none" } } })));
    it("iban present without \"iban\" in protectedChanged", () =>
      rejected(withData({ protectedChanged: ["legalName"] })));
    it("\"iban\" in protectedChanged without iban", () => rejected(withData({ iban: undefined })));
    it("an empty or unknown protectedChanged, a duplicate name", async () => {
      await rejected(withData({ protectedChanged: [], iban: undefined }));
      await rejected(withData({ protectedChanged: ["iban", "swift"] }));
      await rejected(withData({ protectedChanged: ["iban", "iban"] }));
      await rejected(withData({ otherChanged: ["contacts.en", "contacts.en"] }));
      await rejected(withData({ otherChanged: ["notes"] }));
    });
    it("an unknown entity, action or a non-ISO storedAt", async () => {
      await rejected(withData({ entity: "welld_de" }));
      await rejected(withData({ action: "delete" }));
      await rejected(withData({ storedAt: "17 November 2026" }));
    });
    it("a restore without restoredFrom, a save with one", async () => {
      await rejected(withData({ action: "restore", restoredFrom: null }));
      await rejected(withData({ action: "save", restoredFrom: 3 }));
    });
    it("a missing member and a bad version or actor", async () => {
      const { version: _v, ...noVersion } = LEGAL_DATA;
      await rejected(legalBody({ data: noVersion }));
      await rejected(withData({ version: 0 }));
      await rejected(withData({ version: 1.5 }));
      await rejected(withData({ actorName: "" }));
      await rejected(withData({ actorName: "a".repeat(201) }));
    });
    it("another template's data", () => rejected(legalBody({ data: { inviteUrl: "https://x.test", inviterName: "A", expiresAt: "2026-07-16T10:00:00Z" } })));
  });

  it("the full IBAN, name and VAT number in an otherwise valid request can never be echoed: they are refused, not rendered", async () => {
    capture();
    const res = await postAs(
      buildLegalApp(),
      withData({ legalName: "Acme Treuhand AG", vatNumber: "CHE-123.456.789", fullIban: "CH9300762011623852957" }),
    );
    expect(res.status).toBe(400);
    expect(sentMails).toHaveLength(0);
  });

  it("a restore of version m sends 'Version m restored by …' and a retried key sends once", async () => {
    capture();
    const body = withData(
      { action: "restore", restoredFrom: 5, storedAt: "2026-07-01T09:12:00Z" },
      { idempotencyKey: "legal-entity-notice:row_t57" },
    );
    const first = await postAs(buildLegalApp(), body);
    const second = await postAs(buildLegalApp(), body);
    expect(((await first.json()) as { status: string }).status).toBe("sent");
    expect(((await second.json()) as { status: string }).status).toBe("sent");
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.html).toContain("Version 5 restored by Anna Rossi.");
    expect(sentMails[0]?.html).toContain("1 July 2026, 11:12 CEST (Europe/Zurich)");
  });
});
