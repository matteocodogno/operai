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

// T10 — the same injectable-double treatment as checkAppAccess/resolveIdentities
// above, for the identical cross-file module-cache-race reason (file header).
const notifyModule = await import("@/lib/notify");
type NotifyCollaboratorGrantedFn = typeof notifyModule.notifyCollaboratorGranted;
type NotifyCollaboratorRemovedFn = typeof notifyModule.notifyCollaboratorRemoved;

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
  readonly notifyCollaboratorGranted: NotifyCollaboratorGrantedFn;
  readonly notifyCollaboratorRemoved: NotifyCollaboratorRemovedFn;
}

const alwaysIneligible: CheckAppAccessFn = async () => ({ eligible: false });
const emptyIdentities: ResolveIdentitiesFn = async () => new Map();
// T10 — silent no-op defaults so every T8/T9 test written before T10 existed
// keeps working unchanged; only the AC-7.x tests below override these with
// spies.
const noopNotifyGranted: NotifyCollaboratorGrantedFn = async () => {};
const noopNotifyRemoved: NotifyCollaboratorRemovedFn = async () => {};

function buildApp(deps: Partial<TestDeps> = {}) {
  const router = new OpenAPIHono<{ Variables: JwtVariables }>();
  router.use("*", testAuthMiddleware);
  registerCollaboratorRoutes(router, {
    checkAppAccess: deps.checkAppAccess ?? alwaysIneligible,
    resolveIdentities: deps.resolveIdentities ?? emptyIdentities,
    notifyCollaboratorGranted: deps.notifyCollaboratorGranted ?? noopNotifyGranted,
    notifyCollaboratorRemoved: deps.notifyCollaboratorRemoved ?? noopNotifyRemoved,
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
  it("POST /estimates/{id}/collaborators with no relationship → 404, byte-identical to a genuinely absent id", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const strangerAttempt = () =>
      app.request(`/estimates/${estimate.id}/collaborators`, {
        method: "POST",
        headers: bearerHeader("t8-stranger", "stranger@example.com"),
        body: JSON.stringify({ email: "someone@example.com", accessLevel: "viewer" }),
      });

    const strangerRes = await strangerAttempt();
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();

    // The SAME id is now genuinely absent — plan.md claims every
    // `…/collaborators` route's stranger 404 is byte-identical to a
    // genuinely absent id (AC-1.6), the same property
    // estimates.routes.test.ts's T6/AC-1.6 block proves for the plain
    // estimate routes. A differing `detail`/`code` here would be an
    // existence leak.
    await testDb.estimate.delete({ where: { id: estimate.id } });

    const absentRes = await strangerAttempt();
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    expect(strangerBody).toEqual(absentBody);
  });

  it("GET /estimates/{id}/collaborators with no relationship → 404, byte-identical to a genuinely absent id", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const strangerAttempt = () =>
      app.request(`/estimates/${estimate.id}/collaborators`, {
        headers: bearerHeader("t8-stranger-2", "stranger2@example.com"),
      });

    const strangerRes = await strangerAttempt();
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();

    await testDb.estimate.delete({ where: { id: estimate.id } });

    const absentRes = await strangerAttempt();
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    expect(strangerBody).toEqual(absentBody);
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

  it("PATCH by a viewer (not the owner) → 403 owner_only, level unchanged (AC-3.3 — no collaborator, whatever their own level, may manage collaborators)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const viewerId = "t9-patch-by-viewer";
    const viewerEmail = "patch-by-viewer@example.com";
    const targetGrant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: "t9-patch-target-viewer-case",
        email: "patch-target-viewer-case@example.com",
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
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

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${targetGrant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader(viewerId, viewerEmail),
        body: JSON.stringify({ accessLevel: "viewer" }),
      },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("owner_only");

    const unchanged = await testDb.estimateCollaborator.findUnique({
      where: { id: targetGrant.id },
    });
    expect(unchanged?.accessLevel).toBe("editor");
  });

  it("PATCH by an unrelated stranger → 404, byte-identical to a genuinely absent id", async () => {
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

    const strangerAttempt = () =>
      app.request(
        `/estimates/${estimate.id}/collaborators/${grant.id}`,
        {
          method: "PATCH",
          headers: bearerHeader("t9-patch-stranger", "patch-stranger@example.com"),
          body: JSON.stringify({ accessLevel: "editor" }),
        },
      );

    const strangerRes = await strangerAttempt();
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();

    // resolveAccess (the "no relationship to the ESTIMATE" check) runs
    // BEFORE the collaborator-grant lookup, so a stranger's 404 here is the
    // "Estimate not found" flavor, not the AC-5.4 fabricated-grant flavor —
    // deleting the estimate (cascades the grant row too) makes the SAME id
    // genuinely absent and must produce a byte-identical body.
    await testDb.estimate.delete({ where: { id: estimate.id } });

    const absentRes = await strangerAttempt();
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    expect(strangerBody).toEqual(absentBody);
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

  it("DELETE by a viewer (not the owner) → 403 owner_only, grant unchanged (AC-3.3 — no collaborator, whatever their own level, may manage collaborators)", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const viewerId = "t9-delete-by-viewer";
    const viewerEmail = "delete-by-viewer@example.com";
    const targetGrant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: "t9-delete-target-viewer-case",
        email: "delete-target-viewer-case@example.com",
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
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

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${targetGrant.id}`,
      { method: "DELETE", headers: bearerHeader(viewerId, viewerEmail) },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("owner_only");

    const stillThere = await testDb.estimateCollaborator.findUnique({
      where: { id: targetGrant.id },
    });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE by an unrelated stranger → 404, grant unchanged, byte-identical to a genuinely absent id", async () => {
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

    const strangerAttempt = () =>
      app.request(
        `/estimates/${estimate.id}/collaborators/${grant.id}`,
        {
          method: "DELETE",
          headers: bearerHeader("t9-delete-stranger", "delete-stranger@example.com"),
        },
      );

    const strangerRes = await strangerAttempt();
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();
    const stillThere = await testDb.estimateCollaborator.findUnique({ where: { id: grant.id } });
    expect(stillThere).not.toBeNull();

    // Same id, now genuinely absent (cascades the grant row too) — must
    // produce a byte-identical 404 Problem body (AC-1.6).
    await testDb.estimate.delete({ where: { id: estimate.id } });

    const absentRes = await strangerAttempt();
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    expect(strangerBody).toEqual(absentBody);
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

// ─── AC-5.3 — no live disconnection: revocation/downgrade is enforced on ────
// the collaborator's NEXT request only, never a forced real-time kick (QE
// gap-fill: AC-5.1/AC-5.2's "next request is refused" tests above already
// prove the POSITIVE half of this AC; nothing anywhere proved the NEGATIVE
// half plan.md itself concedes is untested ("no push/stream involvement
// asserted (no SSE subscription exists for estimates)") — this makes that
// absence an explicit, executed regression tripwire, the same style as the
// "no /system/* route" mutual-exclusion check directly below and AC-10.4's
// route-table check in orphaned-estimate.test.ts, rather than leaving the
// property entirely parasitic on AC-5.1/AC-5.2. ─────────────────────────────

describe("AC-5.3 — no live-disconnection mechanism exists for estimates (regression tripwire)", () => {
  it("estimai-api registers no stream/SSE/WebSocket route anywhere the estimates domain touches (index.ts, estimates.routes.ts, collaborators.routes.ts) — revocation has nothing live to push to", async () => {
    const filesToScan = ["../index.ts", "./estimates.routes.ts", "./collaborators.routes.ts"];
    for (const relativePath of filesToScan) {
      const source = await Bun.file(new URL(relativePath, import.meta.url)).text();
      // A route path shaped like a live-connection endpoint (mirrors
      // notify-api's OWN /notifications/stream — the ONE such route in the
      // whole suite, ADR-0008 — which estimai-api must never grow a sibling
      // of for estimates).
      expect(source).not.toMatch(/\.(get|post|put|patch|delete|route)\(\s*["'`][^"'`]*\/(stream|sse|socket|ws)\b/i);
      // No WebSocket/EventSource/SSE machinery imported or referenced at all.
      expect(source).not.toMatch(/WebSocket|EventSource|text\/event-stream|upgradeWebSocket/);
    }
  });

  it("revoking (DELETE {collaboratorId}) and downgrading (PATCH editor→viewer) a collaborator's access complete with 204/200 and NO thrown/rejected side effect beyond the best-effort notify call already covered by AC-7.2/AC-7.3 — there is no live session to forcibly terminate, so removal/downgrade is a plain DB write, nothing more", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const targetId = "t9-ac53-target";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: targetId,
        email: "ac53-target@example.com",
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });
    const app = buildApp();

    // Downgrade — no exception, no partial state (a real "kick" would need
    // some out-of-band channel; none is called here at all).
    const patchRes = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader(owner.id, owner.email),
        body: JSON.stringify({ accessLevel: "viewer" }),
      },
    );
    expect(patchRes.status).toBe(200);

    // Revoke entirely — same: a plain, synchronous DB write and an HTTP
    // response, nothing that could represent forcing an open session closed.
    const deleteRes = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      { method: "DELETE", headers: bearerHeader(owner.id, owner.email) },
    );
    expect(deleteRes.status).toBe(204);

    // Enforcement is confirmed on the collaborator's NEXT request only
    // (AC-5.1/AC-5.2 already cover this positively) — restated here just to
    // anchor that "next request" is the ONLY enforcement point exercised;
    // nothing above simulated or asserted an in-flight/open-session kick,
    // because the codebase has no such mechanism to simulate.
    const grantAfter = await testDb.estimateCollaborator.findUnique({
      where: { id: grant.id },
    });
    expect(grantAfter).toBeNull();
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

  it("a genuine stranger's DELETE .../me → the SAME 404 not_a_collaborator (no existence leak beyond that), byte-identical to a genuinely absent id", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const strangerAttempt = () =>
      app.request(`/estimates/${estimate.id}/collaborators/me`, {
        method: "DELETE",
        headers: bearerHeader("t9-ac62-stranger", "ac62-stranger@example.com"),
      });

    const strangerRes = await strangerAttempt();
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();
    expect((strangerBody as { code: string }).code).toBe("not_a_collaborator");

    // `/me` never calls resolveAccess at all (this file's header) — it
    // looks up the caller's OWN grant directly, so the SAME body must come
    // back whether the estimate exists (and the caller merely has no grant
    // on it) or has been deleted outright.
    await testDb.estimate.delete({ where: { id: estimate.id } });

    const absentRes = await strangerAttempt();
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    expect(strangerBody).toEqual(absentBody);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T10 — notification wiring (AC-7.1, AC-7.2, AC-7.3, specs/013-estimate-sharing)
// ═══════════════════════════════════════════════════════════════════════════
//
// notify.ts's own HTTP-payload shape (originApp:"estimai", the granted link,
// the removed link's absence, truncation, never-throws) is already fully
// covered by src/lib/notify.test.ts (T5) — these tests are scoped to the
// WIRING: does collaborators.routes.ts call the right notify function, with
// the right input, exactly once, on exactly the right paths, and does a
// notify failure ever leak into the HTTP response or roll back the DB write.

describe("AC-7.1 — POST grant → notifyCollaboratorGranted called exactly once, with the right input", () => {
  it("recipientId is the target's RESOLVED userId, plus estimateId/estimateName/accessLevel — and the grant persists even when notify THROWS", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id, "AC-7.1 fixture estimate");
    const targetId = "t10-ac71-target";
    const targetEmail = "ac71-target@example.com";

    const notifyCollaboratorGranted = mock<NotifyCollaboratorGrantedFn>(async () => {
      throw new Error("notify-api unreachable (test double)");
    });

    const app = buildApp({
      checkAppAccess: eligibleFor(targetEmail, targetId),
      notifyCollaboratorGranted,
    });

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: targetEmail, accessLevel: "editor" }),
    });

    // The 201 and the persisted grant are UNAFFECTED by the throwing double
    // (bestEffortNotify's defense-in-depth catch, T10) — the notify failure
    // never rolls back the already-committed INSERT.
    expect(res.status).toBe(201);
    const grant = await testDb.estimateCollaborator.findUnique({
      where: { estimateId_userId: { estimateId: estimate.id, userId: targetId } },
    });
    expect(grant).not.toBeNull();

    expect(notifyCollaboratorGranted.mock.calls.length).toBe(1);
    const [input] = notifyCollaboratorGranted.mock.calls[0]!;
    expect(input).toEqual({
      recipientId: targetId,
      estimateId: estimate.id,
      estimateName: "AC-7.1 fixture estimate",
      accessLevel: "editor",
    });
  });

  it("is NOT called on the generic-rejection path (AC-1.2) — notify only ever fires after a successful INSERT", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const notifyCollaboratorGranted = mock<NotifyCollaboratorGrantedFn>(async () => {});
    const app = buildApp({ checkAppAccess: alwaysIneligible, notifyCollaboratorGranted });

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      method: "POST",
      headers: bearerHeader(owner.id, owner.email),
      body: JSON.stringify({ email: "never-eligible@example.com", accessLevel: "viewer" }),
    });

    expect(res.status).toBe(422);
    expect(notifyCollaboratorGranted.mock.calls.length).toBe(0);
  });
});

describe("AC-7.2 — owner-initiated DELETE {collaboratorId} → notifyCollaboratorRemoved called once, no link; self-leave sends nothing", () => {
  it("recipientId is the REMOVED collaborator's userId, no `link` field in the input at all — and the removal persists even when notify THROWS", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id, "AC-7.2 fixture estimate");
    const targetId = "t10-ac72-target";
    const targetEmail = "ac72-target@example.com";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: targetId,
        email: targetEmail,
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });

    const notifyCollaboratorRemoved = mock<NotifyCollaboratorRemovedFn>(async () => {
      throw new Error("notify-api unreachable (test double)");
    });
    const app = buildApp({ notifyCollaboratorRemoved });

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      { method: "DELETE", headers: bearerHeader(owner.id, owner.email) },
    );

    // 204 and the removal are UNAFFECTED by the throwing double.
    expect(res.status).toBe(204);
    const rowGone = await testDb.estimateCollaborator.findUnique({ where: { id: grant.id } });
    expect(rowGone).toBeNull();

    expect(notifyCollaboratorRemoved.mock.calls.length).toBe(1);
    const [input] = notifyCollaboratorRemoved.mock.calls[0]!;
    // NotifyCollaboratorRemovedInput has no `link` field AT ALL (see
    // src/lib/notify.ts) — the type system, not a runtime check, is what
    // makes "no link" true here; this asserts the exact input shape has
    // nothing beyond recipientId/estimateId/estimateName.
    expect(input).toEqual({
      recipientId: targetId,
      estimateId: estimate.id,
      estimateName: "AC-7.2 fixture estimate",
    });
    expect(Object.keys(input)).toEqual(["recipientId", "estimateId", "estimateName"]);
  });

  it("self-leave (DELETE .../me) calls NEITHER notify function", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const viewerId = "t10-ac72-selfleave";
    const viewerEmail = "ac72-selfleave@example.com";
    await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: viewerId,
        email: viewerEmail,
        accessLevel: "viewer",
        grantedByUserId: owner.id,
      },
    });

    const notifyCollaboratorGranted = mock<NotifyCollaboratorGrantedFn>(async () => {});
    const notifyCollaboratorRemoved = mock<NotifyCollaboratorRemovedFn>(async () => {});
    const app = buildApp({ notifyCollaboratorGranted, notifyCollaboratorRemoved });

    const res = await app.request(`/estimates/${estimate.id}/collaborators/me`, {
      method: "DELETE",
      headers: bearerHeader(viewerId, viewerEmail),
    });

    expect(res.status).toBe(204);
    expect(notifyCollaboratorRemoved.mock.calls.length).toBe(0);
    expect(notifyCollaboratorGranted.mock.calls.length).toBe(0);
  });
});

describe("AC-7.3 — no notification for a PATCH level change (silent by design)", () => {
  it("editor→viewer PATCH calls NEITHER notify function", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const editorId = "t10-ac73-editor";
    const editorEmail = "ac73-editor@example.com";
    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: editorId,
        email: editorEmail,
        accessLevel: "editor",
        grantedByUserId: owner.id,
      },
    });

    const notifyCollaboratorGranted = mock<NotifyCollaboratorGrantedFn>(async () => {});
    const notifyCollaboratorRemoved = mock<NotifyCollaboratorRemovedFn>(async () => {});
    const app = buildApp({ notifyCollaboratorGranted, notifyCollaboratorRemoved });

    const res = await app.request(
      `/estimates/${estimate.id}/collaborators/${grant.id}`,
      {
        method: "PATCH",
        headers: bearerHeader(owner.id, owner.email),
        body: JSON.stringify({ accessLevel: "viewer" }),
      },
    );

    expect(res.status).toBe(200);
    expect(notifyCollaboratorGranted.mock.calls.length).toBe(0);
    expect(notifyCollaboratorRemoved.mock.calls.length).toBe(0);
  });
});

describe("AC-7.3 — no notification anywhere in estimates.routes.ts (PUT /estimates/{id} and every other CRUD route)", () => {
  it("estimates.routes.ts contains no reference to @/lib/notify or a notifyCollaborator* call — the file that owns PUT/GET/DELETE /estimates/{id} never imports the notify client at all, so no runtime path there can ever fire a push", async () => {
    // A static/contract guard, not a runtime spy: PUT's handler lives in a
    // COMPLETELY SEPARATE file from collaborators.routes.ts (T10's only
    // touch point), and per plan.md/tasks.md T10's scope, that file is never
    // touched by this feature. Grepping its source is a stronger, regression-
    // proof guarantee than a runtime assertion could be — a future edit that
    // accidentally wires notify.ts into estimates.routes.ts would fail this
    // test immediately, without needing to enumerate every CRUD route.
    const source = await Bun.file(
      new URL("./estimates.routes.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("lib/notify");
    expect(source).not.toContain("notifyCollaborator");
  });
});

describe("Mutual exclusion (ADR-0011's invariant, extended to the third token holder) — collaborator routes accept ONLY a user JWT, never X-Internal-Token; estimai-api exposes no /system/* route", () => {
  it("a request carrying X-Internal-Token but NO Authorization Bearer header is rejected (401), not treated as an alternative credential", async () => {
    const owner = freshOwner();
    ownerIdsToClean.add(owner.id);
    const estimate = await seedEstimate(owner.id);
    const app = buildApp();

    const res = await app.request(`/estimates/${estimate.id}/collaborators`, {
      headers: {
        "X-Internal-Token": "test-notify-internal-token-at-least-32-characters",
      },
    });

    // registerCollaboratorRoutes adds NO auth logic of its own — the ENTIRE
    // credential check is the router's own Bearer-JWT middleware (the real
    // jwtMiddleware in production, testAuthMiddleware here). Neither reads
    // X-Internal-Token at all, so it is simply absent evidence, not an
    // alternative credential — the request is unauthenticated, full stop.
    expect(res.status).toBe(401);
  });

  it("estimai-api registers no /system/* route anywhere (index.ts, collaborators.routes.ts, estimates.routes.ts, health.routes.ts) — it is an outbound notify-api CALLER only, never an inbound internal-token SERVER (ADR-0040)", async () => {
    const filesToScan = [
      "../index.ts",
      "./estimates.routes.ts",
      "./collaborators.routes.ts",
      "../health/health.routes.ts",
    ];
    for (const relativePath of filesToScan) {
      const source = await Bun.file(new URL(relativePath, import.meta.url)).text();
      // Matches a route-registration call targeting a "/system" path
      // (e.g. `.get("/system/...`, `.post('/system/...`) — NOT merely the
      // substring "/system" appearing in a comment or doc string, so this
      // stays robust to prose mentioning ADR-0011/0017/0040's /system/*
      // precedent in notify-api.
      expect(source).not.toMatch(/\.(get|post|put|patch|delete|route)\(\s*["'`]\/system/);
    }
  });
});
