/**
 * JWT claim contract test (T3, specs/004-auth-roles-permissions; extended by
 * T8, specs/005-notification-center — ADR-0010 `aud` claim).
 *
 * plan.md "The JWT claim seam" replaces the dead `jwt.fields` no-op with a
 * real `definePayload` that returns a MINIMAL, deliberate claim set:
 * `{ email, name, image, perm_epoch, aud }`, with `sub` left to the plugin
 * default (`getSubject` → `user.id` — ADR-0005, never changed here).
 *
 * Risk R2 (plan.md "Risks") is exactly what this test guards against:
 * "`definePayload` drops a claim a consumer needs" — `estimai-api`'s
 * `jwtMiddleware` reads `sub` + `email` off the verified payload
 * (estimai-api/src/auth/jwt.middleware.ts) and 401s if either is absent.
 * A regression here would silently break every resource server.
 *
 * ADR-0010 (T8) adds `aud` to that same minimal set: `auth` stamps
 * `env.AUTH_AUDIENCE` as the JWT's standard `aud` claim so resource servers
 * can (T9) reject tokens scoped to a different audience — closing the
 * cross-service replay gap now that notify-api is the suite's first real
 * second JWKS resource server. This file proves the ISSUER half only (a
 * freshly minted token carries `aud`); verifying/rejecting on `aud` is T9's
 * job in estimai-api's and notify-api's own `jwtMiddleware` tests.
 *
 * Strategy: exercise the REAL token-mint flow end-to-end against the live
 * local Postgres (no mocks on auth.config/definePayload) —
 *   1. POST /test-auth/session  → mints a real better-auth session + cookie
 *      for a freshly created, uniquely-emailed test user (self-isolating —
 *      see DB-ISOLATION below).
 *   2. GET  /auth/token         → better-auth's jwt plugin signs a real
 *      RS256 JWT via `definePayload`.
 *   3. GET  /auth/jwks          → the SAME rotating-kid JWKS that signed the
 *      token (ADR-0005 correction: NOT /.well-known/jwks.json, which serves
 *      an unrelated static env keypair — see that ADR's "Correction" note).
 *   4. `jose.jwtVerify` the token against that JWKS — the exact mechanism
 *      estimai-api's jwtMiddleware uses (createRemoteJWKSet + RS256 pin) —
 *      then assert the decoded payload's claim shape.
 *
 * DB-ISOLATION: other auth-service tasks may run `bun test` concurrently
 * against the same shared local Postgres. Every fixture email is suffixed
 * with `crypto.randomUUID()` so concurrent runs can never collide on the
 * `user.email` unique constraint, and the created user (+ cascaded session/
 * account rows — see schema.prisma `onDelete: Cascade` from User) is deleted
 * in `afterAll` regardless of test outcome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, jwtVerify, decodeJwt } from "jose";

// ── Open the test-auth gate deterministically, independent of ambient .env ──
// (mirrors the pattern in test-auth.routes.test.ts) so this test is
// self-contained regardless of what a developer's local .env happens to set.
process.env["ENABLE_TEST_AUTH"] = "true";
if (process.env["NODE_ENV"] === "production") {
  process.env["NODE_ENV"] = "test";
}

const { env } = await import("../lib/env");
(env as unknown as Record<string, unknown>)["ENABLE_TEST_AUTH"] = true;
if (env.NODE_ENV === "production") {
  (env as unknown as Record<string, unknown>)["NODE_ENV"] = "test";
}

const { testAuthRouter } = await import("../test-auth/test-auth.routes");
const { authRouter } = await import("./auth.routes");
const { db } = await import("../lib/db");

// ── Unique, self-isolating fixture ───────────────────────────────────────────
const FIXTURE_EMAIL = `t3-contract-${crypto.randomUUID()}@operai.test`;
const FIXTURE_NAME = "T3 Contract Test User";
let fixtureUserId: string | undefined;

describe("JWT claim contract — definePayload (T3, R2)", () => {
  beforeAll(async () => {
    // Sanity precondition: the fixture user must not already exist so we can
    // assert the freshly-created row's default permissionEpoch (0) below.
    const existing = await db.user.findUnique({ where: { email: FIXTURE_EMAIL } });
    expect(existing).toBeNull();
  });

  afterAll(async () => {
    // Best-effort cleanup: delete the fixture user. Cascades (schema.prisma:
    // Session/Account/UserRole/UserDepartment onDelete: Cascade; AuditLog.actor
    // onDelete: SetNull) mean this leaves no orphaned rows even though this
    // test also exercised session/JWT minting.
    if (fixtureUserId) {
      await db.user.delete({ where: { id: fixtureUserId } }).catch(() => {
        // Already gone (e.g. a prior failed run cleaned it up) — fine.
      });
    }
  });

  test("a freshly minted token carries sub + email (R2 — estimai-api's verifier contract) and perm_epoch (AC-4.3)", async () => {
    // ── 1. Mint a real better-auth session for a brand-new user ────────────
    const sessionRes = await testAuthRouter.request("/test-auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: FIXTURE_EMAIL, name: FIXTURE_NAME }),
    });
    expect(sessionRes.status).toBe(200);

    const sessionBody = (await sessionRes.json()) as { userId: string; email: string };
    fixtureUserId = sessionBody.userId;
    expect(sessionBody.email).toBe(FIXTURE_EMAIL);

    const setCookie = sessionRes.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    // Forward only the "name=value" pair (strip attributes) as the request Cookie header.
    const cookiePair = (setCookie as string).split(";")[0] ?? "";
    expect(cookiePair.length).toBeGreaterThan(0);

    // Confirm the DB row exists with the expected default permissionEpoch (0) —
    // this is the value `definePayload` must read back as `perm_epoch` below.
    const dbUser = await db.user.findUnique({ where: { id: fixtureUserId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.permissionEpoch).toBe(0);

    // ── 2. Exchange the session cookie for a real RS256 JWT ────────────────
    const tokenRes = await authRouter.request("/auth/token", {
      method: "GET",
      headers: { Cookie: cookiePair },
    });
    expect(tokenRes.status).toBe(200);

    const { token } = (await tokenRes.json()) as { token: string };
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    // ── 3. Fetch the JWKS that actually signed this token (ADR-0005: the
    //        rotating-kid `/auth/jwks`, NOT the orphaned /.well-known one) ──
    const jwksRes = await authRouter.request("/auth/jwks", { method: "GET" });
    expect(jwksRes.status).toBe(200);
    const jwks = (await jwksRes.json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys.length).toBeGreaterThan(0);

    const JWKS = createLocalJWKSet(jwks as { keys: never[] });

    // ── 4. Verify exactly as estimai-api's jwtMiddleware does (ADR-0005):
    //        RS256-pinned signature + issuer check — then inspect claims ───
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.BETTER_AUTH_URL,
      algorithms: ["RS256"],
    });

    // R2 — the claims estimai-api's jwtMiddleware requires or it 401s:
    expect(payload.sub).toBe(fixtureUserId);
    expect(payload.email).toBe(FIXTURE_EMAIL);

    // AC-4.3 / plan.md claim seam — perm_epoch present and correct.
    expect(payload["perm_epoch"]).toBe(0);

    // ADR-0010 (T8, specs/005-notification-center) — the standard `aud`
    // claim, stamped from env.AUTH_AUDIENCE via definePayload. Verify it two
    // ways: (a) the decoded payload carries the exact configured value, and
    // (b) re-verifying the SAME token with jose's `audience` option (the
    // shape T9 will wire into estimai-api's/notify-api's jwtMiddleware)
    // succeeds — proving the claim is genuinely signed-in, not merely present
    // in an unverified decode.
    expect(payload["aud"]).toBe(env.AUTH_AUDIENCE);
    await expect(
      jwtVerify(token, JWKS, {
        issuer: env.BETTER_AUTH_URL,
        audience: env.AUTH_AUDIENCE,
        algorithms: ["RS256"],
      }),
    ).resolves.toBeDefined();
    // A wrong/unrecognised audience must fail verification — proves this is
    // a real signed claim jose actually checks, not a coincidental string.
    await expect(
      jwtVerify(token, JWKS, {
        issuer: env.BETTER_AUTH_URL,
        audience: "some-other-audience-not-configured",
        algorithms: ["RS256"],
      }),
    ).rejects.toThrow();

    // Deliberate minimality (plan.md "We deliberately do NOT put roles or the
    // permission set in the token"): no role/permission claims leak in.
    expect(payload["roles"]).toBeUndefined();
    expect(payload["permissions"]).toBeUndefined();

    // definePayload's declared shape: email/name/image (+ perm_epoch, aud),
    // sub via plugin default. name/image are additional identity claims
    // plan.md keeps.
    expect(payload["name"]).toBe(FIXTURE_NAME);

    // Sanity: decodeJwt (no verification) should agree — proves the assertions
    // above are about the actual signed payload, not a verification artifact.
    const unverified = decodeJwt(token);
    expect(unverified.sub).toBe(fixtureUserId);
    expect(unverified["perm_epoch"]).toBe(0);
    expect(unverified["aud"]).toBe(env.AUTH_AUDIENCE);
  });

  test("perm_epoch reflects the DB column at mint time, not a stale value (definePayload reads via Prisma)", async () => {
    // Bump the fixture user's permissionEpoch directly in the DB (simulating
    // an authz mutation elsewhere bumping it per ADR-0007 decision 4), then
    // mint a fresh token and confirm the new value is carried — proving
    // definePayload reads the live column rather than a cached snapshot.
    expect(fixtureUserId).toBeDefined();

    await db.user.update({
      where: { id: fixtureUserId as string },
      data: { permissionEpoch: 7 },
    });

    const sessionRes = await testAuthRouter.request("/test-auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: FIXTURE_EMAIL, name: FIXTURE_NAME }),
    });
    expect(sessionRes.status).toBe(200);
    const setCookie = sessionRes.headers.get("set-cookie");
    const cookiePair = (setCookie as string).split(";")[0] ?? "";

    const tokenRes = await authRouter.request("/auth/token", {
      method: "GET",
      headers: { Cookie: cookiePair },
    });
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };

    const unverified = decodeJwt(token);
    expect(unverified["perm_epoch"]).toBe(7);
    // sub/email still intact after the bump — R2 holds under mutation too.
    expect(unverified.sub).toBe(fixtureUserId);
    expect(unverified.email).toBe(FIXTURE_EMAIL);
  });
});
