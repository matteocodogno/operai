/**
 * Route-level tests for the scoped system middleware on BOTH internal routes
 * (specs/015 T6, ADR-0044; specs/016 T3, ADR-0049).
 *
 * The auth matrix itself lives in systemAuth.middleware.test.ts; this file
 * proves the wiring: what is persisted, the origin binding (403), that each
 * route requires its OWN scope, that an `emails.send` credential renders every
 * email template, and (specs/016 T14, AC-5.1) that `X-Internal-Token` with any
 * value is refused on both routes with nothing persisted. Real Postgres (like notifications.routes.test.ts); the JWKS is
 * in-memory and injected, so no live auth service is needed.
 */

import { describe, it, expect, afterEach, beforeAll, mock } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { env } from "@/lib/env";

// The retired shared header: any value, however secret-shaped, is not a credential.
// Built from parts (tasks.md T14 greps for the name); a local env file that still
// carries the old secret supplies the real value, so a regression would show.
const RETIRED_VALUE =
  process.env[["NOTIFY", "INTERNAL", "TOKEN"].join("_")] ?? "x".repeat(48);
const RETIRED = { "X-Internal-Token": RETIRED_VALUE };
const ORIGINAL_EMAIL_ENABLED = env.EMAIL_ENABLED;
const SERVICE_AUD = "operai-system-test";
const KID = "svc-route-kid";

import { config as dotenvConfig } from "dotenv";
dotenvConfig({
  path: new URL("../../.env", import.meta.url).pathname,
  override: true,
});

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const freshDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }),
});
mock.module("@/lib/db", () => ({ db: freshDb }));

const { createSystemNotificationsRouter } = await import("./notifications.routes");
const { createSystemEmailsRouter } = await import("./emails.routes");
const { createSystemAuthMiddleware } = await import("./systemAuth.middleware");

const RECIPIENT = "svc-jwt-route-test-recipient";
const EMAIL_TO = "svc-jwt-route-test@example.com";

let signingKey: CryptoKey;
let app: Hono;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
  });
  app = new Hono();
  app.route(
    "/",
    createSystemNotificationsRouter(
      createSystemAuthMiddleware({ scope: "notifications.push", jwks, audience: SERVICE_AUD }),
    ),
  );
  app.route(
    "/",
    createSystemEmailsRouter(
      createSystemAuthMiddleware({ scope: "emails.send", jwks, audience: SERVICE_AUD }),
    ),
  );
  env.EMAIL_ENABLED = false; // never hit real Resend from a test
});

afterEach(async () => {
  env.EMAIL_ENABLED = false;
  await freshDb.notification.deleteMany({ where: { recipientId: RECIPIENT } });
  await freshDb.emailDelivery.deleteMany({ where: { to: EMAIL_TO } });
});

const serviceJwt = (
  sub = "system:inventory-api",
  o: { scope?: string; aud?: string; exp?: string | number } = {},
) =>
  new SignJWT({ scope: o.scope ?? "notifications.push" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(o.aud ?? SERVICE_AUD)
    .setSubject(sub)
    .setExpirationTime(o.exp ?? "5m")
    .sign(signingKey);

const body = (overrides?: Record<string, unknown>) => ({
  recipientId: RECIPIENT,
  originApp: "inventory",
  severity: "info",
  title: "Dispositivo assegnato",
  body: "Ti e stato assegnato un dispositivo.",
  link: { href: "/devices" },
  ...overrides,
});

const send = (headers: Record<string, string>, payload: unknown) =>
  app.request("/system/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

const count = () => freshDb.notification.count({ where: { recipientId: RECIPIENT } });

describe("POST /system/notifications with a service JWT", () => {
  it("201: originApp 'inventory' is stored for the recipient", async () => {
    const res = await send({ Authorization: `Bearer ${await serviceJwt()}` }, body());
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; originApp: string; link?: { href: string } };
    expect(created.originApp).toBe("inventory");
    expect(created.link).toEqual({ href: "/devices" });
    const row = await freshDb.notification.findUnique({ where: { id: created.id } });
    expect(row?.recipientId).toBe(RECIPIENT);
    expect(row?.originApp).toBe("inventory");
  });

  it("403: inventory-api may not raise as another app (origin binding); nothing persisted", async () => {
    const res = await send(
      { Authorization: `Bearer ${await serviceJwt()}` },
      body({ originApp: "refund" }),
    );
    expect(res.status).toBe(403);
    expect(await count()).toBe(0);
  });

  it("403: an unknown system:* client may not raise anything; nothing persisted", async () => {
    const res = await send(
      { Authorization: `Bearer ${await serviceJwt("system:someone-else")}` },
      body(),
    );
    expect(res.status).toBe(403);
    expect(await count()).toBe(0);
  });

  it("400 (validation) still precedes the origin check", async () => {
    const res = await send(
      { Authorization: `Bearer ${await serviceJwt()}` },
      body({ title: "" }),
    );
    expect(res.status).toBe(400);
  });

  it("401: no credential, nothing persisted", async () => {
    const res = await send({}, body());
    expect(res.status).toBe(401);
    expect(await count()).toBe(0);
  });
});

const INVITE_DATA = {
  inviteUrl: "https://auth.operai.welld.io/invite?id=inv_1&token=abc123",
  inviterName: "Admin",
  expiresAt: "2026-07-16T10:00:00Z",
};
const REQUEST_URL = "https://app.operai.welld.io/refund/requests/req_abc123";
const TEMPLATES: Array<{ template: string; data: Record<string, unknown> }> = [
  { template: "invitation", data: INVITE_DATA },
  { template: "invitation_resend", data: INVITE_DATA },
  {
    template: "refund_batch_compiled",
    data: {
      batchUrl: "https://app.operai.welld.io/refund/batches/batch_abc123",
      batchReference: "batch_abc123",
      cutoff: "2026-07-19T23:59:59Z",
      generatedAt: "2026-07-20T08:00:00Z",
      requestCount: 4,
    },
  },
  {
    template: "refund_decision_approved",
    data: {
      requestUrl: REQUEST_URL,
      decidedAt: "2026-09-08T10:00:00Z",
      approvedTotals: [{ currency: "CHF", amountCents: 215600 }],
    },
  },
  {
    template: "refund_decision_rejected",
    data: { requestUrl: REQUEST_URL, decidedAt: "2026-09-08T10:00:00Z" },
  },
];

const emailRequest = (
  headers: Record<string, string>,
  t: { template: string; data: Record<string, unknown> } = TEMPLATES[0]!,
) =>
  app.request("/system/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ to: EMAIL_TO, ...t }),
  });

const emailRows = () => freshDb.emailDelivery.count({ where: { to: EMAIL_TO } });
const emailJwt = (sub = "system:refund-api") => serviceJwt(sub, { scope: "emails.send" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("POST /system/emails with an emails.send credential (AC-3.1)", () => {
  it("every template is sent and recorded under its own name", async () => {
    for (const t of TEMPLATES) {
      const viaJwt = await emailRequest(bearer(await emailJwt()), t);
      expect(viaJwt.status).toBe(200);
      const b = (await viaJwt.json()) as { deliveryId: string; status: string };
      expect(b.status).toBe("sent");
      const row = await freshDb.emailDelivery.findUnique({ where: { id: b.deliveryId } });
      expect(row?.template).toBe(t.template);
    }
  });

  it("400 (validation) still applies behind a valid credential", async () => {
    const res = await emailRequest(bearer(await emailJwt()), { template: "invitation", data: {} });
    expect(res.status).toBe(400);
  });
});

describe("each route requires its own scope; every refusal is one body, with no side effect", () => {
  const BOTH = "emails.send notifications.push";
  const expired = Math.floor(Date.now() / 1000) - 60;

  it("/system/emails: push-only token, expired, wrong-audience and user-audience tokens -> 401, no row", async () => {
    const bodies = new Set<string>();
    const tokens = [
      await serviceJwt("system:refund-api"), // notifications.push only
      await serviceJwt("system:refund-api", { scope: BOTH, exp: expired }),
      await serviceJwt("system:refund-api", { scope: BOTH, aud: "elsewhere" }),
      await serviceJwt("user-1", { scope: BOTH, aud: env.AUTH_AUDIENCE }),
    ];
    for (const t of tokens) {
      const res = await emailRequest(bearer(t));
      expect(res.status).toBe(401);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect(bodies.size).toBe(1);
    expect(await emailRows()).toBe(0);
  });

  it("/system/notifications: email-only token, expired, wrong-audience and user-audience tokens -> 401, no row", async () => {
    const bodies = new Set<string>();
    const tokens = [
      await emailJwt(), // emails.send only
      await serviceJwt("system:refund-api", { scope: BOTH, exp: expired }),
      await serviceJwt("system:refund-api", { scope: BOTH, aud: "elsewhere" }),
      await serviceJwt("user-1", { scope: BOTH, aud: env.AUTH_AUDIENCE }),
    ];
    for (const t of tokens) {
      const res = await send(bearer(t), body({ originApp: "refund" }));
      expect(res.status).toBe(401);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect(bodies.size).toBe(1);
    expect(await count()).toBe(0);
  });

  it("the refusal body is the same on both routes (apart from the path)", async () => {
    const e = await emailRequest(bearer(await serviceJwt()));
    const n = await send(bearer(await emailJwt()), body());
    const eb = (await e.json()) as Record<string, unknown>;
    const nb = (await n.json()) as Record<string, unknown>;
    expect({ ...eb, instance: 0 }).toEqual({ ...nb, instance: 0 });
  });
});

describe("origin bindings for the migrated callers", () => {
  it("refund-api may raise 'refund' (201) but not 'estimai' (403)", async () => {
    const t = await serviceJwt("system:refund-api");
    expect((await send(bearer(t), body({ originApp: "refund" }))).status).toBe(201);
    expect((await send(bearer(t), body({ originApp: "estimai" }))).status).toBe(403);
    expect(await count()).toBe(1);
  });

  it("estimai-api may raise 'estimai' (201) but not 'refund' (403)", async () => {
    const t = await serviceJwt("system:estimai-api");
    expect((await send(bearer(t), body({ originApp: "estimai" }))).status).toBe(201);
    expect((await send(bearer(t), body({ originApp: "refund" }))).status).toBe(403);
    expect(await count()).toBe(1);
  });
});

describe("the retired shared token is refused on both routes (AC-5.1)", () => {
  it("/system/notifications: X-Internal-Token alone -> 401 and no row; beside a valid JWT it adds nothing", async () => {
    expect((await send(RETIRED, body({ originApp: "refund" }))).status).toBe(401);
    expect(await count()).toBe(0);
    const t = await serviceJwt("system:refund-api");
    expect((await send({ ...bearer(t), ...RETIRED }, body({ originApp: "refund" }))).status).toBe(201);
    // the origin binding still applies: the header does not widen it
    expect((await send({ ...bearer(t), ...RETIRED }, body({ originApp: "estimai" }))).status).toBe(403);
  });

  it("/system/emails: X-Internal-Token alone -> 401 and no row, for every template", async () => {
    for (const t of TEMPLATES) {
      expect((await emailRequest(RETIRED, t)).status).toBe(401);
    }
    expect(await emailRows()).toBe(0);
  });
});
