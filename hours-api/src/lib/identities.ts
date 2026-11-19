/**
 * Display-identity resolution (specs/20261112-time-tracking T10, T46; adapted from activities-api `lib/identities.ts`,
 * ADR 20260807-live-identity-resolution-by-id-fail-soft): hours-api stores only opaque `auth` user ids, and the name next to an
 * entry is read from `auth POST /authz/users/identities`, never copied into this database, so a person whose name changes shows
 * the new name on all their entries at once (AC-4.8) — within the 60 s below.
 *
 * - CACHED 60 s, in process, keyed by the user id alone (ADR 20260807 § 3; the same posture as estimai-api, crm-api,
 *   projects-api, inventory-api and activities-api, whose copy this is the sixth of). `auth` counts this route per person,
 *   120 calls in any 10 minutes, one budget shared with those services; one call per read spent it in ordinary use
 *   (qe-report.md D-1). The 60 s run from when the batch that read an identity was SENT, not from when the answer arrived
 *   (ADR 20261112-push-liveness-answer-reused-30-seconds: a memo's clock starts when the question is sent), and 60 s is
 *   ADR 20260807's named bound: a constant, never a setting.
 * - One map serves every viewer: `auth`'s answer for an id is a function of that user's row alone, and which ids an answer
 *   names is decided by the caller's own scope before this module is asked, so a viewer served from the cache gets what
 *   `auth` would tell them. No key is ever a value from a query.
 * - Only an item of a 200 answer is kept, with a status `active`, `deleted` or `unknown`, for an id that was asked, and for an
 *   `active` one a `name` that is a string or null (what `auth` sends). A refusal (a 429 included), an outage, a timeout, an
 *   unreadable body, an item of any other shape and an id the answer left out degrade the people they covered for THIS read
 *   only (to `unknown`; an `active` item with an unreadable name reads as no name) and are asked again on the next: a
 *   transient failure must never become a lasting "Unknown user".
 * - An entry past its 60 s is never served, not even when the refresh fails, and it is forgotten by the lookup that finds it
 *   past (names live in memory at most 60 s from the question, plan § Security "Names are cached across viewers"); the sweep
 *   below only reaches the ones nobody asks about again. An answer is stored only when nothing sent later is held for the
 *   id: two reads of one id can be in flight at once and the earlier-sent batch may answer last.
 * - FAILS SOFT: an outage, a refusal or an unreadable answer degrades the people it covered to
 *   `{status:"unknown", name:null}`; the entries stay listed and counted and the caller names
 *   `identities` in `unavailable` (AC-4.7).
 * - Forwards the VIEWER's own Bearer header on the call it makes, so no new credential exists and `auth` rate-limits
 *   per person, not per service. A redirect would replay that Bearer to another host, so none is followed.
 * - A name is returned for an active person only (AC-10.5 of specs/20260807-estimate-sharing): a deleted or unknown
 *   one must not carry an identity that implies otherwise.
 */

import { env } from "./env";

export type IdentityStatus = "active" | "deleted" | "unknown";

export interface Identity {
  readonly id: string;
  readonly name: string | null;
  readonly status: IdentityStatus;
}

/** `auth`'s per-request cap on `POST /authz/users/identities`; keep in sync. */
const MAX_IDS_PER_REQUEST = 100;
/** …and its per-id length bound; a longer string would 400 the whole batch. */
const MAX_ID_LENGTH = 64;
/** The plan's 2 s for a call to another service (R2). */
const REQUEST_TIMEOUT_MS = 2_000;
/** How long an identity is kept, from when the batch that read it was sent (ADR 20260807 § 3). Not a setting. */
const CACHE_TTL_MS = 60_000;
/** Expired entries nobody asks about again are swept at this many (the siblings' threshold); one is never served. */
const CACHE_SWEEP_THRESHOLD = 5_000;

interface CacheEntry {
  readonly identity: Identity;
  /** `Date.now()` when the batch that read it was sent, plus the TTL. */
  readonly expiresAt: number;
}

/** By `auth` user id alone: one map for every viewer (see the header). At most one entry per person shown. */
const cache = new Map<string, CacheEntry>();

/** Test-only: forget cached identities. */
export function __resetIdentityCacheForTests(): void {
  cache.clear();
}

/** Test-only: how many entries the map holds, expired or not. */
export function __identityCacheSizeForTests(): number {
  return cache.size;
}

const unknown = (id: string): Identity => ({ id, name: null, status: "unknown" });

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

class AuthResponseError extends Error {
  constructor(readonly httpStatus: number) {
    super(`auth POST /authz/users/identities responded with HTTP ${httpStatus}`);
    this.name = "AuthResponseError";
  }
}

/**
 * What a log line may say about a failed batch: the HTTP status, or the error's NAME. Never its
 * message (a fetch error's can carry the URL) and never an id or the Bearer.
 */
function describeFailure(error: unknown): string {
  if (error instanceof AuthResponseError) return `HTTP ${error.httpStatus}`;
  return error instanceof Error ? error.name : "unknown error";
}

/** One item of `auth`'s answer as read here: what a person is, and whether the answer is one to keep. */
interface ReadItem {
  readonly identity: Identity;
  readonly keep: boolean;
}

/**
 * Reads one entry of `auth`'s answer defensively. Anything odd is `null` (ignored) or `unknown` for this read only
 * (`keep: false`): only a status `auth` defines is kept, `unknown` included, which `auth` says for an id with no user row.
 */
function readItem(raw: unknown): ReadItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, status, name } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (status === "active") {
    // `auth` sends `name` as a string or null (`z.string().nullable()`); anything else is an item of another shape: this read
    // shows an active person with no readable name, and it is never kept.
    return {
      identity: { id, status, name: typeof name === "string" && name !== "" ? name : null },
      keep: name === null || typeof name === "string",
    };
  }
  if (status === "deleted") return { identity: { id, status, name: null }, keep: true };
  return { identity: unknown(id), keep: status === "unknown" };
}

export interface ResolveOptions {
  /** Per-request timeout; the default suits a read. */
  readonly timeoutMs?: number;
}

/**
 * One entry per distinct id in `ids`, always: a caller can index the result by any id it passed
 * and get an `Identity` back. Asks `auth` only for the ids the cache does not hold. Never throws.
 */
export async function resolveIdentities(
  authorizationHeader: string,
  ids: readonly string[],
  options: ResolveOptions = {},
): Promise<Map<string, Identity>> {
  const result = new Map<string, Identity>();
  const toFetch: string[] = [];
  const now = Date.now();

  for (const id of new Set(ids)) {
    if (id === "" || id.length > MAX_ID_LENGTH) {
      // `auth` would 400 the whole batch for this one; it cannot be a real id. Never sent, never kept.
      result.set(id, unknown(id));
      continue;
    }
    const cached = cache.get(id);
    if (cached !== undefined && cached.expiresAt > now) {
      result.set(id, cached.identity);
      continue;
    }
    // Past its 60 s: forgotten here, not left until a refresh overwrites it or the sweep runs, so a refresh that fails
    // (a 429, an outage) leaves no name in memory beyond the 60 s the plan promises (§ Security, "Names are cached").
    if (cached !== undefined) cache.delete(id);
    toFetch.push(id);
  }

  // Sequential, not Promise.all: `auth` rate-limits this route per caller, and a burst of
  // parallel batches would spend the budget (and be throttled) at once.
  for (const batch of chunk(toFetch, MAX_IDS_PER_REQUEST)) {
    // The memo's clock starts when the question is sent: an answer that arrives late does not lengthen it.
    const sentAt = Date.now();
    try {
      const res = await fetch(`${env.AUTH_BASE_URL}/authz/users/identities`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorizationHeader },
        body: JSON.stringify({ ids: batch }),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) throw new AuthResponseError(res.status);
      const body = (await res.json()) as { users?: unknown } | null;
      const users = Array.isArray(body?.users) ? body.users : [];

      // What `auth` said of each id asked, the last item winning: the answer for this read and what is kept are one.
      const asked = new Set(batch);
      const answered = new Map<string, ReadItem>();
      for (const raw of users) {
        const item = readItem(raw);
        // Ignore anything we did not ask about: `auth` must not be able to inject an entry for another id.
        if (item !== null && asked.has(item.identity.id)) answered.set(item.identity.id, item);
      }

      if (cache.size >= CACHE_SWEEP_THRESHOLD) {
        const swept = Date.now();
        for (const [key, entry] of cache) if (entry.expiresAt <= swept) cache.delete(key);
      }
      for (const id of batch) {
        const item = answered.get(id);
        // Asked but not answered (or answered unreadably): unknown for this read, and NOT kept — the omission may be transient.
        result.set(id, item?.identity ?? unknown(id));
        if (item?.keep) {
          // Only when nothing newer is held: two reads of one id can be in flight at once, and the batch SENT earlier may
          // answer last. Its answer is the older question's, so it must not replace the later one's (a `deleted` read at
          // t0+10 s overwritten by an `active` read at t0), and it would also cut the later one's life short.
          const held = cache.get(id);
          if (held === undefined || held.expiresAt <= sentAt + CACHE_TTL_MS) {
            cache.set(id, { identity: item.identity, expiresAt: sentAt + CACHE_TTL_MS });
          }
        }
      }
    } catch (error) {
      console.error("[identities] could not resolve a batch from auth — degrading it to 'unknown':", describeFailure(error));
      for (const id of batch) result.set(id, unknown(id));
    }
  }

  return result;
}
