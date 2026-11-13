/**
 * The activity an entry on a project or a deal may point at (specs/029 T16; AC-2.7, AC-2.8, AC-2.9, AC-2.11,
 * AC-2.12; plan § Sequences step 5 and "A pointed activity that was deleted", § Entries "The id rule" and
 * "A change and a move", § Reading the owners' list answers, risk R6; ledger D47; ADR-0089), through the
 * ASSEMBLED app, against the real database and the fake owners of T11.
 *
 * Whether an activity belongs to a project or a deal is asked of activities-api, AS THE CALLER, when the pointer is
 * NEW on this entry (sent and different from the stored one) or CARRIED to another target by a move. It is asked
 * ONCE, by id, after bookability has said yes (a 403 or a 404 is never hidden behind it). A pointer that is neither
 * new nor carried is never asked again, and one that no longer resolves is never cleared (D47): activities-api omits
 * an activity the caller cannot read exactly as it omits a deleted one, and clearing it on a write would drop a live
 * pointer from an author who merely lost read access.
 *
 * Projects, deals and meetings as targets: bookability.test.ts, deals.test.ts.
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
  makeDealEntry,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
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
const deal = (id: string) => ({ type: "deal", id });
const meeting = (id: string) => ({ type: "meeting", id });
const body = (on: unknown, over: Record<string, unknown> = {}) => ({ day: "2026-11-12", minutes: 60, on, ...over });

const post = (payload: unknown, as: PersonaName | null = "alice") => call("POST", "/time-entries", { as, body: payload });
const patch = (id: string, payload: unknown, as: PersonaName | null = "alice") => call("PATCH", `/time-entries/${id}`, { as, body: payload });

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

const expectHostUnavailable = (res: { status: number; json: any }) => {
  expect(res.status).toBe(503);
  expect(res.json).toMatchObject({ status: 503, code: "host_unavailable" });
};

/** The 422 of an activity that is not the target's own (or not there for the caller): the member it lands on is `activityId`. */
const expectActivityNotAllowed = (res: { status: number; json: any }) => {
  expect(res.status).toBe(422);
  expect(res.json).toMatchObject({ status: 422, code: "activity_not_allowed", field: "activityId" });
};

describe("POST /time-entries pointing at an activity of the project or the deal (AC-2.7)", () => {
  it("accepts a task of the same project, and returns the activity in the view", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1", assignee: ALICE });

    const res = await post(body(project("p1"), { activityId: "t1" }));

    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ on: { type: "project", id: "p1" }, activity: { id: "t1", subject: "Build the importer", visibility: "visible" } });
    expect(await entryRows()).toMatchObject([{ projectId: "p1", activityId: "t1" }]);
  });

  it("accepts a pre-sales activity of the same deal, of any kind: a call, a note, a task", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.activities.add({ id: "a-call", subject: "Discovery call", type: "call", deal: "d1" });
    hosts.activities.add({ id: "a-note", subject: "Budget notes", type: "note", deal: "d1" });
    hosts.activities.add({ id: "a-task", subject: "Prepare the offer", deal: "d1", assignee: BOB });

    for (const activityId of ["a-call", "a-note", "a-task"]) {
      const res = await post(body(deal("d1"), { activityId, workTypeId: SEED.workTypes.deal.offer }));
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ on: { type: "deal", id: "d1" }, activity: { id: activityId } });
    }
    expect(await entryRows()).toMatchObject([{ activityId: "a-call" }, { activityId: "a-note" }, { activityId: "a-task" }]);
  });

  it("asks activities-api AS THE CALLER for that one id and no other filter: the caller's own token", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    expect((await post(body(project("p1"), { activityId: "t1" }))).status).toBe(201);

    // The view's label for the pointed activity is a second ask, by the same id and the same token.
    const asks = hosts.callsTo("activities.list");
    expect(asks.length).toBeGreaterThanOrEqual(1);
    for (const ask of asks) {
      expect(ask.query.get("ids")).toBe("t1");
      expect([...ask.query.keys()]).toEqual(["ids"]);
      expect(ask.authorization).toBe(await bearerOf("alice"));
    }
  });

  it("refuses an activity of another project, a task of a project on a deal entry and an activity of a deal on a project entry: 422 on `activityId`, nothing written", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.activities.add({ id: "t-other-project", subject: "Somewhere else", project: "p2" });
    hosts.activities.add({ id: "t-p1", subject: "Build the importer", project: "p1" });
    hosts.activities.add({ id: "a-other-deal", subject: "Another deal's call", type: "call", deal: "d2" });
    hosts.activities.add({ id: "a-d1", subject: "Discovery call", type: "call", deal: "d1" });

    expectActivityNotAllowed(await post(body(project("p1"), { activityId: "t-other-project" })));
    expectActivityNotAllowed(await post(body(project("p1"), { activityId: "a-d1" })));
    expectActivityNotAllowed(await post(body(deal("d1"), { activityId: "a-other-deal" })));
    expectActivityNotAllowed(await post(body(deal("d1"), { activityId: "t-p1" })));
    expect(await entryRows()).toHaveLength(0);
  });

  it("refuses a well-formed id activities-api does not return, and one the caller may not read, with the same 422 (AC-2.7)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t-secret", subject: "Not for alice", project: "p1", readableBy: [BOB] });

    const unreadable = await post(body(project("p1"), { activityId: "t-secret" }));
    const unknown = await post(body(project("p1"), { activityId: "a-well-formed-id-nobody-holds" }));

    expectActivityNotAllowed(unreadable);
    expect(unknown.text).toBe(unreadable.text);
    expect(await entryRows()).toHaveLength(0);
  });

  it("lets any number of entries, by any number of people on any number of days, point at one task (AC-2.8)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE, BOB] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });

    const answers = [
      await post(body(project("p1"), { day: "2026-11-10", activityId: "t1" }), "alice"),
      await post(body(project("p1"), { day: "2026-11-11", activityId: "t1" }), "alice"),
      await post(body(project("p1"), { day: "2026-11-12", activityId: "t1" }), "bob"),
    ];

    for (const res of answers) {
      expect(res.status).toBe(201);
      expect(res.json.activity).toMatchObject({ id: "t1", subject: "Build the importer" });
    }
    expect(await entryRows()).toMatchObject([{ userId: ALICE, activityId: "t1" }, { userId: ALICE, activityId: "t1" }, { userId: BOB, activityId: "t1" }]);
  });

  it("asks nothing when there is no pointer: no `activityId`, or `activityId: null`", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    expect((await post(body(project("p1")))).status).toBe(201);
    expect((await post(body(project("p1"), { activityId: null }))).status).toBe(201);
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("refuses an activity on a meeting or on no entity with 422 and no call at all (decided locally)", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    for (const on of [meeting("m1"), { type: "none", categoryId: SEED.categories.training }]) {
      expectActivityNotAllowed(await post(body(on, { activityId: "t1" })));
    }
    expect(hosts.calls).toHaveLength(0);
  });
});

describe("an activity whose owner does not answer, or answers what is no answer (AC-2.11)", () => {
  it.each(OWNER_FAILURES)("is 503 host_unavailable when activities-api %s: nothing is recorded, never accepted unchecked", async (_name, mode) => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.fail("activities.list", mode);

    expectHostUnavailable(await post(body(project("p1"), { activityId: "t1" })));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 when activities-api is unreachable, or slower than its 2 s", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.sever("activities");
    expectHostUnavailable(await post(body(project("p1"), { activityId: "t1" })));

    hosts.reset();
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.fail("activities.list", { delayMs: 2_600 });
    expectHostUnavailable(await post(body(project("p1"), { activityId: "t1" })));
    expect(await entryRows()).toHaveLength(0);
  }, 10_000);

  it("is 503, never 422, when activities-api answers another activity and not the asked one: an owner that ignored `ids` proves nothing (plan amendment 3)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const another = { id: "t-another", type: "task", subject: "Somebody else's", project: { id: "p1" }, deal: null, participants: [], task: { assignee: null } };
    hosts.fail("activities.list", { body: { items: [another], total: 1, page: 1, pageSize: 50 } });

    expectHostUnavailable(await post(body(project("p1"), { activityId: "t1" })));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 on an activities-api that predates the `ids` filter (it answers 422 to `ids` alone, plan R7)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.activities.legacy = true;

    expectHostUnavailable(await post(body(project("p1"), { activityId: "t1" })));
    expect(await entryRows()).toHaveLength(0);
  });
});

describe("bookability answers first: a 403, a 404 or a 503 is never hidden behind the activity (plan § Errors, order of the answers)", () => {
  it("answers 403 not_on_project for a project the caller is not on, whatever the activity", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });
    hosts.activities.add({ id: "t-other", subject: "Elsewhere", project: "p2" });
    for (const activityId of ["t-other", "a-nobody-holds"]) {
      const res = await post(body(project("p1"), { activityId }));
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ code: "not_on_project" });
    }
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("answers 403 not_involved_in_deal for a deal the caller is not involved in, whatever the activity", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.activities.add({ id: "a-d1", subject: "Discovery call", type: "call", deal: "d1", assignee: BOB });
    const res = await post(body(deal("d1"), { activityId: "a-d1" }));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "not_involved_in_deal" });
    // The scan of the deal's activities (`dealId`) is bookability's own; the pointer's `ids` lookup is never made.
    expect(hosts.callsTo("activities.list").some((ask) => ask.query.get("ids") !== null)).toBe(false);
    expect(hosts.callsTo("activities.list").some((ask) => ask.query.get("dealId") === "d1")).toBe(true);
  });

  it("answers 404 for a project that does not exist and 503 when its owner is down, whatever the activity", async () => {
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p-nobody" });
    const missing = await post(body(project("p-nobody"), { activityId: "t1" }));
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: "not_found" });

    hosts.fail("projects.resolve", { status: 500 });
    expectHostUnavailable(await post(body(project("p1"), { activityId: "a-nobody-holds" })));
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
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
  ["a space at the start", " t1"],
  ["a space at the end", "t1 "],
  ["a tab at the start", "\tt1"],
];

describe("an `activityId` outside the id rule is hours-api's own 400, never an owner's 4xx read as 503 (AC-2.7; plan § Entries)", () => {
  it.each(BAD_IDS)("POST with an activity id that is %s: 400 `activityId`, no owner called at all, nothing written", async (_name, id) => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const onProject = await post(body(project("p1"), { activityId: id }));
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    const onDeal = await post(body(deal("d1"), { activityId: id }));

    for (const res of [onProject, onDeal]) {
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "activityId" });
    }
    expect(hosts.calls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
  });

  it.each(BAD_IDS)("PATCH with an activity id that is %s: 400 `activityId`, no owner called at all, the entry unchanged", async (_name, id) => {
    const entry = await makeProjectEntry("p1", { minutes: 60 });
    const res = await patch(entry.id, { activityId: id, minutes: 90 });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_request", field: "activityId" });
    expect(hosts.calls).toHaveLength(0);
    expect(await rowOf(entry.id)).toMatchObject({ minutes: 60, activityId: null });
  });

  it("sends a well-formed id holding `&`, `#`, `+`, `%` or an inner space to activities-api exactly as given, and an unknown one is the 422", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const id = "a&b#c+d%e f";
    expectActivityNotAllowed(await post(body(project("p1"), { activityId: id })));
    expect(hosts.callsTo("activities.list")[0]?.query.get("ids")).toBe(id);
  });
});

describe("PATCH /time-entries/{id} that keeps the target: a pointer is asked only when it is NEW (AC-2.7, AC-2.12, D47)", () => {
  it("accepts a new pointer to a task of the project after the author left the team: only activities-api is asked, projects-api may be down", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] }); // alice is no longer on it
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    const entry = await makeProjectEntry("p1");
    hosts.fail("projects.resolve", { status: 500 });

    const res = await patch(entry.id, { activityId: "t1" });

    expect(res.status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p1", activityId: "t1" });
  });

  it("is 503 when activities-api does not answer a NEW pointer, and the entry is as it was", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    const entry = await makeProjectEntry("p1", { minutes: 60 });
    hosts.fail("activities.list", { status: 500 });

    expectHostUnavailable(await patch(entry.id, { activityId: "t1", minutes: 90 }));
    expect(await rowOf(entry.id)).toMatchObject({ minutes: 60, activityId: null });
  });

  it("refuses a new pointer to an activity of another project with 422, and the old pointer stays", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.activities.add({ id: "t-other", subject: "Elsewhere", project: "p2" });
    const entry = await makeProjectEntry("p1", { activityId: "t1" });

    expectActivityNotAllowed(await patch(entry.id, { activityId: "t-other" }));
    expect(await rowOf(entry.id)).toMatchObject({ activityId: "t1" });
  });

  it("checks a new pointer on a deal entry against the deal: a pre-sales activity of it, not another deal's", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] }); // alice stopped being involved: no matter
    hosts.activities.add({ id: "a-d1", subject: "Discovery call", type: "call", deal: "d1" });
    hosts.activities.add({ id: "a-d2", subject: "Another call", type: "call", deal: "d2" });
    const entry = await makeDealEntry("d1");

    expectActivityNotAllowed(await patch(entry.id, { activityId: "a-d2" }));
    expect((await patch(entry.id, { activityId: "a-d1" })).status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ dealId: "d1", activityId: "a-d1" });
  });

  it("never checks `activityId: null`: it clears the pointer with activities-api down", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { activityId: "t1" });
    hosts.fail("activities.list", { status: 500 });

    const res = await patch(entry.id, { activityId: null });

    expect(res.status).toBe(200);
    expect(res.json.activity).toBeNull();
    expect(await rowOf(entry.id)).toMatchObject({ activityId: null });
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("does not ask again for a pointer the entry already has, re-sent with the target unchanged: 200 while activities-api is down (D47)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { activityId: "t1", workTypeId: SEED.workTypes.project.development });
    hosts.fail("activities.list", { status: 500 });

    // A client that sends the whole form back.
    const res = await patch(entry.id, { on: project("p1"), activityId: "t1", day: "2026-11-03", minutes: 90, note: "Edited", workTypeId: SEED.workTypes.project.support });

    expect(res.status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ activityId: "t1", minutes: 90, note: "Edited" });
  });
});

describe("a pointer that no longer resolves is never cleared (D47, AC-2.9, risk R6)", () => {
  it("keeps the stored id when the activity is gone and the author changes the note: 200 with activities-api DOWN, no pointer check", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { activityId: "t-gone", note: "Before" });
    hosts.fail("activities.list", { status: 500 });

    const res = await patch(entry.id, { note: "After" });

    expect(res.status).toBe(200);
    expect(res.json.note).toBe("After");
    // The view cannot say what the activity is called: unreachable is not deleted.
    expect(res.json.activity).toMatchObject({ id: "t-gone", visibility: "unavailable" });
    expect(await rowOf(entry.id)).toMatchObject({ activityId: "t-gone", note: "After" });
  });

  it("keeps the stored id when activities-api answers and no longer returns it: the view shows `activity: null`", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t-live", subject: "Build the importer", project: "p1" });
    const entry = await makeProjectEntry("p1", { activityId: "t-gone", note: "Before" });

    const res = await patch(entry.id, { note: "After", minutes: 90 });

    expect(res.status).toBe(200);
    expect(res.json.activity).toBeNull();
    expect(await rowOf(entry.id)).toMatchObject({ activityId: "t-gone", note: "After", minutes: 90 });
  });

  it("keeps it for an author who merely lost read access to the activity: omitted like a deleted one, the id stays", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1", readableBy: [BOB] });
    const entry = await makeProjectEntry("p1", { activityId: "t1" });

    const res = await patch(entry.id, { note: "After" });

    expect(res.status).toBe(200);
    expect(res.json.activity).toBeNull();
    expect(await rowOf(entry.id)).toMatchObject({ activityId: "t1" });
  });

  it("shows the activity as hidden, not null, when the project itself is hidden from the AUTHOR, and keeps the id: the pointer is theirs (D44)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setReader(ALICE, false);
    const entry = await makeProjectEntry("p1", { activityId: "t-gone" });

    const res = await patch(entry.id, { note: "After" });

    expect(res.status).toBe(200);
    expect(res.json.activity).toEqual({ id: "t-gone", subject: null, visibility: "hidden" });
    // The author's own response names what they booked, whatever they may read (D44).
    expect(res.json.on).toMatchObject({ type: "project", id: "p1", label: null, visibility: "hidden" });
    expect(await rowOf(entry.id)).toMatchObject({ activityId: "t-gone" });
  });

  it("shows the same hidden activity to ANOTHER viewer without its id, and the stored pointer is untouched (D44)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setReader(PERSONAS.holder.sub, false);
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    const entry = await makeProjectEntry("p1", { activityId: "t-gone", day: "2026-11-12" });

    const res = await call("GET", "/time-entries?from=2026-11-01&to=2026-11-30&whose=all", { as: "holder" });

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0].activity).toEqual({ id: null, subject: null, visibility: "hidden" });
    expect(res.json.items[0].on).toMatchObject({ type: "project", id: null, label: null, visibility: "hidden" });
    expect(res.text).not.toContain("t-gone");
    expect(await rowOf(entry.id)).toMatchObject({ activityId: "t-gone" });
  });
});

describe("PATCH /time-entries/{id} that moves the entry: the pointer it carries is asked again for the new target (plan § Entries 'A change and a move')", () => {
  it("refuses a move to another bookable project with 422 on `activityId`, the row unchanged, and moves it with `activityId: null`", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    const entry = await makeProjectEntry("p1", { activityId: "t1", minutes: 60 });

    expectActivityNotAllowed(await patch(entry.id, { on: project("p2"), minutes: 90 }));
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p1", activityId: "t1", minutes: 60 });

    const moved = await patch(entry.id, { on: project("p2"), activityId: null });
    expect(moved.status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p2", activityId: null });
  });

  it("moves it to another project together with a task of THAT project", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    hosts.activities.add({ id: "t2", subject: "Wire the queue", project: "p2" });
    const entry = await makeProjectEntry("p1", { activityId: "t1" });

    const res = await patch(entry.id, { on: project("p2"), activityId: "t2" });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ on: { type: "project", id: "p2" }, activity: { id: "t2" } });
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p2", activityId: "t2" });
  });

  it("does the same from deal to deal", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.crm.setDeal("d2", { label: "Globex migration", involved: [ALICE] });
    hosts.activities.add({ id: "a-d1", subject: "Discovery call", type: "call", deal: "d1" });
    const entry = await makeDealEntry("d1", { activityId: "a-d1", minutes: 60 });

    expectActivityNotAllowed(await patch(entry.id, { on: deal("d2") }));
    expect(await rowOf(entry.id)).toMatchObject({ dealId: "d1", activityId: "a-d1", minutes: 60 });

    expect((await patch(entry.id, { on: deal("d2"), activityId: null })).status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ dealId: "d2", activityId: null });
  });

  it("refuses a move from a project to a deal, and from a deal to a project, while the pointer is carried", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.activities.add({ id: "a-d1", subject: "Discovery call", type: "call", deal: "d1" });
    const onProject = await makeProjectEntry("p1", { activityId: "t1" });
    const onDeal = await makeDealEntry("d1", { activityId: "a-d1" });

    expectActivityNotAllowed(await patch(onProject.id, { on: deal("d1") }));
    expectActivityNotAllowed(await patch(onDeal.id, { on: project("p1") }));
    expect(await rowOf(onProject.id)).toMatchObject({ target: "project", activityId: "t1" });
    expect(await rowOf(onDeal.id)).toMatchObject({ target: "deal", activityId: "a-d1" });
  });

  it("refuses a move onto a meeting or no entity while the pointer is carried, with no owner called; `activityId: null` moves it", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    const entry = await makeProjectEntry("p1", { activityId: "t1" });

    for (const on of [meeting("m1"), { type: "none", categoryId: SEED.categories.training }]) {
      expectActivityNotAllowed(await patch(entry.id, { on }));
    }
    expect(hosts.calls).toHaveLength(0);
    expect(await rowOf(entry.id)).toMatchObject({ target: "project", activityId: "t1" });

    expect((await patch(entry.id, { on: meeting("m1"), activityId: null })).status).toBe(200);
  });

  it("answers the new target's own 403 before the carried pointer's 422", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [BOB] });
    const entry = await makeProjectEntry("p1", { activityId: "t1" });

    const res = await patch(entry.id, { on: project("p2") });

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "not_on_project" });
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("is 503 when activities-api does not answer for a carried pointer: the move is refused and the row is as it was", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { activityId: "t1" });
    hosts.fail("activities.list", { status: 500 });

    expectHostUnavailable(await patch(entry.id, { on: project("p2") }));
    expect(await rowOf(entry.id)).toMatchObject({ projectId: "p1", activityId: "t1" });
  });

  it("moves an entry that has no pointer without asking activities-api anything", async () => {
    hosts.projects.setProject("p2", { label: "Gemini", assignees: [ALICE] });
    const entry = await makeNoEntityEntry(SEED.categories.training);
    hosts.fail("activities.list", { status: 500 });

    expect((await patch(entry.id, { on: project("p2") })).status).toBe(200);
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });
});

describe("no write that needs an owner is answered 501 any more (plan § Errors, R11)", () => {
  it("answers each with what its owners say: 201, 403, 404, 422 or 503", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    hosts.crm.setDeal("d-mine", { label: "Acme renewal", involved: [ALICE] });
    hosts.crm.setDeal("d-theirs", { label: "Globex migration", involved: [BOB] });
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.activities.add({ id: "t2", subject: "Wire the queue", project: "p1" });
    hosts.activities.add({ id: "a-mine", subject: "Discovery call", type: "call", deal: "d-mine" });

    const answers: Array<[string, number, number]> = [];
    const ask = async (what: string, expected: number, request: Promise<{ status: number }>) => answers.push([what, (await request).status, expected]);
    const fromNone = await makeNoEntityEntry(SEED.categories.training);
    const fromProject = await makeProjectEntry("p1");

    await ask("POST deal, involved", 201, post(body(deal("d-mine"))));
    await ask("POST deal, not involved", 403, post(body(deal("d-theirs"))));
    await ask("POST deal, unknown", 404, post(body(deal("d-nobody"))));
    await ask("POST project + task, its own", 201, post(body(project("p1"), { activityId: "t1" })));
    await ask("POST deal + activity, its own", 201, post(body(deal("d-mine"), { activityId: "a-mine" })));
    await ask("POST project + activity of a deal", 422, post(body(project("p1"), { activityId: "a-mine" })));
    await ask("move none → deal, involved", 200, patch(fromNone.id, { on: deal("d-mine") }));
    await ask("move project → deal, not involved", 403, patch(fromProject.id, { on: deal("d-theirs") }));
    await ask("new pointer on a project entry", 200, patch(fromProject.id, { activityId: "t1" }));
    await ask("new pointer of another project", 422, patch(fromProject.id, { activityId: "a-mine" }));
    hosts.fail("activities.list", { status: 500 });
    await ask("new pointer, activities-api down", 503, patch(fromProject.id, { activityId: "t2", minutes: 90 }));
    hosts.heal("activities.list");
    hosts.fail("crm.resolve", { status: 500 });
    await ask("POST deal, crm-api down", 503, post(body(deal("d-mine"))));

    expect(answers.map(([what, status]) => [what, status])).toEqual(answers.map(([what, , expected]) => [what, expected]));
    expect(answers.some(([, status]) => status === 501)).toBe(false);
  });
});
