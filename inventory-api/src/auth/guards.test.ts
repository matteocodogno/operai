/**
 * The guard split (T7, specs/015-hardware-inventory; AC-9.7, ADR-0014,
 * ADR-0045): routes behind `authorized` need a JWT AND live authorization;
 * routes behind `identityOnly` (the `/me/*` family) need a JWT and nothing
 * else — in particular they never call `auth` and do not fail when it is down.
 *
 * Real Hono apps with the real middleware, over the shared test harness (RS256
 * verification against a local key set, `GET /authz/resolve` replaced by a
 * fixture). `/me/*` itself is built by T16; this pins the contract it must use.
 */

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { setupTestAuth } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

const { authorized, identityOnly, requireCapability, ASSET_MANAGE, LEDGER_MANAGE } =
  await import("./guards");
const { __resetAuthzCacheForTests } = await import("./authz.middleware");

const app = new Hono();
app.use("/me/*", ...identityOnly);
app.get("/me/ping", (c) => c.json({ sub: c.get("userId" as never) }));
app.use("/gated/*", ...authorized);
app.get("/gated/ping", (c) => c.json({ ok: true }));
app.get("/gated/asset", requireCapability(ASSET_MANAGE), (c) => c.json({ ok: true }));
app.get(
  "/gated/either",
  requireCapability(ASSET_MANAGE, LEDGER_MANAGE),
  (c) => c.json({ ok: true }),
);

const grants = (...pairs: [string, string][]) => async () => ({
  sub: "u",
  epoch: 1,
  permissions: pairs.map(([resource, action]) => ({
    resource,
    action,
    conditions: null,
  })),
  entity: "welld_ch",
  jobTitle: null,
});

let token: string;
beforeAll(async () => {
  token = await harness.signToken({ sub: "user-1", email: "u1@welld.ch" });
});
beforeEach(() => {
  __resetAuthzCacheForTests();
  harness.setResolve(grants());
});

const get = (path: string, withToken = true) =>
  app.request(path, withToken ? { headers: { Authorization: `Bearer ${token}` } } : {});

describe("identityOnly (the /me/* stack, ADR-0045)", () => {
  it("a user with no permissions at all gets through", async () => {
    harness.setResolve(grants());
    const res = await get("/me/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "user-1" });
  });

  it("never calls auth for authorization", async () => {
    const before = harness.resolveCallCount();
    await get("/me/ping");
    expect(harness.resolveCallCount()).toBe(before);
  });

  it("an auth outage does not affect it", async () => {
    harness.setResolve(async () => {
      throw new Error("auth is down");
    });
    expect((await get("/me/ping")).status).toBe(200);
  });

  it("still needs a valid token: none → 401 Problem JSON", async () => {
    const res = await get("/me/ping", false);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
  });
});

describe("authorized (everything else)", () => {
  it("no token → 401 and auth is not consulted", async () => {
    const before = harness.resolveCallCount();
    expect((await get("/gated/ping", false)).status).toBe(401);
    expect(harness.resolveCallCount()).toBe(before);
  });

  it("a valid token resolves permissions through auth", async () => {
    const before = harness.resolveCallCount();
    expect((await get("/gated/ping")).status).toBe(200);
    expect(harness.resolveCallCount()).toBe(before + 1);
  });

  it("an auth outage → 503 Problem JSON, never 200 (fail closed)", async () => {
    harness.setResolve(async () => {
      throw new Error("auth is down");
    });
    const res = await get("/gated/ping");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: number }).status).toBe(503);
  });
});

describe("requireCapability", () => {
  it("403 Problem JSON when the caller lacks the capability", async () => {
    harness.setResolve(grants(["inventory", "access"]));
    const res = await get("/gated/asset");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { status: number; title: string; instance: string };
    expect(body.status).toBe(403);
    expect(body.title).toBe("Forbidden");
    expect(body.instance).toBe("/gated/asset");
  });

  it("passes with the capability, whatever else is held", async () => {
    harness.setResolve(grants(["asset", "manage"]));
    expect((await get("/gated/asset")).status).toBe(200);
  });

  it("the other capability does not stand in for it", async () => {
    harness.setResolve(grants(["ledger", "manage"]));
    expect((await get("/gated/asset")).status).toBe(403);
  });

  it("any-of: either capability is enough, neither is 403", async () => {
    harness.setResolve(grants(["ledger", "manage"]));
    expect((await get("/gated/either")).status).toBe(200);
    __resetAuthzCacheForTests();
    harness.setResolve(grants(["asset", "manage"]));
    expect((await get("/gated/either")).status).toBe(200);
    __resetAuthzCacheForTests();
    harness.setResolve(grants(["inventory", "access"]));
    expect((await get("/gated/either")).status).toBe(403);
  });
});
