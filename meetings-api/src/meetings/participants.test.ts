import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";
import { createNotifier, setNotifierForTests } from "../lib/notify";

// AC-5.1, AC-5.4, AC-5.9, AC-5.10, AC-12.1 (specs/021 T24): the participant list.

const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  for (const user of ["creator", "pat", "quinn", "stranger"]) kit.grant(user, "access");
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const json = async (res: Response) => (await res.json()) as Record<string, any>;
async function seed(over: Record<string, unknown> = {}) {
  return kit.db.meeting.create({
    data: { title: "Budget review", format: "online", startsAt: new Date("2026-11-05T09:00:00.000Z"), language: "en", source: "recorded", creatorUserId: "creator", ...over },
  });
}
const put = (id: string, participants: unknown[], who = "creator") => kit.call(who, "PUT", `/meetings/${id}/participants`, { participants });
const rows = (id: string) => kit.db.meetingParticipant.findMany({ where: { meetingId: id }, orderBy: { createdAt: "asc" } });

describe("PUT /meetings/:id/participants", () => {
  it("replaces the list with Operai users and externals, and answers the meeting (AC-5.1)", async () => {
    const m = await seed();
    const res = await put(m.id, [{ userId: "pat" }, { name: "  Dana Outsider ", organisation: "Acme" }, { name: "Eli" }]);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["participants"]).toEqual([
      { id: expect.any(String), kind: "operai", person: { id: "pat", name: "Name pat", status: "active" } },
      { id: expect.any(String), kind: "external", name: "Dana Outsider", organisation: "Acme" },
      { id: expect.any(String), kind: "external", name: "Eli", organisation: null },
    ]);
    expect((await rows(m.id)).map((r) => r.addedBy)).toEqual(["creator", "creator", "creator"]);

    const cleared = await put(m.id, []);
    expect((await json(cleared))["participants"]).toEqual([]);
    expect(await rows(m.id)).toHaveLength(0);
  });

  it("30 are fine and 31 are 422 too_many_participants, keeping the old list", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    const thirty = Array.from({ length: 30 }, (_, i) => ({ name: `Guest ${i}` }));
    expect((await put(m.id, thirty)).status).toBe(200);
    const res = await put(m.id, [...thirty, { name: "One too many" }]);
    expect(res.status).toBe(422);
    expect((await json(res))["code"]).toBe("too_many_participants");
    expect(await rows(m.id)).toHaveLength(30);
  });

  it("an id that is not an active user is 422 participant_not_active with its index, and nothing changes", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    const res = await put(m.id, [{ userId: "quinn" }, { name: "Ext" }, { userId: "gone-zed" }]);
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: "participant_not_active", index: 2 });
    expect((await rows(m.id)).map((r) => r.userId)).toEqual(["pat"]);
  });

  it("fails closed with 503 when the identity service is down", async () => {
    const m = await seed();
    kit.setIdentitiesDown(true);
    const res = await put(m.id, [{ userId: "pat" }]);
    expect(res.status).toBe(503);
    expect((await json(res))["code"]).toBe("identity_unavailable");
    expect(await rows(m.id)).toHaveLength(0);
    // every creator control checks the creator's own account first (AC-5.11), so even externals wait
    expect((await put(m.id, [{ name: "Ext" }])).status).toBe(503);
    kit.setIdentitiesDown(false);
    expect((await put(m.id, [{ name: "Ext" }])).status).toBe(200);
  });

  const invalid: [string, unknown[], string][] = [
    ["an external with an empty name", [{ name: "  " }], "participants.0.name"],
    ["a name over 100 characters", [{ name: "x".repeat(101) }], "participants.0.name"],
    ["an organisation over 100 characters", [{ name: "Ext", organisation: "o".repeat(101) }], "participants.0.organisation"],
    ["an entry that is both a user and an external", [{ userId: "pat", name: "Pat" }], "participants.0"],
    ["an empty entry", [{}], "participants.0"],
  ];
  for (const [name, list, field] of invalid) {
    it(`422 naming ${field} for ${name}`, async () => {
      const m = await seed();
      const res = await put(m.id, list);
      expect(res.status).toBe(422);
      expect((await json(res))["field"]).toBe(field);
      expect(await rows(m.id)).toHaveLength(0);
    });
  }

  it("a person listed twice is one participant", async () => {
    const m = await seed();
    await put(m.id, [{ userId: "pat" }, { userId: "pat" }]);
    expect(await rows(m.id)).toHaveLength(1);
  });

  it("keeps the rows (and their speaker labels) of the people who stay", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }, { externalName: "Dana", addedBy: "creator" }, { externalName: "Gone", addedBy: "creator" }] } });
    const [pat, dana] = await rows(m.id);
    await kit.db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s1", participantId: pat!.id } });
    await put(m.id, [{ name: "Dana" }, { userId: "pat" }, { userId: "quinn" }]);
    const after = await rows(m.id);
    expect(after.map((r) => r.id)).toContain(pat!.id);
    expect(after.map((r) => r.id)).toContain(dana!.id);
    expect(after).toHaveLength(3);
    expect((await kit.db.speakerLabel.findFirstOrThrow({ where: { meetingId: m.id } })).participantId).toBe(pat!.id);
  });

  it("an added participant opens the meeting at once, a removed one gets 404 next (AC-5.4)", async () => {
    const m = await seed();
    expect((await kit.call("pat", "GET", `/meetings/${m.id}`)).status).toBe(404);
    await put(m.id, [{ userId: "pat" }]);
    const opened = await kit.call("pat", "GET", `/meetings/${m.id}`);
    expect(opened.status).toBe(200);
    expect((await json(opened))["role"]).toBe("participant");
    await put(m.id, [{ userId: "quinn" }]);
    expect((await kit.call("pat", "GET", `/meetings/${m.id}`)).status).toBe(404);
    expect((await kit.call("quinn", "GET", `/meetings/${m.id}`)).status).toBe(200);
  });

  it("is the creator's: 403 creator_only, the identical 404 for a stranger, 403 frozen, 403 without meetings:access", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    const asPat = await put(m.id, [], "pat");
    expect([asPat.status, (await json(asPat))["code"]]).toEqual([403, "creator_only"]);
    expect((await put(m.id, [], "stranger")).status).toBe(404);
    kit.deactivate("creator");
    const frozen = await put(m.id, []);
    expect([frozen.status, (await json(frozen))["code"]]).toEqual([403, "frozen"]);
    kit.reactivate("creator");
    kit.grant("creator");
    const noAccess = await put(m.id, []);
    expect([noAccess.status, (await json(noAccess))["code"]]).toEqual([403, "meetings_access_required"]);
    expect(await rows(m.id)).toHaveLength(1);
  });
});

describe("participant-added notifications (AC-5.9, AC-12.1)", () => {
  it("one event for exactly the newly added Operai users: not the actor, not externals, not people already on the list", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    await put(m.id, [{ userId: "pat" }, { userId: "quinn" }, { userId: "creator" }, { name: "Ext" }]);
    expect(kit.notified).toHaveLength(1);
    expect(kit.notified[0]).toEqual({ kind: "participant_added", meetingId: m.id, meetingTitle: "Budget review", actorId: "creator", recipientIds: ["quinn"] });

    // saving the same list again tells nobody
    kit.notified.length = 0;
    await put(m.id, [{ userId: "pat" }, { userId: "quinn" }, { userId: "creator" }, { name: "Ext" }]);
    expect(kit.notified).toHaveLength(0);
    // a participant who was removed and is added back is new again
    await put(m.id, []);
    await put(m.id, [{ userId: "quinn" }]);
    expect(kit.notified.map((e) => e.recipientIds)).toEqual([["quinn"]]);
  });

  it("is not sent when the change is refused", async () => {
    const m = await seed();
    await put(m.id, [{ userId: "pat" }, { userId: "gone-zed" }]);
    await put(m.id, [{ userId: "pat" }], "stranger");
    expect(kit.notified).toHaveLength(0);
  });

  it("reaches notify-api once per recipient with the link and both languages", async () => {
    const calls: { url: string; body: Record<string, any> }[] = [];
    setNotifierForTests(
      createNotifier({
        baseUrl: "http://notify.test",
        tokens: { async getToken() { return "t"; }, invalidate() {} },
        fetchImpl: (async (url: unknown, init?: RequestInit) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 201 });
        }) as typeof fetch,
      }),
    );
    const m = await seed();
    await put(m.id, [{ userId: "pat" }, { userId: "quinn" }, { name: "Ext" }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.map((c) => c.body["recipientId"]).sort()).toEqual(["pat", "quinn"]);
    expect(calls[0]!.url).toBe("http://notify.test/system/notifications");
    expect(calls[0]!.body).toMatchObject({ originApp: "meetings", link: { href: `/my-meetings/m/${m.id}` } });
    expect(calls[0]!.body["title"]).toContain("Budget review");
    expect(calls[0]!.body["it"].title).toContain("Budget review");
    expect(calls[0]!.body).not.toHaveProperty("email");
    setNotifierForTests({ async notify(event) { kit.notified.push(event); } });
  });
});

describe("a deleted participant (AC-5.10)", () => {
  it("is shown as deleted, never by a stale name", async () => {
    const m = await seed({ participants: { create: [{ userId: "gone-pat", addedBy: "creator" }] } });
    const view = await json(await kit.call("creator", "GET", `/meetings/${m.id}`));
    expect(view["participants"][0].person).toEqual({ id: "gone-pat", name: null, status: "deleted" });
  });
});
