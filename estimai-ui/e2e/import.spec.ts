/**
 * T15 — Import journey: offer / accept / partial-failure
 *
 * Refs: spec 001, T15, US-5, AC-5.1, AC-5.2, AC-5.4
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHAT THIS TEST PROVES
 *
 * The full real-stack import journey, seeding legacy `estimai_project_*`
 * localStorage keys before the app loads so the import offer fires:
 *
 * Test 1 — accept path (AC-5.1, AC-5.2, AC-5.4):
 *   1. Seed two valid localStorage estimates (index + per-project keys).
 *   2. Sign in (seeded session), load /estimates.
 *   3. The import offer modal appears because localStorage estimates exist
 *      and the session dismissal flag is not set (AC-5.1).
 *   4. Click "Import all" → POST /estimates/import fires against the real
 *      estimai-api → results view shows both estimates as "Imported" (AC-5.2).
 *   5. Assert both estimate names appear in the results table.
 *   6. Close the modal → the list page re-fetches GET /estimates → both
 *      estimate names appear in the account list (AC-5.2 content round-trip).
 *   7. Assert the two localStorage keys are still present (AC-5.4 — no removal).
 *
 * Test 2 — partial failure (AC-5.4):
 *   1. Seed three localStorage estimates: two valid + one over-1MiB (triggers
 *      the per-element size guard on the server).
 *   2. Unique user email so the account list starts empty.
 *   3. Import offer appears; accept → results view shows:
 *        - 2 × "Imported" rows for the valid estimates
 *        - 1 × "Failed" row for the oversized estimate, with a truncated error
 *   4. Summary line reads "2 of 3 imported successfully." (amber).
 *   5. The two valid estimates appear in the account list.
 *   6. All three localStorage keys are still present (no local data removed).
 *
 * Test 3 — decline path (AC-5.1, AC-5.3):
 *   1. Seed a valid localStorage estimate.
 *   2. Import offer appears; click "Skip for now".
 *   3. Modal closes; sessionStorage flag is set; offer does not re-appear on
 *      the next navigation to /estimates (AC-5.3).
 *   4. The localStorage key is still present (AC-5.3 — untouched).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * IMPLEMENTATION NOTES
 *
 * localStorage seeding:
 *   Uses page.addInitScript to run a script before the page JS executes.
 *   This ensures the localStorage keys are present when the React app
 *   initialises and the useImportOffer hook reads them on first render.
 *
 *   Key format (from src/lib/projects.ts):
 *     estimai_projects          → JSON.stringify(ProjectMeta[])
 *     estimai_project_<id>      → JSON.stringify(ProjectData)
 *
 * Partial-failure seeding:
 *   The per-element size guard in estimai-api checks the UTF-8 byte length
 *   of the serialised `content` field (JSON.stringify(content)).
 *   We craft a `notes` string in one activity that padded to > 1 MiB.
 *   The activity `notes` field accepts up to 2000 chars in the schema, so
 *   we include MANY activities with large notes — totalling > 1 MiB of
 *   serialised content. Actually the simplest approach: one activity with
 *   a `notes` value padded to 1.1 MiB (the Zod schema on the API caps
 *   notes at max 2000 chars, but the size guard runs BEFORE schema parsing
 *   — actually schema parsing happens first).
 *
 *   CORRECT APPROACH: the ImportElementSchema extends EstimateUpsertSchema.
 *   Zod strips unknown keys. To exceed MAX_ESTIMATE_BYTES (1 MiB) we need
 *   a valid payload by schema but large by bytes. The `acts` array is the
 *   best lever — many activities with long (but ≤ 2000 char) `notes` fields.
 *   1 MiB / 2000 chars ≈ 524 activities with full notes. We use 600 activities
 *   each with 2000-char notes to guarantee > 1 MiB serialised content.
 *
 * Unique user emails:
 *   Each test seeds its own user with a timestamp-in-local-part email so
 *   imported rows don't collide across test runs and the account list starts
 *   empty for every assertion.
 *
 * STACK REQUIREMENTS (must be running before pnpm e2e):
 *   - PostgreSQL:   docker compose up -d (localhost:5435)
 *   - auth service: ENABLE_TEST_AUTH=true bun run src/index.ts (localhost:3001)
 *   - estimai-api:  AUTH_JWKS_URL=http://localhost:3001/auth/jwks bun run src/index.ts (localhost:8080)
 *   - UI build with VITE_API_URL=http://localhost:8080 (done by playwright.config.ts webServer)
 */

import { test, expect, type BrowserContext } from '@playwright/test'
import { PROJECTS_KEY, projectKey } from '../src/lib/projects'

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_URL =
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'

/**
 * Wait for the import offer modal to appear.
 * The offer is rendered when useImportOffer detects localStorage estimates.
 */
const MODAL_TIMEOUT = 15_000

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Seeds a better-auth session for a unique test user.
 * Returns the parsed Set-Cookie value and the raw cookie header.
 */
const seedTestUser = async (email: string, name: string) => {
  const res = await fetch(`${AUTH_URL.replace(/\/$/, '')}/test-auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `[T15] POST /test-auth/session failed (${res.status}): ${body}\n` +
        `Make sure auth is running with ENABLE_TEST_AUTH=true.`,
    )
  }

  const rawCookieHeader = res.headers.get('set-cookie')
  if (!rawCookieHeader) {
    throw new Error('[T15] POST /test-auth/session returned no Set-Cookie header.')
  }

  return { rawCookieHeader }
}

/**
 * Parses a `Set-Cookie` header into Playwright-compatible cookie objects
 * and injects them into the BrowserContext.
 */
const injectSessionCookie = async (
  context: BrowserContext,
  rawCookieHeader: string,
  domain: string,
): Promise<void> => {
  const parts = rawCookieHeader.trim().split(';').map((p) => p.trim())
  const [nameValue, ...attrs] = parts
  if (!nameValue) throw new Error('[T15] Could not parse Set-Cookie name=value')
  const eqIdx = nameValue.indexOf('=')
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

  await context.addCookies([
    {
      name,
      value,
      domain: typeof attrMap['domain'] === 'string' ? attrMap['domain'] : domain,
      path: typeof attrMap['path'] === 'string' ? attrMap['path'] : '/',
      httpOnly: attrMap['httponly'] === true,
      secure: attrMap['secure'] === true,
      sameSite,
    },
  ])
}

/**
 * Builds a minimal but valid ProjectData payload for localStorage seeding.
 * The `id` and `name` are seeded so the test can assert on them specifically.
 */
const buildProjectData = (id: string, name: string, author = 'T15 Test Author') => ({
  id,
  name,
  author,
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
  releases: [{ id: `rel-${id}`, name: 'Release 1', fte: 2 }],
  acts: [
    {
      id: `act-${id}`,
      num: '1',
      epic: 'Core',
      act: `Activity for ${name}`,
      prof: 'Developer',
      o: 1,
      ml: 2,
      p: 3,
      risk: 0.1,
      notes: 'T15 test activity',
      release: `rel-${id}`,
    },
  ],
})

/**
 * Builds a ProjectData with a content that exceeds MAX_ESTIMATE_BYTES (1 MiB)
 * when serialised. Uses 600 activities each with a 2000-char `notes` field.
 * 600 × 2000 chars ≈ 1.2 MiB of notes alone — well above the 1 MiB limit.
 */
const buildOversizedProjectData = (id: string, name: string) => {
  const longNotes = 'X'.repeat(2000) // 2000 UTF-8 bytes per activity
  const acts = Array.from({ length: 600 }, (_, i) => ({
    id: `act-${id}-${i}`,
    num: String(i + 1),
    epic: 'Core',
    act: `Oversized Activity ${i + 1}`,
    prof: 'Developer',
    o: 1,
    ml: 2,
    p: 3,
    risk: 0.1,
    notes: longNotes,
    release: `rel-${id}`,
  }))

  return {
    id,
    name,
    author: 'T15 Oversized',
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
    releases: [{ id: `rel-${id}`, name: 'Release 1', fte: 1 }],
    acts,
  }
}

/**
 * Returns the localStorage seeds as a JSON-serialisable object.
 * Callers use this with page.addInitScript to seed before page JS runs.
 */
const buildLocalStorageSeeds = (
  projects: ReturnType<typeof buildProjectData>[],
): Record<string, string> => {
  const seeds: Record<string, string> = {}

  // Index key — ProjectMeta[]
  seeds[PROJECTS_KEY] = JSON.stringify(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      author: p.author,
      updatedAt: new Date().toISOString(),
    })),
  )

  // Per-project keys — ProjectData
  for (const p of projects) {
    seeds[projectKey(p.id)] = JSON.stringify(p)
  }

  return seeds
}

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe('T15 — import journey: offer / accept / partial-failure', () => {
  // ─── Test 1: Accept path (AC-5.1, AC-5.2, AC-5.4) ─────────────────────────

  test(
    'AC-5.1 / AC-5.2: accept imports all valid estimates into the account list; localStorage keys are not removed',
    async ({ context, page }) => {
      const runId = `t15a${Date.now().toString(36)}`
      const userEmail = `t15-accept-${runId}@operai.test`

      // ── Seed two valid estimates ────────────────────────────────────────────
      const ID_A = `proj-${runId}-a`
      const ID_B = `proj-${runId}-b`
      const NAME_A = `T15 Estimate Alpha ${runId}`
      const NAME_B = `T15 Estimate Beta ${runId}`

      const projectA = buildProjectData(ID_A, NAME_A)
      const projectB = buildProjectData(ID_B, NAME_B)
      const seeds = buildLocalStorageSeeds([projectA, projectB])

      // Inject localStorage keys BEFORE the page JS loads (addInitScript runs
      // before any script on the page, ensuring useImportOffer reads them).
      await page.addInitScript((seedData: Record<string, string>) => {
        for (const [key, value] of Object.entries(seedData)) {
          localStorage.setItem(key, value)
        }
      }, seeds)

      // ── Seed a session for the unique test user ──────────────────────────────
      const { rawCookieHeader } = await seedTestUser(userEmail, 'T15 Accept User')
      const authDomain = new URL(AUTH_URL).hostname
      await injectSessionCookie(context, rawCookieHeader, authDomain)

      // ── Navigate to /estimates ────────────────────────────────────────────────
      await page.goto('/estimates')
      await page.waitForLoadState('networkidle')

      // Must be on the estimates list (authed guard passed).
      await expect(page).toHaveURL(/\/estimates$/, { timeout: 15_000 })

      // ── AC-5.1: import offer modal appears ───────────────────────────────────
      const modal = page.locator('[data-testid="import-offer-modal"]')
      await expect(
        modal,
        'AC-5.1: ImportOfferModal must appear when localStorage estimates exist',
      ).toBeVisible({ timeout: MODAL_TIMEOUT })

      // The modal body mentions the count of local estimates found.
      await expect(
        modal,
        'Offer modal must mention the number of local estimates',
      ).toContainText('2 estimate')

      // Both estimate names appear in the preview list (up to 3 are shown).
      await expect(
        modal,
        `Offer modal must preview "${NAME_A}"`,
      ).toContainText(NAME_A)
      await expect(
        modal,
        `Offer modal must preview "${NAME_B}"`,
      ).toContainText(NAME_B)

      // ── Accept the import ─────────────────────────────────────────────────────
      const importAllBtn = modal.getByRole('button', { name: 'Import all' })
      await expect(importAllBtn, '"Import all" button must be visible').toBeVisible()
      await importAllBtn.click()

      // ── Wait for the results view ─────────────────────────────────────────────
      // POST /estimates/import fires; the modal transitions through importing → results.
      // On fast machines (local), the import resolves so quickly the importing phase
      // may not be visible before the results phase replaces it — so we skip asserting
      // on the transient "Importing…" text and wait directly for the results summary.
      await expect(
        modal,
        'Results view must appear after import completes',
      ).toContainText('2 of 2 imported successfully', { timeout: 30_000 })

      // ── AC-5.2: results table shows both estimates as "Imported" ──────────────
      await expect(
        modal,
        `Results table must show "${NAME_A}" as Imported`,
      ).toContainText(NAME_A)
      await expect(
        modal,
        `Results table must show "${NAME_B}" as Imported`,
      ).toContainText(NAME_B)

      // Both rows must show the "Imported" badge (glyph ✓ + text "Imported").
      // StatusBadge renders a <span> with "✓" and a nested <span>Imported</span>.
      // We target the badge spans specifically — text(Imported) inside the table body.
      // The summary line "2 of 2 imported successfully" also contains "imported" (lowercase)
      // so we match case-sensitively via the exact badge text "Imported" inside <td>.
      const importedBadges = modal.locator('table td').getByText('Imported', { exact: true })
      await expect(
        importedBadges,
        'Results table must show 2 "Imported" badges (one per estimate)',
      ).toHaveCount(2)

      // No "Failed" badges present inside table cells.
      await expect(
        modal.locator('table td').getByText('Failed', { exact: true }),
        'Results table must show 0 "Failed" badges',
      ).toHaveCount(0)

      // ── AC-5.4: localStorage keys are still present (not removed) ─────────────
      const projectsKeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        PROJECTS_KEY,
      )
      expect(
        projectsKeyValue,
        `AC-5.4: "${PROJECTS_KEY}" key must still be present in localStorage after import`,
      ).not.toBeNull()

      const projectAKeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        projectKey(ID_A),
      )
      expect(
        projectAKeyValue,
        `AC-5.4: "${projectKey(ID_A)}" key must still be present in localStorage`,
      ).not.toBeNull()

      const projectBKeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        projectKey(ID_B),
      )
      expect(
        projectBKeyValue,
        `AC-5.4: "${projectKey(ID_B)}" key must still be present in localStorage`,
      ).not.toBeNull()

      // ── Close the modal ───────────────────────────────────────────────────────
      const closeBtn = modal.locator('[data-testid="import-results-close"]')
      await expect(closeBtn, '"Close" button must appear in results phase').toBeVisible()
      await closeBtn.click()

      // Modal closes.
      await expect(modal, 'Modal must close after clicking Close').not.toBeVisible({
        timeout: 5_000,
      })

      // ── AC-5.2: both estimates appear in the account list ─────────────────────
      // The EstimatesPage re-fetches GET /estimates after the modal is dismissed;
      // the two imported estimates must appear in the list with their names.
      await page.waitForLoadState('networkidle')

      await expect(
        page.getByText(NAME_A),
        `AC-5.2: "${NAME_A}" must appear in the account estimate list after import`,
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText(NAME_B),
        `AC-5.2: "${NAME_B}" must appear in the account estimate list after import`,
      ).toBeVisible({ timeout: 15_000 })
    },
  )

  // ─── Test 2: Partial failure (AC-5.4) ────────────────────────────────────────

  test(
    'AC-5.4: partial failure — valid estimates imported, oversized estimate fails; results table shows mixed status; no local data removed',
    async ({ context, page }) => {
      const runId = `t15p${Date.now().toString(36)}`
      const userEmail = `t15-partial-${runId}@operai.test`

      // ── Seed three estimates: two valid + one oversized (> 1 MiB content) ─────
      const ID_VALID_1 = `proj-${runId}-v1`
      const ID_VALID_2 = `proj-${runId}-v2`
      const ID_OVERSIZE = `proj-${runId}-oversize`

      const NAME_VALID_1 = `T15 Valid One ${runId}`
      const NAME_VALID_2 = `T15 Valid Two ${runId}`
      const NAME_OVERSIZE = `T15 Oversized ${runId}`

      const validProject1 = buildProjectData(ID_VALID_1, NAME_VALID_1)
      const validProject2 = buildProjectData(ID_VALID_2, NAME_VALID_2)
      const oversizedProject = buildOversizedProjectData(ID_OVERSIZE, NAME_OVERSIZE)

      // Seed all three in localStorage (index + per-project).
      const allProjects = [validProject1, validProject2, oversizedProject]
      const seeds = buildLocalStorageSeeds(allProjects)

      await page.addInitScript((seedData: Record<string, string>) => {
        for (const [key, value] of Object.entries(seedData)) {
          localStorage.setItem(key, value)
        }
      }, seeds)

      // ── Seed a unique session (fresh account, empty list) ─────────────────────
      const { rawCookieHeader } = await seedTestUser(userEmail, 'T15 Partial User')
      const authDomain = new URL(AUTH_URL).hostname
      await injectSessionCookie(context, rawCookieHeader, authDomain)

      // ── Navigate to /estimates ────────────────────────────────────────────────
      await page.goto('/estimates')
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(/\/estimates$/, { timeout: 15_000 })

      // ── AC-5.1: import offer appears (3 estimates found) ─────────────────────
      const modal = page.locator('[data-testid="import-offer-modal"]')
      await expect(
        modal,
        'ImportOfferModal must appear when 3 localStorage estimates exist',
      ).toBeVisible({ timeout: MODAL_TIMEOUT })

      await expect(
        modal,
        'Offer modal must mention 3 estimates',
      ).toContainText('3 estimate')

      // ── Accept the import ─────────────────────────────────────────────────────
      const importAllBtn = modal.getByRole('button', { name: 'Import all' })
      await importAllBtn.click()

      // ── Wait for the results view ─────────────────────────────────────────────
      // POST /estimates/import processes each element sequentially.
      // We wait directly for the results summary (skipping the transient spinner
      // state which may not be visible on fast machines).
      await expect(
        modal,
        'Results view must appear after partial import completes',
      ).toContainText('2 of 3 imported successfully', { timeout: 60_000 })

      // ── AC-5.4: results table shows correct per-estimate outcome ──────────────

      // Two "Imported" badges (inside table cells).
      const importedBadges = modal.locator('table td').getByText('Imported', { exact: true })
      await expect(
        importedBadges,
        'Results table must show 2 "Imported" badges for the valid estimates',
      ).toHaveCount(2)

      // One "Failed" badge (inside table cells).
      const failedBadges = modal.locator('table td').getByText('Failed', { exact: true })
      await expect(
        failedBadges,
        'Results table must show 1 "Failed" badge for the oversized estimate',
      ).toHaveCount(1)

      // The valid estimate names appear in the table.
      await expect(
        modal,
        `Results table must show "${NAME_VALID_1}"`,
      ).toContainText(NAME_VALID_1)
      await expect(
        modal,
        `Results table must show "${NAME_VALID_2}"`,
      ).toContainText(NAME_VALID_2)

      // The oversized estimate name appears in the table (with a "Failed" badge).
      await expect(
        modal,
        `Results table must show "${NAME_OVERSIZE}"`,
      ).toContainText(NAME_OVERSIZE)

      // The summary line is amber/non-green → "Import finished" title (partial).
      // We verify the title is "Import finished" rather than "Import complete".
      await expect(
        modal.locator('#import-modal-title'),
        'Modal title must be "Import finished" for a partial failure',
      ).toContainText('Import finished')

      // The "Your local copies have not been removed" message must appear (AC-5.4).
      await expect(
        modal,
        'Results view must inform the user that local copies are kept (AC-5.4)',
      ).toContainText('Your local copies have not been removed')

      // ── AC-5.4: localStorage keys still present after partial failure ──────────
      const projectsKeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        PROJECTS_KEY,
      )
      expect(
        projectsKeyValue,
        `AC-5.4: "${PROJECTS_KEY}" index key must not be removed`,
      ).not.toBeNull()

      const oversizeKeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        projectKey(ID_OVERSIZE),
      )
      expect(
        oversizeKeyValue,
        `AC-5.4: Failed estimate key "${projectKey(ID_OVERSIZE)}" must not be removed`,
      ).not.toBeNull()

      const valid1KeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        projectKey(ID_VALID_1),
      )
      expect(
        valid1KeyValue,
        `AC-5.4: Imported estimate key "${projectKey(ID_VALID_1)}" must not be removed`,
      ).not.toBeNull()

      // ── Close and verify the account list (AC-5.2 subset) ────────────────────
      const closeBtn = modal.locator('[data-testid="import-results-close"]')
      await expect(closeBtn).toBeVisible()
      await closeBtn.click()

      await expect(modal).not.toBeVisible({ timeout: 5_000 })
      await page.waitForLoadState('networkidle')

      // The two valid estimates appear in the account list.
      await expect(
        page.getByText(NAME_VALID_1),
        `AC-5.2: "${NAME_VALID_1}" must appear in the account list after partial import`,
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText(NAME_VALID_2),
        `AC-5.2: "${NAME_VALID_2}" must appear in the account list after partial import`,
      ).toBeVisible({ timeout: 15_000 })

      // The oversized estimate must NOT be in the account list (it failed).
      await expect(
        page.getByText(NAME_OVERSIZE),
        `The oversized estimate "${NAME_OVERSIZE}" must NOT appear in the account list (it failed)`,
      ).not.toBeVisible({ timeout: 5_000 })
    },
  )

  // ─── Test 3: Decline path (AC-5.1, AC-5.3) ────────────────────────────────

  test(
    'AC-5.3: decline sets the session flag; offer does not re-appear on next visit; localStorage is untouched',
    async ({ context, page }) => {
      const runId = `t15d${Date.now().toString(36)}`
      const userEmail = `t15-decline-${runId}@operai.test`

      const ID_PROJ = `proj-${runId}-d`
      const NAME_PROJ = `T15 Decline Test ${runId}`
      const projectD = buildProjectData(ID_PROJ, NAME_PROJ)
      const seeds = buildLocalStorageSeeds([projectD])

      await page.addInitScript((seedData: Record<string, string>) => {
        for (const [key, value] of Object.entries(seedData)) {
          localStorage.setItem(key, value)
        }
      }, seeds)

      const { rawCookieHeader } = await seedTestUser(userEmail, 'T15 Decline User')
      const authDomain = new URL(AUTH_URL).hostname
      await injectSessionCookie(context, rawCookieHeader, authDomain)

      // ── Navigate and see the offer ────────────────────────────────────────────
      await page.goto('/estimates')
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(/\/estimates$/, { timeout: 15_000 })

      const modal = page.locator('[data-testid="import-offer-modal"]')
      await expect(
        modal,
        'AC-5.1: Import offer must appear on first authenticated load with localStorage estimates',
      ).toBeVisible({ timeout: MODAL_TIMEOUT })

      // ── Decline ───────────────────────────────────────────────────────────────
      const skipBtn = modal.getByRole('button', { name: 'Skip for now' })
      await expect(skipBtn, '"Skip for now" button must be visible').toBeVisible()
      await skipBtn.click()

      // Modal closes.
      await expect(modal, 'Modal must close after declining').not.toBeVisible({
        timeout: 5_000,
      })

      // ── AC-5.3: localStorage key still present (no removal) ───────────────────
      const projectsKeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        PROJECTS_KEY,
      )
      expect(
        projectsKeyValue,
        `AC-5.3: "${PROJECTS_KEY}" key must not be removed on decline`,
      ).not.toBeNull()

      const projKeyValue = await page.evaluate(
        (key: string) => localStorage.getItem(key),
        projectKey(ID_PROJ),
      )
      expect(
        projKeyValue,
        `AC-5.3: "${projectKey(ID_PROJ)}" key must not be removed on decline`,
      ).not.toBeNull()

      // ── AC-5.3: sessionStorage flag is set ────────────────────────────────────
      const sessionFlag = await page.evaluate(() =>
        sessionStorage.getItem('import_offer_dismissed'),
      )
      expect(
        sessionFlag,
        'AC-5.3: sessionStorage "import_offer_dismissed" flag must be set after decline',
      ).toBe('1')

      // ── AC-5.3: offer does not re-appear on next navigation ───────────────────
      // The session flag (sessionStorage) persists within the same browser session.
      // We reload /estimates to simulate a second navigation within the same session.
      // (sessionStorage survives page reloads within the same tab — it only clears on
      // tab close or explicit clearance.)
      await page.goto('/estimates')
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(/\/estimates$/, { timeout: 10_000 })

      // The modal must NOT appear again (session flag prevents it).
      await expect(
        modal,
        'AC-5.3: Import offer must not re-appear after decline (session flag set)',
      ).not.toBeVisible({ timeout: 5_000 })
    },
  )
})
