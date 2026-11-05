import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";

// AC-1.7, AC-5.5, AC-5.6, AC-5.7, AC-11.8, AC-14.5, AC-14.7 (specs/021 T22): linking,
// relinking and unlinking a meeting, host-visible, and the notices each change sends.

const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  for (const user of ["creator", "pat", "oldReader", "newReader"]) kit.grant(user, "access");
  kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1", stateFor: { newReader: "closed" } });
  kit.fake.setEntity("widget", "w2", { title: "Widget two", href: "/testhost/widgets/w2", stateFor: { oldReader: "closed" } });
  kit.fake.setEntity("gadget", "g1", { title: "Gadget", href: "/q/g1" });
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const json = async (res: Response) => (await res.json()) as Record<string, any>;
const W1 = { app: "testhost", entityType: "widget", entityId: "w1" };
const W2 = { app: "testhost", entityType: "widget", entityId: "w2" };
const G1 = { app: "quiethost", entityType: "gadget", entityId: "g1" };
const STARTS = new Date("2026-11-05T09:00:00.000Z");

async function seed(over: Record<string, unknown> = {}) {
  return kit.db.meeting.create({
    data: { title: "Budget review", format: "online", startsAt: STARTS, language: "en", source: "recorded", creatorUserId: "creator", ...over },
  });
}
const linkedToW1 = { hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" };
const patch = (id: string, body: Record<string, unknown>, who = "creator") => kit.call(who, "PATCH", `/meetings/${id}`, body);
/** The notices the fake host received, reduced to what the AC names. */
const seen = () =>
  kit.fake.notices.map((n) => {
    const b = n.body as { event: string; seq: number; meeting: { title: string | null; startsAt: string | null }; entity: { id: string } };
    return { event: b.event, entity: b.entity.id, title: b.meeting.title, startsAt: b.meeting.startsAt, seq: b.seq };
  });

describe("linking, relinking and unlinking", () => {
  it("links a standalone meeting: verified as the creator, one linked notice carrying title and date-time (AC-11.8)", async () => {
    const m = await seed();
    const res = await patch(m.id, { host: W1 });
    expect(res.status).toBe(200);
    expect((await json(res))["host"]).toEqual({ ...W1, state: "open", title: "Widget one", href: "/testhost/widgets/w1" });
    expect(kit.fake.resolves[0]!.authorization).toBe(`Bearer ${await kit.tokenFor("creator")}`);
    expect(seen()).toEqual([{ event: "linked", entity: "w1", title: "Budget review", startsAt: "2026-11-05T09:00:00.000Z", seq: 1 }]);
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" });
  });

  it("relinking tells the old entity unlinked (no title, no date) and the new one linked (AC-1.7, AC-14.7)", async () => {
    const m = await seed(linkedToW1);
    const res = await patch(m.id, { host: W2 });
    expect(res.status).toBe(200);
    expect(seen()).toEqual([
      { event: "unlinked", entity: "w1", title: null, startsAt: null, seq: 1 },
      { event: "linked", entity: "w2", title: "Budget review", startsAt: "2026-11-05T09:00:00.000Z", seq: 2 },
    ]);
  });

  it("unlinking tells the old entity unlinked and leaves the meeting standalone (AC-14.7)", async () => {
    const m = await seed({ ...linkedToW1, hostVisible: true });
    const res = await patch(m.id, { host: null });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ host: null, hostVisible: false, hostVisibleOffered: false });
    expect(seen()).toEqual([{ event: "unlinked", entity: "w1", title: null, startsAt: null, seq: 1 }]);
    // the unlinked notice is an until-delivered one, delivered, so nothing is left behind
    expect(await kit.db.hostNotice.count()).toBe(0);
    expect(await kit.db.meetingJob.count()).toBe(0);
  });

  it("a changed title or date-time sends one changed notice; a format-only change sends nothing (AC-14.5)", async () => {
    const m = await seed(linkedToW1);
    await patch(m.id, { title: "Renamed" });
    await patch(m.id, { startsAt: "2026-12-24T10:00:00.000Z" });
    await patch(m.id, { title: "Renamed again", startsAt: "2026-12-25T10:00:00.000Z" });
    await patch(m.id, { format: "in_person" });
    await patch(m.id, { title: "Renamed again" }); // not a change
    expect(seen()).toEqual([
      { event: "changed", entity: "w1", title: "Renamed", startsAt: "2026-11-05T09:00:00.000Z", seq: 1 },
      { event: "changed", entity: "w1", title: "Renamed", startsAt: "2026-12-24T10:00:00.000Z", seq: 2 },
      { event: "changed", entity: "w1", title: "Renamed again", startsAt: "2026-12-25T10:00:00.000Z", seq: 3 },
    ]);
  });

  it("a standalone meeting's edits and a host that takes no notices send nothing (AC-14.11, AC-11.4)", async () => {
    const standalone = await seed();
    await patch(standalone.id, { title: "x" });
    const m = await seed();
    expect((await patch(m.id, { host: G1 })).status).toBe(200);
    await patch(m.id, { title: "y" });
    expect((await patch(m.id, { host: null })).status).toBe(200);
    expect(kit.fake.notices).toHaveLength(0);
    expect(kit.fake.quietNoticeAttempts).toHaveLength(0);
  });

  it("naming the entity it is already on changes nothing and asks nobody", async () => {
    const m = await seed(linkedToW1);
    expect((await patch(m.id, { host: W1 })).status).toBe(200);
    expect(kit.fake.notices).toHaveLength(0);
    expect(kit.fake.resolves.filter((r) => r.body.ids.includes("w1")).length).toBe(1); // only the view's label
  });

  it("a notice that fails does not undo the change: 200 with hostNotice failed (AC-11.9)", async () => {
    const m = await seed();
    kit.fake.mode.notices = { status: 500 };
    const res = await patch(m.id, { host: W1 });
    expect(res.status).toBe(200);
    expect((await json(res))["hostNotice"]).toEqual({ state: "failed", event: "linked" });
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ hostEntityId: "w1" });
  });

  it("an unlinked notice that fails is retried by the runner, not shown as a creator's problem", async () => {
    const m = await seed(linkedToW1);
    kit.fake.mode.notices = { status: 500 };
    const res = await patch(m.id, { host: null });
    expect(res.status).toBe(200);
    expect((await json(res))["hostNotice"]).toBeNull();
    expect(await kit.db.meetingJob.count({ where: { kind: "deliver_host_notice" } })).toBe(1);
  });
});

describe("what a link must satisfy", () => {
  it("refuses a closed or missing target with the same 422, changing nothing and telling nobody (AC-1.5)", async () => {
    const m = await seed(linkedToW1);
    kit.fake.setEntity("widget", "shut", { title: "Secret", href: "/x", state: "closed" });
    const closed = await patch(m.id, { host: { ...W1, entityId: "shut" } });
    const missing = await patch(m.id, { host: { ...W1, entityId: "ghost" } });
    expect(closed.status).toBe(422);
    expect((await closed.text()).replace("shut", "ghost")).toBe(await missing.text());
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ hostEntityId: "w1" });
    expect(kit.fake.notices).toHaveLength(0);
  });

  it("422 host_not_registered, 503 host_unavailable", async () => {
    const m = await seed();
    const unregistered = await patch(m.id, { host: { app: "nohost", entityType: "x", entityId: "1" } });
    expect([unregistered.status, (await json(unregistered))["code"]]).toEqual([422, "host_not_registered"]);
    kit.fake.mode.resolve = { status: 503 };
    const down = await patch(m.id, { host: W1 });
    expect([down.status, (await json(down))["code"]]).toEqual([503, "host_unavailable"]);
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ hostApp: null });
  });

  it("only the creator, and not when frozen (AC-1.8, AC-5.11)", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    const asPat = await patch(m.id, { host: W1 }, "pat");
    expect([asPat.status, (await json(asPat))["code"]]).toEqual([403, "creator_only"]);
    kit.deactivate("creator");
    const frozen = await patch(m.id, { host: W1 });
    expect([frozen.status, (await json(frozen))["code"]]).toEqual([403, "frozen"]);
    expect(kit.fake.notices).toHaveLength(0);
  });
});

describe("host-visible (AC-5.5)", () => {
  it("turns on for a host that offers it, and off again", async () => {
    const m = await seed(linkedToW1);
    expect(await json(await patch(m.id, { hostVisible: true }))).toMatchObject({ hostVisible: true, can: { setVisibility: true } });
    expect(await json(await patch(m.id, { hostVisible: false }))).toMatchObject({ hostVisible: false });
    expect(kit.fake.notices).toHaveLength(0);
  });

  it("422 host_visible_unavailable for a standalone meeting or a host that does not offer it", async () => {
    const standalone = await seed();
    const a = await patch(standalone.id, { hostVisible: true });
    expect([a.status, (await json(a))["code"]]).toEqual([422, "host_visible_unavailable"]);

    const quiet = await seed({ hostApp: "quiethost", hostEntityType: "gadget", hostEntityId: "g1" });
    const b = await patch(quiet.id, { hostVisible: true });
    expect([b.status, (await json(b))["code"]]).toEqual([422, "host_visible_unavailable"]);
    // also in the same request that links it
    const c = await patch(standalone.id, { host: G1, hostVisible: true });
    expect([c.status, (await json(c))["code"]]).toEqual([422, "host_visible_unavailable"]);
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: standalone.id } })).hostApp).toBeNull();
  });

  it("links and turns it on in one request", async () => {
    const m = await seed();
    expect(await json(await patch(m.id, { host: W1, hostVisible: true }))).toMatchObject({ hostVisible: true, host: { entityId: "w1" } });
  });

  it("follows a relink: readers of the old entity get 404 and of the new one 200 on the next request (AC-1.7, AC-5.7)", async () => {
    const m = await seed({ ...linkedToW1, hostVisible: true });
    const open = (who: string) => kit.call(who, "GET", `/meetings/${m.id}`).then((r) => r.status);
    expect([await open("oldReader"), await open("newReader")]).toEqual([200, 404]);

    expect((await patch(m.id, { host: W2 })).status).toBe(200);
    expect([await open("oldReader"), await open("newReader")]).toEqual([404, 200]);
    // unlinking ends it for everyone who only had the host
    expect((await patch(m.id, { host: null })).status).toBe(200);
    expect([await open("oldReader"), await open("newReader")]).toEqual([404, 404]);
  });

  it("relinking to a host that does not offer it switches host-visible off rather than carrying it over", async () => {
    const m = await seed({ ...linkedToW1, hostVisible: true });
    const res = await patch(m.id, { host: G1 });
    expect(await json(res)).toMatchObject({ hostVisible: false, host: { app: "quiethost" } });
  });
});
