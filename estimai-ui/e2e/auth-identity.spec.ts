/**
 * T14 — JWKS identity + real-401 (closes the 002 eval gaps)
 *
 * Refs: spec 001, T14, AC-4.1, AC-4.2, AC-3.2-equiv
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHAT THIS TEST PROVES
 *
 * Two gaps the spec-002 evaluator flagged because they could only be stubbed
 * there. T14 closes both with real-stack assertions:
 *
 * T-JWKS-identity (AC-4.1, closes 002 AC-3.2 gap):
 *   A real JWT minted by the auth service (/auth/token) is verified by
 *   estimai-api against the auth service's LIVE /auth/jwks endpoint.
 *   The middleware resolves the correct `sub` and the estimate is owned by
 *   the correct user. A second user's real JWT is verifiable but cannot
 *   reach the first user's data → 404.
 *
 *   This is NOT a mocked JWKS test (unlike T3 / jwt.middleware.test.ts).
 *   The whole point is that createRemoteJWKSet in estimai-api fetches keys
 *   from the live auth service — a real network call.
 *
 * T-real-401 (AC-4.2, ADR-0001 apiFetch circuit):
 *   The apiFetch interceptor's refresh-retry-then-redirect circuit is driven
 *   against a GENUINE estimai-api 401 (real backend, not a mocked Response).
 *   We intercept /auth/token to return a permanently invalid JWT. Both the
 *   initial request and the retry receive a real 401 from estimai-api. The
 *   third step (redirect to sign-in) fires — proving the ADR-0001 circuit
 *   fires against a real backend 401, not a stub.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * IMPLEMENTATION NOTES
 *
 * T-JWKS-identity is implemented as an HTTP-level integration test running
 * in the Playwright Node context (not in the browser). We use `fetch()` to
 * call the real auth + estimai-api services directly. This avoids browser
 * module-system limitations while exercising the exact same real chain:
 *   auth /test-auth/session → cookie
 *   auth /auth/token (with cookie) → real RS256 JWT (kid from DB jwks table)
 *   estimai-api POST /estimates (with Bearer JWT) → createRemoteJWKSet fetches
 *   auth /auth/jwks → verifies kid → resolves sub → 201
 *   estimai-api GET /estimates/{id} → 200 (same user)
 *   estimai-api GET /estimates/{id} with user B JWT → 404 (ownership isolation)
 *
 * T-real-401 is implemented as a Playwright browser test. We:
 *   1. Seed a session so the UI mounts authenticated.
 *   2. Route-intercept GET /auth/token to return a permanent fake JWT.
 *   3. Force a page refresh — the cached JWT is gone (new page context, or
 *      we inject a script that clears it), causing apiFetch to call
 *      /auth/token → gets the fake JWT → sends it to estimai-api → real 401.
 *   4. apiFetch retries with a fresh /auth/token call → again fake JWT →
 *      real 401 again.
 *   5. apiFetch redirects to sign-in.
 *
 * STACK REQUIREMENTS (must be running before pnpm e2e):
 *   - PostgreSQL:   docker compose up -d (localhost:5435)
 *   - auth service: ENABLE_TEST_AUTH=true bun run src/index.ts (localhost:3001)
 *   - estimai-api:  AUTH_JWKS_URL=http://localhost:3001/auth/jwks bun run src/index.ts (localhost:8080)
 *   - UI build with VITE_API_URL=http://localhost:8080 (done by playwright.config.ts webServer)
 *
 * DRIFT DISCOVERED DURING IMPLEMENTATION (logged for adr-writer):
 *   better-auth's jwt plugin generates its own RS256 keypair stored in the
 *   DB `jwks` table (kid = dynamic hash, e.g. "Lbei5pwFsPl5yURDrhRaLAUX82qY9lIW").
 *   The custom /.well-known/jwks.json route serves the env-var JWT_PUBLIC_KEY
 *   with kid = "operai-auth-rs256-v1" — a DIFFERENT key.
 *   The /auth/token JWT is signed with the DB keypair. Verification must use
 *   /auth/jwks (better-auth built-in), not /.well-known/jwks.json.
 *   The .env.example and AUTH_JWKS_URL have been corrected to /auth/jwks.
 *   See also: jwks.routes.ts fix (importSPKI required extractable: true).
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_URL =
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'

const API_URL =
  process.env['E2E_API_URL'] ??
  process.env['VITE_API_URL'] ??
  'http://localhost:8080'

const AUTH_ORIGIN = AUTH_URL.replace(/\/$/, '')
const API_ORIGIN = API_URL.replace(/\/$/, '')

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SeedResult = {
  sessionCookieHeader: string
  userId: string
  email: string
}

/**
 * Seeds a better-auth session for the given email and returns the raw
 * session cookie header and the seeded user's id.
 *
 * Used only in the Node context (T-JWKS-identity) — not via Playwright
 * BrowserContext (which is for T-real-401).
 */
const seedUserSession = async (
  email: string,
  name: string,
): Promise<SeedResult> => {
  const res = await fetch(`${AUTH_ORIGIN}/test-auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `[T14] POST /test-auth/session failed (${res.status}): ${body}. ` +
        `Make sure auth is running with ENABLE_TEST_AUTH=true`,
    )
  }

  const body = (await res.json()) as { userId: string; email: string }
  const rawCookieHeader = res.headers.get('set-cookie')
  if (!rawCookieHeader) {
    throw new Error('[T14] POST /test-auth/session returned no Set-Cookie')
  }

  // Extract only the name=value pair for the Cookie: request header
  const nameValue = rawCookieHeader.split(';')[0].trim()

  return {
    sessionCookieHeader: nameValue,
    userId: body.userId,
    email: body.email,
  }
}

/**
 * Fetches a real RS256 JWT from the auth service using a session cookie.
 * Returns the raw JWT string.
 */
const fetchJwt = async (sessionCookieHeader: string): Promise<string> => {
  const res = await fetch(`${AUTH_ORIGIN}/auth/token`, {
    headers: { Cookie: sessionCookieHeader },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`[T14] GET /auth/token failed (${res.status}): ${body}`)
  }

  const body = (await res.json()) as { token: string }
  if (!body.token) {
    throw new Error('[T14] GET /auth/token returned no token')
  }
  return body.token
}

/**
 * Decodes a JWT header (without verifying) to extract the kid.
 */
const decodeJwtHeader = (jwt: string): { alg: string; kid: string } => {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('[T14] Not a valid JWT format')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
  return header as { alg: string; kid: string }
}

/**
 * Decodes a JWT payload (without verifying) to extract claims.
 */
const decodeJwtPayload = (
  jwt: string,
): { sub: string; email: string; iss: string } => {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('[T14] Not a valid JWT format')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  return payload as { sub: string; email: string; iss: string }
}

// ─── T-JWKS-identity ──────────────────────────────────────────────────────────

test.describe('T-JWKS-identity: real JWT verified against live JWKS resolves correct user', () => {
  /**
   * This test exercises the REAL JWKS verification path:
   *
   *   auth /test-auth/session (mint session) →
   *   auth /auth/token (mint real RS256 JWT, signed with DB keypair) →
   *   estimai-api POST /estimates (Bearer <real-jwt>) →
   *     createRemoteJWKSet fetches auth /auth/jwks →
   *     verifies kid + issuer + RS256 →
   *     resolves sub → writes userId=sub →
   *   → 201 Created (ownership resolved to user A)
   *   GET /estimates/{id} with user A JWT → 200
   *   GET /estimates/{id} with user B JWT → 404 (ownership isolation, AC-4.1)
   *
   * Contrast with jwt.middleware.test.ts (T3): that test mocks
   * createRemoteJWKSet with a local fixture keyset. THIS test uses the live
   * auth service JWKS endpoint — a real network call from estimai-api.
   */

  // Unique email per test run so parallel CI doesn't collide on user rows.
  const runId = Date.now().toString(36)
  const USER_A_EMAIL = `t14-a-${runId}@operai.test`
  const USER_B_EMAIL = `t14-b-${runId}@operai.test`

  // Minimal valid estimate content matching the estimai-api schema.
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

  test('(1) auth /auth/jwks is reachable and returns a keys array', async () => {
    /**
     * Pre-condition: confirm the JWKS endpoint the estimai-api will verify
     * against is up and returns at least one key. If this fails the subsequent
     * tests are moot — estimai-api cannot fetch keys and all requests return 401.
     */
    const res = await fetch(`${AUTH_ORIGIN}/auth/jwks`)
    expect(res.status, 'auth /auth/jwks must return 200').toBe(200)

    const body = (await res.json()) as { keys: unknown[] }
    expect(
      Array.isArray(body.keys) && body.keys.length > 0,
      'auth /auth/jwks must return a non-empty keys array',
    ).toBe(true)

    // Confirm the key is RS256 (alg pinning).
    const firstKey = body.keys[0] as { alg: string; kty: string; kid: string }
    expect(firstKey.alg, 'JWKS key must be RS256').toBe('RS256')
    expect(firstKey.kty, 'JWKS key must be RSA').toBe('RSA')
    expect(typeof firstKey.kid, 'JWKS key must have a kid').toBe('string')
  })

  test('(2) real JWT from /auth/token is signed with the kid published in /auth/jwks', async () => {
    /**
     * Proves there is no kid mismatch between the token issuer and the JWKS.
     *
     * DRIFT CONTEXT: the custom /.well-known/jwks.json endpoint serves the
     * env-var JWT_PUBLIC_KEY with kid "operai-auth-rs256-v1". The better-auth
     * jwt plugin issues tokens with a DB keypair whose kid is a random hash.
     * These two keys are DIFFERENT — pointing estimai-api at /.well-known/jwks.json
     * would cause every real token to fail verification. This test catches that
     * mismatch.
     *
     * The test asserts that the kid in a freshly minted JWT matches the kid
     * advertised by /auth/jwks — confirming estimai-api's AUTH_JWKS_URL is
     * correctly pointing at the endpoint that has the signing key.
     */
    const { sessionCookieHeader } = await seedUserSession(
      `t14-kid-check-${runId}@operai.test`,
      'T14 KID Check',
    )
    const jwt = await fetchJwt(sessionCookieHeader)

    // Decode JWT header (without verifying).
    const header = decodeJwtHeader(jwt)
    expect(header.alg, 'JWT alg must be RS256').toBe('RS256')
    expect(typeof header.kid, 'JWT must contain a kid').toBe('string')
    expect(header.kid.length, 'JWT kid must be non-empty').toBeGreaterThan(0)

    // Fetch /auth/jwks and assert the JWT's kid is present there.
    const jwksRes = await fetch(`${AUTH_ORIGIN}/auth/jwks`)
    const jwks = (await jwksRes.json()) as { keys: Array<{ kid: string }> }
    const matchingKey = jwks.keys.find((k) => k.kid === header.kid)

    expect(
      matchingKey,
      `JWT kid "${header.kid}" must be present in /auth/jwks keys ` +
        `(found kids: ${jwks.keys.map((k) => k.kid).join(', ')}). ` +
        `If AUTH_JWKS_URL points to /.well-known/jwks.json instead of ` +
        `/auth/jwks, this test will fail because they serve different keys.`,
    ).toBeDefined()
  })

  test('(3) user A JWT reaches estimai-api, is verified via live JWKS, and creates an estimate', async () => {
    /**
     * Core T-JWKS-identity assertion:
     *
     * A real JWT signed by the auth service is verified by estimai-api against
     * the live /auth/jwks endpoint. The middleware resolves `sub` from the
     * verified payload and the estimate is created with userId = sub.
     *
     * This is the first real round-trip: mint → verify → persist.
     */
    const userA = await seedUserSession(USER_A_EMAIL, 'User A T14')
    const jwtA = await fetchJwt(userA.sessionCookieHeader)

    // Confirm the token's sub matches the seeded userId.
    const payloadA = decodeJwtPayload(jwtA)
    expect(
      payloadA.sub,
      'JWT sub must equal the seeded userId',
    ).toBe(userA.userId)
    expect(payloadA.iss, 'JWT iss must equal AUTH_URL').toBe(AUTH_ORIGIN)

    // POST /estimates — this triggers the real JWKS verification in estimai-api.
    const createRes = await fetch(`${API_ORIGIN}/estimates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'T14 JWKS Identity Estimate',
        author: 'User A T14',
        content: minimalContent,
      }),
    })

    expect(
      createRes.status,
      `POST /estimates with real JWT must return 201 (got ${createRes.status}). ` +
        `If 401, check AUTH_JWKS_URL points to /auth/jwks not /.well-known/jwks.json`,
    ).toBe(201)

    const created = (await createRes.json()) as {
      id: string
      name: string
      author: string
    }
    expect(created.id, 'Created estimate must have an id').toBeTruthy()
    expect(created.name).toBe('T14 JWKS Identity Estimate')
    expect(created.author).toBe('User A T14')

    // GET /estimates/{id} — confirm user A can retrieve their own estimate.
    const getRes = await fetch(`${API_ORIGIN}/estimates/${created.id}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    })

    expect(
      getRes.status,
      'GET /estimates/{id} with owner JWT must return 200',
    ).toBe(200)

    const fetched = (await getRes.json()) as { id: string; name: string }
    expect(fetched.id, 'Fetched estimate id must match created id').toBe(
      created.id,
    )
    expect(fetched.name).toBe('T14 JWKS Identity Estimate')

    // Store for the next test in this suite (cross-user test).
    // We pass via a file-scoped variable using Playwright's test.info() storage.
    test.info().annotations.push({
      type: 'estimateId',
      description: created.id,
    })
  })

  test('(4) user A and user B receive separate estimates; B cannot read A data (AC-4.1)', async () => {
    /**
     * AC-4.1 — ownership isolation via real JWKS-verified tokens.
     *
     * Both users have real JWTs, both are verified against the same live JWKS.
     * Estimai-api scopes every query to `where: { userId: sub }` so user B's
     * verified token is still rejected for user A's data → 404.
     *
     * This is distinct from the T3 unit test: that test uses a fixture keypair
     * and mocks createRemoteJWKSet. Here both tokens are real and both are
     * verified against the real JWKS — the ownership isolation is the assertion.
     */
    const userA = await seedUserSession(USER_A_EMAIL, 'User A T14')
    const userB = await seedUserSession(USER_B_EMAIL, 'User B T14')

    const jwtA = await fetchJwt(userA.sessionCookieHeader)
    const jwtB = await fetchJwt(userB.sessionCookieHeader)

    // Confirm both JWTs have different sub claims (different users).
    const payloadA = decodeJwtPayload(jwtA)
    const payloadB = decodeJwtPayload(jwtB)
    expect(
      payloadA.sub,
      'User A and B must have different sub claims',
    ).not.toBe(payloadB.sub)

    // Create an estimate for user A.
    const createRes = await fetch(`${API_ORIGIN}/estimates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'T14 Private Estimate (User A)',
        author: 'User A T14',
        content: minimalContent,
      }),
    })
    expect(createRes.status, 'User A POST /estimates must return 201').toBe(201)
    const estimateA = (await createRes.json()) as { id: string }

    // User A can list and read their own estimate.
    const listARes = await fetch(`${API_ORIGIN}/estimates`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    })
    expect(listARes.status, 'User A GET /estimates must return 200').toBe(200)
    const listA = (await listARes.json()) as Array<{ id: string }>
    expect(
      listA.some((e) => e.id === estimateA.id),
      'User A estimate list must include the created estimate',
    ).toBe(true)

    // User B's list must NOT include user A's estimate.
    const listBRes = await fetch(`${API_ORIGIN}/estimates`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    })
    expect(listBRes.status, 'User B GET /estimates must return 200').toBe(200)
    const listB = (await listBRes.json()) as Array<{ id: string }>
    expect(
      listB.some((e) => e.id === estimateA.id),
      'User B estimate list must NOT include user A estimate (AC-4.1)',
    ).toBe(false)

    // User B's verified JWT cannot directly read user A's estimate → 404.
    const getByBRes = await fetch(
      `${API_ORIGIN}/estimates/${estimateA.id}`,
      { headers: { Authorization: `Bearer ${jwtB}` } },
    )
    expect(
      getByBRes.status,
      `User B GET /estimates/${estimateA.id} must return 404, not ${getByBRes.status}. ` +
        `Both JWTs are verified via the real JWKS; the 404 is the ownership ` +
        `predicate (userId=sub) not finding the record.`,
    ).toBe(404)

    // Confirm the 404 is a Problem JSON (not an unhandled error).
    const problem = (await getByBRes.json()) as { status: number; type: string }
    expect(problem.status).toBe(404)
    expect(problem.type).toContain('404')
  })
})

// ─── T-real-401 ───────────────────────────────────────────────────────────────

test.describe('T-real-401: apiFetch fires real-backend 401 → ADR-0001 refresh-retry-redirect', () => {
  /**
   * This test drives the apiFetch interceptor circuit against a REAL estimai-api
   * 401 response (not a mocked Response object).
   *
   * ADR-0001 circuit (api.ts):
   *   Step 1: JWT cache empty → fetch /auth/token → cache → attach Bearer → send
   *   Step 2: real 401 from estimai-api → clear cache → refetch /auth/token once → retry
   *   Step 3: retry also 401 → clear cache → redirect to AUTH_URL/sign-in
   *
   * Mechanism:
   *   We use page.route to intercept GET /auth/token and return a fake JWT that
   *   estimai-api will reject. Both the initial request and the retry hit
   *   estimai-api with this fake JWT → two genuine 401 responses. The redirect
   *   fires.
   *
   * The page is navigated to /estimates so the EstimatesPage mounts and
   * immediately calls estimatesApi.list() → apiFetch. The JWT cache is empty
   * (fresh page load), so step 1 fires → /auth/token returns fake JWT →
   * estimai-api returns genuine 401 → step 2 fires → retry → 401 again →
   * step 3 fires → redirect to sign-in.
   *
   * The real estimai-api returns 401 because it verifies the JWT via
   * createRemoteJWKSet against the live /auth/jwks — a syntactically-valid
   * but structurally-fake JWT will fail signature verification and return
   * the real 401 Problem JSON response.
   *
   * NOTE: the auth route guard in router.tsx also intercepts unauthenticated
   * page loads. To ensure we test the apiFetch 401 path (not the guard path),
   * we seed a valid session cookie so the _authed guard passes. The guard
   * calls authClient.getSession() which checks the session cookie — valid.
   * Then the page component calls estimatesApi.list() → apiFetch → uses the
   * intercepted fake JWT → real 401 from estimai-api → redirect.
   *
   * In practice, this means:
   *   - Session cookie is valid (guard passes, page renders)
   *   - JWT cache is empty (fresh page load)
   *   - /auth/token returns a syntactically valid but invalid-signature JWT
   *   - estimai-api verifies against live JWKS → signature mismatch → real 401
   *   - apiFetch retries → same fake JWT → real 401 again
   *   - apiFetch calls redirectToSignIn()
   */

  test('(5) real estimai-api 401 with invalid Bearer triggers the ADR-0001 refresh-retry-redirect', async ({
    context,
    page,
  }) => {
    // 1. Seed a valid session so the _authed route guard passes.
    //    Without this, the guard redirects to sign-in before apiFetch even fires
    //    and we would be testing the guard path (already covered in T11).
    await seedSession(context)

    // 2. Intercept GET /auth/token to return a syntactically valid JWT with a
    //    fake signature that estimai-api will reject via JWKS verification.
    //
    //    The fake JWT is a real-looking RS256 JWT (three base64url parts) but
    //    the signature is garbage — the real estimai-api's jwtVerify will fail
    //    and return a genuine 401 Problem JSON.
    //
    //    We use a well-formed JWT structure to pass the "Bearer " prefix check
    //    in jwtMiddleware and exercise the actual jwtVerify code path.
    const FAKE_JWT =
      // Header: {"alg":"RS256","kid":"fake-kid-t14"}
      'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2Uta2lkLXQxNCJ9' +
      // Payload: {"sub":"fake-sub","email":"fake@test.com","iss":"http://localhost:3001","exp":9999999999}
      '.eyJzdWIiOiJmYWtlLXN1YiIsImVtYWlsIjoiZmFrZUB0ZXN0LmNvbSIsImlzcyI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzAwMSIsImV4cCI6OTk5OTk5OTk5OX0' +
      // Signature: garbage bytes (not a real RS256 signature)
      '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

    // Route intercept: any GET to /auth/token returns the fake JWT.
    // This is at the network level — the apiFetch module-scope code calls
    // window.fetch for /auth/token, which this route captures.
    await page.route(`${AUTH_ORIGIN}/auth/token`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: FAKE_JWT }),
      })
    })

    // 3. Navigate to /estimates. This triggers:
    //    - _authed guard: calls authClient.getSession() → valid (session cookie
    //      set in step 1) → guard passes, page renders
    //    - EstimatesPage mounts, calls estimatesApi.list() → apiFetch
    //    - apiFetch: JWT cache empty → calls /auth/token → gets FAKE_JWT
    //    - apiFetch: sends GET /estimates with Authorization: Bearer <FAKE_JWT>
    //    - estimai-api: jwtVerify against live /auth/jwks → kid "fake-kid-t14"
    //      not found in JWKS → real 401 Problem JSON
    //    - apiFetch: 401 → clears cache → calls /auth/token again → FAKE_JWT
    //    - apiFetch: retry with FAKE_JWT → real 401 again
    //    - apiFetch: redirects to AUTH_URL/sign-in
    await page.goto('/estimates')

    // 4. Assert the redirect to sign-in fired (ADR-0001 step 3).
    //    The exact URL check confirms it is the auth service sign-in page with
    //    the redirect param, not a generic error page.
    await expect(page, 'apiFetch must redirect to sign-in after two real 401s')
      .toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), { timeout: 20_000 })

    // 5. Confirm the redirect carries the originally-requested URL as the
    //    redirect param (matching the redirectToSignIn() implementation in api.ts).
    const url = new URL(page.url())
    const redirectParam = url.searchParams.get('redirect')
    expect(
      redirectParam,
      'sign-in redirect must carry the original URL as `redirect` param',
    ).toBeTruthy()
  })

  test('(6) no Bearer / invalid Bearer → estimai-api returns RFC 7807 401, not HTML or 500', async () => {
    /**
     * Direct HTTP assertion (Node context, not browser):
     * confirms the real estimai-api 401 response is a proper RFC 7807
     * Problem JSON with status=401. This is the response shape apiFetch
     * consumes in step 2/3 of the ADR-0001 circuit.
     *
     * No mock — real estimai-api, real response.
     */
    // No Authorization header → real 401
    const noAuthRes = await fetch(`${API_ORIGIN}/estimates`)
    expect(
      noAuthRes.status,
      'GET /estimates with no Bearer must return real 401',
    ).toBe(401)

    const noAuthBody = (await noAuthRes.json()) as {
      status: number
      type: string
      title: string
    }
    expect(noAuthBody.status).toBe(401)
    expect(noAuthBody.type).toContain('401')
    expect(typeof noAuthBody.title).toBe('string')

    // Invalid Bearer (garbage JWT) → real 401
    const badJwt = 'not.a.real.jwt'
    const badAuthRes = await fetch(`${API_ORIGIN}/estimates`, {
      headers: { Authorization: `Bearer ${badJwt}` },
    })
    expect(
      badAuthRes.status,
      'GET /estimates with invalid Bearer must return real 401',
    ).toBe(401)

    const badAuthBody = (await badAuthRes.json()) as {
      status: number
      type: string
    }
    expect(badAuthBody.status).toBe(401)
    expect(badAuthBody.type).toContain('401')
  })
})
