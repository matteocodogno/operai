import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";

// AC-1.1 to AC-1.6, AC-1.8, AC-2.3, AC-3.5, AC-11.6 (specs/021 T19): create, get and patch
// a meeting's metadata, language and source, through the real app and Postgres.

const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  kit.grant("creator", "access");
  kit.grant("pat", "access");
  kit.grant("stranger", "access");
  kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1" });
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const base = { title: "Budget review", format: "online", language: "en", source: "recorded" } as const;
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const count = () => kit.db.meeting.count();

async function seed(over: Record<string, unknown> = {}) {
  return kit.db.meeting.create({
    data: {
      title: "Seeded",
      format: "online",
      startsAt: new Date("2026-11-05T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      creatorUserId: "creator",
      ...over,
    } as never,
  });
}

describe("POST /meetings", () => {
  it("creates a standalone draft meeting for the caller (AC-1.2) and defaults the date-time to now (AC-1.3)", async () => {
    const before = Date.now();
    const res = await kit.call("creator", "POST", "/meetings", base);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({
      title: "Budget review",
      format: "online",
      language: "en",
      source: "recorded",
      status: "draft",
      role: "creator",
      host: null,
      hostVisible: false,
      consent: null,
      participants: [],
      creator: { id: "creator", status: "active" },
      can: { edit: true, changeSource: true, changeLanguage: true },
    });
    const startsAt = new Date(body["startsAt"]).getTime();
    expect(startsAt).toBeGreaterThanOrEqual(before - 1000);
    expect(startsAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await count()).toBe(1);
    expect(kit.fake.notices).toHaveLength(0);
    expect(kit.fake.resolves).toHaveLength(0);
  });

  it("accepts a date-time in the past and trims the title", async () => {
    const res = await kit.call("creator", "POST", "/meetings", { ...base, title: "  Past  ", startsAt: "2020-01-02T10:00:00.000Z" });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ title: "Past", startsAt: "2020-01-02T10:00:00.000Z" });
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["an empty title", { title: "   " }, "title"],
    ["a title over 200 characters", { title: "x".repeat(201) }, "title"],
    ["a missing title", { title: undefined }, "title"],
    ["an unknown format", { format: "hybrid" }, "format"],
    ["an unknown language", { language: "fr" }, "language"],
    ["an unknown source", { source: "video" }, "source"],
    ["a date-time that is not one", { startsAt: "tomorrow" }, "startsAt"],
    ["a host reference without an id", { host: { app: "testhost", entityType: "widget", entityId: "" } }, "host.entityId"],
  ];
  for (const [name, patch, field] of invalid) {
    it(`422 naming the field for ${name}, and nothing is created`, async () => {
      const res = await kit.call("creator", "POST", "/meetings", { ...base, ...patch });
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body["field"]).toBe(field);
      expect(body["errors"].map((e: { field: string }) => e.field)).toContain(field);
      expect(await count()).toBe(0);
    });
  }

  it("names every invalid field at once", async () => {
    const res = await kit.call("creator", "POST", "/meetings", { title: "", format: "x", language: "it", source: "recorded" });
    expect(res.status).toBe(422);
    const fields = (await json(res))["errors"].map((e: { field: string }) => e.field).sort();
    expect(fields).toEqual(["format", "title"]);
  });

  it("is 403 without meetings:access (AC-1.4), 401 without a token, and 503 when auth is down", async () => {
    kit.grant("nobody");
    const forbidden = await kit.call("nobody", "POST", "/meetings", base);
    expect(forbidden.status).toBe(403);
    expect((await kit.call(null, "POST", "/meetings", base)).status).toBe(401);
    kit.setAuthDown(true);
    expect((await kit.call("creator", "POST", "/meetings", base)).status).toBe(503);
    expect(await count()).toBe(0);
  });

  describe("with a host reference", () => {
    const widget = { app: "testhost", entityType: "widget", entityId: "w1" };

    it("resolves the entity AS THE CALLER, links it, and sends one linked notice (AC-1.1, AC-11.8)", async () => {
      const res = await kit.call("creator", "POST", "/meetings", { ...base, title: "Widget kick-off", host: widget });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body["host"]).toEqual({ ...widget, state: "open", title: "Widget one", href: "/testhost/widgets/w1" });
      expect(body["hostNotice"]).toBeNull();
      expect(body["hostVisibleOffered"]).toBe(true);

      const creatorToken = `Bearer ${await kit.tokenFor("creator")}`;
      expect(kit.fake.resolves[0]).toMatchObject({ authorization: creatorToken, body: { entityType: "widget", ids: ["w1"] } });
      expect(kit.fake.notices).toHaveLength(1);
      expect(kit.fake.notices[0]!.body).toMatchObject({
        event: "linked",
        meeting: { id: body["id"], title: "Widget kick-off", creatorId: "creator" },
        entity: { type: "widget", id: "w1" },
      });
      expect(await kit.db.hostNotice.count()).toBe(0);
    });

    it("a notice that fails does not undo the create: 201, hostNotice failed, no retry job (AC-11.9, AC-14.8)", async () => {
      kit.fake.mode.notices = { status: 500 };
      const res = await kit.call("creator", "POST", "/meetings", { ...base, host: widget });
      expect(res.status).toBe(201);
      expect((await json(res))["hostNotice"]).toEqual({ state: "failed", event: "linked" });
      expect(await count()).toBe(1);
      expect(await kit.db.meetingJob.count()).toBe(0);
    });

    it("a closed and a missing entity are refused with byte-identical answers, nothing created (AC-1.5)", async () => {
      kit.fake.setEntity("widget", "closed1", { title: "Secret", href: "/x", state: "closed" });
      const closed = await kit.call("creator", "POST", "/meetings", { ...base, host: { ...widget, entityId: "closed1" } });
      const missing = await kit.call("creator", "POST", "/meetings", { ...base, host: { ...widget, entityId: "nope" } });
      expect(closed.status).toBe(422);
      expect(missing.status).toBe(422);
      const [a, b] = [await closed.text(), await missing.text()];
      expect(a).toBe(b);
      expect(JSON.parse(a)).toMatchObject({ code: "host_entity_not_found" });
      expect(await count()).toBe(0);
      expect(kit.fake.notices).toHaveLength(0);
    });

    it("an entity this caller cannot open is closed FOR THEM: the host's per-caller answer decides", async () => {
      kit.fake.setEntity("widget", "w2", { title: "Others", href: "/x", stateFor: { creator: "closed" } });
      const res = await kit.call("creator", "POST", "/meetings", { ...base, host: { ...widget, entityId: "w2" } });
      expect(res.status).toBe(422);
      expect((await json(res))["code"]).toBe("host_entity_not_found");
      const ok = await kit.call("pat", "POST", "/meetings", { ...base, host: { ...widget, entityId: "w2" } });
      expect(ok.status).toBe(201);
    });

    it("an unregistered app or entity type is 422 host_not_registered (AC-1.6)", async () => {
      for (const host of [{ app: "nohost", entityType: "widget", entityId: "w1" }, { app: "testhost", entityType: "gizmo", entityId: "w1" }]) {
        const res = await kit.call("creator", "POST", "/meetings", { ...base, host });
        expect(res.status).toBe(422);
        expect((await json(res))["code"]).toBe("host_not_registered");
      }
      expect(await count()).toBe(0);
      expect(kit.fake.resolves).toHaveLength(0);
    });

    it("a host that cannot answer is 503 host_unavailable and never allowed unverified, while standalone still works (AC-11.6)", async () => {
      kit.fake.mode.resolve = { status: 503 };
      const res = await kit.call("creator", "POST", "/meetings", { ...base, host: widget });
      expect(res.status).toBe(503);
      expect((await json(res))["code"]).toBe("host_unavailable");
      expect(await count()).toBe(0);
      const standalone = await kit.call("creator", "POST", "/meetings", base);
      expect(standalone.status).toBe(201);
    });

    it("a host that takes no notices gets none (AC-11.4)", async () => {
      kit.fake.setEntity("gadget", "g1", { title: "Gadget", href: "/g/g1" });
      const res = await kit.call("creator", "POST", "/meetings", { ...base, host: { app: "quiethost", entityType: "gadget", entityId: "g1" } });
      expect(res.status).toBe(201);
      expect(kit.fake.notices).toHaveLength(0);
      expect(kit.fake.quietNoticeAttempts).toHaveLength(0);
      expect((await json(res))["hostVisibleOffered"]).toBe(false);
    });
  });
});

describe("GET /meetings/:id", () => {
  it("returns the meeting to its creator and to a participant, with their role", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    expect(await json(await kit.call("creator", "GET", `/meetings/${m.id}`))).toMatchObject({ id: m.id, role: "creator" });
    const asPat = await kit.call("pat", "GET", `/meetings/${m.id}`);
    expect(asPat.status).toBe(200);
    expect(await json(asPat)).toMatchObject({ id: m.id, role: "participant", can: { edit: false, deleteMeeting: false } });
  });

  it("answers a stranger exactly as it answers an id that does not exist (AC-5.3)", async () => {
    const m = await seed();
    const hidden = await kit.call("stranger", "GET", `/meetings/${m.id}`);
    const missing = await kit.call("stranger", "GET", `/meetings/${m.id.slice(0, -1)}x`);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe((await missing.text()).replace(`${m.id.slice(0, -1)}x`, m.id));
  });

  it("is 401 without a token, and still readable by the creator while auth is down (AC-10.6)", async () => {
    const m = await seed();
    expect((await kit.call(null, "GET", `/meetings/${m.id}`)).status).toBe(401);
    kit.setAuthDown(true);
    const res = await kit.call("creator", "GET", `/meetings/${m.id}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ capabilities: "unavailable", can: { edit: false } });
  });
});

describe("PATCH /meetings/:id: metadata", () => {
  it("changes title, date-time and format, and answers the meeting", async () => {
    const m = await seed();
    const res = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { title: "  New title ", startsAt: "2026-12-01T08:30:00.000Z", format: "in_person" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ title: "New title", startsAt: "2026-12-01T08:30:00.000Z", format: "in_person" });
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ title: "New title", format: "in_person" });
  });

  it("names an invalid field with 422 and changes nothing; an empty body changes nothing", async () => {
    const m = await seed();
    const bad = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { title: "", format: "nope" });
    expect(bad.status).toBe(422);
    expect((await json(bad))["errors"].map((e: { field: string }) => e.field).sort()).toEqual(["format", "title"]);
    expect((await kit.call("creator", "PATCH", `/meetings/${m.id}`, {})).status).toBe(200);
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).title).toBe("Seeded");
  });

  it("is the creator's alone: 403 creator_only for a participant, the identical 404 for a stranger (AC-1.8)", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    const asPat = await kit.call("pat", "PATCH", `/meetings/${m.id}`, { title: "Mine now" });
    expect(asPat.status).toBe(403);
    expect((await json(asPat))["code"]).toBe("creator_only");
    expect((await kit.call("stranger", "PATCH", `/meetings/${m.id}`, { title: "x" })).status).toBe(404);
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).title).toBe("Seeded");
  });

  it("is 403 frozen when the creator's account is deactivated, and works again once reactivated (AC-5.11, AC-5.13)", async () => {
    const m = await seed();
    kit.deactivate("creator");
    const frozen = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { title: "x" });
    expect(frozen.status).toBe(403);
    expect((await json(frozen))["code"]).toBe("frozen");
    kit.reactivate("creator");
    expect((await kit.call("creator", "PATCH", `/meetings/${m.id}`, { title: "x" })).status).toBe(200);
  });

  it("is 403 meetings_access_required for a creator who lost the capability, 503 when auth is down (AC-5.8)", async () => {
    const m = await seed();
    kit.grant("creator");
    const res = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { title: "x" });
    expect(res.status).toBe(403);
    expect((await json(res))["code"]).toBe("meetings_access_required");
    kit.setAuthDown(true);
    expect((await kit.call("creator", "PATCH", `/meetings/${m.id}`, { title: "x" })).status).toBe(503);
  });
});

describe("PATCH /meetings/:id: language and source", () => {
  it("changes the language until processing has started, then 409 language_locked (AC-1.8)", async () => {
    const m = await seed();
    expect(await json(await kit.call("creator", "PATCH", `/meetings/${m.id}`, { language: "it" }))).toMatchObject({ language: "it" });

    await kit.db.meeting.update({ where: { id: m.id }, data: { processingStartedAt: new Date() } });
    const locked = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { language: "en" });
    expect(locked.status).toBe(409);
    expect((await json(locked))["code"]).toBe("language_locked");
    // saying the language it already has is not a change
    expect((await kit.call("creator", "PATCH", `/meetings/${m.id}`, { language: "it", title: "Renamed" })).status).toBe(200);
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).language).toBe("it");
  });

  it("changes the source of an empty draft, whatever consent was given (G1, AC-2.3)", async () => {
    const m = await seed({ consentUserId: "creator", consentAt: new Date("2026-11-05T09:00:00.000Z"), consentNoticeVersion: "2026-11-01" });
    const res = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { source: "uploaded" });
    expect(res.status).toBe(200);
    // recorded -> uploaded keeps the attestation: consent alone does not lock
    expect(await json(res)).toMatchObject({ source: "uploaded", consent: { by: { id: "creator" }, noticeVersion: "2026-11-01" } });
  });

  it("switching to text clears the consent attestation (G1, AC-3.5)", async () => {
    const m = await seed({ consentUserId: "creator", consentAt: new Date(), consentNoticeVersion: "2026-11-01" });
    const res = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { source: "text" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ source: "text", consent: null });
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ consentUserId: null, consentAt: null, consentNoticeVersion: null });
    // ...and back: nothing to restore
    expect(await json(await kit.call("creator", "PATCH", `/meetings/${m.id}`, { source: "recorded" }))).toMatchObject({ source: "recorded", consent: null });
  });

  async function chunked(meetingId: string) {
    const session = await kit.db.recordingSession.create({ data: { meetingId } });
    await kit.db.recordingChunk.create({ data: { meetingId, seq: 0, sessionId: session.id, objectKey: `meetings/${meetingId}/chunks/000000`, sizeBytes: 10, durationMs: 1000 } });
  }
  const locks: [string, (id: string) => Promise<unknown>][] = [
    ["a chunk", chunked],
    ["stored audio", (id) => kit.db.meeting.update({ where: { id }, data: { audioKey: `meetings/${id}/audio.ogg`, audioCreatedAt: new Date() } })],
    ["text", (id) => kit.db.transcriptSegment.create({ data: { meetingId: id, ordinal: 0, text: "hello" } })],
    ["a status beyond draft", (id) => kit.db.meeting.update({ where: { id }, data: { status: "processing" } })],
  ];
  for (const [name, arrange] of locks) {
    it(`409 source_locked once ${name} exists, and the source stays`, async () => {
      const m = await seed();
      await arrange(m.id);
      const res = await kit.call("creator", "PATCH", `/meetings/${m.id}`, { source: "uploaded" });
      expect(res.status).toBe(409);
      expect((await json(res))["code"]).toBe("source_locked");
      expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).source).toBe("recorded");
      // the same source is not a change
      expect((await kit.call("creator", "PATCH", `/meetings/${m.id}`, { source: "recorded" })).status).toBe(200);
    });
  }

  it("the view's can flags agree with what the server enforces", async () => {
    const m = await seed();
    await chunked(m.id);
    const view = await json(await kit.call("creator", "GET", `/meetings/${m.id}`));
    expect(view["can"].changeSource).toBe(false);
  });
});
