/**
 * apiFetch — authenticated fetch wrapper for Operai backend services.
 *
 * JWT caching strategy (ADR-0001):
 *   The RS256 JWT is cached in module-scope memory only — never written to
 *   localStorage, sessionStorage, IndexedDB, or any other persistent storage.
 *   The 7-day session cookie managed by better-auth is the sole durable
 *   credential; the JWT is a derived, re-fetchable artifact.
 *
 * Refresh protocol (per ADR-0001):
 *   1. No JWT cached → fetch GET /auth/token, cache result, attach Bearer header.
 *   2. Request returns 401 → clear cache, re-fetch /auth/token once, retry once.
 *   3. Retry also returns 401 → clear cache, redirect to sign-in page with
 *      current URL as the `redirect` param (AC-4.1 / AC-4.2).
 */

/** In-memory JWT cache (module scope — cleared on page reload, never persisted). */
let cachedJwt: string | null = null

/**
 * Returns the auth service base URL from the Vite environment.
 * Read lazily (not at module scope) so that tests can inject the value before
 * the first call without relying on module-evaluation order.
 */
const getAuthUrl = (): string => import.meta.env.VITE_AUTH_URL as string

/** Clears the in-memory JWT cache. */
export const clearJwtCache = (): void => {
  cachedJwt = null
}

/**
 * Fetches a fresh RS256 JWT from the auth service token endpoint.
 * The endpoint is cookie-authenticated; no credentials are sent in the body.
 * Returns the JWT string, or null if the session is absent (auth service 401).
 */
const fetchJwt = async (): Promise<string | null> => {
  const response = await fetch(`${getAuthUrl()}/auth/token`, {
    credentials: 'include',
  })
  if (!response.ok) {
    return null
  }
  const body = (await response.json()) as { token: string }
  return body.token
}

/**
 * Ensures a JWT is present in the module-scope cache.
 * Fetches from /auth/token if the cache is empty.
 * Returns the JWT string, or null if the session is invalid/absent.
 */
const ensureJwt = async (): Promise<string | null> => {
  if (cachedJwt === null) {
    cachedJwt = await fetchJwt()
  }
  return cachedJwt
}

/**
 * Redirects the user to the auth service sign-in page.
 * Encodes the current absolute URL as the `redirect` query param so that
 * after sign-in the user is returned to where they were (AC-4.2).
 */
const redirectToSignIn = (): void => {
  const redirect = encodeURIComponent(window.location.href)
  window.location.assign(`${getAuthUrl()}/sign-in?redirect=${redirect}`)
}

/**
 * Authenticated fetch wrapper.
 *
 * Drop-in replacement for the browser's `fetch` that attaches an
 * `Authorization: Bearer <jwt>` header to every request and handles token
 * expiry transparently (one refresh + retry on 401, then redirect to sign-in).
 *
 * AC-3.1: every outgoing request carries the user's token.
 * AC-4.1: 401 that cannot be recovered → redirect to sign-in page.
 *
 * Note — AC-3.2 (token identifies the correct user, verified against the
 * auth service JWKS) requires a live auth service and is verified in the
 * integration / e2e layer (T10/T11). The unit tests here cover the
 * interceptor contract only.
 */
export const apiFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  // Step 1: ensure a JWT is cached and attach it.
  const jwt = await ensureJwt()

  const makeHeaders = (token: string | null): HeadersInit => ({
    ...(init?.headers as Record<string, string> | undefined),
    ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
  })

  const firstResponse = await fetch(input, {
    ...init,
    credentials: 'include',
    headers: makeHeaders(jwt),
  })

  if (firstResponse.status !== 401) {
    return firstResponse
  }

  // Step 2: first 401 — drop the cached JWT, re-fetch once, retry.
  cachedJwt = null
  const refreshedJwt = await fetchJwt()
  cachedJwt = refreshedJwt

  const retryResponse = await fetch(input, {
    ...init,
    credentials: 'include',
    headers: makeHeaders(refreshedJwt),
  })

  if (retryResponse.status !== 401) {
    return retryResponse
  }

  // Step 3: second 401 — session is genuinely gone; clear cache and redirect.
  cachedJwt = null
  redirectToSignIn()

  // Return the response to satisfy the return type; the redirect is in flight.
  return retryResponse
}
