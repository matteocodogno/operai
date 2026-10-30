/**
 * Unit tests for the self-mint provider (T2, specs/016 — refs AC-1.4, AC-2.1;
 * ADR-0048): the credential `auth` presents to notify-api, minted in process.
 *
 * Signer is an injected throwaway RS256 key (this file must not import
 * `auth.config`; see serviceToken.routes.ts). The REAL plugin signer is covered
 * by `src/auth/self-service-token.contract.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import type { ServiceJwtPayload } from "./serviceToken.routes";

const { env } = await import("../lib/env");
const { createSelfServiceTokenProvider } = await import("./selfServiceToken");

const { privateKey } = await generateKeyPair("RS256");
const AUDIENCE = "operai-service-selfmint-test";

const mutableEnv = env as unknown as Record<string, unknown>;
const saved = env.SERVICE_AUDIENCE;
beforeAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = AUDIENCE;
});
afterAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = saved;
});

function countingSigner() {
  const calls: ServiceJwtPayload[] = [];
  const signJwt = async (payload: ServiceJwtPayload): Promise<string> => {
    calls.push(payload);
    return new SignJWT({ scope: payload.scope })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(payload.iss)
      .setSubject(payload.sub)
      .setAudience(payload.aud)
      .setIssuedAt(payload.iat)
      .setExpirationTime(payload.exp)
      .setJti(payload.jti)
      .sign(privateKey);
  };
  return { calls, signJwt };
}

/** A clock the test moves by hand, in milliseconds. */
function fakeClock(startMs = 1_800_000_000_000) {
  let now = startMs;
  return { now: () => now, advanceSeconds: (s: number) => void (now += s * 1000) };
}

describe("self-mint provider — claims (AC-1.4, AC-2.1)", () => {
  test("mints sub system:auth, scope emails.send only, aud SERVICE_AUDIENCE, 300 s", async () => {
    const { signJwt } = countingSigner();
    const clock = fakeClock();
    const token = await createSelfServiceTokenProvider({ signJwt, now: clock.now }).getToken();
    const claims = decodeJwt(token);

    expect(claims.sub).toBe("system:auth");
    expect(claims["scope"]).toBe("emails.send");
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.aud).not.toBe(env.AUTH_AUDIENCE);
    expect(claims.iss).toBe(env.BETTER_AUTH_URL);
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    expect(claims.jti).toBeTruthy();
  });
});

describe("self-mint provider — caching and refresh", () => {
  test("reuses one token until 60 s before expiry", async () => {
    const { calls, signJwt } = countingSigner();
    const clock = fakeClock();
    const provider = createSelfServiceTokenProvider({ signJwt, now: clock.now });

    const first = await provider.getToken();
    clock.advanceSeconds(239); // 61 s left
    expect(await provider.getToken()).toBe(first);
    expect(calls).toHaveLength(1);
  });

  test("mints a fresh token once inside the 60 s refresh window", async () => {
    const { calls, signJwt } = countingSigner();
    const clock = fakeClock();
    const provider = createSelfServiceTokenProvider({ signJwt, now: clock.now });

    const first = await provider.getToken();
    clock.advanceSeconds(240); // exactly 60 s left
    const second = await provider.getToken();
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
    expect(decodeJwt(second).jti).not.toBe(decodeJwt(first).jti);
  });

  test("concurrent callers share one mint", async () => {
    const { calls, signJwt } = countingSigner();
    const provider = createSelfServiceTokenProvider({ signJwt, now: fakeClock().now });
    const tokens = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("a failed mint rejects, is not cached, and the next call retries", async () => {
    const { signJwt: realSigner } = countingSigner();
    let fail = true;
    const signJwt = async (payload: ServiceJwtPayload) => {
      if (fail) throw new Error("signer down");
      return realSigner(payload);
    };
    const provider = createSelfServiceTokenProvider({ signJwt, now: fakeClock().now });

    await expect(provider.getToken()).rejects.toThrow("signer down");
    fail = false;
    expect(decodeJwt(await provider.getToken()).sub).toBe("system:auth");
  });

  test("refuses to mint if the audience equals the user audience (never a user-audience token)", async () => {
    const { calls, signJwt } = countingSigner();
    mutableEnv["SERVICE_AUDIENCE"] = env.AUTH_AUDIENCE;
    try {
      await expect(
        createSelfServiceTokenProvider({ signJwt, now: fakeClock().now }).getToken(),
      ).rejects.toThrow("SERVICE_AUDIENCE");
      expect(calls).toHaveLength(0);
    } finally {
      mutableEnv["SERVICE_AUDIENCE"] = AUDIENCE;
    }
  });
});

describe("self-mint provider — invalidate (notify answered 401)", () => {
  test("invalidating the cached token makes the next getToken mint a fresh one", async () => {
    const { calls, signJwt } = countingSigner();
    const provider = createSelfServiceTokenProvider({ signJwt, now: fakeClock().now });

    const first = await provider.getToken();
    provider.invalidate(first);
    const second = await provider.getToken();

    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  test("invalidating a token that is no longer the cached one keeps the current token", async () => {
    const { calls, signJwt } = countingSigner();
    const clock = fakeClock();
    const provider = createSelfServiceTokenProvider({ signJwt, now: clock.now });

    const stale = await provider.getToken();
    clock.advanceSeconds(240);
    const current = await provider.getToken(); // refreshed
    provider.invalidate(stale); // a late 401 for the old token must not evict the new one

    expect(await provider.getToken()).toBe(current);
    expect(calls).toHaveLength(2);
  });
});
