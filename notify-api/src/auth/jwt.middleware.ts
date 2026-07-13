import { createMiddleware } from "hono/factory";
import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
} from "jose";
import { env } from "../lib/env";

// ─── Context variable types ───────────────────────────────────────────────────

/**
 * Variables set on context by jwtMiddleware on successful verification.
 * Import this type into the Hono app/router generics for downstream route handlers.
 */
export type JwtVariables = {
  userId: string;
  email: string;
};

// ─── JWKS key set — built ONCE at module scope ────────────────────────────────
// createRemoteJWKSet returns a cached KeyLike resolver. It fetches the JWKS
// on the first unknown `kid` and honours Cache-Control: max-age=3600 from the
// auth service — no per-request fetch in the steady state.
const JWKS = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL));

/**
 * JWKS-verifier readiness (ADR-0005 cold-start note; plan.md §API contracts
 * "GET /health … additionally report JWKS-verifier readiness"). `JWKS.jwks()`
 * is a synchronous getter over jose's in-memory cache — it never triggers a
 * network fetch itself, it only reports whether at least one fetch has
 * succeeded (the JWKS is lazily fetched on the first unknown `kid`, i.e. the
 * first real verification attempt, not at process start). Consumed by
 * health.routes.ts; exported so the health route never has to reach into the
 * JWKS singleton directly.
 */
export const isJwksReady = (): boolean => JWKS.jwks() !== undefined;

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
 * JWT resource-server middleware (ADR-0005).
 *
 * 1. Reads Authorization: Bearer <jwt>. Missing / malformed → 401 Problem JSON.
 * 2. Verifies the RS256 signature against the auth service JWKS (cached remote fetch).
 *    Algorithm is pinned to RS256 — alg:none / HS256 confusion rejected.
 *    issuer is pinned to AUTH_ISSUER.
 * 3. Any verification failure (expired, bad signature, wrong issuer/kid/alg) → 401.
 * 4. On success: sets c.set('userId', sub) and c.set('email', email).
 *
 * NO database access occurs for unauthenticated requests (AC-4.2).
 */
export const jwtMiddleware = createMiddleware<{
  Variables: JwtVariables;
}>(async (c, next) => {
  // 1. Extract Bearer token from Authorization header.
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return unauthorized(
      "A valid Bearer token is required",
      c.req.path,
    );
  }

  const token = authHeader.slice(7); // strip "Bearer "

  if (!token) {
    return unauthorized(
      "A valid Bearer token is required",
      c.req.path,
    );
  }

  // 2. Verify RS256 signature, issuer, audience, and expiry via cached remote JWKS.
  //    algorithms: ['RS256'] pins the algorithm — rejects alg:none and HS256.
  //    audience (ADR-0010): notify-api is the suite's first real second JWKS
  //    resource server — a token missing or carrying the wrong `aud` is rejected
  //    here, closing the cross-service token-replay gap ADR-0005/ADR-0007 deferred.
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      algorithms: ["RS256"],
    });
    payload = result.payload;
  } catch (err) {
    // Translate all jose verification failures → 401 Problem JSON.
    // We log the code (not full error) so no token details hit app logs.
    const code =
      err instanceof joseErrors.JOSEError
        ? (err.code ?? err.constructor.name)
        : "JWT_VERIFY_FAILED";

    console.warn("[jwt] verification failed:", code);

    return unauthorized(
      "The provided token is invalid or has expired",
      c.req.path,
    );
  }

  // 3. Validate required claims are present.
  const userId = payload.sub;
  const email =
    typeof payload.email === "string" ? payload.email : undefined;

  if (!userId) {
    return unauthorized("Token is missing required 'sub' claim", c.req.path);
  }

  if (!email) {
    return unauthorized(
      "Token is missing required 'email' claim",
      c.req.path,
    );
  }

  // 4. Set context variables for downstream route handlers.
  c.set("userId", userId);
  c.set("email", email);

  return next();
});
