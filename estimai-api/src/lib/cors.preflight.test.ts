/**
 * Regression test for the CORS-policy defect found by the T25 e2e pass on
 * specs/013-estimate-sharing: `allowHeaders`/`allowMethods`/`exposeHeaders`
 * in src/lib/cors.ts (mounted "*" in index.ts) were never updated for this
 * feature's new HTTP surface, so every real cross-origin browser preflight —
 * the shell (localhost:5173) calling estimai-api (localhost:8080), always a
 * different origin — was silently blocked or under-informed, even though the
 * ENTIRE pre-existing unit suite (estimates.routes.test.ts,
 * collaborators.routes.test.ts, …) passed, because those tests call
 * `app.fetch`/`router.request()` directly and never issue a real `OPTIONS`
 * preflight the way a browser does.
 *
 * This file closes that blind spot: it mounts the REAL `corsMiddleware` (the
 * exact same instance index.ts uses — no re-declared literal, so this can
 * never drift into "asserting the config object's contents" while the wired
 * behavior differs) on a throwaway Hono app and issues real `OPTIONS`
 * requests with `Origin` + `Access-Control-Request-Method` /
 * `-Request-Headers`, then asserts on the actual
 * `Access-Control-Allow-Methods` / `-Allow-Headers` / `-Expose-Headers`
 * RESPONSE headers hono/cors emits — the same headers a browser reads to
 * decide whether to let the real request through.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

// ─── Env guards — mirrors estimates.routes.test.ts / collaborators.routes
// .test.ts's `??=` pattern so this file boots correctly regardless of which
// test file in the shared `bun test` process triggers `@/lib/env`'s
// (once-ever) validation first, AND when run standalone (`bun test
// src/lib/cors.preflight.test.ts`), where no earlier file has set these. ───

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

const { corsMiddleware } = await import("./cors");

// Matches ALLOWED_ORIGINS above (see env.ts) — the shell's dev origin,
// always cross-origin from estimai-api's own :8080.
const ALLOWED_ORIGIN = "http://localhost:5173";

function buildApp() {
  const app = new Hono();
  app.use("*", corsMiddleware);
  return app;
}

/** Issues a real preflight OPTIONS request, mirroring what a browser sends. */
function preflight(
  app: Hono,
  path: string,
  method: string,
  requestHeaders?: string,
) {
  return app.request(path, {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Access-Control-Request-Method": method,
      ...(requestHeaders
        ? { "Access-Control-Request-Headers": requestHeaders }
        : {}),
    },
  });
}

describe("CORS preflight — estimai-api's real HTTP surface (specs/013 T25 regression)", () => {
  // ── Defect 1: If-Match missing from allowHeaders ─────────────────────────
  // T7/ADR-0038 made If-Match REQUIRED on PUT /estimates/{id}. A browser
  // preflighting a PUT with an If-Match header must see it echoed back in
  // Access-Control-Allow-Headers, or it refuses to send the real request —
  // i.e. saving is entirely broken cross-origin without this.
  it("PUT /estimates/{id} preflight allows the If-Match header", async () => {
    const app = buildApp();
    const res = await preflight(
      app,
      "/estimates/abc123",
      "PUT",
      "content-type, authorization, if-match",
    );

    expect(res.status).toBe(204);
    const allowHeaders = (res.headers.get("Access-Control-Allow-Headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((h) => h.trim());
    expect(allowHeaders).toContain("if-match");
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain("authorization");
  });

  // ── Defect 2: PATCH missing from allowMethods ────────────────────────────
  // T9's PATCH /estimates/{id}/collaborators/{collaboratorId} (access-level
  // change) must be listed in Access-Control-Allow-Methods or a browser can
  // never issue it cross-origin.
  it("PATCH /estimates/{id}/collaborators/{collaboratorId} preflight allows PATCH", async () => {
    const app = buildApp();
    const res = await preflight(
      app,
      "/estimates/abc123/collaborators/col1",
      "PATCH",
    );

    expect(res.status).toBe(204);
    const allowMethods = (res.headers.get("Access-Control-Allow-Methods") ?? "")
      .toUpperCase()
      .split(",")
      .map((m) => m.trim());
    expect(allowMethods).toContain("PATCH");
  });

  // ── Defect 3: no exposeHeaders — Retry-After / ETag unreadable cross-origin
  // Access-Control-Expose-Headers is NOT preflight-gated (it isn't part of
  // the OPTIONS negotiation at all — it's sent on every actual response,
  // preflighted or not), but hono/cors always echoes it on the preflight
  // response too since it runs before the OPTIONS short-circuit. Assert it
  // here where it's cheap to check alongside the other two.
  it("preflight response exposes Retry-After and ETag for the browser to read on the real response", async () => {
    const app = buildApp();
    const res = await preflight(app, "/estimates/abc123", "PUT", "if-match");

    const exposeHeaders = (res.headers.get("Access-Control-Expose-Headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((h) => h.trim());
    expect(exposeHeaders).toContain("retry-after");
    expect(exposeHeaders).toContain("etag");
  });

  // ── Full-surface assertion: every method/header this feature's routes use
  // is present, and the policy stays a scoped allowlist (no wildcards, no
  // methods/headers this service doesn't actually need).
  it("Access-Control-Allow-Methods is exactly the methods estimai-api's routes use", async () => {
    const app = buildApp();
    const res = await preflight(app, "/estimates", "GET");

    const allowMethods = (res.headers.get("Access-Control-Allow-Methods") ?? "")
      .toUpperCase()
      .split(",")
      .map((m) => m.trim())
      .sort();
    expect(allowMethods).toEqual(
      ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"].sort(),
    );
  });

  it("Access-Control-Expose-Headers is exactly Retry-After and ETag — no wildcard", async () => {
    const app = buildApp();
    const res = await preflight(app, "/estimates/abc123", "GET");

    expect(res.headers.get("Access-Control-Expose-Headers")).not.toBe("*");
    const exposeHeaders = (res.headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((h) => h.trim())
      .sort();
    expect(exposeHeaders).toEqual(["ETag", "Retry-After"].sort());
  });

  // ── Origin allowlisting + credentials still work as before (not touched by
  // this fix, but a preflight test file should prove the fix didn't loosen
  // this) ───────────────────────────────────────────────────────────────────
  it("still reflects only the allowed origin and sets credentials — no wildcard origin", async () => {
    const app = buildApp();
    const res = await preflight(app, "/estimates", "GET");

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("does not reflect an origin absent from ALLOWED_ORIGINS", async () => {
    const app = buildApp();
    const res = await app.request("/estimates", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
