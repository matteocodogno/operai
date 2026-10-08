/**
 * Thin HTTP client for `auth GET /authz/resolve` (T7, specs/015-hardware-
 * inventory, ADR-0014 point 1). Copied from refund-api/src/authz/resolveClient.ts.
 *
 * Deliberately isolated in its own module — mirrors `auth/src/lib/notify.ts`'s
 * pattern for calling out to another Operai service — so that
 * `authz.middleware.ts` (and its tests) can `mock.module()` this single
 * function rather than mocking global `fetch` or `jose`/JWKS machinery a
 * second time in the same test process (see `estimai-api/src/estimates/
 * estimates.routes.test.ts`'s comment on why re-mocking `jose` collides
 * across test files run in the same bun worker).
 *
 * Forwards the CALLER'S OWN Bearer `Authorization` header verbatim — no new
 * service credential is introduced (ADR-0014 point 1: "the same RS256 token
 * the end user already presented to inventory-api").
 */

import { env } from "../lib/env";

const RESOLVE_TIMEOUT_MS = 5_000;

export interface ResolveConditionAttribute {
  readonly key: string;
  readonly match: string;
}

export interface ResolveConditions {
  readonly ownership?: "own" | "any";
  readonly attributes?: readonly ResolveConditionAttribute[];
}

/** One resolved (resource, action) grant, as returned by `/authz/resolve`. */
export interface ResolvedPermission {
  readonly resource: string;
  readonly action: string;
  /** `null` = fully unconditional grant (no restriction at all). */
  readonly conditions: ResolveConditions | null;
}

/** The full `GET /authz/resolve` response body (auth/src/authz/resolve.routes.ts). */
export interface ResolveResponse {
  readonly sub: string;
  readonly epoch: number;
  readonly permissions: readonly ResolvedPermission[];
  readonly entity: string | null;
  readonly jobTitle: string | null;
}

/**
 * Calls `${AUTH_BASE_URL}/authz/resolve`, forwarding `authorizationHeader`
 * (the full `"Bearer <jwt>"` string) verbatim.
 *
 * Throws on any non-2xx response or network failure — callers (authzMiddleware)
 * are responsible for translating that into the fail-closed 503 (ADR-0014
 * point 4: an auth outage must never be treated as "allow").
 */
export async function fetchAuthzResolve(
  authorizationHeader: string,
): Promise<ResolveResponse> {
  const res = await fetch(`${env.AUTH_BASE_URL}/authz/resolve`, {
    method: "GET",
    headers: { Authorization: authorizationHeader },
    // A hung `auth` must become the fail-closed 503, not a hung request.
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `auth GET /authz/resolve responded with HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as Partial<ResolveResponse> | null;
  // A 2xx with a body we cannot read as a permission set is an outage, not an
  // empty grant list — and certainly not a reason to crash a handler later.
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray(body.permissions) ||
    (body.entity !== null && typeof body.entity !== "string")
  ) {
    throw new Error("auth GET /authz/resolve returned an unrecognised body");
  }
  return body as ResolveResponse;
}
