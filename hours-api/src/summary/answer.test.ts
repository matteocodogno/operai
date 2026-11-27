/**
 * What the answer of `GET /time-entries/summary` is made of, and never is (specs/20261112-project-hours T9; AC-1.8, AC-3.1; plan § Who may see what 4, § Security; ADR
 * 20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states, point 5 and § Risks), through the ASSEMBLED
 * app, against the real database and the fake owners of T11.
 *
 * The summary is groups of minutes: no entry, no note, no meeting id or title, no activity subject, no amount, price or rate. A key-set test fails the build when a member appears
 * that is not in the plan's `SummaryAnswer`, whoever the caller is and however much of the answer they are shown. And it is never cached: what the per-person part shows is the
 * caller's right at the moment of the read.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, SEED, call, makeDealEntry, makeMeetingEntry, makeProjectEntry, resetWorld, type PersonaName } from "../test-support/world";
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

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
  hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
});

const summary = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries/summary?${query}`, { as });

/** Every member name an answer carries, at any depth. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

/** What `SummaryAnswer` of plan.md § API contracts is made of, at any depth: the members of the answer, of `on` and of the groups. */
const ALLOWED_KEYS = ["byPerson", "byWorkType", "id", "key", "kind", "label", "minutes", "on", "retired", "status", "totalMinutes", "type", "unavailable", "windowMinutes"];

/**
 * A project p1 and a deal d1 loaded with everything an answer must NOT carry: notes, the activity an entry points at, a meeting with a title and
 * people, an automatic entry of a meeting, and words that look like money.
 */
async function loadedRecords() {
  hosts.projects.setProject("p1", { label: "Project Alpha", projectManagerId: ALICE, assignees: [ALICE, BOB] });
  hosts.crm.setDeal("d1", { label: "Deal Omega", ownerUserId: ALICE, involved: [ALICE] });
  hosts.activities.add({ id: "act-1", subject: "Renegotiate the fee of CHF 120 per hour", project: "p1", assignee: BOB });
  hosts.meetings.add({ id: "meeting-secret-id", title: "Layoffs and the rate card", creator: BOB, participants: [ALICE] });
  hosts.meetings.relinkProject("meeting-secret-id", "p1");
  hosts.meetings.add({ id: "meeting-deal-id", title: "Price negotiation", creator: BOB });
  hosts.meetings.relink("meeting-deal-id", "d1");

  const first = await makeProjectEntry("p1", { userId: BOB, minutes: 120, workTypeId: SEED.workTypes.project.development, note: "A private note about the invoice of 9000 CHF", activityId: "act-1" });
  await makeProjectEntry("p1", { userId: ALICE, minutes: 60 });
  await makeMeetingEntry("meeting-secret-id", { userId: BOB, minutes: 90, automatic: "untouched" });
  await makeDealEntry("d1", { userId: BOB, minutes: 60, workTypeId: SEED.workTypes.deal.offer, note: "Discount of 15 percent" });
  await makeMeetingEntry("meeting-deal-id", { userId: ALICE, minutes: 30 });
  return { entryId: first.id };
}

describe("the answer carries groups of minutes and nothing else (AC-1.8, AC-3.1; ADR point 5)", () => {
  const CASES: ReadonlyArray<readonly [string, string, PersonaName]> = [
    ["a project, as its manager, who sees the most", "projectId=p1&windowFrom=2026-01-01&windowTo=2026-12-31", "alice"],
    ["a project, as a reader", "projectId=p1&windowFrom=2026-01-01&windowTo=2026-12-31", "carol"],
    ["a project, as a holder of everyone's hours", "projectId=p1", "holder"],
    ["a deal, as its owner", "dealId=d1", "alice"],
    ["a deal, as a reader", "dealId=d1", "carol"],
  ];

  it.each(CASES)("has the members of SummaryAnswer and no other, at any depth: %s", async (_what, query, as) => {
    await loadedRecords();

    const res = await summary(query, as);

    expect(res.status).toBe(200);
    const keys = [...keysOf(res.json)].sort();
    expect(keys.filter((key) => !ALLOWED_KEYS.includes(key))).toEqual([]);
    // The answer's own members are all there.
    expect(Object.keys(res.json).sort()).toEqual(["byPerson", "byWorkType", "on", "totalMinutes", "unavailable", "windowMinutes"]);
    expect(Object.keys(res.json.on).sort()).toEqual(["id", "type"]);
  });

  it.each(CASES)("names no entry, note, activity, meeting, deal or project name, and no amount: %s", async (_what, query, as) => {
    const { entryId } = await loadedRecords();

    const res = await summary(query, as);

    expect(res.status).toBe(200);
    for (const forbidden of [
      entryId,
      "private note",
      "9000",
      "invoice",
      "Discount",
      "act-1",
      "Renegotiate",
      "CHF",
      "meeting-secret-id",
      "meeting-deal-id",
      "Layoffs",
      "rate card",
      "Price negotiation",
      "Project Alpha",
      "Deal Omega",
    ]) {
      expect({ forbidden, found: res.text.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
  });

  it("gives each group a kind, minutes and, by kind, its key, label, retired or status: no group member beyond the plan's TotalsGroup", async () => {
    await loadedRecords();

    const { byWorkType, byPerson } = (await summary("projectId=p1", "alice")).json;

    for (const group of byWorkType) {
      expect(Object.keys(group).sort()).toEqual(group.kind === "keyed" ? ["key", "kind", "label", "minutes", "retired"] : ["kind", "minutes"]);
    }
    for (const group of byPerson) expect(Object.keys(group).sort()).toEqual(["key", "kind", "label", "minutes", "status"]);
  });

  it("is minutes, whole numbers, and never a group of nothing", async () => {
    await loadedRecords();

    const { totalMinutes, windowMinutes, byWorkType, byPerson } = (await summary("projectId=p1&windowFrom=2026-01-01&windowTo=2026-12-31", "alice")).json;

    for (const figure of [totalMinutes, windowMinutes, ...byWorkType.map((group: { minutes: number }) => group.minutes), ...byPerson.map((group: { minutes: number }) => group.minutes)]) {
      expect(Number.isInteger(figure)).toBe(true);
    }
    for (const group of [...byWorkType, ...byPerson]) expect(group.minutes).toBeGreaterThan(0);
  });
});

describe("the answer is never cached (ADR § Risks: a change to this header names the ADR)", () => {
  it("is Cache-Control: no-store, for a project and for a deal, whatever the caller is shown", async () => {
    await loadedRecords();

    for (const [query, as] of [
      ["projectId=p1", "alice"],
      ["projectId=p1", "carol"],
      ["dealId=d1", "alice"],
      ["dealId=d1", "carol"],
    ] as const) {
      const res = await summary(query, as);
      expect({ query, as, status: res.status, cache: res.headers.get("cache-control") }).toEqual({ query, as, status: 200, cache: "no-store" });
    }
  });

  it("is also what a refusal says: a 404 or a 503 about a record is no more to be kept than its figures", async () => {
    hosts.projects.setReader(ALICE, false);
    const refused = await summary("projectId=p1");
    hosts.heal("projects.resolve");
    hosts.fail("projects.resolve", { status: 500 });
    const unavailable = await summary("projectId=p1");

    expect(refused.status).toBe(404);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  });
});
