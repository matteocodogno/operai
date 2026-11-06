import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolveResponse } from "../authz/resolveClient";
import { startFakeHost } from "../test-support/fakeHost";

// AC-8.1, AC-8.5, AC-8.6: GET /templates?meetingId= - recommended for the meeting's host first,
// then personal, shared, built-in; `version` per item. Real app, real Postgres (`meetings_test`).

const harness = setupTestAuth();
await harness.init();
const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { buildRegistry, setRegistryForTests } = await import("../hosts/registry");

const grants = (...pairs: [string, string][]): ResolveResponse => ({
  sub: "x",
  epoch: 0,
  permissions: pairs.map(([resource, action]) => ({ resource, action, conditions: null })),
  entity: null,
  jobTitle: null,
});
const EMPLOYEE = grants(["meetings", "access"]);

const tokens = new Map<string, string>();
async function call(path: string, as: string | null = "alice", headers: Record<string, string> = {}) {
  if (as && !tokens.has(as)) tokens.set(as, await harness.signToken({ sub: as, email: `${as}@x.test` }));
  const res = await app.request(path, { headers: { ...(as ? { Authorization: `Bearer ${tokens.get(as)}` } : {}), ...headers } });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as any, text };
}

const sections = [{ heading: "Heading", instruction: "Instruction" }];
const personal = (ownerUserId: string, name: string, extra: Record<string, unknown> = {}) =>
  db.summaryTemplate.create({ data: { scope: "personal", ownerUserId, name, sections, createdBy: ownerUserId, updatedBy: ownerUserId, ...extra } });
const shared = (name: string, extra: Record<string, unknown> = {}) =>
  db.summaryTemplate.create({ data: { scope: "shared", name, sections, createdBy: "admin", updatedBy: "admin", ...extra } });
const meeting = (data: Record<string, unknown> = {}) =>
  db.meeting.create({
    data: { title: "Weekly", format: "online", startsAt: new Date(), language: "en", source: "text", creatorUserId: "alice", ...data } as never,
  });

beforeAll(() => {
  spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "summary_template", "meeting" CASCADE');
  __resetAuthzCacheForTests();
  setRegistryForTests(null);
  harness.setResolve(async () => EMPLOYEE);
});
afterAll(async () => {
  setRegistryForTests(null);
  await db.$disconnect();
});

const ids = (json: { items: { id: string }[] }) => json.items.map((i) => i.id);
const names = (json: { items: { name: string }[] }) => json.items.map((i) => i.name);

describe("access", () => {
  it("401 without a token, 403 without meetings:access, 503 when auth is down", async () => {
    expect((await call("/templates", null)).status).toBe(401);
    harness.setResolve(async () => grants());
    expect((await call("/templates")).status).toBe(403);
    __resetAuthzCacheForTests();
    harness.setResolve(async () => {
      throw new Error("auth is down");
    });
    expect((await call("/templates", "bob")).status).toBe(503);
  });

  it("422 for a meetingId that is not a plausible id", async () => {
    expect((await call(`/templates?meetingId=${"x".repeat(65)}`)).status).toBe(422);
  });
});

describe("with no meeting (AC-8.5)", () => {
  it("lists personal, then shared, then the four built-ins, each marked with its source", async () => {
    await personal("alice", "Beta mine");
    await personal("alice", "Alpha mine");
    await shared("Team standard");
    const { status, json } = await call("/templates");
    expect(status).toBe(200);
    expect(names(json)).toEqual(["Alpha mine", "Beta mine", "Team standard", "Meeting minutes", "Sales discovery call", "1:1", "Action items"]);
    expect(json.items.map((i: { source: string }) => i.source)).toEqual([
      "personal",
      "personal",
      "shared",
      "builtin",
      "builtin",
      "builtin",
      "builtin",
    ]);
    expect(json.items.every((i: { recommended: boolean }) => i.recommended === false)).toBe(true);
  });

  it("never shows another user's personal template (AC-8.2)", async () => {
    await personal("bob", "Bob's secret");
    await personal("alice", "Alice's");
    expect(names((await call("/templates", "alice")).json)).toContain("Alice's");
    expect(names((await call("/templates", "alice")).json)).not.toContain("Bob's secret");
    expect(names((await call("/templates", "bob")).json)).toContain("Bob's secret");
    expect(names((await call("/templates", "bob")).json)).not.toContain("Alice's");
  });

  it("gives every item its sections, general instructions and version (the If-Match precondition, G8)", async () => {
    const mine = await personal("alice", "Mine", { generalInstructions: "Be brief.", version: 4 });
    const { json } = await call("/templates");
    const item = json.items.find((i: { id: string }) => i.id === mine.id);
    expect(item).toEqual({
      id: mine.id,
      source: "personal",
      name: "Mine",
      sections,
      generalInstructions: "Be brief.",
      recommended: false,
      version: 4,
    });
    const builtin = json.items.find((i: { id: string }) => i.id === "builtin:minutes");
    expect(builtin.version).toBe(1);
    expect(builtin.sections.length).toBeGreaterThan(0);
    expect(builtin.generalInstructions).toEqual(expect.any(String));
    expect(Object.keys(builtin).sort()).toEqual(["generalInstructions", "id", "name", "recommended", "sections", "source", "version"]);
  });

  it("sorts names case- and accent-insensitively", async () => {
    await personal("alice", "zeta");
    await personal("alice", "Écrit");
    await personal("alice", "Alpha");
    const personalNames = names((await call("/templates")).json).slice(0, 3);
    expect(personalNames).toEqual(["Alpha", "Écrit", "zeta"]);
  });
});

describe("with a meeting (AC-8.5)", () => {
  it("puts the host's recommended built-in first: Sales discovery call for a crm/deal meeting", async () => {
    const m = await meeting({ hostApp: "crm", hostEntityType: "deal", hostEntityId: "deal-1" });
    await personal("alice", "Mine");
    await shared("Team");
    const { json } = await call(`/templates?meetingId=${m.id}`);
    expect(ids(json)).toEqual([
      "builtin:sales-discovery",
      json.items[1].id, // Mine
      json.items[2].id, // Team
      "builtin:minutes",
      "builtin:one-on-one",
      "builtin:action-items",
    ]);
    expect(names(json)).toEqual(["Sales discovery call", "Mine", "Team", "Meeting minutes", "1:1", "Action items"]);
    expect(json.items.map((i: { recommended: boolean }) => i.recommended)).toEqual([true, false, false, false, false, false]);
    expect(json.items.map((i: { source: string }) => i.source)).toEqual(["builtin", "personal", "shared", "builtin", "builtin", "builtin"]);
  });

  it("recommends nothing for a standalone meeting", async () => {
    const m = await meeting();
    const { json } = await call(`/templates?meetingId=${m.id}`);
    expect(ids(json)).toEqual(["builtin:minutes", "builtin:sales-discovery", "builtin:one-on-one", "builtin:action-items"]);
    expect(json.items.some((i: { recommended: boolean }) => i.recommended)).toBe(false);
  });

  it("follows the registry, not a hard-coded host: a test host recommends a personal and a shared template", async () => {
    const mine = await personal("alice", "My widget notes");
    const team = await shared("Widget template");
    await personal("alice", "Unrelated");
    setRegistryForTests(
      buildRegistry({
        production: false,
        crmApiUrl: "http://crm.test",
        testHosts: [
          {
            app: "testhost",
            entityType: "widget",
            baseUrl: "http://host.test",
            labels: { en: { app: "A", entity: "W", visibilityHint: "", noticeFailed: "" }, it: { app: "A", entity: "W", visibilityHint: "", noticeFailed: "" } },
            offersHostVisible: false,
            hostVisibleRequirement: "",
            notices: false,
            recommendedTemplates: [team.id, mine.id, "builtin:action-items"],
            contract: 1,
          },
        ],
      }),
    );
    const m = await meeting({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" });
    const { json } = await call(`/templates?meetingId=${m.id}`);
    // recommended first, in the host's own order; then the rest: personal, shared, built-in
    expect(ids(json).slice(0, 3)).toEqual([team.id, mine.id, "builtin:action-items"]);
    expect(json.items.slice(0, 3).every((i: { recommended: boolean }) => i.recommended)).toBe(true);
    expect(json.items.slice(3).some((i: { recommended: boolean }) => i.recommended)).toBe(false);
    expect(names(json).slice(3)).toEqual(["Unrelated", "Meeting minutes", "Sales discovery call", "1:1"]);
  });

  it("does not recommend another user's personal template, even if the host names its id", async () => {
    const bobs = await personal("bob", "Bob's");
    setRegistryForTests(
      buildRegistry({
        production: false,
        crmApiUrl: "http://crm.test",
        testHosts: [
          {
            app: "testhost",
            entityType: "widget",
            baseUrl: "http://host.test",
            labels: { en: { app: "A", entity: "W", visibilityHint: "", noticeFailed: "" }, it: { app: "A", entity: "W", visibilityHint: "", noticeFailed: "" } },
            offersHostVisible: false,
            hostVisibleRequirement: "",
            notices: false,
            recommendedTemplates: [bobs.id],
            contract: 1,
          },
        ],
      }),
    );
    const m = await meeting({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" });
    expect(ids((await call(`/templates?meetingId=${m.id}`, "alice")).json)).not.toContain(bobs.id);
  });

  it("works for a participant of the meeting too", async () => {
    const m = await meeting({ hostApp: "crm", hostEntityType: "deal", hostEntityId: "deal-1" });
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: "carol", addedBy: "alice" } });
    expect((await call(`/templates?meetingId=${m.id}`, "carol")).json.items[0].id).toBe("builtin:sales-discovery");
  });

  describe("a host-visible reader (shared visibility, AC-5.2)", () => {
    const fake = startFakeHost();
    afterAll(() => fake.stop());

    beforeEach(() => {
      fake.reset();
      setRegistryForTests({ all: () => fake.definitions, get: (a, t) => fake.definitions.find((d) => d.app === a && d.entityType === t) });
    });

    // the host recommends builtin:minutes; sorted by default it is also first, so use a personal
    // template named to sort FIRST and check `recommended` flags instead of the order alone.
    const recommendedOf = (json: { items: { id: string; recommended: boolean }[] }) => json.items.filter((i) => i.recommended).map((i) => i.id);

    it("gets the host's recommendation when the host vouches for them", async () => {
      fake.setEntity("widget", "w1", { title: "W1", href: "/w/1", hostVisible: true });
      const m = await meeting({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1", hostVisible: true });
      // neither creator nor participant: bob reads it only as a host reader
      const { json } = await call(`/templates?meetingId=${m.id}`, "bob");
      expect(recommendedOf(json)).toEqual(["builtin:minutes"]);
      expect(fake.resolves).toHaveLength(1); // asked as the caller, live
    });

    it("gets nothing when the meeting is not host-visible, or the host does not vouch, or is down - the same bytes as no meetingId", async () => {
      fake.setEntity("widget", "w1", { title: "W1", href: "/w/1", hostVisible: true });
      const notVisible = await meeting({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1", hostVisible: false });
      const closed = await meeting({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w2", hostVisible: true });
      fake.setEntity("widget", "w2", { title: "W2", href: "/w/2", state: "closed" });
      const plain = (await call("/templates", "bob")).text;
      expect((await call(`/templates?meetingId=${notVisible.id}`, "bob")).text).toBe(plain);
      expect((await call(`/templates?meetingId=${closed.id}`, "bob")).text).toBe(plain);
      fake.mode.resolve = { status: 503 };
      const down = await meeting({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1", hostVisible: true });
      expect((await call(`/templates?meetingId=${down.id}`, "bob")).text).toBe(plain);
    });
  });

  it("answers the same for a meeting the caller cannot see, or that does not exist, as for no meeting at all", async () => {
    const m = await meeting({ hostApp: "crm", hostEntityType: "deal", hostEntityId: "deal-1" });
    const plain = await (await call("/templates", "mallory")).text;
    const hidden = await (await call(`/templates?meetingId=${m.id}`, "mallory")).text;
    const missing = await (await call("/templates?meetingId=does-not-exist", "mallory")).text;
    expect(hidden).toBe(plain);
    expect(missing).toBe(plain);
  });
});

describe("language (AC-8.6)", () => {
  it("renders built-ins in the Accept-Language language and leaves user templates as written", async () => {
    await personal("alice", "My notes");
    const it = (await call("/templates", "alice", { "Accept-Language": "it-IT,it;q=0.9,en;q=0.5" })).json;
    expect(names(it)).toEqual(["My notes", "Verbale della riunione", "Chiamata di discovery commerciale", "1:1", "Azioni da intraprendere"]);
    const minutes = it.items.find((i: { id: string }) => i.id === "builtin:minutes");
    expect(minutes.sections[0].heading).toBe("Riepilogo");
    const en = (await call("/templates", "alice", { "Accept-Language": "en" })).json;
    expect(en.items.find((i: { id: string }) => i.id === "builtin:minutes").sections[0].heading).toBe("Summary");
    // no header: English
    expect(names((await call("/templates", "alice")).json)[1]).toBe("Meeting minutes");
  });
});
