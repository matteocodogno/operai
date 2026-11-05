import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";

// AC-1.1, AC-1.7, AC-5.5, AC-5.6, AC-11.2, AC-11.3, AC-11.4 (specs/021 T21): the registry,
// the entity lookup, a host entity's meetings and the linkable meetings (G2), with the
// `testhost` fake and a CRM-shaped `crm/deal` on the same fake.

const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  for (const user of ["alice", "bob", "carol", "dave"]) kit.grant(user, "access");
  kit.grant("outsider");
  kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1" });
  kit.fake.setEntity("widget", "w2", { title: "Widget two", href: "/testhost/widgets/w2" });
  kit.fake.setEntity("deal", "d1", { title: "Big deal", href: "/crm/deals/d1" });
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const json = async (res: Response) => (await res.json()) as Record<string, any>;
let n = 0;
async function seed(over: Record<string, unknown> = {}) {
  n += 1;
  return kit.db.meeting.create({
    data: {
      title: `Meeting ${n}`,
      format: "online",
      startsAt: new Date(Date.UTC(2026, 10, 1, 9, 0, n)),
      language: "en",
      source: "recorded",
      creatorUserId: "alice",
      ...over,
    } as never,
  });
}
const onW1 = { hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" };
const titles = (body: Record<string, any>) => body["items"].map((i: { title: string }) => i.title);

describe("GET /hosts", () => {
  it("serves the public part of every registered host to any signed-in user, never a base URL", async () => {
    const res = await kit.call("outsider", "GET", "/hosts");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["items"].map((h: { app: string; entityType: string }) => `${h.app}/${h.entityType}`).sort()).toEqual(["crm/deal", "quiethost/gadget", "testhost/widget"]);
    for (const host of body["items"]) {
      expect(Object.keys(host).sort()).toEqual(["app", "entityType", "labels", "offersHostVisible", "recommendedTemplates"]);
      for (const lang of ["en", "it"]) expect(Object.keys(host.labels[lang]).sort()).toEqual(["app", "entity", "noticeFailed", "visibilityHint"]);
    }
    expect(JSON.stringify(body)).not.toContain(kit.fake.url);
    const crm = body["items"].find((h: { app: string }) => h.app === "crm");
    expect(crm).toMatchObject({ offersHostVisible: true, recommendedTemplates: ["builtin:sales-discovery"], labels: { en: { noticeFailed: "The deal's activity could not be added" } } });
  });

  it("is 401 without a token", async () => {
    expect((await kit.call(null, "GET", "/hosts")).status).toBe(401);
  });
});

describe("GET /hosts/:app/:type/:id", () => {
  for (const [app, type, id, title, href] of [
    ["testhost", "widget", "w1", "Widget one", "/testhost/widgets/w1"],
    ["crm", "deal", "d1", "Big deal", "/crm/deals/d1"],
  ] as const) {
    it(`returns the host's title for ${app}/${type}, resolved as the caller (AC-1.1)`, async () => {
      const res = await kit.call("alice", "GET", `/hosts/${app}/${type}/${id}`);
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ host: { app, entityType: type, entityId: id, state: "open", title, href } });
      expect(kit.fake.resolves[0]!.authorization).toBe(`Bearer ${await kit.tokenFor("alice")}`);
    });
  }

  it("422 host_not_registered, and missing and closed are byte-identical 422 host_entity_not_found", async () => {
    const unregistered = await kit.call("alice", "GET", "/hosts/nohost/widget/w1");
    expect(unregistered.status).toBe(422);
    expect((await json(unregistered))["code"]).toBe("host_not_registered");

    kit.fake.setEntity("widget", "shut", { title: "Secret", href: "/x", state: "closed" });
    const closed = await kit.call("alice", "GET", "/hosts/testhost/widget/shut");
    const missing = await kit.call("alice", "GET", "/hosts/testhost/widget/ghost");
    expect(closed.status).toBe(422);
    expect(await closed.text()).toBe((await missing.text()).replace("ghost", "shut"));
  });

  it("503 host_unavailable when the host cannot answer; 403 without meetings:access", async () => {
    kit.fake.mode.resolve = { status: 500 };
    const down = await kit.call("alice", "GET", "/hosts/testhost/widget/w1");
    expect(down.status).toBe(503);
    expect((await json(down))["code"]).toBe("host_unavailable");
    expect((await kit.call("outsider", "GET", "/hosts/testhost/widget/w1")).status).toBe(403);
  });
});

describe("GET /hosts/:app/:type/:id/meetings", () => {
  async function arrange() {
    const mine = await seed({ ...onW1, title: "Mine" });
    const shared = await seed({ ...onW1, title: "Shared by bob", creatorUserId: "bob", hostVisible: true });
    const invited = await seed({ ...onW1, title: "Invited", creatorUserId: "carol", participants: { create: [{ userId: "alice", addedBy: "carol" }] } });
    const hidden = await seed({ ...onW1, title: "Private of bob", creatorUserId: "bob" });
    const elsewhere = await seed({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w2", title: "Other widget", hostVisible: true });
    const standalone = await seed({ title: "Standalone" });
    return { mine, shared, invited, hidden, elsewhere, standalone };
  }

  it("lists exactly what the viewer may open, newest first, with roles (AC-11.2, AC-11.3)", async () => {
    await arrange();
    const res = await kit.call("alice", "GET", "/hosts/testhost/widget/w1/meetings");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(titles(body)).toEqual(["Invited", "Shared by bob", "Mine"]);
    expect(body["items"].map((i: { role: string }) => i.role)).toEqual(["participant", "host_reader", "creator"]);
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 25, hostReadersUnavailable: false });
    expect(Object.keys(body["items"][0]).sort()).toEqual(["creator", "format", "host", "id", "role", "startsAt", "status", "summaryCount", "title"]);
    expect(body["items"][0]).toMatchObject({
      status: "draft",
      summaryCount: 0,
      creator: { id: "carol", status: "active" },
      host: { app: "testhost", entityType: "widget", entityId: "w1", state: "open", title: "Widget one" },
    });
    // the entity is resolved once for the whole page
    expect(kit.fake.resolves).toHaveLength(1);
  });

  it("works the same for a CRM-shaped host (AC-11.4)", async () => {
    const m = await seed({ hostApp: "crm", hostEntityType: "deal", hostEntityId: "d1", title: "Deal talk" });
    const res = await kit.call("alice", "GET", "/hosts/crm/deal/d1/meetings");
    expect(titles(await json(res))).toEqual(["Deal talk"]);
    expect(m.id).toBeTruthy();
  });

  it("a host reader needs meetings:access: without it only creator and participant rows remain, and nothing says more", async () => {
    await arrange();
    await seed({ ...onW1, title: "Bob's too", creatorUserId: "bob", hostVisible: true, participants: { create: [{ userId: "outsider", addedBy: "bob" }] } });
    const res = await kit.call("outsider", "GET", "/hosts/testhost/widget/w1/meetings");
    const body = await json(res);
    expect(titles(body)).toEqual(["Bob's too"]);
    expect(body).toMatchObject({ total: 1, hostReadersUnavailable: false });
  });

  it("a viewer the host does not let open the entity, or who lacks what the host requires, sees no host-visible meeting (AC-5.6, AC-5.7)", async () => {
    await arrange();
    kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/x", stateFor: { dave: "closed" } });
    expect(titles(await json(await kit.call("dave", "GET", "/hosts/testhost/widget/w1/meetings")))).toEqual([]);

    // open, but without the host's extra requirement (the CRM's deal:financials)
    kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/x", hostVisible: false });
    const body = await json(await kit.call("dave", "GET", "/hosts/testhost/widget/w1/meetings"));
    expect(titles(body)).toEqual([]);
    expect(body["total"]).toBe(0);
  });

  it("reveals nothing about meetings the viewer may not open: the answer is the same with or without them", async () => {
    kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/x", hostVisible: false });
    const before = await (await kit.call("dave", "GET", "/hosts/testhost/widget/w1/meetings")).text();
    await arrange();
    const after = await (await kit.call("dave", "GET", "/hosts/testhost/widget/w1/meetings")).text();
    expect(after).toBe(before);
    expect(JSON.parse(after)).toEqual({ items: [], total: 0, page: 1, pageSize: 25, hostReadersUnavailable: false });
  });

  it("host unreachable: only creator and participant rows, flagged hostReadersUnavailable", async () => {
    await arrange();
    kit.fake.mode.resolve = { status: 503 };
    const body = await json(await kit.call("alice", "GET", "/hosts/testhost/widget/w1/meetings"));
    expect(titles(body)).toEqual(["Invited", "Mine"]);
    expect(body["hostReadersUnavailable"]).toBe(true);
    expect(body["items"][0]["host"]).toMatchObject({ state: "unavailable", title: null });
  });

  it("pages 25 at a time", async () => {
    for (let i = 0; i < 27; i++) await seed({ ...onW1 });
    const first = await json(await kit.call("alice", "GET", "/hosts/testhost/widget/w1/meetings"));
    const second = await json(await kit.call("alice", "GET", "/hosts/testhost/widget/w1/meetings?page=2"));
    expect([first["items"].length, second["items"].length, first["total"]]).toEqual([25, 2, 27]);
    expect(new Set([...first["items"], ...second["items"]].map((i: { id: string }) => i.id)).size).toBe(27);
  });

  it("422 for an unregistered host; 401 without a token", async () => {
    expect((await kit.call("alice", "GET", "/hosts/nohost/widget/w1/meetings")).status).toBe(422);
    expect((await kit.call(null, "GET", "/hosts/testhost/widget/w1/meetings")).status).toBe(401);
  });
});

describe("GET /hosts/:app/:type/:id/linkable-meetings (G2)", () => {
  it("lists the caller's own meetings that are not on this entity, newest first", async () => {
    await seed({ title: "Standalone" });
    await seed({ ...onW1, title: "Already here" });
    await seed({ hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w2", title: "Linked elsewhere" });
    await seed({ title: "Participant only", creatorUserId: "bob", participants: { create: [{ userId: "alice", addedBy: "bob" }] } });
    await seed({ title: "Bob's shared", creatorUserId: "bob", ...onW1, hostVisible: true });
    await seed({ hostApp: "crm", hostEntityType: "deal", hostEntityId: "d1", title: "On a deal" });

    const res = await kit.call("alice", "GET", "/hosts/testhost/widget/w1/linkable-meetings");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(titles(body)).toEqual(["On a deal", "Linked elsewhere", "Standalone"]);
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(body["items"].every((i: { role: string }) => i.role === "creator")).toBe(true);
  });

  it("filters by title and pages", async () => {
    await seed({ title: "Alpha budget" });
    await seed({ title: "Beta" });
    const body = await json(await kit.call("alice", "GET", "/hosts/testhost/widget/w1/linkable-meetings?q=BUDG"));
    expect(titles(body)).toEqual(["Alpha budget"]);
  });

  it("is empty for a creator whose account is deactivated (frozen meetings cannot be linked)", async () => {
    await seed({ title: "Standalone" });
    kit.deactivate("alice");
    const body = await json(await kit.call("alice", "GET", "/hosts/testhost/widget/w1/linkable-meetings"));
    expect(body).toMatchObject({ items: [], total: 0 });
  });

  it("422 for an unregistered host, 403 without meetings:access, 503 when auth is down", async () => {
    expect((await kit.call("alice", "GET", "/hosts/nohost/widget/w1/linkable-meetings")).status).toBe(422);
    expect((await kit.call("outsider", "GET", "/hosts/testhost/widget/w1/linkable-meetings")).status).toBe(403);
    kit.setAuthDown(true);
    expect((await kit.call("alice", "GET", "/hosts/testhost/widget/w1/linkable-meetings")).status).toBe(503);
  });
});
