/**
 * shell/profileApi — the shell-owned client for the employee self-view
 * (specs/012-employee-address, T14, US-6, AC-6.1/6.2/6.3/6.4; ADR-0034).
 *
 * Wraps `GET /me/address` (auth/src/profile/address.routes.ts, plan.md
 * "Employee self surface"). That endpoint is strictly self-scoped by
 * construction — no `:id` parameter exists (AC-6.4), so there is no request
 * this client could build that would name a colleague — and carries no write
 * verb at all (AC-6.3: `PUT`/`POST`/`PATCH`/`DELETE /me/address` all `404`).
 * This client mirrors that read-only contract all the way down to its own
 * surface: `getMyAddress()` is the ONLY export here, there is no
 * `updateMyAddress`/`setMyAddress` sitting unused — read-only is enforced by
 * the server (AC-6.3), but this module doesn't even offer the shape of a
 * write to begin with.
 *
 * Goes through `apiFetch`/`getAuthBaseUrl` (./session) — the same
 * trusted-origin/Bearer-attach/401-refresh machinery every other Operai API
 * call in the suite uses (ADR-0001). `updatedByUserId` is deliberately
 * absent from `AddressView` below: the server never sends it on this
 * endpoint (plan.md "the data subject's transparency right does not extend
 * to learning which admin edited their record — least exposure"), so there
 * is nothing to model here either — this mirrors the server's `AddressView`
 * type, not its `AdminAddressView` superset.
 */

import { apiFetch, getAuthBaseUrl } from './session'

/** The structured address components (plan.md "Shared shapes" `AddressInput`). */
export interface AddressComponents {
  countryCode: string
  city: string
  street: string
  houseNumber: string
  postalCode?: string | null
  region?: string | null
  latitude?: number | null
  longitude?: number | null
}

/**
 * The self-view response shape (plan.md "Employee self surface" — the
 * `AddressView` type, WITHOUT `updatedByUserId`; see module doc for why).
 */
export interface AddressView extends AddressComponents {
  formatted: string
  updatedAt: string
}

interface MyAddressResponse {
  address: AddressView | null
}

/**
 * Fetches the signed-in caller's own stored address.
 *
 * Resolves to `null` for "no address on file" (a normal `200 { address: null
 * }`) — that is a successful, informative result, not an error. Throws for
 * anything else (a non-2xx response, a network failure, or a malformed
 * response body) so the caller (AccountScreen) can render a genuine
 * error+retry state instead of silently reinterpreting "we couldn't reach
 * the server" as "you have no address on file" — those are distinct facts
 * about a person's own personal data and must never be conflated (design.md
 * F6 step 4, plan.md's AC-6.1 test note).
 */
export async function getMyAddress(): Promise<AddressView | null> {
  const response = await apiFetch(`${getAuthBaseUrl()}/me/address`)

  if (!response.ok) {
    throw new Error(`getMyAddress failed: auth responded ${response.status}`)
  }

  const body = (await response.json()) as MyAddressResponse
  return body.address ?? null
}
