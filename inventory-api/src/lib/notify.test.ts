/**
 * Assignment notifications (T17, specs/015-hardware-inventory; AC-2.8, AC-2.9;
 * ADR-0044). Two layers over a stubbed network (`auth` token endpoint and
 * `notify-api`):
 *   - the notifier itself, with an injected `fetch` and token provider;
 *   - the REAL assignments and /me routers, real Postgres, with the notifier
 *     installed on the after-commit seam.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";
import { truncateInventoryTables } from "../test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { db } = await import("./db");
const { handleProblemError } = await import("./problem");
const { createNotifier, notifier: wired } = await import("./notify");
const { createServiceTokenProvider } = await import("./serviceToken");
const { assignmentsRouter, assignmentHooks } = await import("../assignments/assignments.routes");
const { meRouter } = await import("../me/me.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("./identities");

const NOTIFY = "http://notify.test";
const AUTH = "http://auth.test";
const SECRET = "client-secret-that-must-not-leak-0123456789abcdef";

// ─── A scriptable network ────────────────────────────────────────────────────

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
  init: RequestInit;
}
let tokenSeq = 0;
let notifySent: Sent[] = [];
let tokenSent: Sent[] = [];
let onNotify: (n: number, sent: Sent) => Promise<Response> | Response;
let onToken: (n: number) => Promise<Response> | Response;

const record = (url: string, init?: RequestInit): Sent => ({
  url,
  headers: Object.fromEntries(new Headers(init?.headers).entries()),
  body: init?.body ? JSON.parse(String(init.body)) : undefined,
  init: init ?? {},
});

/** Routes by URL; anything else (auth identities) answers every id as an active user. */
const network = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  if (u === `${AUTH}/system/service-token`) {
    const sent = record(u, init);
    tokenSent.push(sent);
    return onToken(tokenSent.length);
  }
  if (u === `${NOTIFY}/system/notifications`) {
    const sent = record(u, init);
    notifySent.push(sent);
    return onNotify(notifySent.length, sent);
  }
  const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
  return Response.json({ users: ids.map((id) => ({ id, status: "active", name: `Name of ${id}` })) });
}) as unknown as typeof fetch;

const okNotify = () => Response.json({ id: "n1" }, { status: 201 });
const freshToken = () => Response.json({ token: `svc-token-${++tokenSeq}`, expiresInSeconds: 300 });

let clock = 5_000_000;
function build(over: { enabled?: boolean } = {}) {
  const tokens = createServiceTokenProvider({
    baseUrl: AUTH,
    clientId: "inventory-api",
    clientSecret: SECRET,
    now: () => clock,
  });
  return {
    tokens,
    notifier: createNotifier({ baseUrl: NOTIFY, tokens, ...over }),
  };
}

const event = (over: Record<string, unknown> = {}) => ({
  kind: "created" as const,
  assignmentId: "asg-1",
  assetId: "asset-1",
  assetDescription: "MacBook Pro 14",
  assigneeUserId: "emp-1",
  createdByUserId: "mgr-1",
  ...over,
});

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let logSpies: ReturnType<typeof spyOn>[];
const logged = () => JSON.stringify(logSpies.map((s) => s.mock.calls));

beforeEach(async () => {
  tokenSeq = 0;
  notifySent = [];
  tokenSent = [];
  clock = 5_000_000;
  onNotify = okNotify;
  onToken = freshToken;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(network);
  logSpies = [spyOn(console, "error"), spyOn(console, "warn"), spyOn(console, "log")];
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
});
afterEach(() => {
  fetchSpy.mockRestore();
  for (const s of logSpies) s.mockRestore();
});
afterAll(async () => {
  await truncateInventoryTables();
});

// ─── The notifier ────────────────────────────────────────────────────────────

describe("createNotifier: what is sent, to whom", () => {
  it("created: tells the assignee, linking to /devices, with the service token as Bearer", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event());
    expect(notifySent).toHaveLength(1);
    const sent = notifySent[0]!;
    expect(sent.headers["authorization"]).toBe("Bearer svc-token-1");
    expect(sent.headers["x-internal-token"]).toBeUndefined();
    expect(sent.init.signal).toBeInstanceOf(AbortSignal);
    expect(sent.init.redirect).toBe("error");
    expect(sent.body).toEqual({
      recipientId: "emp-1",
      originApp: "inventory",
      severity: "info",
      title: "A device is waiting for your confirmation",
      body: "MacBook Pro 14 has been assigned to you. Confirm that you received it.",
      link: { href: "/devices" },
    });
  });

  it("confirmed: tells the creating manager, by name, linking to the asset", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event({ kind: "confirmed", assigneeName: "Ada Lovelace" }));
    expect(notifySent[0]!.body).toEqual({
      recipientId: "mgr-1",
      originApp: "inventory",
      severity: "success",
      title: "Assignment confirmed",
      body: "Ada Lovelace confirmed receipt of MacBook Pro 14.",
      link: { href: "/inventory/assets/asset-1" },
    });
  });

  it("declined: tells the creating manager the device is back in stock", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event({ kind: "declined", assigneeName: "Ada Lovelace" }));
    expect(notifySent[0]!.body).toMatchObject({
      recipientId: "mgr-1",
      severity: "warning",
      title: "Assignment declined",
      body: "Ada Lovelace declined MacBook Pro 14. It is back in stock.",
      link: { href: "/inventory/assets/asset-1" },
    });
  });

  it("without a known name the copy says 'The employee'", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event({ kind: "confirmed" }));
    expect(notifySent[0]!.body.body).toBe("The employee confirmed receipt of MacBook Pro 14.");
  });

  it("keeps a very long description within notify-api's limits", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event({ assetDescription: "x".repeat(5000) }));
    const { title, body } = notifySent[0]!.body;
    expect(title.length).toBeLessThanOrEqual(200);
    expect(body.length).toBeLessThanOrEqual(2000);
  });

  it("an asset id is path-encoded into the link", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event({ kind: "declined", assetId: "a/b?c" }));
    expect(notifySent[0]!.body.link.href).toBe("/inventory/assets/a%2Fb%3Fc");
  });

  it("carries no money figure", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event({ kind: "confirmed", assigneeName: "Ada" }));
    expect(JSON.stringify(notifySent[0]!.body)).not.toMatch(/CHF|EUR|cents|price|\d{3,}/i);
  });

  it("a disabled notifier makes no call at all", async () => {
    const { notifier } = build({ enabled: false });
    await notifier.notifyAssignment(event());
    expect(tokenSent).toHaveLength(0);
    expect(notifySent).toHaveLength(0);
  });
});

describe("createNotifier: the token", () => {
  it("is reused within its lifetime and refetched after expiry", async () => {
    const { notifier } = build();
    await notifier.notifyAssignment(event());
    await notifier.notifyAssignment(event());
    expect(tokenSent).toHaveLength(1);
    expect(notifySent.map((s) => s.headers["authorization"])).toEqual([
      "Bearer svc-token-1",
      "Bearer svc-token-1",
    ]);
    clock += 241_000; // inside the 60 s margin
    await notifier.notifyAssignment(event());
    expect(tokenSent).toHaveLength(2);
    expect(notifySent[2]!.headers["authorization"]).toBe("Bearer svc-token-2");
  });

  it("a burst shares one exchange", async () => {
    const { notifier } = build();
    await Promise.all([1, 2, 3, 4].map(() => notifier.notifyAssignment(event())));
    expect(tokenSent).toHaveLength(1);
    expect(notifySent).toHaveLength(4);
  });

  it("a 401 from notify drops the token and retries ONCE with a new one", async () => {
    onNotify = (n) => (n === 1 ? new Response("{}", { status: 401 }) : okNotify());
    const { notifier } = build();
    await notifier.notifyAssignment(event());
    expect(tokenSent).toHaveLength(2);
    expect(notifySent.map((s) => s.headers["authorization"])).toEqual([
      "Bearer svc-token-1",
      "Bearer svc-token-2",
    ]);
  });

  it("a second 401 is not retried again, and is swallowed", async () => {
    onNotify = () => new Response("{}", { status: 401 });
    const { notifier } = build();
    await notifier.notifyAssignment(event());
    expect(notifySent).toHaveLength(2);
    expect(tokenSent).toHaveLength(2);
  });
});

describe("createNotifier: strictly best-effort", () => {
  it("never throws and never retries on a notify-api 500", async () => {
    onNotify = () => new Response("boom", { status: 500 });
    const { notifier } = build();
    await expect(notifier.notifyAssignment(event())).resolves.toBeUndefined();
    expect(notifySent).toHaveLength(1);
    expect(logged()).toContain("500");
  });

  it("never throws on a network error to notify-api", async () => {
    onNotify = () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const { notifier } = build();
    await expect(notifier.notifyAssignment(event())).resolves.toBeUndefined();
  });

  it("never throws, and sends nothing, when auth cannot give a token", async () => {
    for (const impl of [
      () => new Response("{}", { status: 401 }),
      () => new Response("{}", { status: 503 }),
      () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    ]) {
      onToken = impl;
      const { notifier } = build();
      await expect(notifier.notifyAssignment(event())).resolves.toBeUndefined();
    }
    expect(notifySent).toHaveLength(0);
  });

  it("neither a token nor the secret appears in any log line, on any failure path", async () => {
    onNotify = () => new Response(`echo ${SECRET} Bearer svc-token-1`, { status: 500 });
    const a = build();
    await a.notifier.notifyAssignment(event());
    onNotify = () => new Response("{}", { status: 401 });
    const b = build();
    await b.notifier.notifyAssignment(event());
    onToken = () => new Response(`echo ${SECRET}`, { status: 500 });
    const c = build();
    await c.notifier.notifyAssignment(event());
    expect(logged()).not.toContain(SECRET);
    expect(logged()).not.toContain("svc-token");
    expect(logged().length).toBeGreaterThan(5); // it did log the failures
  });
});

// ─── Through the real routes ─────────────────────────────────────────────────

const grant = (resource: string, action: string): ResolvedPermission => ({
  resource,
  action,
  conditions: { attributes: [{ key: "entity", match: "user" }] },
});
const app = new OpenAPIHono();
app.route("/", assignmentsRouter);
app.route("/", meRouter);
app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.json({ error: String(err) }, 500));

let mgr: string;
let emp: string;
beforeAll(async () => {
  mgr = await harness.signToken({ sub: "mgr-1", email: "mgr1@welld.ch", permEpoch: 1 });
  emp = await harness.signToken({ sub: "emp-1", email: "emp1@welld.ch", name: "Ada Lovelace", permEpoch: 1 });
});

let installed: ReturnType<typeof build>;
let original: typeof assignmentHooks.afterCommit;
beforeEach(() => {
  harness.setResolve(async () => ({
    sub: "mgr-1",
    epoch: 1,
    permissions: [grant("asset", "manage")],
    entity: "welld_ch",
    jobTitle: null,
  }));
  installed = build();
  original = assignmentHooks.afterCommit;
  assignmentHooks.afterCommit = (e) => installed.notifier.notifyAssignment(e);
});
afterEach(() => {
  assignmentHooks.afterCommit = original;
});

const post = (path: string, bearer: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const seedAsset = () =>
  db.asset.create({
    data: {
      entity: "welld_ch",
      currency: "CHF",
      category: "laptop",
      description: "Thinkpad X1",
      purchaseDate: new Date("2026-03-01"),
      purchasePriceCents: 99815,
      status: "in_stock",
      createdByUserId: "seed",
    } as never,
  });
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe("the seam", () => {
  it("the default after-commit hook is the notifier, and that instance is inert under NODE_ENV=test", async () => {
    const spy = spyOn(wired, "notifyAssignment");
    try {
      await original(event());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(tokenSent).toHaveLength(0); // disabled: a test process never pushes for real
    expect(notifySent).toHaveLength(0);
  });
});

describe("through the routes", () => {
  it("assigning notifies the assignee, and only after the assignment has committed", async () => {
    const a = await seedAsset();
    let committed: string | undefined;
    onNotify = async () => {
      committed = (await db.assignment.findFirst({ where: { assetId: a.id } }))?.status;
      return okNotify();
    };
    const res = await post(`/assets/${a.id}/assignments`, mgr, { assigneeUserId: "emp-1" });
    expect(res.status).toBe(201);
    await until(() => notifySent.length === 1);
    expect(committed).toBe("pending");
    expect(notifySent[0]!.body).toMatchObject({ recipientId: "emp-1", link: { href: "/devices" } });
  });

  it("the response does not wait for notify-api", async () => {
    const a = await seedAsset();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onNotify = async () => {
      await gate;
      return okNotify();
    };
    const started = Date.now();
    const res = await post(`/assets/${a.id}/assignments`, mgr, { assigneeUserId: "emp-1" });
    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(2000);
    release();
    await until(() => notifySent.length === 1);
  });

  it("notify-api 500 and a network error leave the assignment committed and the route 2xx", async () => {
    for (const impl of [
      () => new Response("boom", { status: 500 }),
      () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    ]) {
      onNotify = impl;
      const a = await seedAsset();
      const before = notifySent.length;
      const res = await post(`/assets/${a.id}/assignments`, mgr, { assigneeUserId: "emp-1" });
      expect(res.status).toBe(201);
      await until(() => notifySent.length === before + 1);
      expect(await db.assignment.count({ where: { assetId: a.id, status: "pending" } })).toBe(1);
    }
  });

  it("auth being down leaves the assignment committed and the route 2xx", async () => {
    onToken = () => new Response("{}", { status: 503 });
    const a = await seedAsset();
    const res = await post(`/assets/${a.id}/assignments`, mgr, { assigneeUserId: "emp-1" });
    expect(res.status).toBe(201);
    await until(() => tokenSent.length === 1);
    expect(notifySent).toHaveLength(0);
    expect(await db.assignment.count({ where: { assetId: a.id, status: "pending" } })).toBe(1);
  });

  it("confirm and decline notify the creating manager with the outcome and the employee's name", async () => {
    const a = await seedAsset();
    const b = await seedAsset();
    const p = await db.assignment.create({ data: { assetId: a.id, assigneeUserId: "emp-1", createdByUserId: "mgr-1" } });
    const q = await db.assignment.create({ data: { assetId: b.id, assigneeUserId: "emp-1", createdByUserId: "mgr-2" } });
    expect((await post(`/me/assignments/${p.id}/confirm`, emp)).status).toBe(200);
    expect((await post(`/me/assignments/${q.id}/decline`, emp)).status).toBe(204);
    await until(() => notifySent.length === 2);
    const bodies = notifySent.map((s) => s.body).sort((x, y) => x.recipientId.localeCompare(y.recipientId));
    expect(bodies[0]).toMatchObject({
      recipientId: "mgr-1",
      title: "Assignment confirmed",
      body: "Ada Lovelace confirmed receipt of Thinkpad X1.",
      link: { href: `/inventory/assets/${a.id}` },
    });
    expect(bodies[1]).toMatchObject({
      recipientId: "mgr-2",
      title: "Assignment declined",
      link: { href: `/inventory/assets/${b.id}` },
    });
  });

  it("a refused answer (someone else's assignment, already answered) notifies nobody", async () => {
    const a = await seedAsset();
    const p = await db.assignment.create({ data: { assetId: a.id, assigneeUserId: "emp-2", createdByUserId: "mgr-1" } });
    expect((await post(`/me/assignments/${p.id}/confirm`, emp)).status).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(tokenSent).toHaveLength(0);
    expect(notifySent).toHaveLength(0);
  });

  it("a notify-api failure on confirm leaves the confirmation committed", async () => {
    onNotify = () => new Response("boom", { status: 500 });
    const a = await seedAsset();
    const p = await db.assignment.create({ data: { assetId: a.id, assigneeUserId: "emp-1", createdByUserId: "mgr-1" } });
    expect((await post(`/me/assignments/${p.id}/confirm`, emp)).status).toBe(200);
    await until(() => notifySent.length === 1);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("confirmed");
  });
});
