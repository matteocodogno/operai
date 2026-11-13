/**
 * Shared route-integration test harness (specs/029 T10), adapted from
 * activities-api/src/test-support/testAuth.ts.
 *
 * Mocks the one network-calling identity dependency every route sits behind —
 * `../auth/jwt.middleware` (RS256 verification) — so route tests exercise the REAL Hono app
 * + REAL Postgres (compose, `hours_test` database) without a live `auth` service. What `auth`
 * is asked live (`/authz/resolve`, `/authz/users/identities`) and what the owners are asked is
 * answered by the fake hosts of T11, over real HTTP.
 *
 * `signToken` can mint any wrong token a test of the verifier or of the matrix needs: another
 * `audience` (the user one, `TEST_AUDIENCE`, is the default; `TEST_SERVICE_AUDIENCE` is what a
 * service credential carries and a user route must refuse), another `issuer`, an expired one.
 *
 * `bun test` runs every file in ONE process and `mock.module` is process-global, so the
 * keypair lives at module scope here and every `setupTestAuth()` call returns the same
 * harness. A test of the REAL `jwt.middleware` imports it under a distinct specifier
 * (`./jwt.middleware.ts?real`) so it does not receive this mock.
 */

import { mock } from "bun:test";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWK,
  type JWSHeaderParameters,
  type FlattenedJWSInput,
} from "jose";
import { TEST_ISSUER, TEST_JWKS_URL, TEST_AUDIENCE, TEST_SERVICE_AUDIENCE, TEST_KID } from "./env";

export { TEST_ISSUER, TEST_JWKS_URL, TEST_AUDIENCE, TEST_SERVICE_AUDIENCE, TEST_KID };

export interface SignTokenOptions {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  readonly permEpoch?: number;
  /** Overrides for tests of the verifier: a validly SIGNED token with one wrong claim. */
  readonly issuer?: string;
  readonly audience?: string;
  /** A jose time string such as "1h" or "-1h" (already expired). */
  readonly expiresIn?: string;
}

export interface TestAuthHarness {
  /** Generates the fixture RS256 keypair. Call once, before signing tokens. */
  init(): Promise<void>;
  signToken(options: SignTokenOptions): Promise<string>;
  /** The public key as a JWKS document, for tests of the REAL middleware. */
  jwks(): { keys: JWK[] };
}

let privateKey: CryptoKey | undefined;
let publicJwk: JWK | undefined;
let localJWKS:
  | ((protectedHeader?: JWSHeaderParameters, token?: FlattenedJWSInput) => Promise<CryptoKey>)
  | undefined;
let mocksInstalled = false;

function installMocks(): void {
  if (mocksInstalled) return;
  mocksInstalled = true;

  mock.module("../auth/jwt.middleware", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMiddleware } = require("hono/factory") as typeof import("hono/factory");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jose = require("jose") as typeof import("jose");

    const unauthorized = (detail: string, path: string) =>
      Response.json(
        { type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, detail, instance: path },
        { status: 401 },
      );

    const jwtMiddleware = createMiddleware<{
      Variables: { userId: string; email: string; userName?: string; permEpoch: number };
    }>(async (c, next) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return unauthorized("A valid Bearer token is required", c.req.path);
      }
      const token = authHeader.slice(7);
      if (!token) return unauthorized("A valid Bearer token is required", c.req.path);
      try {
        if (!localJWKS) throw new Error("harness.init() was not called");
        const { payload } = await jose.jwtVerify(token, localJWKS, {
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
          algorithms: ["RS256"],
        });
        const userId = payload.sub;
        const email = typeof payload.email === "string" ? payload.email : undefined;
        if (!userId || !email) return unauthorized("Token is missing required claims", c.req.path);
        c.set("userId", userId);
        c.set("email", email);
        if (typeof payload["name"] === "string" && payload["name"].trim()) c.set("userName", payload["name"]);
        c.set("permEpoch", typeof payload["perm_epoch"] === "number" ? payload["perm_epoch"] : 0);
        return next();
      } catch {
        return unauthorized("The provided token is invalid or has expired", c.req.path);
      }
    });

    return { jwtMiddleware };
  });
}

const harness: TestAuthHarness = {
  async init() {
    if (privateKey) return;
    const kp = await generateKeyPair("RS256", { extractable: true });
    privateKey = kp.privateKey;
    publicJwk = { ...(await exportJWK(kp.publicKey)), use: "sig", alg: "RS256", kid: TEST_KID };
    localJWKS = createLocalJWKSet({ keys: [publicJwk] });
  },
  async signToken({ sub, email, name, permEpoch, issuer, audience, expiresIn }: SignTokenOptions) {
    if (!privateKey) throw new Error("harness.init() was not called");
    return new SignJWT({
      email,
      ...(name !== undefined ? { name } : {}),
      ...(permEpoch !== undefined ? { perm_epoch: permEpoch } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
      .setIssuer(issuer ?? TEST_ISSUER)
      .setSubject(sub)
      .setAudience(audience ?? TEST_AUDIENCE)
      .setExpirationTime(expiresIn ?? "1h")
      .sign(privateKey);
  },
  jwks() {
    if (!publicJwk) throw new Error("harness.init() was not called");
    return { keys: [publicJwk] };
  },
};

/** Installs the jwt mock (once per process) and returns the shared harness. */
export function setupTestAuth(): TestAuthHarness {
  installMocks();
  return harness;
}
