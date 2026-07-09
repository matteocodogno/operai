/**
 * shell/session — the Operai suite's single shared session/runtime module.
 *
 * Extracted from estimai-ui/src/lib/api.ts + authClient.ts (T4, specs/003-suite-shell,
 * ADR-0001, ADR-0006). The shell exposes this module via Module Federation as
 * `./session` so every remote (estimai-ui, refund-ui, …) consumes ONE in-memory
 * JWT cache and ONE better-auth client instance for the whole suite, instead of
 * each tool holding its own copy. estimai-ui keeps its own copy of api.ts/
 * authClient.ts until it is rewired to consume `shell/session` (T13) — this
 * file is not imported by estimai-ui yet.
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
 *      current URL as the `redirect` param.
 *
 * Trusted-origin policy (OWASP):
 *   The Bearer JWT is only attached when the request targets a trusted origin:
 *     • Same origin as the current page (relative URLs resolve here automatically).
 *     • The auth service origin (VITE_AUTH_URL).
 *     • The API service origin (VITE_API_URL), if that env var is defined.
 *   Requests to any other origin proceed unauthenticated — no Authorization
 *   header is sent and credentials are not included cross-origin.
 */

import { authClient } from './authClient'

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
 * Resolves the origin of a RequestInfo | URL value.
 * Relative string paths (no scheme) resolve against window.location.href,
 * which means they share the current page's origin (always trusted).
 */
const resolveOrigin = (input: RequestInfo | URL): string => {
  let href: string
  if (input instanceof Request) {
    href = input.url
  } else if (input instanceof URL) {
    href = input.href
  } else {
    href = input
  }
  try {
    return new URL(href, window.location.href).origin
  } catch {
    // Unparseable URL — treat as same-origin (will fail at fetch level anyway).
    return new URL(window.location.href).origin
  }
}

/**
 * Returns the set of origins to which the Bearer JWT may be sent.
 * Built lazily so tests can inject VITE_AUTH_URL / VITE_API_URL before the
 * first call.
 *
 * The current-page origin is derived from window.location.href (not .origin)
 * so that test environments which mock location as a plain object without the
 * .origin accessor still resolve correctly.
 */
const getTrustedOrigins = (): Set<string> => {
  const currentOrigin = new URL(window.location.href).origin
  const trusted = new Set<string>([currentOrigin])

  const authUrl = import.meta.env.VITE_AUTH_URL as string | undefined
  if (authUrl) {
    try {
      trusted.add(new URL(authUrl).origin)
    } catch { /* ignore invalid env value */ }
  }

  const apiUrl = import.meta.env.VITE_API_URL as string | undefined
  if (apiUrl) {
    try {
      trusted.add(new URL(apiUrl).origin)
    } catch { /* ignore invalid env value */ }
  }

  return trusted
}

/**
 * Returns true when the request targets an origin the app trusts with its JWT.
 */
const isTrustedOrigin = (input: RequestInfo | URL): boolean =>
  getTrustedOrigins().has(resolveOrigin(input))

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
 * after sign-in the user is returned to where they were.
 */
const redirectToSignIn = (): void => {
  const redirect = encodeURIComponent(window.location.href)
  window.location.assign(`${getAuthUrl()}/sign-in?redirect=${redirect}`)
}

/**
 * Authenticated fetch wrapper.
 *
 * Drop-in replacement for the browser's `fetch` that attaches an
 * `Authorization: Bearer <jwt>` header to every request **targeting a trusted
 * origin** and handles token expiry transparently (one refresh + retry on 401,
 * then redirect to sign-in).
 *
 * Trusted origins: same-origin (relative URLs), VITE_AUTH_URL origin, and
 * VITE_API_URL origin (if defined). Requests to any other origin proceed
 * without the Authorization header and without credentials (OWASP).
 *
 * Note — verifying that the token identifies the correct user against the
 * auth service JWKS requires a live auth service and is covered at the
 * integration / e2e layer. The unit tests here cover the interceptor
 * contract only.
 */
export const apiFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const trusted = isTrustedOrigin(input)

  // For untrusted origins: pass through unauthenticated, without credentials.
  if (!trusted) {
    return fetch(input, init)
  }

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

/**
 * Session wrappers — the single better-auth client instance for the suite.
 *
 * getSession / useSession resolve the cookie-based session as-is (mirrors
 * estimai-ui/src/router.tsx's `_authed` guard usage, ADR-0002).
 *
 * signOut additionally clears the shared in-memory JWT cache *before* ending
 * the better-auth session, so a suite-wide sign-out invalidates every
 * remote's cached Bearer token immediately rather than waiting for the next
 * 401 (plan.md federation contract: "authClient.signOut() — suite-wide
 * sign-out; clears the shared JWT cache + redirects").
 */
export const getSession = authClient.getSession
export const useSession = authClient.useSession

export const signOut = async (
  ...args: Parameters<typeof authClient.signOut>
): Promise<Awaited<ReturnType<typeof authClient.signOut>>> => {
  clearJwtCache()
  return authClient.signOut(...args)
}
