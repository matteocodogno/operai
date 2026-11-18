/**
 * QE-added (specs/20261013-notify-service-credentials T3 done-when): through the REAL routes, an accepted push
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

const jwt = (scope: string, sub: string = "system:refund-api") =>
  new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "qe" })
    .setIssuedAt().setIssuer(env.AUTH_ISSUER).setAudience(AUD)
    .setSubject(sub).setExpirationTime("5m").sign(key);

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

// specs/20261117-legal-entities T79 (D9, plan J6): the author's account email is notice content, never a log value.
// Through the REAL router and middleware, a `legal_entity_change` request logs exactly the caller line whether it is
// accepted or refused, and the sentinel address (and a refused value) reaches no console channel.
describe("legal_entity_change author address — no log line carries it (AC-9.12 as amended by D9)", () => {
  const LEGAL_TO = "qe-logprivacy-legal-recipient@example.com";
  const SENTINEL = "qe-sentinel-author-5521@sentinel-logprivacy.example";
  const REFUSED = "qe-sentinel-refused-8830";
  const legalData = (over: Record<string, unknown> = {}) => ({
    entity: "welld_ch",
    action: "save",
    restoredFrom: null,
    actorEmail: SENTINEL,
    storedAt: "2026-11-17T09:12:00.000Z",
    version: 8,
    protectedChanged: ["legalName"],
    otherChanged: [],
    ...over,
  });

  afterAll(async () => {
    await freshDb.emailDelivery.deleteMany({ where: { to: LEGAL_TO } });
  });

  it("an accepted request, a refused address, a refused name and an over-long address log the caller line only", async () => {
    // The shared app has no APP_BASE_URL (the link cannot be built); this one does, with the same auth chain.
    const pair = await generateKeyPair("RS256");
    const localJwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: "qe2", alg: "RS256", use: "sig" }],
    });
    const guarded = new Hono();
    guarded.route(
      "/",
      createSystemEmailsRouter(createSystemAuthMiddleware({ scope: "emails.send", jwks: localJwks, audience: AUD }), {
        appBaseUrl: "https://operai.example.test",
      }),
    );
    const token = await new SignJWT({ scope: "emails.send" })
      .setProtectedHeader({ alg: "RS256", kid: "qe2" })
      .setIssuedAt().setIssuer(env.AUTH_ISSUER).setAudience(AUD)
      .setSubject("system:auth").setExpirationTime("5m").sign(pair.privateKey);

    const spies = (["log", "info", "warn", "error"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      const post = (data: Record<string, unknown>) =>
        guarded.request("/system/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ to: LEGAL_TO, template: "legal_entity_change", data }),
        });
      const accepted = await post(legalData());
      const badAddress = await post(legalData({ actorEmail: REFUSED }));
      const aName = await post(legalData({ actorName: REFUSED }));
      const tooLong = await post(legalData({ actorEmail: `${REFUSED}${"x".repeat(320)}@example.com` }));
      expect(accepted.status).toBe(200);
      expect([badAddress.status, aName.status, tooLong.status]).toEqual([400, 400, 400]);
      const bodies = [await accepted.text(), await badAddress.text(), await aName.text(), await tooLong.text()];

      const lines = spies.flatMap((s) => s.mock.calls.map((a) => a.join(" ")));
      expect(lines).toEqual(Array(4).fill("[system-auth] POST /system/emails caller=system:auth"));
      const all = lines.join("\n");
      for (const value of [SENTINEL, REFUSED, "sentinel-logprivacy", LEGAL_TO, token]) expect(all).not.toContain(value);
      // A refusal never echoes the refused value; an accepted answer never echoes the address either.
      for (const body of bodies) {
        expect(body).not.toContain(REFUSED);
        expect(body).not.toContain(SENTINEL);
      }
      // The stored delivery row has the recipient, the template and a status: no `data`.
      const rows = await freshDb.emailDelivery.findMany({ where: { to: LEGAL_TO } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("sentinel-logprivacy");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
