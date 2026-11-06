import { beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolveResponse } from "../authz/resolveClient";

const harness = setupTestAuth();
await harness.init();

const { selfScoped, capability, eraser, holds, MEETINGS_ACCESS, TEMPLATE_MANAGE, MEETING_ERASE } = await import("./guards");
const { __resetAuthzCacheForTests } = await import("./authz.middleware");

const resolved = (...grants: [string, string][]): ResolveResponse => ({
  sub: "user-1",
  epoch: 0,
  permissions: grants.map(([resource, action]) => ({ resource, action, conditions: null })),
  entity: null,
  jobTitle: null,
});

// A tiny app that exposes what each stack decided.
const app = new Hono();
app.use("/self", ...selfScoped);
app.get("/self", (c) =>
  c.json({
    userId: c.get("userId" as never),
    capabilities: c.get("capabilities" as never),
    access: holds(c as never, MEETINGS_ACCESS),
    manage: holds(c as never, TEMPLATE_MANAGE),
  }),
);
app.use("/needs-access", ...capability(MEETINGS_ACCESS));
app.get("/needs-access", (c) => c.json({ ok: true }));
app.use("/needs-manage-or-erase", ...capability(TEMPLATE_MANAGE, MEETING_ERASE));
app.get("/needs-manage-or-erase", (c) => c.json({ ok: true }));
app.use("/erase", ...eraser);
app.get("/erase", (c) => c.json({ ok: true }));

let token: string;
const get = (path: string, withToken = true) =>
  app.request(path, { headers: withToken ? { Authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(async () => {
  __resetAuthzCacheForTests();
  token = await harness.signToken({ sub: "user-1", email: "u1@x.com", permEpoch: 1 });
  harness.setResolve(async () => resolved(["meetings", "access"]));
});

describe("every stack needs a valid token", () => {
  for (const path of ["/self", "/needs-access", "/erase"]) {
    it(`${path}: 401 without one`, async () => {
      expect((await get(path, false)).status).toBe(401);
    });
  }

  it("401 for a token that does not verify", async () => {
    const res = await app.request("/self", { headers: { Authorization: "Bearer not.a.jwt" } });
    expect(res.status).toBe(401);
  });
});

describe("selfScoped (AC-10.6)", () => {
  it("passes with the permissions auth resolved", async () => {
    const body = (await (await get("/self")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ userId: "user-1", capabilities: "resolved", access: true, manage: false });
  });

  it("with auth down still lets the request through, capabilities unavailable, nothing held", async () => {
    harness.setResolve(async () => {
      throw new Error("auth GET /authz/resolve responded with HTTP 503");
    });
    const res = await get("/self");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ capabilities: "unavailable", access: false, manage: false });
  });

  it("never grants from a stale answer once auth is down and the cache has lapsed", async () => {
    // a different (sub, epoch) than the cached one: no cache hit to fall back on
    harness.setResolve(async () => {
      throw new Error("down");
    });
    const other = await harness.signToken({ sub: "user-2", email: "u2@x.com", permEpoch: 9 });
    const res = await app.request("/self", { headers: { Authorization: `Bearer ${other}` } });
    expect(await res.json()).toMatchObject({ capabilities: "unavailable", access: false });
  });
});

describe("capability(...) (fail closed)", () => {
  it("200 when the permission is held", async () => {
    expect((await get("/needs-access")).status).toBe(200);
  });

  it("403 when auth answered and the permission is absent", async () => {
    harness.setResolve(async () => resolved());
    const res = await get("/needs-access");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { status: number }).status).toBe(403);
  });

  it("503 when auth is down", async () => {
    harness.setResolve(async () => {
      throw new Error("auth GET /authz/resolve responded with HTTP 503");
    });
    const res = await get("/needs-access");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("authorization_unavailable");
  });

  it("accepts any one of several permissions", async () => {
    harness.setResolve(async () => resolved(["template", "manage"]));
    expect((await get("/needs-manage-or-erase")).status).toBe(200);
    harness.setResolve(async () => resolved(["meetings", "access"]));
    __resetAuthzCacheForTests();
    expect((await get("/needs-manage-or-erase")).status).toBe(403);
  });
});

describe("eraser", () => {
  it("needs meeting:erase: tool access alone is a 403", async () => {
    expect((await get("/erase")).status).toBe(403);
  });

  it("200 with meeting:erase", async () => {
    harness.setResolve(async () => resolved(["meeting", "erase"]));
    expect((await get("/erase")).status).toBe(200);
  });

  it("503 when auth is down", async () => {
    harness.setResolve(async () => {
      throw new Error("down");
    });
    expect((await get("/erase")).status).toBe(503);
  });
});

describe("the live resolve is cached per (sub, perm_epoch) for a short time", () => {
  it("asks auth once for repeated requests of the same token", async () => {
    const before = harness.resolveCallCount();
    await get("/needs-access");
    await get("/needs-access");
    expect(harness.resolveCallCount() - before).toBe(1);
  });

  it("a new perm_epoch is a cache miss: revocation is immediate", async () => {
    await get("/needs-access");
    harness.setResolve(async () => resolved());
    const bumped = await harness.signToken({ sub: "user-1", email: "u1@x.com", permEpoch: 2 });
    const res = await app.request("/needs-access", { headers: { Authorization: `Bearer ${bumped}` } });
    expect(res.status).toBe(403);
  });
});
