/**
 * Integration tests for POST /system/notifications (T3,
 * specs/007-refund-service, ADR-0017).
 *
 * Strategy mirrors system/emails.routes.test.ts: real Postgres (compose,
 * host:5435, database: notify) — no DB mocking. Imports the REAL `env` (see
 * emails.routes.test.ts's file header for why `env` is never mock.module()'d
 * — it's a process-wide singleton and other files in this same bun test run
 * depend on its real fields), reading the real NOTIFY_INTERNAL_TOKEN as the
 * "valid token" for tests.
 *
 * done when (tasks.md T3): a valid token pushes a notification to an
 * arbitrary recipientId, persisted (Notification row, recipientId ==
 * body.recipientId, NOT tied to any caller identity) AND fanned out via the
 * existing inApp channel/EventBus SSE seam; missing/wrong token → 401; the
 * user-JWT POST /notifications route still rejects the internal token
 * (already covered generically by raise.routes.test.ts — jwtMiddleware never
 * reads X-Internal-Token at all, so that invariant holds for ANY /system/*
 * route without route-specific test duplication; re-asserted here too for
 * this route's own auth-boundary coverage).
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { env } from "@/lib/env";

// The real, valid internal token (worktree .env) — used as the "correct"
// credential throughout; deliberately NOT overridden so this test proves the
// actual middleware/env wiring, not a mock's approximation of it (mirrors
// emails.routes.test.ts).
const VALID_INTERNAL_TOKEN = env.NOTIFY_INTERNAL_TOKEN;

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

const { systemNotificationsRouter } = await import("./notifications.routes");
const { eventBus } = await import("@/notifications/eventBus");

const testDb = freshDb;
// The caller (a hypothetical accounting user acting through refund-api) and
// the recipient (the request owner) are DIFFERENT users — the whole point of
// this cross-user route (ADR-0017). Neither is ever derived from a JWT here;
// this route accepts no JWT at all.
const CALLER_SUB = "system-notifications-test-caller";
const RECIPIENT_ID = "system-notifications-test-recipient";
const OTHER_RECIPIENT_ID = "system-notifications-test-other-recipient";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  app.route("/", systemNotificationsRouter);
  return app;
};

const validBody = (overrides?: Record<string, unknown>) => ({
  recipientId: RECIPIENT_ID,
  originApp: "refund",
  severity: "success",
  title: "Rimborso approvato",
  body: "La tua richiesta di rimborso è stata approvata.",
  link: { href: "/refund/requests/req_123" },
  ...overrides,
});

afterEach(async () => {
  await testDb.notification.deleteMany({
    where: { recipientId: { in: [RECIPIENT_ID, OTHER_RECIPIENT_ID, CALLER_SUB] } },
  });
});

// ─── Happy path (T3 done-when) ─────────────────────────────────────────────────

describe("POST /system/notifications — valid internal token", () => {
  it("201: persists a Notification for recipientId AND publishes it on recipientId's SSE stream (cross-user, not the caller)", async () => {
    const app = buildApp();

    const recipientEvents: unknown[] = [];
    const callerEvents: unknown[] = [];
    const unsubRecipient = eventBus.subscribe(RECIPIENT_ID, (event) =>
      recipientEvents.push(event),
    );
    const unsubCaller = eventBus.subscribe(CALLER_SUB, (event) => callerEvents.push(event));

    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      title: string;
      body: string;
      severity: string;
      originApp: string;
      link?: { href: string; label?: string };
      toastWorthy: boolean;
      readAt: string | null;
      createdAt: string;
    };

    expect(created.title).toBe("Rimborso approvato");
    expect(created.body).toBe("La tua richiesta di rimborso è stata approvata.");
    expect(created.severity).toBe("success");
    expect(created.originApp).toBe("refund");
    expect(created.link).toEqual({ href: "/refund/requests/req_123" });
    expect(created.toastWorthy).toBe(false);
    expect(created.readAt).toBeNull();
    expect(created.id).toBeTruthy();

    // Persisted for the RECIPIENT, an arbitrary user distinct from any caller
    // identity — this route accepts no JWT/caller identity at all.
    const row = await testDb.notification.findUnique({ where: { id: created.id } });
    expect(row?.recipientId).toBe(RECIPIENT_ID);
    expect(row?.recipientId).not.toBe(CALLER_SUB);

    // Fanned out over the recipient's SSE stream, and NOT the (unrelated,
    // never-addressed) caller's — proves cross-user targeting, the entire
    // point of this route (ADR-0017 vs. the self-only POST /notifications).
    expect(recipientEvents).toHaveLength(1);
    expect(recipientEvents[0]).toEqual({ type: "notification", data: created });
    expect(callerEvents).toHaveLength(0);

    unsubRecipient();
    unsubCaller();
  });

  it("201: pushes to a second, different arbitrary recipientId just as well — recipientId is fully caller-controlled (trusted internal caller)", async () => {
    const app = buildApp();
    const events: unknown[] = [];
    const unsubscribe = eventBus.subscribe(OTHER_RECIPIENT_ID, (event) => events.push(event));

    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ recipientId: OTHER_RECIPIENT_ID, severity: "warning" })),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; severity: string };
    expect(created.severity).toBe("warning");

    const row = await testDb.notification.findUnique({ where: { id: created.id } });
    expect(row?.recipientId).toBe(OTHER_RECIPIENT_ID);
    expect(events).toHaveLength(1);

    unsubscribe();
  });

  it("201: severity defaults to 'info' and a missing link omits the field entirely", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientId: RECIPIENT_ID,
        originApp: "refund",
        title: "Rimborso respinto",
        body: "La tua richiesta di rimborso è stata respinta.",
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created["severity"]).toBe("info");
    expect("link" in created).toBe(false);
  });
});

// ─── Auth (ADR-0011 §Security R2, ADR-0017 §3) ─────────────────────────────────

describe("POST /system/notifications — internal-token auth (ADR-0011, ADR-0017)", () => {
  it("401: missing X-Internal-Token header, nothing persisted", async () => {
    const app = buildApp();
    const before = await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } });

    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);

    const after = await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } });
    expect(after).toBe(before);
  });

  it("401: wrong X-Internal-Token value, nothing persisted", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": "definitely-not-the-right-token-but-long-enough",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);

    const after = await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } });
    expect(after).toBe(0);
  });

  it("401: a user JWT (Authorization: Bearer …) is rejected — /system/notifications never accepts a user JWT in place of the internal token", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        Authorization: "Bearer some.made.up.jwt.value",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  it("401: a user JWT presented ALONGSIDE a wrong X-Internal-Token is still rejected (the JWT does not substitute for it)", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
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

// ─── Validation → 400 ───────────────────────────────────────────────────────────

describe("POST /system/notifications — validation failures → 400", () => {
  it("400: missing recipientId", async () => {
    const app = buildApp();
    const body = validBody();
    const { recipientId: _recipientId, ...rest } = body as Record<string, unknown>;
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(400);
  });

  it("400: empty recipientId", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ recipientId: "" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: empty title", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ title: "" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: empty body", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ body: "" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: unrecognised originApp", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ originApp: "not-a-real-app" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: unrecognised severity", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ severity: "critical" })),
    });
    expect(res.status).toBe(400);
  });

  it("400: a non-relative link.href (open-redirect guard) is rejected", async () => {
    const app = buildApp();
    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        validBody({ link: { href: "https://evil.example.com/phish" } }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it("nothing is persisted after a 400 (no partial write)", async () => {
    const app = buildApp();
    const before = await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } });

    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody({ title: "" })),
    });
    expect(res.status).toBe(400);

    const after = await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } });
    expect(after).toBe(before);
  });
});

// ─── 413: body-size cap ─────────────────────────────────────────────────────────

describe("POST /system/notifications — body-size cap → 413", () => {
  it("a raw body over the 16 KiB cap is rejected before validation", async () => {
    const app = buildApp();
    const rawBody = `{"recipientId":"${RECIPIENT_ID}","originApp":"refund","title":"x","body":"${"B".repeat(20 * 1024)}"}`;

    const res = await app.request("/system/notifications", {
      method: "POST",
      headers: {
        "X-Internal-Token": VALID_INTERNAL_TOKEN,
        "Content-Type": "application/json",
      },
      body: rawBody,
    });
    expect(res.status).toBe(413);
  });
});
