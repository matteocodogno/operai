/**
 * The figures of `GET /time-entries/summary` (specs/20261112-project-hours T9; AC-1.1, AC-1.2, AC-1.8, AC-2.1, AC-2.2, AC-4.1, AC-4.2, AC-4.3; plan § API contracts
 * "hours-api — `GET /time-entries/summary`", § Who may see what), through the ASSEMBLED app, against the real database and the fake owners of T11.
 *
 * A reader of a project or a deal gets what was recorded on it by EVERYONE — the entries on the record itself plus those on the meetings linked to
 * it now, whoever recorded them: the total, the total inside a window, and the hours per work type, the hours without a work type forming one group
 * of their own. Who may see the per-person part and what the answer never carries are ./people.test.ts and ./answer.test.ts; who may read at all is
 * ./record.test.ts; the query's own rules are ./query.test.ts.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, SEED, bearerOf, call, makeDealEntry, makeMeetingEntry, makeProjectEntry, makeWorkType, resetWorld, type PersonaName } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import { __resetOversightCacheForTests } from "../oversight/oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const CAROL = PERSONAS.carol.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** `GET /time-entries/summary?<query>` as `as`, the query exactly as written. */
const summary = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries/summary?${query}`, { as });

const DEVELOPMENT = SEED.workTypes.project.development;
const ANALYSIS = SEED.workTypes.project.analysis;

const keyed = (key: string, label: string, minutes: number, retired = false) => ({ kind: "keyed", key, label, minutes, retired });

describe("a reader of a project gets its total and its hours per work type (AC-1.8, AC-2.1, AC-4.3)", () => {
  it("is the entries of EVERYONE on the project, the total, no window, and per work type with the hours without one in a group of their own", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    await makeProjectEntry("p1", { userId: ALICE, day: "2026-11-02", minutes: 120, workTypeId: DEVELOPMENT });
    await makeProjectEntry("p1", { userId: BOB, day: "2026-11-03", minutes: 240, workTypeId: DEVELOPMENT });
    await makeProjectEntry("p1", { userId: CAROL, day: "2026-11-04", minutes: 60, workTypeId: ANALYSIS });
    await makeProjectEntry("p1", { userId: BOB, day: "2026-11-05", minutes: 90 });

    const res = await summary("projectId=p1");

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      on: { type: "project", id: "p1" },
      totalMinutes: 120 + 240 + 60 + 90,
      windowMinutes: null,
      // The most hours first, then by name; the group of what has no work type last.
      byWorkType: [keyed(DEVELOPMENT, "Development", 360), keyed(ANALYSIS, "Analysis", 60), { kind: "none", minutes: 90 }],
      // Alice is a reader, not the project's manager: no per-person figure.
      byPerson: null,
      unavailable: [],
    });
  });

  it("answers the same figures to any reader: who asks changes what is shown of the people, never the hours", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    await makeProjectEntry("p1", { userId: BOB, minutes: 120, workTypeId: DEVELOPMENT });

    const asAlice = await summary("projectId=p1", "alice");
    const asCarol = await summary("projectId=p1", "carol");
    const asBob = await summary("projectId=p1", "bob");

    for (const res of [asAlice, asCarol, asBob]) {
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ totalMinutes: 120, byWorkType: [keyed(DEVELOPMENT, "Development", 120)] });
    }
  });

  it("is an empty record: nothing recorded is a total of 0 and no group, not an error", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });

    const res = await summary("projectId=p1");

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ on: { type: "project", id: "p1" }, totalMinutes: 0, windowMinutes: null, byWorkType: [], byPerson: null, unavailable: [] });
  });

  it("reads a project that is closed or cancelled as any other: hours are recorded on it in any state (A12)", async () => {
    hosts.projects.setProject("p1", { label: "Alpha", writable: false });
    await makeProjectEntry("p1", { minutes: 60 });

    expect((await summary("projectId=p1")).json).toMatchObject({ totalMinutes: 60 });
  });

  it("counts a record's hours within its kind: an entry on a deal is not a project's, even when the ids are the same text, nor the reverse (A50)", async () => {
    hosts.projects.setProject("same", { label: "A project" });
    hosts.crm.setDeal("same", { label: "A deal" });
    await makeProjectEntry("same", { minutes: 60 });
    await makeDealEntry("same", { minutes: 90 });
    await makeProjectEntry("other", { minutes: 120 });

    expect((await summary("projectId=same")).json).toMatchObject({ on: { type: "project", id: "same" }, totalMinutes: 60 });
    expect((await summary("dealId=same")).json).toMatchObject({ on: { type: "deal", id: "same" }, totalMinutes: 90 });
  });

  it("orders the work types by hours, then by name as an English collator reads it, then by key; the hours without one come last whatever they total; a retired type is shown", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    const zulu = await makeWorkType("project", "Zulu");
    const alpha = await makeWorkType("project", "alpha");
    const bravo = await makeWorkType("project", "Bravo", { retired: true });
    await makeProjectEntry("p1", { minutes: 60, workTypeId: zulu.id });
    await makeProjectEntry("p1", { minutes: 60, workTypeId: alpha.id });
    await makeProjectEntry("p1", { minutes: 60, workTypeId: bravo.id });
    await makeProjectEntry("p1", { minutes: 30, workTypeId: DEVELOPMENT });
    await makeProjectEntry("p1", { minutes: 480 });

    const { byWorkType } = (await summary("projectId=p1")).json;

    expect(byWorkType).toEqual([
      keyed(alpha.id, "alpha", 60),
      keyed(bravo.id, "Bravo", 60, true),
      keyed(zulu.id, "Zulu", 60),
      keyed(DEVELOPMENT, "Development", 30),
      { kind: "none", minutes: 480 },
    ]);
  });

  it("adds the work types up to the total, in every shape of record", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relinkProject("m1", "p1");
    await makeProjectEntry("p1", { minutes: 90, workTypeId: ANALYSIS });
    await makeProjectEntry("p1", { minutes: 30 });
    await makeMeetingEntry("m1", { userId: BOB, minutes: 120 });

    const { totalMinutes, byWorkType } = (await summary("projectId=p1")).json;

    expect(totalMinutes).toBe(240);
    expect(byWorkType.reduce((sum: number, group: { minutes: number }) => sum + group.minutes, 0)).toBe(totalMinutes);
  });
});

describe("the window counts the days it names and no others (AC-1.1, AC-1.2)", () => {
  /** A yearly package starting 1 January 2026: its first period is 2026, its second 2027. One entry a period boundary away from the next. */
  async function fixture() {
    hosts.projects.setProject("p1", { label: "Alpha" });
    await makeProjectEntry("p1", { day: "2025-12-31", minutes: 30 });
    await makeProjectEntry("p1", { day: "2026-01-01", minutes: 60 });
    await makeProjectEntry("p1", { day: "2026-06-15", minutes: 90 });
    await makeProjectEntry("p1", { day: "2026-12-31", minutes: 120 });
    await makeProjectEntry("p1", { day: "2027-01-01", minutes: 240 });
  }

  it("counts only the days in the window, both ends included, and the total stays all time", async () => {
    await fixture();

    const res = await summary("projectId=p1&windowFrom=2026-01-01&windowTo=2026-12-31");

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ totalMinutes: 30 + 60 + 90 + 120 + 240, windowMinutes: 60 + 90 + 120 });
  });

  it("compares each period on its own: the second period does not carry the first one's entries (AC-1.2)", async () => {
    await fixture();

    expect((await summary("projectId=p1&windowFrom=2027-01-01&windowTo=2027-12-31")).json).toMatchObject({ windowMinutes: 240 });
    expect((await summary("projectId=p1&windowFrom=2026-01-01&windowTo=2026-12-31")).json).toMatchObject({ windowMinutes: 270 });
  });

  it("is a window of one day, and a window with no entry in it is 0, never null: null is no window", async () => {
    await fixture();

    expect((await summary("projectId=p1&windowFrom=2026-06-15&windowTo=2026-06-15")).json.windowMinutes).toBe(90);
    expect((await summary("projectId=p1&windowFrom=2026-06-16&windowTo=2026-06-30")).json.windowMinutes).toBe(0);
    expect((await summary("projectId=p1")).json.windowMinutes).toBeNull();
  });

  it("has no span cap: a window of the whole of the time there is is a window", async () => {
    await fixture();

    expect((await summary("projectId=p1&windowFrom=2000-01-01&windowTo=2099-12-31")).json.windowMinutes).toBe(30 + 60 + 90 + 120 + 240);
  });

  it("changes the window's figure only: the work types are of the total, whatever the window (they add up to totalMinutes)", async () => {
    await fixture();

    const whole = (await summary("projectId=p1")).json;
    const windowed = (await summary("projectId=p1&windowFrom=2026-01-01&windowTo=2026-12-31")).json;

    expect(windowed.byWorkType).toEqual(whole.byWorkType);
    expect(windowed.totalMinutes).toBe(whole.totalMinutes);
  });

  it("counts the entries on the meetings linked to the project in the window too (AC-4.3)", async () => {
    await fixture();
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relinkProject("m1", "p1");
    await makeMeetingEntry("m1", { userId: BOB, day: "2026-06-16", minutes: 150 });
    await makeMeetingEntry("m1", { userId: BOB, day: "2027-03-01", minutes: 60 });

    const res = await summary("projectId=p1&windowFrom=2026-01-01&windowTo=2026-12-31");

    expect(res.json).toMatchObject({ windowMinutes: 60 + 90 + 120 + 150, totalMinutes: 30 + 60 + 90 + 120 + 240 + 150 + 60 });
  });
});

describe("the hours of the meetings linked to the record count for it, whoever recorded them (AC-4.1, AC-4.2, AC-4.3, AC-2.2)", () => {
  it("counts an entry on a linked meeting by someone who is on no team of the project, in the total and as hours without a work type (AC-4.1, AC-4.3)", async () => {
    hosts.projects.setProject("p1", { label: "Alpha", assignees: [ALICE] });
    hosts.meetings.add({ id: "m1", creator: BOB, participants: [CAROL] });
    hosts.meetings.relinkProject("m1", "p1");
    await makeProjectEntry("p1", { userId: ALICE, minutes: 120, workTypeId: DEVELOPMENT });
    await makeMeetingEntry("m1", { userId: BOB, minutes: 60 });
    await makeMeetingEntry("m1", { userId: CAROL, minutes: 30 });

    expect((await summary("projectId=p1")).json).toMatchObject({
      totalMinutes: 210,
      byWorkType: [keyed(DEVELOPMENT, "Development", 120), { kind: "none", minutes: 90 }],
    });
  });

  it("counts an automatic entry of a meeting as any other (AC-4.1)", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relinkProject("m1", "p1");
    await makeMeetingEntry("m1", { userId: BOB, minutes: 60, automatic: "untouched" });
    await makeMeetingEntry("m1", { userId: CAROL, minutes: 30 });

    expect((await summary("projectId=p1")).json.totalMinutes).toBe(90);
  });

  it("follows a relink at the next read: nothing about the project is stored on the entry (AC-4.2)", async () => {
    hosts.projects.setProject("pa", { label: "Alpha" });
    hosts.projects.setProject("pb", { label: "Beta" });
    hosts.crm.setDeal("d1", { label: "Deal" });
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relinkProject("m1", "pa");
    await makeProjectEntry("pa", { minutes: 60 });
    await makeMeetingEntry("m1", { userId: BOB, minutes: 120 });
    const total = async (query: string) => (await summary(query)).json.totalMinutes;

    expect([await total("projectId=pa"), await total("projectId=pb"), await total("dealId=d1")]).toEqual([180, 0, 0]);

    hosts.meetings.relinkProject("m1", "pb");
    expect([await total("projectId=pa"), await total("projectId=pb"), await total("dealId=d1")]).toEqual([60, 120, 0]);

    hosts.meetings.relink("m1", "d1");
    expect([await total("projectId=pa"), await total("projectId=pb"), await total("dealId=d1")]).toEqual([60, 0, 120]);

    hosts.meetings.relink("m1", null);
    expect([await total("projectId=pa"), await total("projectId=pb"), await total("dealId=d1")]).toEqual([60, 0, 0]);
  });

  it("counts a deal's hours, the linked meetings' included, per work type (AC-2.2)", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relink("m1", "d1");
    await makeDealEntry("d1", { userId: ALICE, minutes: 90, workTypeId: SEED.workTypes.deal.demo });
    await makeDealEntry("d1", { userId: BOB, minutes: 60, workTypeId: SEED.workTypes.deal.offer });
    await makeDealEntry("d1", { userId: BOB, minutes: 30 });
    await makeMeetingEntry("m1", { userId: CAROL, minutes: 120 });
    // Another deal's entry, and a project's, are not this deal's.
    await makeDealEntry("d2", { minutes: 480 });
    await makeProjectEntry("p1", { minutes: 480 });

    const res = await summary("dealId=d1");

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      on: { type: "deal", id: "d1" },
      totalMinutes: 300,
      windowMinutes: null,
      byWorkType: [
        { kind: "keyed", key: SEED.workTypes.deal.demo, label: "Demo", minutes: 90, retired: false },
        { kind: "keyed", key: SEED.workTypes.deal.offer, label: "Offer", minutes: 60, retired: false },
        { kind: "none", minutes: 150 },
      ],
      // Alice is a reader of the deal, not its owner.
      byPerson: null,
      unavailable: [],
    });
  });

  it("asks meetings-api once for the record's meetings, with hours-api's own credential", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });

    await summary("projectId=p1");

    const asked = hosts.callsTo("meetings.system-hosts");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.query.get("projectId")).toBe("p1");
    expect(asked[0]?.authorization).not.toBe(await bearerOf("alice"));
  });
});
