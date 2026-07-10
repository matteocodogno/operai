/**
 * Real-JWKS identity + real-backend 401 (T18, specs/003-suite-shell).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE (relocated from estimai-ui/e2e/auth-identity.spec.ts)
 *
 * These live-stack assertions verify the auth ↔ estimai-api chain (JWKS
 * verification, ownership isolation, RFC 7807 errors) and the shared
 * `shell/session` apiFetch circuit (ADR-0001) against a REAL estimai-api 401 —
 * not mocks. They historically lived in estimai-ui/e2e because estimai-ui was
 * the only frontend; the JWKS/ownership tests (1)-(4),(6) are pure Node-context
 * HTTP tests that never touched estimai-ui's UI at all, so they kept passing
 * after estimai-ui became a shell remote. They are relocated here so this real
 * backend coverage isn't dropped when the obsolete standalone estimai-ui e2e
 * suite is retired, and so the browser real-401 test (5) drives the ACTUAL
 * shipping surface: EstimAI mounted in the shell, using shell/session's apiFetch.
 *
 * The ADR-0001 refresh-retry-redirect circuit is also unit-covered (with mocked
 * fetch) in shell/src/lib/session.test.ts; test (5) is the real-backend-401
 * end-to-end counterpart.
 *
 * STACK REQUIREMENTS (started by shell/playwright.config.ts webServer):
 *   Postgres (5435), auth (3001, ENABLE_TEST_AUTH=true), estimai-api (8080),
 *   shell + estimai-ui + refund-ui built & previewed.
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

const AUTH_ORIGIN = (
  process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001'
).replace(/\/$/, '')
const API_ORIGIN = (
  process.env['E2E_API_URL'] ?? process.env['VITE_API_URL'] ?? 'http://localhost:8080'
).replace(/\/$/, '')

// ─── Helpers (Node context) ─────────────────────────────────────────────────

type SeedResult = { sessionCookieHeader: string; userId: string; email: string }

const seedUserSession = async (email: string, name: string): Promise<SeedResult> => {
  const res = await fetch(`${AUTH_ORIGIN}/test-auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `[identity] POST /test-auth/session failed (${res.status}): ${body}. ` +
        `Make sure auth is running with ENABLE_TEST_AUTH=true`,
    )
  }
  const body = (await res.json()) as { userId: string; email: string }
  const rawCookieHeader = res.headers.get('set-cookie')
  if (!rawCookieHeader) throw new Error('[identity] POST /test-auth/session returned no Set-Cookie')
  const nameValue = rawCookieHeader.split(';')[0].trim()
  return { sessionCookieHeader: nameValue, userId: body.userId, email: body.email }
}

const fetchJwt = async (sessionCookieHeader: string): Promise<string> => {
  const res = await fetch(`${AUTH_ORIGIN}/auth/token`, { headers: { Cookie: sessionCookieHeader } })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`[identity] GET /auth/token failed (${res.status}): ${body}`)
  }
  const body = (await res.json()) as { token: string }
  if (!body.token) throw new Error('[identity] GET /auth/token returned no token')
  return body.token
}

const decodeJwtHeader = (jwt: string): { alg: string; kid: string } => {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('[identity] Not a valid JWT format')
  return JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg: string; kid: string }
}

const decodeJwtPayload = (jwt: string): { sub: string; email: string; iss: string } => {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('[identity] Not a valid JWT format')
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
    sub: string
    email: string
    iss: string
  }
}

// ─── Real-JWKS identity (Node-context HTTP integration) ─────────────────────

test.describe('real JWT verified against live JWKS resolves the correct user', () => {
  const runId = Date.now().toString(36)
  const USER_A_EMAIL = `id-a-${runId}@operai.test`
  const USER_B_EMAIL = `id-b-${runId}@operai.test`

  const minimalContent = {
    params: {
      parallelism: 0.7,
      sprintDays: 10,
      workingDaysMonth: 20,
      qaDeployDays: 0,
      qaTestDays: 0,
      pmDays: 0,
      aiCostCoef: 10,
      aiGain: 0.3,
    },
    releases: [],
    acts: [],
  }

  test('(1) auth /auth/jwks is reachable and returns an RS256 keys array', async () => {
    const res = await fetch(`${AUTH_ORIGIN}/auth/jwks`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: unknown[] }
    expect(Array.isArray(body.keys) && body.keys.length > 0).toBe(true)
    const firstKey = body.keys[0] as { alg: string; kty: string; kid: string }
    expect(firstKey.alg).toBe('RS256')
    expect(firstKey.kty).toBe('RSA')
    expect(typeof firstKey.kid).toBe('string')
  })

  test('(2) real JWT from /auth/token is signed with the kid published in /auth/jwks', async () => {
    const { sessionCookieHeader } = await seedUserSession(
      `id-kid-${runId}@operai.test`,
      'ID KID Check',
    )
    const jwt = await fetchJwt(sessionCookieHeader)
    const header = decodeJwtHeader(jwt)
    expect(header.alg).toBe('RS256')
    expect(header.kid.length).toBeGreaterThan(0)

    const jwksRes = await fetch(`${AUTH_ORIGIN}/auth/jwks`)
    const jwks = (await jwksRes.json()) as { keys: Array<{ kid: string }> }
    expect(jwks.keys.find((k) => k.kid === header.kid)).toBeDefined()
  })

  test('(3) user A JWT reaches estimai-api, is verified via live JWKS, and creates an estimate', async () => {
    const userA = await seedUserSession(USER_A_EMAIL, 'User A Identity')
    const jwtA = await fetchJwt(userA.sessionCookieHeader)

    const payloadA = decodeJwtPayload(jwtA)
    expect(payloadA.sub).toBe(userA.userId)
    expect(payloadA.iss).toBe(AUTH_ORIGIN)

    const createRes = await fetch(`${API_ORIGIN}/estimates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Identity JWKS Estimate',
        author: 'User A Identity',
        content: minimalContent,
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { id: string; name: string; author: string }
    expect(created.id).toBeTruthy()

    const getRes = await fetch(`${API_ORIGIN}/estimates/${created.id}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    })
    expect(getRes.status).toBe(200)
    const fetched = (await getRes.json()) as { id: string }
    expect(fetched.id).toBe(created.id)
  })

  test('(4) user A and user B receive separate estimates; B cannot read A data', async () => {
    const userA = await seedUserSession(USER_A_EMAIL, 'User A Identity')
    const userB = await seedUserSession(USER_B_EMAIL, 'User B Identity')
    const jwtA = await fetchJwt(userA.sessionCookieHeader)
    const jwtB = await fetchJwt(userB.sessionCookieHeader)

    expect(decodeJwtPayload(jwtA).sub).not.toBe(decodeJwtPayload(jwtB).sub)

    const createRes = await fetch(`${API_ORIGIN}/estimates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Private Estimate (User A)',
        author: 'User A Identity',
        content: minimalContent,
      }),
    })
    expect(createRes.status).toBe(201)
    const estimateA = (await createRes.json()) as { id: string }

    const listBRes = await fetch(`${API_ORIGIN}/estimates`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    })
    expect(listBRes.status).toBe(200)
    const listB = (await listBRes.json()) as Array<{ id: string }>
    expect(listB.some((e) => e.id === estimateA.id)).toBe(false)

    const getByBRes = await fetch(`${API_ORIGIN}/estimates/${estimateA.id}`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    })
    expect(getByBRes.status).toBe(404)
    const problem = (await getByBRes.json()) as { status: number; type: string }
    expect(problem.status).toBe(404)
    expect(problem.type).toContain('404')
  })

  test('(6) no / invalid Bearer → estimai-api returns RFC 7807 401, not HTML or 500', async () => {
    const noAuthRes = await fetch(`${API_ORIGIN}/estimates`)
    expect(noAuthRes.status).toBe(401)
    const noAuthBody = (await noAuthRes.json()) as { status: number; type: string; title: string }
    expect(noAuthBody.status).toBe(401)
    expect(noAuthBody.type).toContain('401')
    expect(typeof noAuthBody.title).toBe('string')

    const badAuthRes = await fetch(`${API_ORIGIN}/estimates`, {
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    })
    expect(badAuthRes.status).toBe(401)
    const badAuthBody = (await badAuthRes.json()) as { status: number; type: string }
    expect(badAuthBody.status).toBe(401)
    expect(badAuthBody.type).toContain('401')
  })
})

// ─── Real-backend 401 → ADR-0001 refresh-retry-redirect (browser) ───────────

test.describe('shell/session apiFetch redirects to sign-in on a real estimai-api 401', () => {
  test('(5) EstimAI in the shell with an invalid Bearer triggers the ADR-0001 redirect', async ({
    context,
    page,
  }) => {
    // Seed a valid session so the shell `_authed` guard passes and EstimAI mounts.
    await seedSession(context)

    // Intercept GET /auth/token to return a syntactically valid but invalid-
    // signature JWT that the real estimai-api rejects via live JWKS verification.
    const FAKE_JWT =
      'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2Uta2lkLXQxNCJ9' +
      '.eyJzdWIiOiJmYWtlLXN1YiIsImVtYWlsIjoiZmFrZUB0ZXN0LmNvbSIsImlzcyI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzAwMSIsImV4cCI6OTk5OTk5OTk5OX0' +
      '.' +
      'A'.repeat(342)

    await page.route(`${AUTH_ORIGIN}/auth/token`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: FAKE_JWT }),
      })
    })

    // Open EstimAI inside the shell; its list fetch goes through shell/session's
    // apiFetch → fake JWT → real estimai-api 401 → refresh → 401 → redirect.
    await page.goto('/estimai')

    await expect(page, 'apiFetch must redirect to sign-in after two real 401s').toHaveURL(
      new RegExp(`^${AUTH_ORIGIN}/sign-in`),
      { timeout: 20_000 },
    )
    const redirectParam = new URL(page.url()).searchParams.get('redirect')
    expect(redirectParam, 'sign-in redirect must carry the original URL').toBeTruthy()
  })
})
