import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { db } from "../../lib/db";
import { HOURS_NOTICE_MAX_ATTEMPTS } from "../../hours/delivery";
import { setHoursChannelForTests } from "../../hours/client";
import { startFakeHours, type FakeHours } from "../../test-support/fakeHours";
import { createRunner, enqueueJob, type Runner } from "../runner";
import { deliverHoursNotice } from "./deliverHoursNotice";

// The hours outbox's delivery job (specs/20261112-meeting-hours T8; AC-1.1, AC-3.4, AC-4.1, AC-4.2; plan § Delivering a
// notice): the REAL runner with a manual `tick()` and a clock the test moves, the real database (`meetings_test`) and a
// fake hours-api on an ephemeral port that parses every body with the shared wire schema.

let fake: FakeHours;
let runner: Runner;
let logged: string[];
let spies: ReturnType<typeof spyOn>[];

/** A clock the test moves (as in runner.test.ts). */
const c = { t: 0, now: () => new Date(c.t), advance: (ms: number) => void (c.t += ms) };

const staticTokens = {
  async getToken() {
    return "service-token";
  },
  invalidate() {},
};

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "meeting_job", "meeting", "hours_notice" CASCADE');
  fake = startFakeHours();
  setHoursChannelForTests({ baseUrl: fake.url, tokens: staticTokens });
  c.t = Date.now() + 1_000;
  runner = createRunner({ db, handlers: { deliver_hours_notice: deliverHoursNotice }, listenUrl: null, idlePollMs: 3_600_000, now: c.now });
  logged = [];
  const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  spies = [spyOn(console, "log").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture), spyOn(console, "error").mockImplementation(capture)];
});
afterEach(async () => {
  await runner.stop(1_000);
  spies.forEach((s) => s.mockRestore());
  setHoursChannelForTests(undefined);
  await fake.stop();
});
afterAll(async () => {
  await db.$disconnect();
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

/** A meeting that was recorded (30 min on 24 Nov 2026 by default), with these participants (a name = an external one). */
async function seedMeeting(over: Record<string, unknown> = {}, participants: string[] = []) {
  const meeting = await db.meeting.create({
    data: {
      title: "Budget review",
      format: "online",
      startsAt: new Date("2026-11-24T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      creatorUserId: "creator-1",
      durationMs: 1_800_000,
      hoursSeq: 1,
      ...over,
    } as never,
  });
  for (const who of participants) {
    await db.meetingParticipant.create({
      data: { meetingId: meeting.id, addedBy: "creator-1", ...(who.startsWith("ext:") ? { externalName: who.slice(4) } : { userId: who }) },
    });
  }
  return meeting;
}

/** What T9's `recordHoursNotice` writes: the notice row and its until-delivered job, in one transaction. */
async function announce(meetingId: string, seq: number, kind: "state" | "deleted" = "state") {
  return db.$transaction(async (tx) => {
    const notice = await tx.hoursNotice.create({ data: { meetingId, seq, kind } });
    const jobId = await enqueueJob(tx, { kind: "deliver_hours_notice", noticeId: notice.id, maxAttempts: HOURS_NOTICE_MAX_ATTEMPTS });
    return { notice, jobId };
  });
}

const job = (id: string) => db.meetingJob.findUniqueOrThrow({ where: { id } });
const row = (id: string) => db.hoursNotice.findUnique({ where: { id } });
const settled = (id: string) => async () => (await job(id)).state !== "running" && (await job(id)).state !== "queued";

describe("the body is built at send time (AC-1.1, plan § Delivering a notice step 2)", () => {
  it("sends the facts of the meeting NOW with the CURRENT version, the Operai participants only, and nothing else", async () => {
    // The notice was recorded at version 1; the meeting has changed twice since (version 3) and says what it says now.
    const m = await seedMeeting({ title: "Secret board strategy", hoursSeq: 3, durationMs: 5_400_000 }, ["user-b", "ext:External Eve", "user-c"]);
    const { notice, jobId } = await announce(m.id, 1);

    await runner.tick();
    await until(settled(jobId));

    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.body).toEqual({
      noticeId: notice.id,
      meeting: {
        id: m.id,
        seq: 3,
        facts: { startsAt: "2026-11-24T09:00:00.000Z", durationMs: 5_400_000, creatorId: "creator-1", participantIds: ["user-b", "user-c"] },
      },
    });
    // The fake parsed it with the shared wire schema (the file hours-api parses with).
    expect(fake.received[0]!.notice).not.toBeNull();
    // No title and no external participant ever rides along (AC-4.1).
    const sent = JSON.stringify(fake.received[0]!.body);
    for (const forbidden of ["Secret board strategy", "External Eve", "Budget review"]) expect(sent).not.toContain(forbidden);
  });

  it("lists the creator among the participants when the meeting does (hours-api counts them once)", async () => {
    const m = await seedMeeting({}, ["creator-1", "user-b"]);
    const { jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));
    expect(fake.accepted[0]!.meeting.facts!.participantIds).toEqual(["creator-1", "user-b"]);
  });

  it("lists the Operai participants in the database's order of user id, never re-sorted (decisions T8)", async () => {
    // Mixed case on purpose: the database's collation (`en_US.utf8`) puts `amy-3` < `Bob-2` < `zed-1`, a JavaScript code-unit
    // sort puts `Bob-2` < `amy-3` < `zed-1`. The wire's order is the database's, and through hours-api's `desiredEntries` it is
    // the order in which the automatic entries are created.
    const m = await seedMeeting({}, ["zed-1", "Bob-2", "amy-3"]);
    const inDatabaseOrder = (
      await db.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "meeting_participant" WHERE "meetingId" = ${m.id} AND "userId" IS NOT NULL ORDER BY "userId"`
    ).map((r) => r.userId);
    // Guards the test itself: on a database whose collation agrees with JavaScript's, this case proves nothing, so it must fail.
    expect(inDatabaseOrder).not.toEqual([...inDatabaseOrder].sort());

    const { jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));

    expect(fake.accepted[0]!.meeting.facts!.participantIds).toEqual(inDatabaseOrder);
  });

  it("carries a duration that is no longer known as null (the too-long refusal of an upload) and a meeting with nobody else as an empty list", async () => {
    const m = await seedMeeting({ durationMs: null });
    const { jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));
    expect(fake.accepted[0]!.meeting.facts).toEqual({ startsAt: "2026-11-24T09:00:00.000Z", durationMs: null, creatorId: "creator-1", participantIds: [] });
  });

  it("sends `facts: null` at the row's own version when the meeting no longer exists, even for a `state` notice", async () => {
    const { notice, jobId } = await announce("meeting-that-is-gone", 7);
    await runner.tick();
    await until(settled(jobId));
    expect(fake.received[0]!.body).toEqual({ noticeId: notice.id, meeting: { id: "meeting-that-is-gone", seq: 7, facts: null } });
  });

  it("sends `facts: null` for a `deleted` notice at the row's version, whatever the meeting row says", async () => {
    const m = await seedMeeting({ hoursSeq: 9 }, ["user-b"]);
    const { jobId } = await announce(m.id, 4, "deleted");
    await runner.tick();
    await until(settled(jobId));
    expect(fake.received[0]!.notice!.meeting).toEqual({ id: m.id, seq: 4, facts: null });
  });
});

describe("a deleted meeting is announced after it is gone (AC-3.4)", () => {
  it("the job carries no meetingId, so deleting the meeting (a cascade) does not take it away, and the notice is delivered", async () => {
    const m = await seedMeeting({}, ["user-b"]);
    const { notice, jobId } = await announce(m.id, 2, "deleted");
    expect((await job(jobId)).meetingId).toBeNull();

    // The route writes the notice in the delete's transaction and then deletes the meeting: the cascade runs.
    await db.meeting.delete({ where: { id: m.id } });
    expect(await db.meetingJob.count({ where: { id: jobId } })).toBe(1);
    expect(await row(notice.id)).not.toBeNull();

    await runner.tick();
    await until(settled(jobId));

    expect(fake.accepted).toEqual([{ noticeId: notice.id, meeting: { id: m.id, seq: 2, facts: null } }]);
    expect(await row(notice.id)).toBeNull();
    expect((await job(jobId)).state).toBe("done");
  });
});

describe("the outcome settles the row (plan § Delivering a notice step 4)", () => {
  it("200: the row is deleted and the job is done", async () => {
    const m = await seedMeeting();
    const { notice, jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));
    expect(await row(notice.id)).toBeNull();
    expect((await job(jobId)).state).toBe("done");
    expect(logged.join("\n")).toContain(`meeting_hours.notice_delivered meeting=${m.id}`);
  });

  it("400: the row is kept as failed with the code, the job is done (never retried), and the log names the meeting and the code only", async () => {
    fake.enqueue({ status: 400, body: { status: 400, code: "invalid_request", field: "meeting.seq" } });
    const m = await seedMeeting({}, ["user-secret-b"]);
    const { notice, jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));

    expect(await row(notice.id)).toMatchObject({ state: "failed", lastErrorCode: "invalid_request" });
    expect((await job(jobId)).state).toBe("done");
    expect(fake.received).toHaveLength(1);
    const refused = logged.filter((line) => line.includes("meeting_hours.notice_refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(`meeting=${m.id}`);
    expect(refused[0]).toContain("code=invalid_request");
    for (const forbidden of ["user-secret-b", "creator-1", "Budget review", "service-token"]) expect(logged.join("\n")).not.toContain(forbidden);

    // A failed row is not sent again by a stray second job.
    await db.$transaction((tx) => enqueueJob(tx, { kind: "deliver_hours_notice", noticeId: notice.id, maxAttempts: HOURS_NOTICE_MAX_ATTEMPTS }));
    await runner.tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.received).toHaveLength(1);
  });

  it("422: failed for good, code rejected", async () => {
    fake.enqueue({ status: 422 });
    const m = await seedMeeting();
    const { notice, jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));
    expect(await row(notice.id)).toMatchObject({ state: "failed", lastErrorCode: "rejected" });
    expect((await job(jobId)).state).toBe("done");
  });

  it("a body the shared wire schema refuses (an id over 64 characters) is failed for good as invalid_notice, and nothing is sent", async () => {
    const m = await seedMeeting({ creatorUserId: "x".repeat(65) });
    const { notice, jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));
    expect(fake.received).toHaveLength(0);
    expect(await row(notice.id)).toMatchObject({ state: "failed", lastErrorCode: "invalid_notice" });
    expect((await job(jobId)).state).toBe("done");
    expect(logged.join("\n")).toContain("code=invalid_notice");
  });

  it("a notice whose row is gone (delivered earlier) is done and sends nothing", async () => {
    const m = await seedMeeting();
    const { notice, jobId } = await announce(m.id, 1);
    await db.hoursNotice.delete({ where: { id: notice.id } });
    await runner.tick();
    await until(settled(jobId));
    expect(fake.received).toHaveLength(0);
    expect((await job(jobId)).state).toBe("done");
  });
});

describe("retries until delivered (AC-4.2)", () => {
  it("503 five times, then 200: retried after 30 s, 2 min, 10 min, 30 min and 30 min, delivered once, the row settled", async () => {
    fake.enqueue({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    const m = await seedMeeting({}, ["user-b"]);
    const { notice, jobId } = await announce(m.id, 1);

    const delays = [30_000, 120_000, 600_000, 1_800_000, 1_800_000];
    for (const [i, delay] of delays.entries()) {
      await runner.tick();
      await until(async () => (await job(jobId)).attempts === i + 1 && (await job(jobId)).state === "queued");
      const waiting = await job(jobId);
      expect(waiting.runAfter.getTime() - c.t).toBe(delay);
      expect(waiting.lastErrorCode).toBe("http_503");
      expect(await row(notice.id)).toMatchObject({ state: "pending", attempts: i + 1, lastErrorCode: "http_503" });

      // Not before it is due.
      c.advance(delay - 1);
      await runner.tick();
      await new Promise((r) => setTimeout(r, 30));
      expect(fake.received).toHaveLength(i + 1);
      c.advance(1);
    }

    await runner.tick();
    await until(settled(jobId));

    expect(fake.received).toHaveLength(6);
    expect(fake.accepted).toHaveLength(1);
    expect(await row(notice.id)).toBeNull();
    expect((await job(jobId)).state).toBe("done");
    // Every attempt sent the same current facts.
    expect(new Set(fake.received.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it("is never stopped by the runner's attempt cap: the job is enqueued with an effectively unlimited one", () => {
    expect(HOURS_NOTICE_MAX_ATTEMPTS).toBe(1_000_000);
  });

  it("hours-api not yet deployed (404), a missing scope (403) and a limiter (429) are all retried, not failed", async () => {
    for (const status of [404, 403, 429]) {
      await db.$executeRawUnsafe('TRUNCATE "meeting_job", "hours_notice" CASCADE');
      fake.reset();
      fake.enqueue({ status });
      const m = await seedMeeting({}, []);
      const { notice, jobId } = await announce(m.id, 1);
      await runner.tick();
      await until(async () => (await job(jobId)).state === "queued" && (await job(jobId)).attempts === 1);
      expect(await row(notice.id)).toMatchObject({ state: "pending", lastErrorCode: `http_${status}` });
      c.advance(31_000);
      await runner.tick();
      await until(settled(jobId));
      expect(await row(notice.id)).toBeNull();
      await db.meeting.delete({ where: { id: m.id } });
    }
  });

  it("a network that is down is retried, and the notice is delivered once hours-api answers", async () => {
    await fake.stop();
    const m = await seedMeeting();
    const { notice, jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(async () => (await job(jobId)).state === "queued" && (await job(jobId)).attempts === 1);
    expect(await row(notice.id)).toMatchObject({ state: "pending", lastErrorCode: "transport" });

    fake = startFakeHours();
    setHoursChannelForTests({ baseUrl: fake.url, tokens: staticTokens });
    c.advance(31_000);
    await runner.tick();
    await until(settled(jobId));
    expect(fake.accepted).toHaveLength(1);
    expect(await row(notice.id)).toBeNull();
  });

  it("a 401 that survives the token refresh is retried (an operator has to fix the client or the allowlist)", async () => {
    fake.enqueue({ status: 401 }, { status: 401 });
    const m = await seedMeeting();
    const { notice, jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(async () => (await job(jobId)).state === "queued" && (await job(jobId)).attempts === 1);
    expect(await row(notice.id)).toMatchObject({ state: "pending", lastErrorCode: "unauthorized" });
    expect(fake.received).toHaveLength(2);
  });

  it("the facts are read again at every attempt: a change between two attempts is what the next one sends", async () => {
    fake.enqueue({ status: 503 });
    const m = await seedMeeting({ hoursSeq: 1, durationMs: 1_800_000 });
    const { jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(async () => (await job(jobId)).state === "queued" && (await job(jobId)).attempts === 1);

    await db.meeting.update({ where: { id: m.id }, data: { hoursSeq: 2, durationMs: 3_600_000 } });
    c.advance(31_000);
    await runner.tick();
    await until(settled(jobId));

    expect(fake.received.map((r) => (r.notice!.meeting.facts as { durationMs: number }).durationMs)).toEqual([1_800_000, 3_600_000]);
    expect(fake.received.map((r) => r.notice!.meeting.seq)).toEqual([1, 2]);
  });

  it("logs a retry with the meeting id and the closed code, and no user id, token or title", async () => {
    fake.enqueue({ status: 503 });
    const m = await seedMeeting({}, ["user-secret-b"]);
    const { jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(async () => (await job(jobId)).state === "queued" && (await job(jobId)).attempts === 1);
    const lines = logged.filter((line) => line.includes("meeting_hours.notice_retry"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`meeting=${m.id}`);
    expect(lines[0]).toContain("code=http_503");
    for (const forbidden of ["user-secret-b", "creator-1", "Budget review", "service-token"]) expect(logged.join("\n")).not.toContain(forbidden);
  });
});

describe("the channel is off (no HOURS_API_URL or no service credential)", () => {
  it("the job marks its row failed `disabled` and sends nothing: it is not retried, and nothing is left pending", async () => {
    setHoursChannelForTests(null);
    const m = await seedMeeting();
    const { notice, jobId } = await announce(m.id, 1);
    await runner.tick();
    await until(settled(jobId));
    expect(fake.received).toHaveLength(0);
    expect(await row(notice.id)).toMatchObject({ state: "failed", lastErrorCode: "disabled" });
    expect((await job(jobId)).state).toBe("done");
    expect(logged.join("\n")).toContain("code=disabled");
  });
});
