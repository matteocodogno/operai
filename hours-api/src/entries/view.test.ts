/**
 * The entry view and the labels behind it (specs/029 T13; plan § API contracts "Views", § Sequences "List
 * / totals" step 4, ADR-0089; AC-2.6, AC-2.9, AC-4.7, AC-4.8, AC-4.10).
 *
 * Rows are inserted DIRECTLY (what a route would otherwise have to be driven for), then read through
 * `viewEntries` exactly as a route handler will, as a persona, against the fake hosts. What each owner
 * says is scripted per test; what hours-api asked is read back from `hosts.calls`.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  PERSONAS,
  SEED,
  bearerOf,
  db,
  makeCategory,
  makeDealEntry,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  makeWorkType,
  resetWorld,
  type PersonaName,
} from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { ENTRY_INCLUDE, TimeEntryViewSchema, viewEntries } from "./view";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = PERSONAS.alice.sub;

beforeEach(async () => {
  await resetWorld();
  // Everybody an entry names is a known, active person unless a test says otherwise.
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** Every entry in the database, oldest first, as `viewer` reads it. */
async function viewAs(viewer: PersonaName = "alice") {
  const rows = await db.timeEntry.findMany({ include: ENTRY_INCLUDE, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return viewEntries(await bearerOf(viewer), rows);
}

describe("an entry on no entity", () => {
  it("is the entry, its person as auth names them now, and its category and work type from the database", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.administration, { day: "2026-11-05", minutes: 90, note: "Expenses" });

    const { items, unavailable } = await viewAs();

    expect(unavailable).toEqual([]);
    expect(items).toEqual([
      {
        id: entry.id,
        day: "2026-11-05",
        minutes: 90,
        note: "Expenses",
        person: { id: ALICE, name: "Name of alice", status: "active" },
        on: { type: "none", category: { id: SEED.categories.administration, name: "Administration", retired: false } },
        workType: null,
        activity: null,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
      },
    ]);
    // No owner is asked about an entry that is on none: only `auth` names the person.
    expect(hosts.calls.map((call) => call.route)).toEqual(["auth.identities"]);
  });

  it("flags a retired category as retired, and keeps showing it", async () => {
    const category = await makeCategory("Offsite", { retired: true });
    await makeNoEntityEntry(category.id);

    const { items } = await viewAs();

    expect(items[0]).toMatchObject({ on: { type: "none", category: { id: category.id, name: "Offsite", retired: true } } });
  });
});

describe("the person (AC-4.8)", () => {
  it("shows the name auth gives now: renaming the person between two reads changes it on the next view", async () => {
    await makeNoEntityEntry();
    expect((await viewAs()).items[0]?.person).toEqual({ id: ALICE, name: "Name of alice", status: "active" });

    hosts.auth.setIdentity(ALICE, { name: "Alice Verdi" });

    const { items, unavailable } = await viewAs();
    expect(items[0]?.person).toEqual({ id: ALICE, name: "Alice Verdi", status: "active" });
    expect(unavailable).toEqual([]);
  });

  it("asks auth with the viewer's own Authorization, once for the page's distinct people", async () => {
    await makeNoEntityEntry(SEED.categories.training, { userId: ALICE });
    await makeNoEntityEntry(SEED.categories.training, { userId: PERSONAS.bob.sub });
    await makeNoEntityEntry(SEED.categories.training, { userId: ALICE });

    await viewAs("carol");

    const calls = hosts.callsTo("auth.identities");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(await bearerOf("carol"));
    expect([...(calls[0]?.body as { ids: string[] }).ids].sort()).toEqual([ALICE, PERSONAS.bob.sub].sort());
  });

  it("a deleted person is shown as deleted, with no name, and that is not an outage", async () => {
    hosts.auth.setIdentity(ALICE, { name: "Alice Rossi", status: "deleted" });
    await makeNoEntityEntry();

    const { items, unavailable } = await viewAs();

    expect(items[0]?.person).toEqual({ id: ALICE, name: null, status: "deleted" });
    expect(unavailable).toEqual([]);
  });

  it("when auth does not answer, the entry is still listed and counted, its person unknown, and `identities` is named (AC-4.7)", async () => {
    await makeNoEntityEntry(SEED.categories.training, { minutes: 150 });
    hosts.fail("auth.identities", { status: 500 });

    const { items, unavailable } = await viewAs();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ minutes: 150, person: { id: ALICE, name: null, status: "unknown" } });
    expect(unavailable).toEqual(["identities"]);
  });
});

describe("an entry on a project", () => {
  it("shows the project as projects-api labels it for the viewer, with the work type", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.analysis });

    const { items, unavailable } = await viewAs();

    expect(unavailable).toEqual([]);
    expect(items[0]).toMatchObject({
      id: entry.id,
      on: { type: "project", id: "p1", label: "Apollo", href: "/projects/p1", visibility: "visible" },
      workType: { id: SEED.workTypes.project.analysis, name: "Analysis", retired: false },
      activity: null,
    });
    // Asked as the viewer, in one call, and as nobody else.
    const calls = hosts.callsTo("projects.resolve");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(await bearerOf("alice"));
    expect(calls[0]?.body).toEqual({ entityType: "project", ids: ["p1"] });
  });

  it("flags a retired work type as retired, and keeps showing it", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    const workType = await makeWorkType("project", "Legacy", { retired: true });
    await makeProjectEntry("p1", { workTypeId: workType.id });

    const { items } = await viewAs();

    expect(items[0]?.workType).toEqual({ id: workType.id, name: "Legacy", retired: true });
  });

  it("a viewer without projects access gets the type and the minutes but no name and no link (AC-4.10), the author included", async () => {
    hosts.projects.setProject("p1", { label: "Secret project" });
    hosts.projects.setReader(ALICE, false);
    await makeProjectEntry("p1", { minutes: 210 });

    const { items, unavailable } = await viewAs("alice");

    expect(unavailable).toEqual([]);
    expect(items[0]).toMatchObject({ minutes: 210, on: { type: "project", id: "p1", label: null, href: null, visibility: "hidden" } });
    expect(JSON.stringify(items)).not.toContain("Secret project");
  });

  it("a project no owner knows reads exactly like one the viewer may not read", async () => {
    hosts.projects.setProject("known", { label: "Secret project" });
    hosts.projects.setReader("user-bob", false);
    await makeProjectEntry("known");
    await makeProjectEntry("gone");

    const unreadable = (await viewAs("bob")).items;
    const missing = (await viewAs("alice")).items[1];

    expect(unreadable[0]?.on).toEqual({ type: "project", id: "known", label: null, href: null, visibility: "hidden" });
    expect(missing?.on).toEqual({ type: "project", id: "gone", label: null, href: null, visibility: "hidden" });
  });

  it("when projects-api does not answer the entry is still listed and counted, unavailable, and `projects` is named (AC-4.7)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    await makeProjectEntry("p1", { minutes: 90 });
    hosts.fail("projects.resolve", { status: 503 });

    const { items, unavailable } = await viewAs();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ minutes: 90, on: { type: "project", id: "p1", label: null, href: null, visibility: "unavailable" } });
    expect(unavailable).toEqual(["projects"]);
  });

  it("a project href that is not a suite path is not believed: the project is unavailable, never a link out of the suite", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", href: "https://evil.example/steal" });
    await makeProjectEntry("p1");

    const { items, unavailable } = await viewAs();

    expect(items[0]?.on).toMatchObject({ type: "project", label: null, href: null, visibility: "unavailable" });
    expect(unavailable).toEqual(["projects"]);
  });

  it("asks once for a project several entries share", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    await makeProjectEntry("p1");
    await makeProjectEntry("p1", { day: "2026-11-03" });

    const { items } = await viewAs();

    expect(items.map((item) => item.on)).toEqual([expect.objectContaining({ label: "Apollo" }), expect.objectContaining({ label: "Apollo" })]);
    expect(hosts.callsTo("projects.resolve")).toHaveLength(1);
    expect(hosts.callsTo("projects.resolve")[0]?.body).toEqual({ entityType: "project", ids: ["p1"] });
  });
});

describe("an entry on a deal", () => {
  it("shows the deal as crm-api labels it for the viewer, with the work type, asked as the viewer", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: [ALICE] });
    await makeDealEntry("d1", { workTypeId: SEED.workTypes.deal.estimate });

    const { items, unavailable } = await viewAs();

    expect(unavailable).toEqual([]);
    expect(items[0]).toMatchObject({
      on: { type: "deal", id: "d1", label: "Acme renewal", href: "/crm/deals/d1", visibility: "visible" },
      workType: { id: SEED.workTypes.deal.estimate, name: "Estimate", retired: false },
    });
    const calls = hosts.callsTo("crm.resolve");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(await bearerOf("alice"));
    expect(calls[0]?.body).toEqual({ entityType: "deal", ids: ["d1"] });
  });

  it("a viewer without crm access gets the type and the minutes but no name and no link (AC-4.10), the author included", async () => {
    hosts.crm.setDeal("d1", { label: "Secret deal" });
    hosts.crm.setReader(ALICE, false);
    await makeDealEntry("d1", { minutes: 300 });

    const { items, unavailable } = await viewAs("alice");

    expect(unavailable).toEqual([]);
    expect(items[0]).toMatchObject({ minutes: 300, on: { type: "deal", id: "d1", label: null, href: null, visibility: "hidden" } });
    expect(JSON.stringify(items)).not.toContain("Secret deal");
  });

  it("a deal crm-api does not hold reads exactly like one the viewer may not read", async () => {
    await makeDealEntry("gone");

    const { items, unavailable } = await viewAs();

    expect(items[0]?.on).toEqual({ type: "deal", id: "gone", label: null, href: null, visibility: "hidden" });
    expect(unavailable).toEqual([]);
  });

  it("when crm-api does not answer, or predates entityType deal (R7), the entry is still listed and counted, unavailable, and `crm` is named", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    await makeDealEntry("d1", { minutes: 90 });

    hosts.fail("crm.resolve", { status: 500 });
    const down = await viewAs();
    hosts.heal("crm.resolve");
    hosts.crm.legacy = true;
    const legacy = await viewAs();

    for (const { items, unavailable } of [down, legacy]) {
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ minutes: 90, on: { type: "deal", id: "d1", label: null, href: null, visibility: "unavailable" } });
      expect(unavailable).toEqual(["crm"]);
    }
  });
});

describe("an entry on a meeting", () => {
  it("shows the title and the link of a meeting the viewer took part in, asked as the viewer", async () => {
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE });
    hosts.meetings.add({ id: "m2", title: "Retro", creator: PERSONAS.bob.sub, participants: [ALICE] });
    await makeMeetingEntry("m1");
    await makeMeetingEntry("m2");

    const { items, unavailable } = await viewAs("alice");

    expect(unavailable).toEqual([]);
    expect(items.map((item) => item.on)).toEqual([
      expect.objectContaining({ type: "meeting", id: "m1", label: "Kick-off", href: "/my-meetings/m/m1", visibility: "visible" }),
      expect.objectContaining({ type: "meeting", id: "m2", label: "Retro", href: "/my-meetings/m/m2", visibility: "visible" }),
    ]);
    const calls = hosts.callsTo("meetings.list");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(await bearerOf("alice"));
    expect(calls[0]?.query.get("ids")?.split(",").sort()).toEqual(["m1", "m2"]);
    expect(calls[0]?.query.has("page")).toBe(false);
  });

  it("gives a title only to a viewer who took part: anyone else, the author of the entry included, gets the type and the minutes", async () => {
    hosts.meetings.add({ id: "m1", title: "Board only", creator: PERSONAS.bob.sub, participants: [PERSONAS.carol.sub] });
    await makeMeetingEntry("m1", { userId: ALICE, minutes: 120 });

    for (const viewer of ["alice", "admin", "holder"] as const) {
      const { items, unavailable } = await viewAs(viewer);
      expect(unavailable).toEqual([]);
      expect(items[0]).toMatchObject({ minutes: 120, on: { type: "meeting", id: "m1", label: null, href: null, visibility: "hidden" } });
      expect(JSON.stringify(items)).not.toContain("Board only");
    }
    // The people who did take part read it.
    expect((await viewAs("bob")).items[0]?.on).toMatchObject({ label: "Board only", visibility: "visible" });
    expect((await viewAs("carol")).items[0]?.on).toMatchObject({ label: "Board only", visibility: "visible" });
  });

  it("a meeting that no longer exists reads exactly like one the viewer did not take part in", async () => {
    await makeMeetingEntry("deleted");

    const { items, unavailable } = await viewAs();

    expect(items[0]?.on).toMatchObject({ type: "meeting", id: "deleted", label: null, href: null, visibility: "hidden" });
    expect(unavailable).toEqual([]);
  });

  it("is `unavailable`, not `hidden`, when meetings-api answered a list that ignored its filter: a foreign item and the asked meeting missing (R7, plan amendment 3)", async () => {
    // A meetings-api before T8 ignores `ids` and answers the caller's latest page.
    hosts.meetings.add({ id: "m-theirs", title: "Board only", creator: PERSONAS.bob.sub });
    hosts.meetings.add({ id: "m-mine", title: "Kick-off", creator: ALICE });
    hosts.meetings.legacy = true;
    await makeMeetingEntry("m-theirs");

    const { items, unavailable } = await viewAs("alice");

    expect(items[0]?.on).toMatchObject({ type: "meeting", id: "m-theirs", label: null, href: null, visibility: "unavailable" });
    expect(unavailable).toEqual(["meetings"]);
    // What the page returned for somebody else's request is never believed.
    expect(JSON.stringify(items)).not.toContain("Kick-off");
  });

  it("keeps the link a path of its own whatever the id holds", async () => {
    hosts.meetings.add({ id: "a/b?c#d e%", title: "Odd id", creator: ALICE });
    await makeMeetingEntry("a/b?c#d e%");

    const { items } = await viewAs();

    const on = items[0]?.on;
    expect(on).toMatchObject({ type: "meeting", label: "Odd id" });
    expect(on && "href" in on ? on.href : undefined).toBe("/my-meetings/m/a%2Fb%3Fc%23d%20e%25");
  });

  it("when meetings-api does not answer the entry is still listed and counted, unavailable, and `meetings` is named (AC-4.7)", async () => {
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE });
    await makeMeetingEntry("m1", { minutes: 90 });
    hosts.fail("meetings.list", { status: 500 });

    const { items, unavailable } = await viewAs();

    expect(items[0]).toMatchObject({ minutes: 90, on: { type: "meeting", id: "m1", label: null, href: null, visibility: "unavailable" } });
    expect(unavailable).toEqual(["meetings"]);
  });
});

/** `on.deal` of the meeting entry at `index`. */
function dealOfMeeting(views: { items: readonly { on: { type: string } }[] }, index = 0): Record<string, unknown> {
  const on = views.items[index]?.on as { type: string; deal?: Record<string, unknown> } | undefined;
  if (on?.type !== "meeting" || on.deal === undefined) throw new Error(`item ${index} is not a meeting entry`);
  return on.deal;
}

describe("the deal a meeting entry counts for (AC-2.6, AC-4.10)", () => {
  it("is the deal's id, name and link when the viewer may read the deal", async () => {
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    await makeMeetingEntry("m1");

    const views = await viewAs();

    expect(dealOfMeeting(views)).toEqual({ state: "linked", visibility: "visible", id: "d1", label: "Acme renewal", href: "/crm/deals/d1" });
    expect(views.unavailable).toEqual([]);
  });

  it("has no id key at all when the viewer may not read the deal, the minutes and the meeting's own title intact", async () => {
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE, dealId: "secret-deal-id" });
    hosts.crm.setDeal("secret-deal-id", { label: "Secret deal name" });
    hosts.crm.setReader(ALICE, false);
    await makeMeetingEntry("m1", { minutes: 120 });

    const views = await viewAs();

    const deal = dealOfMeeting(views);
    expect(deal).toEqual({ state: "linked", visibility: "hidden" });
    expect("id" in deal).toBe(false);
    expect(views.items[0]).toMatchObject({ minutes: 120, on: { type: "meeting", label: "Kick-off", visibility: "visible" } });
    expect(JSON.stringify(views)).not.toContain("secret-deal-id");
    expect(JSON.stringify(views)).not.toContain("Secret deal name");
    expect(views.unavailable).toEqual([]);
  });

  it("is independent of the viewer's access to the meeting: a viewer who did not take part still learns the deal they may read", async () => {
    hosts.meetings.add({ id: "m-theirs", title: "Board only", creator: PERSONAS.bob.sub, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    await makeMeetingEntry("m-theirs");

    const views = await viewAs("alice");

    expect(views.items[0]?.on).toMatchObject({ type: "meeting", label: null, href: null, visibility: "hidden" });
    expect(dealOfMeeting(views)).toEqual({ state: "linked", visibility: "visible", id: "d1", label: "Acme renewal", href: "/crm/deals/d1" });
    expect(JSON.stringify(views)).not.toContain("Board only");
  });

  it("is none for an unlinked meeting and for one that no longer exists", async () => {
    hosts.meetings.add({ id: "m-free", creator: ALICE, dealId: null });
    await makeMeetingEntry("m-free");
    await makeMeetingEntry("m-deleted");

    const views = await viewAs();

    expect(dealOfMeeting(views, 0)).toEqual({ state: "none" });
    expect(dealOfMeeting(views, 1)).toEqual({ state: "none" });
    expect(views.unavailable).toEqual([]);
  });

  it("is unknown when the system route does not answer: `meeting-deals` is named and the entry, its minutes and its title stay (AC-4.7)", async () => {
    hosts.meetings.add({ id: "m1", title: "Kick-off", creator: ALICE, dealId: "d1" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    await makeMeetingEntry("m1", { minutes: 150 });
    hosts.fail("meetings.system-hosts", { status: 500 });

    const views = await viewAs();

    expect(dealOfMeeting(views)).toEqual({ state: "unknown" });
    expect(views.unavailable).toEqual(["meeting-deals"]);
    expect(views.items[0]).toMatchObject({ minutes: 150, on: { type: "meeting", label: "Kick-off", visibility: "visible" } });
  });

  it("is a deal the viewer cannot name when the meeting is linked to a stored deal id outside the id rule, with the page's other deals intact", async () => {
    hosts.meetings.add({ id: "m-odd", creator: ALICE, host: { app: "crm", entityType: "deal", entityId: "x".repeat(65) } });
    hosts.meetings.add({ id: "m-fine", creator: ALICE, dealId: "d-fine" });
    hosts.crm.setDeal("d-fine", { label: "Fine deal" });
    hosts.crm.setDeal("d-direct", { label: "Direct deal" });
    await makeMeetingEntry("m-odd");
    await makeMeetingEntry("m-fine");
    await makeDealEntry("d-direct");

    const views = await viewAs();

    expect(dealOfMeeting(views, 0)).toEqual({ state: "linked", visibility: "hidden" });
    expect(dealOfMeeting(views, 1)).toMatchObject({ visibility: "visible", label: "Fine deal" });
    expect(views.items[2]?.on).toMatchObject({ type: "deal", label: "Direct deal", visibility: "visible" });
    expect(views.unavailable).toEqual([]);
  });

  it("goes out with the deal entries' deals in ONE crm-api resolve, as the viewer", async () => {
    hosts.crm.setDeal("d-direct", { label: "Direct" });
    hosts.crm.setDeal("d-via-meeting", { label: "Via meeting" });
    hosts.meetings.add({ id: "m1", creator: ALICE, dealId: "d-via-meeting" });
    await makeDealEntry("d-direct");
    await makeMeetingEntry("m1");

    const views = await viewAs();

    const calls = hosts.callsTo("crm.resolve");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(await bearerOf("alice"));
    expect([...(calls[0]?.body as { ids: string[] }).ids].sort()).toEqual(["d-direct", "d-via-meeting"]);
    expect(views.items[0]?.on).toMatchObject({ type: "deal", label: "Direct" });
    expect(dealOfMeeting(views, 1)).toMatchObject({ label: "Via meeting" });
  });
});

describe("the activity an entry points at (AC-2.9, AC-4.7, AC-4.10, R6)", () => {
  it("is its id and subject when the viewer reads the entry's project or deal and activities-api returns it, asked once as the viewer", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    hosts.activities.add({ id: "a-task", subject: "Wire the login", project: "p1" });
    hosts.activities.add({ id: "a-call", subject: "Discovery call", type: "call", deal: "d1" });
    await makeProjectEntry("p1", { activityId: "a-task" });
    await makeDealEntry("d1", { activityId: "a-call" });

    const { items, unavailable } = await viewAs();

    expect(items.map((item) => item.activity)).toEqual([
      { id: "a-task", subject: "Wire the login", visibility: "visible" },
      { id: "a-call", subject: "Discovery call", visibility: "visible" },
    ]);
    expect(unavailable).toEqual([]);
    const calls = hosts.callsTo("activities.list");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(await bearerOf("alice"));
    expect(calls[0]?.query.get("ids")?.split(",").sort()).toEqual(["a-call", "a-task"]);
    expect(calls[0]?.query.has("page")).toBe(false);
    expect(calls[0]?.query.has("pageSize")).toBe(false);
  });

  it("asks activities-api once however many entries point at one activity, and shows it on each (AC-2.8)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.activities.add({ id: "a-task", subject: "Wire the login", project: "p1" });
    await makeProjectEntry("p1", { activityId: "a-task", userId: ALICE });
    await makeProjectEntry("p1", { activityId: "a-task", userId: PERSONAS.bob.sub, day: "2026-11-03" });
    await makeProjectEntry("p1", { activityId: "a-task", userId: ALICE, day: "2026-11-04" });

    const { items } = await viewAs();

    expect(items.map((item) => item.activity?.subject)).toEqual(["Wire the login", "Wire the login", "Wire the login"]);
    expect(hosts.callsTo("activities.list")).toHaveLength(1);
    expect(hosts.callsTo("activities.list")[0]?.query.get("ids")).toBe("a-task");
  });

  it("is no activity at all, and makes no activities-api call, for entries that point at none", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    await makeProjectEntry("p1");
    await makeNoEntityEntry();

    const { items } = await viewAs();

    expect(items.map((item) => item.activity)).toEqual([null, null]);
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("is null when the project or deal is readable and activities-api no longer returns the pointed id; the entry stays listed and counted (AC-2.9)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    await makeProjectEntry("p1", { activityId: "a-deleted", minutes: 90 });
    await makeDealEntry("d1", { activityId: "a-also-gone", minutes: 150 });

    const { items, unavailable } = await viewAs();

    expect(items.map((item) => [item.minutes, item.activity])).toEqual([
      [90, null],
      [150, null],
    ]);
    expect(unavailable).toEqual([]);
  });

  it("reads an activity the viewer may not read as a deleted one: activities-api omits both alike", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.activities.add({ id: "a-private", subject: "Private task", project: "p1", readableBy: [PERSONAS.bob.sub] });
    await makeProjectEntry("p1", { activityId: "a-private" });

    const { items } = await viewAs("alice");

    expect(items[0]?.activity).toBeNull();
    expect(JSON.stringify(items)).not.toContain("Private task");
  });

  it("is hidden, with no subject, when the viewer may not read the entry's project or deal, even if activities-api would answer (AC-4.10)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    hosts.activities.add({ id: "a-task", subject: "Secret task subject", project: "p1" });
    hosts.activities.add({ id: "a-call", subject: "Secret call subject", type: "call", deal: "d1" });
    hosts.projects.setReader(ALICE, false);
    hosts.crm.setReader(ALICE, false);
    await makeProjectEntry("p1", { activityId: "a-task", minutes: 60 });
    await makeDealEntry("d1", { activityId: "a-call", minutes: 120 });
    // Pointing at an activity that no longer exists changes nothing for a viewer who cannot read the target: hidden, not null.
    await makeProjectEntry("p1", { activityId: "a-deleted", minutes: 30 });

    const { items, unavailable } = await viewAs("alice");

    expect(items.map((item) => [item.minutes, item.activity])).toEqual([
      [60, { id: "a-task", subject: null, visibility: "hidden" }],
      [120, { id: "a-call", subject: null, visibility: "hidden" }],
      [30, { id: "a-deleted", subject: null, visibility: "hidden" }],
    ]);
    expect(JSON.stringify(items)).not.toContain("Secret");
    expect(unavailable).toEqual([]);
  });

  it("is kept with `unavailable`, never null, when activities-api does not answer, and `activities` is named (R6, AC-4.7)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.activities.add({ id: "a-task", subject: "Wire the login", project: "p1" });
    await makeProjectEntry("p1", { activityId: "a-task", minutes: 90 });

    for (const mode of [{ status: 503 }, { status: 500 }, { malformed: true }, { rawBody: "nope" }]) {
      hosts.heal("activities.list");
      hosts.fail("activities.list", mode);

      const { items, unavailable } = await viewAs();

      expect(items[0]).toMatchObject({ minutes: 90, on: { label: "Apollo" }, activity: { id: "a-task", subject: null, visibility: "unavailable" } });
      expect(unavailable).toEqual(["activities"]);
    }
  });

  it("is kept with `unavailable`, never null, when activities-api predates the `ids` filter (R7)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.activities.add({ id: "a-task", subject: "Wire the login", project: "p1" });
    hosts.activities.legacy = true;
    await makeProjectEntry("p1", { activityId: "a-task" });

    const { items, unavailable } = await viewAs();

    expect(items[0]?.activity).toEqual({ id: "a-task", subject: null, visibility: "unavailable" });
    expect(unavailable).toEqual(["activities"]);
  });

  it("is kept with `unavailable`, never null, when the answer ignored its filter: a foreign item and the asked id missing (plan amendment 3)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    await makeProjectEntry("p1", { activityId: "a-task", minutes: 90 });
    // activities-api answers about an activity nobody asked for and says nothing of the asked one.
    hosts.fail("activities.list", {
      body: {
        items: [
          {
            id: "someone-elses",
            type: "task",
            subject: "Another subject",
            project: { id: "p9" },
            deal: null,
            participants: [],
            task: { assignee: null },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      },
    });

    const { items, unavailable } = await viewAs();

    expect(items[0]?.activity).toEqual({ id: "a-task", subject: null, visibility: "unavailable" });
    expect(unavailable).toEqual(["activities"]);
    expect(JSON.stringify(items)).not.toContain("Another subject");
  });

  it("withholds the subject while the project or deal itself did not answer: it is not known the viewer may read it", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.activities.add({ id: "a-task", subject: "Wire the login", project: "p1" });
    await makeProjectEntry("p1", { activityId: "a-task" });
    hosts.fail("projects.resolve", { status: 503 });

    const { items, unavailable } = await viewAs();

    expect(items[0]?.on).toMatchObject({ type: "project", visibility: "unavailable" });
    expect(items[0]?.activity).toEqual({ id: "a-task", subject: null, visibility: "unavailable" });
    // activities-api did answer: only the project's owner did not.
    expect(unavailable).toEqual(["projects"]);
  });
});

describe("the wire shape (plan § Views)", () => {
  /** One entry of every target and every state a viewer can meet. */
  async function everyKindOfEntry() {
    hosts.projects.setProject("p1", { label: "Apollo" });
    hosts.crm.setDeal("d1", { label: "Acme renewal" });
    hosts.crm.setDeal("d2", { label: "Meeting deal" });
    hosts.meetings.add({ id: "m-linked", title: "Kick-off", creator: ALICE, dealId: "d2" });
    hosts.meetings.add({ id: "m-free", title: "Retro", creator: ALICE, dealId: null });
    hosts.meetings.add({ id: "m-odd", title: "Odd", creator: ALICE, host: { app: "crm", entityType: "deal", entityId: "x".repeat(65) } });
    hosts.activities.add({ id: "a-task", subject: "Wire the login", project: "p1" });
    hosts.activities.add({ id: "a-call", subject: "Discovery call", type: "call", deal: "d1" });
    await makeProjectEntry("p1", { activityId: "a-task", workTypeId: SEED.workTypes.project.analysis, note: "Pairing" });
    await makeProjectEntry("p-unknown", { activityId: "a-gone" });
    await makeDealEntry("d1", { activityId: "a-call", workTypeId: SEED.workTypes.deal.demo });
    await makeDealEntry("d-unknown");
    await makeMeetingEntry("m-linked");
    await makeMeetingEntry("m-free");
    await makeMeetingEntry("m-odd");
    await makeMeetingEntry("m-gone");
    await makeNoEntityEntry(SEED.categories.other, { note: "Offsite" });
  }

  it("is the strict schema in every state: all readable, nothing readable, everything down", async () => {
    await everyKindOfEntry();

    const allReadable = await viewAs("alice");

    hosts.projects.setReader("user-carol", false);
    hosts.crm.setReader("user-carol", false);
    const nothingReadable = await viewAs("carol");

    for (const route of ["auth.identities", "projects.resolve", "crm.resolve", "activities.list", "meetings.list", "meetings.system-hosts"] as const) {
      hosts.fail(route, { status: 500 });
    }
    const everythingDown = await viewAs("alice");

    for (const views of [allReadable, nothingReadable, everythingDown]) {
      expect(views.items).toHaveLength(9);
      for (const item of views.items) expect(() => TimeEntryViewSchema.parse(item)).not.toThrow();
      for (const source of views.unavailable) expect(["projects", "crm", "activities", "meetings", "meeting-deals", "identities"]).toContain(source);
    }
    expect(everythingDown.unavailable).toEqual(["projects", "crm", "activities", "meetings", "meeting-deals", "identities"]);
  });

  it("names a visible thing and nothing else: a label and a link exactly when visible, a subject only when its activity is visible", async () => {
    await everyKindOfEntry();
    hosts.crm.setReader("user-carol", false);

    for (const views of [await viewAs("alice"), await viewAs("carol")]) {
      for (const { on, activity } of views.items) {
        if (on.type === "project" || on.type === "deal" || on.type === "meeting") {
          expect(on.label !== null).toBe(on.visibility === "visible");
          expect(on.href !== null).toBe(on.visibility === "visible");
          // Every link is a path in the suite: one slash, no scheme, no host.
          if (on.href !== null) expect(on.href).toMatch(/^\/(?!\/)[^\s\\:]*$/);
        }
        if (on.type === "meeting" && on.deal.state === "linked") {
          expect("id" in on.deal).toBe(on.deal.visibility === "visible");
          if (on.deal.visibility === "visible") expect(on.deal.href).toMatch(/^\/crm\/deals\/[^/]+$/);
        }
        if (activity !== null) expect(activity.subject !== null).toBe(activity.visibility === "visible");
      }
    }
  });

  it("drops a deal id from a view that may not carry one, and the schema refuses to carry one", () => {
    const hiddenWithId = { state: "linked", visibility: "hidden", id: "d1" };
    const visibleWithoutId = { state: "linked", visibility: "visible", label: "Acme", href: "/crm/deals/d1" };
    const meetingEntry = (deal: unknown) => ({
      id: "e1",
      day: "2026-11-02",
      minutes: 60,
      note: null,
      person: { id: ALICE, name: "Alice", status: "active" },
      on: { type: "meeting", id: "m1", label: null, href: null, visibility: "hidden", deal },
      workType: null,
      activity: null,
      createdAt: "2026-11-02T08:00:00.000Z",
      updatedAt: "2026-11-02T08:00:00.000Z",
    });

    expect(TimeEntryViewSchema.safeParse(meetingEntry({ state: "linked", visibility: "hidden" })).success).toBe(true);
    expect(TimeEntryViewSchema.safeParse(meetingEntry(hiddenWithId)).success).toBe(false);
    expect(TimeEntryViewSchema.safeParse(meetingEntry(visibleWithoutId)).success).toBe(false);
    expect(TimeEntryViewSchema.safeParse(meetingEntry({ state: "none", id: "d1" })).success).toBe(false);
  });

  it("can be documented: a route returning it generates an OpenAPI document that names the view and says what a hidden deal does not carry", () => {
    const api = new OpenAPIHono();
    api.openapi(
      createRoute({
        method: "get",
        path: "/entry",
        responses: { 200: { content: { "application/json": { schema: TimeEntryViewSchema } }, description: "An entry" } },
      }),
      () => new Response() as never,
    );

    const document = api.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "t", version: "1" } });

    expect(Object.keys(document.components?.schemas ?? {})).toContain("TimeEntryView");
    // The deal a meeting counts for: somewhere in the view, a variant that is `linked` but `hidden` or `unavailable`
    // has exactly `state` and `visibility` as properties, and refuses any other.
    const variants: Array<{ properties?: Record<string, { enum?: string[] }>; additionalProperties?: unknown }> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      const object = node as { properties?: Record<string, { enum?: string[] }>; additionalProperties?: unknown };
      if (object.properties?.["state"]?.enum?.[0] === "linked") variants.push(object);
      Object.values(node).forEach(walk);
    };
    walk(document);
    const hidden = variants.find((variant) => variant.properties?.["visibility"]?.enum?.includes("hidden"));
    expect(hidden).toBeDefined();
    expect(Object.keys(hidden?.properties ?? {}).sort()).toEqual(["state", "visibility"]);
    expect(hidden?.additionalProperties).toBe(false);
  });

  it("carries a stored note as written and never a blank one", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    await makeProjectEntry("p1", { note: "  text " });
    // A blank note is no note (plan § Entries): the write path stores `null`; a row that somehow holds one still reads as none.
    await db.timeEntry.create({
      data: { userId: ALICE, day: new Date("2026-11-02T00:00:00Z"), minutes: 30, target: "none", categoryId: SEED.categories.training, note: " \n\t" },
    });

    const { items } = await viewAs();

    expect(items.map((item) => item.note)).toEqual(["  text ", null]);
  });

  it("keeps the order of the rows it is given and every row, however many share a project", async () => {
    hosts.projects.setProject("p1", { label: "Apollo" });
    const first = await makeProjectEntry("p1", { day: "2026-11-04" });
    const second = await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-03" });
    const third = await makeProjectEntry("p1", { day: "2026-11-02" });
    const rows = await db.timeEntry.findMany({ include: ENTRY_INCLUDE, where: { id: { in: [first.id, second.id, third.id] } }, orderBy: { day: "desc" } });

    const { items } = await viewEntries(await bearerOf("alice"), rows);

    expect(items.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
  });
});
