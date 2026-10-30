/**
 * systemAuthMiddleware (specs/015 T6, ADR-0044; generalised by specs/016 T3,
 * ADR-0049; shared token removed by specs/016 T14) — the ONLY auth for
 * `POST /system/notifications` and `POST /system/emails`. Each route builds it
 * with the ONE scope it requires (`notifications.push` / `emails.send`) and it
 * accepts exactly one credential:
 *
 *  `Authorization: Bearer <service JWT>` minted by `auth`'s
 *  `POST /system/service-token` (or `auth`'s in-process self-mint): RS256 via
 *  the suite JWKS, issuer pinned, `aud` = SERVICE_AUDIENCE (never
 *  AUTH_AUDIENCE, so a user JWT is not a system credential), the route's scope
 *  in the space-delimited `scope` claim, and `sub` of the form
 *  `system:<client>`.
 *
 * No other header is a credential: `X-Internal-Token` is never read, so any
 * value of it is simply an absent credential (401, AC-5.1).
 *
 * jwtMiddleware (user routes) keeps verifying `aud = AUTH_AUDIENCE`, so a
 * service token is rejected there.
 *
 * Every failure — no credential, any JWT defect, the other route's scope —
 * returns the SAME 401 body, so a caller learns nothing about which check
 * failed. Nothing about the presented credential is ever logged except the
 * jose error code.
 *
 * An accepted call logs `[system-auth] <METHOD> <path> caller=<sub>` and
 * nothing else: the rollout's confirmation step reads this line (AC-6.2).
 *
 * Origin binding (push only): a service principal may only raise
 * notifications for the origin app(s) bound to its `sub` below. The
 * middleware exposes the allowed list on the context; the route enforces it
 * after body validation (403). A `system:*` sub with no binding gets none.
 */

import { createMiddleware } from "hono/factory";
import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTVerifyGetKey,
} from "jose";
import { env } from "@/lib/env";

export type SystemScope = "notifications.push" | "emails.send";
const SERVICE_SUB_PREFIX = "system:";

/** sub -> origin apps that principal may raise. Unlisted `system:*` subs get none. */
const SERVICE_ORIGIN_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  "system:inventory-api": ["inventory"],
  "system:refund-api": ["refund"],
  "system:estimai-api": ["estimai"],
};

export type SystemAuthVariables = {
  /** The service principal's permitted origin apps. */
  allowedOrigins: readonly string[];
  /** The service JWT `sub`. */
  serviceSub: string;
};

export const originAllowed = (
  allowed: readonly string[],
  originApp: string,
): boolean => allowed.includes(originApp);

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

// Built lazily, once: no JWKS object (and no fetch) unless a Bearer is
// actually presented.
let defaultJwks: JWTVerifyGetKey | undefined;
const getDefaultJwks = (): JWTVerifyGetKey =>
  (defaultJwks ??= createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)));

export type SystemAuthOptions = {
  /** The one scope this route requires. */
  scope: SystemScope;
  /** Injected in tests; defaults to the auth service's remote JWKS. */
  jwks?: JWTVerifyGetKey;
  /** Defaults to env.SERVICE_AUDIENCE. `undefined` disables the Bearer path (fail closed). */
  audience?: string | undefined;
};

export const createSystemAuthMiddleware = (opts: SystemAuthOptions) => {
  const resolveAudience = () =>
    "audience" in opts ? opts.audience : env.SERVICE_AUDIENCE;

  const accept = (method: string, path: string, caller: string) => {
    console.log(`[system-auth] ${method} ${path} caller=${caller}`);
  };

  return createMiddleware<{ Variables: SystemAuthVariables }>(
    async (c, next) => {
      // Scoped service JWT — the only credential.
      const audience = resolveAudience();
      const authHeader = c.req.header("Authorization");
      if (!audience || !authHeader || !authHeader.startsWith("Bearer ")) {
        return unauthorized(c.req.path);
      }
      const token = authHeader.slice(7);
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
          sub.length === SERVICE_SUB_PREFIX.length
        ) {
          return unauthorized(c.req.path);
        }

        const scope = payload["scope"];
        if (
          typeof scope !== "string" ||
          !scope.split(" ").includes(opts.scope)
        ) {
          return unauthorized(c.req.path);
        }

        c.set("allowedOrigins", SERVICE_ORIGIN_BINDINGS[sub] ?? []);
        c.set("serviceSub", sub);
        accept(c.req.method, c.req.path, sub);
      } catch (err) {
        const code =
          err instanceof joseErrors.JOSEError
            ? (err.code ?? err.constructor.name)
            : "JWT_VERIFY_FAILED";
        console.warn("[system-jwt] verification failed:", code);
        return unauthorized(c.req.path);
      }

      return next();
    },
  );
};

