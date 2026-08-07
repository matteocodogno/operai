/**
 * Integration tests for GET / POST /estimates/{id}/collaborators (T8,
 * specs/013-estimate-sharing).
 *
 * Strategy
 * ────────
 * - Real Postgres (compose, host:5435, database: estimai) via a FRESH Prisma
 *   client pointed at the DATABASE_URL restored from `.env` — same
 *   dotenv-restore-then-mock technique as `estimates.routes.test.ts`,
 *   necessary because an earlier-run test file (`jwt.middleware.test.ts`)
 *   unconditionally clobbers `process.env.DATABASE_URL` for the rest of the
 *   `bun test` process.
 * - A fully ISOLATED Hono app: a brand-new `OpenAPIHono` instance with a
 *   trivial test-only auth middleware (NOT the real `jwtMiddleware`, NOT a
 *   real RS256/JWKS setup) and `registerCollaboratorRoutes(router, deps)`
 *   with per-test injectable `checkAppAccess`/`resolveIdentities`. This is
 *   DELIBERATE, not a shortcut — see collaborators.routes.ts's file header:
 *   `bun test` shares ONE process/module-cache across every `*.test.ts`
 *   file, and `estimates.routes.test.ts` already owns its own
 *   `mock.module("@/auth/jwt.middleware", …)` + dynamic-import-of-the-real-
 *   `estimatesRouter-singleton dance for ITS OWN fixture users. Reusing that
 *   singleton here (or mocking the same global specifiers) would make
 *   whichever test file's mock happens to bind FIRST — an unpredictable,
 *   filesystem-traversal-order race — win for BOTH files' requests for the
 *   rest of the process. Building fully independent test doubles here
 *   removes that race entirely; `registerCollaboratorRoutes` itself is
 *   exercised identically to production (same function, real
 *   `estimatesRouter`, real `jwtMiddleware`) via `index.ts`, which is not
 *   under test here.
 * - Fixture "identities" are opaque test-chosen ids/emails — no real JWTs,
 *   no real `auth` HTTP calls. `checkAppAccess`/`resolveIdentities` are
 *   provided per-test as plain async functions via `deps`.
 *
 * `done when` coverage (tasks.md T8)
 * ───────────────────────────────────
 * - 201 + the grant row exists and would surface in the target's list
 *   (verified directly against `estimate`/`estimate_collaborator`, the same
 *   query shape `estimates.repo.ts#listEstimates` uses — T6's own tests
 *   already cover that query end-to-end)
 * - both ineligible causes → byte-identical 422 body (AC-1.2)
 * - duplicate (fast-path) → 409 `already_collaborator`, row count stays 1
 * - stale-email-snapshot duplicate → 409 via the unique-constraint mapping
 * - self-add by JWT email AND by an auth-resolved alias → 422 `cannot_share_with_self`
 * - an editor's add attempt → 403 `owner_only`
 * - the 21st attempt in the window → 429, with successes AND 409s/422s
 *   already having counted
 * - a throwing `auth` call → 503, no grant row created
 * - GET is owner-only; the owner never appears in the list; `id` is the
 *   grant's id, never a `sub`
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { Effect } from "effect";
import { ForbiddenError } from "@/lib/errors";
import type { JwtVariables } from "@/auth/jwt.middleware";

// ─── Env guards — mirrors estimates.routes.test.ts / authClient.test.ts's
// `??=` pattern so this file boots correctly regardless of which test file
// in the shared `bun test` process happens to trigger `@/lib/env`'s
// (once-ever) validation first. ──────────────────────────────────────────

process.env["DATABASE_URL"] ??= "postgresql://postgres:postgres@localhost:5435/estimai";
process.env["ALLOWED_ORIGINS"] ??= "http://localhost:5173";
process.env["AUTH_JWKS_URL"] ??= "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] ??= "http://localhost:3001";
process.env["AUTH_AUDIENCE"] ??= "operai-suite";
process.env["NODE_ENV"] ??= "test";
process.env["AUTH_BASE_URL"] ??= "http://localhost:3001";
process.env["NOTIFY_INTERNAL_TOKEN"] ??=
  "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] ??= "http://localhost:8081";

// ─── Restore the REAL DATABASE_URL from .env (jwt.middleware.test.ts may
// have already clobbered it for the rest of the process) and build a fresh
// Prisma client pointed at it — same technique as estimates.routes.test.ts. ──

import { config as dotenvConfig } from "dotenv";
dotenvConfig({
  path: new URL("../../.env", import.meta.url).pathname,
  override: true,
});

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");

const realDatabaseUrl = process.env["DATABASE_URL"]!;
const freshAdapter = new PrismaPg({ connectionString: realDatabaseUrl });
const freshDb = new PrismaClient({ adapter: freshAdapter });

mock.module("@/lib/db", () => ({ db: freshDb }));

const testDb = freshDb;

// Dynamic import AFTER the @/lib/db mock is registered.
const { registerCollaboratorRoutes } = await import("./collaborators.routes");
const authClientModule = await import("@/lib/authClient");
type CheckAppAccessFn = typeof authClientModule.checkAppAccess;
type ResolveIdentitiesFn = typeof authClientModule.resolveIdentities;

// T9 — `updateEstimate` and `resolveAccess` are DB-only (no Bearer header,
// no HTTP router involved), the SAME functions estimates.routes.ts's real
// `PUT`/`GET /estimates/{id}` call. Exercising them directly here, after a
// T9 route call has already mutated the DB, is the most faithful proof of
// AC-5.1/AC-5.2's "next request" semantics available WITHOUT re-creating the
// full estimates.routes.ts app (which would reintroduce the exact
// mock.module("@/auth/jwt.middleware", …) cross-file race this file's
// header explains at length — estimates.routes.test.ts already owns that
// mock for ITS OWN fixtures).
const { updateEstimate } = await import("./estimates.repo");
const { resolveAccess } = await import("./access");

// ─── Test-only auth middleware ───────────────────────────────────────────
//
// NOT the real jwtMiddleware — see file header. Reads a deliberately
// non-JWT-shaped `Bearer test|<userId>|<email>` token so there is no
// confusion with a real credential and no crypto/JWKS setup needed at all.

const TEST_BEARER_PREFIX = "Bearer test|";

const testAuthMiddleware = createMiddleware<{ Variables: JwtVariables }>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith(TEST_BEARER_PREFIX)) {
    return c.json(
      {
        type: "https://httpstatuses.com/401",
        title: "Unauthorized",
        status: 401,
        detail: "A valid test Bearer token is required",
        instance: c.req.path,
      },
      401,
    );
  }
  const [userId, email] = header.slice(TEST_BEARER_PREFIX.length).split("|");
  if (!userId || !email) {
    return c.json(
      {
        type: "https://httpstatuses.com/401",
        title: "Unauthorized",
        status: 401,
        detail: "Malformed test Bearer token",
        instance: c.req.path,
      },
      401,
    );
  }
  c.set("userId", userId);
  c.set("email", email);
  return next();
});

const bearerHeader = (userId: string, email: string) => ({
  Authorization: `Bearer test|${userId}|${email}`,
  "Content-Type": "application/json",
});

// ─── App builder — one fresh isolated router per test ────────────────────

interface TestDeps {
  readonly checkAppAccess: CheckAppAccessFn;
  readonly resolveIdentities: ResolveIdentitiesFn;
}

const alwaysIneligible: CheckAppAccessFn = async () => ({ eligible: false });
const emptyIdentities: ResolveIdentitiesFn = async () => new Map();

function buildApp(deps: Partial<TestDeps> = {}) {
  const router = new OpenAPIHono<{ Variables: JwtVariables }>();
  router.use("*", testAuthMiddleware);
  registerCollaboratorRoutes(router, {
    checkAppAccess: deps.checkAppAccess ?? alwaysIneligible,
    resolveIdentities: deps.resolveIdentities ?? emptyIdentities,
  });
  const app = new Hono();
  app.route("/", router);
  return app;
}

/** An eligible target: `checkAppAccess` resolves `email` to `userId`, rejects everything else. */
const eligibleFor = (email: string, userId: string): CheckAppAccessFn =>
  async (_authHeader, _appId, submittedEmail) =>
    submittedEmail === email ? { eligible: true, userId } : { eligible: false };

// ─── Fixtures ──────────────────────────────────────────────────────────────

let ownerCounter = 0;
/** A fresh, never-reused owner id + email pair — keeps each test's rate-limit
 * budget independent (the module-scope limiter in collaborators.routes.ts
 * persists for the whole file's run). */
const freshOwner = () => {
  ownerCounter += 1;
  const id = `t8-owner-${ownerCounter}-${Date.now()}`;
  return { id, email: `${id}@example.com` };
};

const makeContent = () => ({
  params: {},
  releases: [],
  acts: [],
});

const seedEstimate = async (ownerId: string, name = "T8 fixture estimate") => {
  const content = makeContent();
  const sizeBytes = new TextEncoder().encode(JSON.stringify(content)).length;
  return testDb.estimate.create({
    data: { userId: ownerId, name, author: "", sizeBytes, content },
  });
};

const ownerIdsToClean = new Set<string>();
afterEach(async () => {
  if (ownerIdsToClean.size > 0) {
    await testDb.estimate.deleteMany({ where: { userId: { in: Array.from(ownerIdsToClean) } } });
    ownerIdsToClean.clear();
  }
});

// ─── AC-1.1 — happy path: 201, grant row exists and would surface in the
// target's list ─────────────────────────────────────────────────────────────

describe("AC-1.1 — eligible email + level → collaborator created", () => {
  it("POST → 201 with the created grant; the row exists and matches the target/estimate/level", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const targetId = "t8-target-ac11";
    const targetEmail = "colleague-ac11@example.com";

    const app = buildApp({ checkAppAccess: eligibleFor(targetEmail, targetId) });

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: targetEmail, accessLevel: "viewer" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      email: string;
      accessLevel: string;
      createdAt: string;
      identity: { status: string; name: string | null };
    };
    expect(body.email).toBe(targetEmail);
    expect(body.accessLevel).toBe("viewer");
    expect(typeof body.id).toBe("string");
    expect(body.id).toBeTruthy();

    // The grant row exists with the target's RESOLVED userId (never taken
    // from the request body) — the same query shape estimates.repo.ts's
    // listEstimates uses to surface shared estimates in the target's list.
    const rows = await testDb.estimate.findMany({
      where: { OR: [{ userId: targetId }, { collaborators: { some: { userId: targetId } } }] },
    });
    expect(rows.some((r) => r.id === estimate.id)).toBe(true);

    const grant = await testDb.estimateCollaborator.findUnique({
      where: { estimateId_userId: { estimateId: estimate.id, userId: targetId } },
    });
    expect(grant).not.toBeNull();
    expect(grant?.email).toBe(targetEmail);
    expect(grant?.accessLevel).toBe("viewer");
    expect(grant?.grantedByUserId).toBe(owner.id);

    // The owner's own GET .../collaborators also reflects it.
    const listRes = await app.request(`/estimates/${estimate.id}/collaborators`, {
      headers: bearerHeader(owner.id, owner.email),
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { collaborators: Array<{ id: string; email: string }> };
    expect(list.collaborators.some((c) => c.id === body.id)).toBe(true);
  });
});

// ─── AC-1.2 — the generic rejection: BOTH causes → byte-identical body ──────

describe("AC-1.2 — the generic rejection is ONE fixed status/code/detail for BOTH causes", () => {
  it("no-such-user and user-without-access both → 422 collaborator_not_eligible, byte-identical bodies, no grant created", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);

    // Both causes collapse to eligible:false at the authClient layer — this
    // mock cannot even express "why", by construction (mirrors auth's own
    // ADR-0035 collapse).
    const app = buildApp({ checkAppAccess: alwaysIneligible });

    const resA = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: "no-such-user@example.com", accessLevel: "viewer" }),
    });
    const resB = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: "no-app-access@example.com", accessLevel: "viewer" }),
    });

    expect(resA.status).toBe(422);
    expect(resB.status).toBe(422);
    const bodyA = (await resA.json()) as { code: string; detail: string; status: number };
    const bodyB = (await resB.json()) as { code: string; detail: string; status: number };
    expect(bodyA.code).toBe("collaborator_not_eligible");
    // Byte-identical status/code/detail across both causes.
    expect(bodyA).toEqual(bodyB);

    const count = await testDb.estimateCollaborator.count({ where: { estimateId: estimate.id } });
    expect(count).toBe(0);
  });

  it("floors the response to at least SHARE_LOOKUP_FLOOR_MS", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp({ checkAppAccess: alwaysIneligible });

    const start = Date.now();
    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: "floor-check@example.com", accessLevel: "viewer" }),
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(422);
    // Default SHARE_LOOKUP_FLOOR_MS is 300ms (env.ts default, not overridden
    // anywhere in this test process) — allow a couple ms of scheduling slack.
    expect(elapsed).toBeGreaterThanOrEqual(295);
  });
});

// ─── AC-1.3 — duplicate ─────────────────────────────────────────────────────

describe("AC-1.3 — duplicate collaborator", () => {
  it("adding the same email twice → second attempt 409 already_collaborator, row count stays 1", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const targetId = "t8-target-ac13";
    const targetEmail = "dup-ac13@example.com";
    const app = buildApp({ checkAppAccess: eligibleFor(targetEmail, targetId) });

    const first = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: targetEmail, accessLevel: "viewer" }),
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: targetEmail, accessLevel: "editor" }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("already_collaborator");

    const count = await testDb.estimateCollaborator.count({ where: { estimateId: estimate.id } });
    expect(count).toBe(1);
  });

  it("stale email-snapshot: a NEW email resolving to an EXISTING collaborator's userId → 409 via the unique-constraint mapping", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const targetId = "t8-target-stale-snapshot";

    // Seed an existing grant directly, simulating a prior add under a
    // DIFFERENT email that has since become stale.
    await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: targetId,
        email: "old-address@example.com",
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });

    // The submitted email is DIFFERENT — findCollaboratorByEmail's
    // (estimateId, email) fast path will NOT find it — but auth resolves it
    // to the SAME userId as the existing grant.
    const aliasEmail = "new-alias-address@example.com";
    const app = buildApp({ checkAppAccess: eligibleFor(aliasEmail, targetId) });

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: aliasEmail, accessLevel: "editor" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("already_collaborator");

    const count = await testDb.estimateCollaborator.count({ where: { estimateId: estimate.id } });
    expect(count).toBe(1);
  });
});

// ─── AC-1.4 — self-add ───────────────────────────────────────────────────────

describe("AC-1.4 — owner cannot add themselves", () => {
  it("own JWT email → 422 cannot_share_with_self, WITHOUT any auth call", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);

    let authCalled = false;
    const app = buildApp({
      checkAppAccess: async (...args) => {
        authCalled = true;
        return alwaysIneligible(...args);
      },
    });

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: owner.email, accessLevel: "viewer" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("cannot_share_with_self");
    expect(authCalled).toBe(false);
  });

  it("own JWT email in a different case/whitespace → still 422 cannot_share_with_self (normalisation)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: `  ${owner.email.toUpperCase()}  `, accessLevel: "viewer" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("cannot_share_with_self");
  });

  it("an ALIAS address that auth resolves to the caller's OWN userId → 422 cannot_share_with_self (the definitive, post-lookup check)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const aliasEmail = "owner-alias@example.com";
    // The fast (step 4) check compares against owner.email and would MISS
    // this — only the definitive (step 7) check, run after auth resolves
    // aliasEmail -> owner.id, catches it.
    const app = buildApp({ checkAppAccess: eligibleFor(aliasEmail, owner.id) });

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: aliasEmail, accessLevel: "viewer" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("cannot_share_with_self");

    const count = await testDb.estimateCollaborator.count({ where: { estimateId: estimate.id } });
    expect(count).toBe(0);
  });
});

// ─── AC-1.5 / AC-3.3-style — a collaborator cannot add collaborators ────────

describe("AC-1.5 — a collaborator (editor) cannot add collaborators", () => {
  it("an editor's POST → 403 owner_only, no row created", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const editorId = "t8-editor-ac15";
    const editorEmail = "editor-ac15@example.com";

    await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: editorId,
        email: editorEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });

    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(editorId, editorEmail),
      body: JSON.stringify({ email: "someone-else@example.com", accessLevel: "viewer" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("owner_only");

    const count = await testDb.estimateCollaborator.count({ where: { estimateId: estimate.id } });
    expect(count).toBe(1); // only the seeded editor row
  });
});

// ─── AC-1.6 — a stranger gets 404 ────────────────────────────────────────────

describe("AC-1.6 — an unrelated caller gets 404, not 403", () => {
  it("POST /estimates/{id}/collaborators with no relationship → 404", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader("t8-stranger", "stranger@example.com"),
      body: JSON.stringify({ email: "someone@example.com", accessLevel: "viewer" }),
    });

    expect(res.status).toBe(404);
  });

  it("GET /estimates/{id}/collaborators with no relationship → 404", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      headers: bearerHeader("t8-stranger-2", "stranger2@example.com"),
    });

    expect(res.status).toBe(404);
  });
});

// ─── 503 — auth unreachable fails CLOSED ────────────────────────────────────

describe("auth unreachable → 503, fail CLOSED, no grant created", () => {
  it("a throwing checkAppAccess → 503 authorization_service_unavailable, zero rows created", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);

    const app = buildApp({
      checkAppAccess: async () => {
        throw new Error("connection refused");
      },
    });

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: "someone@example.com", accessLevel: "viewer" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("authorization_service_unavailable");

    const count = await testDb.estimateCollaborator.count({ where: { estimateId: estimate.id } });
    expect(count).toBe(0);
  });
});

// ─── Rate limiting — the 21st attempt in the window → 429 ──────────────────

describe("rate limiting — SHARE_ADD_RATE_LIMIT attempts per window, counted on every outcome", () => {
  it("the 21st POST attempt (after 20 mixed-outcome attempts) → 429 with Retry-After", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const targetId = "t8-rl-target";
    const targetEmail = "rl-target@example.com";
    const app = buildApp({ checkAppAccess: eligibleFor(targetEmail, targetId) });

    // Attempt 1: self-add → 422 (counts).
    const selfRes = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: owner.email, accessLevel: "viewer" }),
    });
    expect(selfRes.status).toBe(422);

    // Attempt 2: success → 201 (counts).
    const successRes = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: targetEmail, accessLevel: "viewer" }),
    });
    expect(successRes.status).toBe(201);

    // Attempts 3-20 (18 more): duplicate → 409 each (counts).
    for (let i = 0; i < 18; i++) {
      const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
        method: "POST",
        headers: bearerHeader(owner.id, owner.email),
        body: JSON.stringify({ email: targetEmail, accessLevel: "viewer" }),
      });
      expect(res.status).toBe(409);
    }

    // 20 attempts consumed exactly the default SHARE_ADD_RATE_LIMIT budget —
    // the 21st must now be rate-limited.
    const res21 = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: targetEmail, accessLevel: "viewer" }),
    });
    expect(res21.status).toBe(429);
    expect(res21.headers.get("Retry-After")).toBeTruthy();
    const body = (await res21.json()) as { code: string };
    expect(body.code).toBe("rate_limited");
  });
});

// ─── GET — owner-only, grant id (never sub), owner never listed ────────────

describe("GET /estimates/{id}/collaborators", () => {
  it("a collaborator (viewer) attempting GET → 403 owner_only", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const viewerId = "t8-viewer-get";
    const viewerEmail = "viewer-get@example.com";
    await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: viewerId,
        email: viewerEmail,
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      headers: bearerHeader(viewerId, viewerEmail),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("owner_only");
  });

  it("the owner sees the grant's id (never the collaborator's sub) and never sees themselves listed", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const targetId = "t8-target-get-shape";
    const targetEmail = "target-get-shape@example.com";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: targetId,
        email: targetEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      headers: bearerHeader(owner.id, owner.email),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collaborators: Array<{ id: string; email: string; accessLevel: string }>;
    };
    expect(body.collaborators).toHaveLength(1);
    const row = body.collaborators[0]!;
    // The GRANT's id, not the collaborator's userId/sub.
    expect(row.id).toBe(grant.id);
    expect(row.id).not.toBe(targetId);
    expect(row.email).toBe(targetEmail);
    expect(row.accessLevel).toBe("editor");
    // The owner is never a row in their own collaborator list.
    expect(body.collaborators.some((c) => c.id === owner.id)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T9 — PATCH / DELETE {collaboratorId} / DELETE me (manage, revoke, leave)
// (specs/013-estimate-sharing — refs AC-5.1, AC-5.2, AC-5.3, AC-6.1, AC-6.2)
// ═══════════════════════════════════════════════════════════════════════

// ─── AC-5.1 — a level change takes effect on the collaborator's NEXT
// request, proven by calling the REAL `updateEstimate` (what the actual
// `PUT /estimates/{id}` route calls) directly after a PATCH ────────────────

describe("AC-5.1 — PATCH level change takes effect on the collaborator's next request", () => {
  it("editor → viewer: the collaborator's next write attempt is refused (ForbiddenError, not a version conflict)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const collaboratorId = "t9-ac51-editor-to-viewer";
    const collaboratorEmail = "ac51-e2v@example.com";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: collaboratorId,
        email: collaboratorEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    // Sanity: editor can currently write.
    const beforeExit = await Effect.runPromiseExit(
      updateEstimate(estimate.id, collaboratorId, 1, "before", "", makeContent()),
    );
    expect(beforeExit._tag).toBe("Success");

    const patchRes = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader(owner.id, owner.email),
        body: JSON.stringify({ accessLevel: "viewer" }),
      },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { accessLevel: string };
    expect(patchBody.accessLevel).toBe("viewer");

    // The collaborator's NEXT write (correct version this time) is refused —
    // a ForbiddenError, never a success and never a ConflictError (proves
    // the access predicate, not the version, is what stopped it).
    const afterExit = await Effect.runPromiseExit(
      updateEstimate(estimate.id, collaboratorId, 2, "after", "", makeContent()),
    );
    expect(afterExit._tag).toBe("Failure");
    if (afterExit._tag === "Failure") {
      expect(afterExit.cause._tag).toBe("Fail");
      if (afterExit.cause._tag === "Fail") {
        expect(afterExit.cause.error).toBeInstanceOf(ForbiddenError);
      }
    }

    // The stored content is untouched by the refused write.
    const row = await testDb.estimate.findUniqueOrThrow({ where: { id: estimate.id } });
    expect(row.name).toBe("before");
    expect(row.version).toBe(2);
  });

  it("viewer → editor: the collaborator's next write attempt succeeds", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const collaboratorId = "t9-ac51-viewer-to-editor";
    const collaboratorEmail = "ac51-v2e@example.com";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: collaboratorId,
        email: collaboratorEmail,
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    // Sanity: viewer currently cannot write.
    const beforeExit = await Effect.runPromiseExit(
      updateEstimate(estimate.id, collaboratorId, 1, "before", "", makeContent()),
    );
    expect(beforeExit._tag).toBe("Failure");

    const patchRes = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader(owner.id, owner.email),
        body: JSON.stringify({ accessLevel: "editor" }),
      },
    );
    expect(patchRes.status).toBe(200);

    // The collaborator's NEXT write now succeeds.
    const afterExit = await Effect.runPromiseExit(
      updateEstimate(estimate.id, collaboratorId, 1, "after", "", makeContent()),
    );
    expect(afterExit._tag).toBe("Success");
    const row = await testDb.estimate.findUniqueOrThrow({ where: { id: estimate.id } });
    expect(row.name).toBe("after");
    expect(row.version).toBe(2);
  });

  it("PATCH by an editor (not the owner) → 403 owner_only, level unchanged", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const editorId = "t9-patch-by-editor";
    const editorEmail = "patch-by-editor@example.com";
    const targetGrant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: "t9-patch-target",
        email: "patch-target@example.com",
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: editorId,
        email: editorEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${targetGrant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader(editorId, editorEmail),
        body: JSON.stringify({ accessLevel: "editor" }),
      },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("owner_only");

    const unchanged = await testDb.estimateCollaborator.findUnique({
      where: { id: targetGrant.id },
    });
    expect(unchanged?.accessLevel).toBe("viewer");
  });

  it("PATCH by an unrelated stranger → 404", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: "t9-patch-stranger-target",
        email: "patch-stranger-target@example.com",
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader("t9-patch-stranger", "patch-stranger@example.com"),
        body: JSON.stringify({ accessLevel: "editor" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("PATCH on a fabricated grant id (AC-5.4) → 404, even for the real owner", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/does-not-exist`,
      {
        method: "PATCH",
        headers: bearerHeader(owner.id, owner.email),
        body: JSON.stringify({ accessLevel: "editor" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("PATCH with a malformed accessLevel → 400, level unchanged", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: "t9-patch-bad-body",
        email: "patch-bad-body@example.com",
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader(owner.id, owner.email),
        body: JSON.stringify({ accessLevel: "owner" }),
      },
    );

    expect(res.status).toBe(400);
    const unchanged = await testDb.estimateCollaborator.findUnique({ where: { id: grant.id } });
    expect(unchanged?.accessLevel).toBe("viewer");
  });
});

// ─── AC-5.2 / AC-5.4 — DELETE {collaboratorId}: owner-initiated revoke ─────

describe("AC-5.2 — DELETE {collaboratorId} revokes access, same refusal as an unrelated user", () => {
  it("204; the removed collaborator's resolveAccess (what GET/PUT gate on) returns null — same as a stranger's — and they drop out of the OR-listing query", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const targetId = "t9-ac52-target";
    const targetEmail = "ac52-target@example.com";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: targetId,
        email: targetEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    // Before removal: has a relationship, and would surface in their list.
    const beforeAccess = await Effect.runPromiseExit(resolveAccess(estimate.id, targetId));
    expect(beforeAccess._tag).toBe("Success");
    if (beforeAccess._tag === "Success") {
      expect(beforeAccess.value).not.toBeNull();
    }

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      { method: "DELETE", headers: bearerHeader(owner.id, owner.email) },
    );
    expect(res.status).toBe(204);

    const rowGone = await testDb.estimateCollaborator.findUnique({ where: { id: grant.id } });
    expect(rowGone).toBeNull();

    // Same taxonomy as AC-1.6's unrelated stranger: resolveAccess → null.
    // estimates.routes.ts's GET/PUT/DELETE `/estimates/{id}` handlers feed
    // this SAME null branch through the SAME unparameterised `problemNotFound`
    // call for both a genuine stranger and a just-removed collaborator (T6,
    // unchanged by T9) — so the two 404 Problem bodies are byte-identical BY
    // CONSTRUCTION, not by a second, separately-maintained check here.
    const afterAccess = await Effect.runPromiseExit(resolveAccess(estimate.id, targetId));
    expect(afterAccess._tag).toBe("Success");
    if (afterAccess._tag === "Success") {
      expect(afterAccess.value).toBeNull();
    }

    // Excluded from the OR-listing query estimates.repo.ts#listEstimates uses
    // (same shape as T8's AC-1.1 test).
    const listedRows = await testDb.estimate.findMany({
      where: { OR: [{ userId: targetId }, { collaborators: { some: { userId: targetId } } }] },
    });
    expect(listedRows.some((r) => r.id === estimate.id)).toBe(false);

    // Also gone from the owner's own GET .../collaborators.
    const listRes = await app.request(`/estimates/${estimate.id}/collaborators`, {
      headers: bearerHeader(owner.id, owner.email),
    });
    const list = (await listRes.json()) as { collaborators: Array<{ id: string }> };
    expect(list.collaborators.some((c) => c.id === grant.id)).toBe(false);
  });

  it("DELETE by an editor (not the owner) → 403 owner_only, grant unchanged", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const editorId = "t9-delete-by-editor";
    const editorEmail = "delete-by-editor@example.com";
    const targetGrant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: "t9-delete-target",
        email: "delete-target@example.com",
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: editorId,
        email: editorEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${targetGrant.id}`,
      { method: "DELETE", headers: bearerHeader(editorId, editorEmail) },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("owner_only");

    const stillThere = await testDb.estimateCollaborator.findUnique({
      where: { id: targetGrant.id },
    });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE by an unrelated stranger → 404, grant unchanged", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: "t9-delete-stranger-target",
        email: "delete-stranger-target@example.com",
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      {
        method: "DELETE",
        headers: bearerHeader("t9-delete-stranger", "delete-stranger@example.com"),
      },
    );

    expect(res.status).toBe(404);
    const stillThere = await testDb.estimateCollaborator.findUnique({ where: { id: grant.id } });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE on a fabricated grant id (AC-5.4) → 404, even for the real owner", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/does-not-exist`,
      { method: "DELETE", headers: bearerHeader(owner.id, owner.email) },
    );

    expect(res.status).toBe(404);
  });

  it("a grant id that belongs to a DIFFERENT estimate → 404 (never cross-estimate reachable)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimateA = await seedEstimate(owner.id, "T9 estimate A");
    const estimateB = await seedEstimate(owner.id, "T9 estimate B");
    const grantOnB = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimateB.id,
        userId: "t9-cross-estimate-target",
        email: "cross-estimate-target@example.com",
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    // Ask estimate A's collaborators route to delete estimate B's grant id.
    const res = await app.request(
      `/estimates/${estimateA.id}/collaborators/${grantOnB.id}`,
      { method: "DELETE", headers: bearerHeader(owner.id, owner.email) },
    );

    expect(res.status).toBe(404);
    const stillThere = await testDb.estimateCollaborator.findUnique({ where: { id: grantOnB.id } });
    expect(stillThere).not.toBeNull();
  });
});

// ─── AC-6.1 / AC-6.2 — DELETE me: leave ────────────────────────────────────

describe("AC-6.1 — a collaborator can remove themselves via DELETE .../collaborators/me", () => {
  it("a viewer's DELETE .../me → 204 (not 403 — proves the literal /me route is NOT swallowed as a fabricated {collaboratorId}), removes them from the owner's list and from the OR-listing query", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const viewerId = "t9-ac61-viewer";
    const viewerEmail = "ac61-viewer@example.com";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: viewerId,
        email: viewerEmail,
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators/me`, {
      method: "DELETE",
      headers: bearerHeader(viewerId, viewerEmail),
    });

    // A viewer is never the owner of anything, so IF the literal "me" path
    // segment had been swallowed by the owner-gated `{collaboratorId}` route
    // instead (the exact bug the required registration order prevents),
    // this would come back 403 owner_only, not 204.
    expect(res.status).toBe(204);

    const rowGone = await testDb.estimateCollaborator.findUnique({ where: { id: grant.id } });
    expect(rowGone).toBeNull();

    const listRes = await app.request(`/estimates/${estimate.id}/collaborators`, {
      headers: bearerHeader(owner.id, owner.email),
    });
    const list = (await listRes.json()) as { collaborators: Array<{ id: string }> };
    expect(list.collaborators.some((c) => c.id === grant.id)).toBe(false);

    const listedRows = await testDb.estimate.findMany({
      where: { OR: [{ userId: viewerId }, { collaborators: { some: { userId: viewerId } } }] },
    });
    expect(listedRows.some((r) => r.id === estimate.id)).toBe(false);
  });

  it("an editor's DELETE .../me → 204 as well", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const editorId = "t9-ac61-editor";
    const editorEmail = "ac61-editor@example.com";
    await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: editorId,
        email: editorEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators/me`, {
      method: "DELETE",
      headers: bearerHeader(editorId, editorEmail),
    });

    expect(res.status).toBe(204);
    const count = await testDb.estimateCollaborator.count({ where: { estimateId: estimate.id } });
    expect(count).toBe(0);
  });
});

describe("AC-6.2 — the owner has no grant to leave", () => {
  it("the owner's DELETE .../me → 404 not_a_collaborator (never a success, never a 403)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators/me`, {
      method: "DELETE",
      headers: bearerHeader(owner.id, owner.email),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_a_collaborator");

    // The estimate itself is completely unaffected.
    const stillOwned = await testDb.estimate.findUnique({ where: { id: estimate.id } });
    expect(stillOwned).not.toBeNull();
  });

  it("a genuine stranger's DELETE .../me → the SAME 404 not_a_collaborator (no existence leak beyond that)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators/me`, {
      method: "DELETE",
      headers: bearerHeader("t9-ac62-stranger", "ac62-stranger@example.com"),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_a_collaborator");
  });
});
