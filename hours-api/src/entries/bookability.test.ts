/**
 * Whether the caller may book hours on a project or a meeting, and the change rule of AC-2.12 (specs/029 T15;
 * AC-1.4, AC-2.1, AC-2.2, AC-2.4, AC-2.5, AC-2.10, AC-2.11, AC-2.12; plan § Sequences, § Entries "The id rule",
 * § Reading the owners' list answers; ADR-0089), through the ASSEMBLED app, against the real database and the
 * fake owners of T11.
 *
 * The owner answers, as the CALLER, whether the person may book: projects-api's host resolve (`assignees`),
 * meetings-api's own list (`ids`: the caller's own meetings). hours-api keeps no copy and decides nothing about
 * who is on what. Nothing is ever recorded unchecked: an owner that does not answer is 503, never "yes" and
 * never "no".
 *
 * "No bookability call" on a change is proved by the SAVE SUCCEEDING while the owner is down or says the
 * person may not read: the view a write returns resolves its labels as the viewer, so the fake does record a
 * label call even then (re-sync 2026-11-13, T14) — and that call fails soft, a bookability call would not.
 *
 * Deals and the activity pointer are T16's (src/entries/deals.test.ts, activityPointer.test.ts).
 *
 * Time is fixed at 2026-11-13 10:00Z. Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PERSONAS,
  SEED,
  bearerOf,
  call,
  db,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  makeWorkType,
  resetWorld,
  type PersonaName,
} from "../test-support/world";
import { startHosts, type FailureMode } from "../test-support/hosts";
import { __setClockForTests } from "./today";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const NOW = "2026-11-13T10:00:00Z";
const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date(NOW));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

const project = (id: string) => ({ type: "project", id });
const meeting = (id: string) => ({ type: "meeting", id });
const body = (on: unknown, over: Record<string, unknown> = {}) => ({ day: "2026-11-12", minutes: 60, on, ...over });

const post = (payload: unknown, as: PersonaName | null = "alice") => call("POST", "/time-entries", { as, body: payload });
const patch = (id: string, payload: unknown, as: PersonaName | null = "alice") => call("PATCH", `/time-entries/${id}`, { as, body: payload });
const remove = (id: string) => call("DELETE", `/time-entries/${id}`);

const entryRows = () => db.timeEntry.findMany({ orderBy: { createdAt: "asc" } });
const rowOf = (id: string) => db.timeEntry.findUniqueOrThrow({ where: { id } });

/** What an owner that does not answer looks like (AC-2.11): none of these may pass for "yes" or for "no". */
const OWNER_FAILURES: ReadonlyArray<readonly [string, FailureMode]> = [
  ["answers 500", { status: 500 }],
  ["answers 404, a route it has not deployed", { status: 404 }],
  ["answers 422, a version that predates the contract", { status: 422 }],
  ["answers a good body under another 2xx status", { withStatus: 203 }],
  ["breaks its contract", { malformed: true }],
  ["answers text that is not JSON", { rawBody: "<html>bad gateway</html>" }],
  ["redirects", { redirect: true }],
];

/** The 503 of a write whose check could not be made. */
const expectHostUnavailable = (res: { status: number; json: any }) => {
  expect(res.status).toBe(503);
  expect(res.json).toMatchObject({ status: 503, code: "host_unavailable" });
};

describe("POST /time-entries on a project (AC-2.2, AC-2.11)", () => {
  it("accepts the project manager and the team, in every project state: `writable: false` is ignored (A12)", async () => {
    hosts.projects.setProject("p-open", { label: "Apollo", assignees: [BOB, ALICE] });
    hosts.projects.setProject("p-closed", { label: "Gemini", writable: false, assignees: [ALICE] });

    for (const id of ["p-open", "p-closed"]) {
      const res = await post(body(project(id), { workTypeId: SEED.workTypes.project.development }));
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ on: { type: "project", id, visibility: "visible" }, person: { id: ALICE } });
    }
    expect(await entryRows()).toMatchObject([{ projectId: "p-open", userId: ALICE }, { projectId: "p-closed", userId: ALICE }]);
  });

  it("asks projects-api AS THE CALLER, first, for that one project: the caller's own token, no other credential", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    expect((await post(body(project("p1")))).status).toBe(201);

    const [first, ...rest] = hosts.callsTo("projects.resolve");
    // The first call is the check; the view's label may be a second one, never another credential.
    expect(first?.body).toEqual({ entityType: "project", ids: ["p1"] });
    for (const recorded of [first!, ...rest]) expect(recorded.authorization).toBe(await bearerOf("alice"));
    expect(hosts.calls.every((recorded) => recorded.route !== "meetings.system-hosts" && recorded.route !== "crm.resolve")).toBe(true);
  });

  it("refuses a project the caller can read but is not on with 403 not_on_project, and writes nothing", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });
    // A project that is still waiting for its project manager answers its team only: still not the caller.
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [] });

    for (const id of ["p1", "p2"]) {
      const res = await post(body(project(id)));
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ code: "not_on_project" });
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("answers 404 not_found, one body, for a project the caller may not read, one that does not exist and an unknown id (AC-2.10)", async () => {
    hosts.projects.setProject("p-secret", { label: "Secret", assignees: [ALICE] });
    hosts.projects.setReader(ALICE, false); // no `projects:access`: nothing is readable, the project included
    const unreadable = await post(body(project("p-secret")));
    const unreadableToo = await post(body(project("p-nobody")));

    hosts.projects.setReader(ALICE, true);
    const missing = await post(body(project("p-nobody")));
    const noSuchId = await post(body(project("a-well-formed-id-no-owner-knows")));

    expect(unreadable.status).toBe(404);
    expect(unreadable.json).toMatchObject({ status: 404, code: "not_found" });
    for (const other of [unreadableToo, missing, noSuchId]) expect(other.text).toBe(unreadable.text);
    expect(await entryRows()).toHaveLength(0);
  });

  it("sends an id with `&`, `#`, `+`, `%` or an inner space to the owner exactly as given, and an unknown one is the same 404", async () => {
    const id = "a&b#c+d%e f";
    const res = await post(body(project(id)));
    expect(res.status).toBe(404);
    expect(hosts.callsTo("projects.resolve")[0]?.body).toEqual({ entityType: "project", ids: [id] });
  });

  it.each(OWNER_FAILURES)("is 503 host_unavailable when projects-api %s: nothing is recorded, never accepted unchecked", async (_name, mode) => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.fail("projects.resolve", mode);
    expectHostUnavailable(await post(body(project("p1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 host_unavailable when projects-api is unreachable", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.sever("projects");
    expectHostUnavailable(await post(body(project("p1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 host_unavailable when projects-api is slower than its 2 s", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.fail("projects.resolve", { delayMs: 2_600 });
    expectHostUnavailable(await post(body(project("p1"))));
    expect(await entryRows()).toHaveLength(0);
  }, 10_000);

  it("is 503, not 404, when projects-api answers `reader: true` and leaves the asked project out", async () => {
    hosts.fail("projects.resolve", { body: { reader: true, items: [] } });
    expectHostUnavailable(await post(body(project("p1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 when projects-api says the project is open but does not say who is on it: absent is not nobody", async () => {
    hosts.fail("projects.resolve", { body: { reader: true, items: [{ id: "p1", state: "open", writable: true, label: "Apollo", href: "/projects/p1" }] } });
    expectHostUnavailable(await post(body(project("p1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("accepts 6 h on an internal project and 6 h on a client project on the same day: the contractual day is no limit (AC-1.4)", async () => {
    hosts.projects.setProject("p-internal", { label: "Operai", assignees: [ALICE] });
    hosts.projects.setProject("p-client", { label: "Client work", assignees: [ALICE] });

    for (const id of ["p-internal", "p-client"]) expect((await post(body(project(id), { minutes: 360 }))).status).toBe(201);
    expect(await entryRows()).toMatchObject([
      { projectId: "p-internal", minutes: 360 },
      { projectId: "p-client", minutes: 360 },
    ]);
  });

  it("asks nothing of an owner for hours on no entity", async () => {
    expect((await post(body({ type: "none", categoryId: SEED.categories.training }))).status).toBe(201);
    expect(hosts.callsTo("projects.resolve")).toHaveLength(0);
    expect(hosts.callsTo("meetings.list")).toHaveLength(0);
  });
});

describe("an author who is no longer on the project (AC-2.4)", () => {
  it("keeps the entry as it was, and can still delete it: deleting asks no owner", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const created = await post(body(project("p1"), { minutes: 90, note: "Kick-off" }));
    expect(created.status).toBe(201);

    // Removed from the team afterwards, and the project may even be unreadable and the owner down.
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });
    hosts.fail("projects.resolve", { status: 500 });
    expect(await rowOf(created.json.id)).toMatchObject({ projectId: "p1", minutes: 90, note: "Kick-off", userId: ALICE });

    const callsBefore = hosts.calls.length;
    const deleted = await remove(created.json.id);
    expect(deleted.status).toBe(204);
    expect(await entryRows()).toHaveLength(0);
    expect(hosts.calls).toHaveLength(callsBefore); // a delete asks no owner at all
  });

  it("does the same for a meeting the author is no longer one of the people of, meetings-api down", async () => {
    const entry = await makeMeetingEntry("m1", { minutes: 60 });
    hosts.fail("meetings.list", { status: 500 });
    hosts.fail("meetings.system-hosts", { status: 500 });

    expect(await rowOf(entry.id)).toMatchObject({ meetingId: "m1", minutes: 60 });
    const deleted = await remove(entry.id);
    expect(deleted.status).toBe(204);
    expect(hosts.calls).toHaveLength(0);
  });
});

describe("POST /time-entries on a meeting (AC-2.5, AC-2.10, AC-2.11)", () => {
  it("accepts the meeting's creator and its Operai participants", async () => {
    hosts.meetings.add({ id: "m-mine", creator: ALICE });
    hosts.meetings.add({ id: "m-invited", creator: BOB, participants: [ALICE] });

    for (const id of ["m-mine", "m-invited"]) {
      const res = await post(body(meeting(id), { note: "Sprint planning" }));
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ on: { type: "meeting", id }, workType: null, activity: null, person: { id: ALICE } });
    }
    expect(await entryRows()).toMatchObject([{ meetingId: "m-mine", userId: ALICE, target: "meeting" }, { meetingId: "m-invited", userId: ALICE }]);
  });

  it("asks meetings-api AS THE CALLER for that one meeting, through its own list: the caller's token, never the system route", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    expect((await post(body(meeting("m1")))).status).toBe(201);

    const [first, ...rest] = hosts.callsTo("meetings.list");
    expect(first?.query.get("ids")).toBe("m1");
    // One id fits page 1: no `page`, and no other filter that could narrow the answer.
    expect([...first!.query.keys()]).toEqual(["ids"]);
    for (const recorded of [first!, ...rest]) expect(recorded.authorization).toBe(await bearerOf("alice"));
  });

  it("refuses a meeting the caller is not one of the people of with 404, as for one that does not exist: a host-only reader included (AC-2.10)", async () => {
    // The fake's list holds creator and participants only, as meetings-api's does: a person who can read the
    // meeting through its host (the CRM deal page) is never in it, so the check cannot be passed that way.
    hosts.meetings.add({ id: "m-theirs", creator: BOB, participants: [PERSONAS.carol.sub], dealId: "d1" });

    const notOnIt = await post(body(meeting("m-theirs")));
    const unknown = await post(body(meeting("m-nobody")));
    const wellFormedUnknown = await post(body(meeting("a-well-formed-id-no-owner-knows")));

    expect(notOnIt.status).toBe(404);
    expect(notOnIt.json).toMatchObject({ status: 404, code: "not_found" });
    for (const other of [unknown, wellFormedUnknown]) expect(other.text).toBe(notOnIt.text);
    expect(await entryRows()).toHaveLength(0);
  });

  it("never takes a host reader's row for a way to book, if an owner ever lists one: only a creator or a participant is", async () => {
    hosts.fail("meetings.list", { body: { items: [{ id: "m1", title: "Kick-off", role: "host_reader" }], total: 1, page: 1, pageSize: 25 } });
    const res = await post(body(meeting("m1")));
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "not_found" });
    expect(await entryRows()).toHaveLength(0);
  });

  it("answers the same 404 body for a meeting and a project: nothing names the kind of target", async () => {
    hosts.meetings.add({ id: "m-theirs", creator: BOB });
    const meetingMiss = await post(body(meeting("m-theirs")));
    const projectMiss = await post(body(project("p-nobody")));
    expect(projectMiss.text).toBe(meetingMiss.text);
  });

  it("sends an id with `&`, `#`, `+`, `%` or an inner space to the owner exactly as given, and an unknown one is the same 404", async () => {
    const id = "a&b#c+d%e f";
    const res = await post(body(meeting(id)));
    expect(res.status).toBe(404);
    expect(hosts.callsTo("meetings.list")[0]?.query.get("ids")).toBe(id);
  });

  it("refuses a work type on a meeting with 422 before any owner is asked (AC-2.1)", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    const res = await post(body(meeting("m1"), { workTypeId: SEED.workTypes.project.development }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "work_type_not_allowed" });
    expect(hosts.calls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
  });

  it.each(OWNER_FAILURES)("is 503 host_unavailable when meetings-api %s: nothing is recorded", async (_name, mode) => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.fail("meetings.list", mode);
    expectHostUnavailable(await post(body(meeting("m1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 host_unavailable when meetings-api is unreachable", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.sever("meetings");
    expectHostUnavailable(await post(body(meeting("m1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 host_unavailable when meetings-api is slower than its 2 s", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.fail("meetings.list", { delayMs: 2_600 });
    expectHostUnavailable(await post(body(meeting("m1"))));
    expect(await entryRows()).toHaveLength(0);
  }, 10_000);

  describe("a meetings-api that predates its `ids` filter answers the caller's latest page (plan R7)", () => {
    it("is 503, never 404, when that page does not hold the asked meeting: it proves nothing about it", async () => {
      // The caller's own oldest meeting, behind 25 newer ones: the page cannot hold it.
      hosts.meetings.add({ id: "m-oldest", creator: ALICE });
      for (let n = 1; n <= 25; n++) hosts.meetings.add({ id: `m-newer-${n}`, creator: ALICE });
      hosts.meetings.legacy = true;

      expectHostUnavailable(await post(body(meeting("m-oldest"))));
      expect(await entryRows()).toHaveLength(0);
    });

    it("accepts the meeting when it IS on that page: the caller's own list says they took part", async () => {
      hosts.meetings.add({ id: "m-newest", creator: ALICE });
      hosts.meetings.add({ id: "m-other", creator: ALICE });
      hosts.meetings.legacy = true;

      expect((await post(body(meeting("m-newest")))).status).toBe(201);
    });
  });
});

describe("PATCH /time-entries/{id} that keeps the target asks no owner (AC-2.12, D46)", () => {
  it("saves day, duration, note and work type of a project entry after the author left the team, while projects-api is DOWN", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] }); // alice is no longer on it
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.development, note: "Sprint" });
    hosts.fail("projects.resolve", { status: 500 });

    const res = await patch(entry.id, { day: "2026-11-03", minutes: 150, note: "Sprint review", workTypeId: SEED.workTypes.project.support });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ day: "2026-11-03", minutes: 150, note: "Sprint review", on: { type: "project", id: "p1" } });
    expect(await rowOf(entry.id)).toMatchObject({ minutes: 150, note: "Sprint review", workTypeId: SEED.workTypes.project.support, projectId: "p1" });
  });

  it("saves it when the project is no longer readable by the author, projects-api up", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setReader(ALICE, false);
    const entry = await makeProjectEntry("p1", { note: "Sprint" });

    const res = await patch(entry.id, { minutes: 90, note: "Sprint, again", day: "2026-11-04" });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ minutes: 90, on: { type: "project", id: "p1", visibility: "hidden" } });
  });

  it("saves a PATCH whose `on` names the project the entry is already on, and asks nothing about it", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });
    const entry = await makeProjectEntry("p1");

    const res = await patch(entry.id, { on: project("p1"), minutes: 30 });

    expect(res.status).toBe(200);
    expect(res.json.minutes).toBe(30);
    // Only the view's label came: a check would have been a second call, and a 403 for a caller not on it.
    expect(hosts.callsTo("projects.resolve")).toHaveLength(1);
  });

  it("does the same for a meeting entry whose author is no longer one of its people, meetings-api down", async () => {
    hosts.meetings.add({ id: "m1", creator: BOB });
    const entry = await makeMeetingEntry("m1", { note: "Planning" });
    hosts.fail("meetings.list", { status: 500 });

    const res = await patch(entry.id, { day: "2026-11-03", minutes: 120, note: "Planning, the long version" });

    expect(res.status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ day: new Date("2026-11-03T00:00:00Z"), minutes: 120, note: "Planning, the long version", meetingId: "m1" });
  });

  it("does the same for a meeting whose `on` names the one the entry is on, meetings-api up and the author not on it", async () => {
    hosts.meetings.add({ id: "m1", creator: BOB });
    const entry = await makeMeetingEntry("m1");

    const res = await patch(entry.id, { on: meeting("m1"), minutes: 30 });

    expect(res.status).toBe(200);
    expect(hosts.callsTo("meetings.list")).toHaveLength(1); // the view's label, not a check
  });
});

describe("PATCH /time-entries/{id} that moves the entry is checked like a new one (AC-2.12, D46)", () => {
  it("refuses another project the caller is not on with 403 not_on_project and changes nothing", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [BOB] });
    const entry = await makeProjectEntry("p1", { minutes: 60, note: "Before" });

    const res = await patch(entry.id, { on: project("p2"), minutes: 120, note: "After" });

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "not_on_project" });
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p1", minutes: 60, note: "Before" });
  });

  it("moves it to another project the caller is on, asking about THAT project", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] }); // left it: no matter
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1");

    const res = await patch(entry.id, { on: project("p2") });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ on: { type: "project", id: "p2" } });
    expect(await rowOf(entry.id)).toMatchObject({ target: "project", projectId: "p2" });
    expect(hosts.callsTo("projects.resolve")[0]?.body).toEqual({ entityType: "project", ids: ["p2"] });
  });

  it("moves an entry on no entity onto a project the caller is on, and refuses one they are not", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [] });
    const entry = await makeNoEntityEntry(SEED.categories.training);

    expect((await patch(entry.id, { on: project("p2") })).status).toBe(403);
    expect(await rowOf(entry.id)).toMatchObject({ target: "none", categoryId: SEED.categories.training, projectId: null });

    const res = await patch(entry.id, { on: project("p1") });
    expect(res.status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ target: "project", projectId: "p1", categoryId: null });
  });

  it("answers 404 for a project that is missing or that the caller may not read: one body, the entry unchanged", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setProject("p-secret", { label: "Secret", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1");

    const missing = await patch(entry.id, { on: project("p-nobody") });
    hosts.projects.setReader(ALICE, false);
    const unreadable = await patch(entry.id, { on: project("p-secret") });

    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: "not_found" });
    expect(unreadable.text).toBe(missing.text);
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p1" });
  });

  it("is 503 when the owner of the new target does not answer, and the entry is as it was", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { minutes: 60 });
    hosts.fail("projects.resolve", { status: 500 });

    expectHostUnavailable(await patch(entry.id, { on: project("p2"), minutes: 90 }));
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p1", minutes: 60 });
  });

  it("moves an entry from a project to a meeting by asking meetings-api, never projects-api", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    const entry = await makeProjectEntry("p1");

    const res = await patch(entry.id, { on: meeting("m1") });

    expect(res.status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ target: "meeting", meetingId: "m1", projectId: null });
    expect(hosts.callsTo("meetings.list")[0]?.query.get("ids")).toBe("m1");
    expect(hosts.callsTo("projects.resolve")).toHaveLength(0);
  });

  it("refuses another meeting the caller is not one of the people of with 404, and the meeting variant of the change rule holds", async () => {
    hosts.meetings.add({ id: "m1", creator: BOB }); // the author is no longer on it
    hosts.meetings.add({ id: "m2", creator: BOB });
    const entry = await makeMeetingEntry("m1", { minutes: 60 });

    const res = await patch(entry.id, { on: meeting("m2"), minutes: 90 });

    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "not_found" });
    expect(await rowOf(entry.id)).toMatchObject({ meetingId: "m1", minutes: 60 });
  });

  it("is 503 when meetings-api does not answer for the new meeting", async () => {
    hosts.meetings.add({ id: "m2", creator: ALICE });
    const entry = await makeMeetingEntry("m1");
    hosts.fail("meetings.list", { status: 500 });

    expectHostUnavailable(await patch(entry.id, { on: meeting("m2") }));
    expect(await rowOf(entry.id)).toMatchObject({ meetingId: "m1" });
  });
});

describe("a move carries what the entry has, and the owners are asked after the local rules (plan § Entries 'A change and a move', § Errors 'Order of the answers')", () => {
  it("moves a project entry to another project the caller is on and keeps its project work type", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.development, note: "Sprint" });

    const res = await patch(entry.id, { on: project("p2") });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ on: { type: "project", id: "p2" }, workType: { id: SEED.workTypes.project.development, retired: false }, note: "Sprint" });
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p2", workTypeId: SEED.workTypes.project.development, note: "Sprint" });
  });

  it("keeps it when it was retired since: the entry already has it, a move does not choose it anew (AC-3.4)", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    const retired = await makeWorkType("project", "Workshops");
    const entry = await makeProjectEntry("p1", { workTypeId: retired.id });
    await db.workType.update({ where: { id: retired.id }, data: { retiredAt: new Date() } });

    const res = await patch(entry.id, { on: project("p2") });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ on: { type: "project", id: "p2" }, workType: { id: retired.id, name: "Workshops", retired: true } });
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p2", workTypeId: retired.id });
  });

  it("refuses a move to a meeting while the entry carries a work type: 422 work_type_not_allowed on `workTypeId`, no owner asked, nothing changed", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.development });

    const res = await patch(entry.id, { on: meeting("m1") });

    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "work_type_not_allowed", field: "workTypeId" });
    expect(hosts.calls).toHaveLength(0);
    expect(await rowOf(entry.id)).toMatchObject({ target: "project", projectId: "p1", meetingId: null, workTypeId: SEED.workTypes.project.development });
  });

  it("moves it to the meeting when the same PATCH sends `workTypeId: null`", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.development, note: "Sprint" });

    const res = await patch(entry.id, { on: meeting("m1"), workTypeId: null });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ on: { type: "meeting", id: "m1" }, workType: null, note: "Sprint" });
    expect(await rowOf(entry.id)).toMatchObject({ target: "meeting", meetingId: "m1", projectId: null, workTypeId: null });
    expect(hosts.callsTo("meetings.list")[0]?.query.get("ids")).toBe("m1");
  });

  it("refuses 45 minutes on a project the caller is not on with 422 invalid_minutes, not 403, and asks projects-api nothing", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });

    const res = await post(body(project("p1"), { minutes: 45 }));

    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "invalid_minutes", field: "minutes" });
    expect(hosts.callsTo("projects.resolve")).toHaveLength(0);
    expect(hosts.calls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
  });

  it.each([
    ["a duration of 45 minutes", { minutes: 45 }, "invalid_minutes"],
    ["a day after today", { day: "2026-11-14" }, "future_day"],
    ["a note of 1001 characters", { note: "x".repeat(1001) }, "note_too_long"],
    ["a work type of the deal list", { workTypeId: SEED.workTypes.deal.offer }, "work_type_not_allowed"],
  ])("refuses %s before any owner is asked, on a project or a meeting the caller could otherwise be refused on", async (_what, over, code) => {
    for (const on of [project("p-not-mine"), meeting("m-not-mine")]) {
      const res = await post(body(on, over));
      expect(res.status).toBe(422);
      expect(res.json.code).toBe(code);
    }
    expect(hosts.calls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
  });

  it("refuses a work type nobody has on a project the caller is not on with 422 work_type_not_found, asking projects-api nothing", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });
    const res = await post(body(project("p1"), { workTypeId: "wt-does-not-exist" }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "work_type_not_found", field: "workTypeId" });
    expect(hosts.calls).toHaveLength(0);
  });

  it("refuses a move with a rule broken before asking the owner of the new target", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [BOB] });
    const entry = await makeProjectEntry("p1", { minutes: 60 });

    const res = await patch(entry.id, { on: project("p2"), minutes: 45 });

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("invalid_minutes");
    expect(hosts.calls).toHaveLength(0);
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p1", minutes: 60 });
  });
});

describe("no write onto a project or a meeting is answered 501 any more (plan § Errors, R11)", () => {
  it("answers each with what its owner says: 201, 403, 404 or 503", async () => {
    hosts.projects.setProject("p-mine", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setProject("p-theirs", { label: "Gemini", assignees: [BOB] });
    hosts.meetings.add({ id: "m-mine", creator: ALICE });
    hosts.meetings.add({ id: "m-theirs", creator: BOB });

    const fromProject = await makeProjectEntry("p-mine");
    const fromMeeting = await makeMeetingEntry("m-mine");
    const fromNone = await makeNoEntityEntry(SEED.categories.training);
    const stillNone = await makeNoEntityEntry(SEED.categories.training);

    const answers: Array<[string, number, number]> = [];
    const ask = async (what: string, expected: number, request: Promise<{ status: number }>) => answers.push([what, (await request).status, expected]);

    await ask("POST project, on it", 201, post(body(project("p-mine"))));
    await ask("POST project, not on it", 403, post(body(project("p-theirs"))));
    await ask("POST project, unknown", 404, post(body(project("p-nobody"))));
    await ask("POST meeting, on it", 201, post(body(meeting("m-mine"))));
    await ask("POST meeting, not on it", 404, post(body(meeting("m-theirs"))));
    await ask("move none → project, on it", 200, patch(fromNone.id, { on: project("p-mine") }));
    await ask("move none → project, not on it", 403, patch(fromNone.id, { on: project("p-theirs") }));
    await ask("move none → meeting, on it", 200, patch(fromNone.id, { on: meeting("m-mine") }));
    await ask("move meeting → project, on it", 200, patch(fromMeeting.id, { on: project("p-mine") }));
    await ask("move project → project, not on it", 403, patch(fromProject.id, { on: project("p-theirs") }));
    await ask("move project → meeting, not on it", 404, patch(fromProject.id, { on: meeting("m-theirs") }));
    hosts.fail("projects.resolve", { status: 500 });
    await ask("POST project, owner down", 503, post(body(project("p-mine"))));
    await ask("move → project, owner down", 503, patch(stillNone.id, { on: project("p-mine") }));

    expect(answers.map(([what, status]) => [what, status])).toEqual(answers.map(([what, , expected]) => [what, expected]));
    expect(answers.some(([, status]) => status === 501)).toBe(false);
  });
});

/** An id outside the id rule (plan § Entries): each is a 400 of hours-api's own, decided before any owner is asked. */
const BAD_IDS: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  ["65 characters", "x".repeat(65)],
  ["a NUL", "a\u0000b"],
  ["a comma", "a,b"],
  ["an empty member between commas", "a,,b"],
  ["only spaces", "   "],
  ["a space at the start", " p1"],
  ["a space at the end", "p1 "],
  ["a tab at the start", "\tp1"],
];

describe("an `on.id` outside the id rule is hours-api's own 400, whatever the target (AC-2.10; plan § Entries)", () => {
  describe.each([["project"], ["meeting"]] as const)("on a %s", (type) => {
    it.each(BAD_IDS)("POST with an id that is %s: 400 `on.id`, no owner asked, nothing written", async (_name, id) => {
      const res = await post(body({ type, id }));
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "on.id" });
      expect(hosts.calls).toHaveLength(0);
      expect(await entryRows()).toHaveLength(0);
    });

    it.each(BAD_IDS)("PATCH with an id that is %s: 400 `on.id`, no owner asked, the entry unchanged", async (_name, id) => {
      const entry = await makeNoEntityEntry(SEED.categories.training, { minutes: 60 });
      const res = await patch(entry.id, { on: { type, id }, minutes: 90 });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "on.id" });
      expect(hosts.calls).toHaveLength(0);
      expect(await rowOf(entry.id)).toMatchObject({ target: "none", minutes: 60 });
    });
  });
});
