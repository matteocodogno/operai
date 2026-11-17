/**
 * POST /system/notifications — repeat protection (specs/20261117-legal-entities T56, AC-9.13, AC-9.14, plan
 * "Amendment 2026-11-17 after security review" G1.3, G5).
 *
 * done when (tasks.md T56, the in-app half): a repeated call (same `sub`, same key) -> 200 with the stored row, no
 * second SSE event, no push dispatch, no email; another `sub` with the same key -> a new row; two concurrent calls
 * -> one row. Real Postgres (the same setup as notifications.routes.test.ts); the service credential is an
 * in-memory JWT; the push channel and the email channel are spies/stubs — nothing leaves the process.
 */

import { describe, it, expect, afterEach, mock, spyOn } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { env } from "@/lib/env";
import { createSystemAuthMiddleware } from "./systemAuth.middleware";

const SERVICE_AUD = "operai-system-notifications-idempotency-test";
const KID = "notifications-idempotency-kid";
const keyPair = await generateKeyPair("RS256");
const localJwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
});
const token = (scope: string, sub: string) =>
  new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(SERVICE_AUD)
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: new URL("../../.env", import.meta.url).pathname, override: true });

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const testDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }),
});
mock.module("@/lib/db", () => ({ db: testDb }));

const { createSystemNotificationsRouter } = await import("./notifications.routes");
const { eventBus } = await import("@/notifications/eventBus");
const { pushChannel } = await import("@/channels/push.channel");

const RECIPIENT_ID = "idempotency-test-recipient";
const SUB_A = "system:crm-api";
const SUB_B = "system:activities-api"; // also bound to `crm`
const KEY = "legal-entity-notice:row_1";

let emailsSent = 0;
const app = new Hono();
app.route(
  "/",
  createSystemNotificationsRouter(
    createSystemAuthMiddleware({ scope: "notifications.push", jwks: localJwks, audience: SERVICE_AUD }),
    {
      contacts: { lookup: async () => ({ status: "found", email: "someone@example.test", name: "N" }) },
      appBaseUrl: "https://operai.example.test",
      channel: {
        send: async () => {
          emailsSent += 1;
          return { deliveryId: "d1", status: "sent" };
        },
      },
    },
  ),
);

const post = async (body: Record<string, unknown>, sub = SUB_A, scope = "notifications.push") =>
  app.request("/system/notifications", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token(scope, sub)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const validBody = (overrides: Record<string, unknown> = {}) => ({
  recipientId: RECIPIENT_ID,
  originApp: "crm",
  severity: "info",
  title: "Estimate requested",
  body: "Acme asked for an estimate.",
  idempotencyKey: KEY,
  ...overrides,
});

const rows = () => testDb.notification.findMany({ where: { recipientId: RECIPIENT_ID } });

afterEach(async () => {
  emailsSent = 0;
  await testDb.notification.deleteMany({ where: { recipientId: RECIPIENT_ID } });
});

describe("a repeat with the same calling sub and key", () => {
  it("first call 201; the repeat 200 with the stored row — no second SSE event, no push dispatch, no email", async () => {
    const events: unknown[] = [];
    const unsubscribe = eventBus.subscribe(RECIPIENT_ID, (event) => events.push(event));
    const dispatch = spyOn(pushChannel, "dispatch").mockImplementation(async () => {});
    try {
      const first = await post(validBody({ email: true }), SUB_A, "notifications.push emails.send");
      expect(first.status).toBe(201);
      const created = (await first.json()) as { id: string; emailStatus?: string };
      expect(created.emailStatus).toBe("sent");
      expect(emailsSent).toBe(1);
      expect(events).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledTimes(1);

      const repeat = await post(validBody({ email: true }), SUB_A, "notifications.push emails.send");
      expect(repeat.status).toBe(200);
      const again = (await repeat.json()) as Record<string, unknown>;
      expect(again["id"]).toBe(created.id);
      expect(again["title"]).toBe("Estimate requested");
      expect("emailStatus" in again).toBe(false);

      expect(await rows()).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(emailsSent).toBe(1);
    } finally {
      unsubscribe();
      dispatch.mockRestore();
    }
  });

  it("the stored row records the caller and the key; neither is returned", async () => {
    const res = await post(validBody());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("callerSub");
    expect(Object.keys(body)).not.toContain("idempotencyKey");
    const [row] = await rows();
    expect(row?.callerSub).toBe(SUB_A);
    expect(row?.idempotencyKey).toBe(KEY);
  });

  it("the repeat is answered from the stored row even when its content differs (the first result stands)", async () => {
    const first = (await (await post(validBody())).json()) as { id: string };
    const repeat = await post(validBody({ title: "Something else", body: "Other text." }));
    expect(repeat.status).toBe(200);
    const body = (await repeat.json()) as { id: string; title: string };
    expect(body.id).toBe(first.id);
    expect(body.title).toBe("Estimate requested");
    expect(await rows()).toHaveLength(1);
  });

  it("a repeat reports the notification's current state (read or not), not the state at the first call", async () => {
    const first = (await (await post(validBody())).json()) as { id: string; readAt: string | null };
    expect(first.readAt).toBeNull();
    await testDb.notification.update({ where: { id: first.id }, data: { readAt: new Date() } });
    const repeat = (await (await post(validBody())).json()) as { readAt: string | null };
    expect(repeat.readAt).not.toBeNull();
  });

  it("another key is another notification", async () => {
    expect((await post(validBody({ idempotencyKey: "k-1" }))).status).toBe(201);
    expect((await post(validBody({ idempotencyKey: "k-2" }))).status).toBe(201);
    expect(await rows()).toHaveLength(2);
  });

  it("without a key every call stores a row, as before", async () => {
    expect((await post(validBody({ idempotencyKey: undefined }))).status).toBe(201);
    expect((await post(validBody({ idempotencyKey: undefined }))).status).toBe(201);
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.callerSub === null && r.idempotencyKey === null)).toBe(true);
  });

  it("is still held to the origin and scope checks (a repeat cannot get past a 403)", async () => {
    expect((await post(validBody())).status).toBe(201);
    // email: true now needs emails.send, which this token lacks: 403 even though the key was already used.
    const noScope = await post(validBody({ email: true }));
    expect(noScope.status).toBe(403);
    // another origin the caller is not bound to
    const wrongOrigin = await post(validBody({ originApp: "refund" }));
    expect(wrongOrigin.status).toBe(403);
    expect(await rows()).toHaveLength(1);
  });
});

describe("the key is scoped to the calling service", () => {
  it("another sub with the same key gets a new row of its own (and its own SSE event)", async () => {
    const events: unknown[] = [];
    const unsubscribe = eventBus.subscribe(RECIPIENT_ID, (event) => events.push(event));
    try {
      const a = (await (await post(validBody(), SUB_A)).json()) as { id: string };
      const bRes = await post(validBody(), SUB_B);
      expect(bRes.status).toBe(201);
      const b = (await bRes.json()) as { id: string };
      expect(b.id).not.toBe(a.id);
      expect(await rows()).toHaveLength(2);
      expect(events).toHaveLength(2);

      // and each caller's repeat finds its own
      const aAgain = (await (await post(validBody(), SUB_A)).json()) as { id: string };
      const bAgain = (await (await post(validBody(), SUB_B)).json()) as { id: string };
      expect(aAgain.id).toBe(a.id);
      expect(bAgain.id).toBe(b.id);
    } finally {
      unsubscribe();
    }
  });
});

describe("concurrent calls with the same sub and key", () => {
  it("store one row, publish one event, push once; one answers 201 and the rest 200 with that row", async () => {
    const events: unknown[] = [];
    const unsubscribe = eventBus.subscribe(RECIPIENT_ID, (event) => events.push(event));
    const dispatch = spyOn(pushChannel, "dispatch").mockImplementation(async () => {});
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => post(validBody())));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);

      const stored = await rows();
      expect(stored).toHaveLength(1);
      const ids = await Promise.all(results.map(async (r) => ((await r.json()) as { id: string }).id));
      expect(new Set(ids)).toEqual(new Set([stored[0]!.id]));
      expect(events).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      dispatch.mockRestore();
    }
  });
});

describe("the key's shape (400, nothing stored)", () => {
  it.each([
    ["empty", ""],
    ["201 characters", "k".repeat(201)],
    ["a space", "legal entity"],
    ["a slash", "legal/entity"],
    ["a non-string", 12],
  ])("%s", async (_name, key) => {
    const res = await post(validBody({ idempotencyKey: key }));
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("200 characters of the allowed set are accepted", async () => {
    const res = await post(validBody({ idempotencyKey: `a.B_c:1-${"x".repeat(192)}` }));
    expect(res.status).toBe(201);
  });
});
