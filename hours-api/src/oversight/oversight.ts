/**
 * Oversight — reading everyone's hours for a holder of `time-entry:read-all` (specs/029 T19; plan § Sequences
 * "Oversight"; AC-1.6, AC-4.2, AC-4.3, AC-5.2, AC-5.4; ADR-0075, ADR-0088).
 *
 * Adapted from estimai-api/src/estimates/oversight.ts (no workspace: each resource server owns its copy, ADR-0003;
 * not drift-checked, plan R10), with two differences: the `auth` call is T12's `fetchResolvedPermissions`
 * (src/authz/resolveClient.ts: 2 s timeout, `redirect: "error"`, a body read strictly) and not estimai-api's
 * `authClient.ts` (5 s, follows redirects, replaying the Bearer to another host), and the cache key's epoch is the
 * one the JWT middleware already verified (`permEpoch`), not a second decode of the token.
 *
 * hours-api asks `auth GET /authz/resolve` with the CALLER's own JWT whether the caller holds the permission, and
 * only on the oversight path: `whose=all`, a `userId` filter, and a write to an entry that is not the caller's
 * (to choose between 403 `owner_only` and 404). A person's own hours never ask, so they keep working when `auth` is
 * down (AC-5.4).
 *
 * Only a REFUSAL is remembered, per `(sub, perm_epoch)` for 30 s: a grant bumps the epoch, so a new holder's next
 * token is asked afresh. A GRANT is never remembered, so a revocation holds on the very next request even while the
 * caller's token still carries the old epoch (the gap estimai-api's security review of 2026-11-09 closed). An outage
 * is remembered as neither. This is a different cache from `time-list:manage`'s (src/authz/timeListManage.ts): what is
 * known about one permission says nothing about the other.
 *
 * Fails CLOSED: `holdsReadAll` throws `OversightUnavailableError` when `auth` cannot answer. A read turns that into
 * 503 `authz_unavailable` (./scope.ts); the write guard turns it into "no", since the write is refused either way.
 */

import { fetchResolvedPermissions } from "../authz/resolveClient";
import { db } from "../lib/db";

export const READ_ALL = { resource: "time-entry", action: "read-all" } as const;

/** Whose permission is asked: the verified session, with the header it came with (forwarded to `auth` as it is). */
export interface Session {
  /** The verified JWT subject. */
  readonly sub: string;
  /** The verified `perm_epoch` claim: 0 for a token that omits it (src/auth/jwt.middleware.ts). */
  readonly permEpoch: number;
  /** The full `Authorization` header value, `Bearer <jwt>`. */
  readonly authorization: string;
}

/** `auth` could not say whether the caller holds the permission: neither a grant nor a refusal. */
export class OversightUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Authorization service is unavailable");
    this.name = "OversightUnavailableError";
    this.cause = cause;
  }
}

const REFUSAL_TTL_MS = 30_000;
const SWEEP_THRESHOLD = 1_000;
/** `(sub, perm_epoch)` → the instant the remembered refusal ends. */
const refusals = new Map<string, number>();

/** NUL cannot occur in a user id or a number, so two (sub, epoch) pairs never share a key. */
const refusalKey = (sub: string, permEpoch: number): string => `${sub}\0${permEpoch}`;

/**
 * Does the caller hold `time-entry:read-all`? Throws `OversightUnavailableError` when `auth` cannot say. The
 * `hours` catalog declares no conditions for it (auth/src/authz/catalogs/hours.ts), so any grant of the pair is the grant.
 */
export async function holdsReadAll(session: Session): Promise<boolean> {
  const key = refusalKey(session.sub, session.permEpoch);
  const now = Date.now();
  const until = refusals.get(key);
  if (until !== undefined && until > now) return false;

  let holds: boolean;
  try {
    const permissions = await fetchResolvedPermissions(session.authorization);
    holds = permissions.some((p) => p.resource === READ_ALL.resource && p.action === READ_ALL.action);
  } catch (err) {
    // Fail CLOSED (ADR-0014 point 4). The error's NAME only: a fetch error's message can name auth's internal host.
    console.error("[oversight] auth GET /authz/resolve failed — failing closed:", err instanceof Error ? err.name : typeof err);
    throw new OversightUnavailableError(err);
  }
  if (!holds) {
    // Expired entries are otherwise only overwritten: sweep once the map is large, so a long-lived process cannot grow it without bound.
    if (refusals.size >= SWEEP_THRESHOLD) {
      for (const [k, expiresAt] of refusals) if (expiresAt <= now) refusals.delete(k);
    }
    refusals.set(key, now + REFUSAL_TTL_MS);
  }
  return holds;
}

/**
 * The write guard: a write route found no entry of the CALLER's with this id. Is the caller a holder looking at a
 * real entry of someone else's — someone who may read it but not change it (403 `owner_only`, AC-1.6)? Otherwise the
 * route keeps answering 404, the answer for an entry that does not exist. `auth` failing, a missing permission and a
 * nonexistent entry are all "no", so a write is refused either way and a stranger learns nothing. Only `auth`'s
 * silence is read that way: a database that cannot answer is no statement about the entry, and stays the 500 it is.
 *
 * Asked only after the lookup came back empty, so a person's own writes never call `auth`.
 */
export async function isHolderOfSomeoneElsesEntry(session: Session, entryId: string): Promise<boolean> {
  try {
    if (!(await holdsReadAll(session))) return false;
  } catch (err) {
    if (err instanceof OversightUnavailableError) return false;
    throw err;
  }
  return (await db.timeEntry.count({ where: { id: entryId } })) > 0;
}

/** Test-only escape hatch: clears the refusals remembered by the process. */
export function __resetOversightCacheForTests(): void {
  refusals.clear();
}
