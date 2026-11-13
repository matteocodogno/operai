/**
 * Display-identity resolution (specs/029 T10; adapted from activities-api `lib/identities.ts`,
 * ADR-0039): hours-api stores only opaque `auth` user ids, and the name next to an entry is
 * resolved LIVE from `auth POST /authz/users/identities` on every read that shows one, so a person
 * whose name changes shows the new name on all their entries at once (AC-4.8).
 *
 * - FAILS SOFT: an outage, a refusal or an unreadable answer degrades the people it covered to
 *   `{status:"unknown", name:null}`; the entries stay listed and counted and the caller names
 *   `identities` in `unavailable` (AC-4.7).
 * - NO CACHE, unlike activities-api's: a cached name would show the old one after a rename, which
 *   AC-4.8 forbids ("on all their entries"), and one call per read is all a viewer makes.
 * - Forwards the VIEWER's own Bearer header, so no new credential exists and `auth` rate-limits
 *   per person, not per service. A redirect would replay that Bearer to another host, so none is
 *   followed.
 * - A name is returned for an active person only (AC-10.5 of specs/013): a deleted or unknown
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

/** Reads one entry of `auth`'s answer defensively; anything odd is `null` (ignored) or `unknown`. */
function toIdentity(raw: unknown): Identity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, status, name } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (status === "active") {
    return { id, status, name: typeof name === "string" && name !== "" ? name : null };
  }
  if (status === "deleted") return { id, status, name: null };
  return unknown(id);
}

export interface ResolveOptions {
  /** Per-request timeout; the default suits a read. */
  readonly timeoutMs?: number;
}

/**
 * One entry per distinct id in `ids`, always: a caller can index the result by any id it passed
 * and get an `Identity` back. Never throws.
 */
export async function resolveIdentities(
  authorizationHeader: string,
  ids: readonly string[],
  options: ResolveOptions = {},
): Promise<Map<string, Identity>> {
  const result = new Map<string, Identity>();
  const toFetch: string[] = [];

  for (const id of new Set(ids)) {
    if (id === "" || id.length > MAX_ID_LENGTH) {
      // `auth` would 400 the whole batch for this one; it cannot be a real id.
      result.set(id, unknown(id));
    } else {
      toFetch.push(id);
    }
  }

  // Sequential, not Promise.all: `auth` rate-limits this route per caller, and a burst of
  // parallel batches would spend the budget (and be throttled) at once.
  for (const batch of chunk(toFetch, MAX_IDS_PER_REQUEST)) {
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

      const asked = new Set(batch);
      for (const raw of users) {
        const identity = toIdentity(raw);
        // Ignore anything we did not ask about: `auth` must not be able to inject an entry for
        // another id.
        if (!identity || !asked.has(identity.id)) continue;
        result.set(identity.id, identity);
      }
      // Asked but not answered (or answered unreadably): unknown.
      for (const id of batch) if (!result.has(id)) result.set(id, unknown(id));
    } catch (error) {
      console.error("[identities] could not resolve a batch from auth — degrading it to 'unknown':", describeFailure(error));
      for (const id of batch) result.set(id, unknown(id));
    }
  }

  return result;
}
