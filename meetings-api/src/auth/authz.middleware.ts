/**
 * meetings-api's authorization middleware (specs/021-meetings, ADR-0014).
 * Copied from crm-api/src/auth/authz.middleware.ts, plus ONE structural
 * difference (plan.md § Shape, AC-10.6): an OPTIONAL variant.
 *
 * Both variants resolve the caller's permissions live from `auth GET
 * /authz/resolve`, forwarding the caller's own already-verified Bearer token
 * verbatim (no new credential, ADR-0014 point 1), cached by `(sub, perm_epoch)`
 * with a 30 s hard TTL backstop (point 2). They differ only in what an `auth`
 * outage does:
 *
 *   authzMiddleware          fails CLOSED (point 4): 503, never "allow", never a
 *                            stale entry. Used by `capability(...)` and `eraser`.
 *   optionalAuthzMiddleware  never refuses. The request goes on with
 *                            `capabilities: "unavailable"` and no permissions, so
 *                            reading a meeting one created or was invited to does
 *                            not depend on `auth` being up. It can only ever
 *                            WITHHOLD a control, never grant one.
 *
 * Runs AFTER `jwtMiddleware`.
 */

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { JwtVariables } from "./jwt.middleware";
import { fetchAuthzResolve, type ResolvedPermission } from "../authz/resolveClient";

// ─── Context variable types ────────────────────────────────────────────────

export interface AuthzContext {
  readonly permissions: readonly ResolvedPermission[];
  readonly entity: string | null;
}

/** `resolved`: `permissions` is auth's answer. `unavailable`: auth could not answer; `permissions` is empty. */
export type CapabilitiesState = "resolved" | "unavailable";

export type AuthzVariables = JwtVariables & {
  authz: AuthzContext;
  capabilities: CapabilitiesState;
};

// ─── In-process (sub, perm_epoch) cache, 30s hard TTL backstop ────────────

const CACHE_TTL_MS = 30_000;
const CACHE_SWEEP_THRESHOLD = 1_000;

interface CacheEntry {
  readonly context: AuthzContext;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(sub: string, permEpoch: number): string {
  // NUL is not a legal character in a user id or a number's decimal
  // representation, so this can't collide across different (sub, epoch) pairs.
  return `${sub}\0${permEpoch}`;
}

/** Test-only escape hatch: clears the module-scope cache between test cases. */
export function __resetAuthzCacheForTests(): void {
  cache.clear();
}

// ─── Resolution ─────────────────────────────────────────────────────────────

type Ctx = Context<{ Variables: AuthzVariables }>;

/** The caller's permissions, or `null` when `auth` cannot answer. Never throws. */
async function resolve(c: Ctx): Promise<AuthzContext | null> {
  const key = cacheKey(c.get("userId"), c.get("permEpoch"));
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.context;

  // jwtMiddleware (which runs before this) already rejected any request
  // with no/malformed Authorization header, so this is guaranteed present.
  const authorizationHeader = c.req.header("Authorization")!;

  let context: AuthzContext;
  try {
    const resolved = await fetchAuthzResolve(authorizationHeader);
    context = { permissions: resolved.permissions, entity: resolved.entity };
  } catch (err) {
    // Message only: it names an HTTP status or a network error, never a token.
    console.error(
      "[authz] auth GET /authz/resolve failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  }

  // Expired entries are otherwise only overwritten, never evicted: sweep them
  // once the map is large so a long-lived process cannot grow without bound.
  if (cache.size >= CACHE_SWEEP_THRESHOLD) {
    for (const [k, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(k);
    }
  }
  cache.set(key, { context, expiresAt: now + CACHE_TTL_MS });
  return context;
}

const serviceUnavailable = (detail: string, path: string) =>
  Response.json(
    {
      type: "https://httpstatuses.com/503",
      title: "Service Unavailable",
      status: 503,
      detail,
      instance: path,
      code: "authorization_unavailable",
    },
    { status: 503 },
  );

// ─── Middleware ─────────────────────────────────────────────────────────────

/** Fail CLOSED (ADR-0014 point 4): an unreachable `auth` is a 503, never "allow". */
export const authzMiddleware = createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
  const context = await resolve(c);
  if (!context) {
    return serviceUnavailable("Authorization service is unavailable: request denied", c.req.path);
  }
  c.set("authz", context);
  c.set("capabilities", "resolved");
  return next();
});

/** Never refuses (AC-10.6): an outage becomes `capabilities: "unavailable"` with no permissions. */
export const optionalAuthzMiddleware = createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
  const context = await resolve(c);
  if (context) {
    c.set("authz", context);
    c.set("capabilities", "resolved");
  } else {
    c.set("authz", { permissions: [], entity: null });
    c.set("capabilities", "unavailable");
  }
  return next();
});
