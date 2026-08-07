/**
 * Tests for T11 (specs/013-estimate-sharing): OpenAPI registration for the
 * five collaborator-management routes, plus a regression guard for the
 * `/openapi.json`/`/docs` shadowing bug T6's agent flagged and T11 fixed.
 *
 * Two concerns, deliberately kept in separate `describe` blocks:
 *
 * 1. `registerCollaboratorOpenApiDocs` — does calling it on a fresh
 *    `OpenAPIHono` router produce a valid document (no schema-generation
 *    errors) containing all five routes with their documented status
 *    codes? This is a pure, isolated unit test of the doc-only registration
 *    function itself — no jwtMiddleware, no DB, no HTTP auth at all, since
 *    `openAPIRegistry.registerPath` never wires a handler (see
 *    collaborators.docs.ts's file header).
 *
 * 2. The `/openapi.json` shadowing bug: `estimatesRouter`'s wildcard
 *    `.use("*", jwtMiddleware)` (T5/T8), once merged into `app`'s route
 *    table via `OpenAPIHono.route()`, matches EVERY path under `app` —
 *    including `/openapi.json`/`/docs` if those are registered AFTER the
 *    merge, because Hono runs every matching route entry for a request IN
 *    REGISTRATION ORDER and the auth middleware, matched first, returns 401
 *    before the doc handler ever gets a turn. index.ts's real fix is
 *    registration ORDER (`setupOpenAPI(app)` now runs before
 *    `importEstimatesRouter`/`estimatesRouter` are mounted) — this was
 *    verified directly against the real service during T11's
 *    implementation (`bun run src/index.ts` + `curl -s -o /dev/null -w
 *    '%{http_code}' http://localhost:PORT/openapi.json` → 401 before the
 *    fix, 200 after). The two tests below reproduce the MECHANISM with a
 *    minimal synthetic router (not the real `estimatesRouter` singleton —
 *    importing that here would reintroduce the exact cross-test-file
 *    `mock.module("@/auth/jwt.middleware", …)` race
 *    `collaborators.routes.test.ts`'s file header explains at length, for
 *    zero benefit: this bug is about Hono/zod-openapi ROUTE REGISTRATION
 *    ORDER, not about `estimatesRouter`'s specific auth implementation) —
 *    using the REAL `setupOpenAPI` from `./registry` against a synthetic
 *    wildcard-auth-gated router, in BOTH orders, to prove the fix is real
 *    and that the test itself is meaningful (the second test reproduces the
 *    bug when the order is reverted).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { JwtVariables } from "@/auth/jwt.middleware";
import { registerCollaboratorOpenApiDocs } from "./collaborators.docs";
import { setupOpenAPI } from "./registry";

const DOC_CONFIG = {
  openapi: "3.1.0" as const,
  info: { title: "test", version: "0.0.0" },
};

// ─── 1. Doc registration: five routes, no schema-generation errors ─────────

describe("T11 — registerCollaboratorOpenApiDocs", () => {
  it("registers all five collaborator routes and generates a document without schema errors", () => {
    const router = new OpenAPIHono<{ Variables: JwtVariables }>();
    registerCollaboratorOpenApiDocs(router);

    const app = new OpenAPIHono();
    app.route("/", router);

    // Throws on any zod → OpenAPI schema-generation error — the "generated
    // without schema errors" half of T11's done-when.
    const document = app.getOpenAPIDocument(DOC_CONFIG);

    const paths = document.paths ?? {};
    expect(Object.keys(paths).sort()).toEqual(
      [
        "/estimates/{id}/collaborators",
        "/estimates/{id}/collaborators/{collaboratorId}",
        "/estimates/{id}/collaborators/me",
      ].sort(),
    );

    const list = paths["/estimates/{id}/collaborators"];
    expect(list?.get).toBeDefined();
    expect(list?.post).toBeDefined();
    expect(Object.keys(list?.get?.responses ?? {}).sort()).toEqual(
      ["200", "401", "403", "404"].sort(),
    );
    expect(Object.keys(list?.post?.responses ?? {}).sort()).toEqual(
      ["201", "400", "401", "403", "404", "409", "422", "429", "503"].sort(),
    );

    const byId = paths["/estimates/{id}/collaborators/{collaboratorId}"];
    expect(byId?.patch).toBeDefined();
    expect(byId?.delete).toBeDefined();
    expect(Object.keys(byId?.patch?.responses ?? {}).sort()).toEqual(
      ["200", "401", "403", "404"].sort(),
    );
    expect(Object.keys(byId?.delete?.responses ?? {}).sort()).toEqual(
      ["204", "401", "403", "404"].sort(),
    );

    const me = paths["/estimates/{id}/collaborators/me"];
    expect(me?.delete).toBeDefined();
    expect(Object.keys(me?.delete?.responses ?? {}).sort()).toEqual(
      ["204", "401", "404"].sort(),
    );
  });
});

// ─── 2. /openapi.json shadowing — regression guard ──────────────────────────

/** A minimal stand-in for estimatesRouter's `.use("*", jwtMiddleware)` — any
 * request without an Authorization header is rejected, exactly like the
 * real jwtMiddleware's outermost behaviour, without needing a real
 * RS256/JWKS setup. */
function buildSyntheticAuthedRouter(): Hono {
  const router = new Hono();
  router.use("*", async (c, next) => {
    if (!c.req.header("Authorization")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });
  router.get("/estimates", (c) => c.json({ ok: true }));
  return router;
}

describe("T11 — /openapi.json is never shadowed by a wildcard-auth-gated router mounted afterward", () => {
  it("setupOpenAPI(app) registered BEFORE the authed router is mounted: /openapi.json is public, /estimates still requires auth", async () => {
    const app = new OpenAPIHono();
    setupOpenAPI(app);
    app.route("/", buildSyntheticAuthedRouter());

    const docRes = await app.request("/openapi.json");
    expect(docRes.status).toBe(200);

    const docsRes = await app.request("/docs");
    expect(docsRes.status).toBe(200);

    const estimatesRes = await app.request("/estimates");
    expect(estimatesRes.status).toBe(401);
  });

  it("(regression guard) the OPPOSITE order reproduces the shadowing bug — proving the fix is the ordering, not a coincidence", async () => {
    const app = new OpenAPIHono();
    app.route("/", buildSyntheticAuthedRouter());
    setupOpenAPI(app); // registered AFTER the authed router is mounted — the pre-T11 order

    const docRes = await app.request("/openapi.json");
    // This is the bug T6's agent flagged: the wildcard auth middleware,
    // merged in earlier, intercepts /openapi.json before app.doc()'s own
    // handler (registered later) ever runs.
    expect(docRes.status).toBe(401);
  });
});
