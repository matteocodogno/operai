/**
 * Unit tests for the shared limits of the two /system endpoints (specs/20261111-push-notifications US-7,
 * ADR 20261112-system-endpoints-limited-per-verified-service): per-service allowances for verified credentials, ONE per-address
 * count for invalid ones shared by both endpoints, one byte-identical 429.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createSystemRateLimits } from "./systemRateLimits";

const T0 = 5_000_000;
const clock = (start = T0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("createSystemRateLimits — defaults and counting", () => {
  test("production defaults: 300 tokens / 600 lookups per service, 20 invalid per address, 10 min window", () => {
    const c = clock();
    const limits = createSystemRateLimits({ now: c.now });
    for (let i = 0; i < 300; i++) expect(limits.serviceToken.consume("system:a").allowed).toBe(true);
    expect(limits.serviceToken.consume("system:a").allowed).toBe(false);
    for (let i = 0; i < 600; i++) expect(limits.usersContact.consume("system:a").allowed).toBe(true);
    expect(limits.usersContact.consume("system:a").allowed).toBe(false);
    for (let i = 0; i < 300; i++) expect(limits.legalEntities.consume("system:a").allowed).toBe(true);
    expect(limits.legalEntities.consume("system:a").allowed).toBe(false);
    for (let i = 0; i < 20; i++) expect(limits.invalidCredentials.consume("direct").allowed).toBe(true);
    expect(limits.invalidCredentials.consume("direct").allowed).toBe(false);
    expect(limits.windowMs).toBe(600_000);
  });

  test("the legal-entities limiter is its own counter, per service, driven by the injected clock (specs/20261117-legal-entities AC-3.2)", () => {
    const c = clock();
    const limits = createSystemRateLimits({ now: c.now, config: { legalEntitiesLimit: 2, windowMs: 1000 } });
    expect(limits.legalEntities.consume("system:crm-api").allowed).toBe(true);
    expect(limits.legalEntities.consume("system:crm-api").allowed).toBe(true);
    expect(limits.legalEntities.consume("system:crm-api").allowed).toBe(false);
    expect(limits.legalEntities.consume("system:letterhead-api").allowed).toBe(true);
    // not shared with the other verified-service limiters
    expect(limits.usersContact.consume("system:crm-api").allowed).toBe(true);
    expect(limits.serviceToken.consume("system:crm-api").allowed).toBe(true);
    c.advance(1001);
    expect(limits.legalEntities.consume("system:crm-api").allowed).toBe(true);
  });

  test("services are independent of each other and of the invalid count", () => {
    const limits = createSystemRateLimits({ now: clock().now, config: { serviceTokenLimit: 2, invalidLimit: 2 } });
    limits.serviceToken.consume("system:a");
    limits.serviceToken.consume("system:a");
    expect(limits.serviceToken.consume("system:a").allowed).toBe(false);
    expect(limits.serviceToken.consume("system:b").allowed).toBe(true);
    expect(limits.invalidCredentials.consume("direct").allowed).toBe(true);
    expect(limits.usersContact.consume("system:a").allowed).toBe(true);
  });

  test("the invalid count is ONE counter for both endpoints (it is the same object)", () => {
    const limits = createSystemRateLimits({ now: clock().now, config: { invalidLimit: 2 } });
    expect(limits.invalidCredentials.consume("x").allowed).toBe(true);
    expect(limits.invalidCredentials.consume("x").allowed).toBe(true);
    expect(limits.invalidCredentials.consume("x").allowed).toBe(false);
  });

  test("the injected clock drives all three limiters: the window ends on its own; refusals do not extend it", () => {
    const c = clock();
    const limits = createSystemRateLimits({ now: c.now, config: { usersContactLimit: 1, windowMs: 1000 } });
    expect(limits.usersContact.consume("system:n").allowed).toBe(true);
    for (let i = 0; i < 10; i++) {
      c.advance(50);
      expect(limits.usersContact.consume("system:n").allowed).toBe(false);
    }
    c.advance(500); // 1000 ms after the first (only admitted) attempt
    expect(limits.usersContact.consume("system:n").allowed).toBe(true);
  });

  test("the invalid-credential map is capped at 50 000 keys", () => {
    const limits = createSystemRateLimits({ now: clock().now, config: { invalidLimit: 1 } });
    for (let i = 0; i < 50_000; i++) limits.invalidCredentials.consume(`ip-${i}`);
    // new addresses now share the overflow key (limit 1): the second new one is refused
    expect(limits.invalidCredentials.consume("fresh-1").allowed).toBe(true);
    expect(limits.invalidCredentials.consume("fresh-2").allowed).toBe(false);
    // an address already counted keeps its own count
    expect(limits.invalidCredentials.consume("ip-0").allowed).toBe(false);
  });
});

describe("tooManyRequests — the one 429", () => {
  const respond = async (limits: ReturnType<typeof createSystemRateLimits>, path: string) => {
    const app = new Hono();
    app.post("/system/service-token", (c) => limits.tooManyRequests(c));
    app.post("/system/users/contact", (c) => limits.tooManyRequests(c));
    return app.request(path, { method: "POST" });
  };

  test("status, Problem body with code, fixed Retry-After = window seconds, no-store", async () => {
    const res = await respond(createSystemRateLimits({ now: clock().now }), "/system/service-token");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("600");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      type: "https://httpstatuses.com/429",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many requests. Try again later.",
      instance: "/system/service-token",
      code: "rate_limited",
    });
  });

  test("Retry-After follows the configured window, rounded up", async () => {
    const res = await respond(
      createSystemRateLimits({ now: clock().now, config: { windowMs: 1500 } }),
      "/system/users/contact",
    );
    expect(res.headers.get("Retry-After")).toBe("2");
  });

  test("independent of limiter state: byte-identical whatever has been consumed", async () => {
    const c = clock();
    const limits = createSystemRateLimits({ now: c.now, config: { serviceTokenLimit: 1 } });
    const before = await respond(limits, "/system/service-token");
    limits.serviceToken.consume("system:a");
    c.advance(300_000);
    limits.serviceToken.consume("system:a");
    const after = await respond(limits, "/system/service-token");
    expect(await after.text()).toBe(await before.text());
    expect([...after.headers].filter(([k]) => k !== "date")).toEqual(
      [...before.headers].filter(([k]) => k !== "date"),
    );
  });
});

describe("logRefusal — bounded logging, no identities beyond a verified sub", () => {
  test("one line per key per window; the invalid line carries no key", () => {
    const c = clock();
    const limits = createSystemRateLimits({ now: c.now, config: { windowMs: 1000 } });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) limits.logRefusal("invalid", "service-token", "203.0.113.9");
      limits.logRefusal("invalid", "service-token", "203.0.113.10");
      for (let i = 0; i < 5; i++) limits.logRefusal("allowance", "users/contact", "system:notify-api");
      expect(warn).toHaveBeenCalledTimes(3);
      const lines = warn.mock.calls.map((a) => String(a[0]));
      expect(lines[0]).toBe("[system/service-token] invalid-credential limit reached");
      expect(lines.join("\n")).not.toContain("203.0.113");
      expect(lines[2]).toBe("[system/users/contact] allowance exhausted caller=system:notify-api");
      c.advance(1000);
      limits.logRefusal("invalid", "service-token", "203.0.113.9");
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });
});
