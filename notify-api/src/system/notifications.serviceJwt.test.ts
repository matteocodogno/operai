/**
 * Route-level tests for the scoped service JWT on POST /system/notifications
 * and its absence on POST /system/emails (specs/015 T6, ADR-0044).
 *
 * The auth matrix itself lives in notificationsAuth.middleware.test.ts; this
 * file proves the wiring: what is persisted, the origin binding (403), that
 * the legacy token is unrestricted, and that the email route ignores a fully
 * valid service JWT. Real Postgres (like notifications.routes.test.ts); the
 * JWKS is in-memory and injected, so no live auth service is needed.
 */

import { describe, it, expect, afterEach, beforeAll, mock } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { env } from "@/lib/env";

const LEGACY = env.NOTIFY_INTERNAL_TOKEN;
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
const { createNotificationsAuthMiddleware } = await import("./notificationsAuth.middleware");
const { systemEmailsRouter } = await import("./emails.routes");

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
      createNotificationsAuthMiddleware({ jwks, audience: SERVICE_AUD }),
    ),
  );
  app.route("/", systemEmailsRouter);
});

afterEach(async () => {
  await freshDb.notification.deleteMany({ where: { recipientId: RECIPIENT } });
  await freshDb.emailDelivery.deleteMany({ where: { to: EMAIL_TO } });
});

const serviceJwt = (sub = "system:inventory-api") =>
  new SignJWT({ scope: "notifications.push" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(SERVICE_AUD)
    .setSubject(sub)
    .setExpirationTime("5m")
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

describe("POST /system/notifications with the legacy token", () => {
  it("201 for origin 'inventory' and for 'refund' alike (unrestricted, unchanged)", async () => {
    for (const originApp of ["inventory", "refund"]) {
      const res = await send({ "X-Internal-Token": LEGACY }, body({ originApp }));
      expect(res.status).toBe(201);
    }
    expect(await count()).toBe(2);
  });
});

describe("POST /system/emails stays legacy-token only", () => {
  const emailRequest = (headers: Record<string, string>) =>
    app.request("/system/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        to: EMAIL_TO,
        template: "invitation",
        data: {
          inviteUrl: "https://auth.operai.welld.io/invite?id=inv_1&token=abc123",
          inviterName: "Admin",
          expiresAt: "2026-07-16T10:00:00Z",
        },
      }),
    });

  it("control: the same request with the legacy token is 200 (so the 401 below is about auth, not the payload)", async () => {
    const original = env.EMAIL_ENABLED;
    env.EMAIL_ENABLED = false; // never hit real Resend from a test
    try {
      expect((await emailRequest({ "X-Internal-Token": LEGACY })).status).toBe(200);
    } finally {
      env.EMAIL_ENABLED = original;
    }
  });

  it("401: a fully valid service JWT does not authorise an email send; nothing persisted", async () => {
    const res = await emailRequest({ Authorization: `Bearer ${await serviceJwt()}` });
    expect(res.status).toBe(401);
    expect(await freshDb.emailDelivery.count({ where: { to: EMAIL_TO } })).toBe(0);
  });
});
