/**
 * seedSession — programmatically establish a better-auth session for e2e tests.
 *
 * Strategy (plan.md "seeded-session" approach, Architecture item 11):
 *   1. POST /test-auth/session to the auth service with an @operai.test email.
 *      The endpoint mints a real better-auth session and returns the session
 *      cookie in the Set-Cookie response header (not in the body).
 *   2. Parse the Set-Cookie header into Playwright-compatible cookie objects.
 *   3. Inject the cookies into the Playwright BrowserContext so the UI's
 *      `_authed` route guard sees an authenticated session on first page load.
 *
 * Requirements on the auth service side:
 *   - Must be started with NODE_ENV=development and ENABLE_TEST_AUTH=true
 *   - The email MUST end with @operai.test (enforced by the endpoint's allowlist)
 *
 * The auth base URL is read from the E2E_AUTH_URL environment variable
 * (falls back to VITE_AUTH_URL, then http://localhost:3001).
 */

import type { BrowserContext } from '@playwright/test'

const AUTH_URL =
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'

/** Test user minted by the session-mint endpoint for e2e sessions. */
export const E2E_TEST_USER = {
  name: 'E2E User',
  email: 'e2e@operai.test',
} as const

export type ParsedCookie = {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

/**
 * Calls POST /test-auth/session to mint a better-auth session cookie
 * and returns it as a Playwright-compatible cookie object array.
 *
 * The endpoint returns the session in a Set-Cookie header (not the body).
 * Throws a descriptive error if the endpoint is unavailable or the gate is off.
 */
const acquireSessionCookies = async (): Promise<ParsedCookie[]> => {
  const baseUrl = AUTH_URL.replace(/\/$/, '')
  const authHostname = new URL(baseUrl).hostname

  const res = await fetch(`${baseUrl}/test-auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(E2E_TEST_USER),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `[seedSession] POST /test-auth/session failed (${res.status}): ${body}\n` +
        `Auth URL: ${baseUrl}\n` +
        `Make sure the auth service is running with ENABLE_TEST_AUTH=true and NODE_ENV != production.`,
    )
  }

  const rawCookieHeader = res.headers.get('set-cookie')
  if (!rawCookieHeader) {
    throw new Error(
      '[seedSession] POST /test-auth/session succeeded but returned no Set-Cookie header. ' +
        'Check the auth service test-auth route implementation.',
    )
  }

  return parseCookies(rawCookieHeader, authHostname)
}

/**
 * Parses a `Set-Cookie` header string into Playwright-compatible cookie objects.
 *
 * Handles the single-cookie case returned by the test-auth endpoint.
 * The comma-split heuristic below also handles multi-cookie headers
 * (e.g. if the auth service ever returns more than one cookie at once).
 */
const parseCookies = (setCookieHeader: string, domain: string): ParsedCookie[] => {
  // Split on ", " only at the start of a new cookie (before "name=value"),
  // not within Expires dates which also contain commas.
  const rawCookies = setCookieHeader.split(/,(?=\s*\w+=)/)

  return rawCookies.flatMap((raw) => {
    const parts = raw.trim().split(';').map((p) => p.trim())
    const [nameValue, ...attrs] = parts
    if (!nameValue) return []

    const eqIdx = nameValue.indexOf('=')
    if (eqIdx === -1) return []
    const name = nameValue.slice(0, eqIdx).trim()
    const value = nameValue.slice(eqIdx + 1).trim()

    const attrMap: Record<string, string | boolean> = {}
    for (const attr of attrs) {
      const [k, v] = attr.split('=')
      const key = k.trim().toLowerCase()
      attrMap[key] = v !== undefined ? v.trim() : true
    }

    const sameSiteRaw =
      typeof attrMap['samesite'] === 'string'
        ? attrMap['samesite'].toLowerCase()
        : 'lax'
    const sameSite: 'Strict' | 'Lax' | 'None' =
      sameSiteRaw === 'strict' ? 'Strict' : sameSiteRaw === 'none' ? 'None' : 'Lax'

    return [
      {
        name,
        value,
        domain: typeof attrMap['domain'] === 'string' ? attrMap['domain'] : domain,
        path: typeof attrMap['path'] === 'string' ? attrMap['path'] : '/',
        httpOnly: attrMap['httponly'] === true,
        secure: attrMap['secure'] === true,
        sameSite,
      },
    ]
  })
}

/**
 * Seeds a better-auth session into the given Playwright BrowserContext.
 *
 * Calls the dev/test-only session-mint endpoint (POST /test-auth/session),
 * extracts the returned session cookie from Set-Cookie headers, and injects
 * it into the browser context so the UI's `_authed` route guard sees an
 * authenticated session from the very first page load.
 *
 * Returns the injected cookies so callers can capture the raw session token
 * for out-of-band verification (e.g. AC-5.2: assert GET /auth/get-session
 * returns null after sign-out, proving server-side session termination).
 *
 * Usage in a test:
 * ```ts
 * test.beforeEach(async ({ context }) => {
 *   await seedSession(context)
 * })
 *
 * // With session-cookie capture for server-side verification:
 * const cookies = await seedSession(context)
 * ```
 */
export const seedSession = async (context: BrowserContext): Promise<ParsedCookie[]> => {
  const cookies = await acquireSessionCookies()
  if (cookies.length === 0) {
    throw new Error(
      '[seedSession] No cookies were parsed from the auth service response. ' +
        'The session may not have been established.',
    )
  }
  await context.addCookies(cookies)
  return cookies
}
