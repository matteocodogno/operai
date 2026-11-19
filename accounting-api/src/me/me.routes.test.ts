/**
 * GET /v1/me (T6, specs/20261119-accounting, AC-3.2, AC-3.5, AC-3.6, AC-8.2): the real app, the shared auth
 * harness (a fake `auth GET /authz/resolve`), no database.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { failingResolve, fakeResolve, PERSONAS, type Persona } from "../test-support/fakeResolve";
import { setupTestAuth } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();
const { __resetAuthzCacheForTests } = await import("../authz/authz.middleware");
const { handleProblemError, validationHook } = await import("../lib/problem");

// The router under test, in a small app of its own. `setupTestAuth` installs the jwt and resolve mocks when it is
// imported, before any file evaluates a router, so this router holds the mocked jwt middleware like every other.
// The assembled app is checked below for what needs no mock: that the route is mounted.
const { meRouter } = await import("./me.routes");
const app = new OpenAPIHono({ defaultHook: validationHook });
app.route("/", meRouter);
app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.text("unexpected", 500));

let token: string;
beforeAll(async () => {
  token = await harness.signToken({ sub: "user-1", email: "a@welld.ch" });
});
beforeEach(() => __resetAuthzCacheForTests());

async function me(persona: Persona | null, headers: Record<string, string> = { Authorization: `Bearer ${token}` }) {
  if (persona) harness.setResolve(fakeResolve(persona));
  return app.request("/v1/me", { headers });
}

describe("GET /v1/me", () => {
  it("lists one entity for a welld_ch user with entity-conditioned grants, who can manage it", async () => {
    const res = await me(PERSONAS.accountingCh);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entities: [{ entity: "welld_ch", ownCurrency: "CHF", canManage: true, rateSource: "bazg" }],
    });
  });

  it("lists welld_it with no source for a welld_it user (D19)", async () => {
    const res = await me(PERSONAS.accountingIt);
    expect(await res.json()).toEqual({
      entities: [{ entity: "welld_it", ownCurrency: "EUR", canManage: true, rateSource: null }],
    });
  });

  it("lists both entities for an admin, welld_ch first", async () => {
    const res = await me(PERSONAS.admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entities: [
        { entity: "welld_ch", ownCurrency: "CHF", canManage: true, rateSource: "bazg" },
        { entity: "welld_it", ownCurrency: "EUR", canManage: true, rateSource: null },
      ],
    });
  });

  it("a reader reads the entity without canManage", async () => {
    const body = (await (await me(PERSONAS.readerCh)).json()) as { entities: { canManage: boolean }[] };
    expect(body.entities).toHaveLength(1);
    expect(body.entities[0]?.canManage).toBe(false);
  });

  it("manage alone covers read: the entity is listed, and can be managed", async () => {
    expect(await (await me(PERSONAS.managerOnlyCh)).json()).toEqual({
      entities: [{ entity: "welld_ch", ownCurrency: "CHF", canManage: true, rateSource: "bazg" }],
    });
  });

  it("canManage is per entity: manage on one, read on the other", async () => {
    const persona: Persona = {
      sub: "user-mixed",
      entity: "welld_ch",
      permissions: [
        { resource: "accounting", action: "read", conditions: null },
        { resource: "accounting", action: "manage", conditions: PERSONAS.accountingCh.permissions[1]?.conditions ?? null },
      ],
    };
    const body = (await (await me(persona)).json()) as { entities: { entity: string; canManage: boolean }[] };
    expect(body.entities.map((e) => [e.entity, e.canManage])).toEqual([
      ["welld_ch", true],
      ["welld_it", false],
    ]);
  });

  it("403 accounting_forbidden with no data for a person with neither grant", async () => {
    const res = await me(PERSONAS.outsider);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 403, code: "accounting_forbidden", instance: "/v1/me" });
    expect(body).not.toHaveProperty("entities");
  });

  it("403 for a grant that covers nothing: no entity, or a condition it does not know", async () => {
    for (const persona of [PERSONAS.noEntity, PERSONAS.unknownCondition]) {
      const res = await me(persona);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "accounting_forbidden" });
    }
  });

  it("401 without a token, and the permissions are never asked for", async () => {
    harness.setResolve(fakeResolve(PERSONAS.admin));
    const before = harness.resolveCallCount();
    const res = await app.request("/v1/me");
    expect(res.status).toBe(401);
    expect(harness.resolveCallCount()).toBe(before);
  });

  it("503, never data, when auth cannot be reached (fail closed)", async () => {
    harness.setResolve(failingResolve);
    const res = await app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("entities");
  });

  it("answers GET only, and an unknown /v1 path stays a plain 404 with no login in front", async () => {
    harness.setResolve(fakeResolve(PERSONAS.admin));
    const post = await app.request("/v1/me", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(post.status).toBe(404);
    const unknown = await app.request("/v1/nothing-here");
    expect(unknown.status).toBe(404);
  });
});

describe("the assembled app", () => {
  it("mounts GET /v1/me behind the token: 401 without one, where an unmounted route would be a 404", async () => {
    const { app: assembled } = await import("../index");
    const res = await assembled.request("/v1/me");
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("entities");
  });
});
