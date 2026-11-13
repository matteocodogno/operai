/**
 * Thin HTTP client for `auth GET /authz/resolve` (specs/029 T12; ADR-0014 point 1, ADR-0088).
 * Adapted from projects-api/src/authz/resolveClient.ts (no workspace: each resource server owns its
 * copy, ADR-0003; not drift-checked, plan R10).
 *
 * It forwards the CALLER'S OWN Bearer header verbatim: no credential of hours-api's is involved, so
 * `auth` answers what THIS person holds. It answers one question for hours-api, "does the caller hold
 * `time-list:manage`?" (T12), and `time-entry:read-all` for the oversight path (T19, which reads the
 * same list of grants).
 *
 * It THROWS on a non-2xx answer, a timeout, a redirect, a network error and a body that cannot be read
 * as a permission list: every caller maps that to the fail-closed 503 `authz_unavailable` and must
 * never read a throw as "no permission" (an outage is not a refusal, and not a grant either).
 */

import { env } from "../lib/env";

/** The plan's 2 s for a call to another service (R2): a hung `auth` becomes the 503, not a hung request. */
export const RESOLVE_TIMEOUT_MS = 2_000;

/** One resolved (resource, action) grant, as `/authz/resolve` returns it. */
export interface ResolvedPermission {
  readonly resource: string;
  readonly action: string;
  /** `null` = unconditional. The `hours` catalog declares no conditions, so hours-api never reads it. */
  readonly conditions: unknown;
}

const isPermission = (value: unknown): value is ResolvedPermission =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { resource?: unknown }).resource === "string" &&
  typeof (value as { action?: unknown }).action === "string";

/**
 * Calls `${AUTH_BASE_URL}/authz/resolve` with `authorizationHeader` (the full `"Bearer <jwt>"`).
 * A redirect is refused: following one would replay the Bearer to another host.
 */
export async function fetchResolvedPermissions(authorizationHeader: string): Promise<readonly ResolvedPermission[]> {
  const res = await fetch(`${env.AUTH_BASE_URL}/authz/resolve`, {
    method: "GET",
    headers: { Authorization: authorizationHeader },
    redirect: "error",
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`auth GET /authz/resolve responded with HTTP ${res.status}`);

  const body = (await res.json()) as { permissions?: unknown } | null;
  // A 2xx we cannot read as a permission list is an outage, not an empty grant list.
  if (body === null || typeof body !== "object" || !Array.isArray(body.permissions) || !body.permissions.every(isPermission)) {
    throw new Error("auth GET /authz/resolve returned an unrecognised body");
  }
  return body.permissions;
}
