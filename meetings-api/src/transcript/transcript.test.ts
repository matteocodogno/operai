import { describe, expect, it } from "bun:test";
import { authDown, forgetAuth, CREATOR, OTHER, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";

// AC-6.1 (time order), AC-6.2 (speaker labels), AC-6.3 (edit with If-Match),
// AC-6.8 (an edit moves transcriptVersion), AC-5.8/5.11 (creator-only, frozen).

useKit();

interface Seg { id: string; ordinal: number; startMs: number | null; endMs: number | null; speakerKey: string | null; text: string; edited: boolean; version: number }
interface Transcript { version: number; parts: { index: number; startMs: number }[]; segments: Seg[]; speakers: { key: string; label: { kind: string; index?: number; participantId?: string; text?: string } }[] }

const get = (id: string, user = CREATOR) => call("GET", `/meetings/${id}/transcript`, { user });
const patch = (id: string, segmentId: string, text: unknown, ifMatch: string | null, user = CREATOR) =>
  call("PATCH", `/meetings/${id}/transcript/segments/${segmentId}`, { user, body: { text }, ...(ifMatch ? { headers: { "If-Match": ifMatch } } : {}) });
const putSpeaker = (id: string, key: string, body: unknown, user = CREATOR) => call("PUT", `/meetings/${id}/transcript/speakers/${key}`, { user, body });

/** A ready meeting with three voices (B speaks first, then A, then B, then C). */
async function ready(over = {}) {
  const m = await mkMeeting({ status: "ready", transcriptVersion: 1, processingStartedAt: new Date(), ...over });
  const rows: [number, string | null, string][] = [[0, "B", "Hello"], [1, "A", "Hi there"], [2, "B", "Agenda"], [3, "C", "Thanks"]];
  await db.transcriptSegment.createMany({
    data: rows.map(([ordinal, speakerKey, text]) => ({ meetingId: m.id, ordinal, startMs: ordinal * 5000, endMs: ordinal * 5000 + 4000, speakerKey, text })),
  });
  return m;
}
const segmentAt = async (meetingId: string, ordinal: number) => db.transcriptSegment.findUniqueOrThrow({ where: { meetingId_ordinal: { meetingId, ordinal } } });

describe("GET /meetings/:id/transcript", () => {
  it("lists the segments in time order with the meeting's transcript version, and the speakers by first appearance", async () => {
    const m = await ready();
    // insert order must not matter
    await db.transcriptSegment.create({ data: { meetingId: m.id, ordinal: 4, startMs: 20_000, endMs: 24_000, speakerKey: "A", text: "Bye" } });
    const res = await get(m.id);
    expect(res.status).toBe(200);
    const body = await json<Transcript>(res);
    expect(body.version).toBe(1);
    expect(body.segments.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(body.segments.map((s) => s.startMs)).toEqual([0, 5000, 10_000, 15_000, 20_000]);
    expect(body.segments[0]).toMatchObject({ speakerKey: "B", text: "Hello", edited: false, version: 1 });
    expect(body.speakers).toEqual([
      { key: "B", label: { kind: "default", index: 1 } },
      { key: "A", label: { kind: "default", index: 2 } },
      { key: "C", label: { kind: "default", index: 3 } },
    ]);
  });

  it("lists the parts: one entry per part, 1-based, with where each starts (ADR-0070)", async () => {
    const m = await ready({ transcriptPartStartsMs: [0, 3_600_000, 7_200_000] });
    const body = await json<Transcript>(await get(m.id));
    expect(body.parts).toEqual([{ index: 1, startMs: 0 }, { index: 2, startMs: 3_600_000 }, { index: 3, startMs: 7_200_000 }]);
  });

  it("a single part reads as one entry at 0", async () => {
    const m = await ready({ transcriptPartStartsMs: [0] });
    expect((await json<Transcript>(await get(m.id))).parts).toEqual([{ index: 1, startMs: 0 }]);
  });

  it("a meeting that heard nothing, a text meeting and one without a transcript yet have no parts", async () => {
    const quiet = await mkMeeting({ status: "ready", noSpeech: true, processingStartedAt: new Date() });
    const text = await mkMeeting({ source: "text", status: "ready", consentUserId: null, consentAt: null, consentNoticeVersion: null });
    const draft = await mkMeeting({});
    for (const m of [quiet, text, draft]) expect((await json<Transcript>(await get(m.id))).parts).toEqual([]);
  });

  it("shows participant and free-text labels where the creator set them", async () => {
    const m = await ready();
    const p = await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    await db.speakerLabel.createMany({
      data: [{ meetingId: m.id, speakerKey: "B", participantId: p.id }, { meetingId: m.id, speakerKey: "A", customLabel: "The client" }],
    });
    const body = await json<Transcript>(await get(m.id));
    expect(body.speakers.find((s) => s.key === "B")?.label).toEqual({ kind: "participant", participantId: p.id });
    expect(body.speakers.find((s) => s.key === "A")?.label).toEqual({ kind: "text", text: "The client" });
    expect(body.speakers.find((s) => s.key === "C")?.label).toEqual({ kind: "default", index: 3 });
  });

  it("a text meeting has passages: no times, no speaker, no speakers list", async () => {
    const m = await mkMeeting({ source: "text", status: "ready", consentUserId: null, consentAt: null, consentNoticeVersion: null });
    await db.transcriptSegment.create({ data: { meetingId: m.id, ordinal: 0, text: "A passage." } });
    const body = await json<Transcript>(await get(m.id));
    expect(body.segments[0]).toMatchObject({ startMs: null, endMs: null, speakerKey: null, text: "A passage." });
    expect(body.speakers).toEqual([]);
  });

  it("a meeting without segments yet reads empty", async () => {
    const m = await mkMeeting({ status: "processing" });
    expect(await json<Transcript>(await get(m.id))).toMatchObject({ version: 0, segments: [], speakers: [] });
  });

  it("is open to a participant, not to a stranger (404), and works while auth is down", async () => {
    const m = await ready();
    expect((await get(m.id, OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    expect((await get(m.id, OTHER)).status).toBe(200);
    authDown();
    expect((await get(m.id)).status).toBe(200);
  });

  it("a frozen meeting is still readable", async () => {
    const m = await ready();
    kit.identities.set(CREATOR, "deleted");
    expect((await get(m.id)).status).toBe(200);
  });
});

describe("PATCH /meetings/:id/transcript/segments/:segmentId", () => {
  it("saves the text, marks it edited, bumps the segment and the transcript version, answers the new ETag", async () => {
    const m = await ready();
    const seg = await segmentAt(m.id, 1);
    const res = await patch(m.id, seg.id, "Hi there, everyone", `"${seg.version}"`);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(await json<Seg>(res)).toMatchObject({ id: seg.id, ordinal: 1, text: "Hi there, everyone", edited: true, version: 2, speakerKey: "A", startMs: 5000 });
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).transcriptVersion).toBe(2);
    // the other segments are untouched
    expect((await segmentAt(m.id, 0)).edited).toBe(false);
  });

  it("no If-Match is 428; a stale one is 409 version_conflict naming the current version; nothing changes", async () => {
    const m = await ready();
    const seg = await segmentAt(m.id, 0);
    expect((await patch(m.id, seg.id, "x", null)).status).toBe(428);
    expect((await patch(m.id, seg.id, "x", "W/\"1\"")).status).toBe(428);
    await patch(m.id, seg.id, "first edit", '"1"');
    const stale = await patch(m.id, seg.id, "second edit", '"1"');
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: "version_conflict", currentVersion: 2 });
    expect((await segmentAt(m.id, 0)).text).toBe("first edit");
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).transcriptVersion).toBe(2);
  });

  it("saving identical text is a no-op: no edited flag, no version bump", async () => {
    const m = await ready();
    const seg = await segmentAt(m.id, 0);
    const res = await patch(m.id, seg.id, "Hello", '"1"');
    expect(res.status).toBe(200);
    expect(await json<Seg>(res)).toMatchObject({ edited: false, version: 1 });
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).transcriptVersion).toBe(1);
  });

  it("validates the text: empty, blank and over 10,000 characters are 422", async () => {
    const m = await ready();
    const seg = await segmentAt(m.id, 0);
    expect((await patch(m.id, seg.id, "", '"1"')).status).toBe(422);
    expect((await patch(m.id, seg.id, "  \n ", '"1"')).status).toBe(422);
    expect((await patch(m.id, seg.id, "a".repeat(10_001), '"1"')).status).toBe(422);
    expect((await patch(m.id, seg.id, "a".repeat(10_000), '"1"')).status).toBe(200);
  });

  it("a segment of another meeting, or an unknown one, is 404", async () => {
    const m = await ready();
    const other = await ready();
    const foreign = await segmentAt(other.id, 0);
    expect((await patch(m.id, foreign.id, "x", '"1"')).status).toBe(404);
    expect((await patch(m.id, "nope", "x", '"1"')).status).toBe(404);
    expect((await segmentAt(other.id, 0)).text).toBe("Hello");
  });

  it("only a ready meeting with speech can be edited: 409 not_ready", async () => {
    const m = await ready({ status: "processing" });
    const seg = await segmentAt(m.id, 0);
    const res = await patch(m.id, seg.id, "x", '"1"');
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("not_ready");
  });

  it("a non-creator participant is 403 creator_only, a stranger 404, a frozen creator 403 frozen, no access 403", async () => {
    const m = await ready();
    const seg = await segmentAt(m.id, 0);
    expect((await patch(m.id, seg.id, "x", '"1"', OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    const participant = await patch(m.id, seg.id, "x", '"1"', OTHER);
    expect(participant.status).toBe(403);
    expect((await json<{ code: string }>(participant)).code).toBe("creator_only");
    kit.identities.set(CREATOR, "deleted");
    expect((await json<{ code: string }>(await patch(m.id, seg.id, "x", '"1"'))).code).toBe("frozen");
    kit.identities.clear();
    kit.grants.set(CREATOR, []);
    forgetAuth();
    expect((await json<{ code: string }>(await patch(m.id, seg.id, "x", '"1"'))).code).toBe("meetings_access_required");
    expect((await segmentAt(m.id, 0)).text).toBe("Hello");
  });

  it("enqueues no job (a summary is never regenerated automatically, AC-6.8)", async () => {
    const m = await ready();
    const seg = await segmentAt(m.id, 0);
    await patch(m.id, seg.id, "changed", '"1"');
    expect(await db.meetingJob.count()).toBe(0);
  });
});

describe("PUT /meetings/:id/transcript/speakers/:key", () => {
  it("names a speaker after a participant of the meeting; it reads back on every segment of that key", async () => {
    const m = await ready();
    const p = await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    const res = await putSpeaker(m.id, "B", { participantId: p.id });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ key: "B", label: { kind: "participant", participantId: p.id } });
    const body = await json<Transcript>(await get(m.id));
    expect(body.speakers.find((s) => s.key === "B")?.label).toEqual({ kind: "participant", participantId: p.id });
    expect(body.segments.filter((s) => s.speakerKey === "B")).toHaveLength(2); // both B segments share the one label
  });

  it("free text replaces a participant label and is trimmed", async () => {
    const m = await ready();
    const p = await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    await putSpeaker(m.id, "B", { participantId: p.id });
    const res = await putSpeaker(m.id, "B", { text: "  The client  " });
    expect(await json(res)).toEqual({ key: "B", label: { kind: "text", text: "The client" } });
    expect(await db.speakerLabel.count({ where: { meetingId: m.id } })).toBe(1);
    const row = await db.speakerLabel.findUniqueOrThrow({ where: { meetingId_speakerKey: { meetingId: m.id, speakerKey: "B" } } });
    expect(row).toMatchObject({ participantId: null, customLabel: "The client" });
  });

  it("null resets the speaker to 'Speaker n'", async () => {
    const m = await ready();
    await putSpeaker(m.id, "A", { text: "Someone" });
    const res = await putSpeaker(m.id, "A", null);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ key: "A", label: { kind: "default", index: 2 } });
    expect(await db.speakerLabel.count({ where: { meetingId: m.id } })).toBe(0);
  });

  it("rejects a participant of another meeting (422), an empty or over-long text (422), an ambiguous body (422)", async () => {
    const m = await ready();
    const other = await ready();
    const foreign = await db.meetingParticipant.create({ data: { meetingId: other.id, userId: OTHER, addedBy: CREATOR } });
    const res = await putSpeaker(m.id, "B", { participantId: foreign.id });
    expect(res.status).toBe(422);
    expect((await json<{ code: string }>(res)).code).toBe("participant_not_in_meeting");
    expect((await putSpeaker(m.id, "B", { text: "   " })).status).toBe(422);
    expect((await putSpeaker(m.id, "B", { text: "a".repeat(101) })).status).toBe(422);
    expect((await putSpeaker(m.id, "B", { text: "x", participantId: foreign.id })).status).toBe(422);
    expect((await putSpeaker(m.id, "B", {})).status).toBe(422);
    expect(await db.speakerLabel.count()).toBe(0);
  });

  it("a key that no segment carries is 404", async () => {
    const m = await ready();
    expect((await putSpeaker(m.id, "Z", { text: "x" })).status).toBe(404);
  });

  it("creator-only: a participant is 403, a stranger 404, frozen 403; and no job is enqueued", async () => {
    const m = await ready();
    expect((await putSpeaker(m.id, "B", { text: "x" }, OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    expect((await putSpeaker(m.id, "B", { text: "x" }, OTHER)).status).toBe(403);
    kit.identities.set(CREATOR, "deleted");
    expect((await json<{ code: string }>(await putSpeaker(m.id, "B", { text: "x" }))).code).toBe("frozen");
    kit.identities.clear();
    expect((await putSpeaker(m.id, "B", { text: "x" })).status).toBe(200);
    expect(await db.meetingJob.count()).toBe(0);
  });
});
