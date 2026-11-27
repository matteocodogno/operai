/**
 * The request body is bounded before anything reads it (security review A04/A05, specs/20261126-teams follow-up). `rejectNul` decodes
 * a whole JSON body to look for U+0000 on every route, authenticated or not, and Bun's own default ceiling is ~128 MiB, so without
 * a limit in front of it an anonymous caller could make the identity service hold a few copies of that. Two layers here: the middleware
 * on its own (a stream that must never be pulled), and the whole app (a limit before authentication, the legitimate bodies still through).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { db } from "./db";
import { MAX_REQUEST_BODY_BYTES, requestBodyLimit } from "./bodyLimit";
import { rejectNul } from "./nul";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;
const betterAuthHandler = mock(async () => new Response("{}"));
mock.module("../auth/auth.config", () => ({
  auth: { handler: betterAuthHandler, api: { getSession: mock(async () => currentSession) } },
  // The dev-only test-auth router (mounted when ENABLE_TEST_AUTH is on) imports this one.
  applyLivePendingInvitationOnUserCreate: async () => {},
}));
const { app } = await import("../index");
const { ACCOUNTING_CATALOG } = await import("../authz/catalogs/accounting");
const { ADMIN_CATALOG } = await import("../authz/catalogs/admin");
const { CRM_CATALOG } = await import("../authz/catalogs/crm");
const { ESTIMAI_CATALOG } = await import("../authz/catalogs/estimai");
const { HOURS_CATALOG } = await import("../authz/catalogs/hours");
const { INVENTORY_CATALOG } = await import("../authz/catalogs/inventory");
const { LETTERHEADS_CATALOG } = await import("../authz/catalogs/letterheads");
const { MEETINGS_CATALOG } = await import("../authz/catalogs/meetings");
const { PROJECTS_CATALOG } = await import("../authz/catalogs/projects");
const { REFUND_CATALOG } = await import("../authz/catalogs/refund");

const RUN = crypto.randomUUID().slice(0, 8);
const OVER = MAX_REQUEST_BODY_BYTES + 1024;
let adminId = "";

beforeAll(async () => {
  const admin = await db.user.create({ data: { name: "limit admin", email: `limit-${RUN}@operai.test`, emailVerified: true } });
  adminId = admin.id;
  const adminRole = await db.role.upsert({ where: { name: "admin" }, update: {}, create: { name: "admin", isSystem: true } });
  await db.userRole.create({ data: { userId: adminId, roleId: adminRole.id } });
  currentSession = { user: { id: adminId, email: admin.email, name: "L" }, session: { id: `s-${RUN}` } };
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { actorUserId: adminId } });
  await db.department.deleteMany({ where: { name: { contains: RUN } } });
  await db.user.deleteMany({ where: { id: adminId } });
});

const problemOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("the middleware on its own", () => {
  const harness = () => {
    const reached = { handler: 0 };
    const a = new Hono();
    a.use("*", requestBodyLimit);
    a.use("*", rejectNul);
    a.post("/echo", async (c) => {
      reached.handler += 1;
      return c.json({ bytes: (await c.req.text()).length });
    });
    return { a, reached };
  };

  test("a declared length over the limit is a 413 Problem JSON, and not one byte of the body is pulled", async () => {
    const { a, reached } = harness();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const res = await a.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(OVER) },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const p = await problemOf(res);
    expect(p).toMatchObject({ status: 413, title: "Payload Too Large", code: "request_too_large", instance: "/echo" });
    expect(pulls).toBe(0);
    expect(reached.handler).toBe(0);
  });

  test("a body with no declared length is stopped once it passes the limit: a 413, the handler never runs", async () => {
    const { a, reached } = harness();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 8192;
        controller.enqueue(new Uint8Array(8192).fill(0x20));
        if (sent > MAX_REQUEST_BODY_BYTES * 8) controller.close();
      },
    });
    const res = await a.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await problemOf(res))["code"]).toBe("request_too_large");
    expect(reached.handler).toBe(0);
    expect(sent).toBeLessThan(MAX_REQUEST_BODY_BYTES * 2);
  });

  test("a body exactly at the limit passes, and the NUL scan still reads it", async () => {
    const { a, reached } = harness();
    const exact = `"${" ".repeat(MAX_REQUEST_BODY_BYTES - 2)}"`;
    expect(exact.length).toBe(MAX_REQUEST_BODY_BYTES);
    const ok = await a.request("/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: exact });
    expect(ok.status).toBe(200);
    expect(reached.handler).toBe(1);
    const nul = await a.request("/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":"\\u0000"}' });
    expect(nul.status).toBe(400);
  });
});

describe("the whole app", () => {
  const json = { "Content-Type": "application/json" };

  test("an oversized JSON body is a 413 before authentication: no session needed, nothing written", async () => {
    const before = await db.department.count();
    const saved = currentSession;
    currentSession = null;
    try {
      const res = await app.request("/admin/departments", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: `big-${RUN}`, description: "x".repeat(OVER) }),
      });
      expect(res.status).toBe(413);
      expect((await problemOf(res))["code"]).toBe("request_too_large");
    } finally {
      currentSession = saved;
    }
    expect(await db.department.count()).toBe(before);
  });

  test("an oversized body is refused before the NUL scan looks at it (a NUL inside it does not make it a 400)", async () => {
    const res = await app.request("/admin/departments", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: `n-${RUN}`, description: `\u0000${"x".repeat(OVER)}` }),
    });
    expect(res.status).toBe(413);
  });

  test("better-auth's own routes: a small body reaches its handler, an oversized one never does", async () => {
    betterAuthHandler.mockClear();
    const small = await app.request("/auth/sign-in/social", { method: "POST", headers: json, body: JSON.stringify({ provider: "google" }) });
    expect(small.status).toBe(200);
    expect(betterAuthHandler).toHaveBeenCalledTimes(1);
    const big = await app.request("/auth/sign-in/social", { method: "POST", headers: json, body: JSON.stringify({ provider: "x".repeat(OVER) }) });
    expect(big.status).toBe(413);
    expect(betterAuthHandler).toHaveBeenCalledTimes(1);
  });

  test("the legitimate largest body of the biggest bulk route (a bulk delete naming 1 000 users) still works", async () => {
    const userIds = Array.from({ length: 1000 }, () => crypto.randomUUID().replaceAll("-", ""));
    const body = JSON.stringify({ userIds });
    expect(body.length).toBeLessThan(MAX_REQUEST_BODY_BYTES / 4);
    const res = await app.request("/admin/users/delete", { method: "POST", headers: json, body });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { deleted: string[]; skipped: unknown[] };
    expect(out.skipped).toHaveLength(1000);
  });
});

describe("the figure", () => {
  const catalogs = [
    ACCOUNTING_CATALOG,
    ADMIN_CATALOG,
    CRM_CATALOG,
    ESTIMAI_CATALOG,
    HOURS_CATALOG,
    INVENTORY_CATALOG,
    LETTERHEADS_CATALOG,
    MEETINGS_CATALOG,
    PROJECTS_CATALOG,
    REFUND_CATALOG,
  ];

  test("is at least four times the biggest body the admin API legitimately takes: a role holding EVERY permission of the suite, each with a two-attribute condition", () => {
    const rules = catalogs.flatMap((catalog) =>
      catalog.resources.flatMap((resource) =>
        resource.actions.map((action) => ({
          resource: resource["key"],
          action: action["key"],
          conditions: {
            ownership: "any",
            attributes: [
              { key: "entity", match: "welld_ch" },
              { key: "self-approval", match: "deny" },
            ],
          },
        })),
      ),
    );
    const size = JSON.stringify({ rules }).length;
    expect(rules.length).toBeGreaterThan(30);
    expect(size * 4).toBeLessThan(MAX_REQUEST_BODY_BYTES);
  });

  test("is far above the legal-entity writes' own 16 KiB cap (that route keeps answering its own 413)", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(16 * 1024 * 4);
  });
});
