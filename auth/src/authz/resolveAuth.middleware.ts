/**
 * Bearer-JWT verification for the resource-server authorization seam
 * (T1, specs/007-refund-service — refs AC-5.4, AC-6.4, AC-7.5; ADR-0014).
 *
 * `GET /authz/me` (spec 004) is session-cookie-gated — built for the shell, a
 * browser client that already holds a better-auth session cookie. A resource
 * server such as `refund-api` holds no such cookie; it only ever forwards the
 * SAME Bearer JWT its own caller already presented to it (already verified
 * there per ADR-0005/0010). `GET /authz/resolve` (`resolve.routes.ts`) is
 * gated by THIS middleware instead — it authenticates that forwarded Bearer
 * token exactly like every other resource-server call in the suite (RS256,
 * pinned `iss`/`aud`), except verification happens IN-PROCESS rather than
 * over the network the way `estimai-api`/`notify-api` verify tokens `auth`
 * issued (`estimai-api/src/auth/jwt.middleware.ts`'s `createRemoteJWKSet`).
 *
 * IMPORTANT — which key actually signs a token (ADR-0005 "Correction"):
 * tokens minted by `GET /auth/token` are signed by better-auth's `jwt`
 * plugin using a ROTATING RS256 keypair it manages itself in the DB `jwks`
 * table (dynamic `kid`), published at better-auth's own `/auth/jwks`
 * endpoint (`auth.routes.ts` delegates ALL `/auth/**` traffic, including
 * this, to `auth.handler`). The env `JWT_PUBLIC_KEY`/`JWT_PRIVATE_KEY` pair
 * — used by `jwks/jwks.routes.ts`'s CUSTOM `/.well-known/jwks.json` — is a
 * DIFFERENT, unrelated static keypair that does **not** sign `/auth/token`
 * (see `jwt-claims.contract.test.ts` and ADR-0005's dated correction). This
 * middleware therefore fetches keys from `/auth/jwks`, never from
 * `env.JWT_PUBLIC_KEY` — using the latter here would make every real caller
 * token fail verification (unknown `kid`).
 *
 * "In-process, not a remote-JWKS round trip" (ADR-0014 point 1) is realized
 * by calling `authRouter.request("/auth/jwks")` directly — Hono's
 * `.request()` invokes the fetch handler function in the same process, no
 * TCP/HTTP socket — then verifying locally via `jose`'s `createLocalJWKSet`
 * with EXPLICIT `issuer`/`audience`/`algorithms` pinning (unlike better-
 * auth's own `auth.api.verifyJWT` server endpoint, whose audience default is
 * the service's `baseURL`, not `env.AUTH_AUDIENCE` — it cannot enforce
 * ADR-0010's `aud` pinning without a body-level override this codebase does
 * not use, so it is deliberately NOT used here). The fetched key set is
 * cached in-process with a short TTL and refetched immediately on an unknown
 * `kid` (key rotation), mirroring `createRemoteJWKSet`'s steady-state/miss
 * behaviour without an actual network hop.
 */

import { createMiddleware } from "hono/factory";
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { authRouter } from "../auth/auth.routes";
import { env } from "../lib/env";

// ─── Context variable types ───────────────────────────────────────────────────

/** Variables set on context by `bearerJwtMiddleware` on successful verification. */
export type ResolveAuthVariables = {
  callerId: string;
};

// ─── In-process JWKS cache ─────────────────────────────────────────────────
// Short TTL so a genuine key rotation is picked up promptly even without an
// unknown-kid miss; an unknown-kid verification failure also forces an
// immediate refetch below, regardless of the TTL.

const JWKS_CACHE_TTL_MS = 60_000;

let cachedJwks: JSONWebKeySet | null = null;
let cachedAt = 0;

/** Resets the module-scope cache — test-only escape hatch. */
export function __resetJwksCacheForTests(): void {
  cachedJwks = null;
  cachedAt = 0;
}

async function fetchJwks(): Promise<JSONWebKeySet> {
  const res = await authRouter.request("/auth/jwks");
  if (!res.ok) {
    throw new Error(`Failed to fetch /auth/jwks: ${res.status}`);
  }
  return (await res.json()) as JSONWebKeySet;
}

async function getJwks(forceRefresh: boolean): Promise<JSONWebKeySet> {
  const now = Date.now();
  if (!forceRefresh && cachedJwks && now - cachedAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks;
  }
  const jwks = await fetchJwks();
  cachedJwks = jwks;
  cachedAt = now;
  return jwks;
}

/**
 * Verifies `token` against the live `/auth/jwks` key set. Pins `alg:RS256`,
 * `iss:env.BETTER_AUTH_URL`, `aud:env.AUTH_AUDIENCE` (ADR-0010). Retries
 * ONCE with a forced cache refresh on an unrecognized `kid` (key rotation)
 * before giving up.
 */
async function verifyBearerToken(token: string): Promise<JWTPayload> {
  const verifyOptions = {
    issuer: env.BETTER_AUTH_URL,
    audience: env.AUTH_AUDIENCE,
    algorithms: ["RS256"],
  };

  try {
    const jwks = await getJwks(false);
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), verifyOptions);
    return payload;
  } catch (err) {
    const isUnknownKid =
      err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWKSMultipleMatchingKeys;
    if (!isUnknownKid) throw err;

    // Possible key rotation since the cache was last populated — refetch once.
    const jwks = await getJwks(true);
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), verifyOptions);
    return payload;
  }
}

// ─── Problem JSON 401 helper ──────────────────────────────────────────────────

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

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * 1. Reads `Authorization: Bearer <jwt>`. Missing/malformed → 401.
 * 2. Verifies the RS256 signature against the live `/auth/jwks` key set
 *    (algorithm pinned — alg:none/HS256 confusion rejected); issuer pinned
 *    to `env.BETTER_AUTH_URL`; audience pinned to `env.AUTH_AUDIENCE`
 *    (ADR-0010) — a token missing `aud`, or carrying a different value,
 *    fails here.
 * 3. Any verification failure (expired, bad signature, unknown `kid` after
 *    retry, wrong iss/aud) → 401.
 * 4. On success: sets `c.var.callerId` to the token's `sub` — the ONLY user
 *    this request may ever resolve permissions for (`resolve.routes.ts`
 *    never accepts a user-id parameter — caller-own-only, mirroring
 *    `/authz/me`).
 */
export const bearerJwtMiddleware = createMiddleware<{
  Variables: ResolveAuthVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return unauthorized("A valid Bearer token is required", c.req.path);
  }

  const token = authHeader.slice(7); // strip "Bearer "

  if (!token) {
    return unauthorized("A valid Bearer token is required", c.req.path);
  }

  let payload: JWTPayload;
  try {
    payload = await verifyBearerToken(token);
  } catch (err) {
    const code =
      err instanceof joseErrors.JOSEError ? (err.code ?? err.constructor.name) : "JWT_VERIFY_FAILED";
    console.warn("[authz/resolve] verification failed:", code);
    return unauthorized("The provided token is invalid or has expired", c.req.path);
  }

  const callerId = payload.sub;
  if (!callerId) {
    return unauthorized("Token is missing required 'sub' claim", c.req.path);
  }

  c.set("callerId", callerId);

  return next();
});
