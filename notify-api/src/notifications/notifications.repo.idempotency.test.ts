/**
 * createNotificationOnce (specs/20261117-legal-entities T56, AC-9.14): the repeat-protection arbiter is the partial
 * unique index on Notification (callerSub, idempotencyKey) WHERE idempotencyKey IS NOT NULL. These tests pin what
 * the route tests cannot see deterministically: the lost-race branch (the lookup finds nothing, the insert
 * violates the index, the loser reads the winner) and the index itself. Real Postgres, same setup as
 * notifications.repo.test.ts.
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import { Effect } from "effect";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: new URL("../../.env", import.meta.url).pathname, override: true });

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const testDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }),
});

// The repo's handle on the database: the real client, with two hooks so a test can stage a lost race (Prisma builds a
// model's methods per access, so a spy on `testDb.notification.findFirst` would never be the one the repo calls).
type Args = Parameters<typeof testDb.notification.findFirst>[0];
let findFirstOnce: (() => Promise<null>) | null = null;
let createOnce: (() => Promise<never>) | null = null;
const take = <T,>(hook: T | null, clear: () => void): T | null => {
  clear();
  return hook;
};
const stagedDb = {
  notification: {
    findFirst: (args: Args) => {
      const hook = take(findFirstOnce, () => (findFirstOnce = null));
      return hook ? hook() : testDb.notification.findFirst(args);
    },
    create: (args: Parameters<typeof testDb.notification.create>[0]) => {
      const hook = take(createOnce, () => (createOnce = null));
      return hook ? hook() : testDb.notification.create(args);
    },
  },
};
mock.module("@/lib/db", () => ({ db: stagedDb }));

const { createNotificationOnce, isUniqueViolation } = await import("./notifications.repo");

const RECIPIENT_ID = "repo-idempotency-test-recipient";
const input = (title = "T") => ({
  recipientId: RECIPIENT_ID,
  title,
  body: "B",
  severity: "info",
  originApp: "admin",
  toastWorthy: false,
});
const scope = (callerSub = "system:auth", idempotencyKey = "k-1") => ({ callerSub, idempotencyKey });

afterEach(async () => {
  findFirstOnce = null;
  createOnce = null;
  await testDb.notification.deleteMany({ where: { recipientId: RECIPIENT_ID } });
});

describe("createNotificationOnce", () => {
  it("creates, then answers the stored row", async () => {
    const first = await Effect.runPromise(createNotificationOnce(input("first"), scope()));
    expect(first.created).toBe(true);
    const second = await Effect.runPromise(createNotificationOnce(input("second"), scope()));
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(second.notification.title).toBe("first");
    expect(await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } })).toBe(1);
  });

  it("the loser of a race (lookup empty, insert violates the unique index) reads the winner instead of failing", async () => {
    const winner = await Effect.runPromise(createNotificationOnce(input("winner"), scope()));

    // The loser's first lookup finds nothing — as if the winner had not committed yet — and its insert then meets the index.
    findFirstOnce = () => Promise.resolve(null);
    const loser = await Effect.runPromise(createNotificationOnce(input("loser"), scope()));
    expect(findFirstOnce).toBeNull(); // the staged lookup really was the one used
    expect(loser.created).toBe(false);
    expect(loser.notification.id).toBe(winner.notification.id);
    expect(loser.notification.title).toBe("winner");
    expect(await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } })).toBe(1);
  });

  it("the database refuses a second row for one (callerSub, key) and lets other pairs and key-less rows through", async () => {
    const row = (callerSub: string | null, idempotencyKey: string | null) =>
      testDb.notification.create({
        data: { recipientId: RECIPIENT_ID, title: "T", body: "B", severity: "info", originApp: "admin", callerSub, idempotencyKey },
      });
    await row("system:auth", "k-1");
    const duplicate = await row("system:auth", "k-1").catch((e: unknown) => e);
    expect(isUniqueViolation(duplicate)).toBe(true);
    await row("system:crm-api", "k-1");
    await row("system:auth", "k-2");
    await row(null, null);
    await row(null, null);
    expect(await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } })).toBe(5);
  });

  it("the database refuses a key without its caller (CHECK)", async () => {
    const bad = await testDb.notification
      .create({
        data: { recipientId: RECIPIENT_ID, title: "T", body: "B", severity: "info", originApp: "admin", idempotencyKey: "k-1" },
      })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } })).toBe(0);
  });

  it("another failure is not mistaken for a lost race", async () => {
    createOnce = () => Promise.reject(new Error("connection lost"));
    await expect(Effect.runPromise(createNotificationOnce(input(), scope()))).rejects.toThrow();
    expect(createOnce).toBeNull();
    expect(await testDb.notification.count({ where: { recipientId: RECIPIENT_ID } })).toBe(0);
  });
});
