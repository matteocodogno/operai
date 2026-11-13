/**
 * The labels layer on its own (specs/029 T13; plan § Views "How `on.deal` is filled" and "A deal id read
 * from the system route passes the id rule", § Sequences "List / totals" step 4, § Reading the owners' list
 * answers; AC-2.6, AC-4.5, AC-4.7, AC-4.10). `src/entries/view.test.ts` reads the assembled entry view;
 * this file pins what `src/totals/` (T18) will group by and what the view cannot show by itself: which
 * source is asked when, with whose credential, in how many calls, and what a deal id may be.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, bearerOf, resetWorld } from "../test-support/world";
import { claimsOf, startHosts } from "../test-support/hosts";
import { resolveLabels, type LabelNeeds } from "./resolve";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = PERSONAS.alice.sub;

beforeEach(async () => {
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** Labels for `needs`, as `viewer` reads them. */
async function labelsFor(needs: LabelNeeds, viewer: keyof typeof PERSONAS = "alice") {
  return resolveLabels(await bearerOf(viewer), needs);
}

const crmIdsSent = () => hosts.callsTo("crm.resolve").flatMap((call) => (call.body as { ids: string[] }).ids);

describe("the deal a meeting counts for", () => {
  it("is the deal's id, name and link when the viewer may read the deal", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });

    const labels = await labelsFor({ meetingDealIds: ["m1"] });

    expect(labels.meetingDeal("m1")).toEqual({ state: "linked", visibility: "visible", id: "d1", label: "Acme renewal", href: "/crm/deals/d1" });
    expect(labels.unavailable).toEqual([]);
  });

  it("carries neither id nor name when the viewer may not read the deal: only that the meeting is linked", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "secret-deal-id" });
    hosts.crm.setDeal("secret-deal-id", { label: "Secret deal name" });
    hosts.crm.setReader(ALICE, false);

    const labels = await labelsFor({ meetingDealIds: ["m1"] });

    const deal = labels.meetingDeal("m1");
    expect(deal).toEqual({ state: "linked", visibility: "hidden" });
    expect("id" in deal).toBe(false);
    expect(JSON.stringify(deal)).not.toContain("secret-deal-id");
    expect(JSON.stringify(deal)).not.toContain("Secret deal name");
    expect(labels.unavailable).toEqual([]);
  });

  it("is hidden alike for a deal crm-api does not hold", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "no-such-deal" });

    const labels = await labelsFor({ meetingDealIds: ["m1"] });

    expect(labels.meetingDeal("m1")).toEqual({ state: "linked", visibility: "hidden" });
  });

  it("is none when meetings-api answered: no deal, or no meeting any more, and crm-api is not asked", async () => {
    hosts.meetings.add({ id: "m-free", creator: ALICE, dealId: null });

    const labels = await labelsFor({ meetingDealIds: ["m-free", "m-deleted"] });

    expect(labels.meetingDeal("m-free")).toEqual({ state: "none" });
    expect(labels.meetingDeal("m-deleted")).toEqual({ state: "none" });
    expect(labels.unavailable).toEqual([]);
    expect(hosts.callsTo("crm.resolve")).toHaveLength(0);
  });

  it("follows a relink on the next read", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d-old" });
    hosts.crm.setDeal("d-old", { label: "Old deal" });
    hosts.crm.setDeal("d-new", { label: "New deal" });
    expect((await labelsFor({ meetingDealIds: ["m1"] })).meetingDeal("m1")).toMatchObject({ id: "d-old", label: "Old deal" });

    hosts.meetings.relink("m1", "d-new");

    expect((await labelsFor({ meetingDealIds: ["m1"] })).meetingDeal("m1")).toMatchObject({ id: "d-new", label: "New deal" });
  });

  it("is unknown when the system route does not answer, in any way, and `meeting-deals` is named", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });

    const failures = [
      { status: 500 },
      { status: 404 }, // a meetings-api that has not deployed the route yet (R7)
      { status: 401 }, // a credential it refuses
      { malformed: true },
      { rawBody: "<html>not json</html>" },
      { body: { items: [{ id: "m1", host: "crm:d1" }] } }, // not the route's shape
      { redirect: true },
    ];
    for (const mode of failures) {
      hosts.heal("meetings.system-hosts");
      hosts.fail("meetings.system-hosts", mode);

      const labels = await labelsFor({ meetingDealIds: ["m1"] });

      expect(labels.meetingDeal("m1")).toEqual({ state: "unknown" });
      expect(labels.unavailable).toEqual(["meeting-deals"]);
    }
  });

  it("is unknown when the system route ignored its filter: a foreign item and the asked meeting missing (plan amendment 3)", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    hosts.fail("meetings.system-hosts", { body: { items: [{ id: "someone-elses", host: null }] } });

    const labels = await labelsFor({ meetingDealIds: ["m1"] });

    expect(labels.meetingDeal("m1")).toEqual({ state: "unknown" });
    expect(labels.unavailable).toEqual(["meeting-deals"]);
  });

  it("still asks crm-api for the direct deals when the system route does not answer, and each source is named for itself", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Meeting deal" });
    hosts.crm.setDeal("d-direct", { label: "Direct deal" });
    hosts.fail("meetings.system-hosts", { status: 500 });

    const labels = await labelsFor({ meetingDealIds: ["m1"], dealIds: ["d-direct"] });

    expect(labels.deal("d-direct")).toEqual({ visibility: "visible", label: "Direct deal", href: "/crm/deals/d-direct" });
    expect(labels.meetingDeal("m1")).toEqual({ state: "unknown" });
    expect(crmIdsSent()).toEqual(["d-direct"]);
    expect(labels.unavailable).toEqual(["meeting-deals"]);
  });

  it("is linked and unavailable when crm-api does not answer, and `crm` is named", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    hosts.fail("crm.resolve", { status: 503 });

    const labels = await labelsFor({ meetingDealIds: ["m1"] });

    expect(labels.meetingDeal("m1")).toEqual({ state: "linked", visibility: "unavailable" });
    expect(labels.unavailable).toEqual(["crm"]);
  });

  it("reads the link with hours-api's own service credential, never the viewer's, and the deal as the viewer", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });

    await labelsFor({ meetingDealIds: ["m1"] });

    const system = hosts.callsTo("meetings.system-hosts");
    expect(system).toHaveLength(1);
    expect(system[0]?.authorization).not.toBe(await bearerOf("alice"));
    expect(claimsOf(system[0]?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", scope: "meetings.hosts.read" });
    expect(system[0]?.query.get("ids")).toBe("m1");
    expect(hosts.callsTo("crm.resolve")[0]?.authorization).toBe(await bearerOf("alice"));
  });
});

describe("a page's deals go to crm-api in one batch (plan § Sequences, List / totals step 4)", () => {
  it("sends the direct deals and the meetings' deals together, each once, in ONE resolve call as the viewer", async () => {
    hosts.crm.setDeal("d-direct", { label: "Direct" });
    hosts.crm.setDeal("d-shared", { label: "Shared" });
    hosts.crm.setDeal("d-via-meeting", { label: "Via meeting" });
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d-via-meeting" });
    hosts.meetings.add({ id: "m2", creator: ALICE, dealId: "d-shared" });
    hosts.meetings.add({ id: "m3", creator: ALICE, dealId: "d-shared" });

    const labels = await labelsFor({ dealIds: ["d-direct", "d-shared"], meetingDealIds: ["m1", "m2", "m3"] });

    const calls = hosts.callsTo("crm.resolve");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(await bearerOf("alice"));
    expect([...crmIdsSent()].sort()).toEqual(["d-direct", "d-shared", "d-via-meeting"]);
    expect(labels.deal("d-direct")).toMatchObject({ label: "Direct" });
    expect(labels.meetingDeal("m1")).toMatchObject({ id: "d-via-meeting", label: "Via meeting" });
    expect(labels.meetingDeal("m2")).toMatchObject({ id: "d-shared", label: "Shared" });
    expect(labels.meetingDeal("m3")).toMatchObject({ id: "d-shared", label: "Shared" });
  });

  it("splits a page of more deals than crm-api takes at once into batches of 25", async () => {
    const direct = Array.from({ length: 30 }, (_, i) => `d-${i}`);
    const meetingIds = Array.from({ length: 30 }, (_, i) => `m-${i}`);
    for (const id of direct) hosts.crm.setDeal(id, { label: `Deal ${id}` });
    meetingIds.forEach((id, i) => {
      hosts.crm.setDeal(`dm-${i}`, { label: `Meeting deal ${i}` });
      hosts.meetings.add({ id, creator: ALICE, dealId: `dm-${i}` });
    });

    const labels = await labelsFor({ dealIds: direct, meetingDealIds: meetingIds });

    expect(hosts.callsTo("crm.resolve")).toHaveLength(3);
    expect(new Set(crmIdsSent()).size).toBe(60);
    expect(labels.deal("d-29").visibility).toBe("visible");
    expect(labels.meetingDeal("m-29")).toMatchObject({ visibility: "visible", id: "dm-29" });
    expect(labels.unavailable).toEqual([]);
  });
});

describe("a stored host that is not a CRM deal (plan amendment 2, 2026-11-13)", () => {
  it("is no deal: `none`, its entityId never sent to crm-api, `meeting-deals` not named, the batch's other meetings keep their deals", async () => {
    hosts.meetings.add({ id: "m-widget", creator: ALICE, host: { app: "testhost", entityType: "widget", entityId: "widget-77" } });
    hosts.meetings.add({ id: "m-deal", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });

    const labels = await labelsFor({ meetingDealIds: ["m-widget", "m-deal"] });

    expect(labels.meetingDeal("m-widget")).toEqual({ state: "none" });
    expect(labels.meetingDeal("m-deal")).toMatchObject({ state: "linked", visibility: "visible", id: "d1" });
    expect(labels.unavailable).toEqual([]);
    expect(crmIdsSent()).toEqual(["d1"]);
  });

  it("does not read a crm host of another entity type, or an app that only looks like crm, as a deal", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, host: { app: "crm", entityType: "company", entityId: "c1" } });
    hosts.meetings.add({ id: "m2", creator: ALICE, host: { app: "CRM", entityType: "deal", entityId: "d1" } });

    const labels = await labelsFor({ meetingDealIds: ["m1", "m2"] });

    expect(labels.meetingDeal("m1")).toEqual({ state: "none" });
    expect(labels.meetingDeal("m2")).toEqual({ state: "none" });
    expect(hosts.callsTo("crm.resolve")).toHaveLength(0);
  });
});

describe("a meeting's deal id outside the id rule (plan amendment 3, 2026-11-13)", () => {
  const OUTSIDE_THE_RULE = [
    ["65 characters", "x".repeat(65)],
    ["a NUL", "d\u0000x"],
    ["a comma", "a,b"],
    ["a leading space", " d1"],
    ["a trailing space", "d1 "],
    ["only spaces", "   "],
  ] as const;

  for (const [name, entityId] of OUTSIDE_THE_RULE) {
    it(`with ${name}: linked and hidden, never sent to crm-api, the page's other deals keep their labels, \`crm\` is not named`, async () => {
      hosts.meetings.add({ id: "m-odd", creator: ALICE, host: { app: "crm", entityType: "deal", entityId } });
      hosts.meetings.add({ id: "m-fine", creator: ALICE, dealId: "d-fine" });
      hosts.crm.setDeal("d-fine", { label: "Fine deal" });
      hosts.crm.setDeal("d-direct", { label: "Direct deal" });

      const labels = await labelsFor({ meetingDealIds: ["m-odd", "m-fine"], dealIds: ["d-direct"] });

      expect(labels.meetingDeal("m-odd")).toEqual({ state: "linked", visibility: "hidden" });
      expect(labels.meetingDeal("m-fine")).toMatchObject({ state: "linked", visibility: "visible", id: "d-fine", label: "Fine deal" });
      expect(labels.deal("d-direct")).toMatchObject({ visibility: "visible", label: "Direct deal" });
      expect(labels.unavailable).toEqual([]);
      expect(crmIdsSent()).not.toContain(entityId);
      expect([...crmIdsSent()].sort()).toEqual(["d-direct", "d-fine"]);
    });
  }

  it("stays hidden while crm-api is down and the page's other deals are unavailable", async () => {
    hosts.meetings.add({ id: "m-odd", creator: ALICE, host: { app: "crm", entityType: "deal", entityId: "x".repeat(65) } });
    hosts.meetings.add({ id: "m-fine", creator: ALICE, dealId: "d-fine" });
    hosts.crm.setDeal("d-fine", { label: "Fine deal" });
    hosts.fail("crm.resolve", { status: 500 });

    const labels = await labelsFor({ meetingDealIds: ["m-odd", "m-fine"], dealIds: ["d-direct"] });

    expect(labels.meetingDeal("m-odd")).toEqual({ state: "linked", visibility: "hidden" });
    expect(labels.meetingDeal("m-fine")).toEqual({ state: "linked", visibility: "unavailable" });
    expect(labels.deal("d-direct").visibility).toBe("unavailable");
    expect(labels.unavailable).toEqual(["crm"]);
  });

  it("makes no crm-api call at all when the only deal is outside the rule, so `crm` is not named even with crm-api down", async () => {
    hosts.meetings.add({ id: "m-odd", creator: ALICE, host: { app: "crm", entityType: "deal", entityId: " d1" } });
    hosts.fail("crm.resolve", { status: 500 });

    const labels = await labelsFor({ meetingDealIds: ["m-odd"] });

    expect(labels.meetingDeal("m-odd")).toEqual({ state: "linked", visibility: "hidden" });
    expect(labels.unavailable).toEqual([]);
    expect(hosts.callsTo("crm.resolve")).toHaveLength(0);
  });

  it("an empty entityId names nothing: no deal", async () => {
    hosts.meetings.add({ id: "m-empty", creator: ALICE, host: { app: "crm", entityType: "deal", entityId: "" } });

    const labels = await labelsFor({ meetingDealIds: ["m-empty"] });

    expect(labels.meetingDeal("m-empty")).toEqual({ state: "none" });
    expect(labels.unavailable).toEqual([]);
    expect(hosts.callsTo("crm.resolve")).toHaveLength(0);
  });
});

describe("only what a read needs is asked (plan § Totals, \"Sources asked\")", () => {
  it("asks nothing for nothing: no call, nothing unavailable", async () => {
    const labels = await labelsFor({});

    expect(hosts.calls).toHaveLength(0);
    expect(labels.unavailable).toEqual([]);
  });

  it("asks one source for one kind of id, and names no other when it fails", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.fail("auth.identities", { status: 500 });
    hosts.fail("meetings.system-hosts", { status: 500 });
    hosts.fail("crm.resolve", { status: 500 });

    const labels = await labelsFor({ projectIds: ["p1"] });

    expect(hosts.calls.map((call) => call.route)).toEqual(["projects.resolve"]);
    expect(labels.project("p1")).toEqual({ visibility: "visible", label: "Apollo", href: "/projects/p1" });
    expect(labels.unavailable).toEqual([]);
  });

  it("reads a meeting's deal without reading its title, and its title without its deal", async () => {
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });

    await labelsFor({ meetingDealIds: ["m1"] });
    // The service credential is minted for the system route; the title list and `auth`'s identities are not touched.
    expect(hosts.calls.map((call) => call.route).sort()).toEqual(["auth.service-token", "crm.resolve", "meetings.system-hosts"]);

    hosts.reset();
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE, dealId: "d1" });
    const titled = await labelsFor({ meetingIds: ["m1"] });
    expect(hosts.calls.map((call) => call.route)).toEqual(["meetings.list"]);
    expect(titled.meeting("m1")).toMatchObject({ visibility: "visible", label: "Kick-off" });
  });

  it("names `identities` for a person auth cannot name, as for an outage: the name is not known either way", async () => {
    hosts.auth.setIdentity("user-ghost", { name: null, status: "unknown" });

    const labels = await labelsFor({ userIds: ["user-ghost", ALICE] });

    expect(labels.person("user-ghost")).toEqual({ id: "user-ghost", name: null, status: "unknown" });
    expect(labels.person(ALICE)).toEqual({ id: ALICE, name: "Name of alice", status: "active" });
    expect(labels.unavailable).toEqual(["identities"]);
  });

  it("refuses a label nobody listed in the needs: a bug of the caller, not an empty answer", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.activities.add({ id: "a1", subject: "Task", project: "p1" });
    const labels = await labelsFor({ projectIds: ["p1"], meetingIds: ["m1"], activityIds: ["a1"] });

    // An id of a kind that WAS asked for, but not this one: a typo must not read as "hidden", "gone" or "none".
    expect(() => labels.project("p2")).toThrow(/not listed in the needs/);
    expect(() => labels.meeting("m2")).toThrow(/not listed in the needs/);
    expect(() => labels.activity("a2", labels.project("p1"))).toThrow(/not listed in the needs/);
    expect(labels.project("p1").visibility).toBe("visible");
    expect(labels.activity("a1", labels.project("p1"))).toEqual({ id: "a1", subject: "Task", visibility: "visible" });
    // A kind that was not asked for at all.
    expect(() => labels.deal("d1")).toThrow(/not listed in the needs/);
    expect(() => labels.meetingDeal("m1")).toThrow(/not listed in the needs/);
    expect(() => labels.person(ALICE)).toThrow(/not listed in the needs/);
  });
});

describe("the sources are read in parallel (plan § Sequences, List / totals step 4)", () => {
  it("waits for the slowest chain, not the sum of the sources: every source one 300 ms away answers in about two of them", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.crm.setDeal("d1", { label: "Direct deal" });
    hosts.crm.setDeal("d2", { label: "Meeting deal" });
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d2" });
    hosts.activities.add({ id: "a1", subject: "Task", project: "p1" });
    const SLOW = 300;
    for (const route of ["auth.identities", "projects.resolve", "crm.resolve", "activities.list", "meetings.list", "meetings.system-hosts"] as const) {
      hosts.fail(route, { delayMs: SLOW });
    }

    const started = performance.now();
    const labels = await labelsFor({
      userIds: [ALICE],
      projectIds: ["p1"],
      dealIds: ["d1"],
      meetingIds: ["m1"],
      meetingDealIds: ["m1"],
      activityIds: ["a1"],
    });
    const elapsed = performance.now() - started;

    // Sequentially: six calls, 1800 ms. In parallel the longest chain is the system route, then crm-api (the
    // deals a meeting is linked to join crm-api's batch): 600 ms.
    expect(elapsed).toBeLessThan(1200);
    expect(elapsed).toBeGreaterThanOrEqual(2 * SLOW - 20);
    expect(labels.deal("d1")).toMatchObject({ visibility: "visible" });
    expect(labels.meetingDeal("m1")).toMatchObject({ visibility: "visible", id: "d2" });
    expect(labels.unavailable).toEqual([]);
  });

  it("a source that does not answer does not hold the others back or take them down: each is named for itself, in the plan's order", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.crm.setDeal("d1", { label: "Direct deal" });
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE, dealId: "d1" });
    hosts.activities.add({ id: "a1", subject: "Task", project: "p1" });
    const needs = { userIds: [ALICE], projectIds: ["p1"], dealIds: ["d1"], meetingIds: ["m1"], meetingDealIds: ["m1"], activityIds: ["a1"] };

    // One source at a time down: only that one is named, and everything else is read.
    const cases = [
      ["projects.resolve", "projects"],
      ["crm.resolve", "crm"],
      ["activities.list", "activities"],
      ["meetings.list", "meetings"],
      ["meetings.system-hosts", "meeting-deals"],
      ["auth.identities", "identities"],
    ] as const;
    for (const [route, source] of cases) {
      hosts.heal(route);
      hosts.fail(route, { status: 500 });
      const labels = await labelsFor(needs);
      expect(labels.unavailable).toEqual([source]);
      hosts.heal(route);
    }

    // All of them down at once: all are named, once each, in the order of the plan's `Unavailable` type.
    for (const [route] of cases) hosts.fail(route, { status: 500 });
    const everything = await labelsFor(needs);
    expect(everything.unavailable).toEqual(["projects", "crm", "activities", "meetings", "meeting-deals", "identities"]);
    expect(everything.project("p1").visibility).toBe("unavailable");
    expect(everything.deal("d1").visibility).toBe("unavailable");
    expect(everything.meeting("m1").visibility).toBe("unavailable");
    expect(everything.meetingDeal("m1")).toEqual({ state: "unknown" });
    expect(everything.activity("a1", everything.project("p1"))).toEqual({ id: "a1", subject: null, visibility: "unavailable" });
    expect(everything.person(ALICE)).toEqual({ id: ALICE, name: null, status: "unknown" });
  });
});
