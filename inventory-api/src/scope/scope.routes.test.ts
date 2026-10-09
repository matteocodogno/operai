/**
 * `GET /scope` (T7, specs/015-hardware-inventory; AC-9.4, AC-9.5, AC-9.7).
 *
 * Real router + real auth/authz middleware over the shared harness (RS256
 * verification against a local key set, `GET /authz/resolve` replaced by a
 * fixture). Pins what the UI relies on: each capability's covered entities for
 * every grant shape, and that an `auth` outage is a 503 — never an empty scope.
 */

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";

const harness = setupTestAuth();
await harness.init();

const { scopeRouter } = await import("./scope.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const ENTITY: ResolvedPermission["conditions"] = {
  attributes: [{ key: "entity", match: "user" }],
};

const grant = (
  resource: string,
  action: string,
  conditions: ResolvedPermission["conditions"] = null,
): ResolvedPermission => ({ resource, action, conditions });

const resolving =
  (permissions: ResolvedPermission[], entity: string | null) => async () => ({
    sub: "u",
    epoch: 1,
    permissions,
    entity,
    jobTitle: null,
  });

let token: string;
beforeAll(async () => {
  token = await harness.signToken({ sub: "user-1", email: "u1@welld.ch", permEpoch: 1 });
});
beforeEach(() => {
  __resetAuthzCacheForTests();
});

const getScope = (auth: string | null = `Bearer ${token}`) =>
  scopeRouter.request("/scope", auth ? { headers: { Authorization: auth } } : {});

type ScopeBody = { asset: string[]; ledger: string[] };

describe("GET /scope", () => {
  it("entity-conditioned grants → the caller's own entity, per capability", async () => {
    harness.setResolve(
      resolving(
        [grant("asset", "manage", ENTITY), grant("ledger", "manage", ENTITY)],
        "welld_it",
      ),
    );
    const res = await getScope();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ asset: ["welld_it"], ledger: ["welld_it"] });
  });

  it("unconditioned grants → both entities", async () => {
    harness.setResolve(
      resolving([grant("asset", "manage"), grant("ledger", "manage")], "welld_ch"),
    );
    expect((await (await getScope()).json()) as ScopeBody).toEqual({
      asset: ["welld_ch", "welld_it"],
      ledger: ["welld_ch", "welld_it"],
    });
  });

  it("the two lists are independent: conditioned manager, unconditioned accountant", async () => {
    harness.setResolve(
      resolving([grant("asset", "manage", ENTITY), grant("ledger", "manage")], "welld_ch"),
    );
    expect((await (await getScope()).json()) as ScopeBody).toEqual({
      asset: ["welld_ch"],
      ledger: ["welld_ch", "welld_it"],
    });
  });

  it("conditioned grants with no user.entity → both lists empty (R-7), still 200", async () => {
    harness.setResolve(
      resolving(
        [grant("asset", "manage", ENTITY), grant("ledger", "manage", ENTITY)],
        null,
      ),
    );
    const res = await getScope();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ asset: [], ledger: [] });
  });

  it("holding neither capability is not an error: both lists empty", async () => {
    harness.setResolve(resolving([grant("inventory", "access")], "welld_ch"));
    const res = await getScope();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ asset: [], ledger: [] });
  });

  it("widest wins across two grants of one capability", async () => {
    harness.setResolve(
      resolving(
        [grant("asset", "manage", ENTITY), grant("asset", "manage")],
        "welld_ch",
      ),
    );
    expect(((await (await getScope()).json()) as ScopeBody).asset).toEqual([
      "welld_ch",
      "welld_it",
    ]);
  });

  it("is resolved once per (sub, perm_epoch): a second call is served from the cache", async () => {
    harness.setResolve(resolving([grant("asset", "manage")], "welld_ch"));
    const before = harness.resolveCallCount();
    await getScope();
    await getScope();
    expect(harness.resolveCallCount()).toBe(before + 1);
  });

  it("auth unreachable → 503 Problem JSON, not an empty scope", async () => {
    harness.setResolve(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const res = await getScope();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe(503);
    expect(body["title"]).toBe("Service Unavailable");
    expect(body).not.toHaveProperty("asset");
  });

  it("no token → 401 and auth is never asked", async () => {
    const before = harness.resolveCallCount();
    const res = await getScope(null);
    expect(res.status).toBe(401);
    expect(harness.resolveCallCount()).toBe(before);
  });

  it("a token that is not a JWT at all → 401", async () => {
    const res = await getScope("Bearer not.a.jwt");
    expect(res.status).toBe(401);
  });
});

describe("the assembled app (src/index.ts)", () => {
  it("serves /scope behind the guards while leaving /health open", async () => {
    harness.setResolve(resolving([grant("asset", "manage")], "welld_ch"));
    const { default: server } = await import("../index");

    const anonymous = await server.fetch(new Request("http://localhost/scope"));
    expect(anonymous.status).toBe(401);

    const authed = await server.fetch(
      new Request("http://localhost/scope", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(authed.status).toBe(200);
    expect(((await authed.json()) as ScopeBody).asset).toEqual(["welld_ch", "welld_it"]);

    const health = await server.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
  });
});
