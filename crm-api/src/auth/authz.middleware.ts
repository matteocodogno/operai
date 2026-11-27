/**
 * crm-api's authorization-enforcing middleware (specs/20261101-crm, ADR 20260716-refund-api-authorization-enforcing-resource-server).
 * Copied from inventory-api/src/auth/authz.middleware.ts — the repo has no workspace
 * (ADR 20260703-estimai-api-bun-hono-typescript), so each resource server owns its copy.
 *
 * Runs AFTER `jwtMiddleware` on every gated route. Resolves the caller's
 * permissions live from `auth GET /authz/resolve`, forwarding the caller's own
 * already-verified Bearer token verbatim (no new credential, ADR 20260716-refund-api-authorization-enforcing-resource-server point 1),
 * and sets `c.var.authz = { permissions, entity }`.
 *
 * Caching (ADR 20260716-refund-api-authorization-enforcing-resource-server point 2): keyed by `(sub, perm_epoch)` with a 30 s hard TTL
 * backstop, counted from the moment the resolve was SENT. Fail-closed (ADR 20260716-refund-api-authorization-enforcing-resource-server point 4):
 * if `/authz/resolve` is unreachable or answers non-2xx, the request is refused with 503 — never "allow", never a
 * stale cache entry.
 *
 * Single flight (specs/20261126-teams R13 a). A cache miss joins the resolve already running for the same
 * `(sub, perm_epoch)` or starts one, so a person's concurrent requests cost one call, and the answer is the one the
 * cache would have shared with them anyway. The flight keeps its own `RESOLVE_TIMEOUT_MS`, is never aborted by a
 * request that stops waiting, and stores its answer (never a failure) when it ends.
 *
 * Two variants, the same guard:
 *   `authzMiddleware`      page routes: no deadline above them, so a request waits for the whole flight.
 *   `hostAuthzMiddleware`  the host routes (`/activity-host/v1/resolve`, `/meeting-host/v1/resolve`), inside the 2 s of
 *                          their callers: waits at most `HOST_AUTHZ_WAIT_MS` for a flight, then the same 503
 *                          `authz_unavailable` (fail closed — a timeout is never an allow). The flight runs on and
 *                          fills the cache, so the retry the 503 asks for is served from it.
 */

import { createMiddleware } from "hono/factory";
import type { JwtVariables } from "./jwt.middleware";
import { HOST_AUTHZ_WAIT_MS } from "../lib/hostBudget";
import {
  fetchAuthzResolve,
  type ResolvedPermission,
} from "../authz/resolveClient";

// shared-copy:begin authzFlight
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

/**
 * The resolve in flight per `(sub, perm_epoch)`. A flight NEVER rejects (a failure is `null`, logged once), so a request
 * that stopped waiting leaves no unhandled rejection behind. It is removed when it settles, after the cache is filled.
 */
const inflight = new Map<string, Promise<AuthzContext | null>>();

function cacheKey(sub: string, permEpoch: number): string {
  // NUL is not a legal character in a user id or a number's decimal
  // representation, so this can't collide across different (sub, epoch)
  // pairs the way "a:1"/"a" + ":1" could with a naive separator.
  return `${sub}\0${permEpoch}`;
}

/** Test-only escape hatch — clears the module-scope cache and flights between test cases. */
export function __resetAuthzCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

// ─── The flight ─────────────────────────────────────────────────────────────

/** One resolve, stamped when it is sent. Never throws: a failure is `null`. */
async function resolveOnce(
  key: string,
  authorizationHeader: string,
): Promise<AuthzContext | null> {
  const sentAt = Date.now();
  try {
    const resolved = await fetchAuthzResolve(authorizationHeader);
    const context: AuthzContext = {
      permissions: resolved.permissions,
      entity: resolved.entity,
    };
    // Expired entries are otherwise only overwritten, never evicted — sweep them
    // once the map is large so a long-lived process cannot grow without bound.
    if (cache.size >= CACHE_SWEEP_THRESHOLD) {
      const now = Date.now();
      for (const [k, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(k);
      }
    }
    cache.set(key, { context, expiresAt: sentAt + CACHE_TTL_MS });
    return context;
  } catch (err) {
    // Fail CLOSED (ADR 20260716-refund-api-authorization-enforcing-resource-server point 4) — never fall back to "allow", and never
    // serve a stale cache entry to paper over the outage. Nothing is stored.
    console.error(
      "[authz] auth GET /authz/resolve failed — denying request (fail-closed):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Joins the flight of `key` or starts one with `authorizationHeader` (the verified caller's own). */
function flightFor(
  key: string,
  authorizationHeader: string,
): Promise<AuthzContext | null> {
  const running = inflight.get(key);
  if (running) return running;
  const flight: Promise<AuthzContext | null> = resolveOnce(
    key,
    authorizationHeader,
  ).finally(() => {
    if (inflight.get(key) === flight) inflight.delete(key);
  });
  inflight.set(key, flight);
  return flight;
}

const WAIT_EXCEEDED = Symbol("wait_exceeded");

/** The flight's answer, or `WAIT_EXCEEDED` when it is still running after `waitMs` (`null`: no limit). */
async function waitFor(
  flight: Promise<AuthzContext | null>,
  waitMs: number | null,
): Promise<AuthzContext | null | typeof WAIT_EXCEEDED> {
  if (waitMs === null) return flight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      flight,
      new Promise<typeof WAIT_EXCEEDED>((resolve) => {
        timer = setTimeout(() => resolve(WAIT_EXCEEDED), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Middleware ─────────────────────────────────────────────────────────────

/**
 * `waitMs: null` waits for the whole flight (page routes); a number is the host variant's bound.
 * @internal exported for tests; routes use `authzMiddleware` and `hostAuthzMiddleware`.
 */
export function createAuthzMiddleware(waitMs: number | null) {
  return createMiddleware<{
    Variables: AuthzVariables;
  }>(async (c, next) => {
    const sub = c.get("userId");
    const permEpoch = c.get("permEpoch");

    const key = cacheKey(sub, permEpoch);
    const cached = cache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      c.set("authz", cached.context);
      return next();
    }

    // jwtMiddleware (which runs before this) already rejected any request
    // with no/malformed Authorization header, so this is guaranteed present.
    const authorizationHeader = c.req.header("Authorization")!;

    const answer = await waitFor(
      flightFor(key, authorizationHeader),
      waitMs,
    );
    if (answer === WAIT_EXCEEDED) {
      // Not an allow: the request is refused inside its caller's deadline, and the flight (not aborted) fills the cache.
      console.error(
        "[authz] auth GET /authz/resolve not answered within the host wait: denying (fail-closed) reason=wait_exceeded",
      );
      return serviceUnavailable(
        "Authorization service is unavailable — request denied",
        c.req.path,
      );
    }
    if (answer === null) {
      return serviceUnavailable(
        "Authorization service is unavailable — request denied",
        c.req.path,
      );
    }

    c.set("authz", answer);
    return next();
  });
}

// shared-copy:end authzFlight

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

/** The page variant: waits for the whole resolve. */
export const authzMiddleware = createAuthzMiddleware(null);

/** The host variant: waits at most `HOST_AUTHZ_WAIT_MS` for a resolve it has not cached. */
export const hostAuthzMiddleware = createAuthzMiddleware(HOST_AUTHZ_WAIT_MS);
