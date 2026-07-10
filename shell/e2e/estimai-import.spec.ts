/**
 * EstimAI legacy-localStorage import journey — offer / accept / partial-failure /
 * decline, running against the SHELL-MOUNTED EstimAI remote (T18, specs/003-suite-shell).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE (relocated from estimai-ui/e2e/import.spec.ts)
 *
 * Same rationale as estimai-persistence.spec.ts: estimai-ui is now a federated
 * remote consuming `shell/session` (T13) with no standalone authed bootstrap,
 * so the original standalone import e2e can no longer run. This is the SAME
 * one-time import journey, ported to drive EstimAI inside the shell under
 * `/estimai/*`. Because the remote executes in the shell's page context, the
 * legacy `estimai_project_*` localStorage keys are seeded on the shell origin
 * (localhost:5173) — exactly where `useImportOffer` reads them.
 *
 * WHAT THIS TEST PROVES (against the live estimai-api):
 *   Test 1 — accept: seed 2 valid localStorage estimates → offer appears →
 *     "Import all" → POST /estimates/import → both imported → both appear in the
 *     account list → localStorage keys NOT removed.
 *   Test 2 — partial failure: 2 valid + 1 over-1MiB → mixed results table
 *     (2 Imported, 1 Failed) → valid two appear in the list → no local data removed.
 *   Test 3 — decline: "Skip for now" → session dismissal flag set → offer does
 *     not re-appear on the next visit → localStorage untouched.
 *
 * The localStorage key format is inlined (`estimai_projects`,
 * `estimai_project_<id>`) rather than imported across the package boundary
 * (estimai-ui/src/lib/projects.ts) to keep this shell spec self-contained.
 */

import { test, expect, type BrowserContext } from '@playwright/test'

// ─── Constants ──────────────────────────────────────────────────────────────

const AUTH_URL = (
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'
).replace(/\/$/, '')

const MODAL_TIMEOUT = 15_000

// Legacy localStorage keys (from estimai-ui/src/lib/projects.ts).
const PROJECTS_KEY = 'estimai_projects'
const projectKey = (id: string) => `estimai_project_${id}`

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Seeds a unique better-auth user and injects the session cookie so the
 *  account list starts empty for this test (no cross-run collisions). */
const seedUniqueUser = async (
  context: BrowserContext,
  email: string,
  name: string,
): Promise<void> => {
  const res = await fetch(`${AUTH_URL}/test-auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `[import] POST /test-auth/session failed (${res.status}): ${body}\n` +
        `Make sure auth is running with ENABLE_TEST_AUTH=true.`,
    )
  }
  const rawCookieHeader = res.headers.get('set-cookie')
  if (!rawCookieHeader) {
    throw new Error('[import] POST /test-auth/session returned no Set-Cookie header.')
  }

  const parts = rawCookieHeader.trim().split(';').map((p) => p.trim())
  const [nameValue, ...attrs] = parts
  const eqIdx = nameValue.indexOf('=')
  const cookieName = nameValue.slice(0, eqIdx).trim()
  const value = nameValue.slice(eqIdx + 1).trim()

  const attrMap: Record<string, string | boolean> = {}
  for (const attr of attrs) {
    const [k, v] = attr.split('=')
    attrMap[k.trim().toLowerCase()] = v !== undefined ? v.trim() : true
  }
  const sameSiteRaw =
    typeof attrMap['samesite'] === 'string' ? attrMap['samesite'].toLowerCase() : 'lax'
  const sameSite: 'Strict' | 'Lax' | 'None' =
    sameSiteRaw === 'strict' ? 'Strict' : sameSiteRaw === 'none' ? 'None' : 'Lax'

  await context.addCookies([
    {
      name: cookieName,
      value,
      domain: typeof attrMap['domain'] === 'string' ? attrMap['domain'] : new URL(AUTH_URL).hostname,
      path: typeof attrMap['path'] === 'string' ? attrMap['path'] : '/',
      httpOnly: attrMap['httponly'] === true,
      secure: attrMap['secure'] === true,
      sameSite,
    },
  ])
}

const buildProjectData = (id: string, name: string, author = 'Import Test Author') => ({
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
      notes: 'import test activity',
      release: `rel-${id}`,
    },
  ],
})

/** Content that exceeds MAX_ESTIMATE_BYTES (1 MiB): 600 activities × 2000-char notes. */
const buildOversizedProjectData = (id: string, name: string) => {
  const longNotes = 'X'.repeat(2000)
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
    author: 'Import Oversized',
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

const buildLocalStorageSeeds = (
  projects: ReturnType<typeof buildProjectData>[],
): Record<string, string> => {
  const seeds: Record<string, string> = {}
  seeds[PROJECTS_KEY] = JSON.stringify(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      author: p.author,
      updatedAt: new Date().toISOString(),
    })),
  )
  for (const p of projects) {
    seeds[projectKey(p.id)] = JSON.stringify(p)
  }
  return seeds
}

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe('EstimAI import journey inside the shell (offer / accept / partial / decline)', () => {
  test('accept: imports all valid estimates into the account list; localStorage keys are not removed', async ({
    context,
    page,
  }) => {
    const runId = `impa${Date.now().toString(36)}`
    const ID_A = `proj-${runId}-a`
    const ID_B = `proj-${runId}-b`
    const NAME_A = `Import Alpha ${runId}`
    const NAME_B = `Import Beta ${runId}`

    const seeds = buildLocalStorageSeeds([
      buildProjectData(ID_A, NAME_A),
      buildProjectData(ID_B, NAME_B),
    ])
    await page.addInitScript((seedData: Record<string, string>) => {
      for (const [key, value] of Object.entries(seedData)) localStorage.setItem(key, value)
    }, seeds)

    await seedUniqueUser(context, `${runId}@operai.test`, 'Import Accept User')

    await page.goto('/estimai/estimates')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 15_000 })

    const modal = page.locator('[data-testid="import-offer-modal"]')
    await expect(modal, 'Import offer must appear when localStorage estimates exist').toBeVisible({
      timeout: MODAL_TIMEOUT,
    })
    await expect(modal).toContainText('2 estimate')
    await expect(modal).toContainText(NAME_A)
    await expect(modal).toContainText(NAME_B)

    await modal.getByRole('button', { name: 'Import all' }).click()

    await expect(modal, 'Results view must appear after import').toContainText(
      '2 of 2 imported successfully',
      { timeout: 30_000 },
    )
    await expect(modal.locator('table td').getByText('Imported', { exact: true })).toHaveCount(2)
    await expect(modal.locator('table td').getByText('Failed', { exact: true })).toHaveCount(0)

    // localStorage keys are NOT removed.
    for (const key of [PROJECTS_KEY, projectKey(ID_A), projectKey(ID_B)]) {
      const value = await page.evaluate((k: string) => localStorage.getItem(k), key)
      expect(value, `"${key}" must still be present after import`).not.toBeNull()
    }

    await modal.locator('[data-testid="import-results-close"]').click()
    await expect(modal).not.toBeVisible({ timeout: 5_000 })

    await page.waitForLoadState('networkidle')
    await expect(page.getByText(NAME_A)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(NAME_B)).toBeVisible({ timeout: 15_000 })
  })

  test('partial failure: valid estimates imported, oversized estimate fails; no local data removed', async ({
    context,
    page,
  }) => {
    const runId = `impp${Date.now().toString(36)}`
    const ID_V1 = `proj-${runId}-v1`
    const ID_V2 = `proj-${runId}-v2`
    const ID_OVER = `proj-${runId}-over`
    const NAME_V1 = `Import Valid One ${runId}`
    const NAME_V2 = `Import Valid Two ${runId}`
    const NAME_OVER = `Import Oversized ${runId}`

    const seeds = buildLocalStorageSeeds([
      buildProjectData(ID_V1, NAME_V1),
      buildProjectData(ID_V2, NAME_V2),
      buildOversizedProjectData(ID_OVER, NAME_OVER),
    ])
    await page.addInitScript((seedData: Record<string, string>) => {
      for (const [key, value] of Object.entries(seedData)) localStorage.setItem(key, value)
    }, seeds)

    await seedUniqueUser(context, `${runId}@operai.test`, 'Import Partial User')

    await page.goto('/estimai/estimates')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 15_000 })

    const modal = page.locator('[data-testid="import-offer-modal"]')
    await expect(modal).toBeVisible({ timeout: MODAL_TIMEOUT })
    await expect(modal).toContainText('3 estimate')

    await modal.getByRole('button', { name: 'Import all' }).click()

    await expect(modal, 'Results summary must show 2 of 3 imported').toContainText(
      '2 of 3 imported successfully',
      { timeout: 30_000 },
    )
    await expect(modal.locator('table td').getByText('Imported', { exact: true })).toHaveCount(2)
    await expect(modal.locator('table td').getByText('Failed', { exact: true })).toHaveCount(1)

    // No local data removed.
    for (const key of [PROJECTS_KEY, projectKey(ID_V1), projectKey(ID_V2), projectKey(ID_OVER)]) {
      const value = await page.evaluate((k: string) => localStorage.getItem(k), key)
      expect(value, `"${key}" must still be present after partial import`).not.toBeNull()
    }

    await modal.locator('[data-testid="import-results-close"]').click()
    await expect(modal).not.toBeVisible({ timeout: 5_000 })

    await page.waitForLoadState('networkidle')
    await expect(page.getByText(NAME_V1)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(NAME_V2)).toBeVisible({ timeout: 15_000 })
  })

  test('decline: sets the session flag; offer does not re-appear on next visit; localStorage untouched', async ({
    context,
    page,
  }) => {
    const runId = `impd${Date.now().toString(36)}`
    const ID_D = `proj-${runId}-d`
    const NAME_D = `Import Decline ${runId}`

    const seeds = buildLocalStorageSeeds([buildProjectData(ID_D, NAME_D)])
    await page.addInitScript((seedData: Record<string, string>) => {
      for (const [key, value] of Object.entries(seedData)) localStorage.setItem(key, value)
    }, seeds)

    await seedUniqueUser(context, `${runId}@operai.test`, 'Import Decline User')

    await page.goto('/estimai/estimates')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 15_000 })

    const modal = page.locator('[data-testid="import-offer-modal"]')
    await expect(modal).toBeVisible({ timeout: MODAL_TIMEOUT })

    await modal.getByRole('button', { name: 'Skip for now' }).click()
    await expect(modal).not.toBeVisible({ timeout: 5_000 })

    // localStorage keys untouched.
    for (const key of [PROJECTS_KEY, projectKey(ID_D)]) {
      const value = await page.evaluate((k: string) => localStorage.getItem(k), key)
      expect(value, `"${key}" must not be removed on decline`).not.toBeNull()
    }

    // Session dismissal flag set.
    const sessionFlag = await page.evaluate(() =>
      sessionStorage.getItem('import_offer_dismissed'),
    )
    expect(sessionFlag, 'import_offer_dismissed flag must be set after decline').toBe('1')

    // Offer does not re-appear on the next navigation within the same session.
    await page.goto('/estimai/estimates')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await expect(modal, 'Import offer must not re-appear after decline').not.toBeVisible({
      timeout: 5_000,
    })
  })
})
