/**
 * Shared route-integration test harness (T7, specs/015-hardware-inventory).
 * Ported from refund-api/src/test-support/testAuth.ts.
 *
 * Mocks the TWO network-calling dependencies every gated route sits behind —
 * `../auth/jwt.middleware` (RS256 verification) and `../authz/resolveClient`
 * (`auth GET /authz/resolve`) — so route tests exercise the REAL Hono app +
 * REAL Postgres (compose, `inventory` database) without a live `auth` service.
 *
 * Usage — import this module BEFORE anything that evaluates `src/lib/env`
 * (it sets the environment as a side effect of being imported), call
 * `setupTestAuth()` ONCE at the top of a route test file, and only then
 * `await import(...)` the router under test:
 *
 *   import { setupTestAuth } from "../test-support/testAuth";
 *   const harness = setupTestAuth();
 *   await harness.init();
 *   const { scopeRouter } = await import("./scope.routes");
 *   harness.setResolve(async () => fixture);
 *   const token = await harness.signToken({ sub: "user-1", email: "a@x.com" });
 *
 * Shared state, deliberately. `bun test` runs every file in ONE process and
 * `mock.module` is process-global, and a module such as `auth/guards.ts` that
 * was first imported by one test file keeps the middleware it got THEN. So the
 * keypair, the resolve fixture and the call counter live at module scope here
 * (this module is evaluated once per process), the mocks are registered once,
 * and every `setupTestAuth()` call returns the same harness. A per-call closure
 * would leave a second test file verifying tokens against the first file's key.
 * Each file sets the fixture it needs (`setResolve`) in its own `beforeEach`.
 *
 * Conversely, a test of the REAL `jwt.middleware` / `resolveClient` must import
 * them under a distinct specifier (`./jwt.middleware.ts?real`), so it does not
 * receive these mocks — see those files.
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

// ─── Test environment ────────────────────────────────────────────────────────
//
// `src/lib/env.ts` validates at import and exits the process on failure, so a
// test must have set every required variable before importing anything that
// reads it. Values the suite asserts on are set unconditionally; everything
// else uses `??=` so a developer's real values (DATABASE_URL above all — `bun
// test` shares ONE process, so overwriting it here would clobber every other
// file's database) are never touched.
//
// INVENTORY_S3_EU_ENDPOINT_HOSTS is the one derived value: a developer's local
// environment deliberately does not list localhost as an EU host (the
// residency check must stay strict), so a test that imports env opts the
// endpoint's own host in for the test process only. The validation itself is
// not weakened — it is satisfied the same way an operator satisfies it.
process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/inventory";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = `${TEST_ISSUER}/auth/jwks`;
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["AUTH_BASE_URL"] = TEST_ISSUER;
process.env["NODE_ENV"] = "test";
process.env["INVENTORY_S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["INVENTORY_S3_REGION"] ??= "eu-central-1";
process.env["INVENTORY_S3_BUCKET"] ??= "inventory-test";
process.env["INVENTORY_S3_ACCESS_KEY_ID"] ??= "test-access-key";
process.env["INVENTORY_S3_SECRET_ACCESS_KEY"] ??= "test-secret-key";
process.env["INVENTORY_S3_EU_ENDPOINT_HOSTS"] = new URL(
  process.env["INVENTORY_S3_ENDPOINT"],
).hostname;
process.env["NOTIFY_INTERNAL_URL"] ??= "http://localhost:8081";
process.env["SERVICE_CLIENT_ID"] ??= "inventory-api";
process.env["SERVICE_CLIENT_SECRET"] ??=
  "test-service-client-secret-at-least-32-characters";

export interface SignTokenOptions {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
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

// ─── Process-wide state (see the note above) ─────────────────────────────────

let privateKey: CryptoKey | undefined;
let localJWKS:
  | ((
      protectedHeader?: JWSHeaderParameters,
      token?: FlattenedJWSInput,
    ) => Promise<CryptoKey>)
  | undefined;

let resolveImpl: (
  authorizationHeader: string,
) => Promise<ResolveResponse> = async () => {
  throw new Error("resolveImpl not configured for this test");
};
let callCount = 0;
let mocksInstalled = false;

function installMocks(): void {
  if (mocksInstalled) return;
  mocksInstalled = true;

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
      Variables: {
        userId: string;
        email: string;
        userName?: string;
        permEpoch: number;
      };
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
        if (!localJWKS) throw new Error("harness.init() was not called");
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
        if (typeof payload["name"] === "string" && payload["name"].trim()) {
          c.set("userName", payload["name"]);
        }
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
}

const harness: TestAuthHarness = {
  async init() {
    if (privateKey) return;
    const kp = await generateKeyPair("RS256", { extractable: true });
    privateKey = kp.privateKey;
    const publicJwk = await exportJWK(kp.publicKey);
    localJWKS = createLocalJWKSet({
      keys: [{ ...publicJwk, use: "sig", alg: "RS256", kid: TEST_KID }],
    });
  },
  async signToken({ sub, email, name, permEpoch }: SignTokenOptions) {
    if (!privateKey) throw new Error("harness.init() was not called");
    const jwt = new SignJWT({
      email,
      ...(name !== undefined ? { name } : {}),
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

/** Installs the two mocks (once per process) and returns the shared harness. */
export function setupTestAuth(): TestAuthHarness {
  installMocks();
  return harness;
}
