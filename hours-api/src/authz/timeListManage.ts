/**
 * The live `time-list:manage` check (specs/029 T12; plan § Sequences "Admin lists", AC-3.3, ADR-0088).
 * The shape of projects-api's `authzMiddleware`, narrowed to the one permission this service gates
 * a route on; the oversight permission of T19 has its own module (src/oversight).
 *
 * Attached to each list WRITE as route middleware, so it runs before the body and the path are
 * validated: a caller without the permission is refused whatever they send (plan § Entries, "A path
 * `{id}` outside the id rule").
 */

import { createMiddleware } from "hono/factory";
import type { JwtVariables } from "../auth/jwt.middleware";
import { problem } from "../lib/problem";
import { fetchResolvedPermissions } from "./resolveClient";

export const TIME_LIST_MANAGE = { resource: "time-list", action: "manage" } as const;

// Only a REFUSAL is remembered, per `(sub, perm_epoch)` for 30 s (ADR-0075): a grant bumps the epoch,
// so a new holder's next token is asked afresh and is not held back. A grant is never remembered, so
// a revocation holds on the very next write even while the caller's token still carries the old
// epoch (estimai-api's security review of 2026-11-09: a cached grant kept a revoked admin writing
// for up to 30 s). Holders are few and each write is rare, so the extra calls to `auth` cost nothing.
// An outage is remembered as neither.
const REFUSAL_TTL_MS = 30_000;
const SWEEP_THRESHOLD = 1_000;
const refusals = new Map<string, number>();

/** NUL cannot occur in a user id or a number, so two (sub, epoch) pairs never share a key. */
const refusalKey = (sub: string, permEpoch: number): string => `${sub}\0${permEpoch}`;

const refused = (path: string): Response =>
  problem(
    { status: 403, code: "time_list_manage_required", detail: "Managing the categories and work types needs the time-list:manage permission" },
    path,
  );

export const timeListManage = createMiddleware<{ Variables: JwtVariables }>(async (c, next) => {
  const key = refusalKey(c.get("userId"), c.get("permEpoch"));
  const now = Date.now();
  const until = refusals.get(key);
  if (until !== undefined && until > now) return refused(c.req.path);

  let permissions: Awaited<ReturnType<typeof fetchResolvedPermissions>>;
  try {
    // `jwtMiddleware` already refused a request with no Bearer, so the header is there.
    permissions = await fetchResolvedPermissions(c.req.header("Authorization")!);
  } catch (err) {
    // Fail CLOSED (ADR-0014 point 4): an outage is neither a grant nor a refusal. The error's NAME
    // only: a fetch error's message can name auth's internal host.
    console.error("[authz] auth GET /authz/resolve failed — denying the list write (fail-closed):", err instanceof Error ? err.name : typeof err);
    return problem(
      { status: 503, code: "authz_unavailable", detail: "The authorization service is unavailable: nothing was changed" },
      c.req.path,
    );
  }
  // The `hours` catalog declares no conditions for this permission (auth/src/authz/catalogs/hours.ts),
  // so any grant of the pair is the grant.
  const holds = permissions.some((p) => p.resource === TIME_LIST_MANAGE.resource && p.action === TIME_LIST_MANAGE.action);
  if (!holds) {
    // Expired entries are otherwise only overwritten: sweep once the map is large, so a long-lived
    // process cannot grow it without bound.
    if (refusals.size >= SWEEP_THRESHOLD) {
      for (const [k, expiresAt] of refusals) if (expiresAt <= now) refusals.delete(k);
    }
    refusals.set(key, now + REFUSAL_TTL_MS);
    return refused(c.req.path);
  }
  return next();
});

/** Test-only escape hatch: clears the refusals remembered by the process. */
export function __resetTimeListManageCacheForTests(): void {
  refusals.clear();
}
