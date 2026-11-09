/**
 * systemAuthMiddleware (specs/024-projects T2, ADR-0076) — the ONLY auth for the
 * `/system/*` routes. Copied, minus the origin binding, from notify-api's
 * `src/system/systemAuth.middleware.ts` (specs/015 T6, ADR-0044/0049): the same
 * credential, verified the same way, so every resource server that exposes a
 * system route behaves identically.
 *
 * It accepts exactly one credential, `Authorization: Bearer <service JWT>`
 * minted by `auth` (`POST /system/service-token`): RS256 via the suite JWKS,
 * issuer pinned, `aud` = SERVICE_AUDIENCE (never AUTH_AUDIENCE, so a user JWT is
 * not a system credential), the route's scope in the space-delimited `scope`
 * claim, and `sub` of the form `system:<client>`.
 *
 * Fail closed: with SERVICE_AUDIENCE unset the Bearer path is off and every
 * request is a 401.
 *
 * Every failure — no credential, any JWT defect, another route's scope — returns
 * the SAME 401 body, so a caller learns nothing about which check failed.
 * Nothing about the presented credential is logged except the jose error code.
 * An accepted call logs `[system-auth] <METHOD> <path> caller=<sub>` and nothing
 * else.
 */

import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env } from "../lib/env";
import { problem } from "../lib/problem";

/** The scopes a `/system/*` route of crm-api may require. */
export type SystemScope = "crm.companies.read";

const SERVICE_SUB_PREFIX = "system:";

export type SystemAuthVariables = {
  /** The service JWT `sub` (`system:<client>`). */
  serviceSub: string;
};

// One body for every failure: byte-identical, no hint of which check failed.
const unauthorized = (path: string): Response =>
  problem({ status: 401, detail: "Valid credentials are required" }, path);

// Built lazily, once: no JWKS object (and no fetch) unless a Bearer is actually presented.
let defaultJwks: JWTVerifyGetKey | undefined;
const getDefaultJwks = (): JWTVerifyGetKey => (defaultJwks ??= createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)));

export type SystemAuthOptions = {
  /** The one scope this route requires. */
  scope: SystemScope;
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
      if (typeof sub !== "string" || !sub.startsWith(SERVICE_SUB_PREFIX) || sub.length === SERVICE_SUB_PREFIX.length) {
        return unauthorized(c.req.path);
      }
      const scope = payload["scope"];
      if (typeof scope !== "string" || !scope.split(" ").includes(opts.scope)) return unauthorized(c.req.path);

      c.set("serviceSub", sub);
      console.log(`[system-auth] ${c.req.method} ${c.req.path} caller=${sub}`);
    } catch (err) {
      const code = err instanceof joseErrors.JOSEError ? (err.code ?? err.constructor.name) : "JWT_VERIFY_FAILED";
      console.warn("[system-jwt] verification failed:", code);
      return unauthorized(c.req.path);
    }

    return next();
  });
};
