/**
 * The fake owners themselves (specs/029 T11: `src/test-support/hosts.ts`). Every later hours-api task
 * (T12-T20) scripts them and cannot extend them (tasks.md "shared files"), so what they promise is
 * pinned here: they refuse what the real owners refuse (a client that sent something the owner would
 * refuse must fail its test, not pass against a lenient fake), they record every request that reached
 * them, and they put themselves back.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { env } from "../lib/env";
import { serviceTokens } from "../lib/serviceToken";
import { TEST_AUDIENCE, TEST_SERVICE_AUDIENCE } from "../test-support/env";
import { claimsOf, startHosts, tokenShaped } from "../test-support/hosts";
import { resetWorld } from "../test-support/world";

const hosts = startHosts();
afterAll(() => hosts.stop());
beforeEach(() => hosts.reset());

const ALICE = `Bearer ${tokenShaped({ sub: "user-alice" })}`;

const post = (base: string, path: string, body: unknown, authorization: string | null = ALICE) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
  });
const get = (base: string, path: string, authorization: string | null = ALICE) =>
  fetch(`${base}${path}`, { headers: authorization ? { Authorization: authorization } : {} });

const projectsResolve = (body: unknown, authorization?: string | null) => post(env.PROJECTS_API_URL, "/activity-host/v1/resolve", body, authorization);
const crmResolve = (body: unknown, authorization?: string | null) => post(env.CRM_API_URL, "/activity-host/v1/resolve", body, authorization);
const activities = (query: string, authorization?: string | null) => get(env.ACTIVITIES_API_URL, `/activities?${query}`, authorization);
const meetings = (query: string, authorization?: string | null) => get(env.MEETINGS_API_URL, `/meetings?${query}`, authorization);
const systemHosts = (query: string, authorization: string | null) => get(env.MEETINGS_API_URL, `/system/meetings/hosts?${query}`, authorization);

const serviceToken = (claims: Record<string, unknown> = {}) =>
  `Bearer ${tokenShaped({ sub: "system:hours-api", aud: TEST_SERVICE_AUDIENCE, scope: "meetings.hosts.read", exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;

describe("startHosts", () => {
  it("points the owner URLs and auth at itself, and `stop` puts the placeholders back", async () => {
    const other = startHosts();
    try {
      for (const url of [env.PROJECTS_API_URL, env.CRM_API_URL, env.ACTIVITIES_API_URL, env.MEETINGS_API_URL, env.AUTH_BASE_URL]) {
        expect(url.startsWith(other.url)).toBe(true);
      }
    } finally {
      await other.stop();
    }
    // `other` saved what it found: the first server's URLs.
    expect(env.PROJECTS_API_URL).toBe(`${hosts.url}/projects`);
    expect(env.AUTH_BASE_URL).toBe(`${hosts.url}/auth`);
  });

  it("answers a route it does not play, or the wrong method, as a route not deployed yet: 404", async () => {
    expect((await fetch(`${hosts.url}/projects/nothing-here`)).status).toBe(404);
    expect((await get(env.PROJECTS_API_URL, "/activity-host/v1/resolve")).status).toBe(404);
  });
});

describe("what it records", () => {
  it("every request that reached it, in order, with the Authorization it got and the query decoded", async () => {
    await activities("ids=a%26b%2Cc");
    await projectsResolve({ entityType: "project", ids: ["p1"] });
    expect(hosts.calls.map((call) => call.route)).toEqual(["activities.list", "projects.resolve"]);
    const [list, resolve] = hosts.calls;
    expect(list?.authorization).toBe(ALICE);
    expect(list?.query.get("ids")).toBe("a&b,c");
    expect(list?.method).toBe("GET");
    expect(list?.path).toBe("/activities");
    expect(resolve?.body).toEqual({ entityType: "project", ids: ["p1"] });
    expect(resolve?.path).toBe("/activity-host/v1/resolve");
    expect(hosts.callsTo("projects.resolve")).toHaveLength(1);
  });

  it("a request it refuses, a request that fails by script and a request with no credential too", async () => {
    await projectsResolve({ entityType: "project", ids: "nope" });
    await projectsResolve({ entityType: "project", ids: [] }, null);
    hosts.fail("crm.resolve", { status: 500 });
    await crmResolve({ entityType: "deal", ids: ["d1"] });
    expect(hosts.calls).toHaveLength(3);
    expect(hosts.calls[1]?.authorization).toBeNull();
  });
});

describe("failures by script", () => {
  it("`times` applies to the next N calls only, `after` lets N through first, `heal` clears", async () => {
    hosts.projects.setProject("p1", { label: "One" });
    const status = async () => (await projectsResolve({ entityType: "project", ids: ["p1"] })).status;
    hosts.fail("projects.resolve", { status: 503, times: 2 });
    expect([await status(), await status(), await status()]).toEqual([503, 503, 200]);
    hosts.fail("projects.resolve", { status: 500, after: 1 });
    expect([await status(), await status(), await status()]).toEqual([200, 500, 500]);
    hosts.heal("projects.resolve");
    expect(await status()).toBe(200);
  });

  it("`withStatus` is the route's good answer under another status", async () => {
    hosts.projects.setProject("p1", { label: "One" });
    hosts.fail("projects.resolve", { withStatus: 206 });
    const res = await projectsResolve({ entityType: "project", ids: ["p1"] });
    expect(res.status).toBe(206);
    expect(await res.json()).toMatchObject({ reader: true, items: [{ id: "p1", state: "open" }] });
  });

  it("`sever` closes one owner's port, and `reset` opens it again", async () => {
    hosts.sever("projects");
    await expect(projectsResolve({ entityType: "project", ids: ["p1"] })).rejects.toThrow();
    expect((await crmResolve({ entityType: "deal", ids: [] })).status).toBe(200);
    hosts.reset();
    expect((await projectsResolve({ entityType: "project", ids: [] })).status).toBe(200);
  });

  it("`reset` clears what was scripted, recorded and failed, and the legacy switches", async () => {
    hosts.projects.setProject("p1", { label: "One" });
    hosts.crm.legacy = hosts.activities.legacy = hosts.meetings.legacy = true;
    hosts.fail("projects.resolve", { status: 500 });
    await projectsResolve({ entityType: "project", ids: ["p1"] });
    hosts.reset();
    expect(hosts.calls).toEqual([]);
    expect([hosts.crm.legacy, hosts.activities.legacy, hosts.meetings.legacy]).toEqual([false, false, false]);
    const body: any = await (await projectsResolve({ entityType: "project", ids: ["p1"] })).json();
    expect(body).toEqual({ reader: true, items: [{ id: "p1", state: "missing" }] });
  });

  it("is reset by `resetWorld`, the hook T10's world.ts offers", async () => {
    hosts.projects.setProject("p1", { label: "One" });
    await projectsResolve({ entityType: "project", ids: ["p1"] });
    await resetWorld();
    expect(hosts.calls).toEqual([]);
    expect(await (await projectsResolve({ entityType: "project", ids: ["p1"] })).json()).toEqual({ reader: true, items: [{ id: "p1", state: "missing" }] });
  });
});

describe("projects-api: the strict body and the reader", () => {
  it.each([
    ["an unknown key", { entityType: "project", ids: [], userId: "x" }],
    ["another entity type", { entityType: "deal", ids: [] }],
    ["26 ids", { entityType: "project", ids: Array.from({ length: 26 }, (_, i) => `p${i}`) }],
    ["an id over 64 characters", { entityType: "project", ids: ["p".repeat(65)] }],
    ["an empty id", { entityType: "project", ids: [""] }],
    ["an id holding a NUL", { entityType: "project", ids: ["a\u0000b"] }],
    ["ids that are not a list", { entityType: "project", ids: "p1" }],
  ])("refuses %s with a 400", async (_label, body) => {
    expect((await projectsResolve(body)).status).toBe(400);
  });

  it("accepts 25 ids and the optional `related` it ignores, and answers 401 with no credential", async () => {
    expect((await projectsResolve({ entityType: "project", ids: Array.from({ length: 25 }, (_, i) => `p${i}`), related: { deal: ["d1"] } })).status).toBe(200);
    expect((await projectsResolve({ entityType: "project", ids: [] }, null)).status).toBe(401);
  });

  it("answers a non-reader `reader: false` with every id missing, and reads per caller", async () => {
    hosts.projects.setProject("p1", { label: "One", assignees: ["user-alice"] });
    hosts.projects.setReader("*", false);
    hosts.projects.setReader("user-alice", true);
    const alice = await (await projectsResolve({ entityType: "project", ids: ["p1"] })).json();
    expect(alice).toMatchObject({ reader: true, items: [{ id: "p1", state: "open", assignees: ["user-alice"] }] });
    const bob = await (await projectsResolve({ entityType: "project", ids: ["p1"] }, `Bearer ${tokenShaped({ sub: "user-bob" })}`)).json();
    expect(bob).toEqual({ reader: false, items: [{ id: "p1", state: "missing" }] });
  });
});

describe("crm-api: the deal body", () => {
  it("is strict for a deal (`related` is a company member) and answers 422", async () => {
    expect((await crmResolve({ entityType: "deal", ids: [], related: { deal: [] } })).status).toBe(422);
    expect((await crmResolve({ entityType: "deal", ids: ["d1"] })).status).toBe(200);
    expect((await crmResolve({ entityType: "deal", ids: Array.from({ length: 26 }, (_, i) => `d${i}`) })).status).toBe(422);
    expect((await crmResolve({ entityType: "project", ids: [] })).status).toBe(422);
  });

  it("answers a non-reader `reader: false` and no item at all, so not even whether a deal exists leaks", async () => {
    hosts.crm.setDeal("d1", { label: "One", involved: ["user-alice"] });
    hosts.crm.setReader("user-alice", false);
    expect(await (await crmResolve({ entityType: "deal", ids: ["d1"] })).json()).toEqual({ reader: false, items: [] });
  });

  it("answers `involved` for an open deal, and 422 to `entityType: deal` when it plays an old crm-api", async () => {
    hosts.crm.setDeal("d1", { label: "One", involved: ["user-owner", "user-tech"] });
    expect(await (await crmResolve({ entityType: "deal", ids: ["d1", "d2"] })).json()).toMatchObject({
      reader: true,
      items: [{ id: "d1", state: "open", involved: ["user-owner", "user-tech"] }, { id: "d2", state: "missing" }],
    });
    hosts.crm.legacy = true;
    expect((await crmResolve({ entityType: "deal", ids: ["d1"] })).status).toBe(422);
    expect((await crmResolve({ entityType: "company", ids: [] })).status).toBe(200);
  });
});

describe("activities-api: `ids` and `dealId`, as T6 built them", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`).join(",");

  it("needs exactly one filter: none, two, or `ids` alone empty is a 422", async () => {
    expect((await activities("")).status).toBe(422);
    expect((await activities("ids=")).status).toBe(422);
    expect((await activities("ids=a1&dealId=d1")).status).toBe(422);
    expect((await activities("ids=a1")).status).toBe(200);
    expect((await activities("dealId=d1")).status).toBe(200);
  });

  it.each([
    ["an empty element", "ids=a,,b"],
    ["a trailing comma", "ids=a,"],
    ["a leading comma", "ids=,a"],
    ["an element of 65 characters", `ids=${"x".repeat(65)}`],
    ["a NUL", "ids=a%00b"],
    ["the parameter repeated", "ids=a&ids=b"],
    ["51 elements", `ids=${ids(51)}`],
  ])("answers %s with a 422", async (_label, query) => {
    expect((await activities(query)).status).toBe(422);
  });

  it("accepts 50 elements, never trims, and answers ONE page whatever `page` and `pageSize` say", async () => {
    for (let i = 0; i < 60; i++) hosts.activities.add({ id: `a${i}`, subject: `S${i}`, project: "p1" });
    hosts.activities.add({ id: " a ", subject: "spaced", project: "p1" });
    const body: any = await (await activities(`ids=${ids(50)}&page=3&pageSize=5`)).json();
    expect(body).toMatchObject({ total: 50, page: 1, pageSize: 50 });
    expect(body.items).toHaveLength(50);
    const spaced: any = await (await activities("ids=%20a%20")).json();
    expect(spaced.items.map((item: { id: string }) => item.id)).toEqual([" a "]);
    expect(((await (await activities("ids=a")).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("is the old activities-api when `legacy`: `ids` is not a filter, so `ids` alone is the \"exactly one\" 422", async () => {
    hosts.activities.legacy = true;
    expect((await activities("ids=a1")).status).toBe(422);
    expect((await activities("dealId=d1")).status).toBe(200);
  });

  it("pages a deal's activities newest first, a hundred at most, and 404s a non-reader", async () => {
    for (let i = 0; i < 120; i++) hosts.activities.add({ id: `a${i}`, subject: `S${i}`, deal: "d1" });
    const first: any = await (await activities("dealId=d1&page=1&pageSize=100")).json();
    expect(first).toMatchObject({ total: 120, page: 1, pageSize: 100 });
    expect(first.items[0].id).toBe("a119");
    expect(((await (await activities("dealId=d1&page=2&pageSize=100")).json()) as { items: unknown[] }).items).toHaveLength(20);
    expect((await activities("dealId=d1&pageSize=101")).status).toBe(422);
    expect(((await (await activities("dealId=d1")).json()) as { pageSize: number }).pageSize).toBe(25);
    hosts.activities.setReader("user-alice", false);
    expect((await activities("dealId=d1")).status).toBe(404);
  });
});

describe("meetings-api: `ids` on the caller's own list, as T8 built it", () => {
  it.each([
    ["an empty list", "ids="],
    ["a blank list", "ids=%20"],
    ["an empty member", "ids=a,,b"],
    ["a trailing comma", "ids=a,"],
    ["a member of 65 characters", `ids=${"x".repeat(65)}`],
    ["26 members", `ids=${Array.from({ length: 26 }, (_, i) => `m${i}`).join(",")}`],
    ["the parameter repeated", "ids=a&ids=b"],
  ])("answers %s with a 422, never `no filter`", async (_label, query) => {
    expect((await meetings(query)).status).toBe(422);
  });

  it("returns only the caller's meetings among the ids, trimmed, newest first, and a NUL member is absent", async () => {
    hosts.meetings.add({ id: "m1", title: "Old", creator: "user-alice" });
    hosts.meetings.add({ id: "m2", title: "New", creator: "user-bob", participants: ["user-alice"] });
    hosts.meetings.add({ id: "m3", title: "Not mine", creator: "user-bob" });
    const body: any = await (await meetings("ids=%20m1%20,m2,m3,a%00b")).json();
    expect(body.items.map((row: { id: string }) => row.id)).toEqual(["m2", "m1"]);
    expect(body.items.map((row: { role: string }) => row.role)).toEqual(["participant", "creator"]);
    expect(body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
  });

  it("is the old meetings-api when `legacy`: `ids` is ignored and the caller's latest page comes back", async () => {
    for (let i = 1; i <= 30; i++) hosts.meetings.add({ id: `m${i}`, creator: "user-alice" });
    hosts.meetings.legacy = true;
    const body: any = await (await meetings("ids=m1")).json();
    expect(body.items).toHaveLength(25);
    expect(body.items[0].id).toBe("m30");
    expect(body.total).toBe(30);
  });
});

describe("meetings-api: the system route answers one identical 401 to anything but hours-api's service JWT", () => {
  it.each([
    ["no credential", () => null],
    ["a user JWT", () => `Bearer ${tokenShaped({ sub: "user-alice", aud: TEST_AUDIENCE })}`],
    ["another subject", () => serviceToken({ sub: "system:crm-api" })],
    ["another scope", () => serviceToken({ scope: "notifications.push" })],
    ["a scope that only contains it", () => serviceToken({ scope: "meetings.hosts.read.more" })],
    ["the user audience", () => serviceToken({ aud: TEST_AUDIENCE })],
    ["an expired token", () => serviceToken({ exp: Math.floor(Date.now() / 1000) - 10 })],
    ["a bearer that is not a JWT", () => "Bearer nonsense"],
  ])("refuses %s", async (_label, credential) => {
    const res = await systemHosts("ids=m1", credential());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ type: "https://httpstatuses.com/401", title: "scripted", status: 401 });
  });

  it("answers `{id, host}` and nothing else, omitting unknown ids, and needs exactly one of `ids` / `dealId`", async () => {
    hosts.meetings.add({ id: "m1", title: "Secret title", creator: "user-bob", participants: ["user-carol"], dealId: "d1" });
    hosts.meetings.add({ id: "m2", creator: "user-bob" });
    const body: any = await (await systemHosts("ids=m1,m2,m3", serviceToken())).json();
    expect(body).toEqual({
      items: [
        { id: "m1", host: { app: "crm", entityType: "deal", entityId: "d1" } },
        { id: "m2", host: null },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("Secret title");
    expect(await (await systemHosts("dealId=d1", serviceToken())).json()).toEqual({
      items: [{ id: "m1", host: { app: "crm", entityType: "deal", entityId: "d1" } }],
    });
    expect((await systemHosts("", serviceToken())).status).toBe(422);
    expect((await systemHosts("ids=m1&dealId=d1", serviceToken())).status).toBe(422);
    expect((await systemHosts(`ids=${Array.from({ length: 101 }, (_, i) => `m${i}`).join(",")}`, serviceToken())).status).toBe(422);
  });
});

describe("auth", () => {
  it("answers identities for the active only, `unknown` for the rest, and refuses a loose body", async () => {
    hosts.auth.setIdentity("user-alice", { name: "Alice Rossi" });
    hosts.auth.setIdentity("user-gone", { name: "Should not show", status: "deleted" });
    const res = await post(env.AUTH_BASE_URL, "/authz/users/identities", { ids: ["user-alice", "user-gone", "user-who"] });
    expect(await res.json()).toEqual({
      users: [
        { id: "user-alice", status: "active", name: "Alice Rossi" },
        { id: "user-gone", status: "deleted", name: null },
        { id: "user-who", status: "unknown", name: null },
      ],
    });
    expect((await post(env.AUTH_BASE_URL, "/authz/users/identities", { ids: [] })).status).toBe(400);
    expect((await post(env.AUTH_BASE_URL, "/authz/users/identities", { ids: ["a"], email: "x" })).status).toBe(400);
    expect((await post(env.AUTH_BASE_URL, "/authz/users/identities", { ids: Array.from({ length: 101 }, (_, i) => `u${i}`) })).status).toBe(400);
  });

  it("shows a renamed person's new name on the next call", async () => {
    hosts.auth.setIdentity("user-alice", { name: "Alice Rossi" });
    hosts.auth.setIdentity("user-alice", { name: "Alice Bianchi" });
    const res = await post(env.AUTH_BASE_URL, "/authz/users/identities", { ids: ["user-alice"] });
    expect(((await res.json()) as { users: { name: string }[] }).users[0]?.name).toBe("Alice Bianchi");
  });

  it("resolves the caller's own permissions, unconditioned, and echoes the token's `perm_epoch`", async () => {
    hosts.auth.grant("user-holder", "time-entry", "read-all");
    const holder = `Bearer ${tokenShaped({ sub: "user-holder", perm_epoch: 7 })}`;
    const res = await get(env.AUTH_BASE_URL, "/authz/resolve", holder);
    expect(await res.json()).toEqual({
      sub: "user-holder",
      epoch: 7,
      permissions: [{ resource: "time-entry", action: "read-all", conditions: null }],
      entity: null,
      jobTitle: null,
    });
    const other = await (await get(env.AUTH_BASE_URL, "/authz/resolve", ALICE)).json();
    expect(other).toMatchObject({ sub: "user-alice", epoch: 0, permissions: [] });
    expect((await get(env.AUTH_BASE_URL, "/authz/resolve", null)).status).toBe(401);
  });

  describe("the service token endpoint", () => {
    const mint = (body: unknown) => post(env.AUTH_BASE_URL, "/system/service-token", body, null);

    it("mints hours-api's JWT for its own client id and secret, and counts it", async () => {
      const res = await mint({ clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET });
      const { token, expiresInSeconds } = (await res.json()) as { token: string; expiresInSeconds: number };
      expect(expiresInSeconds).toBe(300);
      expect(claimsOf(`Bearer ${token}`)).toMatchObject({ sub: "system:hours-api", aud: TEST_SERVICE_AUDIENCE, scope: "meetings.hosts.read" });
      expect(hosts.auth.mints).toBe(1);
    });

    it("answers a wrong secret and an unknown client alike, and refuses a loose body", async () => {
      const wrongSecret = await mint({ clientId: env.SERVICE_CLIENT_ID, clientSecret: "nope" });
      const unknownClient = await mint({ clientId: "someone-else", clientSecret: env.SERVICE_CLIENT_SECRET });
      expect([wrongSecret.status, unknownClient.status]).toEqual([401, 401]);
      expect(await wrongSecret.text()).toBe(await unknownClient.text());
      expect((await mint({ clientId: "x", clientSecret: "y", extra: 1 })).status).toBe(400);
      expect(hosts.auth.mints).toBe(0);
    });

    it("is forgotten by `reset`: the wired provider mints again afterwards", async () => {
      const first = await serviceTokens.getToken();
      expect(await serviceTokens.getToken()).toBe(first);
      expect(hosts.auth.mints).toBe(1);
      hosts.reset();
      const second = await serviceTokens.getToken();
      expect(second).not.toBe(first);
      expect(hosts.auth.mints).toBe(1);
    });
  });
});
