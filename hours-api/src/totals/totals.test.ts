/**
 * The totals, `GET /time-entries/totals?groupBy=person|project|deal|category|month|day` (specs/029 T18; AC-1.4, AC-2.6,
 * AC-4.1, AC-4.4, AC-4.5, AC-4.7, AC-4.8, AC-4.10, AC-4.11; plan § Totals, § Views, ADR-0089 amendment A1), through the
 * ASSEMBLED app, against the real database and the fake hosts of T11.
 *
 * Rows are inserted directly (what a route would otherwise have to be driven for). What each owner says is scripted per
 * test; what hours-api asked of them is read back from `hosts.calls`. The request rules (span, dates, ids, `groupBy`,
 * who) are in ./request.test.ts.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PERSONAS,
  SEED,
  bearerOf,
  call,
  db,
  makeCategory,
  makeDealEntry,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  resetWorld,
  type PersonaName,
} from "../test-support/world";
import { claimsOf, startHosts } from "../test-support/hosts";
import { totalsOf } from "./totals";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const TRAINING = SEED.categories.training;

beforeEach(async () => {
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** A period that holds every day these tests use. */
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

/** `GET /time-entries/totals?<query>` as `as`, the query exactly as written. */
const totals = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries/totals?${query}`, { as });

type Group = { kind: string; key?: string; label?: string | null; minutes: number; status?: string; retired?: boolean };
type Answer = { totalMinutes: number; groups: Group[]; unavailable: string[] };

/** The groups of an answer that must be a 200. */
async function groupsOf(query: string, as: PersonaName = "alice"): Promise<Answer> {
  const res = await totals(query, as);
  expect(res.status).toBe(200);
  return res.json as Answer;
}

const keyed = (key: string, label: string | null, minutes: number, extra: Record<string, unknown> = {}) => ({ kind: "keyed" as const, key, label, minutes, ...extra });

/**
 * The routes hours-api asked, in order of arrival, without the mint of its own service credential (a call to a
 * system route is preceded by one, once per token's life, which says nothing about what the read needed).
 */
const asked = () => hosts.calls.map((recorded) => recorded.route).filter((route) => route !== "auth.service-token");

describe("groupBy=day (AC-4.1; plan § Totals, 'Day totals')", () => {
  it("is one group per day with entries, newest first, each the sum of that day's matching entries, with no label and no other service asked", async () => {
    await makeNoEntityEntry(TRAINING, { day: "2026-11-03", minutes: 120 });
    await makeProjectEntry("p1", { day: "2026-11-03", minutes: 90 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-10", minutes: 30 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-05", minutes: 60, userId: BOB });

    const answer = await groupsOf(`groupBy=day&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 240,
      groups: [keyed("2026-11-10", null, 30), keyed("2026-11-03", null, 210)],
      unavailable: [],
    });
    expect(hosts.calls).toEqual([]);
  });
});

describe("groupBy=month (AC-4.5; plan § Totals)", () => {
  it("is one group per calendar month with entries, newest first, keyed `YYYY-MM`, with no label; a month with none is absent, not padded", async () => {
    await makeNoEntityEntry(TRAINING, { day: "2026-09-30", minutes: 30 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-01", minutes: 60 });
    await makeProjectEntry("p1", { day: "2026-11-30", minutes: 90 });
    await makeNoEntityEntry(TRAINING, { day: "2026-12-01", minutes: 120 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-15", minutes: 30, userId: BOB });

    const answer = await groupsOf("groupBy=month&from=2026-09-01&to=2026-12-31");

    expect(answer).toEqual({
      totalMinutes: 300,
      groups: [keyed("2026-12", null, 120), keyed("2026-11", null, 150), keyed("2026-09", null, 30)],
      unavailable: [],
    });
    expect(hosts.calls).toEqual([]);
  });
});

describe("groupBy=person (AC-4.5, AC-4.8; plan § Totals)", () => {
  it("is one group per person, keyed by the user id, named as auth names them NOW, and asks auth and nobody else", async () => {
    await makeNoEntityEntry(TRAINING, { day: "2026-11-02", minutes: 60 });
    await makeProjectEntry("p1", { day: "2026-11-03", minutes: 90 });
    await makeNoEntityEntry(TRAINING, { userId: BOB, minutes: 480 });

    const answer = await groupsOf(`groupBy=person&${NOVEMBER}`);

    expect(answer).toEqual({ totalMinutes: 150, groups: [keyed(ALICE, "Name of alice", 150, { status: "active" })], unavailable: [] });
    expect(hosts.calls.map((recorded) => recorded.route)).toEqual(["auth.identities"]);
  });

  it("shows the new name once auth names the person otherwise: nothing about the name is stored (AC-4.8)", async () => {
    await makeNoEntityEntry(TRAINING, { minutes: 60 });
    expect((await groupsOf(`groupBy=person&${NOVEMBER}`)).groups).toEqual([keyed(ALICE, "Name of alice", 60, { status: "active" })]);

    hosts.auth.setIdentity(ALICE, { name: "Alice Renamed" });

    expect((await groupsOf(`groupBy=person&${NOVEMBER}`)).groups).toEqual([keyed(ALICE, "Alice Renamed", 60, { status: "active" })]);
  });

  it("when auth does not answer, still counts the person: no name, status unknown, `identities` named, the total unchanged (AC-4.7)", async () => {
    await makeNoEntityEntry(TRAINING, { minutes: 60 });
    hosts.fail("auth.identities", { status: 500 });

    const answer = await groupsOf(`groupBy=person&${NOVEMBER}`);

    expect(answer).toEqual({ totalMinutes: 60, groups: [keyed(ALICE, null, 60, { status: "unknown" })], unavailable: ["identities"] });
  });

  it("names a deleted person by no name, and that is not an outage", async () => {
    await makeNoEntityEntry(TRAINING, { minutes: 60 });
    hosts.auth.setIdentity(ALICE, { name: null, status: "deleted" });

    const answer = await groupsOf(`groupBy=person&${NOVEMBER}`);

    expect(answer).toEqual({ totalMinutes: 60, groups: [keyed(ALICE, null, 60, { status: "deleted" })], unavailable: [] });
  });
});

describe("groupBy=person over several people (what T19's `whose=all` selects; the aggregation does not decide whose)", () => {
  const EVERYONE = { day: { gte: new Date("2026-11-01T00:00:00Z"), lte: new Date("2026-11-30T00:00:00Z") } };

  it("orders by name as an English collator reads it (case and accents set aside), a person with no name last, ties by user id", async () => {
    const people: Array<[string, string | null, number]> = [
      ["u-5", "bob", 30],
      ["u-2", "Émile", 60],
      ["u-1", "alice", 60],
      ["u-4", "Alice", 30],
      ["u-3", null, 90],
      ["u-0", null, 30],
    ];
    for (const [userId, name, minutes] of people) {
      hosts.auth.setIdentity(userId, { name });
      await makeNoEntityEntry(TRAINING, { userId, minutes });
    }

    const answer = await totalsOf("person", EVERYONE, await bearerOf("holder"));

    // "alice" and "Alice" are equal to the collator: the key decides. "Émile" sorts with the E's, after "bob". A null label is last, by key.
    expect(answer.groups.map((group) => (group.kind === "keyed" ? [group.key, group.label] : group.kind))).toEqual([
      ["u-1", "alice"],
      ["u-4", "Alice"],
      ["u-5", "bob"],
      ["u-2", "Émile"],
      ["u-0", null],
      ["u-3", null],
    ]);
    expect(answer.totalMinutes).toBe(300);
  });

  it("lists every person with hours, however many: more than the 100 auth names in one call, and more than a list page", async () => {
    const users = Array.from({ length: 130 }, (_, index) => `many-${String(index).padStart(3, "0")}`);
    for (const userId of users) hosts.auth.setIdentity(userId, { name: `Person ${userId}` });
    await db.timeEntry.createMany({
      data: users.map((userId) => ({ userId, day: new Date("2026-11-02T00:00:00Z"), minutes: 30, target: "none" as const, categoryId: TRAINING })),
    });

    const answer = await totalsOf("person", EVERYONE, await bearerOf("holder"));

    expect(answer.groups).toHaveLength(130);
    expect(answer.totalMinutes).toBe(130 * 30);
    expect(answer.unavailable).toEqual([]);
    expect(answer.groups.every((group) => group.kind === "keyed" && group.label === `Person ${group.key}`)).toBe(true);
    expect(hosts.callsTo("auth.identities")).toHaveLength(2);
  });
});

describe("groupBy=project (AC-1.4, AC-4.5, AC-4.7, AC-4.10; plan § Totals)", () => {
  it("is one group per project the viewer can read, the most hours first, then by name; what they cannot read is ONE `hidden` group; the rest is `none`", async () => {
    hosts.projects.setProject("p-b", { label: "Beta" });
    hosts.projects.setProject("p-a", { label: "Alpha" });
    hosts.projects.setProject("p-c", { label: "Charlie" });
    // p-x1 and p-x2 are held by nobody the viewer can read: the owner answers them as it answers an id it does not know.
    await makeProjectEntry("p-b", { day: "2026-11-02", minutes: 360 });
    await makeProjectEntry("p-a", { day: "2026-11-03", minutes: 240 });
    await makeProjectEntry("p-a", { day: "2026-11-04", minutes: 120 });
    await makeProjectEntry("p-c", { day: "2026-11-05", minutes: 120 });
    await makeProjectEntry("p-x1", { minutes: 30 });
    await makeProjectEntry("p-x2", { minutes: 60 });
    await makeDealEntry("d1", { minutes: 30 });
    await makeMeetingEntry("m1", { minutes: 30 });
    await makeNoEntityEntry(TRAINING, { minutes: 60 });
    await makeProjectEntry("p-b", { userId: BOB, minutes: 480 });

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 360 + 360 + 120 + 90 + 120,
      groups: [
        keyed("p-a", "Alpha", 360),
        keyed("p-b", "Beta", 360),
        keyed("p-c", "Charlie", 120),
        { kind: "hidden", minutes: 90 },
        { kind: "none", minutes: 120 },
      ],
      unavailable: [],
    });
    // projects-api alone, once, as the viewer: no other source is needed to group by project.
    expect(hosts.calls.map((recorded) => recorded.route)).toEqual(["projects.resolve"]);
    expect(hosts.calls[0]?.authorization).toBe(await bearerOf("alice"));
  });

  it("breaks a tie on the hours by the name as an English collator reads it, then by id", async () => {
    hosts.projects.setProject("p-2", { label: "alpha" });
    hosts.projects.setProject("p-1", { label: "Alpha" });
    hosts.projects.setProject("p-3", { label: "Zulu" });
    hosts.projects.setProject("p-0", { label: "Émile" });
    for (const id of ["p-3", "p-2", "p-1", "p-0"]) await makeProjectEntry(id, { minutes: 60 });

    const { groups } = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(groups.map((group) => group.key)).toEqual(["p-1", "p-2", "p-0", "p-3"]);
  });

  it("counts a project whose owner did not answer in ONE `unavailable` group, names `projects`, and keeps the total (AC-4.7)", async () => {
    await makeProjectEntry("p-a", { minutes: 60 });
    await makeProjectEntry("p-b", { minutes: 90 });
    await makeNoEntityEntry(TRAINING, { minutes: 30 });
    hosts.fail("projects.resolve", { status: 500 });

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 180,
      groups: [{ kind: "unavailable", minutes: 150 }, { kind: "none", minutes: 30 }],
      unavailable: ["projects"],
    });
  });

  it("puts every project in `hidden` for a viewer who may not read projects at all", async () => {
    hosts.projects.setProject("p-a", { label: "Alpha" });
    hosts.projects.setReader(ALICE, false);
    await makeProjectEntry("p-a", { minutes: 60 });

    expect(await groupsOf(`groupBy=project&${NOVEMBER}`)).toEqual({ totalMinutes: 60, groups: [{ kind: "hidden", minutes: 60 }], unavailable: [] });
  });

  it("names no project the viewer cannot read: neither its id nor its name appears anywhere in the answer (AC-4.10)", async () => {
    hosts.projects.setProject("p-secret", { label: "Secret reorganisation" });
    hosts.projects.setReader(ALICE, false);
    await makeProjectEntry("p-secret", { minutes: 60 });
    await makeProjectEntry("p-unknown", { minutes: 30 });

    const res = await totals(`groupBy=project&${NOVEMBER}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("p-secret");
    expect(res.text).not.toContain("p-unknown");
    expect(res.text).not.toContain("Secret reorganisation");
    // One group says it, and what it holds is counted.
    expect(res.json.groups).toEqual([{ kind: "hidden", minutes: 90 }]);
  });

  it("asks nobody when no entry is on a project", async () => {
    await makeNoEntityEntry(TRAINING, { minutes: 60 });

    expect(await groupsOf(`groupBy=project&${NOVEMBER}`)).toEqual({ totalMinutes: 60, groups: [{ kind: "none", minutes: 60 }], unavailable: [] });
    expect(hosts.calls).toEqual([]);
  });

  it("counts two entries of one day on two projects in full on each, and in full in that day's group (AC-1.4: 6 h + 6 h)", async () => {
    hosts.projects.setProject("internal", { label: "Internal" });
    hosts.projects.setProject("client", { label: "Client" });
    await makeProjectEntry("internal", { day: "2026-11-09", minutes: 360 });
    await makeProjectEntry("client", { day: "2026-11-09", minutes: 360 });

    const byProject = await groupsOf(`groupBy=project&${NOVEMBER}`);
    expect(byProject.groups).toEqual([keyed("client", "Client", 360), keyed("internal", "Internal", 360)]);
    expect(byProject.totalMinutes).toBe(720);

    expect(await groupsOf(`groupBy=day&${NOVEMBER}`)).toEqual({ totalMinutes: 720, groups: [keyed("2026-11-09", null, 720)], unavailable: [] });
  });
});

describe("groupBy=deal (AC-2.6, AC-4.5, AC-4.7, AC-4.10; plan § Totals; ADR-0089 A1)", () => {
  /**
   * Two deals the viewer reads (d1, d2) and two they do not (d3, d4: the owner holds nothing they may read under those ids);
   * meetings linked to d1, d2, d3, to none, to a host that is not a CRM deal, and one meetings-api no longer holds.
   * 630 minutes in all, one entry of 30 on a project and 60 on no entity among them.
   */
  async function fixture() {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.crm.setDeal("d2", { label: "Deal two" });
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) hosts.meetings.add({ id, creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    hosts.meetings.relink("m2", "d2");
    hosts.meetings.relink("m3", "d3");
    hosts.meetings.relink("m4", null);
    hosts.meetings.setHost("m5", { app: "testhost", entityType: "widget", entityId: "w1" });
    await makeDealEntry("d1", { day: "2026-11-02", minutes: 60 });
    await makeDealEntry("d2", { day: "2026-11-02", minutes: 30 });
    await makeDealEntry("d3", { day: "2026-11-02", minutes: 30 });
    await makeDealEntry("d4", { day: "2026-11-02", minutes: 60 });
    await makeMeetingEntry("m1", { day: "2026-11-03", minutes: 120 });
    await makeMeetingEntry("m2", { day: "2026-11-03", minutes: 90 });
    await makeMeetingEntry("m3", { day: "2026-11-03", minutes: 30 });
    await makeMeetingEntry("m4", { day: "2026-11-03", minutes: 30 });
    await makeMeetingEntry("m5", { day: "2026-11-03", minutes: 60 });
    await makeMeetingEntry("m-gone", { day: "2026-11-03", minutes: 30 });
    await makeProjectEntry("p1", { day: "2026-11-04", minutes: 30 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-04", minutes: 60 });
  }

  it("counts a meeting's hours under the deal it is linked to NOW, with the deal's own; what the viewer cannot read is ONE `hidden` group, what is under no deal is `none`", async () => {
    await fixture();

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 630,
      groups: [
        keyed("d1", "Deal one", 60 + 120),
        keyed("d2", "Deal two", 30 + 90),
        // d3 and d4 and the meeting linked to d3: the viewer may read none of them, and is told nothing of which.
        { kind: "hidden", minutes: 30 + 60 + 30 },
        // a meeting linked to none, to a host that is not a CRM deal, and one that no longer exists; a project and a no-entity entry.
        { kind: "none", minutes: 30 + 60 + 30 + 30 + 60 },
      ],
      unavailable: [],
    });
  });

  it("asks meetings-api once with its own credential for the deals of the meetings, crm-api once as the viewer for every deal, and nobody else", async () => {
    await fixture();

    await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect([...new Set(asked())].sort()).toEqual(["crm.resolve", "meetings.system-hosts"]);
    const links = hosts.callsTo("meetings.system-hosts");
    expect(links).toHaveLength(1);
    expect(links[0]?.query.get("ids")?.split(",").sort()).toEqual(["m-gone", "m1", "m2", "m3", "m4", "m5"]);
    expect(claimsOf(links[0]?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", scope: "meetings.hosts.read" });
    // The deals of the deal entries and the deals the meetings are linked to go out in ONE batch, as the viewer.
    const resolves = hosts.callsTo("crm.resolve");
    expect(resolves).toHaveLength(1);
    expect([...(resolves[0]?.body as { ids: string[] }).ids].sort()).toEqual(["d1", "d2", "d3", "d4"]);
    expect(resolves[0]?.authorization).toBe(await bearerOf("alice"));
  });

  it("moves the hours of a meeting when it is relinked: they count for the new deal and no longer for the old one (AC-2.6)", async () => {
    await fixture();
    expect((await groupsOf(`groupBy=deal&${NOVEMBER}`)).groups[0]).toEqual(keyed("d1", "Deal one", 180));

    hosts.meetings.relink("m1", "d2");

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);
    expect(answer.groups.slice(0, 2)).toEqual([keyed("d2", "Deal two", 30 + 90 + 120), keyed("d1", "Deal one", 60)]);
    expect(answer.totalMinutes).toBe(630);
  });

  it("with no deal readable, one `hidden` group holds every deal and every linked meeting, and the name of none of them is told", async () => {
    await fixture();
    hosts.crm.setReader(ALICE, false);

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(answer.groups).toEqual([
      { kind: "hidden", minutes: 60 + 30 + 30 + 60 + 120 + 90 + 30 },
      { kind: "none", minutes: 210 },
    ]);
    expect(JSON.stringify(answer)).not.toContain("Deal one");
  });

  it("counts everything whose deal crm-api did not say in ONE `unavailable` group, names `crm`, and keeps the total (AC-4.7)", async () => {
    await fixture();
    hosts.fail("crm.resolve", { status: 500 });

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    // The meetings' links were read (m4 and m5 are under no deal, m3 is linked): what crm-api was to say is unavailable.
    expect(answer).toEqual({
      totalMinutes: 630,
      groups: [{ kind: "unavailable", minutes: 60 + 30 + 30 + 60 + 120 + 90 + 30 }, { kind: "none", minutes: 210 }],
      unavailable: ["crm"],
    });
  });

  it("puts a meeting whose link could not be read in `deal-unknown`, keeps the total and the deal entries, and names `meeting-deals` (AC-4.7)", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500 });

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 630,
      groups: [
        keyed("d1", "Deal one", 60),
        keyed("d2", "Deal two", 30),
        { kind: "hidden", minutes: 30 + 60 },
        // all six meeting entries: 120 + 90 + 30 + 30 + 60 + 30
        { kind: "deal-unknown", minutes: 360 },
        { kind: "none", minutes: 90 },
      ],
      unavailable: ["meeting-deals"],
    });
  });

  it("names both when both are down, and the total is still every entry", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500 });
    hosts.fail("crm.resolve", { status: 500 });

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(answer.unavailable).toEqual(["crm", "meeting-deals"]);
    expect(answer.totalMinutes).toBe(630);
    expect(answer.groups).toEqual([
      { kind: "unavailable", minutes: 60 + 30 + 30 + 60 },
      { kind: "deal-unknown", minutes: 360 },
      { kind: "none", minutes: 90 },
    ]);
  });

  it("orders the deals by hours, then name, then id; then `hidden`, `unavailable`, `deal-unknown`, `none`", async () => {
    hosts.crm.setDeal("d-z", { label: "Zulu" });
    hosts.crm.setDeal("d-a", { label: "Alpha" });
    hosts.crm.setDeal("d-b", { label: "Beta" });
    hosts.crm.setDeal("d-c", { label: "Charlie" });
    await makeDealEntry("d-z", { minutes: 60 });
    await makeDealEntry("d-b", { minutes: 60 });
    await makeDealEntry("d-a", { minutes: 60 });
    await makeDealEntry("d-c", { minutes: 120 });
    await makeDealEntry("d-hidden", { minutes: 30 });
    await makeProjectEntry("p1", { minutes: 30 });

    const { groups } = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(groups.map((group) => (group.kind === "keyed" ? group.label : group.kind))).toEqual(["Charlie", "Alpha", "Beta", "Zulu", "hidden", "none"]);
  });

  it("counts a meeting linked to a deal id outside the id rule in `hidden`, never sends that id to crm-api, and does not disturb the deals around it (plan § Views)", async () => {
    // What meetings-api stores is not bounded by hours-api's id rule: 65 characters, a NUL, a comma, a space at either end.
    const OUTSIDE = ["x".repeat(65), "a\u0000b", "a,b", " d1", "d1 "];
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m-ok", creator: ALICE });
    hosts.meetings.relink("m-ok", "d1");
    await makeMeetingEntry("m-ok", { minutes: 30 });
    await makeDealEntry("d1", { minutes: 60 });
    for (const [index, entityId] of OUTSIDE.entries()) {
      hosts.meetings.add({ id: `m-out-${index}`, creator: ALICE });
      hosts.meetings.relink(`m-out-${index}`, entityId);
      await makeMeetingEntry(`m-out-${index}`, { minutes: 30 });
    }

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(answer).toEqual({ totalMinutes: 90 + 30 * OUTSIDE.length, groups: [keyed("d1", "Deal one", 90), { kind: "hidden", minutes: 30 * OUTSIDE.length }], unavailable: [] });
    const resolves = hosts.callsTo("crm.resolve");
    expect(resolves).toHaveLength(1);
    expect((resolves[0]?.body as { ids: string[] }).ids).toEqual(["d1"]);
    // Whether crm-api answers does not change it: the id was never sent, so there was nothing to be unavailable.
    hosts.fail("crm.resolve", { status: 500 });
    const down = await groupsOf(`groupBy=deal&${NOVEMBER}`);
    expect(down.groups).toEqual([{ kind: "hidden", minutes: 30 * OUTSIDE.length }, { kind: "unavailable", minutes: 90 }]);
    expect(down.unavailable).toEqual(["crm"]);
  });

  it("counts a meeting linked to an empty deal id in `none`: it names nothing", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.setHost("m1", { app: "crm", entityType: "deal", entityId: "" });
    await makeMeetingEntry("m1", { minutes: 30 });

    expect(await groupsOf(`groupBy=deal&${NOVEMBER}`)).toEqual({ totalMinutes: 30, groups: [{ kind: "none", minutes: 30 }], unavailable: [] });
  });

  it("reads a system-route answer that ignored its filter as no answer: those meetings are `deal-unknown`, `meeting-deals` is named, the total is whole (plan amendment 3)", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    await makeMeetingEntry("m1", { minutes: 60 });
    // An answer about a meeting nobody asked for, and none about the one asked: the filter was ignored.
    hosts.fail("meetings.system-hosts", { body: { items: [{ id: "some-other-meeting", host: { app: "crm", entityType: "deal", entityId: "d1" } }] } });

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(answer).toEqual({ totalMinutes: 60, groups: [{ kind: "deal-unknown", minutes: 60 }], unavailable: ["meeting-deals"] });
  });

  it("reads an answer that is not the route's shape, a refusal and a timeout alike: `deal-unknown`, never an error and never a wrong deal", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    await makeMeetingEntry("m1", { minutes: 60 });

    for (const breakIt of [
      () => hosts.fail("meetings.system-hosts", { malformed: true }),
      () => hosts.fail("meetings.system-hosts", { rawBody: "not json" }),
      () => hosts.fail("meetings.system-hosts", { status: 404 }),
      () => hosts.fail("meetings.system-hosts", { status: 401 }),
      () => hosts.fail("auth.service-token", { status: 500 }),
      () => hosts.sever("meetings"),
    ]) {
      hosts.reset();
      hosts.crm.setDeal("d1", { label: "Deal one" });
      hosts.meetings.add({ id: "m1", creator: ALICE });
      hosts.meetings.relink("m1", "d1");
      breakIt();
      expect(await groupsOf(`groupBy=deal&${NOVEMBER}`)).toEqual({ totalMinutes: 60, groups: [{ kind: "deal-unknown", minutes: 60 }], unavailable: ["meeting-deals"] });
    }
  });

  it("adds up the meetings of a period however many: more than the 100 ids meetings-api takes in one call", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    const ids = Array.from({ length: 130 }, (_, index) => `many-${String(index).padStart(3, "0")}`);
    for (const id of ids) {
      hosts.meetings.add({ id, creator: ALICE });
      hosts.meetings.relink(id, "d1");
    }
    await db.timeEntry.createMany({
      data: ids.map((meetingId) => ({ userId: ALICE, day: new Date("2026-11-02T00:00:00Z"), minutes: 30, target: "meeting" as const, meetingId })),
    });

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}`);

    expect(answer).toEqual({ totalMinutes: 130 * 30, groups: [keyed("d1", "Deal one", 130 * 30)], unavailable: [] });
    expect(hosts.callsTo("meetings.system-hosts")).toHaveLength(2);
  });

  it("names no deal the viewer cannot read: no id and no name of it anywhere in the answer, a meeting's link included (AC-4.10, ADR-0089 A1)", async () => {
    await fixture();

    const res = await totals(`groupBy=deal&${NOVEMBER}`);

    // d3 and d4 are unreadable; m3 is linked to d3, which only hours-api's own credential could tell.
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("d3");
    expect(res.text).not.toContain("d4");
  });

  it("asks nobody when no entry is on a deal or a meeting", async () => {
    await makeProjectEntry("p1", { minutes: 30 });
    await makeNoEntityEntry(TRAINING, { minutes: 60 });

    expect(await groupsOf(`groupBy=deal&${NOVEMBER}`)).toEqual({ totalMinutes: 90, groups: [{ kind: "none", minutes: 90 }], unavailable: [] });
    expect(hosts.calls).toEqual([]);
  });

  it("asks meetings-api only: a period with meeting entries and no deal entry needs no crm-api call when no meeting is linked to a deal", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    await makeMeetingEntry("m1", { minutes: 30 });

    expect(await groupsOf(`groupBy=deal&${NOVEMBER}`)).toEqual({ totalMinutes: 30, groups: [{ kind: "none", minutes: 30 }], unavailable: [] });
    expect(asked()).toEqual(["meetings.system-hosts"]);
  });
});

describe("the filters narrow the totals as they narrow the list (AC-4.4)", () => {
  /** What the list and the totals are asked about: three projects' worth of entries on each kind of target. */
  async function fixture() {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.projects.setProject("p2", { label: "Beta" });
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.add({ id: "m2", creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    const development = SEED.workTypes.project.development;
    await makeProjectEntry("p1", { day: "2026-11-02", minutes: 120, workTypeId: development });
    await makeProjectEntry("p1", { day: "2026-11-03", minutes: 60 });
    await makeProjectEntry("p2", { day: "2026-11-03", minutes: 90, workTypeId: SEED.workTypes.project.analysis });
    await makeDealEntry("d1", { day: "2026-11-04", minutes: 30, workTypeId: SEED.workTypes.deal.demo });
    await makeMeetingEntry("m1", { day: "2026-11-04", minutes: 60 });
    await makeMeetingEntry("m2", { day: "2026-11-05", minutes: 30 });
    await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-05", minutes: 60 });
    await makeNoEntityEntry(SEED.categories.administration, { day: "2026-11-06", minutes: 30 });
    await makeProjectEntry("p1", { userId: BOB, day: "2026-11-03", minutes: 480 });
  }

  const FILTERS: Array<[string, string, number]> = [
    ["nothing", "", 120 + 60 + 90 + 30 + 60 + 30 + 60 + 30],
    ["a project", "&projectId=p1", 120 + 60],
    ["a deal and the meetings linked to it", "&dealId=d1", 30 + 60],
    ["a meeting", "&meetingId=m2", 30],
    ["a category", "&categoryId=tc-training", 60],
    ["a work type", `&workTypeId=${SEED.workTypes.project.development}`, 120],
    ["a target", "&target=meeting", 90],
    ["a target and a project", "&target=deal&projectId=p1", 0],
    ["a period of two days", "&from=2026-11-03&to=2026-11-04", 60 + 90 + 30 + 60],
    ["a filter nothing matches", "&projectId=nobody", 0],
  ];

  it.each(FILTERS)("%s: every grouping adds up to what the list holds for the same query", async (_what, extra, expected) => {
    await fixture();
    const period = extra.includes("from=") ? "" : `${NOVEMBER}`;
    const query = `${period}${extra}`.replace(/^&/, "");

    const list = await call("GET", `/time-entries?${query}&limit=500`);
    expect(list.status).toBe(200);
    const listed: Array<{ day: string; minutes: number }> = list.json.items;
    expect(listed.reduce((sum, item) => sum + item.minutes, 0)).toBe(expected);

    for (const groupBy of ["person", "project", "deal", "category", "month", "day"]) {
      const answer = await groupsOf(`groupBy=${groupBy}&${query}`);
      expect({ groupBy, totalMinutes: answer.totalMinutes }).toEqual({ groupBy, totalMinutes: expected });
      expect({ groupBy, sum: answer.groups.reduce((sum, group) => sum + group.minutes, 0) }).toEqual({ groupBy, sum: expected });
      // No group holds nothing: a person, a project or a day with no matching entry is absent, not zero.
      expect(answer.groups.every((group) => group.minutes > 0)).toBe(true);
    }

    // Each day's total is the sum of that day's matching entries, whichever page they arrive on (AC-4.1).
    const perDay = new Map<string, number>();
    for (const item of listed) perDay.set(item.day, (perDay.get(item.day) ?? 0) + item.minutes);
    const days = (await groupsOf(`groupBy=day&${query}`)).groups;
    expect(days.map((group) => [group.key, group.minutes])).toEqual([...perDay].sort(([a], [b]) => (a < b ? 1 : -1)));
  });

  it("counts nobody else's hours: whose=mine is the caller's own, whichever filter names the other person's entries", async () => {
    await fixture();

    expect((await groupsOf(`groupBy=person&${NOVEMBER}&projectId=p1`)).groups).toEqual([keyed(ALICE, "Name of alice", 180, { status: "active" })]);
    expect((await groupsOf(`groupBy=person&${NOVEMBER}&projectId=p1`, "bob")).groups).toEqual([keyed(BOB, "Name of bob", 480, { status: "active" })]);
  });
});

describe("whatever is down, every entry is counted, in one group (AC-4.7; plan § Totals, 'Complete')", () => {
  /** What every owner would say, so each weather below spoils one thing. */
  async function fixture() {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    await makeProjectEntry("p1", { day: "2026-11-02", minutes: 120 });
    await makeProjectEntry("p-gone", { day: "2026-11-02", minutes: 30 });
    await makeDealEntry("d1", { day: "2026-11-03", minutes: 60 });
    await makeDealEntry("d-gone", { day: "2026-11-03", minutes: 30 });
    await makeMeetingEntry("m1", { day: "2026-11-04", minutes: 90 });
    await makeMeetingEntry("m-gone", { day: "2026-11-04", minutes: 30 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-05", minutes: 60 });
  }
  const ALL = 120 + 30 + 60 + 30 + 90 + 30 + 60;

  const WEATHER: Array<[string, () => void]> = [
    ["fair", () => undefined],
    ["projects-api down", () => hosts.fail("projects.resolve", { status: 500 })],
    ["crm-api down", () => hosts.fail("crm.resolve", { status: 500 })],
    ["the meetings system route down", () => hosts.fail("meetings.system-hosts", { status: 500 })],
    ["auth down (names)", () => hosts.fail("auth.identities", { status: 500 })],
    ["every owner and auth severed", () => (["projects", "crm", "activities", "meetings", "auth"] as const).forEach((host) => hosts.sever(host))],
  ];

  it.each(WEATHER)("%s: each grouping adds up to every entry, and no group is empty", async (_what, spoil) => {
    await fixture();
    spoil();

    for (const groupBy of ["person", "project", "deal", "category", "month", "day"]) {
      const answer = await groupsOf(`groupBy=${groupBy}&${NOVEMBER}`);
      expect({ groupBy, totalMinutes: answer.totalMinutes, sum: answer.groups.reduce((sum, group) => sum + group.minutes, 0) }).toEqual({ groupBy, totalMinutes: ALL, sum: ALL });
      expect(answer.groups.every((group) => group.minutes > 0)).toBe(true);
    }
  });

  it("asks no one, and names no one, for a grouping that needs no one: day, month and category are whole even with every owner severed", async () => {
    await fixture();
    for (const host of ["projects", "crm", "activities", "meetings", "auth"] as const) hosts.sever(host);

    for (const groupBy of ["day", "month", "category"]) {
      const answer = await groupsOf(`groupBy=${groupBy}&${NOVEMBER}`);
      expect({ groupBy, unavailable: answer.unavailable }).toEqual({ groupBy, unavailable: [] });
    }
    expect(hosts.calls).toEqual([]);
  });

  it("names exactly the sources the grouping needed: person asks auth, project asks projects-api, deal asks crm-api and the meetings' links", async () => {
    await fixture();
    hosts.fail("projects.resolve", { status: 500 });
    hosts.fail("crm.resolve", { status: 500 });
    hosts.fail("meetings.system-hosts", { status: 500 });
    hosts.fail("auth.identities", { status: 500 });

    expect((await groupsOf(`groupBy=person&${NOVEMBER}`)).unavailable).toEqual(["identities"]);
    expect((await groupsOf(`groupBy=project&${NOVEMBER}`)).unavailable).toEqual(["projects"]);
    expect((await groupsOf(`groupBy=deal&${NOVEMBER}`)).unavailable).toEqual(["crm", "meeting-deals"]);
  });
});

describe("the deal filter, and meetings-api not saying which meetings are linked (AC-2.6, AC-4.11; plan § Totals)", () => {
  const OUTAGES: Array<[string, () => void]> = [
    ["answering 500", () => hosts.fail("meetings.system-hosts", { status: 500 })],
    ["answering 503", () => hosts.fail("meetings.system-hosts", { status: 503 })],
    ["answering 401 to the credential, even after a fresh one", () => hosts.fail("meetings.system-hosts", { status: 401 })],
    ["a route that is not deployed yet (404)", () => hosts.fail("meetings.system-hosts", { status: 404 })],
    ["a body that is not the route's shape", () => hosts.fail("meetings.system-hosts", { malformed: true })],
    ["a connection that cannot be made", () => hosts.sever("meetings")],
    ["no credential: auth would not mint one", () => hosts.fail("auth.service-token", { status: 500 })],
  ];
  const GROUPINGS = ["person", "project", "deal", "category", "month", "day"];

  async function fixture() {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.crm.setDeal("d2", { label: "Deal two" });
    for (const id of ["m1", "m2"]) hosts.meetings.add({ id, creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    hosts.meetings.relink("m2", "d2");
    await makeDealEntry("d1", { day: "2026-11-02", minutes: 60 });
    await makeDealEntry("d2", { day: "2026-11-03", minutes: 30 });
    await makeMeetingEntry("m1", { day: "2026-11-04", minutes: 120 });
    await makeMeetingEntry("m2", { day: "2026-11-05", minutes: 90 });
    await makeProjectEntry("p1", { day: "2026-11-06", minutes: 30 });
  }

  it("counts the deal's own entries and the entries on the meetings linked to it, in every grouping", async () => {
    await fixture();

    for (const groupBy of GROUPINGS) {
      const answer = await groupsOf(`groupBy=${groupBy}&${NOVEMBER}&dealId=d1`);
      expect({ groupBy, totalMinutes: answer.totalMinutes }).toEqual({ groupBy, totalMinutes: 180 });
    }
    expect((await groupsOf(`groupBy=day&${NOVEMBER}&dealId=d1`)).groups).toEqual([keyed("2026-11-04", null, 120), keyed("2026-11-02", null, 60)]);
  });

  it("moves a meeting's hours with the link: a relink in meetings-api moves them from one deal's totals to the other's", async () => {
    await fixture();
    expect((await groupsOf(`groupBy=month&${NOVEMBER}&dealId=d1`)).totalMinutes).toBe(180);
    expect((await groupsOf(`groupBy=month&${NOVEMBER}&dealId=d2`)).totalMinutes).toBe(120);

    hosts.meetings.relink("m1", "d2");

    expect((await groupsOf(`groupBy=month&${NOVEMBER}&dealId=d1`)).totalMinutes).toBe(60);
    expect((await groupsOf(`groupBy=month&${NOVEMBER}&dealId=d2`)).totalMinutes).toBe(240);
  });

  it("groups the deal's hours under it when grouped by deal, the meetings' included", async () => {
    await fixture();

    expect(await groupsOf(`groupBy=deal&${NOVEMBER}&dealId=d1`)).toEqual({ totalMinutes: 180, groups: [keyed("d1", "Deal one", 180)], unavailable: [] });
  });

  it("asks meetings-api only the one question for a grouping that needs no deal: the meetings of the deal", async () => {
    await fixture();

    await groupsOf(`groupBy=day&${NOVEMBER}&dealId=d1`);

    const calls = hosts.callsTo("meetings.system-hosts");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("dealId")).toBe("d1");
    expect(claimsOf(calls[0]?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", scope: "meetings.hosts.read" });
  });

  it.each(OUTAGES)("is refused 503 host_unavailable with no groups, whichever grouping, however it is down: %s", async (_what, breakIt) => {
    await fixture();
    breakIt();

    for (const groupBy of GROUPINGS) {
      const res = await totals(`groupBy=${groupBy}&${NOVEMBER}&dealId=d1`);
      expect({ groupBy, status: res.status }).toEqual({ groupBy, status: 503 });
      expect(res.json).toMatchObject({ code: "host_unavailable", status: 503 });
      // Nothing partial: not the deal's own entries, not a total, no list of what was unavailable.
      for (const member of ["groups", "totalMinutes", "unavailable"]) expect(res.json).not.toHaveProperty(member);
    }
  });

  it("is refused the same when meetings-api is slower than the 2 s it is given (one grouping: the wait is the point)", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { delayMs: 2_600 });

    const res = await totals(`groupBy=deal&${NOVEMBER}&dealId=d1`);

    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "host_unavailable" });
    expect(res.json).not.toHaveProperty("groups");
  });

  it("refuses even when the deal has no entries at all, and answers again, whole, once meetings-api does", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500 });
    expect((await totals(`groupBy=day&${NOVEMBER}&dealId=nobody`)).status).toBe(503);

    hosts.heal("meetings.system-hosts");

    expect(await groupsOf(`groupBy=day&${NOVEMBER}&dealId=nobody`)).toEqual({ totalMinutes: 0, groups: [], unavailable: [] });
    expect((await groupsOf(`groupBy=day&${NOVEMBER}&dealId=d1`)).totalMinutes).toBe(180);
  });

  it("is only the deal filter: the same outage without it still answers, the meetings in `deal-unknown` and `meeting-deals` named (AC-4.7)", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500 });

    const byDeal = await groupsOf(`groupBy=deal&${NOVEMBER}`);
    expect(byDeal.totalMinutes).toBe(330);
    expect(byDeal.unavailable).toEqual(["meeting-deals"]);
    expect(byDeal.groups.find((group) => group.kind === "deal-unknown")).toEqual({ kind: "deal-unknown", minutes: 210 });

    // A grouping that reads no deal is whole and names nothing.
    for (const groupBy of ["person", "project", "category", "month", "day"]) {
      const answer = await groupsOf(`groupBy=${groupBy}&${NOVEMBER}`);
      expect({ groupBy, totalMinutes: answer.totalMinutes }).toEqual({ groupBy, totalMinutes: 330 });
    }
  });

  it("when the link is known for the filter but fails a moment later, by deal, keeps the total and names `meeting-deals` (the second question is its own)", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500, after: 1 });

    const answer = await groupsOf(`groupBy=deal&${NOVEMBER}&dealId=d1`);

    expect(answer).toEqual({
      totalMinutes: 180,
      groups: [keyed("d1", "Deal one", 60), { kind: "deal-unknown", minutes: 120 }],
      unavailable: ["meeting-deals"],
    });
  });
});

describe("the names follow the VIEWER, not the author of the entries (AC-4.10, ADR-0089 A1: the author included)", () => {
  /** Everyone's entries: what T19's `whose=all` will hand the aggregation. The route decides whose; the labels are the viewer's. */
  const EVERYONE = { day: { gte: new Date("2026-11-01T00:00:00Z"), lte: new Date("2026-11-30T00:00:00Z") } };

  async function fixture() {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relink("m1", "d1");
    await makeProjectEntry("p1", { userId: BOB, minutes: 60 });
    await makeDealEntry("d1", { userId: BOB, minutes: 30 });
    await makeMeetingEntry("m1", { userId: BOB, minutes: 90 });
  }

  it("a viewer who may read what its author reads is told its names, and they are asked as THAT viewer", async () => {
    await fixture();
    const viewer = await bearerOf("holder");

    expect((await totalsOf("project", EVERYONE, viewer)).groups).toEqual([keyed("p1", "Alpha", 60), { kind: "none", minutes: 120 }]);
    expect((await totalsOf("deal", EVERYONE, viewer)).groups).toEqual([keyed("d1", "Deal one", 120), { kind: "none", minutes: 60 }]);
    for (const recorded of [...hosts.callsTo("projects.resolve"), ...hosts.callsTo("crm.resolve")]) expect(recorded.authorization).toBe(viewer);
  });

  it("a viewer who may not read them is told none, though the author reads all: one `hidden` group each, the meeting's deal included", async () => {
    await fixture();
    hosts.projects.setReader(PERSONAS.holder.sub, false);
    hosts.crm.setReader(PERSONAS.holder.sub, false);
    hosts.projects.setReader(BOB, true);
    hosts.crm.setReader(BOB, true);

    const viewer = await bearerOf("holder");
    const byProject = await totalsOf("project", EVERYONE, viewer);
    const byDeal = await totalsOf("deal", EVERYONE, viewer);

    expect(byProject.groups).toEqual([{ kind: "hidden", minutes: 60 }, { kind: "none", minutes: 120 }]);
    expect(byDeal.groups).toEqual([{ kind: "hidden", minutes: 120 }, { kind: "none", minutes: 60 }]);
    expect(JSON.stringify([byProject, byDeal])).not.toMatch(/Alpha|Deal one|p1|d1/);
    // And the author, asking for the same, reads them: the same hours, read as another viewer.
    expect((await totalsOf("project", EVERYONE, await bearerOf("bob"))).groups).toEqual([keyed("p1", "Alpha", 60), { kind: "none", minutes: 120 }]);
  });
});

describe("groupBy=category (AC-4.5; plan § Totals)", () => {
  it("is one group per category used: the name as typed and whether it is retired, the most hours first, then by name; every other entry is `none`", async () => {
    const offsite = await makeCategory("Offsite", { retired: true });
    await makeNoEntityEntry(offsite.id, { day: "2026-11-02", minutes: 120 });
    await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-03", minutes: 60 });
    await makeNoEntityEntry(SEED.categories.administration, { day: "2026-11-04", minutes: 30 });
    await makeNoEntityEntry(SEED.categories.administration, { day: "2026-11-05", minutes: 30 });
    await makeProjectEntry("p1", { minutes: 30 });
    await makeDealEntry("d1", { minutes: 90 });
    await makeMeetingEntry("m1", { minutes: 30 });
    await makeNoEntityEntry(TRAINING, { userId: BOB, minutes: 480 });

    const answer = await groupsOf(`groupBy=category&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 120 + 60 + 60 + 30 + 90 + 30,
      groups: [
        keyed(offsite.id, "Offsite", 120, { retired: true }),
        keyed(SEED.categories.administration, "Administration", 60, { retired: false }),
        keyed(SEED.categories.training, "Training", 60, { retired: false }),
        { kind: "none", minutes: 150 },
      ],
      unavailable: [],
    });
    // A category is this service's own: nothing else is asked.
    expect(hosts.calls).toEqual([]);
  });

  it("has no `none` group when every entry is on a category, and nothing at all when there are no entries", async () => {
    await makeNoEntityEntry(TRAINING, { minutes: 30 });
    expect((await groupsOf(`groupBy=category&${NOVEMBER}`)).groups.map((group) => group.kind)).toEqual(["keyed"]);
    expect(await groupsOf("groupBy=category&from=2026-01-01&to=2026-01-31")).toEqual({ totalMinutes: 0, groups: [], unavailable: [] });
  });
});
