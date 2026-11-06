import { beforeEach, afterEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";
import { createRunner, type Runner } from "../jobs/runner";
import { deliverHostNotice } from "../jobs/handlers/deliverHostNotice";
import { deliverNotices, recordNotice, retryFailedNotices } from "./notices";

// AC-11.8, AC-11.9, AC-14.6, AC-14.8, AC-14.10, AC-14.11 (specs/021 T20): the host-notice
// outbox, its one awaited attempt, the manual vs until-delivered policies, the retry route.

// At the top level, so the kit's teardown is registered for this file (not for a hook).
const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1" });
  kit.grant("creator", "access");
  kit.grant("pat", "access");
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const WIDGET = { app: "testhost", entityType: "widget", entityId: "w1" } as const;

async function seed(over: Record<string, unknown> = {}) {
  return kit.db.meeting.create({
    data: {
      title: "Budget review",
      format: "online",
      startsAt: new Date("2026-11-05T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      creatorUserId: "creator",
      hostApp: "testhost",
      hostEntityType: "widget",
      hostEntityId: "w1",
      ...over,
    } as never,
  });
}

const record = (meeting: { id: string; creatorUserId: string }, input: Parameters<typeof recordNotice>[3], target: Parameters<typeof recordNotice>[2] = WIDGET) =>
  kit.db.$transaction((tx) => recordNotice(tx, meeting, target, input));

const STARTS = new Date("2026-11-05T09:00:00.000Z");

describe("recording and the one awaited attempt", () => {
  it("delivers a linked notice with exactly the contract's keys, then removes the row", async () => {
    const m = await seed();
    const id = await record(m, { event: "linked", title: m.title, startsAt: STARTS });
    expect(id).not.toBeNull();
    expect(await kit.db.hostNotice.count()).toBe(1);

    await deliverNotices([id!]);

    expect(kit.fake.notices).toHaveLength(1);
    const body = kit.fake.notices[0]!.body as { noticeId: string; seq: number; event: string; meeting: Record<string, unknown>; entity: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["entity", "event", "meeting", "noticeId", "seq"]);
    expect(Object.keys(body.meeting).sort()).toEqual(["creatorId", "id", "startsAt", "title"]);
    expect(Object.keys(body.entity).sort()).toEqual(["id", "type"]);
    expect(body).toMatchObject({
      noticeId: id,
      seq: 1,
      event: "linked",
      meeting: { id: m.id, title: "Budget review", startsAt: "2026-11-05T09:00:00.000Z", creatorId: "creator" },
      entity: { type: "widget", id: "w1" },
    });
    expect(await kit.db.hostNotice.count()).toBe(0);
  });

  it("numbers notices per meeting, monotonically", async () => {
    const a = await seed();
    const b = await seed();
    const ids = [
      await record(a, { event: "linked", title: "t", startsAt: STARTS }),
      await record(a, { event: "unlinked" }),
      await record(b, { event: "linked", title: "t", startsAt: STARTS }),
    ];
    const rows = await kit.db.hostNotice.findMany({ where: { id: { in: ids as string[] } }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.meetingId === a.id ? "a" : "b", r.seq])).toEqual([["a", 1], ["a", 2], ["b", 1]]);
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: a.id } })).hostNoticeSeq).toBe(2);
  });

  it("unlinked and deleted carry no title and no date-time, in the row and on the wire", async () => {
    const m = await seed();
    const ids = [await record(m, { event: "unlinked" }), await record(m, { event: "deleted" })] as string[];
    const rows = await kit.db.hostNotice.findMany({ where: { id: { in: ids } } });
    for (const row of rows) {
      expect(row.title).toBeNull();
      expect(row.startsAt).toBeNull();
      expect(row.policy).toBe("until_delivered");
    }
    await deliverNotices(ids);
    for (const n of kit.fake.notices) expect(n.body["meeting"]).toEqual({ id: m.id, title: null, startsAt: null, creatorId: "creator" });
  });

  it("a host that did not opt in, and a standalone meeting, get zero calls and leave no row", async () => {
    const m = await seed();
    kit.fake.setEntity("gadget", "g1", { title: "Gadget", href: "/q/g1" });
    const quiet = await record(m, { event: "linked", title: "t", startsAt: STARTS }, { app: "quiethost", entityType: "gadget", entityId: "g1" });
    const unregistered = await record(m, { event: "linked", title: "t", startsAt: STARTS }, { app: "nohost", entityType: "x", entityId: "1" });
    expect(quiet).toBeNull();
    expect(unregistered).toBeNull();
    await deliverNotices([]);
    expect(kit.fake.notices).toHaveLength(0);
    expect(kit.fake.quietNoticeAttempts).toHaveLength(0);
    expect(await kit.db.hostNotice.count()).toBe(0);
    expect(await kit.db.meetingJob.count()).toBe(0);
    // no seq was spent on a notice nobody will receive
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).hostNoticeSeq).toBe(0);
  });

  it("a newer notice for the same entity supersedes a failed manual one", async () => {
    const m = await seed();
    kit.fake.mode.notices = { status: 500 };
    const first = (await record(m, { event: "linked", title: "t", startsAt: STARTS }))!;
    await deliverNotices([first]);
    expect((await kit.db.hostNotice.findUniqueOrThrow({ where: { id: first } })).state).toBe("failed");

    kit.fake.mode.notices = {};
    const second = (await record(m, { event: "changed", title: "t2", startsAt: STARTS }))!;
    expect(await kit.db.hostNotice.findUnique({ where: { id: first } })).toBeNull();
    await deliverNotices([second]);
    expect(await kit.db.hostNotice.count()).toBe(0);
  });
});

describe("manual policy: linked and changed", () => {
  it("a 500 leaves the notice failed with no retry job, the view carries it, and the retry route delivers it", async () => {
    const m = await seed();
    kit.fake.mode.notices = { status: 500 };
    const id = (await record(m, { event: "linked", title: "Budget review", startsAt: STARTS }))!;
    await deliverNotices([id]);

    const row = await kit.db.hostNotice.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: "failed", policy: "manual", attempts: 1, lastErrorCode: "unavailable" });
    expect(await kit.db.meetingJob.count()).toBe(0);

    // still failing: the retry says so, the row stays, still no job
    const again = await kit.call("creator", "POST", `/meetings/${m.id}/host-notice/retry`);
    expect(again.status).toBe(200);
    const stillFailed = (await again.json()) as { hostNotice: unknown; can: { retryHostNotice: boolean } };
    expect(stillFailed.hostNotice).toEqual({ state: "failed", event: "linked" });
    expect(stillFailed.can.retryHostNotice).toBe(true);
    expect(await kit.db.hostNotice.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "failed", attempts: 2 });
    expect(await kit.db.meetingJob.count()).toBe(0);

    kit.fake.mode.notices = {};
    const res = await kit.call("creator", "POST", `/meetings/${m.id}/host-notice/retry`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hostNotice: unknown }).hostNotice).toBeNull();
    expect(await kit.db.hostNotice.count()).toBe(0);
    expect(kit.fake.notices.filter((n) => n.applied)).toHaveLength(1);
  });

  it("retry with nothing failed is a harmless no-op", async () => {
    const m = await seed();
    const res = await kit.call("creator", "POST", `/meetings/${m.id}/host-notice/retry`);
    expect(res.status).toBe(200);
    expect(kit.fake.notices).toHaveLength(0);
  });

  it("is refused 403 frozen when the creator's account is deactivated (AC-14.10)", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    kit.fake.mode.notices = { status: 500 };
    await deliverNotices([(await record(m, { event: "linked", title: "t", startsAt: STARTS }))!]);
    kit.fake.reset();
    kit.deactivate("creator");

    const res = await kit.call("creator", "POST", `/meetings/${m.id}/host-notice/retry`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("frozen");
    expect(kit.fake.notices).toHaveLength(0);
    // ...and for everyone else: a participant is not the creator
    const other = await kit.call("pat", "POST", `/meetings/${m.id}/host-notice/retry`);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { code: string }).code).toBe("creator_only");
  });

  it("answers a stranger the identical 404 and a creator without meetings:access 403 meetings_access_required", async () => {
    const m = await seed();
    kit.grant("stranger", "access");
    const stranger = await kit.call("stranger", "POST", `/meetings/${m.id}/host-notice/retry`);
    const missing = await kit.call("stranger", "POST", `/meetings/nope/host-notice/retry`);
    expect(stranger.status).toBe(404);
    expect(await stranger.text()).toBe((await missing.text()).replace("/meetings/nope/", `/meetings/${m.id}/`));

    kit.grant("creator");
    const res = await kit.call("creator", "POST", `/meetings/${m.id}/host-notice/retry`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("meetings_access_required");
  });

  it("retryFailedNotices touches only this meeting's failed manual notices", async () => {
    const a = await seed();
    const b = await seed();
    kit.fake.mode.notices = { status: 500 };
    await deliverNotices([(await record(a, { event: "linked", title: "t", startsAt: STARTS }))!, (await record(b, { event: "linked", title: "t", startsAt: STARTS }))!]);
    kit.fake.mode.notices = {};
    await retryFailedNotices(a.id);
    expect(await kit.db.hostNotice.count({ where: { meetingId: a.id } })).toBe(0);
    expect(await kit.db.hostNotice.count({ where: { meetingId: b.id } })).toBe(1);
  });
});

describe("until-delivered policy: unlinked and deleted", () => {
  const runners: Runner[] = [];
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop(500)));
  });
  const until = async (cond: () => Promise<boolean>, ms = 3_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("condition not met in time");
  };

  it("is queued in the change's transaction, outliving the meeting's deletion (no foreign key to it)", async () => {
    const m = await seed();
    const id = (await record(m, { event: "deleted" }))!;
    const jobs = await kit.db.meetingJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "deliver_host_notice", noticeId: id, meetingId: null, state: "queued" });

    await kit.db.meeting.delete({ where: { id: m.id } });
    expect(await kit.db.meetingJob.count()).toBe(1);
    expect(await kit.db.hostNotice.count()).toBe(1);
  });

  it("delivered on the first attempt: the row and the queued job are removed", async () => {
    const m = await seed();
    const id = (await record(m, { event: "unlinked" }))!;
    await deliverNotices([id]);
    expect(await kit.db.hostNotice.count()).toBe(0);
    expect(await kit.db.meetingJob.count()).toBe(0);
  });

  it("failing three times is delivered by the retry jobs, on the 1 m, 5 m, 30 m schedule", async () => {
    const m = await seed();
    kit.fake.mode.notices = { status: 500 };
    const id = (await record(m, { event: "deleted" }))!;
    await deliverNotices([id]); // failure 1: the awaited attempt after commit
    expect(kit.fake.notices).toHaveLength(1);
    expect(await kit.db.hostNotice.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "pending", attempts: 1, lastErrorCode: "unavailable" });

    const clock = { t: Date.now() + 61_000 };
    const runner = createRunner({ db: kit.db, handlers: { deliver_host_notice: deliverHostNotice }, listenUrl: null, idlePollMs: 60_000, now: () => new Date(clock.t) });
    runners.push(runner);
    const job = () => kit.db.meetingJob.findFirstOrThrow();

    await runner.tick(); // failure 2 (1 m after the change)
    await until(async () => kit.fake.notices.length === 2 && (await job()).state === "queued");
    expect((await job()).runAfter.getTime()).toBeGreaterThanOrEqual(clock.t + 5 * 60_000 - 1);

    await runner.tick(); // too early: nothing is due
    expect(kit.fake.notices).toHaveLength(2);

    clock.t += 5 * 60_000 + 1_000;
    await runner.tick(); // failure 3
    await until(async () => kit.fake.notices.length === 3 && (await job()).state === "queued");
    expect((await job()).runAfter.getTime()).toBeGreaterThanOrEqual(clock.t + 30 * 60_000 - 1);

    kit.fake.mode.notices = {};
    clock.t += 30 * 60_000 + 1_000;
    await runner.tick(); // delivered
    await until(async () => (await job()).state === "done");
    expect(await kit.db.hostNotice.count()).toBe(0);
    expect(kit.fake.notices.filter((n) => n.applied)).toHaveLength(1);
  });

  it("the schedule caps at every 6 h", async () => {
    const { noticeRetryDelayMs } = await import("./notices");
    expect([1, 2, 3, 4, 5, 6, 40].map(noticeRetryDelayMs)).toEqual([
      5 * 60_000,
      30 * 60_000,
      2 * 3_600_000,
      6 * 3_600_000,
      6 * 3_600_000,
      6 * 3_600_000,
      6 * 3_600_000,
    ]);
  });

  it("an entity the host no longer has ends the retries and removes the row (nothing is left to unlink)", async () => {
    const m = await seed({ hostEntityId: "ghost" });
    const id = (await record(m, { event: "unlinked" }, { app: "testhost", entityType: "widget", entityId: "ghost" }))!;
    await deliverNotices([id]);
    expect(await kit.db.hostNotice.count()).toBe(0);
    expect(await kit.db.meetingJob.count()).toBe(0);
  });
});
