/**
 * systemAuth middleware — the only credential of crm-api's `/system` routes
 * (specs/021 T6, AC-11.8; specs/018 AC-3.3; ADR-0044/0049 mechanism, ADR-0059).
 * Copied from notify-api/src/system/systemAuth.middleware.ts — the repo has no
 * workspace (ADR-0003), so each resource server owns its copy.
 *
 * The ONLY credential on a `/system/*` route is a scoped service JWT minted by
 * `auth` (`POST /system/service-token`): RS256 via the suite JWKS, issuer
 * pinned, `aud` = SERVICE_AUDIENCE (never AUTH_AUDIENCE, so a user JWT is not a
 * system credential), the route's scope in the space-delimited `scope` claim,
 * and a `sub` that is on the route's allowlist (`system:meetings-api` for the
 * meeting-host notices, `system:estimai-api` for the estimate notices of specs/018
 * AC-3.3, ADR-0073, `system:projects-api` for `GET /system/companies`, specs/025,
 * ADR-0080). A system sub that is not listed is refused: holding a
 * service credential is not holding THIS route's.
 *
 * Every failure — no credential, any JWT defect, the wrong scope or sub —
 * answers the SAME 401 body, so a caller learns nothing about which check
 * failed. Nothing about the presented credential is ever logged except the jose
 * error code. An accepted call logs `[system-auth] <METHOD> <path> caller=<sub>`
 * and nothing else (no query string, no body, no token).
 *
 * Fails closed: with SERVICE_AUDIENCE unset the Bearer path is disabled and
 * every call is a 401.
 *
 * Attach per route, through `createRoute({ middleware: [...] })`, never with
 * `router.use("*", …)` (every router is mounted at "/", see guards.ts).
 */

import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTVerifyGetKey } from "jose";
import { env } from "../lib/env";

const SERVICE_SUB_PREFIX = "system:";

export type SystemAuthVariables = {
  /** The verified service JWT `sub`, e.g. `system:meetings-api`. */
  serviceSub: string;
};

// One body for every failure: byte-identical, no hint of which check failed.
const unauthorized = (path: string) =>
  Response.json(
    {
      type: "https://httpstatuses.com/401",
      title: "Unauthorized",
      status: 401,
      detail: "Valid credentials are required",
      instance: path,
    },
    { status: 401 },
  );

// Built lazily, once: no JWKS object (and no fetch) unless a Bearer is presented.
let defaultJwks: JWTVerifyGetKey | undefined;
const getDefaultJwks = (): JWTVerifyGetKey => (defaultJwks ??= createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)));

/**
 * Test-only: replaces the process-wide default key set and returns the previous one so a test can
 * restore it. `bun test` runs every file in ONE process, and the memoised remote set caches whatever
 * the first request to `AUTH_JWKS_URL` answered, so a test cannot rely on stubbing `fetch`.
 */
export const __setDefaultJwksForTests = (jwks: JWTVerifyGetKey | undefined): JWTVerifyGetKey | undefined => {
  const previous = defaultJwks;
  defaultJwks = jwks;
  return previous;
};

export type SystemAuthOptions = {
  /** The one scope this route requires. */
  scope: string;
  /** The service principals allowed on this route (`system:<client>`). */
  allowedSubs: readonly string[];
  /** Injected in tests; defaults to the auth service's remote JWKS. */
  jwks?: JWTVerifyGetKey;
  /** Defaults to env.SERVICE_AUDIENCE. `undefined` disables the Bearer path (fail closed). */
  audience?: string | undefined;
};

export const createSystemAuthMiddleware = (opts: SystemAuthOptions) => {
  const resolveAudience = () => ("audience" in opts ? opts.audience : env.SERVICE_AUDIENCE);

  return createMiddleware<{ Variables: SystemAuthVariables }>(async (c, next) => {
    const audience = resolveAudience();
    const authHeader = c.req.header("Authorization");
    if (!audience || !authHeader || !authHeader.startsWith("Bearer ")) return unauthorized(c.req.path);
    const token = authHeader.slice("Bearer ".length);
    if (!token) return unauthorized(c.req.path);

    try {
      const { payload } = await jwtVerify(token, opts.jwks ?? getDefaultJwks(), {
        issuer: env.AUTH_ISSUER,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub", "aud", "iss"],
      });

      const sub = payload.sub;
      if (
        typeof sub !== "string" ||
        !sub.startsWith(SERVICE_SUB_PREFIX) ||
        sub.length === SERVICE_SUB_PREFIX.length ||
        !opts.allowedSubs.includes(sub)
      ) {
        return unauthorized(c.req.path);
      }

      const scope = payload["scope"];
      if (typeof scope !== "string" || !scope.split(" ").includes(opts.scope)) return unauthorized(c.req.path);

      c.set("serviceSub", sub);
      console.log(`[system-auth] ${c.req.method} ${c.req.path} caller=${sub}`);
    } catch (err) {
      const code = err instanceof joseErrors.JOSEError ? (err.code ?? err.constructor.name) : "JWT_VERIFY_FAILED";
      console.warn("[system-auth] verification failed:", code);
      return unauthorized(c.req.path);
    }

    return next();
  });
};
