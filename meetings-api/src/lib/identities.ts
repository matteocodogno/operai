/**
 * People, by id (specs/20261104-meetings AC-5.10, AC-5.11, AC-5.12; ADR 20260807-live-identity-resolution-by-id-fail-soft).
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
/** One batch of `POST /authz/users/identities`, aborted past it. A bounded wait (`LIST_NAMES_WAIT_MS`) is shorter and does not abort it. */
export const REQUEST_TIMEOUT_MS = 5_000;
/**
 * The longest a meeting LIST waits, in all, for its creators' names (specs/20261126-teams R13 b, ADR 20261119-on-demand-outbound-work-..., rule 6): hours-api asks
 * `GET /meetings?ids=` inside 6 s, beside a host round of 2 s. A slow `auth` costs the names (`unknown`, the fail-soft display), not the list; the lookup is
 * not aborted and fills the 60 s cache. Only `meetings/rows.ts` passes it: summaries and Q&A prompts (`promptSegments.ts`, `view.ts`) keep the whole wait,
 * because a shorter one would put "unknown" speakers into a summary. Pinned by `hours-api/src/clients/owners.budgets.cross-package.test.ts`.
 */
export const LIST_NAMES_WAIT_MS = 800;

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

export interface ResolveOptions {
  /**
   * For a path inside another service's deadline (specs/20261126-teams R13 b): wait at most this long, in all, for the lookup. An id `auth`
   * has not answered by then is `unknown` in the answer, which is a snapshot that never changes afterwards. The lookup is NOT aborted: it
   * keeps its own `REQUEST_TIMEOUT_MS` per batch and fills the cache, so the next call has the names. Absent: wait for all.
   */
  readonly waitMs?: number;
}

/**
 * DISPLAY. One entry per distinct id in `ids`, always: a caller can index the
 * result by any id it passed and get an `Identity` back.
 */
export async function resolveIdentities(
  authorizationHeader: string,
  ids: readonly string[],
  options: ResolveOptions = {},
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
  // With a bounded wait the lookup writes into its own map, so an answer that arrives after the wait cannot change the one already handed
  // back; without one it writes into the result itself (the behaviour of every other caller). Never rejects: a failed batch is `unknown`.
  const into = options.waitMs === undefined ? result : new Map<string, Identity>();
  const lookup = async (): Promise<void> => {
    for (const batch of chunk(toFetch, MAX_IDS_PER_REQUEST)) {
      try {
        const answered = await fetchBatch(authorizationHeader, batch);
        if (cache.size >= CACHE_SWEEP_THRESHOLD) {
          for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
        }
        for (const [id, identity] of answered) {
          into.set(id, identity);
          cache.set(id, { identity, expiresAt: now + CACHE_TTL_MS });
        }
        // Asked but not answered: unknown, and NOT cached (the omission may be transient).
        for (const id of batch) if (!into.has(id)) into.set(id, unknown(id));
      } catch (error) {
        console.error(
          "[identities] could not resolve a batch from auth, degrading it to 'unknown':",
          error instanceof Error ? error.message : "unknown error",
        );
        for (const id of batch) into.set(id, unknown(id));
      }
    }
  };

  if (options.waitMs === undefined) {
    await lookup();
    return result;
  }

  // Bounded wait: the lookup runs on in the background past the timer (and fills the cache); what it had answered by then is the answer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lookup(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const snapshot = new Map(result);
  for (const id of toFetch) snapshot.set(id, into.get(id) ?? unknown(id));
  return snapshot;
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
