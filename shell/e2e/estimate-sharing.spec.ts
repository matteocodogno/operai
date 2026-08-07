/**
 * T25 — Estimate sharing e2e journeys (specs/013-estimate-sharing, QE
 * verification pass). Drives the REAL assembled shell host + estimai-ui
 * remote (ADR-0006) against the REAL estimai-api/auth services — no
 * mocking — mirroring this suite's existing cross-app e2e convention
 * (refund-headline.spec.ts, estimai-persistence.spec.ts).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE, NOT `estimai-ui/e2e/`
 *
 * specs/013's own tasks.md (T25) names `estimai-ui/e2e/estimate-sharing.
 * spec.ts` and "the existing seeded-session helper in estimai-ui/e2e/". That
 * directory does not exist any more: T18 of specs/003-suite-shell retired
 * estimai-ui's standalone e2e outright (commit 23c8833, "estimai-ui
 * standalone e2e retired (it is a federated remote now, no standalone authed
 * bootstrap); genuine journeys … relocated to shell/e2e") once estimai-ui
 * became a Module Federation remote that consumes `shell/session` for its
 * JWT/apiFetch and dropped its own `_authed` guard — it structurally cannot
 * mint an authenticated session on its own any more (`import('shell/session')`
 * has nothing to resolve against without the shell served). Every other
 * estimai journey since specs/003 (import, persistence, identity/JWKS, the
 * authed-call smoke test) already lives in `shell/e2e/` for the identical
 * reason; this file follows that same, current, working convention rather
 * than resurrecting a directory the codebase deliberately deleted. See the
 * T25 QE report for the full drift note back to specs/013.
 *
 * WHAT THIS PROVES:
 *   Journey 1 (US-1/2/3/5/6/7, AC-1.1/2.1/3.1/5.2/6.1) — owner shares an
 *   estimate with a registered collaborator → collaborator sees it in their
 *   own list with the right badge → viewer cannot edit (UI absence AND a
 *   direct API PUT attempt refused) → owner promotes to editor → editor
 *   saves → owner revokes → estimate disappears from the collaborator's list.
 *
 *   Journey 2 (US-4, AC-4.4) — a SOLO owner, two browser tabs (two Playwright
 *   BrowserContexts sharing one seeded session), no other collaborator
 *   involved: the second tab's autosave surfaces the conflict banner after
 *   the first tab already saved — the deliberate proof that conflict
 *   detection is not merely a multi-collaborator feature (spec.md
 *   Amendments: this supersedes spec 001's prior single-writer last-write-
 *   wins acceptance).
 *
 * FIXTURES: `estimaiFixtures.ts`'s `grantEstimaiAccess` grants the REAL
 * `(estimai, access)` PermissionRule a real admin would grant — verified
 * against `auth/src/authz/seed.ts` that the baseline `employee` role carries
 * NO such grant by default. Two independent things need it: (1) the shell's
 * OWN `/estimai/*` route guard (specs/004 T25, `createToolAccessBeforeLoad`)
 * redirects to `/no-access` unless `GET /authz/me`'s `apps` includes
 * "estimai" — this gates EVERY user in EVERY journey below, including
 * Journey 2's solo owner who never shares anything; (2) T2's `auth POST
 * /authz/app-access-check` (ADR-0035) additionally needs it on BOTH the
 * calling owner (caller gate) and the target collaborator (eligibility) for
 * the share flow specifically.
 *
 * STACK REQUIREMENTS (started by shell/playwright.config.ts webServer, same
 * as every other spec in this directory): PostgreSQL (localhost:5435), auth
 * (localhost:3001, ENABLE_TEST_AUTH=true), estimai-api (localhost:8080,
 * AUTH_BASE_URL pointed at the same auth instance — required for the share
 * path per specs/013's fail-closed posture, unlike the plain editor).
 */
import { test, expect, type Page } from '@playwright/test'
import { seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantEstimaiAccess } from './helpers/estimaiFixtures'

// estimai-api base URL — mirrors shell/playwright.config.ts's own apiUrl resolution.
const ESTIMAI_API_URL =
  process.env['E2E_API_URL'] ?? process.env['VITE_API_URL'] ?? 'http://localhost:8080'

// Auto-save debounce is 1500 ms (EstimatorContext.tsx); wait generously for the PUT.
const AUTOSAVE_WAIT_MS = 12_000

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

const estimateIdFromUrl = (url: string): string => {
  const match = url.match(/\/estimai\/estimates\/([a-z0-9]+)$/)
  if (!match) throw new Error(`[estimate-sharing] could not extract estimate id from URL: ${url}`)
  return match[1]!
}

/** Creates a brand-new estimate via the "+ New estimate" → blank-template path, names it, adds one activity, and waits for the first autosave to land. Returns the estimate id. */
async function createNamedEstimate(page: Page, name: string, activityName: string): Promise<string> {
  await page.goto('/estimai/estimates')
  await page.waitForLoadState('networkidle')

  const newBtn = page.getByRole('button', { name: '+ New estimate' })
  await expect(newBtn, 'New estimate button must be visible').toBeVisible({ timeout: 15_000 })
  await newBtn.click()

  await expect(page, 'Must navigate to the editor after create').toHaveURL(
    /\/estimai\/estimates\/[a-z0-9]+$/,
    { timeout: 15_000 },
  )
  const estimateId = estimateIdFromUrl(page.url())

  const nameInput = page.getByPlaceholder('Project name…').first()
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.click({ clickCount: 3 })
  await nameInput.pressSequentially(name)
  await expect(nameInput).toHaveValue(name, { timeout: 3_000 })

  const blankBtn = page.getByRole('button', { name: 'Start with a blank estimate' })
  await expect(blankBtn).toBeVisible({ timeout: 5_000 })
  await blankBtn.click()

  const addActivityBtn = page.getByTitle('Add activity (Shift+N)').first()
  await expect(addActivityBtn).toBeVisible({ timeout: 5_000 })
  await addActivityBtn.click()

  const activityInput = page.getByPlaceholder('Activity…').first()
  await expect(activityInput).toBeVisible({ timeout: 5_000 })
  await activityInput.click({ clickCount: 3 })
  await activityInput.pressSequentially(activityName)
  await page.keyboard.press('Tab')

  await page.waitForResponse(
    (resp) =>
      resp.url().includes(`/estimates/${estimateId}`) &&
      resp.request().method() === 'PUT' &&
      resp.status() === 200,
    { timeout: AUTOSAVE_WAIT_MS },
  )

  return estimateId
}

// Two full multi-context journeys, each with several 12s-budgeted autosave
// waits — comfortably over Playwright's 30s default per-test timeout even
// when every step succeeds well within its own generous inner timeout.
test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.describe('specs/013-estimate-sharing T25: headline journeys', () => {
  test('Journey 1 — owner shares → collaborator sees it with the right badge → viewer cannot edit → promote to editor → editor saves → owner revokes → disappears (AC-1.1/2.1/3.1/5.2/6.1)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const ownerEmail = `e2e-share-owner-${tag}@operai.test`
    const collabEmail = `e2e-share-collab-${tag}@operai.test`
    const estimateName = `Sharing Journey ${tag}`

    const ownerSession = await seedUserSession(ownerEmail, 'E2E Share Owner')
    grantEstimaiAccess(ownerEmail) // caller gate on auth POST /authz/app-access-check (ADR-0035)
    const collabSession = await seedUserSession(collabEmail, 'E2E Share Collaborator')
    grantEstimaiAccess(collabEmail) // eligibility target for the same check

    // ─── Owner: create an estimate, then share it as a viewer ──────────────
    const ownerContext = await browser.newContext()
    await applySessionCookie(ownerContext, ownerSession)
    const ownerPage = await ownerContext.newPage()

    const estimateId = await createNamedEstimate(ownerPage, estimateName, 'Sharing activity')

    const collabsButton = ownerPage.getByTestId('collaborators-button')
    await expect(collabsButton, 'Owner must see the actionable Collaborators button').toBeVisible({
      timeout: 10_000,
    })
    await collabsButton.click()

    const dialog = ownerPage.getByTestId('collaborators-dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    await ownerPage.getByTestId('collaborators-dialog-email-input').fill(collabEmail)
    // Default level select is already 'viewer' — leave it (AC-1.1's viewer path).
    await ownerPage.getByTestId('collaborators-dialog-add-button').click()

    const collabRow = ownerPage.getByTestId('collaborators-dialog-list').locator('li', { hasText: collabEmail })
    await expect(collabRow, 'Collaborator must appear in the owner-mode list after add').toBeVisible({
      timeout: 10_000,
    })
    await expect(collabRow).toContainText('Viewer')

    await ownerPage.getByLabel('Close').click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })

    // ─── Collaborator: sees the shared estimate in their own list ──────────
    const collabContext = await browser.newContext()
    await applySessionCookie(collabContext, collabSession)
    const collabPage = await collabContext.newPage()

    await collabPage.goto('/estimai/estimates')
    await collabPage.waitForLoadState('networkidle')

    const sharedRow = collabPage.getByTestId('estimate-row-shared').filter({ hasText: estimateName })
    await expect(sharedRow, 'Shared estimate must appear, badged, in the collaborator\'s own list (AC-2.1/2.2)').toBeVisible({
      timeout: 15_000,
    })
    await expect(sharedRow).toContainText('Viewer')
    // Owner-only Delete must be absent on a shared row (AC-3.3/5.1's mirror on the list side).
    await expect(sharedRow.getByRole('button', { name: /^Delete/ })).toHaveCount(0)

    // ─── Collaborator (viewer): open it — read-only in the UI ──────────────
    await sharedRow.getByRole('button', { name: 'Open' }).click()
    await expect(collabPage, 'Collaborator must land on the same estimate id').toHaveURL(
      new RegExp(`/estimai/estimates/${estimateId}$`),
      { timeout: 15_000 },
    )

    await expect(
      collabPage.getByPlaceholder('Project name…').first(),
      'Name input must round-trip the owner-set name',
    ).toHaveValue(estimateName, { timeout: 10_000 })
    await expect(
      collabPage.getByPlaceholder('Project name…').first(),
      'Name input must be readOnly for a viewer (AC-3.1)',
    ).toHaveAttribute('readonly', '')

    await expect(
      collabPage.getByTitle('Add activity (Shift+N)'),
      'No "Add activity" control anywhere for a viewer (AC-3.1)',
    ).toHaveCount(0)

    await expect(
      collabPage.getByTestId('collaborators-chip'),
      'Collaborator sees the non-actionable chip, never the owner\'s button (AC-8.1/8.2 toolbar decision)',
    ).toBeVisible()
    await expect(collabPage.getByTestId('collaborators-button')).toHaveCount(0)

    // AC-3.1's second half: a direct API PUT attempt (bypassing the UI
    // entirely) must be refused too — the UI gating is not the real control.
    // Driven from Node directly (ADR-0001: the JWT lives in a module-scope
    // variable inside the page, never window-visible, so there is nothing to
    // read via page.evaluate()) using the collaborator's own seeded token —
    // the same trust level as their real browser session.
    const directGetRes = await fetch(`${ESTIMAI_API_URL}/estimates/${estimateId}`, {
      headers: { Authorization: `Bearer ${collabSession.token}` },
    })
    expect(directGetRes.status, 'A viewer must still be able to GET (AC-3.1: read stays allowed)').toBe(200)
    const etag = directGetRes.headers.get('etag')
    expect(etag, 'GET must carry an ETag for If-Match (ADR-0038)').toBeTruthy()
    const body = (await directGetRes.json()) as { name: string; author: string; content: unknown }

    const directPutRes = await fetch(`${ESTIMAI_API_URL}/estimates/${estimateId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${collabSession.token}`,
        'Content-Type': 'application/json',
        'If-Match': etag!,
      },
      body: JSON.stringify({ name: `${body.name} — hacked by viewer`, author: body.author, content: body.content }),
    })
    expect(
      directPutRes.status,
      'A viewer\'s direct API PUT must be refused (403 insufficient_access), never a silent 200 (AC-3.1)',
    ).toBe(403)

    // ─── Owner: promote the collaborator to editor ──────────────────────────
    await ownerPage.getByTestId('collaborators-button').click()
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    const ownerRowAfterAdd = ownerPage.getByTestId('collaborators-dialog-list').locator('li', { hasText: collabEmail })
    await ownerRowAfterAdd.locator('select').selectOption('editor')
    await expect(ownerRowAfterAdd.locator('select'), 'Level select must settle on editor').toHaveValue('editor', {
      timeout: 10_000,
    })
    await expect(ownerRowAfterAdd).toContainText('Editor')
    await ownerPage.getByLabel('Close').click()

    // ─── Collaborator (now editor, next request per AC-5.1): saves successfully ──
    await collabPage.getByRole('button', { name: 'My Estimates' }).first().click()
    await expect(collabPage).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await collabPage.waitForLoadState('networkidle')

    const sharedRowAsEditor = collabPage.getByTestId('estimate-row-shared').filter({ hasText: estimateName })
    await expect(sharedRowAsEditor).toContainText('Editor')
    await sharedRowAsEditor.getByRole('button', { name: 'Open' }).click()
    await expect(collabPage).toHaveURL(new RegExp(`/estimai/estimates/${estimateId}$`), { timeout: 15_000 })

    await expect(
      collabPage.getByTitle('Add activity (Shift+N)').first(),
      'Editor collaborator must now have the mutating control back (AC-3.2/5.1)',
    ).toBeVisible({ timeout: 10_000 })

    const editedName = `${estimateName} — edited by editor`
    const collabNameInput = collabPage.getByPlaceholder('Project name…').first()
    await collabNameInput.click({ clickCount: 3 })
    await collabNameInput.pressSequentially(editedName)

    const editorSaveRes = await collabPage.waitForResponse(
      (resp) =>
        resp.url().includes(`/estimates/${estimateId}`) &&
        resp.request().method() === 'PUT',
      { timeout: AUTOSAVE_WAIT_MS },
    )
    expect(editorSaveRes.status(), 'Editor collaborator\'s save must succeed (AC-3.2/AC-5.1)').toBe(200)

    // ─── Owner: revoke the collaborator ──────────────────────────────────────
    await ownerPage.getByTestId('collaborators-button').click()
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    const ownerRowToRemove = ownerPage.getByTestId('collaborators-dialog-list').locator('li', { hasText: collabEmail })
    await ownerRowToRemove.getByRole('button', { name: `Remove ${collabEmail}` }).click()

    const confirmModal = ownerPage.locator('[data-testid="confirm-delete-modal"]')
    await expect(confirmModal).toBeVisible({ timeout: 5_000 })
    await ownerPage.locator('[data-testid="confirm-delete-confirm"]').click()
    await expect(confirmModal).not.toBeVisible({ timeout: 10_000 })
    await expect(
      ownerPage.getByTestId('collaborators-dialog-list').locator('li', { hasText: collabEmail }),
    ).toHaveCount(0)
    await ownerPage.getByLabel('Close').click()

    // ─── Collaborator: the estimate disappears from their list (AC-5.2) ─────
    await collabPage.getByRole('button', { name: 'My Estimates' }).first().click()
    await expect(collabPage).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await collabPage.waitForLoadState('networkidle')
    await expect(
      collabPage.getByTestId('estimate-row-shared').filter({ hasText: estimateName }),
      'Revoked estimate must be gone from the former collaborator\'s list (AC-5.2)',
    ).toHaveCount(0)

    // A direct GET must also now be refused the same way an unrelated user's would (AC-1.6/AC-5.2).
    const directGetAfterRevoke = await fetch(`${ESTIMAI_API_URL}/estimates/${estimateId}`, {
      headers: { Authorization: `Bearer ${collabSession.token}` },
    })
    expect(directGetAfterRevoke.status, 'Revoked collaborator\'s GET must 404 (AC-1.6 denial taxonomy)').toBe(404)

    // ─── Cleanup: owner deletes the estimate ─────────────────────────────────
    await ownerPage.getByRole('button', { name: 'My Estimates' }).first().click()
    await expect(ownerPage).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await ownerPage.waitForLoadState('networkidle')
    // The editor's save step above renamed the estimate, so match on the
    // Delete button's fixed prefix rather than the original `estimateName`.
    const deleteBtn = ownerPage.getByRole('button', { name: /^Delete "/ })
    await expect(deleteBtn).toBeVisible({ timeout: 10_000 })
    await deleteBtn.click()
    const deleteModal = ownerPage.locator('[data-testid="confirm-delete-modal"]')
    await expect(deleteModal).toBeVisible({ timeout: 5_000 })
    await ownerPage.locator('[data-testid="confirm-delete-confirm"]').click()
    await expect(deleteModal).not.toBeVisible({ timeout: 10_000 })

    await ownerContext.close()
    await collabContext.close()
  })

  test('Journey 2 — same owner, two tabs: second tab\'s autosave surfaces the conflict banner after the first tab already saved (AC-4.4)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const ownerEmail = `e2e-share-conflict-${tag}@operai.test`
    const estimateName = `Conflict Journey ${tag}`

    // Solo owner — estimai-api's own read/write path never gates on
    // estimai:access (ADR-0036: it is not an authorization-enforcing
    // resource server), but the SHELL's own `/estimai/*` route guard
    // (specs/004 T25, `createToolAccessBeforeLoad`) does: it redirects to
    // `/no-access` unless the caller's `GET /authz/me` `apps` includes
    // "estimai", regardless of what the tool underneath requires. Every user
    // reaching the shell-mounted editor in these tests needs this grant.
    const ownerSession = await seedUserSession(ownerEmail, 'E2E Conflict Owner')
    grantEstimaiAccess(ownerEmail)

    // ─── Tab 1: create + first save ──────────────────────────────────────────
    const tab1Context = await browser.newContext()
    await applySessionCookie(tab1Context, ownerSession)
    const tab1 = await tab1Context.newPage()

    const estimateId = await createNamedEstimate(tab1, estimateName, 'Conflict activity')

    // ─── Tab 2: same user, same estimate, opened right after tab 1's first save ──
    const tab2Context = await browser.newContext()
    await applySessionCookie(tab2Context, ownerSession)
    const tab2 = await tab2Context.newPage()

    await tab2.goto(`/estimai/estimates/${estimateId}`)
    await expect(tab2.getByPlaceholder('Project name…').first()).toHaveValue(estimateName, { timeout: 15_000 })

    // Track every PUT tab 2 fires against this estimate from here on.
    let tab2PutCount = 0
    tab2.on('response', (resp) => {
      if (resp.request().method() === 'PUT' && resp.url().includes(`/estimates/${estimateId}`)) tab2PutCount++
    })

    // ─── Tab 1: a SECOND edit + save, bumping the version tab 2 doesn't know about ──
    const tab1SecondName = `${estimateName} — tab1 edit`
    const tab1NameInput = tab1.getByPlaceholder('Project name…').first()
    await tab1NameInput.click({ clickCount: 3 })
    await tab1NameInput.pressSequentially(tab1SecondName)
    const tab1SecondSave = await tab1.waitForResponse(
      (resp) => resp.url().includes(`/estimates/${estimateId}`) && resp.request().method() === 'PUT',
      { timeout: AUTOSAVE_WAIT_MS },
    )
    expect(tab1SecondSave.status(), 'Tab 1\'s second save must succeed').toBe(200)

    // ─── Tab 2: edits independently — its autosave now carries a stale If-Match ──
    const tab2LocalName = `${estimateName} — tab2 stale edit`
    const tab2NameInput = tab2.getByPlaceholder('Project name…').first()
    await tab2NameInput.click({ clickCount: 3 })
    await tab2NameInput.pressSequentially(tab2LocalName)

    const tab2ConflictRes = await tab2.waitForResponse(
      (resp) => resp.url().includes(`/estimates/${estimateId}`) && resp.request().method() === 'PUT',
      { timeout: AUTOSAVE_WAIT_MS },
    )
    expect(
      tab2ConflictRes.status(),
      'Tab 2\'s save must be refused with a conflict, never silently overwrite tab 1\'s save (AC-4.1/AC-4.4)',
    ).toBe(409)

    // ─── The conflict banner appears — AC-4.1/4.2's recovery surface ────────
    const banner = tab2.getByTestId('conflict-banner')
    await expect(banner).toBeVisible({ timeout: 5_000 })
    await expect(banner).toHaveAttribute('role', 'alert')
    await expect(banner.getByRole('button', { name: 'Reload latest' })).toBeVisible()
    await expect(banner.getByRole('button', { name: 'Save as a copy instead' })).toBeVisible()
    // Never a dismiss "×" on this banner (design.md — it must not be
    // "fixable" by adding one back later).
    await expect(banner.getByRole('button', { name: '×' })).toHaveCount(0)

    // Header's 4th save-status state makes the suppression visible.
    await expect(tab2.getByText('Not saving — reload to continue')).toBeVisible({ timeout: 5_000 })

    // AC-4.2: the user's own in-progress edit is NOT discarded by the conflict.
    await expect(tab2NameInput).toHaveValue(tab2LocalName)

    // ─── AC-4.2's suspension: no further autosave fires while conflict is active ──
    const putsAtConflict = tab2PutCount
    await tab2NameInput.pressSequentially(' — still typing')
    // Wait well past the 1500ms debounce with margin.
    await tab2.waitForTimeout(6_000)
    expect(tab2PutCount, 'Autosave must stay suspended after a conflict — no further PUT fires').toBe(putsAtConflict)
    // The extra keystrokes are still visible locally, proving nothing was lost.
    await expect(tab2NameInput).toHaveValue(`${tab2LocalName} — still typing`)

    // ─── "Reload latest" actually recovers: pulls tab 1's real content, clears the banner ──
    await banner.getByRole('button', { name: 'Reload latest' }).click()
    await expect(banner, 'Conflict banner must clear after reloading').not.toBeVisible({ timeout: 10_000 })
    await expect(
      tab2.getByPlaceholder('Project name…').first(),
      'Reload must pull the server\'s real (tab 1) content, not tab 2\'s stale/local one',
    ).toHaveValue(tab1SecondName, { timeout: 10_000 })

    // ─── Cleanup ──────────────────────────────────────────────────────────────
    await tab1.bringToFront()
    await tab1.getByRole('button', { name: 'My Estimates' }).first().click()
    await expect(tab1).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await tab1.waitForLoadState('networkidle')
    const deleteBtn = tab1.getByRole('button', { name: /^Delete "/ })
    if (await deleteBtn.count()) {
      await deleteBtn.first().click()
      const deleteModal = tab1.locator('[data-testid="confirm-delete-modal"]')
      await expect(deleteModal).toBeVisible({ timeout: 5_000 })
      await tab1.locator('[data-testid="confirm-delete-confirm"]').click()
      await expect(deleteModal).not.toBeVisible({ timeout: 10_000 })
    }

    await tab1Context.close()
    await tab2Context.close()
  })
})
