/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/session.ts — JWT cache + apiFetch interceptor.
 *
 * Ported from estimai-ui/src/lib/api.test.ts (T4, specs/003-suite-shell) —
 * the shell now owns the extracted `apiFetch`/JWT-cache implementation, so
 * these tests move with it. They cover the interceptor contract at the unit
 * level:
 *   (a) apiFetch attaches Authorization: Bearer <jwt> to every request.
 *   (b) On a 401, apiFetch re-fetches /auth/token once and retries.
 *   (c) On a second 401, apiFetch redirects to the sign-in URL with the
 *       current location encoded as the `redirect` query param.
 *   (d) Trusted-origin policy: Bearer header is only sent to same-origin and
 *       configured service origins — never to third-party URLs (OWASP).
 *
 * (e) signOut() (new in this module — see session.ts) clears the shared
 *     in-memory JWT cache before delegating to the better-auth client, so a
 *     suite-wide sign-out invalidates the cached Bearer token immediately.
 *
 * NOTE — verifying that the token identifies the correct user against the
 * auth service JWKS endpoint requires a running auth service and a live JWKS
 * verification step. That level of verification is an integration / e2e
 * concern (T16). The unit tests here prove the interceptor contract only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// Mock better-auth's client factory so importing ./authClient (a session.ts
// dependency) doesn't perform real network/env work during these interceptor
// tests. signOut is a vi.fn() so test (e) can assert it was delegated to.
const mockAuthClientSignOut = vi.fn().mockResolvedValue(undefined)
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    getSession: vi.fn(),
    useSession: vi.fn(),
    signOut: mockAuthClientSignOut,
  }),
}))

const {
  apiFetch,
  clearJwtCache,
  signOut,
  ensurePermissions,
  revalidatePermissions,
  clearPermissionsCache,
  usePermissions,
  EMPTY_PERMISSIONS,
  registerSuiteNavigate,
  navigateSuite,
} = await import('./session')
type PermissionsResult = Awaited<ReturnType<typeof ensurePermissions>>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_URL = 'http://auth.test'
const API_URL = 'http://api.test'
const REFUND_API_URL = 'http://refund-api.test'
const TARGET_URL = `${API_URL}/estimates`
const THIRD_PARTY_URL = 'https://evil.example.com/x'
const SAME_ORIGIN_PATH = '/estimates'
const FAKE_JWT = 'header.payload.signature'
const REFRESHED_JWT = 'header.refreshed.signature'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object accepted by vi.fn(). */
const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const tokenResponse = (token: string): Response =>
  makeResponse(200, { token })

const unauthorizedResponse = (): Response => makeResponse(401, { error: 'Unauthorized' })

const okResponse = (): Response => makeResponse(200, { data: 'ok' })

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Inject VITE_AUTH_URL into import.meta.env via vi.stubEnv so the lazy
  // getAuthUrl() inside session.ts reads the correct value in every test.
  vi.stubEnv('VITE_AUTH_URL', AUTH_URL)

  // Inject VITE_API_URL so that TARGET_URL (http://api.test/…) is treated as
  // a trusted origin in the existing interceptor tests.
  vi.stubEnv('VITE_API_URL', API_URL)

  // Clear the module-level JWT + permissions caches before each test.
  clearJwtCache()
  clearPermissionsCache()

  // Replace global fetch with a vi mock (restored after each test via afterEach).
  vi.stubGlobal('fetch', vi.fn())

  // Spy on window.location.assign without navigating.
  Object.defineProperty(window, 'location', {
    value: {
      href: 'http://localhost:5173/estimates',
      assign: vi.fn(),
    },
    writable: true,
    configurable: true,
  })

  mockAuthClientSignOut.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('apiFetch', () => {
  describe('(a) attaches Authorization: Bearer header to every request', () => {
    it('fetches /auth/token when cache is empty, then attaches Bearer on the target request', async () => {
      const mockFetch = vi.mocked(fetch)

      // First call: GET /auth/token → returns JWT.
      // Second call: GET TARGET_URL → 200 OK.
      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(okResponse())

      await apiFetch(TARGET_URL)

      // Token endpoint must be called exactly once.
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        `${AUTH_URL}/auth/token`,
        expect.objectContaining({ credentials: 'include' }),
      )

      // Target request must carry Authorization: Bearer.
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        TARGET_URL,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${FAKE_JWT}`,
          }),
        }),
      )
    })

    it('uses the cached JWT on the second call (no second /auth/token fetch)', async () => {
      const mockFetch = vi.mocked(fetch)

      // Call 1: token endpoint, call 2 and call 3: two target requests.
      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(okResponse())
        .mockResolvedValueOnce(okResponse())

      await apiFetch(TARGET_URL)
      await apiFetch(TARGET_URL)

      // /auth/token fetched only once across both apiFetch calls.
      const tokenCalls = mockFetch.mock.calls.filter(
        ([url]) => url === `${AUTH_URL}/auth/token`,
      )
      expect(tokenCalls).toHaveLength(1)

      // Both target requests carry the Bearer header.
      const targetCalls = mockFetch.mock.calls.filter(([url]) => url === TARGET_URL)
      expect(targetCalls).toHaveLength(2)
      for (const [, init] of targetCalls) {
        expect((init as RequestInit & { headers: Record<string, string> }).headers).toMatchObject({
          Authorization: `Bearer ${FAKE_JWT}`,
        })
      }
    })
  })

  describe('(b) on 401, re-fetches /auth/token once and retries the original request', () => {
    it('retries with a fresh JWT when the first response is 401', async () => {
      const mockFetch = vi.mocked(fetch)

      // Call sequence:
      //   1. GET /auth/token          → initial JWT
      //   2. GET TARGET_URL           → 401 (stale token)
      //   3. GET /auth/token          → refreshed JWT
      //   4. GET TARGET_URL (retry)   → 200 OK
      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(unauthorizedResponse())
        .mockResolvedValueOnce(tokenResponse(REFRESHED_JWT))
        .mockResolvedValueOnce(okResponse())

      const response = await apiFetch(TARGET_URL)

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(4)

      // The retry must use the refreshed JWT.
      const retryCall = mockFetch.mock.calls[3]
      expect(
        (retryCall[1] as RequestInit & { headers: Record<string, string> }).headers,
      ).toMatchObject({ Authorization: `Bearer ${REFRESHED_JWT}` })
    })

    it('/auth/token is called exactly ONCE during the refresh (not more)', async () => {
      const mockFetch = vi.mocked(fetch)

      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(unauthorizedResponse())
        .mockResolvedValueOnce(tokenResponse(REFRESHED_JWT))
        .mockResolvedValueOnce(okResponse())

      await apiFetch(TARGET_URL)

      const tokenCalls = mockFetch.mock.calls.filter(
        ([url]) => url === `${AUTH_URL}/auth/token`,
      )
      // Initial fetch + one refresh = 2 total /auth/token calls.
      expect(tokenCalls).toHaveLength(2)
    })
  })

  describe('(d) trusted-origin policy — Bearer header is only sent to trusted origins', () => {
    it('sends Authorization header for a relative (same-origin) URL', async () => {
      const mockFetch = vi.mocked(fetch)

      // Relative path: /estimates resolves to http://localhost:5173/estimates
      // (window.location.href = 'http://localhost:5173/estimates' in beforeEach)
      // which shares the current page origin (http://localhost:5173) → trusted.
      // Call sequence: 1. GET /auth/token → JWT; 2. GET /estimates → 200 OK.
      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT)) // /auth/token
        .mockResolvedValueOnce(okResponse())             // relative target

      await apiFetch(SAME_ORIGIN_PATH)

      // Both calls must have happened (token fetch + target fetch).
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // The target request (second call) must carry the Bearer header.
      const [, init] = mockFetch.mock.calls[1]
      expect(
        (init as RequestInit & { headers: Record<string, string> }).headers,
      ).toMatchObject({ Authorization: `Bearer ${FAKE_JWT}` })
    })

    it('sends Authorization header for a request to the auth-origin URL', async () => {
      const mockFetch = vi.mocked(fetch)

      const authOriginUrl = `${AUTH_URL}/some-endpoint`
      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(okResponse())

      await apiFetch(authOriginUrl)

      expect(mockFetch).toHaveBeenCalledTimes(2)
      const [, init] = mockFetch.mock.calls[1]
      expect(
        (init as RequestInit & { headers: Record<string, string> }).headers,
      ).toMatchObject({ Authorization: `Bearer ${FAKE_JWT}` })
    })

    // T20 (specs/007-refund-service, tasks.md "Trusted-origin fix"): proves
    // getTrustedOrigins() (session.ts, unexported) includes the refund-api
    // origin once VITE_REFUND_API_URL is set — mirrors this describe block's
    // own auth-origin assertion above, and matches how specs/005-notification-
    // center proved the notify-api entry (shell/src/lib/notifications.test.ts,
    // "trusted origins" describe block) — behaviorally, via apiFetch, since
    // getTrustedOrigins itself is a private helper.
    it('sends Authorization header for a request to the refund-api origin (VITE_REFUND_API_URL)', async () => {
      vi.stubEnv('VITE_REFUND_API_URL', REFUND_API_URL)
      const mockFetch = vi.mocked(fetch)

      const refundOriginUrl = `${REFUND_API_URL}/requests`
      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(okResponse())

      await apiFetch(refundOriginUrl)

      expect(mockFetch).toHaveBeenCalledTimes(2)
      const [, init] = mockFetch.mock.calls[1]
      expect(
        (init as RequestInit & { headers: Record<string, string> }).headers,
      ).toMatchObject({ Authorization: `Bearer ${FAKE_JWT}` })
    })

    it('does NOT send Authorization header for a third-party URL', async () => {
      const mockFetch = vi.mocked(fetch)

      // Third-party origin — no JWT fetch, no Bearer header.
      mockFetch.mockResolvedValueOnce(okResponse())

      await apiFetch(THIRD_PARTY_URL)

      // Only the single passthrough fetch — no /auth/token call.
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(THIRD_PARTY_URL)

      // init may be undefined (passthrough) or lack an Authorization key.
      const headers = (init as RequestInit & { headers?: Record<string, string> } | undefined)?.headers
      expect(headers?.['Authorization']).toBeUndefined()
    })

    it('does NOT include credentials for a third-party URL', async () => {
      const mockFetch = vi.mocked(fetch)

      mockFetch.mockResolvedValueOnce(okResponse())

      await apiFetch(THIRD_PARTY_URL)

      const [, init] = mockFetch.mock.calls[0]
      // credentials must NOT be 'include' for cross-origin requests.
      expect((init as RequestInit | undefined)?.credentials).not.toBe('include')
    })

    it('returns the response from a third-party URL even though it is unauthenticated', async () => {
      const mockFetch = vi.mocked(fetch)

      mockFetch.mockResolvedValueOnce(okResponse())

      const response = await apiFetch(THIRD_PARTY_URL)

      expect(response.status).toBe(200)
    })
  })

  describe('(c) on a second 401, redirects to the sign-in URL with current location as redirect param', () => {
    it('redirects to <AUTH_URL>/sign-in?redirect=<current URL> when both attempts return 401', async () => {
      const mockFetch = vi.mocked(fetch)

      // Call sequence:
      //   1. GET /auth/token          → initial JWT
      //   2. GET TARGET_URL           → 401
      //   3. GET /auth/token          → refreshed JWT (or null; session truly gone)
      //   4. GET TARGET_URL (retry)   → 401 again
      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(unauthorizedResponse())
        .mockResolvedValueOnce(tokenResponse(REFRESHED_JWT))
        .mockResolvedValueOnce(unauthorizedResponse())

      await apiFetch(TARGET_URL)

      const expectedRedirect = encodeURIComponent(window.location.href)
      expect(window.location.assign).toHaveBeenCalledOnce()
      expect(window.location.assign).toHaveBeenCalledWith(
        `${AUTH_URL}/sign-in?redirect=${expectedRedirect}`,
      )
    })

    it('does NOT redirect when the retry succeeds (200)', async () => {
      const mockFetch = vi.mocked(fetch)

      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(unauthorizedResponse())
        .mockResolvedValueOnce(tokenResponse(REFRESHED_JWT))
        .mockResolvedValueOnce(okResponse())

      await apiFetch(TARGET_URL)

      expect(window.location.assign).not.toHaveBeenCalled()
    })

    it('clears the JWT cache before redirecting so the next page load re-fetches a fresh token', async () => {
      const mockFetch = vi.mocked(fetch)

      mockFetch
        .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
        .mockResolvedValueOnce(unauthorizedResponse())
        .mockResolvedValueOnce(tokenResponse(REFRESHED_JWT))
        .mockResolvedValueOnce(unauthorizedResponse())
        // Fresh token fetch that would happen on the next apiFetch call
        .mockResolvedValueOnce(tokenResponse('brand-new-jwt'))
        .mockResolvedValueOnce(okResponse())

      await apiFetch(TARGET_URL)

      // After the redirect path, the cache is cleared. A subsequent call must
      // hit /auth/token again.
      await apiFetch(TARGET_URL)

      const tokenCalls = mockFetch.mock.calls.filter(
        ([url]) => url === `${AUTH_URL}/auth/token`,
      )
      // 2 from the failed flow + 1 for the fresh call after cache clear = 3.
      expect(tokenCalls).toHaveLength(3)
    })
  })
})

describe('signOut', () => {
  it('(e) clears the in-memory JWT cache before delegating to the better-auth client', async () => {
    const mockFetch = vi.mocked(fetch)

    // Prime the cache with a JWT.
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(okResponse())
    await apiFetch(TARGET_URL)

    await signOut()

    // The better-auth client's signOut was called (session delegation).
    expect(mockAuthClientSignOut).toHaveBeenCalledOnce()

    // The cache was cleared before delegating: a subsequent apiFetch must
    // re-fetch /auth/token rather than reuse the stale JWT.
    mockFetch
      .mockResolvedValueOnce(tokenResponse('post-signout-jwt'))
      .mockResolvedValueOnce(okResponse())
    await apiFetch(TARGET_URL)

    const tokenCalls = mockFetch.mock.calls.filter(
      ([url]) => url === `${AUTH_URL}/auth/token`,
    )
    // 1 initial fetch + 1 fetch after sign-out clears the cache = 2.
    expect(tokenCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Permission resolution — ensurePermissions / revalidatePermissions /
// usePermissions (T23, specs/004-auth-roles-permissions).
//
// GET /authz/me is reached through apiFetch (same trusted-origin/Bearer/401
// machinery as the JWT), so every scenario below primes a /auth/token
// response before the /authz/me response, mirroring the apiFetch tests above.
// ---------------------------------------------------------------------------

const PERMISSIONS_URL = `${AUTH_URL}/authz/me`

const permissionsResponse = (overrides: Partial<PermissionsResult> = {}): Response =>
  makeResponse(200, {
    epoch: 1,
    apps: ['estimai'],
    roles: ['employee'],
    departments: [],
    permissions: [{ resource: 'estimate', action: 'view' }],
    ...overrides,
  })

describe('ensurePermissions', () => {
  it('fetches GET /authz/me and populates the in-memory cache on the first call', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT)) // /auth/token (apiFetch)
      .mockResolvedValueOnce(permissionsResponse()) // /authz/me

    const result = await ensurePermissions()

    expect(result).toEqual({
      epoch: 1,
      apps: ['estimai'],
      roles: ['employee'],
      departments: [],
      permissions: [{ resource: 'estimate', action: 'view' }],
    })

    const permCalls = mockFetch.mock.calls.filter(([url]) => url === PERMISSIONS_URL)
    expect(permCalls).toHaveLength(1)
  })

  it('returns the cached value on a second call — no second /authz/me fetch', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(permissionsResponse())

    const first = await ensurePermissions()
    const second = await ensurePermissions()

    expect(second).toEqual(first)
    const permCalls = mockFetch.mock.calls.filter(([url]) => url === PERMISSIONS_URL)
    expect(permCalls).toHaveLength(1)
  })

  it('dedupes concurrent callers into a single in-flight /authz/me request', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(permissionsResponse())

    const [a, b] = await Promise.all([ensurePermissions(), ensurePermissions()])

    expect(a).toEqual(b)
    const permCalls = mockFetch.mock.calls.filter(([url]) => url === PERMISSIONS_URL)
    expect(permCalls).toHaveLength(1)
  })

  it('resolves to EMPTY_PERMISSIONS (apps: []) on a failed fetch instead of throwing', async () => {
    const mockFetch = vi.mocked(fetch)
    // apiFetch flow: token, first 401, refresh token, retry 401 → redirect;
    // ensurePermissions must resolve to the denied result, never throw/reject.
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(unauthorizedResponse())
      .mockResolvedValueOnce(tokenResponse(REFRESHED_JWT))
      .mockResolvedValueOnce(unauthorizedResponse())

    await expect(ensurePermissions()).resolves.toEqual(EMPTY_PERMISSIONS)
  })

  it('resolves to EMPTY_PERMISSIONS on a network-level failure instead of throwing', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockRejectedValueOnce(new TypeError('network error'))

    await expect(ensurePermissions()).resolves.toEqual(EMPTY_PERMISSIONS)
  })
})

describe('revalidatePermissions', () => {
  it('re-fetches /authz/me and replaces the cache even when already populated', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(permissionsResponse({ epoch: 1, apps: ['estimai'] }))
      .mockResolvedValueOnce(
        permissionsResponse({ epoch: 2, apps: ['estimai', 'refund'] }),
      )

    const first = await ensurePermissions()
    expect(first.apps).toEqual(['estimai'])

    const second = await revalidatePermissions()
    expect(second.epoch).toBe(2)
    expect(second.apps).toEqual(['estimai', 'refund'])

    // A subsequent ensurePermissions() call must reuse the revalidated cache,
    // not trigger a third fetch.
    const third = await ensurePermissions()
    expect(third).toEqual(second)

    const permCalls = mockFetch.mock.calls.filter(([url]) => url === PERMISSIONS_URL)
    expect(permCalls).toHaveLength(2)
  })
})

describe('signOut clears the permissions cache', () => {
  it('forces a fresh /authz/me fetch on the next ensurePermissions() call after sign-out', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(permissionsResponse({ epoch: 1 }))
    await ensurePermissions()

    await signOut()

    mockFetch
      .mockResolvedValueOnce(tokenResponse('post-signout-jwt'))
      .mockResolvedValueOnce(permissionsResponse({ epoch: 2 }))
    const result = await ensurePermissions()

    expect(result.epoch).toBe(2)
    const permCalls = mockFetch.mock.calls.filter(([url]) => url === PERMISSIONS_URL)
    expect(permCalls).toHaveLength(2)
  })
})

describe('usePermissions', () => {
  it('exposes EMPTY_PERMISSIONS synchronously, then the resolved permissions once fetched', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(permissionsResponse({ apps: ['estimai'] }))

    const { result } = renderHook(() => usePermissions())

    expect(result.current).toEqual(EMPTY_PERMISSIONS)

    await waitFor(() => {
      expect(result.current.apps).toEqual(['estimai'])
    })
  })

  it('reflects a revalidatePermissions() update in an already-mounted component', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockResolvedValueOnce(tokenResponse(FAKE_JWT))
      .mockResolvedValueOnce(permissionsResponse({ epoch: 1, apps: ['estimai'] }))
      .mockResolvedValueOnce(
        permissionsResponse({ epoch: 2, apps: ['estimai', 'refund'] }),
      )

    const { result } = renderHook(() => usePermissions())

    await waitFor(() => {
      expect(result.current.apps).toEqual(['estimai'])
    })

    await revalidatePermissions()

    await waitFor(() => {
      expect(result.current.apps).toEqual(['estimai', 'refund'])
    })
  })
})

// ---------------------------------------------------------------------------
// navigateSuite / registerSuiteNavigate — the cross-remote navigation seam
// (follow-up to specs/005-notification-center, T15/AC-2.5). NOTE: the
// underlying registry is module-scope and NOT reset by beforeEach (there is
// no `resetSuiteNavigate` — production only ever registers once, from
// main.tsx), so the "falls back" case is asserted FIRST, before any test in
// this file registers a function, and the "registered" case intentionally
// leaves a registration behind afterwards.
// ---------------------------------------------------------------------------

describe('navigateSuite', () => {
  it('falls back to window.location.assign(to) when nothing is registered', () => {
    navigateSuite('/estimai/estimates/42')

    expect(window.location.assign).toHaveBeenCalledOnce()
    expect(window.location.assign).toHaveBeenCalledWith('/estimai/estimates/42')
  })

  it('calls the registered function instead of the fallback once registerSuiteNavigate has run', () => {
    const fn = vi.fn()
    registerSuiteNavigate(fn)

    navigateSuite('/refund/reports/7')

    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith('/refund/reports/7')
    expect(window.location.assign).not.toHaveBeenCalled()
  })
})
