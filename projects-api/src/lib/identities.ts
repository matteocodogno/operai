/**
 * Display-identity resolution for project managers and team members
 * (specs/025-projects, ADR-0039). Copied from crm-api/src/lib/identities.ts, with
 * `requireProjectUsers` for writes in place of its `requireCrmUsers` (ADR-0055).
 *
 * projects-api stores only opaque auth user ids. Names are resolved LIVE from
 * `auth POST /authz/users/identities` at read time, never copied into this
 * database. `resolveIdentities` FAILS SOFT (an outage degrades to
 * `{status:"unknown"}`); `requireProjectUsers` is for a write that sets a project
 * manager or a team and FAILS CLOSED with a 503 when `auth` cannot answer, and a 422
 * when an id does not hold access to the module.
 *
 * It forwards the CALLER's own Bearer header — no new credential.
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

/**
 * The write-time check for the people a project is given to: a project manager or a
 * team member must be an active Operai user who holds `projects:access` (AC-1.6,
 * ADR-0055). Asked of `auth POST /authz/app-access-check {appId:"projects", userId}`
 * with the caller's own JWT, one id at a time (`auth` has no batch form and rate-limits
 * the route per caller, so the ids are distinct and the calls sequential).
 *
 * - The caller themselves needs no check: they are using the module right now.
 * - A `system:` principal can never be a project manager or a member.
 * - Every refused id is collected: 422 `not_project_user` with `{ userIds }`.
 * - Fails CLOSED: auth unreachable, 5xx or 429 → 503 `identity_unavailable`, never "eligible".
 */
export async function requireProjectUsers(
  c: { req: { header(name: string): string | undefined }; get(key: "userId"): string },
  userIds: readonly string[],
): Promise<void> {
  const caller = c.get("userId");
  const refused: string[] = [];
  for (const id of new Set(userIds)) {
    if (id === caller) continue;
    if (id === "" || id.length > MAX_ID_LENGTH || isSystemActor(id)) {
      refused.push(id);
      continue;
    }
    let eligible: boolean;
    try {
      const res = await fetch(`${env.AUTH_BASE_URL}/authz/app-access-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: c.req.header("Authorization") ?? "" },
        body: JSON.stringify({ appId: "projects", userId: id }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      eligible = ((await res.json()) as { eligible?: unknown }).eligible === true;
    } catch (error) {
      console.error(
        "[identities] could not check project access with auth — refusing the write (fail-closed):",
        error instanceof Error ? error.message : error,
      );
      throw new ProblemError({
        status: 503,
        code: "identity_unavailable",
        detail: "The identity service is unavailable; the person could not be checked",
      });
    }
    if (!eligible) refused.push(id);
  }
  if (refused.length > 0) {
    throw new ProblemError({
      status: 422,
      code: "not_project_user",
      detail: "Every project manager and team member must be an Operai user with access to Projects",
      extras: { userIds: refused },
    });
  }
}
