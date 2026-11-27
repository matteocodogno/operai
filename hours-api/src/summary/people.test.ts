/**
 * Who sees the hours PER PERSON in `GET /time-entries/summary` (specs/20261112-project-hours T9; AC-2.3, AC-2.4, AC-2.5, AC-2.7; plan § Who may see what 2; ADR
 * 20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states), through the ASSEMBLED app,
 * against the real database and the fake owners of T11.
 *
 * The per-person figure is personal data about workers. It is given to the project's manager (`projectManagerId === sub`), the deal's owner (`ownerUserId === sub`)
 * — both facts the record's OWNER states in the answer that proves the caller reads the record, so they cost no further call — and to a holder of
 * `time-entry:read-all`, asked live of `auth` as the caller (refusals remembered 30 s, a grant never). To everyone else it is `null`, and it is `null` for a
 * project that awaits its manager, whose ops-manager is NOT asked about (D79). When `auth` cannot say, the figure is withheld — `null` and `"authz"` in
 * `unavailable` — never shown on a guess, and the totals still show.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, bearerOf, call, makeDealEntry, makeMeetingEntry, makeProjectEntry, resetWorld, type PersonaName } from "../test-support/world";
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
const HOLDER = PERSONAS.holder.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
  // By convention (test-support/world.ts) `holder` holds the permission and nobody else does.
  hosts.auth.grant(HOLDER, "time-entry", "read-all");
});

const summary = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries/summary?${query}`, { as });

const person = (key: string, label: string | null, minutes: number, status = "active") => ({ kind: "keyed", key, label, minutes, status });

/** A project p1 managed by alice with bob (on the team) and carol (in a linked meeting only) having recorded hours: 120 + 60 + 90 minutes. */
async function projectFixture(manager: string | null = ALICE) {
  hosts.projects.setProject("p1", { label: "Alpha", projectManagerId: manager, assignees: [ALICE, BOB] });
  hosts.meetings.add({ id: "m1", creator: CAROL });
  hosts.meetings.relinkProject("m1", "p1");
  await makeProjectEntry("p1", { userId: BOB, minutes: 120 });
  await makeProjectEntry("p1", { userId: ALICE, minutes: 60 });
  await makeMeetingEntry("m1", { userId: CAROL, minutes: 90 });
}

/** A deal d1 owned by alice, recorded on by bob, and discussed in a linked meeting by carol: 120 + 60 + 90 minutes. */
async function dealFixture(owner = ALICE) {
  hosts.crm.setDeal("d1", { label: "Deal one", ownerUserId: owner, involved: [ALICE, BOB] });
  hosts.meetings.add({ id: "m2", creator: CAROL });
  hosts.meetings.relink("m2", "d1");
  await makeDealEntry("d1", { userId: BOB, minutes: 120 });
  await makeDealEntry("d1", { userId: ALICE, minutes: 60 });
  await makeMeetingEntry("m2", { userId: CAROL, minutes: 90 });
}

describe("the project's manager sees the hours per person (AC-2.3)", () => {
  it("is every person who recorded hours on the project or on a meeting linked to it, by name, with the hours of people outside the team (A49), and asks `auth` nothing about permissions", async () => {
    await projectFixture();

    const res = await summary("projectId=p1", "alice");

    expect(res.status).toBe(200);
    expect(res.json.byPerson).toEqual([person(ALICE, "Name of alice", 60), person(BOB, "Name of bob", 120), person(CAROL, "Name of carol", 90)]);
    expect(res.json.unavailable).toEqual([]);
    // The owner's fact is checked first and costs no call: the manager is not asked about `time-entry:read-all`.
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });

  it("adds the people up to the total, the work types' figure too", async () => {
    await projectFixture();

    const { totalMinutes, byPerson, byWorkType } = (await summary("projectId=p1", "alice")).json;

    expect(totalMinutes).toBe(270);
    expect(byPerson.reduce((sum: number, group: { minutes: number }) => sum + group.minutes, 0)).toBe(totalMinutes);
    expect(byWorkType.reduce((sum: number, group: { minutes: number }) => sum + group.minutes, 0)).toBe(totalMinutes);
  });

  it("is the manager the OWNER names now, never a copy: when the project changes hands, the old manager loses it and the new one has it at the next read", async () => {
    await projectFixture(ALICE);
    expect((await summary("projectId=p1", "alice")).json.byPerson).not.toBeNull();
    expect((await summary("projectId=p1", "bob")).json.byPerson).toBeNull();

    hosts.projects.setProject("p1", { label: "Alpha", projectManagerId: BOB, assignees: [ALICE, BOB] });
    __resetOversightCacheForTests();

    expect((await summary("projectId=p1", "alice")).json.byPerson).toBeNull();
    expect((await summary("projectId=p1", "bob")).json.byPerson).not.toBeNull();
  });

  it("is withheld from a member of the team who is not its manager, from a reader of the project and from the person who recorded the most", async () => {
    await projectFixture(ALICE);

    for (const as of ["bob", "carol"] as const) {
      const res = await summary("projectId=p1", as);
      expect({ as, status: res.status, byPerson: res.json.byPerson }).toEqual({ as, status: 200, byPerson: null });
    }
  });

  it("counts for the manager as a reader of the project only: a manager who may not read it is told 404 and nothing of its people", async () => {
    await projectFixture(ALICE);
    hosts.projects.setReader(ALICE, false);

    const res = await summary("projectId=p1", "alice");

    expect(res.status).toBe(404);
    expect(res.json).not.toHaveProperty("byPerson");
  });

  it("gives the manager the people while `auth` is down: the owner's fact needs no `auth`", async () => {
    await projectFixture(ALICE);
    hosts.fail("auth.resolve", { status: 500 });

    const res = await summary("projectId=p1", "alice");

    expect(res.status).toBe(200);
    expect(res.json.byPerson).toHaveLength(3);
    expect(res.json.unavailable).toEqual([]);
  });
});

describe("the deal's owner sees the hours per person (AC-2.4)", () => {
  it("is every person who recorded hours on the deal or on a meeting linked to it, by name, and asks `auth` nothing about permissions", async () => {
    await dealFixture();

    const res = await summary("dealId=d1", "alice");

    expect(res.status).toBe(200);
    expect(res.json.byPerson).toEqual([person(ALICE, "Name of alice", 60), person(BOB, "Name of bob", 120), person(CAROL, "Name of carol", 90)]);
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });

  it("is withheld from the technical contact and from every other reader of the deal, the owner named by the CRM alone", async () => {
    await dealFixture(ALICE);

    for (const as of ["bob", "carol"] as const) {
      const res = await summary("dealId=d1", as);
      expect({ as, status: res.status, byPerson: res.json.byPerson }).toEqual({ as, status: 200, byPerson: null });
    }
  });

  it("follows the owner the CRM states now: a reassigned deal shows its people to its new owner and no longer to the old one", async () => {
    await dealFixture(ALICE);
    expect((await summary("dealId=d1", "alice")).json.byPerson).not.toBeNull();

    hosts.crm.setDeal("d1", { label: "Deal one", ownerUserId: BOB, involved: [ALICE, BOB] });
    __resetOversightCacheForTests();

    expect((await summary("dealId=d1", "alice")).json.byPerson).toBeNull();
    expect((await summary("dealId=d1", "bob")).json.byPerson).not.toBeNull();
  });

  it("is never the project manager's role: a caller named `projectManagerId` of a project is not the owner of a deal with the same id", async () => {
    hosts.projects.setProject("same", { label: "Project", projectManagerId: ALICE });
    hosts.crm.setDeal("same", { label: "Deal", ownerUserId: BOB });
    await makeDealEntry("same", { userId: BOB, minutes: 60 });

    expect((await summary("dealId=same", "alice")).json.byPerson).toBeNull();
    expect((await summary("dealId=same", "bob")).json.byPerson).not.toBeNull();
  });
});

describe("a holder of time-entry:read-all sees the hours per person, asked live of `auth` as the caller (AC-2.5)", () => {
  it("is present for a project and for a deal, the holder being neither the manager nor the owner", async () => {
    await projectFixture(ALICE);
    await dealFixture(ALICE);

    const project = await summary("projectId=p1", "holder");
    const deal = await summary("dealId=d1", "holder");

    expect(project.json.byPerson).toHaveLength(3);
    expect(deal.json.byPerson).toHaveLength(3);
  });

  it("asks `auth GET /authz/resolve` AS THE CALLER, with the caller's own token", async () => {
    await projectFixture(ALICE);

    await summary("projectId=p1", "holder");

    const asked = hosts.callsTo("auth.resolve");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(await bearerOf("holder"));
  });

  it("is refused for a reader who does not hold it: `null`, no word that there is anything to see, and the totals as for anyone", async () => {
    await projectFixture(ALICE);

    const res = await summary("projectId=p1", "carol");

    expect(res.status).toBe(200);
    expect(res.json.byPerson).toBeNull();
    expect(res.json.unavailable).toEqual([]);
    expect(res.json.totalMinutes).toBe(270);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);
    // Nobody's name was asked for: the people of a figure that is not shown are not looked up.
    expect(hosts.callsTo("auth.identities")).toEqual([]);
  });

  it("does not take another permission for this one: time-list:manage is not time-entry:read-all", async () => {
    await projectFixture(ALICE);
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");

    expect((await summary("projectId=p1", "manager")).json.byPerson).toBeNull();
  });

  it("never remembers a grant: a holder whose permission is revoked is refused on the very next request", async () => {
    await projectFixture(ALICE);
    expect((await summary("projectId=p1", "holder")).json.byPerson).toHaveLength(3);

    hosts.reset();
    for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
    hosts.projects.setProject("p1", { label: "Alpha", projectManagerId: ALICE, assignees: [ALICE, BOB] });
    // Same token, same `perm_epoch`: nothing was remembered about the grant.

    expect((await summary("projectId=p1", "holder")).json.byPerson).toBeNull();
  });

  it("asks `auth` again for a caller it refused only after 30 s: a refusal is remembered, a grant is not", async () => {
    await projectFixture(ALICE);

    await summary("projectId=p1", "carol");
    await summary("projectId=p1", "carol");
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);

    await summary("projectId=p1", "holder");
    await summary("projectId=p1", "holder");
    expect(hosts.callsTo("auth.resolve")).toHaveLength(3);
  });
});

describe("a project that awaits its manager shows its people to holders only (AC-2.7, D79)", () => {
  it("is `null` for everyone but a holder: the purchase order's ops-manager, a team member, the creator of a meeting", async () => {
    await projectFixture(null);

    for (const as of ["alice", "bob", "carol"] as const) {
      const res = await summary("projectId=p1", as);
      expect({ as, status: res.status, byPerson: res.json.byPerson }).toEqual({ as, status: 200, byPerson: null });
    }
    expect((await summary("projectId=p1", "holder")).json.byPerson).toHaveLength(3);
  });

  it("asks nothing about the project's ops-manager: the one call about the project is the resolve that proves the caller reads it", async () => {
    await projectFixture(null);

    await summary("projectId=p1", "alice");

    expect(hosts.callsTo("projects.resolve")).toHaveLength(1);
    expect(hosts.calls.map((recorded) => recorded.host).filter((host) => host === "projects")).toEqual(["projects"]);
  });

  it("is never a grant to nobody-in-particular: a caller whose id is not a manager's does not become one because the manager is null", async () => {
    await projectFixture(null);
    hosts.fail("auth.resolve", { status: 500 });

    const res = await summary("projectId=p1", "alice");

    expect(res.status).toBe(200);
    expect(res.json.byPerson).toBeNull();
    expect(res.json.unavailable).toEqual(["authz"]);
  });
});

describe("an owner that predates the fact states no role, and that is never a grant (plan § Deploy order)", () => {
  it("is `null` for everyone but a holder when projects-api states no `projectManagerId` at all, even for the person who is the manager", async () => {
    await projectFixture(ALICE);
    hosts.projects.legacyManager = true;

    expect((await summary("projectId=p1", "alice")).json.byPerson).toBeNull();
    expect((await summary("projectId=p1", "holder")).json.byPerson).toHaveLength(3);
  });

  it("is `null` for everyone but a holder when crm-api states no `ownerUserId` at all", async () => {
    await dealFixture(ALICE);
    hosts.crm.legacyOwner = true;

    expect((await summary("dealId=d1", "alice")).json.byPerson).toBeNull();
    expect((await summary("dealId=d1", "holder")).json.byPerson).toHaveLength(3);
  });
});

describe("`auth` not saying whether the caller holds time-entry:read-all withholds the people and never guesses (AC-2.5, fail closed)", () => {
  const OUTAGES: ReadonlyArray<readonly [string, () => void]> = [
    ["answering 500", () => hosts.fail("auth.resolve", { status: 500 })],
    ["answering 401", () => hosts.fail("auth.resolve", { status: 401 })],
    ["a body that is not the route's shape", () => hosts.fail("auth.resolve", { malformed: true })],
    ["slower than 2 s", () => hosts.fail("auth.resolve", { delayMs: 2_600 })],
  ];

  it.each(OUTAGES)("is `byPerson: null` with `authz` in `unavailable`, and every other figure still shown: %s", async (_what, breakIt) => {
    await projectFixture(ALICE);
    breakIt();

    // The holder is asked, and `auth` cannot say: not even a holder's people are shown on a guess.
    const res = await summary("projectId=p1", "holder");

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ totalMinutes: 270, byPerson: null, unavailable: ["authz"] });
    expect(res.json.byWorkType.length).toBeGreaterThan(0);
    expect(res.json).toHaveProperty("windowMinutes");
  });

  it("is not remembered: the holder is shown the people as soon as `auth` answers again", async () => {
    await projectFixture(ALICE);
    hosts.fail("auth.resolve", { status: 500 });
    expect((await summary("projectId=p1", "holder")).json.byPerson).toBeNull();

    hosts.heal("auth.resolve");

    expect((await summary("projectId=p1", "holder")).json.byPerson).toHaveLength(3);
  });

  it("does not turn an unreachable `auth` into a refusal of the record: a 200 whole, the people withheld, while hours-api holds the 5-minute credential it asks meetings-api with", async () => {
    await dealFixture(ALICE);
    // The owner's own answer reads the record and mints the service credential (cached for 5 minutes): the first read needs `auth` for nothing else.
    expect((await summary("dealId=d1", "alice")).status).toBe(200);
    hosts.sever("auth");

    const res = await summary("dealId=d1", "carol");

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ totalMinutes: 270, byPerson: null, unavailable: ["authz"] });
  });

  it("is a 503 when `auth` is down and hours-api holds no credential for meetings-api: the linked meetings cannot be said, so no figure lower than the truth (AC-4.9)", async () => {
    await dealFixture(ALICE);
    hosts.sever("auth");

    const res = await summary("dealId=d1", "carol");

    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "host_unavailable" });
    expect(res.json).not.toHaveProperty("totalMinutes");
  });
});

describe("the people are named as `auth` names them now, as the viewer, and one `auth` cannot name stays counted (AC-2.3, AC-2.4)", () => {
  it("asks `auth POST /authz/users/identities` with the viewer's own token for the people of the figure, once", async () => {
    await projectFixture(ALICE);

    await summary("projectId=p1", "alice");

    const asked = hosts.callsTo("auth.identities");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(await bearerOf("alice"));
    expect([...(asked[0]?.body as { ids: string[] }).ids].sort()).toEqual([ALICE, BOB, CAROL].sort());
  });

  it("orders the people by name as an English collator reads it, a person with no name last, ties by user id", async () => {
    hosts.projects.setProject("p1", { label: "Alpha", projectManagerId: ALICE });
    hosts.auth.setIdentity(ALICE, { name: "zoë" });
    hosts.auth.setIdentity(BOB, { name: "Émile" });
    hosts.auth.setIdentity(CAROL, { name: "alpha" });
    hosts.auth.setIdentity(HOLDER, { name: null });
    for (const userId of [ALICE, BOB, CAROL, HOLDER]) await makeProjectEntry("p1", { userId, minutes: 60 });

    const { byPerson } = (await summary("projectId=p1", "alice")).json;

    expect(byPerson.map((group: { label: string | null }) => group.label)).toEqual(["alpha", "Émile", "zoë", null]);
  });

  it("keeps a person `auth` cannot name in the count, with no name and status unknown, and says `identities`, while the totals are whole", async () => {
    await projectFixture(ALICE);
    hosts.fail("auth.identities", { status: 500 });

    const res = await summary("projectId=p1", "alice");

    expect(res.status).toBe(200);
    expect(res.json.byPerson).toEqual([person(ALICE, null, 60, "unknown"), person(BOB, null, 120, "unknown"), person(CAROL, null, 90, "unknown")]);
    expect(res.json.unavailable).toEqual(["identities"]);
    expect(res.json.totalMinutes).toBe(270);
  });

  it("names a deleted person by no name, and that is not an outage", async () => {
    await projectFixture(ALICE);
    hosts.auth.setIdentity(BOB, { name: null, status: "deleted" });

    const res = await summary("projectId=p1", "alice");

    expect(res.json.byPerson).toContainEqual(person(BOB, null, 120, "deleted"));
    expect(res.json.unavailable).toEqual([]);
  });
});
