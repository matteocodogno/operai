/**
 * refund-api's authorization-enforcing middleware (T6, specs/007-refund-service,
 * ADR-0014).
 *
 * Runs AFTER `jwtMiddleware` on every gated route (identity is already
 * established — `c.var.userId`/`email`/`permEpoch`). Resolves the caller's
 * REFUND permissions live from `auth GET /authz/resolve`, forwarding the
 * caller's own already-verified Bearer token verbatim (no new credential,
 * ADR-0014 point 1). Sets `c.var.authz = { permissions, entity }` for
 * downstream route handlers (T7+) to gate on via `src/authz/conditions.ts`'s
 * helpers.
 *
 * Caching (ADR-0014 point 2): keyed by `(sub, perm_epoch)` — the epoch read
 * off the caller's OWN verified JWT by jwtMiddleware. A grant change bumps
 * `perm_epoch` at `auth`; the caller's next refreshed token carries the new
 * epoch, which is a cache-key MISS here, forcing a fresh resolve. A short
 * hard TTL (30s) sits alongside the epoch key as a liveness backstop,
 * bounding worst-case staleness independent of how promptly any individual
 * client refreshes its own token.
 *
 * Fail-closed (ADR-0014 point 4): if `/authz/resolve` is unreachable or
 * returns a non-2xx response, this middleware responds 503 — it NEVER falls
 * back to "allow", and it never serves a stale/expired cache entry to paper
 * over the outage. Every authorization-gated route now has a hard runtime
 * dependency on `auth`'s availability; this is an accepted trade-off given
 * this feature's financial-data weight (plan.md Risk R3), not a defect.
 */

import { createMiddleware } from "hono/factory";
import type { JwtVariables } from "./jwt.middleware";
import {
  fetchAuthzResolve,
  type ResolvedPermission,
} from "../authz/resolveClient";

// ─── Context variable types ────────────────────────────────────────────────

export interface AuthzContext {
  readonly permissions: readonly ResolvedPermission[];
  readonly entity: string | null;
}

export type AuthzVariables = JwtVariables & {
  authz: AuthzContext;
};

// ─── In-process (sub, perm_epoch) cache, 30s hard TTL backstop ────────────

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly context: AuthzContext;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(sub: string, permEpoch: number): string {
  // NUL is not a legal character in a user id or a number's decimal
  // representation, so this can't collide across different (sub, epoch)
  // pairs the way "a:1"/"a" + ":1" could with a naive separator.
  return `${sub}\0${permEpoch}`;
}

/** Test-only escape hatch — clears the module-scope cache between test cases. */
export function __resetAuthzCacheForTests(): void {
  cache.clear();
}

// ─── Problem JSON 503 helper ────────────────────────────────────────────────

const serviceUnavailable = (detail: string, path: string) =>
  Response.json(
    {
      type: "https://httpstatuses.com/503",
      title: "Service Unavailable",
      status: 503,
      detail,
      instance: path,
    },
    { status: 503 },
  );

// ─── Middleware ─────────────────────────────────────────────────────────────

export const authzMiddleware = createMiddleware<{
  Variables: AuthzVariables;
}>(async (c, next) => {
  const sub = c.get("userId");
  const permEpoch = c.get("permEpoch");

  const key = cacheKey(sub, permEpoch);
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    c.set("authz", cached.context);
    return next();
  }

  // jwtMiddleware (which runs before this) already rejected any request
  // with no/malformed Authorization header, so this is guaranteed present.
  const authorizationHeader = c.req.header("Authorization")!;

  let context: AuthzContext;
  try {
    const resolved = await fetchAuthzResolve(authorizationHeader);
    context = { permissions: resolved.permissions, entity: resolved.entity };
  } catch (err) {
    // Fail CLOSED (ADR-0014 point 4) — never fall back to "allow", and never
    // serve a stale cache entry to paper over the outage.
    console.error(
      "[authz] auth GET /authz/resolve failed — denying request (fail-closed):",
      err instanceof Error ? err.message : err,
    );
    return serviceUnavailable(
      "Authorization service is unavailable — request denied",
      c.req.path,
    );
  }

  cache.set(key, { context, expiresAt: now + CACHE_TTL_MS });

  c.set("authz", context);
  return next();
});
