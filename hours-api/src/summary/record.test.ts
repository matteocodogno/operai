/**
 * Who may read the record, and what happens when that cannot be said, for `GET /time-entries/summary` (specs/20261112-project-hours T9; AC-1.8, AC-2.1, AC-2.2, AC-4.9;
 * plan § Who may see what 1 and 3, § API contracts; ADR 20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states
 * and ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route), through the ASSEMBLED app, against the real database and the fake owners of T11.
 *
 * The record's OWNER says whether the caller reads it — projects-api for a project, crm-api for a deal — asked AS THE CALLER, on every request. A record
 * that does not exist and one the caller may not read are ONE answer, 404, with one body: the id space is no oracle for what other people may read. An owner
 * or meetings-api that does not answer is 503 `host_unavailable` and nothing partial, never a figure lower than the truth and never a guess that the caller reads.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, bearerOf, call, makeDealEntry, makeMeetingEntry, makeProjectEntry, resetWorld, type PersonaName } from "../test-support/world";
import { claimsOf, startHosts, type FailureMode, type RouteName } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import { __resetOversightCacheForTests } from "../oversight/oversight";

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
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

const summary = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries/summary?${query}`, { as });

/** What an owner that does not answer looks like: none of these may pass for "yes" or for "no". */
const OWNER_FAILURES: ReadonlyArray<readonly [string, FailureMode]> = [
  ["answers 500", { status: 500 }],
  ["answers 404, a route it has not deployed", { status: 404 }],
  ["answers 422, a version that predates the contract", { status: 422 }],
  ["answers a good body under another 2xx status", { withStatus: 203 }],
  ["breaks its contract", { malformed: true }],
  ["answers text that is not JSON", { rawBody: "<html>bad gateway</html>" }],
  ["answers slower than 2 s", { delayMs: 2_600 }],
  ["redirects", { redirect: true }],
];

describe("a record the caller may not read, or that does not exist, is ONE 404 (AC-1.8; plan § Who may see what 1)", () => {
  it("is the same answer for a project that does not exist and for one the caller may not read: status, code and body, the id aside", async () => {
    hosts.projects.setProject("secret", { label: "Secret reorganisation" });
    hosts.projects.setReader(ALICE, false);
    await makeProjectEntry("secret", { userId: BOB, minutes: 600 });

    const unreadable = await summary("projectId=secret");
    const missing = await summary("projectId=nobody");

    expect(unreadable.status).toBe(404);
    expect(unreadable.json).toMatchObject({ status: 404, code: "not_found" });
    expect(unreadable.text).toBe(missing.text);
    expect(unreadable.json).not.toHaveProperty("totalMinutes");
    // The refusal names no record: not its id, not its name, not its hours.
    expect(unreadable.text).not.toMatch(/secret|Secret reorganisation|600/);
  });

  it("is the same for a deal: a reader of the CRM who does not read this one, and a deal that is not there", async () => {
    hosts.crm.setDeal("d-secret", { label: "Acquisition of ACME" });
    hosts.crm.setReader(ALICE, false);
    await makeDealEntry("d-secret", { userId: BOB, minutes: 600 });

    const unreadable = await summary("dealId=d-secret");
    const missing = await summary("dealId=nobody");

    expect(unreadable.status).toBe(404);
    expect(unreadable.json).toMatchObject({ status: 404, code: "not_found" });
    expect(unreadable.text).toBe(missing.text);
    expect(unreadable.text).not.toMatch(/d-secret|ACME|600/);
  });

  it("is the same body for a project and for a deal, so the kind of record the caller asked about reveals nothing", async () => {
    hosts.projects.setReader(ALICE, false);
    hosts.crm.setReader(ALICE, false);

    const ofProject = await summary("projectId=x");
    const ofDeal = await summary("dealId=x");

    expect(ofProject.status).toBe(404);
    expect(ofDeal.status).toBe(404);
    expect(ofProject.text).toBe(ofDeal.text);
  });

  it("is a 404 for someone else's record, too: a project the caller reads is not another caller's, and a holder of everyone's hours does not make a record readable", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.projects.setReader(PERSONAS.holder.sub, false);
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");

    expect((await summary("projectId=p1", "holder")).status).toBe(404);
    // ...while the caller who reads it is answered.
    expect((await summary("projectId=p1", "alice")).status).toBe(200);
  });

  it("asks the owner AS THE CALLER, with the caller's own token, and nobody else before it: not meetings-api, not auth", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.projects.setReader(ALICE, false);

    await summary("projectId=p1");

    const resolves = hosts.callsTo("projects.resolve");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]?.authorization).toBe(await bearerOf("alice"));
    expect(resolves[0]?.body).toEqual({ entityType: "project", ids: ["p1"] });
    // A caller who may not read the record never makes hours-api ask anything else about it.
    expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
    expect(hosts.callsTo("auth.identities")).toEqual([]);
  });

  it("asks crm-api, as the caller, for a deal, and never projects-api", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });

    await summary("dealId=d1");

    expect(hosts.callsTo("crm.resolve")).toHaveLength(1);
    expect(hosts.callsTo("crm.resolve")[0]?.authorization).toBe(await bearerOf("alice"));
    expect(hosts.callsTo("crm.resolve")[0]?.body).toEqual({ entityType: "deal", ids: ["d1"] });
    expect(hosts.callsTo("projects.resolve")).toEqual([]);
  });

  it("asks again on every request and keeps nothing: a reader who stops reading is refused at once", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    expect((await summary("projectId=p1")).status).toBe(200);

    hosts.projects.setReader(ALICE, false);

    expect((await summary("projectId=p1")).status).toBe(404);
    expect(hosts.callsTo("projects.resolve")).toHaveLength(2);
  });
});

describe("an owner that does not answer is a 503 host_unavailable, and nothing partial (AC-2.6; plan § Who may see what 1)", () => {
  const OWNERS: ReadonlyArray<readonly [string, RouteName, string]> = [
    ["a project's owner", "projects.resolve", "projectId=p1"],
    ["a deal's owner", "crm.resolve", "dealId=d1"],
  ];

  for (const [who, route, query] of OWNERS) {
    it.each(OWNER_FAILURES)(`${who} that ${"%s"} is 503, never "readable" and never "not found"`, async (_what, mode) => {
      hosts.projects.setProject("p1", { label: "Alpha" });
      hosts.crm.setDeal("d1", { label: "Deal one" });
      await makeProjectEntry("p1", { minutes: 60 });
      await makeDealEntry("d1", { minutes: 60 });
      hosts.fail(route, mode);

      const res = await summary(query);

      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ status: 503, code: "host_unavailable" });
      for (const member of ["totalMinutes", "byWorkType", "byPerson", "windowMinutes", "on"]) expect(res.json).not.toHaveProperty(member);
    });
  }

  it("is 503 for an owner that cannot be reached at all", async () => {
    hosts.sever("projects");

    expect((await summary("projectId=p1")).status).toBe(503);
  });

  it("answers again, whole, once the owner does", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    await makeProjectEntry("p1", { minutes: 60 });
    hosts.fail("projects.resolve", { status: 500 });
    expect((await summary("projectId=p1")).status).toBe(503);

    hosts.heal("projects.resolve");

    expect((await summary("projectId=p1")).json).toMatchObject({ totalMinutes: 60 });
  });
});

describe("meetings-api not saying which meetings are linked is a 503, and no figure lower than the truth (AC-4.9; D45)", () => {
  const OUTAGES: ReadonlyArray<readonly [string, () => void]> = [
    ["answering 500", () => hosts.fail("meetings.system-hosts", { status: 500 })],
    ["answering 401 to the credential, even after a fresh one", () => hosts.fail("meetings.system-hosts", { status: 401 })],
    ["a route that is not deployed yet (404)", () => hosts.fail("meetings.system-hosts", { status: 404 })],
    ["a meetings-api that predates the filter and refuses `projectId` or `dealId` (422, plan R2)", () => hosts.fail("meetings.system-hosts", { status: 422 })],
    ["a body that is not the route's shape", () => hosts.fail("meetings.system-hosts", { malformed: true })],
    ["slower than 2 s", () => hosts.fail("meetings.system-hosts", { delayMs: 2_600 })],
    ["a connection that cannot be made", () => hosts.sever("meetings")],
    ["no credential: auth would not mint one", () => hosts.fail("auth.service-token", { status: 500 })],
  ];

  for (const [kind, query] of [
    ["project", "projectId=p1"],
    ["deal", "dealId=d1"],
  ] as const) {
    it.each(OUTAGES)(`is a 503 host_unavailable for a ${kind}, with no figure at all, however it is down: %s`, async (_what, breakIt) => {
      hosts.projects.setProject("p1", { label: "Alpha" });
      hosts.crm.setDeal("d1", { label: "Deal one" });
      hosts.meetings.add({ id: "m1", creator: BOB });
      hosts.meetings.relinkProject("m1", "p1");
      hosts.meetings.relink("m1", "d1");
      await makeProjectEntry("p1", { minutes: 60 });
      await makeDealEntry("d1", { minutes: 60 });
      await makeMeetingEntry("m1", { userId: BOB, minutes: 120 });
      breakIt();

      const res = await summary(query);

      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ status: 503, code: "host_unavailable" });
      // Not the record's own entries (a total without the meetings is lower than the truth), not an empty answer, not a partial one.
      for (const member of ["totalMinutes", "windowMinutes", "byWorkType", "byPerson", "unavailable", "on"]) expect(res.json).not.toHaveProperty(member);
    });
  }

  it("says what is not shown, the project's or the deal's hours", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.fail("meetings.system-hosts", { status: 500 });

    expect((await summary("projectId=p1")).json.detail).toContain("project");
    expect((await summary("dealId=d1")).json.detail).toContain("deal");
  });

  it("is asked with hours-api's own credential and never the caller's, once", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });

    await summary("projectId=p1");

    const asked = hosts.callsTo("meetings.system-hosts");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).not.toBe(await bearerOf("alice"));
    expect(claimsOf(asked[0]?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", scope: "meetings.hosts.read" });
  });

  it("answers again, whole, once meetings-api does", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relinkProject("m1", "p1");
    await makeMeetingEntry("m1", { userId: BOB, minutes: 120 });
    hosts.fail("meetings.system-hosts", { status: 500 });
    expect((await summary("projectId=p1")).status).toBe(503);

    hosts.heal("meetings.system-hosts");

    expect((await summary("projectId=p1")).json).toMatchObject({ totalMinutes: 120 });
  });
});
