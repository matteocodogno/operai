/**
 * People, by id (specs/021-meetings AC-5.10, AC-5.11, AC-5.12; ADR-0039).
 * Derived from crm-api/src/lib/identities.ts.
 *
 * meetings-api stores only opaque `auth` user ids. A person is looked up LIVE
 * from `auth POST /authz/users/identities`, forwarding the CALLER's own Bearer
 * header (no new credential), and the lookup has two postures that must never be
 * mixed up:
 *
 *   resolveIdentities   DISPLAY. Fails SOFT: an outage degrades every id to
 *                       `{ status: "unknown", name: null }`. A short cache is fine.
 *   requireIdentities   GATES (is the creator deactivated? is this participant an
 *                       active user?). Fails CLOSED: an outage, an id `auth` did
 *                       not answer, or a status it could not read is a 503
 *                       `identity_unavailable`. NEVER cached, so a reactivation
 *                       restores control on the next request (AC-5.11) and a
 *                       deactivation bites at once.
 *
 * A name is surfaced for an ACTIVE user only (`deleted` maps to `name: null`,
 * AC-5.12): a deactivated or unknown one must not carry an identity that implies
 * otherwise.
 */

import { env } from "./env";
import { ProblemError } from "./problem";

export type IdentityStatus = "active" | "deleted" | "unknown";

export interface Identity {
  readonly id: string;
  readonly name: string | null;
  readonly status: IdentityStatus;
}

/** The API shape (plan.md § Conventions): `{ id, name, status }`. */
export type PersonRef = Identity;

export const toPersonRef = (identity: Identity): PersonRef => ({
  id: identity.id,
  name: identity.name,
  status: identity.status,
});

/** `auth`'s per-request cap on `POST /authz/users/identities`; keep in sync. */
const MAX_IDS_PER_REQUEST = 100;
/** …and its per-id length bound; a longer string would 400 the whole batch. */
const MAX_ID_LENGTH = 64;
const SYSTEM_PREFIX = "system:";
const CACHE_TTL_MS = 60_000;
const CACHE_SWEEP_THRESHOLD = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface CacheEntry {
  readonly identity: Identity;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: forget cached identities. */
export function __resetIdentityCacheForTests(): void {
  cache.clear();
}

const unknown = (id: string): Identity => ({ id, name: null, status: "unknown" });

/** An id that cannot be a real, active user: empty, over-long, or a service principal. */
const cannotBeAUser = (id: string): boolean =>
  id === "" || id.length > MAX_ID_LENGTH || id.startsWith(SYSTEM_PREFIX);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Reads one entry of `auth`'s answer defensively; anything odd is `null`. */
function toIdentity(raw: unknown): Identity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, status, name } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (status === "active") return { id, status, name: typeof name === "string" && name !== "" ? name : null };
  if (status === "deleted") return { id, status, name: null };
  return null;
}

/** One batch, throwing on any transport or shape failure. Returns what `auth` answered, for ids asked. */
async function fetchBatch(authorizationHeader: string, batch: readonly string[]): Promise<Map<string, Identity>> {
  const res = await fetch(`${env.AUTH_BASE_URL}/authz/users/identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorizationHeader },
    body: JSON.stringify({ ids: batch }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`auth POST /authz/users/identities responded with HTTP ${res.status}`);
  const body = (await res.json()) as { users?: unknown } | null;
  if (!Array.isArray(body?.users)) throw new Error("auth POST /authz/users/identities returned an unrecognised body");

  const asked = new Set(batch);
  const answered = new Map<string, Identity>();
  for (const raw of body.users) {
    const identity = toIdentity(raw);
    // Ignore anything we did not ask about: `auth` must not be able to inject an entry for another id.
    if (identity && asked.has(identity.id)) answered.set(identity.id, identity);
  }
  return answered;
}

/**
 * DISPLAY. One entry per distinct id in `ids`, always: a caller can index the
 * result by any id it passed and get an `Identity` back.
 */
export async function resolveIdentities(
  authorizationHeader: string,
  ids: readonly string[],
): Promise<Map<string, Identity>> {
  const result = new Map<string, Identity>();
  const now = Date.now();
  const toFetch: string[] = [];

  for (const id of new Set(ids)) {
    if (cannotBeAUser(id)) {
      result.set(id, unknown(id));
      continue;
    }
    const cached = cache.get(id);
    if (cached && cached.expiresAt > now) result.set(id, cached.identity);
    else toFetch.push(id);
  }

  // Sequential, not Promise.all: `auth` rate-limits this route per caller, and a
  // burst of parallel chunks would spend the budget (and be throttled) at once.
  for (const batch of chunk(toFetch, MAX_IDS_PER_REQUEST)) {
    try {
      const answered = await fetchBatch(authorizationHeader, batch);
      if (cache.size >= CACHE_SWEEP_THRESHOLD) {
        for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
      }
      for (const [id, identity] of answered) {
        result.set(id, identity);
        cache.set(id, { identity, expiresAt: now + CACHE_TTL_MS });
      }
      // Asked but not answered: unknown, and NOT cached (the omission may be transient).
      for (const id of batch) if (!result.has(id)) result.set(id, unknown(id));
    } catch (error) {
      console.error(
        "[identities] could not resolve a batch from auth, degrading it to 'unknown':",
        error instanceof Error ? error.message : "unknown error",
      );
      for (const id of batch) result.set(id, unknown(id));
    }
  }

  return result;
}

const identityUnavailable = () =>
  new ProblemError({
    status: 503,
    code: "identity_unavailable",
    detail: "The identity service is unavailable; the person could not be checked",
  });

/**
 * GATES. Every id comes back `active` or `deleted`, or the whole call is a 503.
 * Uncached on purpose. An id that can never be a user (empty, over-long, a
 * service principal) is answered `deleted` without asking: it is not an active
 * user, which is all a gate needs to know.
 */
export async function requireIdentities(
  authorizationHeader: string,
  ids: readonly string[],
): Promise<Map<string, Identity>> {
  const result = new Map<string, Identity>();
  const toFetch: string[] = [];
  for (const id of new Set(ids)) {
    if (cannotBeAUser(id)) result.set(id, { id, name: null, status: "deleted" });
    else toFetch.push(id);
  }

  for (const batch of chunk(toFetch, MAX_IDS_PER_REQUEST)) {
    let answered: Map<string, Identity>;
    try {
      answered = await fetchBatch(authorizationHeader, batch);
    } catch (error) {
      console.error(
        "[identities] could not check people with auth, refusing (fail-closed):",
        error instanceof Error ? error.message : "unknown error",
      );
      throw identityUnavailable();
    }
    for (const id of batch) {
      const identity = answered.get(id);
      // Not answered, or answered with a status we cannot read: not a decision we can take.
      if (!identity) throw identityUnavailable();
      result.set(id, identity);
    }
  }
  return result;
}
