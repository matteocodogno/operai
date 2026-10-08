/**
 * `fetchAuthzResolve` (T7, specs/015-hardware-inventory; ADR-0014 point 4):
 * every way `auth` can misbehave must END IN A THROW, which authzMiddleware
 * turns into the fail-closed 503 — never into an empty or partial permission
 * set that a handler would then crash on or, worse, read as "no restrictions".
 */

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import "../test-support/testAuth";

// Own registry entry: other test files mock.module() "./resolveClient".
const REAL_MODULE = "./resolveClient.ts?real"; // a variable keeps tsc from resolving the query
const { fetchAuthzResolve } = (await import(REAL_MODULE)) as typeof import("./resolveClient");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const respondWith = (response: Response) => {
  const spy = spyOn(globalThis, "fetch").mockResolvedValue(response);
  return spy;
};

describe("fetchAuthzResolve", () => {
  it("forwards the caller's Authorization header verbatim to GET /authz/resolve", async () => {
    const spy = respondWith(
      Response.json({ sub: "u", epoch: 3, permissions: [], entity: null, jobTitle: null }),
    );
    await fetchAuthzResolve("Bearer abc.def.ghi");
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/authz/resolve");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer abc.def.ghi",
    );
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the parsed permission set on 200", async () => {
    respondWith(
      Response.json({
        sub: "u",
        epoch: 3,
        permissions: [{ resource: "asset", action: "manage", conditions: null }],
        entity: "welld_ch",
        jobTitle: null,
      }),
    );
    const result = await fetchAuthzResolve("Bearer x");
    expect(result.entity).toBe("welld_ch");
    expect(result.permissions).toHaveLength(1);
  });

  it("a non-2xx answer throws", async () => {
    respondWith(new Response("nope", { status: 401 }));
    await expect(fetchAuthzResolve("Bearer x")).rejects.toThrow(/HTTP 401/);
    respondWith(new Response("boom", { status: 500 }));
    await expect(fetchAuthzResolve("Bearer x")).rejects.toThrow(/HTTP 500/);
  });

  it("a network failure throws", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(fetchAuthzResolve("Bearer x")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("a 200 whose body is not a permission set throws instead of yielding a half-object", async () => {
    for (const body of [
      {},
      { permissions: "all", entity: null },
      { permissions: [] }, // no entity member at all
      { permissions: [], entity: 5 },
      null,
    ]) {
      respondWith(Response.json(body));
      await expect(fetchAuthzResolve("Bearer x")).rejects.toThrow(/unrecognised body/);
    }
  });

  it("a 200 that is not JSON throws", async () => {
    respondWith(new Response("<html>gateway</html>", { status: 200 }));
    await expect(fetchAuthzResolve("Bearer x")).rejects.toThrow();
  });
});
