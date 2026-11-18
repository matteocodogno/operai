/**
 * Mount guard (D1, specs/20261117-legal-entities): goes through the ASSEMBLED app exported from `src/index.ts`, with the
 * REAL better-auth handler, and asserts that every route group is reached. It exists because a router-level unit test
 * cannot see this failure: Hono's SmartRouter picks RegExpRouter and falls back to TrieRouter for the WHOLE app as soon
 * as any one route makes RegExpRouter throw (the legal-entities read router does), and the two routers read `"/**"`
 * differently - the auth mount then answered 404 to every /auth/** path while its own tests still passed.
 *
 * "Reached" for a better-auth path means: not the app's own `notFound` problem document. (Better Auth answers 4xx of its
 * own - 400, 401, 302 - which are all fine here; what is not fine is the app saying the path does not exist.)
 */

import { afterAll, describe, expect, test } from "bun:test";
import { getCookies } from "better-auth/cookies";
import { auth } from "./auth.config";
import { db } from "../lib/db";
import { env } from "../lib/env";

const { app } = await import("../index");

const isAppNotFound = async (res: Response): Promise<boolean> => {
  if (res.status !== 404) return false;
  const body = (await res.clone().text()) ?? "";
  return body.includes("httpstatuses.com/404") && body.includes("does not exist");
};

const send = (method: string, path: string): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      redirect: "manual",
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
    }),
  );

describe("the auth mount, through the assembled app", () => {
  test("/auth/ok answers 200", async () => {
    const res = await send("GET", "/auth/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("/auth/jwks answers 200 with a key set", async () => {
    const res = await send("GET", "/auth/jwks");
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { keys: unknown[] }).keys)).toBe(true);
  });

  test("/auth/get-session answers 200 (no session) on GET; a POST reaches Better Auth (its 405), never the app's 404", async () => {
    expect((await send("GET", "/auth/get-session")).status).toBe(200);
    const post = await send("POST", "/auth/get-session");
    expect(post.status).toBe(405);
    expect(await isAppNotFound(post)).toBe(false);
  });

  test("/auth/token answers 401 without a session, never 404", async () => {
    const res = await send("GET", "/auth/token");
    expect(res.status).toBe(401);
  });

  test("a nested better-auth path is reached: POST /auth/sign-in/social (400 for an empty body, not 404)", async () => {
    const res = await send("POST", "/auth/sign-in/social");
    expect(res.status).toBe(400);
  });

  test("a nested better-auth path with a parameter is reached: GET /auth/callback/google", async () => {
    const res = await send("GET", "/auth/callback/google");
    expect(await isAppNotFound(res)).toBe(false);
    expect([302, 400]).toContain(res.status);
  });

  test("an unknown path under /auth is Better Auth's 404, not the app's", async () => {
    const res = await send("GET", "/auth/no/such/endpoint");
    expect(res.status).toBe(404);
    expect(await isAppNotFound(res)).toBe(false);
  });

  test("DELETE under /auth is delegated too (the mount lists GET, POST and DELETE)", async () => {
    const res = await send("DELETE", "/auth/sign-out");
    expect(await isAppNotFound(res)).toBe(false);
  });

  test("EVERY endpoint better-auth serves in this configuration is reached through the app", async () => {
    const endpoints = Object.values(auth.api as Record<string, { path?: string; options?: { method?: string | string[] } }>)
      .filter((e): e is { path: string; options?: { method?: string | string[] } } => typeof e.path === "string");
    expect(endpoints.length).toBeGreaterThan(20); // sign-in/social, callback/:id, get-session, token, jwks, ok, ...

    const unreached: string[] = [];
    for (const e of endpoints) {
      const method = [e.options?.method ?? "GET"].flat()[0] as string;
      const path = `/auth${e.path.replace(/:\w+/g, "google")}`;
      if (await isAppNotFound(await send(method, path))) unreached.push(`${method} ${path}`);
    }
    expect(unreached).toEqual([]);
  });
});

describe("the other route groups still answer through the assembled app (mount order and router fallback)", () => {
  test("legal-entities read routes answer 401 without a session, no-store, never 404", async () => {
    for (const path of ["/legal-entities", "/legal-entities/manageable", "/legal-entities/welld_ch"]) {
      const res = await send("GET", path);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toContain("no-store");
    }
  });

  test("legal-entities history, write, system and the other groups are mounted (a status other than the app's 404)", async () => {
    const probes: Array<[string, string]> = [
      ["GET", "/legal-entities/welld_ch/versions"],
      ["GET", "/legal-entities/welld_ch/versions/1"],
      ["POST", "/legal-entities/welld_ch/versions"],
      ["POST", "/legal-entities/welld_ch/versions/1/restore"],
      ["POST", "/legal-entities/welld_ch/versions/check"],
      ["GET", "/system/legal-entities"],
      ["GET", "/system/legal-entities/welld_ch"],
      ["POST", "/system/service-token"],
      ["GET", "/authz/me"],
      ["GET", "/admin/users"],
      ["GET", "/admin/roles"],
      ["GET", "/admin/departments"],
      ["GET", "/health"],
    ];
    const unreached: string[] = [];
    for (const [method, path] of probes) {
      if (await isAppNotFound(await send(method, path))) unreached.push(`${method} ${path}`);
    }
    expect(unreached).toEqual([]);
  });
});

// ─── CORS: Retry-After is readable cross-origin (T74, AC-9.6, AC-8.1) ──────────────────────────────────────────────
// `Retry-After` is not CORS-safelisted, so without `exposeHeaders` a cross-origin admin-ui cannot read the 429 wait.

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];

afterAll(async () => {
  await db.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.role.deleteMany({ where: { id: { in: createdRoleIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

/** A person who manages every legal entity, and the signed session cookie of a real Better Auth session for them. */
async function managerCookie(): Promise<string> {
  const user = await db.user.create({
    data: { name: "T74 fixture", email: `t74-cors-${RUN_ID}-${crypto.randomUUID()}@legalentities.test`, emailVerified: true },
  });
  createdUserIds.push(user.id);
  const role = await db.role.create({ data: { name: `t74-cors-${RUN_ID}-${crypto.randomUUID()}` } });
  createdRoleIds.push(role.id);
  await db.permissionRule.create({ data: { roleId: role.id, resource: "legal-entity", action: "manage" } });
  await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return sessionCookieFor(user.id);
}

/** The signed session cookie of a real Better Auth session for `userId`. */
async function sessionCookieFor(userId: string): Promise<string> {
  const session = await (await auth.$context).internalAdapter.createSession(userId, false);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(session.token));
  const signed = `${session.token}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
  return `${getCookies(auth.options).sessionToken.name}=${encodeURIComponent(signed)}`;
}

const ORIGIN = "http://localhost:5173";
const exposed = (res: Response): string[] =>
  (res.headers.get("access-control-expose-headers") ?? "").split(",").map((h) => h.trim().toLowerCase());

describe("CORS exposes Retry-After (T74)", () => {
  test("a throttled POST /legal-entities/:entity/versions from an allowed origin carries Retry-After AND exposes it", async () => {
    const cookie = await managerCookie();
    let throttled: Response | undefined;
    for (let i = 0; i <= env.LEGAL_ENTITY_WRITE_RATE_LIMIT && throttled === undefined; i++) {
      const res = await app.request("/legal-entities/welld_ch/versions", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: "{}",
      });
      if (res.status === 429) throttled = res;
      else expect(res.status).toBe(422); // spent attempts: counted, then refused for the empty body
    }
    expect(throttled).toBeDefined();
    const res = throttled as Response;
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(exposed(res)).toContain("retry-after");
  });

  test("a preflight still answers 204 with the unchanged policy (origin, credentials, methods, headers)", async () => {
    const res = await app.request("/legal-entities/welld_ch/versions", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type,Authorization");
  });

  test("an origin that is not allowed gets no CORS grant at all", async () => {
    const res = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ─── The account email cannot be changed by its holder (T88, security review D9-2) ──────────────────────────────────
// The author of a legal-entity change is identified in the notice by `user.email`; "the holder cannot set it" rests on
// Better Auth's defaults (`user.changeEmail` off, `update-user` ignoring `email`). This pins the premise.

describe("a signed-in holder cannot change user.email (D9-2)", () => {
  const attempts: Array<[string, string, Record<string, unknown>]> = [
    ["POST /auth/change-email", "/auth/change-email", { newEmail: "attacker-chosen@legalentities.test" }],
    ["POST /auth/change-email (callbackURL)", "/auth/change-email", { newEmail: "attacker-chosen@legalentities.test", callbackURL: "/" }],
    ["POST /auth/update-user with an email member", "/auth/update-user", { email: "attacker-chosen@legalentities.test" }],
    ["POST /auth/update-user with email and name", "/auth/update-user", { email: "attacker-chosen@legalentities.test", name: "Renamed" }],
  ];

  for (const [label, path, body] of attempts) {
    test(`${label} leaves the stored email unchanged`, async () => {
      const email = `t88-email-${RUN_ID}-${crypto.randomUUID()}@legalentities.test`;
      const user = await db.user.create({ data: { name: "T88 fixture", email, emailVerified: true } });
      createdUserIds.push(user.id);
      const cookie = await sessionCookieFor(user.id);

      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      // Recorded, not asserted: what Better Auth answers (it may refuse, or accept the request and ignore the member).
      console.info(`[T88] ${label} -> ${res.status} ${text.slice(0, 160)}`);

      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.email).toBe(email);
      expect(after.emailVerified).toBe(true);
      expect(await db.user.count({ where: { email: { contains: "attacker-chosen" } } })).toBe(0);
    });
  }
});
