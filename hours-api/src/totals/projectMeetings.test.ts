/**
 * The totals of a project count the meetings linked to it (specs/20261112-project-hours T8; AC-4.1, AC-4.2, AC-4.5, AC-4.7, AC-4.8, AC-4.10; plan § The
 * hours views "Totals `groupBy=project`" and "Filter"; ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route amendment A1 and its
 * amendment of 2026-11-26), through the ASSEMBLED app, against the real database and the fake hosts of T11.
 *
 * `groupBy=project` is `groupBy=deal`'s twin (src/totals/totals.test.ts "groupBy=deal"): a meeting's entries count under the project it is linked
 * to NOW, which only meetings-api can say (its system route, hours-api's own credential), and which a viewer is told only with the right to read the
 * project. What they cannot read is ONE `hidden` group, what projects-api did not answer ONE `unavailable` group, what meetings-api did not say
 * `project-unknown`, and what is linked to no project `none`.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PERSONAS,
  SEED,
  bearerOf,
  call,
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

const keyed = (key: string, label: string | null, minutes: number) => ({ kind: "keyed" as const, key, label, minutes });

describe("groupBy=project counts a meeting's hours under the project it is linked to NOW (AC-4.5)", () => {
  /**
   * Two projects the viewer reads (p1, p2) and two they do not (p3, p4: the owner holds nothing they may read under those ids), a meeting on each
   * (m1 → p1, m2 → p2, m3 → p3, m4 → p4), one linked to no project (m5), one to a deal (m6), and an entry on each of those, and on p1 and a deal.
   */
  async function fixture() {
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) hosts.meetings.add({ id, creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    hosts.meetings.relinkProject("m2", "p2");
    hosts.meetings.relinkProject("m3", "p3");
    hosts.meetings.relinkProject("m4", "p4");
    hosts.meetings.relink("m6", "d1");
    hosts.projects.setProject("p1", { label: "Project one" });
    hosts.projects.setProject("p2", { label: "Project two" });
    await makeProjectEntry("p1", { day: "2026-11-02", minutes: 120 });
    await makeMeetingEntry("m1", { day: "2026-11-03", minutes: 60 });
    await makeMeetingEntry("m2", { day: "2026-11-04", minutes: 30 });
    await makeMeetingEntry("m3", { day: "2026-11-05", minutes: 30 });
    await makeMeetingEntry("m4", { day: "2026-11-06", minutes: 60 });
    await makeMeetingEntry("m5", { day: "2026-11-09", minutes: 30 });
    await makeMeetingEntry("m6", { day: "2026-11-10", minutes: 90 });
    await makeDealEntry("d1", { day: "2026-11-11", minutes: 30 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-12", minutes: 60 });
  }

  it("keys a linked meeting's hours under a project the viewer can read, with the project's own; what they cannot read is ONE `hidden` group, what is under no project is `none`", async () => {
    await fixture();

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 120 + 60 + 30 + 30 + 60 + 30 + 90 + 30 + 60,
      groups: [
        keyed("p1", "Project one", 180),
        keyed("p2", "Project two", 30),
        { kind: "hidden", minutes: 90 },
        // The unlinked meeting (30), the deal's meeting (90), the deal's entry (30) and the no-entity entry (60).
        { kind: "none", minutes: 210 },
      ],
      unavailable: [],
    });
  });

  it("counts a linked meeting's hours whoever recorded them: the author's own entries and another person's are one group (AC-4.1)", async () => {
    await fixture();
    await makeMeetingEntry("m1", { userId: BOB, day: "2026-11-03", minutes: 90 });
    // What `whose=all` hands the aggregation: everyone's entries (the route decides whose; this is the aggregation).
    const everyone = { day: { gte: new Date("2026-11-01T00:00:00Z"), lte: new Date("2026-11-30T00:00:00Z") } };

    const answer = await totalsOf("project", everyone, await bearerOf("alice"));

    expect(answer.groups[0]).toEqual(keyed("p1", "Project one", 120 + 60 + 90));
  });

  it("moves the hours of a meeting when it is relinked: they count for the new project and no longer for the old one (AC-4.2)", async () => {
    await fixture();
    expect((await groupsOf(`groupBy=project&${NOVEMBER}`)).groups[0]).toEqual(keyed("p1", "Project one", 180));

    hosts.meetings.relinkProject("m1", "p2");
    let groups = (await groupsOf(`groupBy=project&${NOVEMBER}`)).groups;
    expect(groups.slice(0, 2)).toEqual([keyed("p1", "Project one", 120), keyed("p2", "Project two", 90)]);

    // To a deal, then unlinked: it counts for no project, and its hours are in `none`.
    hosts.meetings.relink("m1", "d1");
    groups = (await groupsOf(`groupBy=project&${NOVEMBER}`)).groups;
    expect(groups.find((group) => group.key === "p1")).toEqual(keyed("p1", "Project one", 120));
    expect(groups.find((group) => group.key === "p2")).toEqual(keyed("p2", "Project two", 30));
    expect(groups.find((group) => group.kind === "none")).toEqual({ kind: "none", minutes: 270 });
  });

  it("with no project readable, one `hidden` group holds every project and every linked meeting, and the name or id of none of them is told (AC-4.7)", async () => {
    await fixture();
    hosts.projects.setReader(ALICE, false);

    const res = await totals(`groupBy=project&${NOVEMBER}`);

    expect(res.status).toBe(200);
    expect(res.json.groups).toEqual([
      { kind: "hidden", minutes: 120 + 60 + 30 + 30 + 60 },
      { kind: "none", minutes: 210 },
    ]);
    expect(res.text).not.toMatch(/Project one|Project two|p1|p2|p3|p4/);
  });

  it("counts everything whose project projects-api did not say in ONE `unavailable` group, names `projects`, and keeps the total (AC-4.7)", async () => {
    await fixture();
    hosts.fail("projects.resolve", { status: 500 });

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    // The meetings' links were read (m5 and m6 are under no project): what projects-api was to say is unavailable.
    expect(answer).toEqual({
      totalMinutes: 510,
      groups: [{ kind: "unavailable", minutes: 120 + 60 + 30 + 30 + 60 }, { kind: "none", minutes: 210 }],
      unavailable: ["projects"],
    });
  });

  it("puts a meeting whose link could not be read in `project-unknown`, keeps the total and the project entries, and names `meeting-projects` (AC-4.5, AC-4.10)", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500 });

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(answer).toEqual({
      totalMinutes: 510,
      groups: [
        keyed("p1", "Project one", 120),
        // all six meeting entries: 60 + 30 + 30 + 60 + 30 + 90
        { kind: "project-unknown", minutes: 300 },
        // the deal's entry (30) and the no-entity entry (60)
        { kind: "none", minutes: 90 },
      ],
      // `meeting-deals` is not named: a by-project read asked about projects, never about a meeting's deal.
      unavailable: ["meeting-projects"],
    });
  });

  it("names both when both are down, and the total is still every entry", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500 });
    hosts.fail("projects.resolve", { status: 500 });

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(answer.unavailable).toEqual(["projects", "meeting-projects"]);
    expect(answer.totalMinutes).toBe(510);
    expect(answer.groups).toEqual([
      { kind: "unavailable", minutes: 120 },
      { kind: "project-unknown", minutes: 300 },
      { kind: "none", minutes: 90 },
    ]);
  });

  it("orders the projects by hours, then name, then id, a linked meeting's hours counted with its project's; then `hidden`, then `none`", async () => {
    hosts.projects.setProject("p-z", { label: "Zulu" });
    hosts.projects.setProject("p-a", { label: "Alpha" });
    hosts.projects.setProject("p-b", { label: "Beta" });
    hosts.projects.setProject("p-c", { label: "Charlie" });
    hosts.meetings.add({ id: "m-z", creator: ALICE });
    hosts.meetings.relinkProject("m-z", "p-z");
    await makeMeetingEntry("m-z", { minutes: 60 });
    await makeProjectEntry("p-b", { minutes: 60 });
    await makeProjectEntry("p-a", { minutes: 60 });
    await makeProjectEntry("p-c", { minutes: 120 });
    await makeProjectEntry("p-hidden", { minutes: 30 });
    await makeDealEntry("d1", { minutes: 30 });

    const { groups } = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(groups.map((group) => (group.kind === "keyed" ? group.label : group.kind))).toEqual(["Charlie", "Alpha", "Beta", "Zulu", "hidden", "none"]);
  });

  it("puts `project-unknown` after `hidden` and `unavailable` and before `none`: the four tail groups, in the plan's order", async () => {
    // hidden (a project nobody reads) and none (a deal entry) beside project-unknown (a meeting whose link was not said).
    hosts.meetings.add({ id: "m1", creator: ALICE });
    await makeMeetingEntry("m1", { minutes: 30 });
    await makeProjectEntry("p-hidden", { minutes: 60 });
    await makeDealEntry("d1", { minutes: 90 });
    hosts.fail("meetings.system-hosts", { status: 500 });

    const { groups } = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(groups).toEqual([
      { kind: "hidden", minutes: 60 },
      { kind: "project-unknown", minutes: 30 },
      { kind: "none", minutes: 90 },
    ]);
  });

  it("counts a meeting linked to a project id outside the id rule in `hidden`, never sends that id to projects-api, and does not disturb the projects around it (plan § Views)", async () => {
    // What meetings-api stores is not bounded by hours-api's id rule: 65 characters, a NUL, a comma, a space at either end.
    const OUTSIDE = ["x".repeat(65), "a\u0000b", "a,b", " p1", "p1 "];
    hosts.projects.setProject("p1", { label: "Project one" });
    hosts.meetings.add({ id: "m-ok", creator: ALICE });
    hosts.meetings.relinkProject("m-ok", "p1");
    await makeMeetingEntry("m-ok", { minutes: 30 });
    for (const [index, odd] of OUTSIDE.entries()) {
      hosts.meetings.add({ id: `m-odd-${index}`, creator: ALICE });
      hosts.meetings.relinkProject(`m-odd-${index}`, odd);
      await makeMeetingEntry(`m-odd-${index}`, { minutes: 30 });
    }

    const res = await totals(`groupBy=project&${NOVEMBER}`);

    expect(res.status).toBe(200);
    expect(res.json.groups).toEqual([keyed("p1", "Project one", 30), { kind: "hidden", minutes: 30 * OUTSIDE.length }]);
    expect(res.json.unavailable).toEqual([]);
    // The resolve was asked for the id inside the rule alone: the owner would have refused the whole batch for any other.
    expect(hosts.callsTo("projects.resolve")).toHaveLength(1);
    expect(hosts.callsTo("projects.resolve")[0]?.body).toEqual({ entityType: "project", ids: ["p1"] });
  });

  it("counts a meeting linked to an empty project id in `none`: it names nothing", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", "");
    await makeMeetingEntry("m1", { minutes: 30 });

    expect((await groupsOf(`groupBy=project&${NOVEMBER}`)).groups).toEqual([{ kind: "none", minutes: 30 }]);
    expect(hosts.callsTo("projects.resolve")).toEqual([]);
  });

  it("reads a system-route answer that ignored its filter as no answer: those meetings are `project-unknown`, `meeting-projects` is named, the total is whole", async () => {
    await fixture();
    // A route that returns something nobody asked about is not an answer to `ids=`: nothing is believed of the meetings.
    hosts.fail("meetings.system-hosts", {
      body: { items: [{ id: "some-other-meeting", host: { app: "projects", entityType: "project", entityId: "p1" } }] },
    });

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(answer.totalMinutes).toBe(510);
    expect(answer.unavailable).toEqual(["meeting-projects"]);
    expect(answer.groups.find((group) => group.kind === "project-unknown")).toEqual({ kind: "project-unknown", minutes: 300 });
  });

  it("adds up the meetings of a period however many: more than the 100 ids meetings-api takes in one call", async () => {
    hosts.projects.setProject("p1", { label: "Project one" });
    for (let index = 0; index < 130; index++) {
      const id = `many-${String(index).padStart(3, "0")}`;
      hosts.meetings.add({ id, creator: ALICE });
      hosts.meetings.relinkProject(id, "p1");
      await makeMeetingEntry(id, { minutes: 30 });
    }

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}`);

    expect(answer).toEqual({ totalMinutes: 130 * 30, groups: [keyed("p1", "Project one", 130 * 30)], unavailable: [] });
    expect(hosts.callsTo("meetings.system-hosts").length).toBe(2);
  });

  it("asks meetings-api once with its own credential for the projects of the meetings, projects-api once as the viewer for every project, and never crm-api", async () => {
    await fixture();

    await groupsOf(`groupBy=project&${NOVEMBER}`);

    const system = hosts.callsTo("meetings.system-hosts");
    expect(system).toHaveLength(1);
    expect(system[0]?.query.has("ids")).toBe(true);
    expect(system[0]?.authorization).not.toBe(await bearerOf("alice"));
    expect(claimsOf(system[0]?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", scope: "meetings.hosts.read" });
    // The project of an entry and the projects of the meetings go out together, each once, as the viewer.
    const resolves = hosts.callsTo("projects.resolve");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]?.authorization).toBe(await bearerOf("alice"));
    expect([...((resolves[0]?.body as { ids: string[] }).ids)].sort()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(hosts.callsTo("crm.resolve")).toEqual([]);
  });

  it("asks nobody when no entry is on a project or a meeting", async () => {
    await makeNoEntityEntry(TRAINING, { minutes: 60 });
    await makeDealEntry("d1", { minutes: 30 });

    expect(await groupsOf(`groupBy=project&${NOVEMBER}`)).toEqual({ totalMinutes: 90, groups: [{ kind: "none", minutes: 90 }], unavailable: [] });
    expect(hosts.calls).toEqual([]);
  });

  it("asks meetings-api only: a period with meeting entries and no project entry needs no projects-api call when no meeting is linked to a project", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    await makeMeetingEntry("m1", { minutes: 30 });

    expect(await groupsOf(`groupBy=project&${NOVEMBER}`)).toEqual({ totalMinutes: 30, groups: [{ kind: "none", minutes: 30 }], unavailable: [] });
    expect(hosts.callsTo("projects.resolve")).toEqual([]);
    expect(hosts.callsTo("meetings.system-hosts")).toHaveLength(1);
  });

  it("names no project the viewer cannot read: no id and no name of it anywhere in the answer, a meeting's link included (AC-4.7, AC-4.10)", async () => {
    hosts.projects.setProject("p-secret", { label: "Secret reorganisation" });
    hosts.projects.setReader(ALICE, false);
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", "p-secret");
    await makeMeetingEntry("m1", { minutes: 60 });
    await makeProjectEntry("p-secret", { minutes: 30 });

    const res = await totals(`groupBy=project&${NOVEMBER}`);

    expect(res.status).toBe(200);
    expect(res.json.groups).toEqual([{ kind: "hidden", minutes: 90 }]);
    expect(res.text).not.toMatch(/p-secret|Secret reorganisation/);
  });
});

describe("groupBy=deal is not changed by a meeting linked to a project (A50)", () => {
  it("counts a project's linked meeting under `none`, asks crm-api and the meetings' links and never projects-api, and names only `meeting-deals` when it fails", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    hosts.crm.setDeal("d1", { label: "Deal one" });
    await makeMeetingEntry("m1", { minutes: 60 });
    await makeDealEntry("d1", { minutes: 30 });

    expect(await groupsOf(`groupBy=deal&${NOVEMBER}`)).toEqual({
      totalMinutes: 90,
      groups: [keyed("d1", "Deal one", 30), { kind: "none", minutes: 60 }],
      unavailable: [],
    });
    expect(hosts.callsTo("projects.resolve")).toEqual([]);

    hosts.fail("meetings.system-hosts", { status: 500 });
    expect((await groupsOf(`groupBy=deal&${NOVEMBER}`)).unavailable).toEqual(["meeting-deals"]);
  });
});

describe("the project filter, in every grouping (AC-4.4, AC-4.8; plan § The hours views)", () => {
  const OUTAGES: Array<[string, () => void]> = [
    ["answering 500", () => hosts.fail("meetings.system-hosts", { status: 500 })],
    ["a route that is not deployed yet (404)", () => hosts.fail("meetings.system-hosts", { status: 404 })],
    ["a meetings-api that predates the filter and refuses `projectId` (422)", () => hosts.fail("meetings.system-hosts", { status: 422 })],
    ["a body that is not the route's shape", () => hosts.fail("meetings.system-hosts", { malformed: true })],
    ["a connection that cannot be made", () => hosts.sever("meetings")],
    ["no credential: auth would not mint one", () => hosts.fail("auth.service-token", { status: 500 })],
  ];
  const GROUPINGS = ["person", "project", "deal", "category", "month", "day"];

  /** A project, a meeting linked to it, and entries on both, plus a meeting and a project entry that are not its own: 180 minutes are the project's. */
  async function fixture() {
    hosts.projects.setProject("p1", { label: "Project one" });
    hosts.projects.setProject("p2", { label: "Project two" });
    for (const id of ["m1", "m2"]) hosts.meetings.add({ id, creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    hosts.meetings.relinkProject("m2", "p2");
    await makeProjectEntry("p1", { day: "2026-11-02", minutes: 120 });
    await makeMeetingEntry("m1", { day: "2026-11-03", minutes: 60 });
    await makeProjectEntry("p2", { day: "2026-11-04", minutes: 30 });
    await makeMeetingEntry("m2", { day: "2026-11-05", minutes: 90 });
    await makeNoEntityEntry(TRAINING, { day: "2026-11-06", minutes: 60 });
  }

  it("counts the project's own entries and the entries on the meetings linked to it, in every grouping", async () => {
    await fixture();

    for (const groupBy of GROUPINGS) {
      const answer = await groupsOf(`groupBy=${groupBy}&${NOVEMBER}&projectId=p1`);
      expect({ groupBy, totalMinutes: answer.totalMinutes }).toEqual({ groupBy, totalMinutes: 180 });
      expect({ groupBy, sum: answer.groups.reduce((sum, group) => sum + group.minutes, 0) }).toEqual({ groupBy, sum: 180 });
    }
    // By day, the newest first: the meeting's day (3 November) and the project's (2 November).
    expect((await groupsOf(`groupBy=day&${NOVEMBER}&projectId=p1`)).groups).toEqual([keyed("2026-11-03", null, 60), keyed("2026-11-02", null, 120)]);
  });

  it("groups the project's hours under it when grouped by project, the meetings' included, and nothing else", async () => {
    await fixture();

    expect(await groupsOf(`groupBy=project&${NOVEMBER}&projectId=p1`)).toEqual({ totalMinutes: 180, groups: [keyed("p1", "Project one", 180)], unavailable: [] });
  });

  it("moves a meeting's hours with the link: a relink in meetings-api moves them from one project's totals to the other's", async () => {
    await fixture();
    expect((await groupsOf(`groupBy=day&${NOVEMBER}&projectId=p1`)).totalMinutes).toBe(180);
    expect((await groupsOf(`groupBy=day&${NOVEMBER}&projectId=p2`)).totalMinutes).toBe(120);

    hosts.meetings.relinkProject("m1", "p2");

    expect((await groupsOf(`groupBy=day&${NOVEMBER}&projectId=p1`)).totalMinutes).toBe(120);
    expect((await groupsOf(`groupBy=day&${NOVEMBER}&projectId=p2`)).totalMinutes).toBe(180);
  });

  it("asks meetings-api only the one question for a grouping that needs no project: the meetings of the project", async () => {
    await fixture();

    await groupsOf(`groupBy=day&${NOVEMBER}&projectId=p1`);

    expect(hosts.callsTo("meetings.system-hosts").map((recorded) => recorded.query.get("projectId"))).toEqual(["p1"]);
    expect(hosts.callsTo("projects.resolve")).toEqual([]);
  });

  it.each(OUTAGES)("is a 503 host_unavailable with no groups, in every grouping, however meetings-api is down: %s", async (_what, breakIt) => {
    await fixture();
    breakIt();

    for (const groupBy of GROUPINGS) {
      const res = await totals(`groupBy=${groupBy}&${NOVEMBER}&projectId=p1`);
      expect({ groupBy, status: res.status, code: res.json?.code }).toEqual({ groupBy, status: 503, code: "host_unavailable" });
      expect(res.json).not.toHaveProperty("groups");
      expect(res.json).not.toHaveProperty("totalMinutes");
    }
  });

  it("refuses even when the project has no entries at all, and answers again, whole, once meetings-api does", async () => {
    hosts.fail("meetings.system-hosts", { status: 500 });
    expect((await totals(`groupBy=day&${NOVEMBER}&projectId=p1`)).status).toBe(503);

    hosts.heal("meetings.system-hosts");

    expect(await groupsOf(`groupBy=day&${NOVEMBER}&projectId=p1`)).toEqual({ totalMinutes: 0, groups: [], unavailable: [] });
  });

  it("is only the project filter: the same outage without it still answers, the meetings in `project-unknown` and `meeting-projects` named (AC-4.10)", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500 });

    const byProject = await groupsOf(`groupBy=project&${NOVEMBER}`);
    expect(byProject.totalMinutes).toBe(360);
    expect(byProject.unavailable).toEqual(["meeting-projects"]);
    expect(byProject.groups.find((group) => group.kind === "project-unknown")).toEqual({ kind: "project-unknown", minutes: 150 });

    // A grouping that reads no project is whole and names nothing.
    for (const groupBy of ["person", "category", "month", "day"]) {
      const answer = await groupsOf(`groupBy=${groupBy}&${NOVEMBER}`);
      expect({ groupBy, totalMinutes: answer.totalMinutes, unavailable: answer.unavailable }).toEqual({ groupBy, totalMinutes: 360, unavailable: [] });
    }
  });

  it("when the link is known for the filter but fails a moment later, by project, keeps the total and names `meeting-projects` (the second question is its own)", async () => {
    await fixture();
    hosts.fail("meetings.system-hosts", { status: 500, after: 1 });

    const answer = await groupsOf(`groupBy=project&${NOVEMBER}&projectId=p1`);

    expect(answer).toEqual({
      totalMinutes: 180,
      groups: [keyed("p1", "Project one", 120), { kind: "project-unknown", minutes: 60 }],
      unavailable: ["meeting-projects"],
    });
  });
});
