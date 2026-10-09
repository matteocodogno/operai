/**
 * notificationsAuthMiddleware (specs/015 T6, ADR-0044) — the ONLY auth for
 * `POST /system/notifications`. Accepts EITHER:
 *
 *  1. the legacy shared `X-Internal-Token` (ADR-0011/0017/0040: `auth`,
 *     `refund-api`, `estimai-api`) — compared constant-time, exactly as
 *     internalTokenMiddleware does, no origin restriction; OR
 *  2. `Authorization: Bearer <service JWT>` minted by `auth`'s
 *     `POST /system/service-token`: RS256 via the suite JWKS, issuer pinned,
 *     `aud` = SERVICE_AUDIENCE (never AUTH_AUDIENCE, so a user JWT is not a
 *     system credential), `scope` containing `notifications.push`, and
 *     `sub` of the form `system:<client>`.
 *
 * `/system/emails` deliberately does NOT use this middleware: it stays on
 * internalTokenMiddleware (legacy token only), so the new scope can never
 * reach email. Conversely jwtMiddleware (user routes) keeps verifying
 * `aud = AUTH_AUDIENCE`, so a service token is rejected there.
 *
 * Every failure — no credential, wrong legacy token, any JWT defect — returns
 * the SAME 401 body, so a caller learns nothing about which check failed.
 * Nothing about the presented credential is ever logged except the jose
 * error code.
 *
 * Origin binding (decision not dictated by the plan, see report): a service
 * principal may only raise notifications for the origin app(s) bound to its
 * `sub` below. The middleware exposes the allowed list on the context; the
 * route enforces it after body validation (403). Legacy-token callers carry
 * `null` = unrestricted, unchanged.
 */

import { createMiddleware } from "hono/factory";
import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTVerifyGetKey,
} from "jose";
import { env } from "@/lib/env";
import { safeEqual } from "./internalToken.middleware";

export const NOTIFICATIONS_PUSH_SCOPE = "notifications.push";
const SERVICE_SUB_PREFIX = "system:";

/** sub -> origin apps that principal may raise. Unlisted `system:*` subs get none. */
const SERVICE_ORIGIN_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  "system:inventory-api": ["inventory"],
};

export type NotificationsAuthVariables = {
  /** null = legacy internal token (unrestricted); array = service principal's permitted origins. */
  allowedOrigins: readonly string[] | null;
  /** The service JWT `sub`, or null for the legacy token. */
  serviceSub: string | null;
};

export const originAllowed = (
  allowed: readonly string[] | null,
  originApp: string,
): boolean => allowed === null || allowed.includes(originApp);

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

// Built lazily, once: no JWKS object (and no fetch) unless the service-JWT
// path is enabled AND a Bearer is actually presented.
let defaultJwks: JWTVerifyGetKey | undefined;
const getDefaultJwks = (): JWTVerifyGetKey =>
  (defaultJwks ??= createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)));

export type NotificationsAuthOptions = {
  /** Injected in tests; defaults to the auth service's remote JWKS. */
  jwks?: JWTVerifyGetKey;
  /** Defaults to env.SERVICE_AUDIENCE. `undefined` disables the Bearer path (fail closed). */
  audience?: string | undefined;
};

export const createNotificationsAuthMiddleware = (
  opts: NotificationsAuthOptions | undefined = undefined,
) => {
  const resolveAudience = () =>
    opts && "audience" in opts ? opts.audience : env.SERVICE_AUDIENCE;

  return createMiddleware<{ Variables: NotificationsAuthVariables }>(
    async (c, next) => {
      // 1. Legacy shared token (constant-time).
      const internal = c.req.header("X-Internal-Token");
      if (internal && safeEqual(internal, env.NOTIFY_INTERNAL_TOKEN)) {
        c.set("allowedOrigins", null);
        c.set("serviceSub", null);
        return next();
      }

      // 2. Scoped service JWT.
      const audience = resolveAudience();
      const authHeader = c.req.header("Authorization");
      if (!audience || !authHeader || !authHeader.startsWith("Bearer ")) {
        return unauthorized(c.req.path);
      }
      const token = authHeader.slice(7);
      if (!token) return unauthorized(c.req.path);

      try {
        const { payload } = await jwtVerify(token, opts?.jwks ?? getDefaultJwks(), {
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
          !scope.split(" ").includes(NOTIFICATIONS_PUSH_SCOPE)
        ) {
          return unauthorized(c.req.path);
        }

        c.set("allowedOrigins", SERVICE_ORIGIN_BINDINGS[sub] ?? []);
        c.set("serviceSub", sub);
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

export const notificationsAuthMiddleware = createNotificationsAuthMiddleware();
