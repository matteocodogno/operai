/**
 * The ids of a record the viewer may not read are withheld from everyone but the entry's author
 * (specs/029 T41; AC-4.10, AC-4.2; ADR-0089 A1; owasp-report.md F1 and § "4. D44 decision").
 *
 * The composition that this closes: a holder of `time-entry:read-all` WITHOUT CRM access listed everyone's
 * entries, got the ids of hidden deals and meetings from the list itself, and fed them back as `dealId` /
 * `meetingId` / `projectId` filters, which expand a deal to the meetings currently linked to it with
 * hours-api's own credential. That told them which hidden meetings are linked to which hidden deal, the
 * disclosure A1 forbids. The filters stay (a caller who already knows an id may use it: F2, accepted); what
 * goes is the list handing out the id of a record the viewer cannot read.
 *
 * Driven through the ASSEMBLED app, against the real database and the fake hosts. `src/entries/view.test.ts`
 * has the same rule one level down, by `viewEntries` and a viewer.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, SEED, call, makeDealEntry, makeMeetingEntry, makeNoEntityEntry, makeProjectEntry, resetWorld, type PersonaName } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "./today";
import { __resetOversightCacheForTests } from "../oversight/oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const CAROL = PERSONAS.carol.sub;
const HOLDER = PERSONAS.holder.sub;
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
  hosts.auth.grant(HOLDER, "time-entry", "read-all");
});

const listAll = (as: PersonaName, extra = "") => call("GET", `/time-entries?${NOVEMBER}&whose=all${extra}`, { as });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entryOf = (res: { json: any }, id: string) => res.json.items.find((item: { id: string }) => item.id === id);

describe("a holder of time-entry:read-all with no CRM and no project access (the review's probe, F1)", () => {
  /** The probe's world: a hidden deal with two hidden meetings linked to it and one linked to nothing, all of other people's. */
  async function theProbeWorld() {
    hosts.crm.setDeal("deal-secret", { label: "Acquisition of ACME", involved: [BOB] });
    hosts.crm.setReader(HOLDER, false);
    hosts.projects.setProject("p-secret", { label: "Apollo", assignees: [BOB] });
    hosts.projects.setReader(HOLDER, false);
    hosts.meetings.add({ id: "mtg-alice", creator: ALICE, dealId: "deal-secret", title: "ACME board call" });
    hosts.meetings.add({ id: "mtg-carol", creator: CAROL, dealId: "deal-secret" });
    hosts.meetings.add({ id: "mtg-other", creator: CAROL, dealId: null });
    return {
      deal: await makeDealEntry("deal-secret", { userId: BOB, day: "2026-11-05", minutes: 120 }),
      project: await makeProjectEntry("p-secret", { userId: BOB, day: "2026-11-05", minutes: 150 }),
      meetingAlice: await makeMeetingEntry("mtg-alice", { userId: ALICE, day: "2026-11-06", minutes: 60 }),
      meetingCarol: await makeMeetingEntry("mtg-carol", { userId: CAROL, day: "2026-11-06", minutes: 90 }),
      meetingOther: await makeMeetingEntry("mtg-other", { userId: CAROL, day: "2026-11-07", minutes: 30 }),
    };
  }

  it("is told the entry is on a hidden deal, project or meeting, and is given no id for it", async () => {
    const entries = await theProbeWorld();

    const res = await listAll("holder");

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(5);
    expect(entryOf(res, entries.deal.id).on).toEqual({ type: "deal", id: null, label: null, href: null, visibility: "hidden" });
    expect(entryOf(res, entries.project.id).on).toEqual({ type: "project", id: null, label: null, href: null, visibility: "hidden" });
    for (const entry of [entries.meetingAlice, entries.meetingCarol, entries.meetingOther]) {
      expect(entryOf(res, entry.id).on).toMatchObject({ type: "meeting", id: null, label: null, href: null, visibility: "hidden" });
    }
  });

  it("still sees that a hidden meeting counts for a hidden deal, and still sees every minute: only the ids are gone", async () => {
    const entries = await theProbeWorld();

    const res = await listAll("holder");

    // `on.deal` is unchanged (plan § Views, review I3): a link is shown, never the deal it points at.
    expect(entryOf(res, entries.meetingAlice.id).on.deal).toEqual({ state: "linked", visibility: "hidden" });
    expect(entryOf(res, entries.meetingCarol.id).on.deal).toEqual({ state: "linked", visibility: "hidden" });
    expect(entryOf(res, entries.meetingOther.id).on.deal).toEqual({ state: "none" });
    expect(res.json.items.map((item: { minutes: number }) => item.minutes).sort((a: number, b: number) => a - b)).toEqual([30, 60, 90, 120, 150]);
  });

  it("is handed no hidden id anywhere in the answer, so there is nothing to feed back as a dealId, meetingId or projectId filter", async () => {
    await theProbeWorld();

    const res = await listAll("holder");

    // The whole body, not just `on.id`: an id of a hidden record must not travel under any other member either.
    for (const hidden of ["deal-secret", "p-secret", "mtg-alice", "mtg-carol", "mtg-other"]) {
      expect({ hidden, leaked: res.text.includes(hidden) }).toEqual({ hidden, leaked: false });
    }
    // The names stay hidden too (AC-4.10), as before.
    for (const name of ["Acquisition of ACME", "Apollo", "ACME board call"]) expect(res.text).not.toContain(name);
  });

  it("is handed none either by the list narrowed to one person", async () => {
    await theProbeWorld();

    const res = await listAll("holder", `&userId=${CAROL}`);

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(2);
    expect(res.text).not.toContain("mtg-carol");
    expect(res.text).not.toContain("mtg-other");
    expect(res.text).not.toContain("deal-secret");
  });
});

describe("an entry that is the viewer's own keeps its ids, whatever the viewer may read (owasp-report.md § 4)", () => {
  it("lists them to a holder that lists everyone's entries: their own hidden deal, project and meeting keep the id, another person's on the same records do not", async () => {
    hosts.crm.setDeal("deal-secret", { label: "Acquisition of ACME", involved: [BOB] });
    hosts.crm.setReader(HOLDER, false);
    hosts.projects.setProject("p-secret", { label: "Apollo", assignees: [BOB] });
    hosts.projects.setReader(HOLDER, false);
    hosts.meetings.add({ id: "mtg-1", creator: BOB, dealId: "deal-secret" });
    const mine = {
      deal: await makeDealEntry("deal-secret", { userId: HOLDER, day: "2026-11-05" }),
      project: await makeProjectEntry("p-secret", { userId: HOLDER, day: "2026-11-05" }),
      meeting: await makeMeetingEntry("mtg-1", { userId: HOLDER, day: "2026-11-05" }),
    };
    const theirs = {
      deal: await makeDealEntry("deal-secret", { userId: BOB, day: "2026-11-06" }),
      project: await makeProjectEntry("p-secret", { userId: BOB, day: "2026-11-06" }),
      meeting: await makeMeetingEntry("mtg-1", { userId: BOB, day: "2026-11-06" }),
    };

    const res = await listAll("holder");

    expect(res.status).toBe(200);
    expect(entryOf(res, mine.deal.id).on).toMatchObject({ type: "deal", id: "deal-secret", visibility: "hidden", label: null });
    expect(entryOf(res, mine.project.id).on).toMatchObject({ type: "project", id: "p-secret", visibility: "hidden", label: null });
    expect(entryOf(res, mine.meeting.id).on).toMatchObject({ type: "meeting", id: "mtg-1", visibility: "hidden", label: null });
    expect(entryOf(res, theirs.deal.id).on).toMatchObject({ type: "deal", id: null });
    expect(entryOf(res, theirs.project.id).on).toMatchObject({ type: "project", id: null });
    expect(entryOf(res, theirs.meeting.id).on).toMatchObject({ type: "meeting", id: null });
  });
});

describe("an entity the viewer may read keeps its id for everyone (owasp-report.md § 4)", () => {
  it("shows a visible deal, project and meeting with their ids on another person's entries, and the deal a visible meeting counts for", async () => {
    hosts.crm.setDeal("deal-1", { label: "Acquisition of ACME", involved: [BOB] });
    hosts.projects.setProject("p-1", { label: "Apollo", assignees: [BOB] });
    // The holder takes part in the meeting, so it is on the list of the meetings they read.
    hosts.meetings.add({ id: "mtg-1", creator: BOB, participants: [HOLDER], dealId: "deal-1", title: "Kick-off" });
    const deal = await makeDealEntry("deal-1", { userId: BOB, day: "2026-11-05" });
    const project = await makeProjectEntry("p-1", { userId: BOB, day: "2026-11-05" });
    const meeting = await makeMeetingEntry("mtg-1", { userId: BOB, day: "2026-11-05" });

    const res = await listAll("holder");

    expect(entryOf(res, deal.id).on).toMatchObject({ type: "deal", id: "deal-1", label: "Acquisition of ACME", visibility: "visible" });
    expect(entryOf(res, project.id).on).toMatchObject({ type: "project", id: "p-1", label: "Apollo", visibility: "visible" });
    expect(entryOf(res, meeting.id).on).toMatchObject({
      type: "meeting",
      id: "mtg-1",
      label: "Kick-off",
      visibility: "visible",
      deal: { state: "linked", visibility: "visible", id: "deal-1", label: "Acquisition of ACME" },
    });
  });
});

describe("an entry with an activity pointer", () => {
  it("withholds the activity id from another person while the project is hidden from them, and keeps it for the author", async () => {
    hosts.projects.setProject("p-secret", { label: "Apollo", assignees: [BOB] });
    hosts.projects.setReader(HOLDER, false);
    hosts.activities.add({ id: "t-secret", subject: "Rotate the keys", project: "p-secret" });
    const theirs = await makeProjectEntry("p-secret", { userId: BOB, day: "2026-11-05", activityId: "t-secret" });
    const mine = await makeProjectEntry("p-secret", { userId: HOLDER, day: "2026-11-06", activityId: "t-secret" });

    const res = await listAll("holder");

    expect(entryOf(res, theirs.id).activity).toEqual({ id: null, subject: null, visibility: "hidden" });
    expect(entryOf(res, mine.id).activity).toEqual({ id: "t-secret", subject: null, visibility: "hidden" });
    expect(entryOf(res, theirs.id).on.id).toBeNull();
    expect(res.text.match(/t-secret/g)).toHaveLength(1);
  });

  it("keeps the activity id on another person's entry when the viewer may read the project and the activity", async () => {
    hosts.projects.setProject("p-1", { label: "Apollo", assignees: [BOB] });
    hosts.activities.add({ id: "t-1", subject: "Build the importer", project: "p-1" });
    const theirs = await makeProjectEntry("p-1", { userId: BOB, day: "2026-11-05", activityId: "t-1" });

    const res = await listAll("holder");

    expect(entryOf(res, theirs.id).activity).toEqual({ id: "t-1", subject: "Build the importer", visibility: "visible" });
  });
});

describe("a source that did not answer", () => {
  it("withholds the id of another person's entry on a project or deal whose owner is down, and keeps the author's own", async () => {
    hosts.projects.setProject("p-1", { label: "Apollo", assignees: [BOB] });
    hosts.crm.setDeal("deal-1", { label: "Acquisition of ACME", involved: [BOB] });
    const theirsProject = await makeProjectEntry("p-1", { userId: BOB, day: "2026-11-05" });
    const theirsDeal = await makeDealEntry("deal-1", { userId: BOB, day: "2026-11-05" });
    const mineProject = await makeProjectEntry("p-1", { userId: HOLDER, day: "2026-11-06" });
    const mineDeal = await makeDealEntry("deal-1", { userId: HOLDER, day: "2026-11-06" });
    hosts.fail("projects.resolve", { status: 500 });
    hosts.fail("crm.resolve", { status: 500 });

    const res = await listAll("holder");

    expect(res.status).toBe(200);
    expect(res.json.unavailable).toEqual(["projects", "crm"]);
    expect(entryOf(res, theirsProject.id).on).toEqual({ type: "project", id: null, label: null, href: null, visibility: "unavailable" });
    expect(entryOf(res, theirsDeal.id).on).toEqual({ type: "deal", id: null, label: null, href: null, visibility: "unavailable" });
    expect(entryOf(res, mineProject.id).on).toEqual({ type: "project", id: "p-1", label: null, href: null, visibility: "unavailable" });
    expect(entryOf(res, mineDeal.id).on).toEqual({ type: "deal", id: "deal-1", label: null, href: null, visibility: "unavailable" });
  });

  it("withholds the id of another person's entry on a meeting whose title meetings-api could not give, and keeps the author's own", async () => {
    hosts.meetings.add({ id: "mtg-1", creator: BOB, participants: [HOLDER], dealId: null });
    const theirs = await makeMeetingEntry("mtg-1", { userId: BOB, day: "2026-11-05" });
    const mine = await makeMeetingEntry("mtg-1", { userId: HOLDER, day: "2026-11-06" });
    hosts.fail("meetings.list", { status: 500 });

    const res = await listAll("holder");

    expect(res.json.unavailable).toEqual(["meetings"]);
    expect(entryOf(res, theirs.id).on).toMatchObject({ type: "meeting", id: null, label: null, href: null, visibility: "unavailable" });
    expect(entryOf(res, mine.id).on).toMatchObject({ type: "meeting", id: "mtg-1", label: null, href: null, visibility: "unavailable" });
  });

  it("withholds another person's activity id when activities-api did not answer, even though the project did and is readable", async () => {
    hosts.projects.setProject("p-1", { label: "Apollo", assignees: [BOB] });
    const theirs = await makeProjectEntry("p-1", { userId: BOB, day: "2026-11-05", activityId: "t-1" });
    const mine = await makeProjectEntry("p-1", { userId: HOLDER, day: "2026-11-06", activityId: "t-1" });
    hosts.fail("activities.list", { status: 500 });

    const res = await listAll("holder");

    expect(res.json.unavailable).toEqual(["activities"]);
    expect(entryOf(res, theirs.id).on).toMatchObject({ id: "p-1", visibility: "visible" });
    expect(entryOf(res, theirs.id).activity).toEqual({ id: null, subject: null, visibility: "unavailable" });
    expect(entryOf(res, mine.id).activity).toEqual({ id: "t-1", subject: null, visibility: "unavailable" });
  });
});

describe("the author's own POST and PATCH answers keep the ids of what they booked (owasp-report.md § 4)", () => {
  it("POST: an entry just recorded on a project whose owner cannot be read back for the label still names the project", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    // The bookability question (the first call) is answered; reading the label back afterwards (the second) is not.
    hosts.fail("projects.resolve", { status: 500, after: 1 });

    const res = await call("POST", "/time-entries", { as: "alice", body: { day: "2026-11-12", minutes: 60, on: { type: "project", id: "p1" } } });

    expect(hosts.callsTo("projects.resolve")).toHaveLength(2);
    expect(res.status).toBe(201);
    expect(res.json.on).toEqual({ type: "project", id: "p1", label: null, href: null, visibility: "unavailable" });
  });

  it("PATCH: an entry whose project and activity are hidden from its author still names both, and another viewer is given neither", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setReader(ALICE, false);
    hosts.projects.setReader(HOLDER, false);
    hosts.activities.add({ id: "t-1", subject: "Rotate the keys", project: "p1" });
    const entry = await makeProjectEntry("p1", { userId: ALICE, day: "2026-11-12", activityId: "t-1" });

    const changed = await call("PATCH", `/time-entries/${entry.id}`, { as: "alice", body: { note: "Rotated" } });
    const read = await listAll("holder");

    expect(changed.status).toBe(200);
    expect(changed.json.on).toMatchObject({ type: "project", id: "p1", visibility: "hidden" });
    expect(changed.json.activity).toEqual({ id: "t-1", subject: null, visibility: "hidden" });
    expect(entryOf(read, entry.id).on).toMatchObject({ type: "project", id: null, visibility: "hidden" });
    expect(entryOf(read, entry.id).activity).toEqual({ id: null, subject: null, visibility: "hidden" });
  });
});

describe("what is not a record's id is untouched", () => {
  it("keeps the category of an entry on no entity, for another person's too: the list is hours-api's own", async () => {
    const theirs = await makeNoEntityEntry(SEED.categories.training, { userId: BOB, day: "2026-11-05" });

    const res = await listAll("holder");

    expect(entryOf(res, theirs.id).on).toEqual({ type: "none", category: { id: SEED.categories.training, name: "Training", retired: false } });
    expect(entryOf(res, theirs.id).person.id).toBe(BOB);
  });
});
