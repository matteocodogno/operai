/**
 * Display-identity resolution and the write-time "is this an Operai user of that app" check
 * (specs/20261110-activities; carried over from crm-api `lib/identities.ts`, ADR 20260807-live-identity-resolution-by-id-fail-soft/0055).
 *
 * activities-api stores only opaque auth user ids. Names are resolved LIVE from
 * `auth POST /authz/users/identities` at read time, never copied into this database.
 * `resolveIdentities` FAILS SOFT (an outage degrades to `{status:"unknown"}`);
 * `requireAppUsers` is for a write that gives a record to a person (an assignee, a
 * participant) and FAILS CLOSED with a 503 when `auth` cannot answer, and a 422 when an id is
 * not an active user of the host's app.
 *
 * Both forward the CALLER's own Bearer header: no new credential.
 */

import { env } from "./env";
import { ProblemError } from "./problem";

export type IdentityStatus = "active" | "deleted" | "unknown" | "system";

export interface Identity {
  readonly id: string;
  readonly name: string | null;
  readonly status: IdentityStatus;
}

/** `auth`'s per-request cap on `POST /authz/users/identities`; keep in sync. */
const MAX_IDS_PER_REQUEST = 100;
/** …and its per-id length bound; a longer string would 400 the whole batch. */
const MAX_ID_LENGTH = 64;
const SYSTEM_PREFIX = "system:";
const CACHE_TTL_MS = 60_000;
/** One batch of `POST /authz/users/identities`, aborted past it. A bounded wait (`ResolveOptions.waitMs`) is shorter and does not abort it. */
export const REQUEST_TIMEOUT_MS = 5_000;

interface CacheEntry {
  readonly identity: Identity;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_SWEEP_THRESHOLD = 5_000;

/** Test-only: forget cached identities. */
export function __resetIdentityCacheForTests(): void {
  cache.clear();
}

const unknown = (id: string): Identity => ({ id, name: null, status: "unknown" });
const system = (id: string): Identity => ({ id, name: null, status: "system" });

export const isSystemActor = (id: string): boolean => id.startsWith(SYSTEM_PREFIX);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Reads one entry of `auth`'s answer defensively; anything odd is `unknown`. */
function toIdentity(raw: unknown): Identity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, status, name } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (status === "active") {
    return { id, status, name: typeof name === "string" && name !== "" ? name : null };
  }
  // A name is surfaced for an active user only (AC-10.5 of specs/20260807-estimate-sharing): a
  // deleted or unknown one must not carry an identity that implies otherwise.
  if (status === "deleted") return { id, status, name: null };
  return unknown(id);
}

export interface ResolveOptions {
  /** Per-request timeout; the default suits a read, a caller that awaits the lookup passes less. */
  readonly timeoutMs?: number;
  /**
   * For a path inside another service's deadline (specs/20261126-teams R13 b): wait at most this long, in all, for the lookup. An id
   * `auth` has not answered by then is `unknown` in the answer, which is a snapshot that never changes afterwards. The lookup is NOT
   * aborted: it keeps its own `REQUEST_TIMEOUT_MS` per batch and fills the cache, so the next call has the names. Absent: wait for all.
   */
  readonly waitMs?: number;
}

/**
 * One entry per distinct id in `ids`, always: a caller can index the result by any id it
 * passed and get an `Identity` back.
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
    if (isSystemActor(id)) {
      result.set(id, system(id));
    } else if (id === "" || id.length > MAX_ID_LENGTH) {
      // `auth` would 400 the whole batch for this one; it cannot be a real id.
      result.set(id, unknown(id));
    } else {
      const cached = cache.get(id);
      if (cached && cached.expiresAt > now) result.set(id, cached.identity);
      else toFetch.push(id);
    }
  }

  // With a bounded wait the lookup writes into its own map, so an answer that arrives after the wait cannot change the one
  // already handed back; without one it writes into the result itself (the behaviour of every other caller).
  const into = options.waitMs === undefined ? result : new Map<string, Identity>();

  // Sequential, not Promise.all: `auth` rate-limits this route per caller, and a
  // burst of parallel chunks would spend the budget (and be throttled) at once.
  // Never rejects: a failed batch is `unknown`.
  const lookup = async (): Promise<void> => {
    for (const batch of chunk(toFetch, MAX_IDS_PER_REQUEST)) {
      try {
        const res = await fetch(`${env.AUTH_BASE_URL}/authz/users/identities`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorizationHeader,
          },
          body: JSON.stringify({ ids: batch }),
          signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
          // The caller's Bearer is forwarded: a redirect would replay it to another host (OWASP L1).
          redirect: "error",
        });
        if (!res.ok) {
          throw new Error(`auth POST /authz/users/identities responded with HTTP ${res.status}`);
        }
        const body = (await res.json()) as { users?: unknown } | null;
        const users = Array.isArray(body?.users) ? body.users : [];

        if (cache.size >= CACHE_SWEEP_THRESHOLD) {
          for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
        }

        const asked = new Set(batch);
        for (const raw of users) {
          const identity = toIdentity(raw);
          // Ignore anything we did not ask about: `auth` must not be able to
          // inject an entry for another id, and "system" is not its to assign.
          if (!identity || !asked.has(identity.id)) continue;
          into.set(identity.id, identity);
          cache.set(identity.id, { identity, expiresAt: now + CACHE_TTL_MS });
        }
        // Asked but not answered (or answered unreadably): unknown, and NOT cached
        // — the omission may be transient.
        for (const id of batch) if (!into.has(id)) into.set(id, unknown(id));
      } catch (error) {
        console.error(
          "[identities] could not resolve a batch from auth — degrading it to 'unknown':",
          error instanceof Error ? error.message : error,
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

/**
 * The write-time check for a person a record is given to: an assignee or a participant must
 * be an active Operai user who can open the host's app (specs/20261101-crm-sales-flow US-2, ADR 20261101-app-access-check-by-user-id-and-directory-app-filter; specs/20261110-activities
 * AC-5.1). Asked of `auth POST /authz/app-access-check {appId, userId}` with the caller's own
 * JWT, one id at a time (a write names a handful).
 *
 * - The caller themselves needs no check: they are using the app right now.
 * - A `system:` principal can author a record but never own one (D-15).
 * - Fails CLOSED: auth unreachable, 5xx or 429 → 503 `identity_unavailable`.
 * - Not a user of the app (deleted, or active without access: the same answer) → 422
 *   `owner_not_app_user` with `extras.field` naming the offending member.
 */
export async function requireAppUsers(
  c: { req: { header(name: string): string | undefined }; get(key: "userId"): string },
  appId: string,
  checks: readonly { readonly id: string; readonly field: string }[],
): Promise<void> {
  const notAppUser = (field: string) =>
    new ProblemError({
      status: 422,
      code: "owner_not_app_user",
      detail: `${field} is not an Operai user with access to ${appId}`,
      extras: { field },
    });
  const caller = c.get("userId");
  for (const check of checks) {
    if (check.id === caller) continue;
    if (check.id === "" || check.id.length > MAX_ID_LENGTH || isSystemActor(check.id)) throw notAppUser(check.field);
    let eligible: boolean;
    try {
      const res = await fetch(`${env.AUTH_BASE_URL}/authz/app-access-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: c.req.header("Authorization") ?? "" },
        body: JSON.stringify({ appId, userId: check.id }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      eligible = ((await res.json()) as { eligible?: unknown }).eligible === true;
    } catch (error) {
      console.error(
        `[identities] could not check ${appId} access with auth — refusing the write (fail-closed):`,
        error instanceof Error ? error.message : error,
      );
      throw new ProblemError({
        status: 503,
        code: "identity_unavailable",
        detail: "The identity service is unavailable; the person could not be checked",
      });
    }
    if (!eligible) throw notAppUser(check.field);
  }
}
