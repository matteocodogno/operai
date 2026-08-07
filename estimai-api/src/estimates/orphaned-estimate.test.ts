/**
 * Cross-service test — an estimate owner's soft-delete in `auth` leaves the
 * estimate and every collaborator grant untouched in `estimai-api` (T12,
 * specs/013-estimate-sharing — refs AC-10.1, AC-10.2, AC-10.3, AC-10.4;
 * plan.md "Data model" → "Cascade behaviour" → "US-10 (owner soft-deleted)").
 *
 * WHAT THIS TEST IS ACTUALLY PROVING
 * ───────────────────────────────────
 * AC-10.1 is satisfied by the ABSENCE of a mechanism, not the presence of
 * one: `estimai-api` has no FK to `auth`'s `user` table (separate logical
 * databases), and ADR-0012 point 3 already fixes that resource servers do
 * nothing at delete time. A test that only re-reads the estimate row after
 * calling auth's delete route and finds it unchanged would ALSO pass if a
 * future well-intentioned change added a delete-time cascade that happened
 * to be a no-op for this fixture (e.g. an early-return bug, or a cascade
 * that only fires for a *different* condition) — it would prove nothing
 * about the absence of the call. This file additionally spies on global
 * `fetch` for the exact duration of the real `auth` delete-route call and
 * asserts it was invoked ZERO times — that is the actual claim under test.
 *
 * WHY THIS RUNS auth's REAL SOFT-DELETE CODE, NOT A RE-IMPLEMENTATION
 * ─────────────────────────────────────────────────────────────────────
 * Re-deriving "what auth's soft-delete does" (e.g. a raw
 * `UPDATE "user" SET "deletedAt" = now()`) and then asserting estimai-api is
 * unaffected would prove nothing about the REAL code path — it would only
 * prove that OUR OWN SQL doesn't call estimai-api, which nobody doubts. This
 * file instead imports `auth/src/admin/users.routes.ts`'s real `usersRouter`
 * and drives its real `DELETE /admin/users/:id` handler (`withAudit` +
 * `tx.user.update` + `tx.session.deleteMany`, verbatim production code)
 * against a REAL Postgres row in the REAL `auth` database (`operai_auth`,
 * localhost:5435) — exactly mirroring the pattern
 * `auth/src/admin/users.routes.test.ts` already uses for its own coverage:
 *   - `mock.module(".../auth/auth.config", …)` replaces only the
 *     better-auth SESSION SOURCE `requireAuth`/`requireAdmin` read (so this
 *     test can "log in" as a seeded admin without a real OAuth round trip;
 *     `sessionMiddleware` calls `auth.api.getSession()`, that's the only
 *     seam being substituted) — the real `requireAdmin` role-membership
 *     query, the real `withAudit` transaction, the real last-admin guard,
 *     and the real Prisma writes all run unmocked.
 *   - `usersRouter.request(...)` dispatches in-process (no listening HTTP
 *     server needed — this is Hono's own built-in test helper, not a
 *     network call).
 *
 * WHY estimai-api's HALF USES estimates.repo.ts / collaborators.routes.ts
 * DIRECTLY, NOT THE REAL `estimatesRouter` SINGLETON OVER HTTP
 * ─────────────────────────────────────────────────────────────────────────
 * `estimates.routes.ts` exports `estimatesRouter` as a MODULE-LEVEL
 * SINGLETON wired to `@/auth/jwt.middleware` at ITS OWN first-import time.
 * `estimates.routes.test.ts` already owns a process-wide
 * `mock.module("@/auth/jwt.middleware", …)` for its OWN three fixture users
 * (A/B/C) — see that file's header and `collaborators.routes.test.ts`'s
 * header for the exact hazard: `bun test` shares ONE process/module cache
 * across every `*.test.ts` file, so whichever test file's mock happens to
 * bind first (a filesystem-traversal-order race) would win for every other
 * file's requests for the rest of the run. `collaborators.routes.test.ts`
 * already resolved this by building a fully isolated router + injectable
 * deps for the collaborator-management routes; this file reuses that exact
 * `registerCollaboratorRoutes(isolatedRouter, deps)` pattern for
 * GET/POST/PATCH/DELETE `.../collaborators`, and calls `getEstimateById` /
 * `updateEstimate` / `deleteEstimate` from `estimates.repo.ts` directly for
 * plain-estimate GET/PUT/DELETE — the SAME functions the real
 * `estimatesRouter` route handlers call, DB-only, no HTTP/JWT layer
 * involved at all. `collaborators.routes.test.ts`'s own T9 section already
 * establishes this as "the most faithful proof available without
 * reintroducing the jwt.middleware mock race" — this file follows the same
 * precedent. (`estimatesRouter.routes` — the STATIC route table, never
 * dispatched — is still imported for the route-table assertion below; that
 * is safe regardless of which jwtMiddleware mock is active, since no
 * request is ever sent to it.)
 *
 * WHY auth's db.ts / estimai-api's db.ts ARE EACH GIVEN A DEDICATED FRESH
 * PRISMA CLIENT VIA mock.module, NEVER IMPORTED FOR REAL
 * ─────────────────────────────────────────────────────────────────────────
 * Both `auth/src/lib/db.ts` and `estimai-api/src/lib/db.ts` cache their
 * PrismaClient on the SAME global slot (`globalThis.prisma`, their "reuse
 * across `bun --hot` reloads" mechanism) — `db.ts ?? new PrismaClient(...)`.
 * If this file let BOTH real `db.ts` modules execute in the same process,
 * whichever imports first would win that global slot, and the SECOND
 * service's `db` export would silently become the FIRST service's
 * PrismaClient (wrong generated model types, wrong database, wrong Postgres
 * schema — `db.estimate` doesn't exist on auth's client and vice versa).
 * Mocking `@/lib/db` (estimai-api) and `<auth>/lib/db` (auth) with
 * independent, purpose-built clients — mirroring the exact
 * dotenv-restore-then-fresh-client technique `estimates.routes.test.ts` /
 * `collaborators.routes.test.ts` already use for estimai-api's own DB —
 * means the real `db.ts` files (and their shared global slot) never run at
 * all, so there is no collision to reason about.
 *
 * ENV — see estimai-api/.env (minimal, per the task's env-doctor note) plus
 * the `??=` guards below, which mirror every sibling test file's defensive
 * pattern (this file may run before OR after `estimates.routes.test.ts` /
 * `collaborators.routes.test.ts` in the shared `bun test` process).
 */

import { describe, it, expect, beforeAll, afterAll, spyOn, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { Effect } from "effect";
import { config as dotenvConfig } from "dotenv";
import { ForbiddenError } from "@/lib/errors";
import type { JwtVariables } from "@/auth/jwt.middleware";

// ─── estimai-api env guards (mirrors estimates.routes.test.ts /
// collaborators.routes.test.ts / authClient.test.ts's `??=` pattern) ────────

process.env["DATABASE_URL"] ??=
  "postgresql://postgres:postgres@localhost:5435/estimai";
process.env["ALLOWED_ORIGINS"] ??= "http://localhost:5173";
process.env["AUTH_JWKS_URL"] ??= "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] ??= "http://localhost:3001";
process.env["AUTH_AUDIENCE"] ??= "operai-suite";
process.env["NODE_ENV"] ??= "test";
process.env["AUTH_BASE_URL"] ??= "http://localhost:3001";
process.env["NOTIFY_INTERNAL_TOKEN"] ??=
  "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] ??= "http://localhost:8081";

// Restore the REAL DATABASE_URL from estimai-api/.env (an earlier-run test
// file may have clobbered it) BEFORE building estimai-api's fresh client.
dotenvConfig({
  path: new URL("../../.env", import.meta.url).pathname,
  override: true,
});

const ESTIMAI_DATABASE_URL = process.env["DATABASE_URL"]!;

// `auth`'s own DATABASE_URL is a SEPARATE database (operai_auth) on the same
// Postgres instance — never read from estimai-api's own .env. AUTH_DATABASE_URL
// is this file's own escape hatch (not part of estimai-api's env contract) for
// an environment where the local default differs; it is not required anywhere
// else in this codebase.
const AUTH_DATABASE_URL =
  process.env["AUTH_DATABASE_URL"] ??
  "postgresql://postgres:postgres@localhost:5435/operai_auth";

// ─── estimai-api: fresh Prisma client + @/lib/db mock ──────────────────────

const { PrismaClient: EstimaiPrismaClient } = await import(
  "@/lib/generated/prisma/client"
);
const { PrismaPg: EstimaiPrismaPg } = await import("@prisma/adapter-pg");

const estimaiDb = new EstimaiPrismaClient({
  adapter: new EstimaiPrismaPg({ connectionString: ESTIMAI_DATABASE_URL }),
});

mock.module("@/lib/db", () => ({ db: estimaiDb }));

// ─── auth: fresh Prisma client + <auth>/lib/db mock ────────────────────────
//
// Every cross-repo specifier below is built as a RUNTIME STRING (joined
// path segments, never a string literal) and passed to `import()`/
// `mock.module()`. TypeScript infers `Promise<any>` for a dynamic `import()`
// whose specifier is not a literal, which deliberately keeps `auth`'s own
// source tree OUT of estimai-api's `tsc --noEmit` program — a literal
// `import("../../../auth/src/...")` would pull auth's entire type graph
// (checked under estimai-api's OWN tsconfig strictness settings) into
// estimai-api's typecheck output, a cross-project coupling this repo's
// per-app-independent-tooling posture (CLAUDE.md) does not want.
const authSrc = ["..", "..", "..", "auth", "src"].join("/");
const p = (...segments: string[]) => [authSrc, ...segments].join("/");

const { PrismaClient: AuthPrismaClient } = (await import(
  p("lib", "generated", "prisma", "client")
)) as { PrismaClient: new (opts: { adapter: unknown }) => AuthDb };
const { PrismaPg: AuthPrismaPg } = await import("@prisma/adapter-pg");

// Minimal structural type for the handful of auth-db calls this file makes —
// deliberately NOT importing auth's generated Prisma types (see note above).
interface AuthDb {
  user: {
    create: (args: {
      data: { name: string; email: string; emailVerified: boolean };
    }) => Promise<{ id: string; email: string }>;
    findUniqueOrThrow: (args: {
      where: { id: string };
    }) => Promise<{ id: string; deletedAt: Date | null }>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
  };
  role: {
    upsert: (args: {
      where: { name: string };
      update: Record<string, never>;
      create: { name: string; isSystem: boolean };
    }) => Promise<{ id: string }>;
  };
  userRole: {
    create: (args: {
      data: { userId: string; roleId: string };
    }) => Promise<unknown>;
    deleteMany: (args: { where: { userId: { in: string[] } } }) => Promise<unknown>;
  };
}

const authDb = new AuthPrismaClient({
  adapter: new AuthPrismaPg({ connectionString: AUTH_DATABASE_URL }),
});

mock.module(p("lib", "db"), () => ({ db: authDb }));

// ─── auth: fake session source (mirrors auth/src/admin/users.routes.test.ts) ─
//
// Substitutes ONLY `auth.api.getSession` (the one seam `sessionMiddleware`
// reads) — `requireAuth`, `requireAdmin` (real role-membership query),
// `withAudit`, and every Prisma write in the real `deleteUserRoute` handler
// run unmocked, against the real `operai_auth` database.

type FakeAuthSession = {
  user: { id: string; email: string; name: string };
  session: { id: string };
} | null;

let currentAuthSession: FakeAuthSession = null;

mock.module(p("auth", "auth.config"), () => ({
  auth: {
    api: {
      getSession: async () => currentAuthSession,
    },
  },
}));

function actAsAuthAdmin(userId: string, email: string): void {
  currentAuthSession = {
    user: { id: userId, email, name: email },
    session: { id: `t12-sess-${userId}` },
  };
}

// Dynamic imports AFTER both `mock.module` calls are registered.
const { usersRouter } = (await import(p("admin", "users.routes"))) as {
  usersRouter: { request: (path: string, init?: RequestInit) => Promise<Response> };
};

// ─── estimai-api: real repo functions (DB-only, no HTTP/JWT layer) ─────────

const { getEstimateById, updateEstimate, deleteEstimate } = await import(
  "./estimates.repo"
);
const { resolveAccess } = await import("./access");
// `estimatesRouter` — imported ONLY for its STATIC `.routes` table (the
// route-table assertion). Never dispatched — see file header.
const { estimatesRouter } = await import("./estimates.routes");

// ─── estimai-api: isolated collaborator-management router (mirrors
// collaborators.routes.test.ts's own test-only auth middleware verbatim —
// NOT the real jwtMiddleware, no crypto/JWKS setup) ─────────────────────────

const { registerCollaboratorRoutes } = await import("./collaborators.routes");

const TEST_BEARER_PREFIX = "Bearer test|";

const testAuthMiddleware = createMiddleware<{ Variables: JwtVariables }>(
  async (c, next) => {
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
  },
);

const bearerHeader = (userId: string, email: string) => ({
  Authorization: `Bearer test|${userId}|${email}`,
  "Content-Type": "application/json",
});

const collaboratorsRouter = new OpenAPIHono<{ Variables: JwtVariables }>();
collaboratorsRouter.use("*", testAuthMiddleware);
// notifyCollaboratorGranted/notifyCollaboratorRemoved (T10 widened
// CollaboratorRouteDeps to require these) are stubbed as inert `mock()`
// spies rather than plain no-op functions: every AC-10.4 route below is
// exercised expecting a pre-notify 403 (`owner_only`, thrown by
// `resolveAccess`/the owner-only guard before any notify call site is
// reached), so asserting zero calls on both spies is a free correctness
// strengthening — it would catch a future regression that let a
// non-owner request reach the grant/removal notify path. See the
// "AC-10.4 — notify spies" describe block below for the assertions.
const notifyCollaboratorGranted = mock(async () => {});
const notifyCollaboratorRemoved = mock(async () => {});
registerCollaboratorRoutes(collaboratorsRouter, {
  checkAppAccess: async () => ({ eligible: false }),
  resolveIdentities: async () => new Map(),
  notifyCollaboratorGranted,
  notifyCollaboratorRemoved,
});

// ─── Fixture ids ─────────────────────────────────────────────────────────

const RUN_ID = crypto.randomUUID().slice(0, 8);
// The owner + admin ids are auth-generated cuids (`@default(cuid())` on
// auth's `User` model) — captured into these `let`s once `beforeAll` creates
// the rows, never hardcoded (there is no way to choose a Prisma cuid).
let OWNER_AUTH_ID: string;
const OWNER_EMAIL = `t12-owner-${RUN_ID}@operai.test`;
let ADMIN_AUTH_ID: string;
const ADMIN_EMAIL = `t12-admin-${RUN_ID}@operai.test`;
const EDITOR_ID = `t12-editor-${RUN_ID}`;
const EDITOR_EMAIL = `t12-editor-${RUN_ID}@example.com`;
const VIEWER_ID = `t12-viewer-${RUN_ID}`;
const VIEWER_EMAIL = `t12-viewer-${RUN_ID}@example.com`;

const makeContent = () => ({
  params: {
    parallelism: 0.7,
    sprintDays: 10,
    workingDaysMonth: 20,
    qaDeployDays: 0,
    qaTestDays: 0,
    pmDays: 0,
    aiCostCoef: 10,
    aiGain: 0.3,
  },
  releases: [{ id: "rel-1", name: "Release 1", fte: 2 }],
  acts: [
    {
      id: "act-1",
      num: 1,
      epic: "Auth",
      act: "Orphaned estimate fixture",
      prof: "Backend Dev",
      o: 1,
      ml: 2,
      p: 4,
      risk: 0.1,
      release: "rel-1",
    },
  ],
});

// ─── Shared fixture state, populated once in beforeAll ─────────────────────

let estimateId: string;
let editorGrantId: string;
let viewerGrantId: string;

let estimateBefore: Awaited<ReturnType<typeof estimaiDb.estimate.findUniqueOrThrow>>;
let collaboratorsBefore: Awaited<
  ReturnType<typeof estimaiDb.estimateCollaborator.findMany>
>;
let deleteRouteResponse: { status: number; body: { deletedAt?: string; status?: number } };
let fetchCallsDuringDelete: number;

beforeAll(async () => {
  // ── auth fixtures: an admin (the acting caller) + the owner-to-be-deleted.
  // AC-5.6 forbids self-delete, so these MUST be two distinct accounts.
  const admin = await authDb.user.create({
    data: { name: `T12 admin ${RUN_ID}`, email: ADMIN_EMAIL, emailVerified: true },
  });
  const owner = await authDb.user.create({
    data: { name: `T12 owner ${RUN_ID}`, email: OWNER_EMAIL, emailVerified: true },
  });
  expect(owner.id).toBeTruthy();
  OWNER_AUTH_ID = owner.id;
  ADMIN_AUTH_ID = admin.id;
  const adminRole = await authDb.role.upsert({
    where: { name: "admin" },
    update: {},
    create: { name: "admin", isSystem: true },
  });
  await authDb.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  // ── estimai-api fixtures: an estimate owned by the REAL auth owner id,
  // plus one editor and one viewer collaborator grant (arbitrary ids — no
  // FK to auth, ADR-0036, so these need not be real auth accounts).
  const content = makeContent();
  const sizeBytes = new TextEncoder().encode(JSON.stringify(content)).length;
  const estimate = await estimaiDb.estimate.create({
    data: {
      userId: owner.id,
      name: "T12 orphaned-estimate fixture",
      author: "",
      sizeBytes,
      content,
    },
  });
  estimateId = estimate.id;

  const editorGrant = await estimaiDb.estimateCollaborator.create({
    data: {
      estimateId,
      userId: EDITOR_ID,
      email: EDITOR_EMAIL,
      accessLevel: "editor",
      grantedByUserId: owner.id,
    },
  });
  editorGrantId = editorGrant.id;

  const viewerGrant = await estimaiDb.estimateCollaborator.create({
    data: {
      estimateId,
      userId: VIEWER_ID,
      email: VIEWER_EMAIL,
      accessLevel: "viewer",
      grantedByUserId: owner.id,
    },
  });
  viewerGrantId = viewerGrant.id;

  // ── Snapshot BEFORE — the estimate row and both grant rows, in full.
  estimateBefore = await estimaiDb.estimate.findUniqueOrThrow({ where: { id: estimateId } });
  collaboratorsBefore = await estimaiDb.estimateCollaborator.findMany({
    where: { estimateId },
    orderBy: { id: "asc" },
  });

  // ── The claim under test: auth's REAL soft-delete route, for real, makes
  // NO network call of any kind (in particular, none into estimai-api).
  // spyOn keeps the real fetch implementation (calls through) so nothing
  // besides the assertion below changes — a call would still succeed (and
  // be recorded), it just must never happen.
  const fetchSpy = spyOn(globalThis, "fetch");

  actAsAuthAdmin(admin.id, admin.email);
  const res = await usersRouter.request(`/admin/users/${owner.id}`, {
    method: "DELETE",
  });
  const body = (await res.json()) as { deletedAt?: string; status?: number };
  deleteRouteResponse = { status: res.status, body };

  fetchCallsDuringDelete = fetchSpy.mock.calls.length;
  fetchSpy.mockRestore();
});

afterAll(async () => {
  await estimaiDb.estimate.deleteMany({ where: { id: estimateId } });
  await authDb.userRole.deleteMany({ where: { userId: { in: [ADMIN_AUTH_ID, OWNER_AUTH_ID] } } });
  await authDb.user.deleteMany({ where: { id: { in: [ADMIN_AUTH_ID, OWNER_AUTH_ID] } } });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("T12 — auth's real soft-delete of an estimate owner", () => {
  it("succeeds (200) and actually sets deletedAt on the owner's auth row", async () => {
    expect(deleteRouteResponse.status).toBe(200);
    expect(deleteRouteResponse.body.deletedAt).toBeTruthy();

    const ownerRow = await authDb.user.findUniqueOrThrow({ where: { id: OWNER_AUTH_ID } });
    expect(ownerRow.deletedAt).not.toBeNull();
  });

  it("AC-10.1 (the absence of a mechanism): makes ZERO network calls — none into estimai-api, none anywhere", () => {
    expect(fetchCallsDuringDelete).toBe(0);
  });
});

describe("AC-10.1 — the estimate row and every collaborator grant are byte-identical afterwards", () => {
  it("the estimate row is unchanged", async () => {
    const estimateAfter = await estimaiDb.estimate.findUniqueOrThrow({
      where: { id: estimateId },
    });
    expect(estimateAfter).toEqual(estimateBefore);
  });

  it("every EstimateCollaborator row is unchanged", async () => {
    const collaboratorsAfter = await estimaiDb.estimateCollaborator.findMany({
      where: { estimateId },
      orderBy: { id: "asc" },
    });
    expect(collaboratorsAfter).toEqual(collaboratorsBefore);
    expect(collaboratorsAfter.length).toBe(2);
  });
});

describe("AC-10.2 — the editor collaborator keeps exactly the same capabilities", () => {
  it("GET succeeds with unchanged content", async () => {
    const exit = await Effect.runPromiseExit(getEstimateById(estimateId, EDITOR_ID));
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.access).toBe("editor");
      // See AC-10.3's identical cast note below — `estimateBefore.content`
      // is Prisma's `JsonValue` (includes `null`); this fixture's content is
      // always a real object.
      expect(exit.value.content).toEqual(
        estimateBefore.content as typeof exit.value.content,
      );
    }
  });

  it("PUT (with a valid If-Match/version) succeeds and persists the edit", async () => {
    const current = await estimaiDb.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    const newContent = { ...makeContent(), releases: [{ id: "rel-1", name: "Edited by editor", fte: 3 }] };

    const exit = await Effect.runPromiseExit(
      updateEstimate(estimateId, EDITOR_ID, current.version, current.name, current.author, newContent),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.content).toEqual(newContent);
      expect(exit.value.version).toBe(current.version + 1);
    }

    const persisted = await estimaiDb.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(persisted.content).toEqual(newContent);
  });
});

describe("AC-10.3 — the viewer collaborator keeps exactly the same capabilities", () => {
  it("GET succeeds and returns the estimate's current content", async () => {
    const current = await estimaiDb.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    const exit = await Effect.runPromiseExit(getEstimateById(estimateId, VIEWER_ID));
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.access).toBe("viewer");
      // `current.content` is Prisma's `JsonValue` (includes `null`); this
      // fixture's row always has real object content, never null — cast to
      // compare against `EstimateContent` structurally.
      expect(exit.value.content).toEqual(current.content as typeof exit.value.content);
    }
  });
});

// [userId, email] pairs for both remaining collaborators — a typed tuple
// array (not an inline array literal) so `for (const [userId, email] of …)`
// destructures to `string`, not `string | undefined`.
const REMAINING_COLLABORATORS: ReadonlyArray<readonly [string, string]> = [
  [EDITOR_ID, EDITOR_EMAIL],
  [VIEWER_ID, VIEWER_EMAIL],
];

describe("AC-10.4 — every owner-only operation is now permanently unavailable to every remaining collaborator", () => {
  it("DELETE /estimates/{id} → 403 owner_only for both the editor and the viewer", async () => {
    for (const collaborator of [EDITOR_ID, VIEWER_ID]) {
      const exit = await Effect.runPromiseExit(deleteEstimate(estimateId, collaborator));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const cause = exit.cause;
        expect(cause._tag).toBe("Fail");
        if (cause._tag === "Fail") {
          expect(cause.error).toBeInstanceOf(ForbiddenError);
          expect((cause.error as ForbiddenError).code).toBe("owner_only");
        }
      }
    }

    // The estimate must still exist — none of the above deleted it.
    const stillThere = await estimaiDb.estimate.findUnique({ where: { id: estimateId } });
    expect(stillThere).not.toBeNull();
  });

  it("GET /estimates/{id}/collaborators → 403 owner_only for both the editor and the viewer", async () => {
    for (const [userId, email] of REMAINING_COLLABORATORS) {
      const res = await collaboratorsRouter.request(`/estimates/${estimateId}/collaborators`, {
        headers: bearerHeader(userId, email),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("owner_only");
    }
  });

  it("POST /estimates/{id}/collaborators → 403 owner_only for both the editor and the viewer", async () => {
    for (const [userId, email] of REMAINING_COLLABORATORS) {
      const res = await collaboratorsRouter.request(`/estimates/${estimateId}/collaborators`, {
        method: "POST",
        headers: bearerHeader(userId, email),
        body: JSON.stringify({ email: "someone-new@example.com", accessLevel: "viewer" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("owner_only");
    }

    // No grant was created by either attempt.
    const count = await estimaiDb.estimateCollaborator.count({ where: { estimateId } });
    expect(count).toBe(2);
  });

  it("PATCH /estimates/{id}/collaborators/{collaboratorId} → 403 owner_only for both the editor and the viewer", async () => {
    for (const [userId, email] of REMAINING_COLLABORATORS) {
      const res = await collaboratorsRouter.request(
        `/estimates/${estimateId}/collaborators/${viewerGrantId}`,
        {
          method: "PATCH",
          headers: bearerHeader(userId, email),
          body: JSON.stringify({ accessLevel: "editor" }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("owner_only");
    }

    // The target grant's level is unchanged.
    const grant = await estimaiDb.estimateCollaborator.findUniqueOrThrow({
      where: { id: viewerGrantId },
    });
    expect(grant.accessLevel).toBe("viewer");
  });

  it("DELETE /estimates/{id}/collaborators/{collaboratorId} → 403 owner_only for both the editor and the viewer", async () => {
    for (const [userId, email] of REMAINING_COLLABORATORS) {
      const res = await collaboratorsRouter.request(
        `/estimates/${estimateId}/collaborators/${editorGrantId}`,
        {
          method: "DELETE",
          headers: bearerHeader(userId, email),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("owner_only");
    }

    // Both grants are still present — neither attempt removed anything.
    const count = await estimaiDb.estimateCollaborator.count({ where: { estimateId } });
    expect(count).toBe(2);
  });

  it("sanity: resolveAccess itself still resolves the collaborators' levels (they are not simply gone)", async () => {
    const editorAccess = await Effect.runPromise(resolveAccess(estimateId, EDITOR_ID));
    const viewerAccess = await Effect.runPromise(resolveAccess(estimateId, VIEWER_ID));
    expect(editorAccess?.level).toBe("editor");
    expect(viewerAccess?.level).toBe("viewer");
  });

  it("neither notify stub was ever called — every request above was rejected before reaching a notify call site", () => {
    expect(notifyCollaboratorGranted).not.toHaveBeenCalled();
    expect(notifyCollaboratorRemoved).not.toHaveBeenCalled();
  });
});

describe("AC-10.4 (non-goal regression tripwire) — no ownership-reassignment route exists, ever", () => {
  it("the registered route table (estimate CRUD + collaborator management) has no admin/reassign/transfer/owner-mutation route", () => {
    type RouteEntry = { method: string; path: string };
    const crudRoutes: RouteEntry[] = estimatesRouter.routes.map((r) => ({
      method: r.method.toUpperCase(),
      path: r.path,
    }));
    const collaboratorRoutes: RouteEntry[] = collaboratorsRouter.routes.map((r) => ({
      method: r.method.toUpperCase(),
      path: r.path,
    }));
    const allRoutes = [...crudRoutes, ...collaboratorRoutes];

    // Every route this feature is SPEC'd to expose (plan.md's API contracts —
    // estimates.routes.ts's own header comment, collaborators.routes.ts's
    // own header comment). An exact-set assertion: ANY addition — reassign,
    // transfer, admin re-home, or anything else — breaks this test and
    // forces a deliberate, reviewed update, exactly the tripwire the task
    // asks for. (importEstimatesRouter's POST /estimates/import is a
    // SEPARATE router, not estimatesRouter, and out of scope here.)
    const expectedRoutes = new Set([
      // "ALL /*" entries are middleware registrations (bodyLimit,
      // jwtMiddleware/testAuthMiddleware's own `.use("*", …)`), not routes —
      // Hono's `.routes` array records both. Included here (not filtered
      // out) so the assertion stays an exact, unfiltered match of the real
      // array; a middleware addition is not what this tripwire guards
      // against, but it should still be a deliberate, reviewed change.
      "ALL /*",
      "POST /estimates",
      "GET /estimates",
      "GET /estimates/:id",
      "PUT /estimates/:id",
      "DELETE /estimates/:id",
      "GET /estimates/:id/collaborators",
      "POST /estimates/:id/collaborators",
      "DELETE /estimates/:id/collaborators/me",
      "PATCH /estimates/:id/collaborators/:collaboratorId",
      "DELETE /estimates/:id/collaborators/:collaboratorId",
    ]);

    const actualRoutes = new Set(allRoutes.map((r) => `${r.method} ${r.path}`));

    expect(actualRoutes).toEqual(expectedRoutes);

    // Defence in depth, independent of the exact-set assertion above: no
    // registered path or method name, on ANY router this feature owns,
    // mentions ownership mutation/reassignment vocabulary at all — this
    // still catches the concern even if the allowlist above were itself
    // wrong or incomplete.
    const reassignmentShaped = /owner|reassign|transfer|re-?home/i;
    for (const route of allRoutes) {
      expect(reassignmentShaped.test(route.path)).toBe(false);
    }
  });
});
