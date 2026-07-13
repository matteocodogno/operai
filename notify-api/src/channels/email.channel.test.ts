/**
 * Unit tests for the email channel (T2, specs/006-user-invitations, ADR-0011).
 *
 * done when (tasks.md T2): "unit: email channel records delivery; inApp
 * unchanged". The inApp half is proven by raise.routes.test.ts continuing to
 * pass unmodified after the T2 refactor (src/channels/inApp.channel.ts).
 *
 * Strategy: real Postgres (compose, host:5435, database: notify), same as
 * raise.routes.test.ts — no DB mocking. `@/lib/resend` is module-mocked so
 * each test can control the simulated Resend outcome without touching real
 * credentials or the network.
 *
 * NOTE: deliberately does NOT `mock.module("@/lib/env", …)`. `env` is a
 * process-wide singleton (bun test runs every file in one process, and
 * mock.module replaces a specifier for the rest of that process — see
 * stream.routes.test.ts, which reads env.MAX_STREAM_DURATION and would break
 * if some other file's mock permanently replaced the whole module). Instead
 * this file imports the REAL `env` and mutates only `EMAIL_ENABLED` on the
 * shared object (email.channel.ts re-reads it at call time, not import time),
 * restoring it to its `.env` default in `afterEach` so no other test file
 * observes a changed value.
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import { env } from "@/lib/env";

const ORIGINAL_EMAIL_ENABLED = env.EMAIL_ENABLED;

// ─── @/lib/resend mock — controlled per test via sendEmailImpl ───────────────

type SendEmailResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

let sendEmailCalled = false;
let sendEmailImpl: (input: {
  to: string;
  subject: string;
  html: string;
}) => Promise<SendEmailResult> = async () => ({
  ok: true,
  providerId: "unused",
});

mock.module("@/lib/resend", () => ({
  sendEmail: (input: { to: string; subject: string; html: string }) => {
    sendEmailCalled = true;
    return sendEmailImpl(input);
  },
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

const { emailChannel } = await import("./email.channel");

const testDb = freshDb;
const TEST_ADDRESS_PREFIX = "email-channel-test";

afterEach(async () => {
  sendEmailCalled = false;
  env.EMAIL_ENABLED = ORIGINAL_EMAIL_ENABLED;
  await testDb.emailDelivery.deleteMany({
    where: { to: { contains: TEST_ADDRESS_PREFIX } },
  });
});

// ─── EMAIL_ENABLED=false — stubbed send (T2 done-when) ───────────────────────

describe("emailChannel — EMAIL_ENABLED=false (stub)", () => {
  it("records EmailDelivery status=sent with a synthetic (stub_) providerId, and never calls sendEmail", async () => {
    env.EMAIL_ENABLED = false;

    const result = await emailChannel.send({
      to: `${TEST_ADDRESS_PREFIX}-a@example.com`,
      template: "invitation",
      subject: "You're invited",
      html: "<p>hi</p>",
    });

    expect(result.status).toBe("sent");
    expect(sendEmailCalled).toBe(false);

    const row = await testDb.emailDelivery.findUnique({
      where: { id: result.deliveryId },
    });
    expect(row).not.toBeNull();
    expect(row?.to).toBe(`${TEST_ADDRESS_PREFIX}-a@example.com`);
    expect(row?.template).toBe("invitation");
    expect(row?.status).toBe("sent");
    expect(row?.providerId).toMatch(/^stub_/);
    expect(row?.error).toBeNull();
  });
});

// ─── EMAIL_ENABLED=true — real send path (mocked Resend) ────────────────────

describe("emailChannel — EMAIL_ENABLED=true (mocked Resend)", () => {
  it("success: records EmailDelivery status=sent with Resend's own providerId", async () => {
    env.EMAIL_ENABLED = true;
    sendEmailImpl = async () => ({ ok: true, providerId: "resend-msg-123" });

    const result = await emailChannel.send({
      to: `${TEST_ADDRESS_PREFIX}-b@example.com`,
      template: "invitation_resend",
      subject: "New link",
      html: "<p>hi again</p>",
    });

    expect(result.status).toBe("sent");
    expect(sendEmailCalled).toBe(true);

    const row = await testDb.emailDelivery.findUnique({
      where: { id: result.deliveryId },
    });
    expect(row?.providerId).toBe("resend-msg-123");
    expect(row?.template).toBe("invitation_resend");
    expect(row?.status).toBe("sent");
  });

  it("failure: a Resend/network failure records EmailDelivery status=failed and returns {status:'failed'} — never throws", async () => {
    env.EMAIL_ENABLED = true;
    sendEmailImpl = async () => ({ ok: false, error: "network timeout" });

    const result = await emailChannel.send({
      to: `${TEST_ADDRESS_PREFIX}-c@example.com`,
      template: "invitation",
      subject: "You're invited",
      html: "<p>hi</p>",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("network timeout");
    }

    const row = await testDb.emailDelivery.findUnique({
      where: { id: result.deliveryId },
    });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("network timeout");
    expect(row?.providerId).toBeNull();
  });
});
