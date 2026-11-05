import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  buildMeetingView,
  loadMeetingView,
  type MeetingRecord,
  type ViewCaller,
  type ViewInput,
} from "./view";
import type { VisibilityDeps } from "./visibility";
import { ProblemError } from "../lib/problem";
import { db } from "../lib/db";
import type { Identity } from "../lib/identities";
import { startFakeHost } from "../test-support/fakeHost";

// AC-2.8, AC-2.9 (G3), AC-4.4, AC-5.8, AC-5.11, AC-10.6 and amendment G1: the
// Meeting a caller sees, with every derived field and every `can` flag.

const NOW = new Date("2026-11-05T10:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 86_400_000;

const record = (over: Partial<MeetingRecord> = {}): MeetingRecord => ({
  id: "m1",
  title: "Kick-off",
  format: "online",
  startsAt: at(-3600_000),
  language: "en",
  source: "recorded",
  status: "ready",
  stage: null,
  failureCode: null,
  noSpeech: false,
  creatorUserId: "creator",
  hostApp: null,
  hostEntityType: null,
  hostEntityId: null,
  hostVisible: false,
  consentUserId: null,
  consentAt: null,
  consentNoticeVersion: null,
  durationMs: 60_000,
  audioCreatedAt: at(-DAY),
  audioDeletedAt: null,
  processingStartedAt: at(-DAY),
  transcriptVersion: 2,
  ...over,
});

const people = (...ids: string[]) =>
  new Map<string, Identity>(ids.map((id) => [id, { id, name: `Name of ${id}`, status: "active" as const }]));

const input = (over: Partial<ViewInput> = {}): ViewInput => ({
  meeting: record(),
  role: "creator",
  caller: { holdsAccess: true, holdsErase: false, capabilities: "resolved" },
  frozen: false,
  people: people("creator", "pat", "consenter"),
  participants: [],
  latestSession: null,
  storedMs: 0,
  latestSessionStoredMs: 0,
  hasContent: true,
  summaryCount: 0,
  host: null,
  hostVisibleOffered: false,
  failedHostNotice: null,
  retry: { audioKey: "meetings/m1/audio.ogg", oldestSourceAt: null },
  ...over,
});

const FLAGS = [
  "edit", "changeSource", "changeLanguage", "manageParticipants", "link", "setVisibility", "capture",
  "editTranscript", "retryProcessing", "deleteAudio", "deleteMeeting", "summarise", "ask", "retryHostNotice",
] as const;
const allFalse = Object.fromEntries(FLAGS.map((f) => [f, false])) as Record<(typeof FLAGS)[number], boolean>;
const can = (over: Partial<ViewInput> = {}) => buildMeetingView(input(over), NOW).can;

describe("buildMeetingView: plain fields", () => {
  it("carries the contract's fields, with instants as ISO strings", () => {
    const v = buildMeetingView(input({ summaryCount: 3 }), NOW);
    expect(v).toMatchObject({
      id: "m1",
      title: "Kick-off",
      format: "online",
      startsAt: at(-3600_000).toISOString(),
      language: "en",
      source: "recorded",
      status: "ready",
      stage: null,
      failure: null,
      noSpeech: false,
      durationMs: 60_000,
      role: "creator",
      frozen: false,
      consent: null,
      participants: [],
      hostVisible: false,
      hostVisibleOffered: false,
      host: null,
      summaryCount: 3,
      transcriptVersion: 2,
      capabilities: "resolved",
      recording: null,
      hostNotice: null,
      creator: { id: "creator", name: "Name of creator", status: "active" },
    });
    expect(Object.keys(v.can).sort()).toEqual([...FLAGS].sort());
  });

  it("a creator the identity service could not name is unknown, never a stale name", () => {
    const v = buildMeetingView(input({ people: new Map() }), NOW);
    expect(v.creator).toEqual({ id: "creator", name: null, status: "unknown" });
  });

  it("a deactivated creator shows as deleted with no name (AC-5.10)", () => {
    const v = buildMeetingView(input({ people: new Map([["creator", { id: "creator", name: null, status: "deleted" as const }]]) }), NOW);
    expect(v.creator).toEqual({ id: "creator", name: null, status: "deleted" });
  });

  it("failure and stage only mean something in their status", () => {
    const failed = buildMeetingView(input({ meeting: record({ status: "failed", failureCode: "audio_unreadable", stage: "transcribing" }) }), NOW);
    expect(failed.failure).toEqual({ code: "audio_unreadable" });
    expect(failed.stage).toBeNull();
    const processing = buildMeetingView(input({ meeting: record({ status: "processing", stage: "transcribing" }) }), NOW);
    expect(processing.stage).toBe("transcribing");
    expect(processing.failure).toBeNull();
  });

  it("maps consent and participants, naming Operai participants live and externals as typed", () => {
    const v = buildMeetingView(
      input({
        meeting: record({ consentUserId: "consenter", consentAt: at(-1000), consentNoticeVersion: "v1" }),
        participants: [
          { id: "p1", userId: "pat", externalName: null, externalOrganisation: null },
          { id: "p2", userId: null, externalName: "Eve", externalOrganisation: "ACME" },
          { id: "p3", userId: "ghost", externalName: null, externalOrganisation: null },
        ],
      }),
      NOW,
    );
    expect(v.consent).toEqual({ by: { id: "consenter", name: "Name of consenter", status: "active" }, at: at(-1000).toISOString(), noticeVersion: "v1" });
    expect(v.participants).toEqual([
      { id: "p1", kind: "operai", person: { id: "pat", name: "Name of pat", status: "active" } },
      { id: "p2", kind: "external", name: "Eve", organisation: "ACME" },
      { id: "p3", kind: "operai", person: { id: "ghost", name: null, status: "unknown" } },
    ]);
  });

  it("passes the host view through and reports whether visibility is offered", () => {
    const host = { app: "testhost", entityType: "widget", entityId: "w1", state: "open" as const, title: "W1", href: "/testhost/widgets/w1" };
    const v = buildMeetingView(input({ host, hostVisibleOffered: true }), NOW);
    expect(v.host).toEqual(host);
    expect(v.hostVisibleOffered).toBe(true);
  });
});

describe("buildMeetingView: derived status (AC-2.8)", () => {
  const live = { startedAt: at(-600_000), lastChunkAt: null, lastBeatAt: at(-30_000), paused: false, endedAt: null, capturedMs: null };

  it("recording with a fresh beat stays recording, and the view is live", () => {
    const v = buildMeetingView(input({ meeting: record({ status: "recording", durationMs: null }), latestSession: live, storedMs: 45_000 }), NOW);
    expect(v.status).toBe("recording");
    expect(v.recording).toEqual({ live: true, durationMs: 45_000, lostMs: null });
  });

  it("recording silent for 2 minutes reads interrupted, keeps the stored duration, and is no longer live", () => {
    const v = buildMeetingView(
      input({ meeting: record({ status: "recording", durationMs: null }), latestSession: { ...live, lastBeatAt: at(-120_000) }, storedMs: 45_000 }),
      NOW,
    );
    expect(v.status).toBe("interrupted");
    expect(v.recording?.live).toBe(false);
    expect(v.recording?.durationMs).toBe(45_000);
    expect(v.durationMs).toBe(45_000);
  });

  it("a paused session with beats stays recording", () => {
    const v = buildMeetingView(
      input({ meeting: record({ status: "recording", durationMs: null }), latestSession: { ...live, paused: true, startedAt: at(-3 * 3600_000) } }),
      NOW,
    );
    expect(v.status).toBe("recording");
  });
});

describe("buildMeetingView: recording.lostMs is the creator's alone (AC-2.9, G3)", () => {
  const session = { startedAt: at(-600_000), lastChunkAt: at(-10_000), lastBeatAt: at(-5_000), paused: false, endedAt: at(-1000), capturedMs: 100_000 };
  const base = { meeting: record({ status: "processing" }), latestSession: session, storedMs: 70_000, latestSessionStoredMs: 70_000 };

  it("capturedMs minus the latest session's stored durations", () => {
    expect(buildMeetingView(input(base), NOW).recording).toEqual({ live: false, durationMs: 70_000, lostMs: 30_000 });
  });

  it("floors at 0 and is null when the tab never reported", () => {
    expect(buildMeetingView(input({ ...base, latestSessionStoredMs: 120_000 }), NOW).recording?.lostMs).toBe(0);
    expect(buildMeetingView(input({ ...base, latestSession: { ...session, capturedMs: null } }), NOW).recording?.lostMs).toBeNull();
  });

  it("uses the latest session's chunks, not the whole meeting's", () => {
    expect(buildMeetingView(input({ ...base, storedMs: 500_000, latestSessionStoredMs: 70_000 }), NOW).recording?.lostMs).toBe(30_000);
  });

  it("a participant or host reader never sees it, even when it is positive", () => {
    for (const role of ["participant", "host_reader"] as const) {
      expect(buildMeetingView(input({ ...base, role }), NOW).recording).toEqual({ live: false, durationMs: 70_000, lostMs: null });
    }
  });
});

describe("buildMeetingView: audio (AC-4.4)", () => {
  it("kept until audioCreatedAt + 29 d, as an ISO instant", () => {
    const v = buildMeetingView(input({ meeting: record({ audioCreatedAt: at(-DAY) }) }), NOW);
    expect(v.audio).toEqual({ state: "kept", until: at(28 * DAY).toISOString() });
  });

  it("deleted at the boundary and after; none without audio", () => {
    expect(buildMeetingView(input({ meeting: record({ audioCreatedAt: at(-29 * DAY + 1) }) }), NOW).audio.state).toBe("kept");
    expect(buildMeetingView(input({ meeting: record({ audioCreatedAt: at(-29 * DAY) }) }), NOW).audio).toEqual({ state: "deleted" });
    expect(buildMeetingView(input({ meeting: record({ audioCreatedAt: null }) }), NOW).audio).toEqual({ state: "none" });
  });

  it("a frozen meeting's audio still expires on schedule (AC-5.12)", () => {
    const v = buildMeetingView(input({ frozen: true, meeting: record({ audioCreatedAt: at(-30 * DAY) }) }), NOW);
    expect(v.audio).toEqual({ state: "deleted" });
  });
});

describe("buildMeetingView: hostNotice is the creator's (AC-14.8)", () => {
  it("shown to the creator, hidden from everyone else", () => {
    const failed = { event: "linked" as const };
    expect(buildMeetingView(input({ failedHostNotice: failed }), NOW).hostNotice).toEqual({ state: "failed", event: "linked" });
    expect(buildMeetingView(input({ failedHostNotice: failed, role: "participant" }), NOW).hostNotice).toBeNull();
    expect(buildMeetingView(input({ failedHostNotice: failed, role: "host_reader" }), NOW).hostNotice).toBeNull();
  });
});

describe("can: the truth table (AC-5.8, AC-5.11, AC-10.6, G1)", () => {
  const creatorEverything = { ...allFalse, edit: true, manageParticipants: true, link: true, editTranscript: true, deleteAudio: true, deleteMeeting: true, summarise: true, ask: true, changeLanguage: false };

  it("a ready, processed meeting: the creator holding access can do everything that applies", () => {
    expect(can()).toEqual(creatorEverything);
  });

  it("a participant holding access can summarise and ask, and nothing else (AC-5.8)", () => {
    expect(can({ role: "participant" })).toEqual({ ...allFalse, summarise: true, ask: true });
    expect(can({ role: "host_reader" })).toEqual({ ...allFalse, summarise: true, ask: true });
  });

  it("a participant without meetings:access can only read (US-10)", () => {
    const caller = { holdsAccess: false, holdsErase: false, capabilities: "resolved" as const };
    expect(can({ role: "participant", caller })).toEqual(allFalse);
  });

  it("a creator who lost meetings:access keeps only deleting the meeting and its recording (A4)", () => {
    const caller = { holdsAccess: false, holdsErase: false, capabilities: "resolved" as const };
    expect(can({ caller })).toEqual({ ...allFalse, deleteAudio: true, deleteMeeting: true });
  });

  it("auth unreachable (capabilities unavailable) withholds capability controls but keeps the delete path (AC-10.6)", () => {
    const caller = { holdsAccess: false, holdsErase: false, capabilities: "unavailable" as const };
    const v = buildMeetingView(input({ caller }), NOW);
    expect(v.capabilities).toBe("unavailable");
    expect(v.can).toEqual({ ...allFalse, deleteAudio: true, deleteMeeting: true });
  });

  it("a frozen meeting: no creator control for anyone, summarise and ask stay (AC-5.11)", () => {
    expect(can({ frozen: true })).toEqual({ ...allFalse, summarise: true, ask: true });
  });

  it("a frozen meeting can still be deleted by a meeting:erase holder, and only by one (AC-5.12)", () => {
    const eraser = { holdsAccess: true, holdsErase: true, capabilities: "resolved" as const };
    expect(can({ frozen: true, caller: eraser, role: "participant" }).deleteMeeting).toBe(true);
    expect(can({ frozen: true, caller: eraser, role: "participant" })).toEqual({ ...allFalse, summarise: true, ask: true, deleteMeeting: true });
  });

  it("an erase holder who is only a participant gets no creator control, just the delete path (AC-4.8)", () => {
    const eraser = { holdsAccess: true, holdsErase: true, capabilities: "resolved" as const };
    expect(can({ caller: eraser, role: "participant" })).toEqual({ ...allFalse, summarise: true, ask: true, deleteMeeting: true });
  });

  it("an unknown frozen state (identity outage) fails closed on creator controls", () => {
    const v = buildMeetingView(input({ frozen: null }), NOW);
    expect(v.frozen).toBeNull();
    expect(v.can).toEqual({ ...allFalse, summarise: true, ask: true });
  });

  it("summarise and ask need a ready meeting with speech", () => {
    for (const status of ["draft", "recording", "processing", "failed"] as const) {
      const c = can({ meeting: record({ status }) });
      expect([status, c.summarise, c.ask]).toEqual([status, false, false]);
    }
    const none = can({ meeting: record({ noSpeech: true }) });
    expect([none.summarise, none.ask, none.editTranscript]).toEqual([false, false, false]);
  });

  describe("G1: changeSource and changeLanguage", () => {
    const draft = (over: Partial<MeetingRecord> = {}) => record({ status: "draft", audioCreatedAt: null, durationMs: null, processingStartedAt: null, ...over });

    it("changeSource: a draft with no audio, chunk or text", () => {
      expect(can({ meeting: draft(), hasContent: false }).changeSource).toBe(true);
    });

    it("changeSource: consent alone does not lock it", () => {
      const meeting = draft({ consentUserId: "creator", consentAt: at(-1), consentNoticeVersion: "v1" });
      expect(can({ meeting, hasContent: false }).changeSource).toBe(true);
    });

    it("changeSource: locked by audio, a chunk or text, and by any non-draft status", () => {
      expect(can({ meeting: draft(), hasContent: true }).changeSource).toBe(false);
      expect(can({ meeting: draft({ status: "recording" }), hasContent: false }).changeSource).toBe(false);
      expect(can({ meeting: draft({ status: "ready" }), hasContent: false }).changeSource).toBe(false);
    });

    it("changeSource: a creator control, so not for others, frozen, or without access", () => {
      const meeting = draft();
      expect(can({ meeting, hasContent: false, role: "participant" }).changeSource).toBe(false);
      expect(can({ meeting, hasContent: false, frozen: true }).changeSource).toBe(false);
      expect(can({ meeting, hasContent: false, caller: { holdsAccess: false, holdsErase: false, capabilities: "resolved" } }).changeSource).toBe(false);
    });

    it("changeLanguage: until processing starts (AC-1.8), whatever the status", () => {
      expect(can({ meeting: draft() }).changeLanguage).toBe(true);
      expect(can({ meeting: draft({ status: "recording" }) }).changeLanguage).toBe(true);
      expect(can({ meeting: draft({ processingStartedAt: at(-1) }) }).changeLanguage).toBe(false);
      expect(can({ meeting: draft(), frozen: true }).changeLanguage).toBe(false);
      expect(can({ meeting: draft(), role: "participant" }).changeLanguage).toBe(false);
    });
  });

  describe("per-status controls", () => {
    const m = (status: MeetingRecord["status"], over: Partial<MeetingRecord> = {}) => record({ status, ...over });

    it("capture: a creator control while draft, recording or interrupted", () => {
      expect(can({ meeting: m("draft") }).capture).toBe(true);
      expect(can({ meeting: m("recording") , latestSession: { startedAt: at(-1000), lastChunkAt: null, lastBeatAt: at(-1000), paused: false, endedAt: null, capturedMs: null } }).capture).toBe(true);
      // silent recording = interrupted
      expect(can({ meeting: m("recording") }).capture).toBe(true);
      expect(can({ meeting: m("processing") }).capture).toBe(false);
      expect(can({ meeting: m("ready") }).capture).toBe(false);
    });

    it("retryProcessing: failed with retained audio", () => {
      expect(can({ meeting: m("failed") }).retryProcessing).toBe(true);
      expect(can({ meeting: m("failed", { audioCreatedAt: at(-30 * DAY) }) }).retryProcessing).toBe(false);
      expect(can({ meeting: m("failed", { audioCreatedAt: null }), retry: { audioKey: null, oldestSourceAt: null } }).retryProcessing).toBe(false);
      expect(can({ meeting: m("ready") }).retryProcessing).toBe(false);
    });

    // AC-6.9: after a prepare_audio failure audio.ogg never existed, only the sources were kept.
    it("retryProcessing: failed with only retained sources, until 29 days after the oldest one", () => {
      const sourcesOnly = (ageMs: number, over: Partial<MeetingRecord> = {}) =>
        can({ meeting: m("failed", { audioCreatedAt: null, ...over }), retry: { audioKey: null, oldestSourceAt: at(-ageMs) } }).retryProcessing;
      expect(sourcesOnly(DAY)).toBe(true);
      expect(sourcesOnly(29 * DAY - 1000)).toBe(true);
      expect(sourcesOnly(29 * DAY)).toBe(false);
      expect(sourcesOnly(DAY, { audioDeletedAt: at(-1000) })).toBe(false);
    });

    it("deleteAudio: only while audio is kept and the meeting is not mid-recording or mid-processing", () => {
      expect(can({ meeting: m("ready") }).deleteAudio).toBe(true);
      expect(can({ meeting: m("ready", { audioCreatedAt: at(-30 * DAY) }) }).deleteAudio).toBe(false);
      expect(can({ meeting: m("ready", { audioCreatedAt: null }) }).deleteAudio).toBe(false);
      expect(can({ meeting: m("processing") }).deleteAudio).toBe(false);
    });

    it("retryHostNotice: only when a notice failed", () => {
      expect(can({ failedHostNotice: { event: "changed" } }).retryHostNotice).toBe(true);
      expect(can({ failedHostNotice: null }).retryHostNotice).toBe(false);
      expect(can({ failedHostNotice: { event: "changed" }, frozen: true }).retryHostNotice).toBe(false);
    });

    it("setVisibility: a creator control on a meeting whose host offers it", () => {
      const host = { app: "testhost", entityType: "widget", entityId: "w1", state: "open" as const, title: "W1", href: "/x" };
      const meeting = m("ready", { hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" });
      expect(can({ meeting, host, hostVisibleOffered: true }).setVisibility).toBe(true);
      expect(can({ meeting, host, hostVisibleOffered: false }).setVisibility).toBe(false);
      expect(can({ hostVisibleOffered: true }).setVisibility).toBe(false); // standalone
    });
  });
});

// ─── loadMeetingView: the database, identities and the host ──────────────────

describe("loadMeetingView", () => {
  const fake = startFakeHost();
  afterAll(() => fake.stop());
  const hostRegistry = { get: (a: string, t: string) => fake.definitions.find((d) => d.app === a && d.entityType === t) };

  let creatorStatus: "active" | "deleted" | "outage";
  const requireIdentities: NonNullable<VisibilityDeps["requireIdentities"]> = async (_a, ids) => {
    if (creatorStatus === "outage") throw new ProblemError({ status: 503, code: "identity_unavailable", detail: "down" });
    return new Map<string, Identity>(ids.map((id) => [id, { id, name: creatorStatus === "active" ? `N ${id}` : null, status: creatorStatus === "active" ? "active" : "deleted" }]));
  };
  const deps = { registry: hostRegistry, requireIdentities, resolveIdentities: async (_a: string, ids: readonly string[]) => new Map<string, Identity>(ids.map((id) => [id, { id, name: `N ${id}`, status: "active" as const }])) };

  const bearer = (sub: string) => `Bearer h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;
  const caller = (userId: string, over: Partial<ViewCaller> = {}): ViewCaller => ({
    userId,
    authorization: bearer(userId),
    holdsAccess: true,
    holdsErase: false,
    capabilities: "resolved",
    ...over,
  });

  const ids: string[] = [];
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    fake.reset();
    creatorStatus = "active";
    fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1", hostVisible: true });
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    warnSpy.mockRestore();
    await db.hostNotice.deleteMany({ where: { meetingId: { in: ids } } });
    await db.meeting.deleteMany({ where: { id: { in: ids.splice(0) } } });
  });

  async function seed(over: Record<string, unknown> = {}) {
    const row = await db.meeting.create({
      data: {
        title: "Seeded",
        format: "online",
        startsAt: at(-3600_000),
        language: "en",
        source: "recorded",
        creatorUserId: "creator",
        ...over,
      } as never,
    });
    ids.push(row.id);
    return row.id;
  }

  it("builds the creator's view of a draft, with content flags from the database", async () => {
    const id = await seed();
    const v = await loadMeetingView(id, caller("creator"), NOW, deps);
    expect(v.role).toBe("creator");
    expect(v.status).toBe("draft");
    expect(v.frozen).toBe(false);
    expect(v.can.changeSource).toBe(true);
    expect(v.creator).toEqual({ id: "creator", name: "N creator", status: "active" });

    await db.recordingSession.create({ data: { meetingId: id, lastBeatAt: NOW } });
    await db.meeting.update({ where: { id }, data: { status: "recording" } });
    const rec = await loadMeetingView(id, caller("creator"), at(1000), deps);
    expect(rec.status).toBe("recording");
    expect(rec.recording?.live).toBe(true);
  });

  it("a stored chunk locks the source, and unconfirmed chunks do not count as stored duration", async () => {
    const id = await seed();
    const session = await db.recordingSession.create({ data: { meetingId: id, lastBeatAt: NOW, capturedMs: 30_000, endedAt: NOW } });
    await db.recordingChunk.createMany({
      data: [
        { meetingId: id, seq: 0, sessionId: session.id, objectKey: "k0", sizeBytes: 1, durationMs: 10_000, storedAt: NOW },
        { meetingId: id, seq: 1, sessionId: session.id, objectKey: "k1", sizeBytes: 1, durationMs: 10_000, storedAt: null },
      ],
    });
    const v = await loadMeetingView(id, caller("creator"), NOW, deps);
    expect(v.can.changeSource).toBe(false);
    expect(v.recording).toEqual({ live: false, durationMs: 10_000, lostMs: 20_000 });
  });

  it("text on the meeting locks the source", async () => {
    const id = await seed({ source: "text" });
    await db.transcriptSegment.create({ data: { meetingId: id, ordinal: 0, text: "hello" } });
    expect((await loadMeetingView(id, caller("creator"), NOW, deps)).can.changeSource).toBe(false);
  });

  it("is frozen from the creator's live identity, null on an outage, and back on reactivation", async () => {
    const id = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    creatorStatus = "deleted";
    expect((await loadMeetingView(id, caller("pat"), NOW, deps)).frozen).toBe(true);
    creatorStatus = "outage";
    expect((await loadMeetingView(id, caller("pat"), NOW, deps)).frozen).toBeNull();
    creatorStatus = "active";
    expect((await loadMeetingView(id, caller("pat"), NOW, deps)).frozen).toBe(false);
  });

  it("a not-visible meeting is the identical 404", async () => {
    const id = await seed();
    const err = (await loadMeetingView(id, caller("outsider"), NOW, deps).then(() => null, (e: unknown) => e)) as ProblemError;
    expect(err.status).toBe(404);
  });

  it("resolves the host label as the caller, and fails soft to unavailable", async () => {
    const id = await seed({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1", hostVisible: true });
    const open = await loadMeetingView(id, caller("creator"), NOW, deps);
    expect(open.host).toEqual({ app: "testhost", entityType: "widget", entityId: "w1", state: "open", title: "Widget one", href: "/testhost/widgets/w1" });
    expect(open.hostVisible).toBe(true);
    expect(open.hostVisibleOffered).toBe(true);
    expect(open.can.setVisibility).toBe(true);

    fake.mode.resolve = { status: 503 };
    const down = await loadMeetingView(id, caller("creator"), NOW, deps);
    expect(down.host).toEqual({ app: "testhost", entityType: "widget", entityId: "w1", state: "unavailable", title: null, href: null });
  });

  it("a closed host entity reads closed with no title (the link survives, the label does not leak)", async () => {
    fake.setEntity("widget", "w1", { title: "Secret", href: "/x", state: "closed" });
    const id = await seed({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" });
    const v = await loadMeetingView(id, caller("creator"), NOW, deps);
    expect(v.host).toEqual({ app: "testhost", entityType: "widget", entityId: "w1", state: "closed", title: null, href: null });
  });

  it("surfaces a failed manual host notice to the creator only", async () => {
    const id = await seed({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1", participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    await db.hostNotice.create({
      data: { hostApp: "testhost", entityType: "widget", entityId: "w1", meetingId: id, seq: 1, event: "linked", title: "t", creatorUserId: "creator", policy: "manual", state: "failed" },
    });
    await db.hostNotice.create({
      data: { hostApp: "testhost", entityType: "widget", entityId: "w1", meetingId: id, seq: 2, event: "unlinked", creatorUserId: "creator", policy: "until_delivered", state: "failed" },
    });
    expect((await loadMeetingView(id, caller("creator"), NOW, deps)).hostNotice).toEqual({ state: "failed", event: "linked" });
    expect((await loadMeetingView(id, caller("pat"), NOW, deps)).hostNotice).toBeNull();
  });

  it("counts summaries", async () => {
    const id = await seed();
    await db.summary.create({
      data: { meetingId: id, authorUserId: "creator", template: {}, language: "en", status: "ready", attemptId: "a", transcriptVersion: 0 },
    });
    expect((await loadMeetingView(id, caller("creator"), NOW, deps)).summaryCount).toBe(1);
  });
});
