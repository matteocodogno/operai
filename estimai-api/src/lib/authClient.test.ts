/**
 * Unit tests for the `auth` outbound client (T5, specs/013-estimate-sharing).
 *
 * This module IS the network boundary being tested (unlike a route test that
 * would `mock.module()` this file), so global `fetch` is mocked directly —
 * same strategy as `refund-api/src/lib/notify.test.ts`.
 *
 * Done-when coverage (tasks.md T5)
 * ─────────────────────────────────
 * - the identity cache serves a second call without a second fetch
 * - the identity cache expires at 60s (simulated clock, mirrors
 *   refund-api/src/auth/authz.middleware.test.ts's Date.now spy pattern)
 * - a fail-soft test: a throwing/rejecting `resolveIdentities` fetch still
 *   yields `status:"unknown"` rather than propagating an error
 * - a fail-closed test: a throwing/rejecting `checkAppAccess` fetch surfaces
 *   as a thrown error (the caller, T8, is responsible for mapping that to a
 *   503 — asserting the throw itself is this module's contract)
 */

import { describe, it, expect, afterEach, spyOn } from "bun:test";

process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] =
  "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";

const { checkAppAccess, resolveIdentities, __resetIdentityCacheForTests } =
  await import("./authClient");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetIdentityCacheForTests();
});

const AUTH_HEADER = "Bearer test-jwt";

describe("checkAppAccess", () => {
  it("POSTs to /authz/app-access-check forwarding the caller's Authorization header verbatim", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ eligible: true, userId: "target-user" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await checkAppAccess(
      AUTH_HEADER,
      "estimai",
      "colleague@example.com",
    );

    expect(capturedUrl).toBe("http://localhost:3001/authz/app-access-check");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(AUTH_HEADER);
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string) as {
      appId: string;
      email: string;
    };
    expect(body).toEqual({ appId: "estimai", email: "colleague@example.com" });
    expect(result).toEqual({ eligible: true, userId: "target-user" });
  });

  it("resolves the byte-identical negative body ({eligible:false}) unchanged", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ eligible: false }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await checkAppAccess(AUTH_HEADER, "estimai", "nobody@example.com");
    expect(result).toEqual({ eligible: false });
  });

  it("FAIL-CLOSED: throws on a non-2xx response (caller must map to 503)", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    await expect(
      checkAppAccess(AUTH_HEADER, "estimai", "someone@example.com"),
    ).rejects.toThrow();
  });

  it("FAIL-CLOSED: throws on a network failure (caller must map to 503, never a silent allow)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(
      checkAppAccess(AUTH_HEADER, "estimai", "someone@example.com"),
    ).rejects.toThrow("connection refused");
  });
});

describe("resolveIdentities", () => {
  it("POSTs ids only, forwarding the caller's Authorization header verbatim", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          users: [{ id: "user-1", status: "active", name: "Marco Rossi" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await resolveIdentities(AUTH_HEADER, ["user-1"]);

    expect(capturedUrl).toBe("http://localhost:3001/authz/users/identities");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(AUTH_HEADER);
    const body = JSON.parse(capturedInit?.body as string) as { ids: string[] };
    expect(body).toEqual({ ids: ["user-1"] });
    expect(result.get("user-1")).toEqual({
      id: "user-1",
      status: "active",
      name: "Marco Rossi",
    });
  });

  it("serves a second call for the SAME id from cache without a second fetch", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          users: [{ id: "user-1", status: "active", name: "Marco Rossi" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await resolveIdentities(AUTH_HEADER, ["user-1"]);
    expect(fetchCallCount).toBe(1);

    const second = await resolveIdentities(AUTH_HEADER, ["user-1"]);
    expect(fetchCallCount).toBe(1); // no second network call
    expect(second.get("user-1")).toEqual({
      id: "user-1",
      status: "active",
      name: "Marco Rossi",
    });
  });

  it("only fetches the uncached subset when mixing a cached id with a new one", async () => {
    let lastRequestedIds: string[] = [];
    let fetchCallCount = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      fetchCallCount++;
      const body = JSON.parse(init?.body as string) as { ids: string[] };
      lastRequestedIds = body.ids;
      return new Response(
        JSON.stringify({
          users: body.ids.map((id) => ({
            id,
            status: "active",
            name: `Name-${id}`,
          })),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await resolveIdentities(AUTH_HEADER, ["user-1"]);
    expect(fetchCallCount).toBe(1);

    const result = await resolveIdentities(AUTH_HEADER, ["user-1", "user-2"]);
    expect(fetchCallCount).toBe(2);
    expect(lastRequestedIds).toEqual(["user-2"]); // only the uncached one
    expect(result.get("user-1")?.name).toBe("Name-user-1");
    expect(result.get("user-2")?.name).toBe("Name-user-2");
  });

  it("the cache entry expires at 60s (simulated clock)", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          users: [{ id: "user-1", status: "active", name: "Marco Rossi" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const realNow = Date.now;
    try {
      let simulatedNow = realNow();
      const nowSpy = spyOn(Date, "now").mockImplementation(() => simulatedNow);

      await resolveIdentities(AUTH_HEADER, ["user-1"]);
      expect(fetchCallCount).toBe(1);

      // Still within the 60s TTL — served from cache.
      simulatedNow += 59_000;
      await resolveIdentities(AUTH_HEADER, ["user-1"]);
      expect(fetchCallCount).toBe(1);

      // Past the 60s TTL — must re-fetch.
      simulatedNow += 2_000;
      await resolveIdentities(AUTH_HEADER, ["user-1"]);
      expect(fetchCallCount).toBe(2);

      nowSpy.mockRestore();
    } finally {
      expect(Date.now).toBe(realNow);
    }
  });

  it("FAIL-SOFT: a throwing fetch degrades every requested id to status:'unknown' rather than throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await resolveIdentities(AUTH_HEADER, ["user-1", "user-2"]);

    expect(result.get("user-1")).toEqual({
      id: "user-1",
      status: "unknown",
      name: null,
    });
    expect(result.get("user-2")).toEqual({
      id: "user-2",
      status: "unknown",
      name: null,
    });
  });

  it("FAIL-SOFT: a non-2xx response degrades to status:'unknown' rather than throwing", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await resolveIdentities(AUTH_HEADER, ["user-1"]);
    expect(result.get("user-1")).toEqual({
      id: "user-1",
      status: "unknown",
      name: null,
    });
  });

  it("an id auth silently omits from its response also degrades to status:'unknown'", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ users: [] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await resolveIdentities(AUTH_HEADER, ["user-ghost"]);
    expect(result.get("user-ghost")).toEqual({
      id: "user-ghost",
      status: "unknown",
      name: null,
    });
  });

  describe("chunking (>100 ids, auth's MAX_IDS cap)", () => {
    it("splits more than 100 uncached ids into multiple requests of at most 100 ids each, and resolves all of them", async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `user-${i}`);
      const requestedBatches: string[][] = [];

      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { ids: string[] };
        requestedBatches.push(body.ids);
        return new Response(
          JSON.stringify({
            users: body.ids.map((id) => ({
              id,
              status: "active",
              name: `Name-${id}`,
            })),
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const result = await resolveIdentities(AUTH_HEADER, ids);

      // 250 ids at a cap of 100/request => 3 requests (100, 100, 50), never
      // one request carrying all 250 (that's exactly what auth 400s on).
      expect(requestedBatches.length).toBe(3);
      for (const batch of requestedBatches) {
        expect(batch.length).toBeLessThanOrEqual(100);
      }
      expect(
        requestedBatches.reduce((sum, batch) => sum + batch.length, 0),
      ).toBe(250);

      // Every id resolved — none silently dropped or left unresolved.
      expect(result.size).toBe(250);
      for (const id of ids) {
        expect(result.get(id)).toEqual({
          id,
          status: "active",
          name: `Name-${id}`,
        });
      }
    });

    it("issues chunk requests sequentially, not concurrently (paces against auth's per-caller rate limit)", async () => {
      const ids = Array.from({ length: 201 }, (_, i) => `user-${i}`);
      let inFlight = 0;
      let maxConcurrent = 0;
      const callOrder: number[] = [];

      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        const body = JSON.parse(init?.body as string) as { ids: string[] };
        callOrder.push(body.ids.length);
        // Yield to the event loop so a concurrent (Promise.all-style) caller
        // would have a chance to start a second fetch before this resolves.
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight--;
        return new Response(
          JSON.stringify({
            users: body.ids.map((id) => ({
              id,
              status: "active",
              name: `Name-${id}`,
            })),
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      await resolveIdentities(AUTH_HEADER, ids);

      expect(maxConcurrent).toBe(1);
      expect(callOrder).toEqual([100, 100, 1]);
    });

    it("a single failing batch degrades ONLY its own ids to status:'unknown' — ids in batches that succeeded still resolve", async () => {
      // 3 batches: [0..99] succeeds, [100..199] fails, [200..204] succeeds.
      const batch1 = Array.from({ length: 100 }, (_, i) => `user-${i}`);
      const batch2 = Array.from({ length: 100 }, (_, i) => `user-${100 + i}`);
      const batch3 = Array.from({ length: 5 }, (_, i) => `user-${200 + i}`);
      const ids = [...batch1, ...batch2, ...batch3];

      let callCount = 0;
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        callCount++;
        const body = JSON.parse(init?.body as string) as { ids: string[] };
        if (callCount === 2) {
          // The second batch's request fails outright.
          throw new Error("connection refused");
        }
        return new Response(
          JSON.stringify({
            users: body.ids.map((id) => ({
              id,
              status: "active",
              name: `Name-${id}`,
            })),
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const result = await resolveIdentities(AUTH_HEADER, ids);

      expect(callCount).toBe(3);
      expect(result.size).toBe(205);

      for (const id of batch1) {
        expect(result.get(id)).toEqual({
          id,
          status: "active",
          name: `Name-${id}`,
        });
      }
      for (const id of batch2) {
        expect(result.get(id)).toEqual({ id, status: "unknown", name: null });
      }
      for (const id of batch3) {
        expect(result.get(id)).toEqual({
          id,
          status: "active",
          name: `Name-${id}`,
        });
      }
    });

    it("never throws even when a middle batch's response is a non-2xx", async () => {
      const batch1 = Array.from({ length: 100 }, (_, i) => `user-${i}`);
      const batch2 = Array.from({ length: 50 }, (_, i) => `user-${100 + i}`);
      const ids = [...batch1, ...batch2];

      let callCount = 0;
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 2) {
          return new Response("bad request", { status: 400 });
        }
        const body = JSON.parse(init?.body as string) as { ids: string[] };
        return new Response(
          JSON.stringify({
            users: body.ids.map((id) => ({
              id,
              status: "active",
              name: `Name-${id}`,
            })),
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const result = await resolveIdentities(AUTH_HEADER, ids);

      expect(callCount).toBe(2);
      for (const id of batch1) {
        expect(result.get(id)?.status).toBe("active");
      }
      for (const id of batch2) {
        expect(result.get(id)).toEqual({ id, status: "unknown", name: null });
      }
    });
  });
});
