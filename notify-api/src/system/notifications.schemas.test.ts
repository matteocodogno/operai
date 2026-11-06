/**
 * Contract tests for the optional Italian variant on POST /system/notifications
 * (T5, specs/021-meetings, ADR-0065): same limits as the English fields,
 * all-or-nothing, never blank.
 */

import { describe, it, expect } from "bun:test";
import { SystemNotificationRequestSchema } from "./notifications.schemas";
import { NotificationSchema, ORIGIN_APPS } from "@/notifications/notifications.schemas";

const base = {
  recipientId: "u1",
  originApp: "meetings",
  title: "Transcript ready",
  body: "Your meeting was transcribed with AI.",
};

describe("SystemNotificationRequestSchema — it", () => {
  it("accepts a request without it (existing callers)", () => {
    const parsed = SystemNotificationRequestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.it).toBeUndefined();
  });

  it("accepts it at the limits: title 200, body 2000", () => {
    const parsed = SystemNotificationRequestSchema.safeParse({
      ...base,
      it: { title: "t".repeat(200), body: "b".repeat(2000) },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects it.title over 200 and it.body over 2000", () => {
    expect(
      SystemNotificationRequestSchema.safeParse({ ...base, it: { title: "t".repeat(201), body: "b" } }).success,
    ).toBe(false);
    expect(
      SystemNotificationRequestSchema.safeParse({ ...base, it: { title: "t", body: "b".repeat(2001) } }).success,
    ).toBe(false);
  });

  it("rejects an empty or half-filled it (a blank variant must never reach a reader)", () => {
    for (const bad of [
      {},
      { title: "t" },
      { body: "b" },
      { title: "", body: "b" },
      { title: "t", body: "" },
    ]) {
      expect(SystemNotificationRequestSchema.safeParse({ ...base, it: bad }).success).toBe(false);
    }
  });

  it("rejects it: null (omit the field instead)", () => {
    expect(SystemNotificationRequestSchema.safeParse({ ...base, it: null }).success).toBe(false);
  });
});

describe("origin apps and the notification shape", () => {
  it("meetings is a known origin app", () => {
    expect(ORIGIN_APPS).toContain("meetings");
  });

  it("NotificationSchema carries it: { title, body } | null", () => {
    const dto = {
      id: "n1",
      title: "T",
      body: "B",
      severity: "info",
      originApp: "meetings",
      toastWorthy: false,
      readAt: null,
      createdAt: "2026-11-05T10:00:00.000Z",
    };
    expect(NotificationSchema.safeParse({ ...dto, it: null }).success).toBe(true);
    expect(NotificationSchema.safeParse({ ...dto, it: { title: "t", body: "b" } }).success).toBe(true);
    expect(NotificationSchema.safeParse({ ...dto, it: { title: "t" } }).success).toBe(false);
  });
});
