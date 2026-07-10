/**
 * EstimAI persistence journey — create / save / reload / reopen / delete,
 * running against the SHELL-MOUNTED EstimAI remote (T18, specs/003-suite-shell).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE (relocated from estimai-ui/e2e/persistence.spec.ts)
 *
 * T13 made estimai-ui a Module Federation remote that consumes `shell/session`
 * for its JWT/apiFetch and dropped its own `_authed` guard; T14 moved the
 * suite chrome into the shell. estimai-ui therefore no longer runs standalone
 * for authed flows (its `import('shell/session')` cannot resolve without the
 * shell served), so the original standalone persistence e2e could no longer
 * pass. This is the SAME journey, ported to drive EstimAI as it actually ships
 * now — mounted inside the shell under `/estimai/*` — using the shell suite's
 * seeded better-auth session. AC-4.1 ("EstimAI behaves identically inside the
 * shell") is exactly what this verifies end-to-end.
 *
 * WHAT THIS TEST PROVES — the full round-trip against the live stack:
 *   1. Sign in via a seeded better-auth session (shell owns the guard).
 *   2. CREATE: `/estimai/estimates` → "+ New estimate" → POST /estimates.
 *   3. SAVE: type a project name + add an activity → debounced PUT /estimates/{id}.
 *   4. RELOAD: back to the list → GET /estimates shows the saved estimate.
 *   5. REOPEN: Open the row → GET /estimates/{id} → editor shows persisted
 *      content and computed metrics render.
 *   6. DELETE: delete the row via the confirm modal → gone from the list.
 *
 * STACK REQUIREMENTS (started by shell/playwright.config.ts webServer):
 *   - PostgreSQL (localhost:5435), auth (localhost:3001, ENABLE_TEST_AUTH=true),
 *     estimai-api (localhost:8080), shell+estimai-ui+refund-ui built & previewed.
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

// Auto-save debounce is 1500 ms; wait generously for the PUT to complete.
const AUTOSAVE_WAIT_MS = 12_000

// Unique names per run so a shared DB never collides across runs.
const ESTIMATE_NAME = `Shell Persistence Test ${Date.now().toString(36)}`
const ACTIVITY_NAME = 'Shell persistence activity'

test.describe('EstimAI persistence journey inside the shell (AC-4.1)', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('create estimate → save → reload list → reopen with content → delete', async ({
    page,
  }) => {
    // ── Step 1: Open EstimAI's list inside the shell ─────────────────────────
    // The shell `_authed` guard passes (seeded cookie); RemoteMount loads the
    // estimai remote; its inner router (basepath '/estimai') renders the list.
    await page.goto('/estimai/estimates')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 15_000 })

    // ── Step 2: Create a new estimate ────────────────────────────────────────
    const newBtn = page.getByRole('button', { name: '+ New estimate' })
    await expect(newBtn, 'New estimate button must be visible').toBeVisible({ timeout: 15_000 })
    await newBtn.click()

    await expect(page, 'Must navigate to the editor after create').toHaveURL(
      /\/estimai\/estimates\/[a-z0-9]+$/,
      { timeout: 15_000 },
    )

    // ── Step 3: Set a distinctive project name ───────────────────────────────
    const nameInput = page.getByPlaceholder('Project name…').first()
    await expect(nameInput, 'Project name input must be visible').toBeVisible({ timeout: 5_000 })
    await nameInput.click({ clickCount: 3 })
    await nameInput.pressSequentially(ESTIMATE_NAME)
    await expect(nameInput).toHaveValue(ESTIMATE_NAME, { timeout: 3_000 })

    // ── Step 4: Add an activity so there is non-trivial content ──────────────
    const blankBtn = page.getByRole('button', { name: 'Start with a blank estimate' })
    await expect(blankBtn, 'TemplatePicker "Start blank" must be visible').toBeVisible({
      timeout: 5_000,
    })
    await blankBtn.click()

    // Two "+ Add Activity" buttons exist (top + bottom of the table); target the first.
    const addActivityBtn = page.getByTitle('Add activity (Shift+N)').first()
    await expect(addActivityBtn, '"+ Add Activity" must be visible').toBeVisible({ timeout: 5_000 })
    await addActivityBtn.click()

    const activityInput = page.getByPlaceholder('Activity…').first()
    await expect(activityInput, 'Activity name input must appear').toBeVisible({ timeout: 5_000 })
    await activityInput.click({ clickCount: 3 })
    await activityInput.pressSequentially(ACTIVITY_NAME)
    await page.keyboard.press('Tab')

    // ── Step 5: Wait for the debounced auto-save (PUT /estimates/{id}) ────────
    const saveIndicator = page.locator('[aria-live="polite"]').first()
    await page.waitForResponse(
      (resp) => resp.url().includes('/estimates/') && resp.request().method() === 'PUT',
      { timeout: AUTOSAVE_WAIT_MS },
    )
    await expect(
      saveIndicator,
      'Save indicator must not show "Save failed" after the PUT',
    ).not.toContainText('Save failed')

    // ── Step 6: Reload the list; the estimate appears ────────────────────────
    await page.getByRole('button', { name: 'My Estimates' }).first().click()
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await page.waitForLoadState('networkidle')

    await expect(
      page.getByText(ESTIMATE_NAME),
      `Estimate "${ESTIMATE_NAME}" must appear in the list`,
    ).toBeVisible({ timeout: 15_000 })

    // ── Step 7: Reopen and verify persisted content ──────────────────────────
    const deleteBtnForRow = page.getByRole('button', {
      name: new RegExp(`Delete "${ESTIMATE_NAME}"`, 'i'),
    })
    await expect(deleteBtnForRow, 'Delete button for the row must be visible').toBeVisible({
      timeout: 5_000,
    })
    const openBtn = deleteBtnForRow.locator('..').getByRole('button', { name: 'Open' })
    await expect(openBtn, '"Open" button must be in the row').toBeVisible({ timeout: 5_000 })
    await openBtn.click()

    await expect(page, 'Must navigate to the editor on Open').toHaveURL(
      /\/estimai\/estimates\/[a-z0-9]+$/,
      { timeout: 15_000 },
    )

    const reopenedNameInput = page.getByPlaceholder('Project name…').first()
    await expect(
      reopenedNameInput,
      `Name must round-trip to "${ESTIMATE_NAME}" after reopen`,
    ).toHaveValue(ESTIMATE_NAME, { timeout: 10_000 })

    const activityInput2 = page.getByPlaceholder('Activity…').first()
    await expect(
      activityInput2,
      `Activity must round-trip to "${ACTIVITY_NAME}" after reopen`,
    ).toHaveValue(ACTIVITY_NAME, { timeout: 10_000 })

    await expect(
      page.getByText('Total Man/Days'),
      'MetricsBar must render computed values (proves useEstimator ran)',
    ).toBeVisible({ timeout: 10_000 })

    // ── Step 8: Delete the estimate ──────────────────────────────────────────
    await page.getByRole('button', { name: 'My Estimates' }).first().click()
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await page.waitForLoadState('networkidle')

    const deleteBtn = page.getByRole('button', {
      name: new RegExp(`Delete "${ESTIMATE_NAME}"`, 'i'),
    })
    await expect(deleteBtn, 'Delete button must be visible').toBeVisible({ timeout: 10_000 })
    await deleteBtn.click()

    const modal = page.locator('[data-testid="confirm-delete-modal"]')
    await expect(modal, 'ConfirmDeleteModal must open').toBeVisible({ timeout: 5_000 })
    await expect(modal, 'Modal must show the estimate name').toContainText(ESTIMATE_NAME)

    const confirmBtn = page.locator('[data-testid="confirm-delete-confirm"]')
    await expect(confirmBtn, 'Delete confirm button must be visible').toBeVisible()
    await confirmBtn.click()

    await expect(modal, 'Modal must close after confirming delete').not.toBeVisible({
      timeout: 10_000,
    })
    await expect(
      page.getByText(ESTIMATE_NAME),
      `Estimate "${ESTIMATE_NAME}" must be gone from the list after delete`,
    ).not.toBeVisible({ timeout: 10_000 })
  })

  test('cancelling delete leaves the estimate in the list', async ({ page }) => {
    const cancelTestName = `Shell Cancel Test ${Date.now().toString(36)}`

    await page.goto('/estimai/estimates')
    await page.waitForLoadState('networkidle')

    const newBtn = page.getByRole('button', { name: '+ New estimate' })
    await expect(newBtn).toBeVisible({ timeout: 15_000 })
    await newBtn.click()
    await expect(page).toHaveURL(/\/estimai\/estimates\/[a-z0-9]+$/, { timeout: 15_000 })

    const nameInput = page.getByPlaceholder('Project name…').first()
    await nameInput.click({ clickCount: 3 })
    await nameInput.pressSequentially(cancelTestName)

    await page.waitForResponse(
      (resp) => resp.url().includes('/estimates/') && resp.request().method() === 'PUT',
      { timeout: AUTOSAVE_WAIT_MS },
    )

    await page.getByRole('button', { name: 'My Estimates' }).first().click()
    await expect(page).toHaveURL(/\/estimai\/estimates$/, { timeout: 10_000 })
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(cancelTestName)).toBeVisible({ timeout: 15_000 })

    const deleteBtn = page.getByRole('button', {
      name: new RegExp(`Delete "${cancelTestName}"`, 'i'),
    })
    await expect(deleteBtn).toBeVisible({ timeout: 10_000 })
    await deleteBtn.click()

    const modal = page.locator('[data-testid="confirm-delete-modal"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Cancel the delete (the modal's dedicated Cancel control).
    await page.locator('[data-testid="confirm-delete-cancel"]').click()
    await expect(modal, 'Modal must close after cancelling').not.toBeVisible({ timeout: 5_000 })

    // The estimate must still be present.
    await expect(
      page.getByText(cancelTestName),
      'Cancelled delete must leave the estimate in the list',
    ).toBeVisible({ timeout: 10_000 })

    // Cleanup: delete the estimate so the shared DB stays tidy.
    await page
      .getByRole('button', { name: new RegExp(`Delete "${cancelTestName}"`, 'i') })
      .click()
    await expect(modal).toBeVisible()
    await page.locator('[data-testid="confirm-delete-confirm"]').click()
    await expect(modal).not.toBeVisible({ timeout: 10_000 })
  })
})
