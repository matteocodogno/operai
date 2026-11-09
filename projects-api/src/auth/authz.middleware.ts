/**
 * projects-api's authorization-enforcing middleware (specs/024-projects, ADR-0014).
 * Copied from crm-api/src/auth/authz.middleware.ts — the repo has no workspace
 * (ADR-0003), so each resource server owns its copy.
 *
 * Runs AFTER `jwtMiddleware` on every gated route. Resolves the caller's
 * permissions live from `auth GET /authz/resolve`, forwarding the caller's own
 * already-verified Bearer token verbatim (no new credential, ADR-0014 point 1),
 * and sets `c.var.authz = { permissions, entity }`.
 *
 * Caching (ADR-0014 point 2): keyed by `(sub, perm_epoch)` with a 30 s hard TTL
 * backstop. Fail-closed (ADR-0014 point 4): if `/authz/resolve` is unreachable
 * or answers non-2xx, the request is refused with 503 — never "allow", never a
 * stale cache entry.
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
const CACHE_SWEEP_THRESHOLD = 1_000;

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
      code: "authz_unavailable",
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

  // Expired entries are otherwise only overwritten, never evicted — sweep them
  // once the map is large so a long-lived process cannot grow without bound.
  if (cache.size >= CACHE_SWEEP_THRESHOLD) {
    for (const [k, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(k);
    }
  }
  cache.set(key, { context, expiresAt: now + CACHE_TTL_MS });

  c.set("authz", context);
  return next();
});
