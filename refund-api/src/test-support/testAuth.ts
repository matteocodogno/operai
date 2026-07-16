/**
 * Shared route-integration test harness (T7+, specs/007-refund-service).
 *
 * Mocks the TWO network-calling dependencies every gated route sits behind —
 * `../auth/jwt.middleware` (RS256 verification) and `../authz/resolveClient`
 * (`auth GET /authz/resolve`) — so route tests exercise the REAL Hono app +
 * REAL Postgres (compose, `refund` database) without a live `auth` service.
 * Mirrors the pattern established by `src/auth/authz.middleware.test.ts` (mock
 * the resolve-client module, not global fetch) and
 * `estimai-api/src/estimates/estimates.routes.test.ts` (mock the jwt-middleware
 * MODULE itself, not `jose` — avoids the cross-file `mock.module("jose")`
 * collision `jwt.middleware.test.ts` warns about when multiple files run in
 * the same `bun test` worker process).
 *
 * Usage — call `setupTestAuth()` ONCE at the top of a route test file, before
 * any dynamic `await import("./some.routes")` of the router under test:
 *
 *   const harness = setupTestAuth();
 *   await harness.init();
 *   const { requestsRouter } = await import("./requests.routes");
 *   harness.setResolve(async () => FIXTURE_RESOLVE_RESPONSE);
 *   const token = await harness.signToken({ sub: "user-1", email: "a@x.com" });
 *
 * Each call to `setupTestAuth()` registers its OWN `mock.module()` factories
 * (closures over this call's own mutable state) — safe to call from multiple
 * test files in the same run AS LONG AS each file's dynamic import of its
 * router-under-test happens after that file's own `setupTestAuth()` call, and
 * no two files import the SAME router specifier (true here: T7/T8/T9/T10 each
 * own a distinct route module).
 */

import { mock } from "bun:test";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWSHeaderParameters,
  type FlattenedJWSInput,
} from "jose";
import type { ResolveResponse } from "../authz/resolveClient";

export const TEST_ISSUER = "http://localhost:3001";
export const TEST_AUDIENCE = "operai-suite";
export const TEST_KID = "operai-auth-rs256-v1-test";

export interface SignTokenOptions {
  readonly sub: string;
  readonly email: string;
  readonly permEpoch?: number;
}

export interface TestAuthHarness {
  /** Generates the fixture RS256 keypair. Call once, before signing tokens. */
  init(): Promise<void>;
  signToken(options: SignTokenOptions): Promise<string>;
  /** Swaps the `GET /authz/resolve` fixture response for subsequent requests. */
  setResolve(
    fn: (authorizationHeader: string) => Promise<ResolveResponse>,
  ): void;
  /** Number of times the (mocked) resolve client has been invoked. */
  resolveCallCount(): number;
}

export function setupTestAuth(): TestAuthHarness {
  let privateKey: CryptoKey;
  let localJWKS: (
    protectedHeader?: JWSHeaderParameters,
    token?: FlattenedJWSInput,
  ) => Promise<CryptoKey>;

  let resolveImpl: (
    authorizationHeader: string,
  ) => Promise<ResolveResponse> = async () => {
    throw new Error("resolveImpl not configured for this test");
  };
  let callCount = 0;

  // ─── Mock jwt.middleware — verifies against OUR local JWKS, not a live auth ──
  mock.module("../auth/jwt.middleware", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMiddleware } = require("hono/factory") as typeof import("hono/factory");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jose = require("jose") as typeof import("jose");

    const unauthorized = (detail: string, path: string) =>
      Response.json(
        {
          type: "https://httpstatuses.com/401",
          title: "Unauthorized",
          status: 401,
          detail,
          instance: path,
        },
        { status: 401 },
      );

    const jwtMiddleware = createMiddleware<{
      Variables: { userId: string; email: string; permEpoch: number };
    }>(async (c, next) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return unauthorized("A valid Bearer token is required", c.req.path);
      }
      const token = authHeader.slice(7);
      if (!token) {
        return unauthorized("A valid Bearer token is required", c.req.path);
      }
      try {
        const { payload } = await jose.jwtVerify(token, localJWKS, {
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
          algorithms: ["RS256"],
        });
        const userId = payload.sub;
        const email =
          typeof payload.email === "string" ? payload.email : undefined;
        if (!userId || !email) {
          return unauthorized("Token is missing required claims", c.req.path);
        }
        const permEpoch =
          typeof payload["perm_epoch"] === "number"
            ? payload["perm_epoch"]
            : 0;
        c.set("userId", userId);
        c.set("email", email);
        c.set("permEpoch", permEpoch);
        return next();
      } catch {
        return unauthorized(
          "The provided token is invalid or has expired",
          c.req.path,
        );
      }
    });

    return { jwtMiddleware };
  });

  // ─── Mock resolveClient — fixture GET /authz/resolve response ──────────────
  mock.module("../authz/resolveClient", () => ({
    fetchAuthzResolve: async (authorizationHeader: string) => {
      callCount++;
      return resolveImpl(authorizationHeader);
    },
  }));

  return {
    async init() {
      const kp = await generateKeyPair("RS256", { extractable: true });
      privateKey = kp.privateKey;
      const publicJwk = await exportJWK(kp.publicKey);
      localJWKS = createLocalJWKSet({
        keys: [{ ...publicJwk, use: "sig", alg: "RS256", kid: TEST_KID }],
      });
    },
    async signToken({ sub, email, permEpoch }: SignTokenOptions) {
      const jwt = new SignJWT({
        email,
        ...(permEpoch !== undefined ? { perm_epoch: permEpoch } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
        .setIssuer(TEST_ISSUER)
        .setSubject(sub)
        .setAudience(TEST_AUDIENCE)
        .setExpirationTime("1h");
      return jwt.sign(privateKey);
    },
    setResolve(fn) {
      resolveImpl = fn;
    },
    resolveCallCount() {
      return callCount;
    },
  };
}
