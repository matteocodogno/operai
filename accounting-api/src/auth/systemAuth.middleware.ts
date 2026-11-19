/**
 * systemAuth middleware — the only credential of accounting-api's `/system/v1/*` routes
 * (specs/20261119-accounting T4, used from T13; ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049 mechanism, ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…).
 * A shared copy of crm-api/src/auth/systemAuth.middleware.ts — the repo has no workspace (ADR 20260703-estimai-api-bun-hono-typescript), so each
 * resource server owns its copy and `scripts/check-shared-copies.ts` keeps the marked region identical across them.
 *
 * The ONLY credential on a `/system/v1/*` route is a scoped service JWT minted by `auth`
 * (`POST /system/service-token`): RS256 via the suite JWKS, issuer pinned, `aud` =
 * SERVICE_AUDIENCE (never AUTH_AUDIENCE, so a user JWT is not a system credential), the route's
 * scope (`accounting.reference.read`) in the space-delimited `scope` claim, and a `sub` on the
 * route's allowlist (`system:refund-api`). Every failure answers the SAME 401 body.
 *
 * Attach per route, through `createRoute({ middleware: [...] })`, never with `app.use("*", …)`.
 */

// shared-copy:begin systemAuth
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
// shared-copy:end systemAuth
