/**
 * Display-identity resolution for holders and actors (T9, specs/015-hardware-
 * inventory; AC-3.7, AC-11.3; ADR-0039). Mirrors estimai-api/src/lib/authClient.ts
 * `resolveIdentities`, plus the `system` status this feature adds.
 *
 * inventory-api stores only opaque auth user ids (`holderUserId`,
 * `actorUserId`, …). Names are resolved LIVE from `auth POST
 * /authz/users/identities` at read time, never copied into this database, so a
 * renamed person is current everywhere and a deleted one shows as deleted
 * rather than as a stale name implying an active account.
 *
 * FAILS SOFT. A name on a screen is decoration: this function NEVER throws. An
 * `auth` outage, a non-2xx answer, a body it cannot read, a timeout — each
 * degrades the affected ids to `{status:"unknown", name:null}` and the read the
 * caller was serving still succeeds. That is the opposite of this service's
 * authorization path (`authzMiddleware`), which fails CLOSED with a 503; the two
 * are not to be harmonised (ADR-0039 vs ADR-0014).
 *
 * `system:*` ids (the launch seed, the legacy import) are not users: they map to
 * status `system` locally and are never sent to `auth`.
 *
 * Like the estimai original it forwards the CALLER's own Bearer header — no new
 * credential — which is why the first argument is the `Authorization` header
 * and not just the ids: `auth` requires a user JWT on this route.
 */

import { env } from "./env";

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
const REQUEST_TIMEOUT_MS = 5_000;

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
  // A name is surfaced for an active user only (AC-10.5 of specs/013): a
  // deleted or unknown one must not carry an identity that implies otherwise.
  if (status === "deleted") return { id, status, name: null };
  return unknown(id);
}

/**
 * One entry per distinct id in `ids`, always — a caller can index the result by
 * any id it passed and get an `Identity` back.
 */
export async function resolveIdentities(
  authorizationHeader: string,
  ids: readonly string[],
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

  // Sequential, not Promise.all: `auth` rate-limits this route per caller, and a
  // burst of parallel chunks would spend the budget (and be throttled) at once.
  for (const batch of chunk(toFetch, MAX_IDS_PER_REQUEST)) {
    try {
      const res = await fetch(`${env.AUTH_BASE_URL}/authz/users/identities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorizationHeader,
        },
        body: JSON.stringify({ ids: batch }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        result.set(identity.id, identity);
        cache.set(identity.id, { identity, expiresAt: now + CACHE_TTL_MS });
      }
      // Asked but not answered (or answered unreadably): unknown, and NOT cached
      // — the omission may be transient.
      for (const id of batch) if (!result.has(id)) result.set(id, unknown(id));
    } catch (error) {
      console.error(
        "[identities] could not resolve a batch from auth — degrading it to 'unknown':",
        error instanceof Error ? error.message : error,
      );
      for (const id of batch) result.set(id, unknown(id));
    }
  }

  return result;
}
