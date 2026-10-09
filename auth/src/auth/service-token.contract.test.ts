/**
 * R-4 contract test (T4, specs/015-hardware-inventory — plan.md risk R-4,
 * ADR-0044): a token minted by `POST /system/service-token` verifies through
 * `auth`'s REAL published JWKS with exactly the checks `notify-api`'s
 * `/system/notifications` applies
 * (`notify-api/src/system/notificationsAuth.middleware.ts`, T6):
 *
 *   RS256 pinned, issuer pinned, `aud` = SERVICE_AUDIENCE,
 *   required claims exp/sub/aud/iss, `sub` of the form `system:<client>`,
 *   `scope` containing `notifications.push`.
 *
 * and is REJECTED by the user-token path (`aud` = AUTH_AUDIENCE).
 *
 * WHICH KEY SIGNS (the R-4 finding): tokens in this service are signed by
 * better-auth's jwt plugin with its rotating RS256 key from the `jwks` table
 * and published at `/auth/jwks` — the URL every resource server's
 * `AUTH_JWKS_URL` points at. The env `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` pair
 * (served at `/.well-known/jwks.json`) is an unrelated static keypair
 * (ADR-0005's correction), so the task's stated fallback of "sign with jose
 * using JWT_PRIVATE_KEY" would produce tokens no resource server can verify.
 * The plugin's server-only `signJWT` endpoint signs an arbitrary payload with
 * the same key and `kid`, which is what this test proves end to end. The JWKS
 * is fetched from `/auth/jwks` and verified in-process with `jose` — the same
 * mechanics as a remote verifier, minus the socket.
 *
 * WHY THIS FILE LIVES IN `src/auth/`, not next to the route in `src/system/`:
 * it needs the REAL `auth.config`, and sibling test files elsewhere
 * `mock.module("../auth/auth.config", ...)` for the rest of the process; a
 * module first loaded after that gets the stub. `src/auth/` test files run
 * before those mocks are registered (the same placement
 * `authz-resolve.routes.test.ts` and `jwt-claims.contract.test.ts` use). If the
 * stub ever leaks in, `auth.api.signJWT` is missing and every test here fails
 * loudly rather than passing vacuously.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, errors as joseErrors } from "jose";

const { env } = await import("../lib/env");
const { auth } = await import("./auth.config");
const { authRouter } = await import("./auth.routes");
const { resolveRouter } = await import("../authz/resolve.routes");
const { identitiesRouter } = await import("../authz/identities.routes");
const { createServiceTokenRouter, signWithAuth } = await import("../system/serviceToken.routes");

// The production wiring (src/index.ts): the real plugin signer.
const serviceTokenRouter = createServiceTokenRouter({ signJwt: signWithAuth(auth) });

const SERVICE_AUDIENCE = "operai-service-contract-test";
// Obvious dummy — never a real secret.
const CLIENT_SECRET = "dummy-contract-secret-0123456789-abcdef";

const saved = { audience: env.SERVICE_AUDIENCE, clients: env.SERVICE_CLIENTS };
const mutableEnv = env as unknown as Record<string, unknown>;

beforeAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = SERVICE_AUDIENCE;
  mutableEnv["SERVICE_CLIENTS"] = new Map([
    ["inventory-api", { secret: CLIENT_SECRET, scopes: ["notifications.push"] }],
  ]);
});
afterAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = saved.audience;
  mutableEnv["SERVICE_CLIENTS"] = saved.clients;
});

async function mint(): Promise<string> {
  const res = await serviceTokenRouter.request("/system/service-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.10" },
    body: JSON.stringify({ clientId: "inventory-api", clientSecret: CLIENT_SECRET }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function authJwks() {
  const res = await authRouter.request("/auth/jwks");
  expect(res.status).toBe(200);
  return createLocalJWKSet((await res.json()) as Parameters<typeof createLocalJWKSet>[0]);
}

describe("R-4: a minted service token verifies through auth's JWKS as notify-api verifies it", () => {
  test("passes notify-api's exact verification options and carries the expected claims", async () => {
    const token = await mint();
    const jwks = await authJwks();

    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: env.BETTER_AUTH_URL, // notify-api's AUTH_ISSUER
      audience: SERVICE_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "aud", "iss"],
    });

    expect(protectedHeader.alg).toBe("RS256");
    expect(typeof protectedHeader.kid).toBe("string");
    expect(payload.sub).toBe("system:inventory-api");
    expect((payload["scope"] as string).split(" ")).toContain("notifications.push");
  });

  test("is signed with a key that is in /auth/jwks — the kid matches a published key", async () => {
    const token = await mint();
    const res = await authRouter.request("/auth/jwks");
    const { keys } = (await res.json()) as { keys: { kid: string }[] };
    expect(keys.map((k) => k.kid)).toContain(decodeProtectedHeader(token).kid as string);
  });

  test("is REJECTED by the user-token verification (aud = AUTH_AUDIENCE) — never a user credential", async () => {
    const token = await mint();
    const jwks = await authJwks();

    await expect(
      jwtVerify(token, jwks, {
        issuer: env.BETTER_AUTH_URL,
        audience: env.AUTH_AUDIENCE,
        algorithms: ["RS256"],
      }),
    ).rejects.toBeInstanceOf(joseErrors.JWTClaimValidationFailed);
  });

  test("is rejected by auth's own user routes (401): /authz/resolve and /authz/users/identities", async () => {
    const token = await mint();

    const resolve = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resolve.status).toBe(401);

    const identities = await identitiesRouter.request("/authz/users/identities", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: ["x"] }),
    });
    expect(identities.status).toBe(401);
  });
});
