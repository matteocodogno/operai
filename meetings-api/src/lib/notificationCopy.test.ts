import { describe, expect, it } from "bun:test";
import {
  MAX_BODY,
  MAX_TITLE,
  NOTIFICATION_KINDS,
  catalog,
  renderNotification,
  type NotificationKind,
} from "./notificationCopy";

// AC-12.5: every notification exists in English and Italian. AC-12.1/12.2: the
// text carries the title and the outcome, and the participant notice says AI.

describe("catalog parity", () => {
  it("has the same kinds in both languages, and every kind is in the exported list", () => {
    expect(Object.keys(catalog.en).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    expect(Object.keys(catalog.it).sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  it("has non-empty title and body in both languages for every kind", () => {
    for (const lang of ["en", "it"] as const) {
      for (const kind of NOTIFICATION_KINDS) {
        const copy = catalog[lang][kind];
        expect(copy.title("Budget review").trim().length).toBeGreaterThan(0);
        expect(copy.body("Budget review").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("Italian is actually Italian: no kind reuses the English text", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(catalog.it[kind].title("X")).not.toBe(catalog.en[kind].title("X"));
      expect(catalog.it[kind].body("X")).not.toBe(catalog.en[kind].body("X"));
    }
  });
});

describe("renderNotification", () => {
  it("returns English as the default text and Italian as the variant", () => {
    const n = renderNotification("transcription_done", "Budget review");
    expect(n.title).toContain("Budget review");
    expect(n.it.title).toContain("Budget review");
    expect(n.title).not.toBe(n.it.title);
    expect(n.severity).toBe("success");
  });

  it("carries the meeting title and the outcome for each kind (AC-12.2)", () => {
    const outcome: Record<NotificationKind, "success" | "warning" | "info"> = {
      participant_added: "info",
      transcription_done: "success",
      transcription_failed: "warning",
      upload_refused: "warning",
      summary_done: "success",
      summary_failed: "warning",
    };
    for (const kind of NOTIFICATION_KINDS) {
      const n = renderNotification(kind, "Acme renewal");
      expect(n.title).toContain("Acme renewal");
      expect(n.it.title).toContain("Acme renewal");
      expect(n.severity).toBe(outcome[kind]);
    }
  });

  it("the participant notice states that the meeting was recorded or transcribed with AI (AC-12.1), in both languages", () => {
    const n = renderNotification("participant_added", "Acme renewal");
    expect(n.body).toMatch(/AI/);
    expect(n.it.body).toMatch(/IA/);
  });

  it("keeps title and body inside notify-api's limits however long the meeting title is", () => {
    expect(MAX_TITLE).toBe(200);
    expect(MAX_BODY).toBe(2000);
    for (const kind of NOTIFICATION_KINDS) {
      const n = renderNotification(kind, "T".repeat(5000));
      expect(n.title.length).toBeLessThanOrEqual(MAX_TITLE);
      expect(n.it.title.length).toBeLessThanOrEqual(MAX_TITLE);
      expect(n.body.length).toBeLessThanOrEqual(MAX_BODY);
      expect(n.it.body.length).toBeLessThanOrEqual(MAX_BODY);
    }
  });

  it("never puts transcript, summary or answer text anywhere: only the title it was given", () => {
    const n = renderNotification("summary_done", "CANARY-TITLE");
    const everything = JSON.stringify(n);
    expect(everything.replaceAll("CANARY-TITLE", "")).not.toMatch(/CANARY/);
  });
});
