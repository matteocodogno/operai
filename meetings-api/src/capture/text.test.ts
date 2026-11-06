import { describe, expect, it } from "bun:test";
import { authDown, CREATOR, OTHER, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";

// AC-3.4: up to 200,000 characters become the transcript; no consent is asked.

useKit();

const put = (id: string, text: unknown, user = CREATOR) => call("PUT", `/meetings/${id}/text`, { user, body: { text } });
const textMeeting = (over = {}) => mkMeeting({ source: "text", consentUserId: null, consentAt: null, consentNoticeVersion: null, ...over });

describe("PUT /meetings/:id/text", () => {
  it("turns the text into passages and the meeting into ready, without any consent", async () => {
    const m = await textMeeting();
    const res = await put(m.id, "First paragraph.\n\nSecond paragraph.");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: "ready", source: "text", noSpeech: false, consent: null });
    const segments = await db.transcriptSegment.findMany({ where: { meetingId: m.id }, orderBy: { ordinal: "asc" } });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ ordinal: 0, startMs: null, endMs: null, speakerKey: null, edited: false, version: 1 });
    expect(segments[0]?.text).toBe("First paragraph.\n\nSecond paragraph.");
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe("ready");
    expect(row.transcriptVersion).toBe(1);
    expect(row.processingStartedAt).not.toBeNull();
    expect(row.processedAt).not.toBeNull();
    expect(row.durationMs).toBeNull();
    expect(await db.meetingJob.count()).toBe(0);
  });

  it("accepts exactly 200,000 characters", async () => {
    const m = await textMeeting();
    const text = "word ".repeat(40_000);
    expect(text.length).toBe(200_000);
    const res = await put(m.id, text);
    expect(res.status).toBe(200);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("ready");
    expect(await db.transcriptSegment.count({ where: { meetingId: m.id } })).toBeGreaterThan(190);
  });

  it("refuses 200,001 characters with 422 and stores nothing", async () => {
    const m = await textMeeting();
    const res = await put(m.id, "a".repeat(200_001));
    expect(res.status).toBe(422);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
    expect(await db.transcriptSegment.count()).toBe(0);
  });

  it("counts characters, not UTF-16 units: 200,000 emoji are accepted", async () => {
    const m = await textMeeting();
    expect((await put(m.id, "😀".repeat(200_000))).status).toBe(200);
  });

  it("empty or whitespace-only text is 422", async () => {
    const m = await textMeeting();
    expect((await put(m.id, "")).status).toBe(422);
    expect((await put(m.id, "  \n\n \t")).status).toBe(422);
    expect((await put(m.id, 12)).status).toBe(422);
  });

  it("a body over 1 MiB is 413 (the route's own limit, not the 64 KiB default)", async () => {
    const m = await textMeeting();
    const res = await put(m.id, "a".repeat(1024 * 1024 + 10));
    expect(res.status).toBe(413);
    // 100 KiB passes the route limit
    expect((await put(m.id, "a".repeat(100 * 1024))).status).toBe(200);
  });

  it("replacing the text of a ready meeting swaps the passages and bumps transcriptVersion", async () => {
    const m = await textMeeting();
    await put(m.id, "old text");
    const res = await put(m.id, "new text");
    expect(res.status).toBe(200);
    const segments = await db.transcriptSegment.findMany({ where: { meetingId: m.id } });
    expect(segments.map((s) => s.text)).toEqual(["new text"]);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).transcriptVersion).toBe(2);
  });

  it("only a text meeting takes text: 409 wrong_source", async () => {
    const m = await mkMeeting({ source: "recorded" });
    const res = await put(m.id, "hello");
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("wrong_source");
  });

  it("a meeting that is processing or failed is 409 not_editable", async () => {
    const m = await textMeeting({ status: "processing" });
    const res = await put(m.id, "hello");
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("not_editable");
  });

  it("creator-control: a stranger 404, a participant 403 creator_only, no access 403, frozen 403, outage 503", async () => {
    const m = await textMeeting();
    expect((await put(m.id, "x", OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    const participant = await put(m.id, "x", OTHER);
    expect(participant.status).toBe(403);
    expect((await json<{ code: string }>(participant)).code).toBe("creator_only");
    kit.grants.set(CREATOR, []);
    expect((await json<{ code: string }>(await put(m.id, "x"))).code).toBe("meetings_access_required");
    kit.grants.clear();
    kit.identities.set(CREATOR, "deleted");
    expect((await json<{ code: string }>(await put(m.id, "x"))).code).toBe("frozen");
    kit.identities.clear();
    authDown();
    expect((await put(m.id, "x")).status).toBe(503);
  });
});
