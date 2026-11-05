import { describe, expect, it } from "bun:test";
import { authDown, forgetAuth, CREATOR, OTHER, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";
import { speakerNamesFor } from "../meetings/promptSegments";

// AC-6.16 (Separate by part), AC-5.8/AC-5.11 (creator-only, frozen), AC-6.2 (numbering), H-5/H-6 (names copied, defaultIndex,
// the row lock, no version bump). The matrix row (creator 200, participant 403, frozen 403, stranger 404) is in matrix.test.ts.

useKit();

interface Speaker { key: string; label: { kind: string; index?: number; participantId?: string; text?: string }; parts: number[]; joined: boolean }
interface Separated { speakers: Speaker[] }
interface Transcript { segments: { speakerKey: string | null; part: number | null; version: number }[]; speakers: Speaker[]; separateLabels: boolean }

const separate = (id: string, key: string, user = CREATOR) => call("POST", `/meetings/${id}/transcript/speakers/${key}/separate`, { user });
const get = (id: string) => call("GET", `/meetings/${id}/transcript`, { user: CREATOR });
const putSpeaker = (id: string, key: string, body: unknown) => call("PUT", `/meetings/${id}/transcript/speakers/${key}`, { user: CREATOR, body });

/** [ordinal, key, part] rows on a ready meeting with three parts. */
async function parted(rows: [number, string, number | null][], over = {}) {
  const m = await mkMeeting({
    status: "ready",
    transcriptVersion: 4,
    processingStartedAt: new Date(),
    transcriptPartStartsMs: [0, 510_000, 1_020_000],
    transcriptPartEndsMs: [600_000, 1_110_000, 1_620_000],
    ...over,
  });
  await db.transcriptSegment.createMany({
    data: rows.map(([ordinal, speakerKey, part]) => ({ meetingId: m.id, ordinal, startMs: ordinal * 100_000, endMs: ordinal * 100_000 + 4_000, speakerKey, text: `t${ordinal}`, part, version: ordinal + 1 })),
  });
  return m;
}
/** s1 is joined over parts 1, 2 and 3; s2 speaks in part 1 only. */
const JOINED: [number, string, number | null][] = [[0, "s1", 1], [1, "s2", 1], [2, "s1", 2], [3, "s1", 3], [4, "s1", 3]];
const keysByPart = async (id: string) => (await db.transcriptSegment.findMany({ where: { meetingId: id }, orderBy: { ordinal: "asc" } })).map((s) => `${s.speakerKey}@${s.part}`);

describe("POST /meetings/:id/transcript/speakers/:key/separate", () => {
  it("gives each later part its own key: the lowest part keeps the key, the others take the next unused numbers in part order", async () => {
    const m = await parted(JOINED);
    const res = await separate(m.id, "s1");
    expect(res.status).toBe(200);
    expect(await keysByPart(m.id)).toEqual(["s1@1", "s2@1", "s3@2", "s4@3", "s4@3"]);
    const body = await json<Separated>(res);
    expect(body.speakers.map((s) => [s.key, s.parts, s.joined])).toEqual([["s1", [1], false], ["s2", [1], false], ["s3", [2], false], ["s4", [3], false]]);
    // the same shape the transcript answers with, which now shows the notice (a later part has labels of its own)
    const after = await json<Transcript>(await get(m.id));
    expect(after.speakers).toEqual(body.speakers);
    expect(after.separateLabels).toBe(true);
  });

  it("an unnamed 'Speaker 1' stays Speaker 1 on every part until renamed (defaultIndex), and nobody else is renumbered", async () => {
    const m = await parted(JOINED);
    await separate(m.id, "s1");
    const speakers = (await json<Transcript>(await get(m.id))).speakers;
    expect(speakers.map((s) => [s.key, s.label])).toEqual([
      ["s1", { kind: "default", index: 1 }],
      ["s2", { kind: "default", index: 2 }],
      ["s3", { kind: "default", index: 1 }],
      ["s4", { kind: "default", index: 1 }],
    ]);
    const rows = await db.speakerLabel.findMany({ where: { meetingId: m.id }, orderBy: { speakerKey: "asc" } });
    expect(rows.map((r) => [r.speakerKey, r.defaultIndex, r.participantId, r.customLabel])).toEqual([["s3", 1, null, null], ["s4", 1, null, null]]);
  });

  it("each part keeps the name the joined label had: a participant, a free text, or the inherited default of its own", async () => {
    const m = await parted(JOINED);
    const p = await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    await db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s1", participantId: p.id } });
    await separate(m.id, "s1");
    expect((await json<Transcript>(await get(m.id))).speakers.filter((s) => s.key !== "s2").map((s) => s.label)).toEqual(Array(3).fill({ kind: "participant", participantId: p.id }));

    const t = await parted(JOINED);
    await db.speakerLabel.create({ data: { meetingId: t.id, speakerKey: "s1", customLabel: "The client" } });
    await separate(t.id, "s1");
    expect((await json<Transcript>(await get(t.id))).speakers.filter((s) => s.key !== "s2").map((s) => s.label)).toEqual(Array(3).fill({ kind: "text", text: "The client" }));

    // a label that itself inherited a default keeps reading that number on every part
    const d = await parted(JOINED);
    await db.speakerLabel.create({ data: { meetingId: d.id, speakerKey: "s1", defaultIndex: 7 } });
    await separate(d.id, "s1");
    expect((await json<Transcript>(await get(d.id))).speakers.filter((s) => s.key !== "s2").map((s) => s.label)).toEqual(Array(3).fill({ kind: "default", index: 7 }));
  });

  it("the rename that follows applies to ONE part's label only, and the names of the others stay (AC-6.16)", async () => {
    const m = await parted(JOINED);
    await separate(m.id, "s1");
    expect((await putSpeaker(m.id, "s3", { text: "Dana, part 2" })).status).toBe(200);
    const labels = (await json<Transcript>(await get(m.id))).speakers.map((s) => [s.key, s.label]);
    expect(labels).toEqual([
      ["s1", { kind: "default", index: 1 }],
      ["s2", { kind: "default", index: 2 }],
      ["s3", { kind: "text", text: "Dana, part 2" }],
      ["s4", { kind: "default", index: 1 }],
    ]);
  });

  it("before it, a rename of the joined key renames every part", async () => {
    const m = await parted(JOINED);
    expect((await putSpeaker(m.id, "s1", { text: "Dana" })).status).toBe(200);
    const speakers = (await json<Transcript>(await get(m.id))).speakers;
    expect(speakers.find((s) => s.key === "s1")).toMatchObject({ label: { kind: "text", text: "Dana" }, parts: [1, 2, 3], joined: true });
  });

  it("changes labels only: no transcript version bump, no segment version bump, no job", async () => {
    const m = await parted(JOINED);
    const before = (await json<Transcript>(await get(m.id))).segments.map((s) => s.version);
    await separate(m.id, "s1");
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).transcriptVersion).toBe(4);
    expect((await json<Transcript>(await get(m.id))).segments.map((s) => s.version)).toEqual(before);
    expect(await db.meetingJob.count()).toBe(0);
  });

  it("a second call is 409 not_joined, not a no-op; so is a key of one part", async () => {
    const m = await parted(JOINED);
    expect((await separate(m.id, "s1")).status).toBe(200);
    const again = await separate(m.id, "s1");
    expect(again.status).toBe(409);
    expect((await json<{ code: string }>(again)).code).toBe("not_joined");
    const one = await separate(m.id, "s2");
    expect(one.status).toBe(409);
    expect((await json<{ code: string }>(one)).code).toBe("not_joined");
  });

  it("rows with no part (older than the column) are not joined: 409 not_joined", async () => {
    const m = await parted([[0, "s1", null], [1, "s1", null]]);
    const res = await separate(m.id, "s1");
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("not_joined");
  });

  it("a key that no segment carries is 404; a meeting that is not ready, or heard nothing, is 409 not_ready", async () => {
    const m = await parted(JOINED);
    expect((await separate(m.id, "s9")).status).toBe(404);
    const processing = await mkMeeting({ status: "processing" });
    const res = await separate(processing.id, "s1");
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("not_ready");
    const quiet = await mkMeeting({ status: "ready", noSpeech: true, processingStartedAt: new Date() });
    expect((await json<{ code: string }>(await separate(quiet.id, "s1"))).code).toBe("not_ready");
  });

  it("a label the creator named is also copied when the key was renamed AFTER a first separation of another key (numbers never collide)", async () => {
    const m = await parted([[0, "s1", 1], [1, "s2", 1], [2, "s1", 2], [3, "s2", 2], [4, "s2", 3]]);
    expect((await separate(m.id, "s1")).status).toBe(200); // s1@2 -> s3
    expect((await separate(m.id, "s2")).status).toBe(200); // s2@2 -> s4, s2@3 -> s5
    expect(await keysByPart(m.id)).toEqual(["s1@1", "s2@1", "s3@2", "s4@2", "s5@3"]);
  });

  it("two separations at the same moment: one wins, the other is told it is not joined; no number is used twice", async () => {
    const m = await parted(JOINED);
    const [a, b] = await Promise.all([separate(m.id, "s1"), separate(m.id, "s1")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await keysByPart(m.id)).toEqual(["s1@1", "s2@1", "s3@2", "s4@3", "s4@3"]);
  });

  it("is the creator's alone: a stranger 404, a participant 403, a frozen meeting 403, and nothing changes", async () => {
    const m = await parted(JOINED);
    expect((await separate(m.id, "s1", OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    expect((await separate(m.id, "s1", OTHER)).status).toBe(403);
    kit.identities.set(CREATOR, "deleted");
    expect((await json<{ code: string }>(await separate(m.id, "s1"))).code).toBe("frozen");
    expect(await keysByPart(m.id)).toEqual(["s1@1", "s2@1", "s1@2", "s1@3", "s1@3"]);
    kit.identities.clear();
    // and a creator whose access was withdrawn
    kit.grants.set(CREATOR, []);
    forgetAuth();
    expect((await json<{ code: string }>(await separate(m.id, "s1"))).code).toBe("meetings_access_required");
    expect(await keysByPart(m.id)).toEqual(["s1@1", "s2@1", "s1@2", "s1@3", "s1@3"]);
  });

  it("while auth is down it is refused, not guessed (fail closed), and changes nothing", async () => {
    const m = await parted(JOINED);
    authDown();
    expect((await separate(m.id, "s1")).status).toBeGreaterThanOrEqual(500);
    expect(await keysByPart(m.id)).toEqual(["s1@1", "s2@1", "s1@2", "s1@3", "s1@3"]);
  });

  it("without a token it is 401", async () => {
    const m = await parted(JOINED);
    const res = await call("POST", `/meetings/${m.id}/transcript/speakers/s1/separate`, { user: null });
    expect(res.status).toBe(401);
  });

  it("the prompt names honour the inherited default: 'Speaker 1' on every part that inherited it (AC-6.16, AC-7.10)", async () => {
    const m = await parted(JOINED);
    await separate(m.id, "s1");
    const names = await speakerNamesFor(db, m.id, "Bearer x", async () => new Map());
    expect(names).toEqual({ s3: "Speaker 1", s4: "Speaker 1" });
    // a name set later wins over the default
    await putSpeaker(m.id, "s3", { text: "Dana" });
    expect(await speakerNamesFor(db, m.id, "Bearer x", async () => new Map())).toEqual({ s3: "Dana", s4: "Speaker 1" });
  });
});
