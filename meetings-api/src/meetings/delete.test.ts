import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";

// AC-4.6, AC-4.8, AC-5.12, AC-14.6 (specs/021 T25): deleting a meeting, by its creator or by
// a holder of meeting:erase, with the storage prefix first and a content-free trace after.

const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  kit.grant("creator", "access");
  kit.grant("pat", "access");
  kit.grant("stranger", "access");
  kit.grant("eraser", "erase");
  kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1" });
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const json = async (res: Response) => (await res.json()) as Record<string, any>;
const del = (id: string, who = "creator") => kit.call(who, "DELETE", `/meetings/${id}`);

/** A meeting with a row in every table that can hold one, and objects in storage. */
async function rich(over: Record<string, unknown> = {}) {
  const m = await kit.db.meeting.create({
    data: {
      title: "Salary talks",
      format: "online",
      startsAt: new Date("2026-11-05T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      status: "ready",
      creatorUserId: "creator",
      audioKey: "x",
      audioCreatedAt: new Date(),
      participants: { create: [{ userId: "pat", addedBy: "creator" }, { externalName: "Dana", addedBy: "creator" }] },
      ...over,
    } as never,
    include: { participants: true },
  });
  const session = await kit.db.recordingSession.create({ data: { meetingId: m.id } });
  await kit.db.recordingChunk.create({ data: { meetingId: m.id, seq: 0, sessionId: session.id, objectKey: `meetings/${m.id}/chunks/000000`, sizeBytes: 1, durationMs: 1000 } });
  await kit.db.meetingUpload.create({ data: { meetingId: m.id, objectKey: `meetings/${m.id}/upload/cccccccc-cccc-4ccc-8ccc-cccccccccccc`, contentType: "audio/mpeg", sizeBytes: 1 } });
  await kit.db.transcriptSegment.create({ data: { meetingId: m.id, ordinal: 0, text: "secret words" } });
  await kit.db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s1", participantId: m.participants[0]!.id } });
  await kit.db.summary.create({ data: { meetingId: m.id, authorUserId: "creator", template: {}, language: "en", status: "ready", attemptId: "a", transcriptVersion: 0 } });
  await kit.db.conversationTurn.create({ data: { meetingId: m.id, userId: "pat", question: "what?", status: "answered", transcriptVersion: 0 } });
  await kit.db.meetingJob.create({ data: { kind: "summarize", meetingId: m.id, maxAttempts: 3 } });
  await kit.db.hostNotice.create({
    data: { hostApp: "testhost", entityType: "widget", entityId: "w1", meetingId: m.id, seq: 1, event: "linked", title: "Salary talks", startsAt: new Date(), creatorUserId: "creator", policy: "manual", state: "failed" },
  });
  kit.storage.put(`meetings/${m.id}/chunks/000000`, 1);
  kit.storage.put(`meetings/${m.id}/audio.ogg`, 1);
  return m;
}

const TABLES = ["recording_session", "recording_chunk", "meeting_upload", "meeting_participant", "transcript_segment", "speaker_label", "summary", "conversation_turn", "meeting_job", "host_notice"] as const;
async function rowsFor(id: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await kit.db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE "meetingId" = $1`, id);
    out[table] = Number(row?.n);
  }
  const [self] = await kit.db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "meeting" WHERE "id" = $1`, id);
  out["meeting"] = Number(self?.n);
  return out;
}
const allZero = Object.fromEntries([...TABLES, "meeting"].map((t) => [t, 0]));

describe("the creator deletes (AC-4.6)", () => {
  it("removes every row and every object, leaves only a content-free entry, and the id is gone for everyone", async () => {
    const m = await rich();
    const other = await rich({ title: "Someone else's" });
    const before = await rowsFor(m.id);
    expect(Object.values(before).every((n) => n >= 1)).toBe(true);

    const res = await del(m.id);
    expect(res.status).toBe(204);

    expect(await rowsFor(m.id)).toEqual(allZero);
    expect(kit.storage.keys()).toEqual([`meetings/${other.id}/audio.ogg`, `meetings/${other.id}/chunks/000000`].sort());
    expect(await rowsFor(other.id)).toEqual(before);

    const trace = await kit.db.meetingDeletion.findMany();
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ meetingId: m.id, deletedByUserId: "creator", via: "creator" });
    expect(Object.keys(trace[0]!).sort()).toEqual(["deletedAt", "deletedByUserId", "id", "meetingId", "via"]);
    expect(JSON.stringify(trace)).not.toContain("Salary");

    for (const who of ["creator", "pat", "stranger"]) expect((await kit.call(who, "GET", `/meetings/${m.id}`)).status).toBe(404);
    expect((await del(m.id)).status).toBe(404);
  });

  it("a storage failure is 503 storage_unavailable and NOTHING is deleted", async () => {
    const m = await rich();
    kit.storage.failWith(new Error("bucket down"));
    const res = await del(m.id);
    expect(res.status).toBe(503);
    expect((await json(res))["code"]).toBe("storage_unavailable");
    expect((await rowsFor(m.id))["meeting"]).toBe(1);
    expect(await kit.db.meetingDeletion.count()).toBe(0);
    expect(kit.fake.notices).toHaveLength(0);

    kit.storage.failWith(null);
    expect((await del(m.id)).status).toBe(204);
  });

  it("needs no capability: a creator who lost meetings:access, or while auth is down, can still delete (A4)", async () => {
    const a = await rich();
    kit.grant("creator");
    expect((await del(a.id)).status).toBe(204);
    const b = await rich();
    kit.setAuthDown(true);
    expect((await del(b.id)).status).toBe(204);
  });

  it("is refused 403 frozen when the creator's account is deactivated and the caller has no erase right (AC-5.11)", async () => {
    const m = await rich();
    kit.deactivate("creator");
    const res = await del(m.id);
    expect([res.status, (await json(res))["code"]]).toEqual([403, "frozen"]);
    expect((await rowsFor(m.id))["meeting"]).toBe(1);
  });

  it("a participant gets 403 creator_only; a stranger the same 404 as for an id that never existed", async () => {
    const m = await rich();
    const asPat = await del(m.id, "pat");
    expect([asPat.status, (await json(asPat))["code"]]).toEqual([403, "creator_only"]);
    const hidden = await del(m.id, "stranger");
    const missing = await del("nope", "stranger");
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe((await missing.text()).replace("/meetings/nope", `/meetings/${m.id}`));
    expect((await rowsFor(m.id))["meeting"]).toBe(1);
  });

  it("is 401 without a token", async () => {
    const m = await rich();
    expect((await kit.call(null, "DELETE", `/meetings/${m.id}`)).status).toBe(401);
  });
});

describe("the host is told (AC-4.6, AC-14.6)", () => {
  const onW1 = { hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" };

  it("one deleted notice with no title and no date-time, and the failed manual notice (which has a title) is dropped", async () => {
    const m = await rich(onW1);
    expect((await del(m.id)).status).toBe(204);
    expect(kit.fake.notices).toHaveLength(1);
    expect(kit.fake.notices[0]!.body).toMatchObject({
      event: "deleted",
      seq: 1,
      meeting: { id: m.id, title: null, startsAt: null, creatorId: "creator" },
      entity: { type: "widget", id: "w1" },
    });
    expect(await kit.db.hostNotice.count()).toBe(0);
  });

  it("a host that is down never blocks the deletion: the notice outlives the meeting, titleless, and is retried", async () => {
    const m = await rich(onW1);
    kit.fake.mode.notices = { status: 500 };
    expect((await del(m.id)).status).toBe(204);

    const notices = await kit.db.hostNotice.findMany();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ meetingId: m.id, event: "deleted", title: null, startsAt: null, policy: "until_delivered", attempts: 1 });
    const jobs = await kit.db.meetingJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "deliver_host_notice", noticeId: notices[0]!.id, meetingId: null });
    // the meeting's own rows are all gone regardless
    expect((await rowsFor(m.id))["meeting"]).toBe(0);
  });

  it("a standalone meeting, or a host that takes no notices, hears nothing (AC-14.11)", async () => {
    const standalone = await rich();
    await del(standalone.id);
    const quiet = await rich({ hostApp: "quiethost", hostEntityType: "gadget", hostEntityId: "g1" });
    await del(quiet.id);
    expect(kit.fake.notices).toHaveLength(0);
    expect(kit.fake.quietNoticeAttempts).toHaveLength(0);
  });
});

describe("a holder of meeting:erase (AC-4.8, AC-5.12)", () => {
  it("deletes another person's meeting without being able to read any of it", async () => {
    const m = await rich();
    // every content route is a 404 for the erase holder
    expect((await kit.call("eraser", "GET", `/meetings/${m.id}`)).status).toBe(404);
    expect((await kit.call("eraser", "PATCH", `/meetings/${m.id}`, { title: "x" })).status).toBe(404);
    expect((await kit.call("eraser", "PUT", `/meetings/${m.id}/participants`, { participants: [] })).status).toBe(404);
    expect((await kit.call("eraser", "POST", `/meetings/${m.id}/consent`, { noticeVersion: "2026-11-01" })).status).toBe(404);
    expect((await kit.call("eraser", "POST", `/meetings/${m.id}/host-notice/retry`)).status).toBe(404);

    expect((await del(m.id, "eraser")).status).toBe(204);
    expect(await rowsFor(m.id)).toEqual(allZero);
    expect(await kit.db.meetingDeletion.findMany()).toMatchObject([{ meetingId: m.id, deletedByUserId: "eraser", via: "erase" }]);
  });

  it("deletes a frozen meeting, which its own creator cannot, and its host hears of it", async () => {
    const m = await rich({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" });
    kit.deactivate("creator");
    expect((await del(m.id, "pat")).status).toBe(403);
    expect((await del(m.id, "eraser")).status).toBe(204);
    expect(kit.fake.notices.map((n) => (n.body as { event: string }).event)).toEqual(["deleted"]);
    expect(await rowsFor(m.id)).toEqual(allZero);
  });

  it("the right comes from auth: without it the same request is the stranger's 404; with auth down it cannot be assumed", async () => {
    const m = await rich();
    kit.grant("eraser", "template");
    expect((await del(m.id, "eraser")).status).toBe(404);
    kit.grant("eraser", "erase");
    kit.setAuthDown(true);
    expect((await del(m.id, "eraser")).status).toBe(404);
    expect((await rowsFor(m.id))["meeting"]).toBe(1);
  });

  it("an erase holder who is also a participant deletes as an eraser, and a missing id is still 404", async () => {
    const m = await rich();
    await kit.db.meetingParticipant.create({ data: { meetingId: m.id, userId: "eraser", addedBy: "creator" } });
    expect((await del(m.id, "eraser")).status).toBe(204);
    expect((await del("nope", "eraser")).status).toBe(404);
  });
});
