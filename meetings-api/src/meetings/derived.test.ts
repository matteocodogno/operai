import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDIO_RETENTION_DAYS, INTERRUPTED_AFTER_MS, audioState, derivedStatus, lostMs, type LiveSession } from "./derived";

// AC-2.8 (+A1), AC-2.9 (+A2, G3), AC-4.4: time-based states are DERIVED on read,
// with an injected clock, and never written.

const T0 = new Date("2026-11-05T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  startedAt: T0,
  lastChunkAt: null,
  lastBeatAt: T0,
  paused: false,
  endedAt: null,
  ...over,
});

describe("derivedStatus (AC-2.8, A1)", () => {
  it("is 2 minutes", () => {
    expect(INTERRUPTED_AFTER_MS).toBe(120_000);
  });

  it("a recording with a beat or chunk in the last 2 minutes stays recording", () => {
    expect(derivedStatus("recording", session(), at(119_999))).toBe("recording");
    expect(derivedStatus("recording", session({ lastBeatAt: at(-500_000), lastChunkAt: at(60_000) }), at(150_000))).toBe("recording");
  });

  it("2 minutes with neither a chunk nor a beat reads interrupted", () => {
    expect(derivedStatus("recording", session(), at(120_000))).toBe("interrupted");
    expect(derivedStatus("recording", session({ lastChunkAt: at(-30_000) }), at(120_000))).toBe("interrupted");
  });

  it("the later of chunk and beat counts", () => {
    const s = session({ lastBeatAt: T0, lastChunkAt: at(100_000) });
    expect(derivedStatus("recording", s, at(200_000))).toBe("recording");
    expect(derivedStatus("recording", s, at(220_000))).toBe("interrupted");
  });

  it("a paused session that keeps beating stays recording however long the pause (A1)", () => {
    let s = session({ paused: true });
    for (let minute = 1; minute <= 30; minute++) {
      s = { ...s, lastBeatAt: at(minute * 60_000 - 30_000) };
      expect(derivedStatus("recording", s, at(minute * 60_000))).toBe("recording");
    }
  });

  it("a paused session whose beats stopped is interrupted", () => {
    expect(derivedStatus("recording", session({ paused: true }), at(10 * 60_000))).toBe("interrupted");
  });

  it("a recording with no live session has nothing arriving: interrupted", () => {
    expect(derivedStatus("recording", null, T0)).toBe("interrupted");
    expect(derivedStatus("recording", session({ endedAt: at(1000) }), at(1000))).toBe("interrupted");
  });

  it("every other stored status reads as itself, session or not", () => {
    for (const status of ["draft", "processing", "ready", "failed"] as const) {
      expect(derivedStatus(status, session(), at(60 * 60_000))).toBe(status);
      expect(derivedStatus(status, null, at(60 * 60_000))).toBe(status);
    }
  });
});

describe("lostMs (AC-2.9, G3)", () => {
  it("is capturedMs minus the stored durations", () => {
    expect(lostMs(40_000, 25_000)).toBe(15_000);
    expect(lostMs(40_000, 0)).toBe(40_000);
  });

  it("is 0 when nothing is lost, and floored at 0 when stored exceeds reported", () => {
    expect(lostMs(40_000, 40_000)).toBe(0);
    expect(lostMs(40_000, 45_000)).toBe(0);
  });

  it("is null when capturedMs was never reported", () => {
    expect(lostMs(null, 25_000)).toBeNull();
    expect(lostMs(null, 0)).toBeNull();
  });

  it("a reported 0 is 0, not null", () => {
    expect(lostMs(0, 0)).toBe(0);
  });
});

describe("audioState (AC-4.4, D-9)", () => {
  const DAY = 86_400_000;

  it("retains for 29 days", () => {
    expect(AUDIO_RETENTION_DAYS).toBe(29);
  });

  it("none when there never was audio", () => {
    expect(audioState({ audioCreatedAt: null, audioDeletedAt: null }, T0)).toEqual({ state: "none" });
  });

  it("kept until audioCreatedAt + 29 days", () => {
    const out = audioState({ audioCreatedAt: T0, audioDeletedAt: null }, at(1000));
    expect(out).toEqual({ state: "kept", until: at(29 * DAY) });
  });

  it("kept one millisecond before the boundary, deleted at it", () => {
    expect(audioState({ audioCreatedAt: T0, audioDeletedAt: null }, at(29 * DAY - 1)).state).toBe("kept");
    expect(audioState({ audioCreatedAt: T0, audioDeletedAt: null }, at(29 * DAY)).state).toBe("deleted");
    expect(audioState({ audioCreatedAt: T0, audioDeletedAt: null }, at(40 * DAY))).toEqual({ state: "deleted" });
  });

  it("deleted as soon as audioDeletedAt is set, even before the boundary", () => {
    expect(audioState({ audioCreatedAt: T0, audioDeletedAt: at(DAY) }, at(2 * DAY))).toEqual({ state: "deleted" });
  });

  it("deleted when deletion was recorded without a creation instant", () => {
    expect(audioState({ audioCreatedAt: null, audioDeletedAt: T0 }, T0)).toEqual({ state: "deleted" });
  });
});

describe("static: nothing writes a lifecycle state from the clock (AC-2.8)", () => {
  it("derived.ts neither imports the database nor writes", () => {
    const source = readFileSync(join(import.meta.dir, "derived.ts"), "utf8");
    expect(source).not.toMatch(/lib\/db|\.update\(|\.updateMany\(|\.create\(/);
  });

  it("no module under src/meetings imports derived.ts to write a status", () => {
    for (const file of readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source).not.toMatch(/status:\s*derivedStatus|status:\s*["']interrupted["']/);
    }
  });
});
