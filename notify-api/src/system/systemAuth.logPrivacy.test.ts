/**
 * QE-added (specs/016 T3 done-when): through the REAL routes, an accepted push
 * and an accepted email log exactly the caller line, and no console channel
 * ever sees the token, the recipient address, the title or the body.
 */
import { describe, it, expect, beforeAll, afterAll, mock, spyOn } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { env } from "@/lib/env";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: new URL("../../.env", import.meta.url).pathname, override: true });

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const freshDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }),
});
mock.module("@/lib/db", () => ({ db: freshDb }));
const { createSystemNotificationsRouter } = await import("./notifications.routes");
const { createSystemEmailsRouter } = await import("./emails.routes");
const { createSystemAuthMiddleware } = await import("./systemAuth.middleware");

const AUD = "operai-system-qe";
const RECIPIENT = "qe-logprivacy-recipient";
const TO = "qe-logprivacy@example.com";
const TITLE = "QE-UNIQUE-TITLE-7731";
const BODY = "QE-UNIQUE-BODY-9042";

let key: CryptoKey;
let app: Hono;
const origEmail = env.EMAIL_ENABLED;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "qe", alg: "RS256", use: "sig" }],
  });
  app = new Hono();
  app.route("/", createSystemNotificationsRouter(createSystemAuthMiddleware({ scope: "notifications.push", jwks, audience: AUD })));
  app.route("/", createSystemEmailsRouter(createSystemAuthMiddleware({ scope: "emails.send", jwks, audience: AUD })));
  env.EMAIL_ENABLED = false;
});
afterAll(async () => {
  env.EMAIL_ENABLED = origEmail;
  await freshDb.notification.deleteMany({ where: { recipientId: RECIPIENT } });
  await freshDb.emailDelivery.deleteMany({ where: { to: TO } });
});

const jwt = (scope: string) =>
  new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "qe" })
    .setIssuedAt().setIssuer(env.AUTH_ISSUER).setAudience(AUD)
    .setSubject("system:refund-api").setExpirationTime("5m").sign(key);

describe("caller log line through the real routes", () => {
  it("push and email each log exactly one caller line; no token/address/title/body anywhere", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      const push = await jwt("notifications.push");
      const mail = await jwt("emails.send");
      const r1 = await app.request("/system/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${push}` },
        body: JSON.stringify({ recipientId: RECIPIENT, originApp: "refund", severity: "info", title: TITLE, body: BODY, link: { href: "/refund" } }),
      });
      const r2 = await app.request("/system/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mail}` },
        body: JSON.stringify({ to: TO, template: "refund_decision_rejected", data: { requestUrl: "https://app.operai.welld.io/refund/requests/abc", decidedAt: "2026-09-08T10:00:00Z" } }),
      });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(200);
      const lines = spies.flatMap((s) => s.mock.calls.map((a) => a.join(" ")));
      expect(lines).toEqual([
        "[system-auth] POST /system/notifications caller=system:refund-api",
        "[system-auth] POST /system/emails caller=system:refund-api",
      ]);
      const all = lines.join("\n");
      for (const secret of [push, mail, TO, TITLE, BODY]) expect(all).not.toContain(secret);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
