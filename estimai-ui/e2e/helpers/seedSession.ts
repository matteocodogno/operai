/**
 * seedSession — programmatically establish a better-auth session for e2e tests.
 *
 * Strategy (plan.md "seeded-session" approach):
 *   1. POST /auth/sign-up/email to create (or reuse) a test user via better-auth's
 *      built-in email sign-up endpoint.  This works without going through real OAuth —
 *      the endpoint is always enabled when better-auth runs.
 *   2. POST /auth/sign-in/email to get a Set-Cookie session token.
 *   3. Inject the resulting cookie into the Playwright BrowserContext so the UI
 *      sees an authenticated session from the first page load.
 *
 * The auth base URL is read from the E2E_AUTH_URL environment variable
 * (falls back to VITE_AUTH_URL, then http://localhost:3001).
 *
 * NOTE: The email sign-up endpoint must not be disabled in the auth service.
 * better-auth enables it by default.  If a future auth config change restricts
 * it, the helper will throw a descriptive error early.
 */

import type { BrowserContext } from '@playwright/test'

const AUTH_URL =
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'

/** Test user seeded into better-auth for e2e sessions. */
export const E2E_TEST_USER = {
  name: 'E2E Test User',
  email: 'e2e-test@operai.local',
  password: 'E2eTestPass!2024',
} as const

type BetterAuthSession = {
  /** The raw `Set-Cookie` header value from the sign-in response. */
  cookieHeader: string
  /** Structured cookie entries for Playwright's `context.addCookies()`. */
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    httpOnly: boolean
    secure: boolean
    sameSite: 'Strict' | 'Lax' | 'None'
  }>
}

/**
 * Creates a test user (idempotent — ignores 422 already-exists) and signs in,
 * returning the session cookies.
 */
const acquireSessionCookies = async (): Promise<BetterAuthSession> => {
  const baseUrl = AUTH_URL.replace(/\/$/, '')

  // ── Step 1: create the test user (idempotent) ──────────────────────────────
  const signUpRes = await fetch(`${baseUrl}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(E2E_TEST_USER),
  })

  // 200 = created, 422 = already exists — both are fine.
  // Any other status is an unexpected error.
  if (!signUpRes.ok && signUpRes.status !== 422) {
    const body = await signUpRes.text()
    throw new Error(
      `[seedSession] sign-up failed (${signUpRes.status}): ${body}\n` +
        `Auth URL: ${baseUrl}`,
    )
  }

  // ── Step 2: sign in to obtain the session cookie ───────────────────────────
  const signInRes = await fetch(`${baseUrl}/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: E2E_TEST_USER.email,
      password: E2E_TEST_USER.password,
    }),
  })

  if (!signInRes.ok) {
    const body = await signInRes.text()
    throw new Error(
      `[seedSession] sign-in failed (${signInRes.status}): ${body}\n` +
        `Auth URL: ${baseUrl}`,
    )
  }

  const rawCookieHeader = signInRes.headers.get('set-cookie')
  if (!rawCookieHeader) {
    throw new Error(
      '[seedSession] sign-in succeeded but no Set-Cookie header was returned. ' +
        'Check that the auth service session cookie is not HttpOnly-only under HTTPS ' +
        'and that CORS exposes the Set-Cookie header to this origin.',
    )
  }

  // ── Step 3: parse cookies for Playwright ──────────────────────────────────
  const cookies = parseCookies(rawCookieHeader, new URL(baseUrl).hostname)

  return { cookieHeader: rawCookieHeader, cookies }
}

/**
 * Parses a `Set-Cookie` header string into Playwright-compatible cookie objects.
 * Handles comma-separated multiple cookies (RFC 6265 §4.2.1).
 */
const parseCookies = (
  setCookieHeader: string,
  domain: string,
): BetterAuthSession['cookies'] => {
  // Split on ", " only at the start of a new cookie (before "name=value"),
  // not within Expires dates which also contain commas.
  // A safe heuristic: split on ", " followed by a word char (cookie name).
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

    const sameSiteRaw = typeof attrMap['samesite'] === 'string'
      ? attrMap['samesite'].toLowerCase()
      : 'lax'
    const sameSite: 'Strict' | 'Lax' | 'None' =
      sameSiteRaw === 'strict' ? 'Strict' :
      sameSiteRaw === 'none'   ? 'None'   : 'Lax'

    return [{
      name,
      value,
      domain: typeof attrMap['domain'] === 'string' ? attrMap['domain'] : domain,
      path: typeof attrMap['path'] === 'string' ? attrMap['path'] : '/',
      httpOnly: attrMap['httponly'] === true,
      secure: attrMap['secure'] === true,
      sameSite,
    }]
  })
}

/**
 * Seeds a better-auth session into the given Playwright BrowserContext.
 *
 * Usage in a test:
 * ```ts
 * test.beforeEach(async ({ context }) => {
 *   await seedSession(context)
 * })
 * ```
 *
 * The context will have a valid session cookie set for the auth service domain,
 * so the UI's `_authed` route guard will see an authenticated session on first
 * page load.
 */
export const seedSession = async (context: BrowserContext): Promise<void> => {
  const { cookies } = await acquireSessionCookies()
  if (cookies.length === 0) {
    throw new Error(
      '[seedSession] No cookies were parsed from the auth service response. ' +
        'The session may not have been established.',
    )
  }
  await context.addCookies(cookies)
}
