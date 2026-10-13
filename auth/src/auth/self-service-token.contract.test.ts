/**
 * Contract test for the self-mint provider (T2, specs/016 — refs AC-1.4,
 * AC-2.1; ADR-0048): the token `auth` presents to notify-api, minted with the
 * REAL better-auth jwt plugin, verifies against `/auth/jwks` with exactly the
 * checks notify-api applies, and is useless on a user route.
 *
 * Lives in `src/auth/` for the same reason as `service-token.contract.test.ts`:
 * it needs the real `auth.config`, which sibling tests elsewhere mock.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify } from "jose";

const { env } = await import("../lib/env");
const { auth } = await import("./auth.config");
const { authRouter } = await import("./auth.routes");
const { resolveRouter } = await import("../authz/resolve.routes");
const { signWithAuth } = await import("../system/serviceToken.routes");
const { createSelfServiceTokenProvider } = await import("../system/selfServiceToken");

const SERVICE_AUDIENCE = "operai-service-selfmint-contract-test";
const mutableEnv = env as unknown as Record<string, unknown>;
const saved = env.SERVICE_AUDIENCE;
beforeAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = SERVICE_AUDIENCE;
});
afterAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = saved;
});

const provider = createSelfServiceTokenProvider({ signJwt: signWithAuth(auth) });

async function authJwks() {
  const res = await authRouter.request("/auth/jwks");
  expect(res.status).toBe(200);
  return createLocalJWKSet((await res.json()) as Parameters<typeof createLocalJWKSet>[0]);
}

describe("self-minted credential verifies through auth's JWKS as notify-api verifies it", () => {
  test("sub system:auth, scope emails.send, aud SERVICE_AUDIENCE, 300 s, RS256 with a published kid", async () => {
    const token = await provider.getToken();
    const { payload, protectedHeader } = await jwtVerify(token, await authJwks(), {
      issuer: env.BETTER_AUTH_URL,
      audience: SERVICE_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "aud", "iss"],
    });

    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.sub).toBe("system:auth");
    expect(payload["scope"]).toBe("emails.send");
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);

    const { keys } = (await (await authRouter.request("/auth/jwks")).json()) as { keys: { kid: string }[] };
    expect(keys.map((k) => k.kid)).toContain(decodeProtectedHeader(token).kid as string);
  });

  test("is rejected with aud = AUTH_AUDIENCE and by auth's own user routes", async () => {
    const token = await provider.getToken();
    await expect(
      jwtVerify(token, await authJwks(), {
        issuer: env.BETTER_AUTH_URL,
        audience: env.AUTH_AUDIENCE,
        algorithms: ["RS256"],
      }),
    ).rejects.toBeInstanceOf(joseErrors.JWTClaimValidationFailed);

    const resolve = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resolve.status).toBe(401);
  });
});
