import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../lib/db";
import { handleProblemError } from "../lib/problem";
import { AI_REQUESTS_PER_HOUR, AiRateLimitedError, consumeAiRequest, consumeAiRequestIn } from "./rateLimit";

// AC-13.4 / AC-9.8: 30 AI requests per user per rolling hour, refused with the time to retry.
// Needs a migrated `meetings_test` database.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "ai_request", "meeting" CASCADE');
});
afterAll(async () => {
  await db.$disconnect();
});

/** A clock the test moves. */
function clock(start = T0) {
  const c = { t: start, now: () => new Date(c.t), advance: (ms: number) => void (c.t += ms) };
  return c;
}

const rows = (userId: string) => db.aiRequest.findMany({ where: { userId }, orderBy: { at: "asc" } });

describe("the limit", () => {
  it("allows 30 in an hour and refuses the 31st", async () => {
    const c = clock();
    for (let i = 0; i < AI_REQUESTS_PER_HOUR; i++) {
      expect(await consumeAiRequest(db, "u1", "summary", { now: c.now }), `request ${i + 1}`).toEqual({ allowed: true });
      c.advance(1_000);
    }
    const refused = await consumeAiRequest(db, "u1", "question", { now: c.now });
    expect(refused.allowed).toBe(false);
    expect(await db.aiRequest.count({ where: { userId: "u1" } })).toBe(30); // a refusal records nothing
  });

  it("tells the caller exactly when the oldest request leaves the window", async () => {
    const c = clock();
    for (let i = 0; i < 30; i++) {
      await consumeAiRequest(db, "u1", "summary", { now: c.now });
      c.advance(10_000); // the oldest is at T0, the newest at T0 + 290 s
    }
    // now = T0 + 300 s; the oldest leaves at T0 + 3600 s -> 3300 s from now
    expect(await consumeAiRequest(db, "u1", "summary", { now: c.now })).toEqual({ allowed: false, retryAfterSeconds: 3_300 });

    // 0.5 s later the answer rounds UP: 3299.5 s -> 3300 s, never a second too early
    c.advance(500);
    expect(await consumeAiRequest(db, "u1", "summary", { now: c.now })).toEqual({ allowed: false, retryAfterSeconds: 3_300 });

    // and following that advice works: at exactly the stated time the call is allowed
    c.t = T0 + HOUR;
    expect((await consumeAiRequest(db, "u1", "summary", { now: c.now })).allowed).toBe(true);
  });

  it("is a rolling window, not a fixed hour: one slot frees as each old request ages out", async () => {
    const c = clock();
    for (let i = 0; i < 30; i++) {
      await consumeAiRequest(db, "u1", "summary", { now: c.now });
      c.advance(60_000); // one a minute: T0 .. T0 + 29 min
    }
    c.t = T0 + HOUR - 1; // 1 ms before the first expires
    expect((await consumeAiRequest(db, "u1", "summary", { now: c.now })).allowed).toBe(false);
    c.t = T0 + HOUR; // the first is exactly an hour old: out of the window
    expect((await consumeAiRequest(db, "u1", "summary", { now: c.now })).allowed).toBe(true);
    expect((await consumeAiRequest(db, "u1", "summary", { now: c.now })).allowed).toBe(false); // only one slot opened
  });

  it("counts per user and per kind of request together", async () => {
    const c = clock();
    for (let i = 0; i < 15; i++) await consumeAiRequest(db, "u1", "summary", { now: c.now });
    for (let i = 0; i < 15; i++) await consumeAiRequest(db, "u1", "question", { now: c.now });
    expect((await consumeAiRequest(db, "u1", "summary", { now: c.now })).allowed).toBe(false);
    expect((await consumeAiRequest(db, "u2", "summary", { now: c.now })).allowed).toBe(true);
  });

  it("honours a different limit when one is given", async () => {
    const c = clock();
    const options = { now: c.now, limit: 2 };
    expect((await consumeAiRequest(db, "u1", "summary", options)).allowed).toBe(true);
    expect((await consumeAiRequest(db, "u1", "summary", options)).allowed).toBe(true);
    expect((await consumeAiRequest(db, "u1", "summary", options)).allowed).toBe(false);
  });
});

describe("concurrency", () => {
  it("never lets concurrent calls exceed 30, for one user, across 45 racing callers", async () => {
    const results = await Promise.all(Array.from({ length: 45 }, () => consumeAiRequest(db, "racer", "summary")));
    expect(results.filter((r) => r.allowed)).toHaveLength(30);
    expect(results.filter((r) => !r.allowed)).toHaveLength(15);
    expect(await db.aiRequest.count({ where: { userId: "racer" } })).toBe(30);
  });

  it("does not make one user wait for another's lock", async () => {
    const results = await Promise.all([
      ...Array.from({ length: 35 }, () => consumeAiRequest(db, "a", "summary")),
      ...Array.from({ length: 5 }, () => consumeAiRequest(db, "b", "summary")),
    ]);
    expect(results.slice(35).every((r) => r.allowed)).toBe(true);
    expect(await db.aiRequest.count({ where: { userId: "a" } })).toBe(30);
  });

  it("takes part in the caller's transaction: a rollback gives the slot back", async () => {
    const c = clock();
    await db
      .$transaction(async (tx) => {
        expect((await consumeAiRequestIn(tx, "u1", "summary", { now: c.now })).allowed).toBe(true);
        throw new Error("the summary row could not be created");
      })
      .catch(() => {});
    expect(await db.aiRequest.count({ where: { userId: "u1" } })).toBe(0);
  });
});

describe("what is stored", () => {
  it("is a content-free row: user, kind and time", async () => {
    const c = clock();
    await consumeAiRequest(db, "u1", "answer_retry", { now: c.now });
    const [row] = await rows("u1");
    expect(Object.keys(row!).sort()).toEqual(["at", "id", "kind", "userId"]);
    expect(row).toMatchObject({ userId: "u1", kind: "answer_retry" });
    expect(row!.at.getTime()).toBe(T0);
  });

  it("deleting content does not refund a request", async () => {
    const c = clock();
    const meeting = await db.meeting.create({
      data: { title: "t", format: "online", startsAt: new Date(T0), language: "en", source: "text", creatorUserId: "u1" },
    });
    for (let i = 0; i < 30; i++) await consumeAiRequest(db, "u1", "summary", { now: c.now });
    await db.meeting.delete({ where: { id: meeting.id } }); // cascades its summaries and turns
    expect(await db.aiRequest.count({ where: { userId: "u1" } })).toBe(30);
    expect((await consumeAiRequest(db, "u1", "summary", { now: c.now })).allowed).toBe(false);
  });

  it("prunes only that user's rows older than an hour, in the same call", async () => {
    const c = clock();
    await db.aiRequest.createMany({
      data: [
        { userId: "u1", kind: "summary", at: new Date(T0 - 2 * HOUR) },
        { userId: "u1", kind: "summary", at: new Date(T0 - HOUR) }, // exactly an hour old: out of the window
        { userId: "u1", kind: "summary", at: new Date(T0 - HOUR + 1) }, // 1 ms inside
        { userId: "u2", kind: "summary", at: new Date(T0 - 2 * HOUR) }, // someone else's old row stays
      ],
    });
    await consumeAiRequest(db, "u1", "summary", { now: c.now });
    expect((await rows("u1")).map((r) => r.at.getTime())).toEqual([T0 - HOUR + 1, T0]);
    expect(await db.aiRequest.count({ where: { userId: "u2" } })).toBe(1);
  });

  it("still prunes old rows on a call it refuses, and adds nothing", async () => {
    const c = clock();
    await db.aiRequest.createMany({
      data: [
        { userId: "u1", kind: "summary", at: new Date(T0 - 5 * HOUR) },
        ...Array.from({ length: 30 }, (_, i) => ({ userId: "u1", kind: "summary", at: new Date(T0 - 1_000 * (i + 1)) })),
      ],
    });
    expect((await consumeAiRequest(db, "u1", "summary", { now: c.now })).allowed).toBe(false);
    expect(await db.aiRequest.count({ where: { userId: "u1" } })).toBe(30);
  });
});

describe("the refusal as an answer", () => {
  it("is a 429 ai_rate_limited with Retry-After and the same figure in the body", async () => {
    const error = new AiRateLimitedError(754);
    const response = handleProblemError(error, "/meetings/m1/summaries")!;
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("754");
    expect(await response.json()).toMatchObject({ status: 429, code: "ai_rate_limited", retryAfterSeconds: 754, instance: "/meetings/m1/summaries" });
  });

  it("never asks for less than one second", () => {
    expect(new AiRateLimitedError(0).retryAfterSeconds).toBe(1);
    expect(new AiRateLimitedError(-5).retryAfterSeconds).toBe(1);
  });
});
