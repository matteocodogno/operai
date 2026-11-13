/**
 * Whether the caller may book hours on a deal, and the change rule of AC-2.12 for a deal (specs/029 T16; AC-2.3,
 * AC-2.4, AC-2.10, AC-2.11, AC-2.12; plan § Sequences "Record an entry on a deal", § Entries "The id rule",
 * § Reading the owners' list answers "The deal scan", R9; ADR-0089), through the ASSEMBLED app, against the real
 * database and the fake owners of T11.
 *
 * Who is involved in a deal is asked of its owners, as the CALLER, at the moment of the write: crm-api says who
 * owns it and who is its technical contact (`involved`); only for anyone else is activities-api asked for the
 * deal's activities, to look for the caller as a task's assignee or a participant. hours-api keeps no list of
 * who is involved in what, and decides nothing it has not been told. Nothing is ever recorded unchecked: an owner
 * that does not answer is a 503, never "yes" and never "not involved".
 *
 * "No bookability call" on a change is proved by the SAVE SUCCEEDING while the owners are down: the view a write
 * returns resolves its labels as the viewer, so the fake does record a crm call even then (plan amendment 5) — and
 * that call fails soft, a bookability call would not.
 *
 * The activity pointer is src/entries/activityPointer.test.ts. Projects and meetings: bookability.test.ts.
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
const CAROL = PERSONAS.carol.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date(NOW));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

const deal = (id: string) => ({ type: "deal", id });
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

describe("POST /time-entries on a deal the CRM says the caller is involved in (AC-2.3)", () => {
  it("accepts the deal's owner or its technical contact on crm-api's word alone: activities-api is never asked", async () => {
    hosts.crm.setDeal("d-owned", { label: "Acme renewal", involved: [ALICE, BOB] });
    hosts.crm.setDeal("d-technical", { label: "Globex migration", involved: [BOB, ALICE] });

    for (const id of ["d-owned", "d-technical"]) {
      const res = await post(body(deal(id), { workTypeId: SEED.workTypes.deal.estimate }));
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ on: { type: "deal", id, visibility: "visible" }, person: { id: ALICE } });
    }
    expect(await entryRows()).toMatchObject([{ dealId: "d-owned", target: "deal", userId: ALICE }, { dealId: "d-technical", userId: ALICE }]);
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });
});

describe("POST /time-entries on a deal the caller is involved in only through an activity (AC-2.3)", () => {
  it("accepts the assignee of one of its tasks and a participant of one of its activities, after crm-api did not name them", async () => {
    hosts.crm.setDeal("d-task", { label: "Acme renewal", involved: [BOB] });
    hosts.activities.add({ id: "a-task", subject: "Prepare the offer", deal: "d-task", assignee: ALICE });
    hosts.crm.setDeal("d-call", { label: "Globex migration", involved: [BOB] });
    hosts.activities.add({ id: "a-call", subject: "Discovery call", type: "call", deal: "d-call", participants: [ALICE] });

    for (const id of ["d-task", "d-call"]) {
      const res = await post(body(deal(id)));
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ on: { type: "deal", id } });
    }
    expect(await entryRows()).toMatchObject([{ dealId: "d-task" }, { dealId: "d-call" }]);
  });

  it("asks activities-api AS THE CALLER for that deal's activities, and only after crm-api: the caller's own token", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.activities.add({ id: "a1", subject: "Prepare the offer", deal: "d1", assignee: ALICE });
    expect((await post(body(deal("d1")))).status).toBe(201);

    const scans = hosts.callsTo("activities.list");
    expect(scans).toHaveLength(1);
    expect(scans[0]?.query.get("dealId")).toBe("d1");
    expect(scans[0]?.authorization).toBe(await bearerOf("alice"));
    const routes = hosts.calls.map((recorded) => recorded.route);
    expect(routes.indexOf("crm.resolve")).toBeLessThan(routes.indexOf("activities.list"));
    expect(hosts.callsTo("crm.resolve")[0]?.body).toEqual({ entityType: "deal", ids: ["d1"] });
    for (const recorded of hosts.callsTo("crm.resolve")) expect(recorded.authorization).toBe(await bearerOf("alice"));
  });

  it("refuses any other CRM reader with 403 not_involved_in_deal and writes nothing", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    // Someone else's activities on the deal, and an activity of ANOTHER deal that names the caller: neither counts.
    hosts.activities.add({ id: "a-theirs", subject: "Prepare the offer", deal: "d1", assignee: BOB, participants: [CAROL] });
    hosts.crm.setDeal("d2", { label: "Globex migration", involved: [BOB] });
    hosts.activities.add({ id: "a-other-deal", subject: "Kick-off", deal: "d2", assignee: ALICE });
    // A project's task of the caller is no activity of the deal.
    hosts.activities.add({ id: "a-project", subject: "Build it", project: "p1", assignee: ALICE });

    const res = await post(body(deal("d1")));

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ status: 403, code: "not_involved_in_deal" });
    expect(await entryRows()).toHaveLength(0);
  });

  it("walks the deal's pages: a person on the second page of its activities is involved", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.activities.add({ id: "a-mine", subject: "Oldest, so last", deal: "d1", assignee: ALICE });
    for (let n = 1; n <= 120; n++) hosts.activities.add({ id: `a-${n}`, subject: `Activity ${n}`, deal: "d1", assignee: BOB });

    expect((await post(body(deal("d1")))).status).toBe(201);
    expect(hosts.callsTo("activities.list").map((recorded) => recorded.query.get("page"))).toEqual(["1", "2"]);
  });

  it("stops at 10 pages (R9): a person involved only through the 1001st activity is refused, after exactly 10 calls", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.activities.add({ id: "a-mine", subject: "Oldest, past the bound", deal: "d1", assignee: ALICE });
    for (let n = 1; n <= 1000; n++) hosts.activities.add({ id: `a-${n}`, subject: `Activity ${n}`, deal: "d1", assignee: BOB });

    const res = await post(body(deal("d1")));

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "not_involved_in_deal" });
    expect(hosts.callsTo("activities.list")).toHaveLength(10);
    expect(await entryRows()).toHaveLength(0);
  });
});

describe("a deal in any stage, and the answers that are the same whatever is asked (AC-2.3, AC-2.10)", () => {
  it("accepts a won deal and a lost deal: hours-api reads no stage of crm-api's answer (A13)", async () => {
    const open = (id: string, stage: string) => ({
      id,
      state: "open",
      writable: true,
      label: `Deal ${id}`,
      href: `/crm/deals/${id}`,
      may: { write: true, manage: true },
      involved: [ALICE],
      stage,
    });
    for (const stage of ["won", "lost"]) {
      hosts.fail("crm.resolve", { body: { reader: true, items: [open(`d-${stage}`, stage)] } });
      expect((await post(body(deal(`d-${stage}`)))).status).toBe(201);
    }
    expect(await entryRows()).toMatchObject([{ dealId: "d-won" }, { dealId: "d-lost" }]);
  });

  it("answers 404 not_found, one body, for a deal the caller may not read, one that does not exist and an unknown id (AC-2.10)", async () => {
    hosts.crm.setDeal("d-secret", { label: "Secret", involved: [ALICE] });
    hosts.crm.setReader(ALICE, false); // no `crm:access`: nothing is readable, the deal included
    const unreadable = await post(body(deal("d-secret")));
    const unreadableToo = await post(body(deal("d-nobody")));

    hosts.crm.setReader(ALICE, true);
    const missing = await post(body(deal("d-nobody")));
    const noSuchId = await post(body(deal("a-well-formed-id-no-owner-knows")));

    expect(unreadable.status).toBe(404);
    expect(unreadable.json).toMatchObject({ status: 404, code: "not_found" });
    for (const other of [unreadableToo, missing, noSuchId]) expect(other.text).toBe(unreadable.text);
    expect(await entryRows()).toHaveLength(0);
    // A caller who cannot read the CRM is never sent on to activities-api.
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("answers a deal, a project and a meeting that are not there with the same 404 body: nothing names the kind of target", async () => {
    hosts.meetings.add({ id: "m-theirs", creator: BOB });
    const dealMiss = await post(body(deal("d-nobody")));
    const projectMiss = await post(body(project("p-nobody")));
    const meetingMiss = await post(body(meeting("m-theirs")));
    expect(dealMiss.status).toBe(404);
    expect(projectMiss.text).toBe(dealMiss.text);
    expect(meetingMiss.text).toBe(dealMiss.text);
  });

  it("sends an id with `&`, `#`, `+`, `%` or an inner space to crm-api exactly as given, and an unknown one is the same 404", async () => {
    const id = "a&b#c+d%e f";
    const res = await post(body(deal(id)));
    expect(res.status).toBe(404);
    expect(hosts.callsTo("crm.resolve")[0]?.body).toEqual({ entityType: "deal", ids: [id] });
  });
});

describe("a deal whose owners do not answer: fail closed, nothing recorded (AC-2.11)", () => {
  it.each(OWNER_FAILURES)("is 503 host_unavailable when crm-api %s: never accepted unchecked, even for its own owner", async (_name, mode) => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.fail("crm.resolve", mode);
    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("is 503 host_unavailable when crm-api is unreachable, or slower than its 2 s", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.sever("crm");
    expectHostUnavailable(await post(body(deal("d1"))));

    hosts.reset();
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.fail("crm.resolve", { delayMs: 2_600 });
    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
  }, 10_000);

  it("is 503, not 404, when crm-api answers `reader: true` and leaves the asked deal out", async () => {
    hosts.fail("crm.resolve", { body: { reader: true, items: [] } });
    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 when crm-api says the deal is open but does not say who is involved: absent is not nobody", async () => {
    hosts.fail("crm.resolve", { body: { reader: true, items: [{ id: "d1", state: "open", writable: true, label: "Acme", href: "/crm/deals/d1" }] } });
    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503 on a crm-api that predates the deal resolve (it answers 422 to `entityType: \"deal\"`, plan R7)", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.crm.legacy = true;
    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  describe.each(OWNER_FAILURES)("when activities-api %s", (_name, mode) => {
    it("is 503, not 403, for a caller crm-api did not name: the scan could not be made, which is no \"not involved\"", async () => {
      hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
      hosts.activities.add({ id: "a1", subject: "Prepare the offer", deal: "d1", assignee: ALICE });
      hosts.fail("activities.list", mode);

      expectHostUnavailable(await post(body(deal("d1"))));
      expect(await entryRows()).toHaveLength(0);
    });

    it("changes nothing for the deal's own owner: crm-api's word is enough, the scan is never made", async () => {
      hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
      hosts.fail("activities.list", mode);

      expect((await post(body(deal("d1")))).status).toBe(201);
      expect(hosts.callsTo("activities.list")).toHaveLength(0);
    });
  });

  it("is 503 when activities-api is unreachable, or slower than its 2 s", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.sever("activities");
    expectHostUnavailable(await post(body(deal("d1"))));

    hosts.reset();
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.fail("activities.list", { delayMs: 2_600 });
    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
  }, 10_000);

  it("is 503, not 403, when a later page of the scan does not answer: a shorter list never passes for the whole one", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.activities.add({ id: "a-mine", subject: "Oldest, on page 2", deal: "d1", assignee: ALICE });
    for (let n = 1; n <= 120; n++) hosts.activities.add({ id: `a-${n}`, subject: `Activity ${n}`, deal: "d1", assignee: BOB });
    hosts.fail("activities.list", { status: 500, after: 1 });

    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503, never 403, when the scan holds an activity not about that deal: an owner that ignored its filter proves nothing (plan amendment 3)", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    const stray = (dealId: string | null) => ({
      id: "a-stray",
      type: "task",
      subject: "Somewhere else",
      project: null,
      deal: dealId === null ? null : { id: dealId },
      participants: [{ id: ALICE }],
      task: { assignee: { id: ALICE } },
    });

    for (const dealId of ["d-another", null]) {
      hosts.fail("activities.list", { body: { items: [stray(dealId)], total: 1, page: 1, pageSize: 100 } });
      // Even though it names the caller: an activity about another deal never makes anyone involved in this one.
      expectHostUnavailable(await post(body(deal("d1"))));
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("is 503, never 403, when the pages do not add up to the owner's `total`", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    const own = { id: "a1", type: "task", subject: "Prepare", project: null, deal: { id: "d1" }, participants: [], task: { assignee: { id: BOB } } };

    // `total` says 5, the only page holds 1.
    hosts.fail("activities.list", { body: { items: [own], total: 5, page: 1, pageSize: 100 } });
    expectHostUnavailable(await post(body(deal("d1"))));
    // An empty page while `total` says there is more.
    hosts.fail("activities.list", { body: { items: [], total: 150, page: 1, pageSize: 100 } });
    expectHostUnavailable(await post(body(deal("d1"))));
    expect(await entryRows()).toHaveLength(0);
  });
});

describe("an author who is no longer involved in the deal (AC-2.4)", () => {
  it("keeps the entry as it was, and can still delete it: deleting asks no owner", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    const created = await post(body(deal("d1"), { minutes: 90, note: "Kick-off" }));
    expect(created.status).toBe(201);

    // The deal is handed to someone else, and the owners fail on top of it.
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    hosts.fail("crm.resolve", { status: 500 });
    hosts.fail("activities.list", { status: 500 });
    expect(await rowOf(created.json.id)).toMatchObject({ dealId: "d1", minutes: 90, note: "Kick-off", userId: ALICE });

    const callsBefore = hosts.calls.length;
    const deleted = await remove(created.json.id);
    expect(deleted.status).toBe(204);
    expect(await entryRows()).toHaveLength(0);
    expect(hosts.calls).toHaveLength(callsBefore);
  });
});

describe("PATCH /time-entries/{id} that keeps the deal asks no owner for bookability (AC-2.12, D46)", () => {
  it("saves day, duration, note and work type after the author stopped being involved, with crm-api AND activities-api DOWN", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] }); // alice is no longer involved
    const entry = await makeDealEntry("d1", { workTypeId: SEED.workTypes.deal.estimate, note: "Sizing" });
    hosts.fail("crm.resolve", { status: 500 });
    hosts.fail("activities.list", { status: 500 });

    const res = await patch(entry.id, { day: "2026-11-03", minutes: 150, note: "Sizing, the long version", workTypeId: SEED.workTypes.deal.demo });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ day: "2026-11-03", minutes: 150, note: "Sizing, the long version", on: { type: "deal", id: "d1" } });
    expect(await rowOf(entry.id)).toMatchObject({ minutes: 150, workTypeId: SEED.workTypes.deal.demo, dealId: "d1" });
    // A bookability check would have scanned the deal's activities: that is never asked.
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("saves it when the deal is no longer readable by the author, crm-api up", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.crm.setReader(ALICE, false);
    const entry = await makeDealEntry("d1", { note: "Sizing" });

    const res = await patch(entry.id, { minutes: 90, note: "Sizing, again", day: "2026-11-04" });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ minutes: 90, on: { type: "deal", id: "d1", visibility: "hidden" } });
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("saves a PATCH whose `on` names the deal the entry is already on, and asks nothing about it", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    const entry = await makeDealEntry("d1");
    hosts.fail("activities.list", { status: 500 });

    const res = await patch(entry.id, { on: deal("d1"), minutes: 30 });

    expect(res.status).toBe(200);
    expect(res.json.minutes).toBe(30);
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });
});

describe("PATCH /time-entries/{id} that moves the entry onto a deal is checked like a new one (AC-2.12, D46)", () => {
  it("refuses another deal the caller is not involved in with 403 not_involved_in_deal and changes nothing", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.crm.setDeal("d2", { label: "Globex migration", involved: [BOB] });
    const entry = await makeDealEntry("d1", { minutes: 60, note: "Before" });

    const res = await patch(entry.id, { on: deal("d2"), minutes: 120, note: "After" });

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "not_involved_in_deal" });
    expect(await rowOf(entry.id)).toMatchObject({ dealId: "d1", minutes: 60, note: "Before" });
  });

  it("moves it to another deal the caller is involved in, asking about THAT deal — through the activities too when crm-api does not name them", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] }); // left it: no matter
    hosts.crm.setDeal("d2", { label: "Globex migration", involved: [BOB] });
    hosts.activities.add({ id: "a-d2", subject: "Prepare the offer", deal: "d2", participants: [ALICE] });
    const entry = await makeDealEntry("d1");

    const res = await patch(entry.id, { on: deal("d2") });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ on: { type: "deal", id: "d2" } });
    expect(await rowOf(entry.id)).toMatchObject({ target: "deal", dealId: "d2" });
    expect(hosts.callsTo("crm.resolve")[0]?.body).toEqual({ entityType: "deal", ids: ["d2"] });
    expect(hosts.callsTo("activities.list")[0]?.query.get("dealId")).toBe("d2");
  });

  it("moves an entry on no entity, a project and a meeting onto a deal the caller is involved in, and refuses one they are not", async () => {
    hosts.crm.setDeal("d-mine", { label: "Acme renewal", involved: [ALICE] });
    hosts.crm.setDeal("d-theirs", { label: "Globex migration", involved: [BOB] });
    const entries = [await makeNoEntityEntry(SEED.categories.training), await makeProjectEntry("p1"), await makeMeetingEntry("m1")];

    for (const entry of entries) {
      expect((await patch(entry.id, { on: deal("d-theirs") })).status).toBe(403);
      expect(await rowOf(entry.id)).toMatchObject({ dealId: null });
    }
    for (const entry of entries) {
      const res = await patch(entry.id, { on: deal("d-mine") });
      expect(res.status).toBe(200);
      expect(await rowOf(entry.id)).toMatchObject({ target: "deal", dealId: "d-mine", categoryId: null, projectId: null, meetingId: null });
    }
  });

  it("answers 404 for a deal that is missing or that the caller may not read: one body, the entry unchanged", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    hosts.crm.setDeal("d-secret", { label: "Secret", involved: [ALICE] });
    const entry = await makeDealEntry("d1");

    const missing = await patch(entry.id, { on: deal("d-nobody") });
    hosts.crm.setReader(ALICE, false);
    const unreadable = await patch(entry.id, { on: deal("d-secret") });

    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: "not_found" });
    expect(unreadable.text).toBe(missing.text);
    expect(await rowOf(entry.id)).toMatchObject({ dealId: "d1" });
  });

  it("is 503 when an owner of the new deal does not answer, and the entry is as it was", async () => {
    hosts.crm.setDeal("d2", { label: "Globex migration", involved: [BOB] });
    hosts.activities.add({ id: "a-d2", subject: "Prepare the offer", deal: "d2", assignee: ALICE });
    const entry = await makeDealEntry("d1", { minutes: 60 });

    hosts.fail("crm.resolve", { status: 500 });
    expectHostUnavailable(await patch(entry.id, { on: deal("d2"), minutes: 90 }));
    hosts.heal("crm.resolve");
    hosts.fail("activities.list", { status: 500 });
    expectHostUnavailable(await patch(entry.id, { on: deal("d2"), minutes: 90 }));

    expect(await rowOf(entry.id)).toMatchObject({ dealId: "d1", minutes: 60 });
  });

  it("carries a deal work type to another deal, retired since or not, and refuses it on a move to a project or a meeting unless `workTypeId: null`", async () => {
    hosts.crm.setDeal("d2", { label: "Globex migration", involved: [ALICE] });
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const retired = await makeWorkType("deal", "Workshops");
    const entry = await makeDealEntry("d1", { workTypeId: retired.id });
    await db.workType.update({ where: { id: retired.id }, data: { retiredAt: new Date() } });

    const moved = await patch(entry.id, { on: deal("d2") });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ on: { id: "d2" }, workType: { id: retired.id, name: "Workshops", retired: true } });

    // A deal work type does not fit a project: no owner is asked, nothing changes.
    hosts.reset();
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const refused = await patch(entry.id, { on: project("p1") });
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ code: "work_type_not_allowed", field: "workTypeId" });
    expect(hosts.calls).toHaveLength(0);
    expect(await rowOf(entry.id)).toMatchObject({ dealId: "d2", workTypeId: retired.id });

    expect((await patch(entry.id, { on: project("p1"), workTypeId: null })).status).toBe(200);
  });

  it("refuses 45 minutes on a deal the caller is not involved in with 422 invalid_minutes, not 403, and asks no owner (local rules first)", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });

    const res = await post(body(deal("d1"), { minutes: 45 }));

    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "invalid_minutes", field: "minutes" });
    expect(hosts.calls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
  });

  it("refuses a work type of the project list on a deal with 422 work_type_not_allowed before any owner is asked", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [BOB] });
    const res = await post(body(deal("d1"), { workTypeId: SEED.workTypes.project.development }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "work_type_not_allowed", field: "workTypeId" });
    expect(hosts.calls).toHaveLength(0);
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
  ["a space at the start", " d1"],
  ["a space at the end", "d1 "],
  ["a tab at the start", "\td1"],
];

describe("an `on.id` outside the id rule is hours-api's own 400 for a deal too (AC-2.10; plan § Entries)", () => {
  it.each(BAD_IDS)("POST with a deal id that is %s: 400 `on.id`, neither crm-api nor activities-api asked, nothing written", async (_name, id) => {
    const res = await post(body({ type: "deal", id }));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_request", field: "on.id" });
    expect(hosts.calls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
  });

  it.each(BAD_IDS)("PATCH with a deal id that is %s: 400 `on.id`, no owner asked, the entry unchanged", async (_name, id) => {
    const entry = await makeNoEntityEntry(SEED.categories.training, { minutes: 60 });
    const res = await patch(entry.id, { on: { type: "deal", id }, minutes: 90 });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_request", field: "on.id" });
    expect(hosts.calls).toHaveLength(0);
    expect(await rowOf(entry.id)).toMatchObject({ target: "none", minutes: 60 });
  });
});
