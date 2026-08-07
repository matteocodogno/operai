/**
 * Thin HTTP client for the two `auth`-hosted third-party endpoints this
 * feature introduces (T5, specs/013-estimate-sharing, plan.md "The
 * third-party lookup" and "Display identity").
 *
 * Deliberately isolated in its own module, mirroring `refund-api/src/authz/
 * resolveClient.ts` and `refund-api/src/lib/notify.ts` — a single-function-
 * per-concern module so route tests can `mock.module()` this file rather
 * than mocking global `fetch` or re-mocking `jose` a second time in the same
 * bun worker (see `estimai-api/src/estimates/estimates.routes.test.ts`'s
 * comment on why re-mocking `jose` collides across test files run in one
 * process).
 *
 * Both functions forward the CALLER'S OWN Bearer `Authorization` header
 * verbatim — no new service credential is introduced (plan.md's decision:
 * "an internal token would put an inbound service-trust surface on the
 * identity service itself... The forwarded-JWT model introduces no new
 * credential at all").
 *
 * The two functions have DELIBERATELY OPPOSITE failure contracts — this is
 * not an inconsistency to "harmonise":
 *
 *   - `checkAppAccess` FAILS CLOSED (throws on any non-2xx response or
 *     network failure). It answers an AUTHORIZATION question (plan.md:
 *     "adding a collaborator... fails closed, 503 — ADR-0014's posture,
 *     because it is an authorization decision"). The caller
 *     (collaborators.routes.ts, T8) is responsible for turning that
 *     rejection into a 503 `authorization_service_unavailable` and creating
 *     NO grant row.
 *   - `resolveIdentities` FAILS SOFT (never throws; a failure degrades every
 *     requested id to `status: "unknown"`). It answers a DECORATIVE display
 *     question that never gates access (plan.md: "display-identity
 *     resolution... fails soft to an 'unknown' placeholder, because it is
 *     decorative and never gates access"). `estimai-api`'s read/write path
 *     must keep working when `auth` is down (plan.md's "Why estimai-api does
 *     NOT become an authorization-enforcing resource server").
 */

import { env } from "./env";

// ─── POST /authz/app-access-check — eligibility DECISION, fails CLOSED ─────

export interface AppAccessCheckResult {
  readonly eligible: boolean;
  /** Only present when `eligible` is true. */
  readonly userId?: string;
}

/**
 * Calls `${AUTH_BASE_URL}/authz/app-access-check`, forwarding
 * `authorizationHeader` (the full `"Bearer <jwt>"` string) verbatim.
 *
 * Throws on any non-2xx response or network failure — by design (see file
 * header). Callers MUST catch and map the rejection to a fail-closed 503;
 * they must never treat a thrown error as "not eligible" (that would be a
 * silent allow-by-omission on the write path, and a silent-deny-as-if-fact
 * on the read path — both wrong).
 */
export async function checkAppAccess(
  authorizationHeader: string,
  appId: string,
  email: string,
): Promise<AppAccessCheckResult> {
  const res = await fetch(`${env.AUTH_BASE_URL}/authz/app-access-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorizationHeader,
    },
    body: JSON.stringify({ appId, email }),
  });

  if (!res.ok) {
    throw new Error(
      `auth POST /authz/app-access-check responded with HTTP ${res.status}`,
    );
  }

  return (await res.json()) as AppAccessCheckResult;
}

// ─── POST /authz/users/identities — display identity, fails SOFT + cached ─

export type IdentityStatus = "active" | "deleted" | "unknown";

export interface Identity {
  readonly id: string;
  readonly status: IdentityStatus;
  readonly name: string | null;
}

interface CacheEntry {
  readonly identity: Identity;
  readonly expiresAt: number;
}

// 60s TTL (plan.md "Display identity"), in-process (single instance today —
// plan.md R7). Keyed by the `auth` user id (`sub`), not by anything caller-
// or estimate-scoped, so the same colleague's identity is a cache hit across
// every estimate/list render that mentions them.
const IDENTITY_CACHE_TTL_MS = 60_000;

const identityCache = new Map<string, CacheEntry>();

/** Test-only escape hatch — production code never needs to clear the cache. */
export function __resetIdentityCacheForTests(): void {
  identityCache.clear();
}

const unknownIdentity = (id: string): Identity => ({
  id,
  status: "unknown",
  name: null,
});

/**
 * Resolves display identity for up to 100 `auth` user ids, forwarding
 * `authorizationHeader` verbatim. Distinct ids are deduplicated by the
 * caller before this is invoked (batched per list render — plan.md).
 *
 * NEVER THROWS (see file header). A network failure, a non-2xx response, or
 * an id `auth` doesn't return degrades that id to `{status:"unknown",
 * name:null}` rather than propagating an error — `GET /estimates` and
 * `GET /estimates/{id}` must keep returning 200 even when `auth` is
 * unreachable.
 *
 * Serves cached entries (<60s old) without a network call at all; only the
 * ids that are cold or expired are actually fetched.
 */
export async function resolveIdentities(
  authorizationHeader: string,
  ids: readonly string[],
): Promise<Map<string, Identity>> {
  const now = Date.now();
  const result = new Map<string, Identity>();
  const uncached: string[] = [];

  for (const id of ids) {
    const cached = identityCache.get(id);
    if (cached && cached.expiresAt > now) {
      result.set(id, cached.identity);
    } else {
      uncached.push(id);
    }
  }

  if (uncached.length === 0) {
    return result;
  }

  try {
    const res = await fetch(`${env.AUTH_BASE_URL}/authz/users/identities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorizationHeader,
      },
      body: JSON.stringify({ ids: uncached }),
    });

    if (!res.ok) {
      throw new Error(
        `auth POST /authz/users/identities responded with HTTP ${res.status}`,
      );
    }

    const body = (await res.json()) as { users: Identity[] };
    const returned = new Set<string>();

    for (const user of body.users) {
      returned.add(user.id);
      identityCache.set(user.id, {
        identity: user,
        expiresAt: now + IDENTITY_CACHE_TTL_MS,
      });
      result.set(user.id, user);
    }

    // Fail soft per-id too: an id auth silently omitted degrades to
    // "unknown" rather than being absent from the returned Map (callers
    // index by id and must get an entry for everything they asked about).
    // Deliberately NOT cached — a same-request omission may be transient.
    for (const id of uncached) {
      if (!returned.has(id)) {
        result.set(id, unknownIdentity(id));
      }
    }
  } catch (error) {
    console.error(
      "[authClient] failed to resolve identities from auth — degrading to 'unknown':",
      error instanceof Error ? error.message : error,
    );
    for (const id of uncached) {
      result.set(id, unknownIdentity(id));
    }
  }

  return result;
}
