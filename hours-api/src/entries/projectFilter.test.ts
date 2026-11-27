/**
 * The `projectId` filter counts the meetings currently linked to the project (specs/20261112-project-hours T8; AC-4.1, AC-4.2, AC-4.4,
 * AC-4.8, AC-4.9; plan § The hours views "Filter", § Deploy order R2; ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route
 * amendment of 2026-11-26), through the ASSEMBLED app, against the real database and the fake owners of T11.
 *
 * It is the deal filter's twin (src/entries/list.test.ts "the dealId filter counts the meetings currently linked to the deal"): the entries on the
 * project itself, plus the entries on the meetings meetings-api says are linked to it NOW, read with hours-api's own credential. The link is
 * not stored on an entry, so a relink moves the hours; and meetings-api that cannot say is a refusal, never a lower figure.
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
  makeDealEntry,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  resetWorld,
  type PersonaName,
} from "../test-support/world";
import { claimsOf, startHosts } from "../test-support/hosts";
import { dealMeetingsKey, projectMeetingsKey } from "./filters";
import { __setClockForTests } from "./today";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** A period that holds every day these tests use. */
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

/** `GET /time-entries?<query>` as `as`. The query is sent exactly as written. */
const list = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries?${query}`, { as });

type Item = { id: string; day: string };
const idsOf = (res: { json: { items: Item[] } }): string[] => res.json.items.map((item) => item.id);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expectInvalid = (res: { status: number; json: any }, field: string) => {
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ code: "invalid_request", field });
};

describe("the projectId filter counts the meetings currently linked to the project (AC-4.1, AC-4.2, AC-4.4)", () => {
  /** Two projects, three meetings (m1 → p1, m2 → p2, m3 → none), and an entry of alice's on each, project p1 and p2 included. */
  async function fixture() {
    for (const id of ["m1", "m2", "m3"]) hosts.meetings.add({ id, creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    hosts.meetings.relinkProject("m2", "p2");
    hosts.projects.setProject("p1", { label: "Project one" });
    hosts.projects.setProject("p2", { label: "Project two" });
    return {
      p1: await makeProjectEntry("p1", { day: "2026-11-02" }),
      p2: await makeProjectEntry("p2", { day: "2026-11-03" }),
      m1: await makeMeetingEntry("m1", { day: "2026-11-04" }),
      m2: await makeMeetingEntry("m2", { day: "2026-11-05" }),
      m3: await makeMeetingEntry("m3", { day: "2026-11-06" }),
      deal: await makeDealEntry("d1", { day: "2026-11-07" }),
    };
  }

  const forProject = async (projectId: string, extra = "") => idsOf(await list(`${NOVEMBER}&projectId=${projectId}${extra}`));

  it("lists the entries on the project plus those on the meetings linked to it, and no others", async () => {
    const e = await fixture();

    expect(await forProject("p1")).toEqual([e.m1.id, e.p1.id]);
    expect(await forProject("p2")).toEqual([e.m2.id, e.p2.id]);
    expect(await forProject("no-such-project")).toEqual([]);
  });

  it("counts a linked meeting's entry whoever recorded it, and whether or not they are on the project's team (AC-4.1)", async () => {
    const e = await fixture();
    hosts.meetings.add({ id: "m4", creator: BOB });
    hosts.meetings.relinkProject("m4", "p1");
    // Bob took part in a meeting about p1 and is on no team of it: his hours on the meeting count for the project all the same.
    const bobs = await makeMeetingEntry("m4", { userId: BOB, day: "2026-11-08" });
    hosts.projects.setProject("p1", { label: "Project one", assignees: [ALICE] });

    // `whose=all` is the oversight path: bob's entry is listed for a holder, and counts for the project.
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    const res = await list(`${NOVEMBER}&projectId=p1&whose=all`, "holder");

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([bobs.id, e.m1.id, e.p1.id]);
  });

  it("moves the hours of a meeting when the meeting is relinked: nothing about the project is stored on the entry (AC-4.2)", async () => {
    const e = await fixture();
    expect(await forProject("p1")).toEqual([e.m1.id, e.p1.id]);

    // To another project: from the next read, p1 no longer counts it and p2 does.
    hosts.meetings.relinkProject("m1", "p2");
    expect(await forProject("p1")).toEqual([e.p1.id]);
    expect(await forProject("p2")).toEqual([e.m2.id, e.m1.id, e.p2.id]);

    // To a deal: it counts for the deal's host only, for no project.
    hosts.meetings.relink("m1", "d1");
    expect(await forProject("p1")).toEqual([e.p1.id]);
    expect(await forProject("p2")).toEqual([e.m2.id, e.p2.id]);

    // Unlinked, then another meeting linked in its place.
    hosts.meetings.relink("m1", null);
    hosts.meetings.relinkProject("m3", "p1");
    expect(await forProject("p1")).toEqual([e.m3.id, e.p1.id]);
    expect(await forProject("p2")).toEqual([e.m2.id, e.p2.id]);
  });

  it("narrows with the other filters: the meeting must be the one asked for AND linked to the project", async () => {
    const e = await fixture();

    expect(await forProject("p1", "&meetingId=m1")).toEqual([e.m1.id]);
    expect(await forProject("p1", "&meetingId=m2")).toEqual([]);
    expect(await forProject("p1", "&target=meeting")).toEqual([e.m1.id]);
    expect(await forProject("p1", "&target=project")).toEqual([e.p1.id]);
    expect(await forProject("p1", "&target=deal")).toEqual([]);
  });

  it("never lists another person's entry on a linked meeting for whose=mine", async () => {
    const e = await fixture();
    await makeMeetingEntry("m1", { userId: BOB, day: "2026-11-04" });

    expect(await forProject("p1")).toEqual([e.m1.id, e.p1.id]);
  });

  it("walks the cursor across the project's own and the meetings' entries alike", async () => {
    const e = await fixture();

    const first = await list(`${NOVEMBER}&projectId=p1&limit=1`);
    expect(idsOf(first)).toEqual([e.m1.id]);
    expect(idsOf(await list(`${NOVEMBER}&projectId=p1&limit=1&cursor=${first.json.nextCursor}`))).toEqual([e.p1.id]);
  });

  it("refuses a later page 409 project_meetings_changed when the project's meetings changed since the first: a walk never mixes two sets", async () => {
    const e = await fixture();

    const first = await list(`${NOVEMBER}&projectId=p1&limit=1`);
    expect(idsOf(first)).toEqual([e.m1.id]);

    hosts.meetings.relinkProject("m3", "p1");
    const next = await list(`${NOVEMBER}&projectId=p1&limit=1&cursor=${first.json.nextCursor}`);
    expect(next.status).toBe(409);
    expect(next.json.code).toBe("project_meetings_changed");

    // Read again from the start, the walk is consistent with the new set.
    expect(await forProject("p1")).toEqual([e.m3.id, e.m1.id, e.p1.id]);
  });

  it("is also a 409 when the only meeting of the project is relinked away between pages", async () => {
    const e = await fixture();
    const first = await list(`${NOVEMBER}&projectId=p1&limit=1`);

    hosts.meetings.relinkProject("m1", null);

    const next = await list(`${NOVEMBER}&projectId=p1&limit=1&cursor=${first.json.nextCursor}`);
    expect(next.status).toBe(409);
    expect(next.json.code).toBe("project_meetings_changed");
    expect(await forProject("p1")).toEqual([e.p1.id]);
  });

  it("never takes a project-filtered cursor without the project filter, nor a plain cursor with it", async () => {
    await fixture();

    const withProject = await list(`${NOVEMBER}&projectId=p1&limit=1`);
    const plain = await list(`${NOVEMBER}&limit=1`);

    expectInvalid(await list(`${NOVEMBER}&cursor=${withProject.json.nextCursor}`), "cursor");
    expectInvalid(await list(`${NOVEMBER}&projectId=p1&cursor=${plain.json.nextCursor}`), "cursor");
  });

  it("never takes a deal's cursor for a project's, even when both name the same meetings (or none): the two keys are never equal", async () => {
    // A deal d9 and a project p9 with no linked meeting at all, and two entries each, so there is a second page.
    for (const day of ["2026-11-09", "2026-11-10"]) {
      await makeDealEntry("d9", { day });
      await makeProjectEntry("p9", { day });
    }

    const ofDeal = await list(`${NOVEMBER}&dealId=d9&limit=1`);
    const ofProject = await list(`${NOVEMBER}&projectId=p9&limit=1`);
    expect(typeof ofDeal.json.nextCursor).toBe("string");
    expect(typeof ofProject.json.nextCursor).toBe("string");

    const crossed = await list(`${NOVEMBER}&projectId=p9&limit=1&cursor=${ofDeal.json.nextCursor}`);
    expect(crossed.status).toBe(409);
    expect(crossed.json.code).toBe("project_meetings_changed");
    const crossedBack = await list(`${NOVEMBER}&dealId=d9&limit=1&cursor=${ofProject.json.nextCursor}`);
    expect(crossedBack.status).toBe(409);
    expect(crossedBack.json.code).toBe("deal_meetings_changed");
  });

  it("asks meetings-api once for the project's meetings, with hours-api's own credential and never the caller's", async () => {
    await fixture();
    const caller = await bearerOf("alice");

    await list(`${NOVEMBER}&projectId=p1`);

    const calls = hosts.callsTo("meetings.system-hosts").filter((recorded) => recorded.query.has("projectId"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("projectId")).toBe("p1");
    expect(calls[0]?.query.has("dealId")).toBe(false);
    expect(calls[0]?.authorization).not.toBe(caller);
    expect(claimsOf(calls[0]?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", scope: "meetings.hosts.read" });
    // Whatever the view asks of the system route afterwards is by ids, never a second question about the project.
    expect(hosts.callsTo("meetings.system-hosts").filter((recorded) => recorded.query.has("projectId"))).toHaveLength(1);
  });

  it("sends the project id exactly as given: what only needs escaping reaches meetings-api intact", async () => {
    const odd = "p&1#2+3%4 5";
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", odd);
    const meeting = await makeMeetingEntry("m1", { day: "2026-11-04" });

    expect(await forProject(encodeURIComponent(odd))).toEqual([meeting.id]);
    expect(hosts.callsTo("meetings.system-hosts")[0]?.query.get("projectId")).toBe(odd);
  });

  it("lists every meeting of a project with many: the answer is not paged and not capped", async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `many-${String(index).padStart(3, "0")}`);
    for (const id of ids) {
      hosts.meetings.add({ id, creator: ALICE });
      hosts.meetings.relinkProject(id, "p1");
    }
    await db.timeEntry.createMany({
      data: ids.map((id, index) => ({
        userId: ALICE,
        day: new Date(`2026-11-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`),
        minutes: 30,
        target: "meeting" as const,
        meetingId: id,
      })),
    });

    const res = await list(`${NOVEMBER}&projectId=p1&limit=500`);

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(130);
    expect(res.json.unavailable).toEqual([]);
  });

  it("counts only the meetings meetings-api says are linked to THIS project: an item linked elsewhere, to a deal, to none or to another host is not counted", async () => {
    const e = await fixture();
    await makeMeetingEntry("m4", { day: "2026-11-08" });
    await makeMeetingEntry("m5", { day: "2026-11-09" });
    // The route's answer is whatever meetings-api stores: here, items that are not this project's among its own.
    hosts.fail("meetings.system-hosts", {
      times: 1,
      body: {
        items: [
          { id: "m1", host: { app: "projects", entityType: "project", entityId: "p1" } },
          { id: "m2", host: { app: "projects", entityType: "project", entityId: "p2" } },
          { id: "m3", host: null },
          { id: "m4", host: { app: "crm", entityType: "deal", entityId: "p1" } },
          { id: "m5", host: { app: "testhost", entityType: "widget", entityId: "p1" } },
        ],
      },
    });

    expect(await forProject("p1")).toEqual([e.m1.id, e.p1.id]);
  });

  it("drops a meeting id outside the id rule from the question instead of sending it to the database", async () => {
    const e = await fixture();
    hosts.fail("meetings.system-hosts", {
      times: 1,
      body: {
        items: [
          { id: "m\u0000x", host: { app: "projects", entityType: "project", entityId: "p1" } },
          { id: "m1", host: { app: "projects", entityType: "project", entityId: "p1" } },
        ],
      },
    });

    const res = await list(`${NOVEMBER}&projectId=p1`);

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([e.m1.id, e.p1.id]);
  });

  it("does not count a deal's linked meeting for the project, nor a project's for the deal (A50): a meeting has one host", async () => {
    const e = await fixture();
    hosts.meetings.relink("m3", "d1");
    hosts.crm.setDeal("d1", { label: "Deal one" });

    expect(await forProject("p1")).toEqual([e.m1.id, e.p1.id]);
    // The deal's own list holds the deal entry and the meeting linked to the deal (newest day first), and none of the project's.
    expect(idsOf(await list(`${NOVEMBER}&dealId=d1`))).toEqual([e.deal.id, e.m3.id]);
  });
});

describe("a query naming a deal and a project asks for both sets, and its cursor carries both keys", () => {
  it("is the entries that are on the deal's side AND on the project's side: none, since an entry has one target", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    await makeProjectEntry("p1", { day: "2026-11-02" });
    await makeDealEntry("d1", { day: "2026-11-03" });
    await makeMeetingEntry("m1", { day: "2026-11-04" });

    const res = await list(`${NOVEMBER}&projectId=p1&dealId=d1`);

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([]);
    // Both questions were put to meetings-api, one each.
    const asked = hosts.callsTo("meetings.system-hosts").map((recorded) => (recorded.query.has("projectId") ? "projectId" : "dealId")).sort();
    expect(asked).toEqual(["dealId", "projectId"]);
  });

  it("is refused 503 when either of the two cannot be said", async () => {
    hosts.fail("meetings.system-hosts", { status: 500, after: 1 });

    expect((await list(`${NOVEMBER}&projectId=p1&dealId=d1`)).status).toBe(503);
  });

  it("reads a cursor of five parts, the deal's key before the project's, and refuses either key that is no longer the set's", async () => {
    // No query of both filters ever has a second page (an entry has one target), so the cursor is made by hand, as hours-api would.
    const at = (deal: string, project: string) =>
      Buffer.from(`2026-11-05|${String(Date.parse("2026-11-05T10:00:00Z"))}|cmhw3q0a10000x2k9|${deal}|${project}`, "utf8").toString("base64url");
    const dealKey = dealMeetingsKey([]);
    const projectKey = projectMeetingsKey([]);
    const query = `${NOVEMBER}&projectId=p1&dealId=d1&limit=1`;

    expect((await list(`${query}&cursor=${at(dealKey, projectKey)}`)).status).toBe(200);
    const wrongDeal = await list(`${query}&cursor=${at(projectKey, projectKey)}`);
    expect(wrongDeal.status).toBe(409);
    expect(wrongDeal.json.code).toBe("deal_meetings_changed");
    const wrongProject = await list(`${query}&cursor=${at(dealKey, dealKey)}`);
    expect(wrongProject.status).toBe(409);
    expect(wrongProject.json.code).toBe("project_meetings_changed");
    // Four parts under two filters are not a cursor this API minted.
    const four = Buffer.from(`2026-11-05|${String(Date.parse("2026-11-05T10:00:00Z"))}|cmhw3q0a10000x2k9|${dealKey}`, "utf8").toString("base64url");
    expectInvalid(await list(`${query}&cursor=${four}`), "cursor");
  });
});

describe("while meetings-api cannot say which meetings are linked, the project filter refuses (AC-4.8, plan R2)", () => {
  const OUTAGES: Array<[string, () => void]> = [
    ["answering 500", () => hosts.fail("meetings.system-hosts", { status: 500 })],
    ["answering 503", () => hosts.fail("meetings.system-hosts", { status: 503 })],
    ["answering 401 to the credential, even after a fresh one", () => hosts.fail("meetings.system-hosts", { status: 401 })],
    ["a route that is not deployed yet (404)", () => hosts.fail("meetings.system-hosts", { status: 404 })],
    ["a meetings-api that predates the filter and refuses `projectId` (422)", () => hosts.fail("meetings.system-hosts", { status: 422 })],
    ["a good answer under another status", () => hosts.fail("meetings.system-hosts", { withStatus: 203 })],
    ["slower than 2 s", () => hosts.fail("meetings.system-hosts", { delayMs: 2_600 })],
    ["a redirect", () => hosts.fail("meetings.system-hosts", { redirect: true })],
    ["a body that is not JSON", () => hosts.fail("meetings.system-hosts", { rawBody: "not json" })],
    ["a body that is not the route's shape", () => hosts.fail("meetings.system-hosts", { malformed: true })],
    ["a connection that cannot be made", () => hosts.sever("meetings")],
    ["no credential: auth would not mint one", () => hosts.fail("auth.service-token", { status: 500 })],
  ];

  it.each(OUTAGES)("is a 503 host_unavailable with no items, however it is down: %s", async (_what, breakIt) => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    await makeProjectEntry("p1", { day: "2026-11-02" });
    await makeMeetingEntry("m1", { day: "2026-11-04" });
    breakIt();

    const res = await list(`${NOVEMBER}&projectId=p1`);

    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "host_unavailable", status: 503 });
    // Nothing partial: not the project's own entries, not an empty page, no cursor, no list of what was unavailable.
    expect(res.json).not.toHaveProperty("items");
    expect(res.json).not.toHaveProperty("nextCursor");
    expect(res.json).not.toHaveProperty("unavailable");
  });

  it("refuses even when the project has no entries at all, and a page that would have been empty is not an empty page", async () => {
    hosts.fail("meetings.system-hosts", { status: 500 });

    expect((await list(`${NOVEMBER}&projectId=p1`)).status).toBe(503);
  });

  it("says it is the project's hours that are not shown, not the deal's", async () => {
    hosts.fail("meetings.system-hosts", { status: 500 });

    const res = await list(`${NOVEMBER}&projectId=p1`);

    expect(res.json.detail).toContain("project");
    expect(res.json.detail).not.toContain("deal");
  });

  it("answers again, whole, once meetings-api does", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    const meeting = await makeMeetingEntry("m1", { day: "2026-11-04" });
    hosts.fail("meetings.system-hosts", { status: 500 });
    expect((await list(`${NOVEMBER}&projectId=p1`)).status).toBe(503);

    hosts.heal("meetings.system-hosts");

    expect(idsOf(await list(`${NOVEMBER}&projectId=p1`))).toEqual([meeting.id]);
  });

  it("refuses a later page too, when meetings-api stops answering between pages: nothing partial", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relinkProject("m1", "p1");
    await makeProjectEntry("p1", { day: "2026-11-02" });
    await makeMeetingEntry("m1", { day: "2026-11-04" });
    const first = await list(`${NOVEMBER}&projectId=p1&limit=1`);
    expect(first.status).toBe(200);

    hosts.fail("meetings.system-hosts", { status: 500 });
    const next = await list(`${NOVEMBER}&projectId=p1&limit=1&cursor=${first.json.nextCursor}`);

    expect(next.status).toBe(503);
    expect(next.json).toMatchObject({ code: "host_unavailable" });
    expect(next.json).not.toHaveProperty("items");
  });

  it("is only the project filter: without it the same outage lists every entry, a meeting's deal and project unknown and both sources named (AC-4.10)", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, title: "Kick-off" });
    hosts.meetings.relinkProject("m1", "p1");
    const meeting = await makeMeetingEntry("m1", { day: "2026-11-04" });
    const training = await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-05" });
    hosts.fail("meetings.system-hosts", { status: 500 });

    const res = await list(NOVEMBER);

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([training.id, meeting.id]);
    expect(res.json.unavailable).toEqual(["meeting-deals", "meeting-projects"]);
    expect(res.json.items.find((item: Item) => item.id === meeting.id)).toMatchObject({
      on: { type: "meeting", id: "m1", deal: { state: "unknown" }, project: { state: "unknown" } },
    });
  });
});

describe("the project filter, as the viewer reads the entries (AC-4.7, AC-4.10)", () => {
  it("lists a linked meeting's entry with the project it counts for, and withholds it from a viewer who cannot read the project", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, title: "Kick-off" });
    hosts.meetings.relinkProject("m1", "p1");
    hosts.projects.setProject("p1", { label: "Project one" });
    const meeting = await makeMeetingEntry("m1", { day: "2026-11-04" });

    const visible = await list(`${NOVEMBER}&projectId=p1`);
    expect(visible.json.items[0]).toMatchObject({ id: meeting.id, on: { type: "meeting", project: { state: "linked", visibility: "visible", id: "p1", label: "Project one" } } });

    // The filter names the project by the caller's own request; what the answer tells is still decided by the viewer's right to read it.
    hosts.projects.setReader(ALICE, false);
    const hidden = await list(`${NOVEMBER}&projectId=p1`);
    expect(hidden.status).toBe(200);
    expect(hidden.json.items[0].on.project).toEqual({ state: "linked", visibility: "hidden" });
    expect(JSON.stringify(hidden.json.items[0].on.project)).not.toMatch(/p1|Project one/);
  });
});
