/**
 * T45 — Inventory assignment journeys (specs/015-hardware-inventory).
 *
 * Drives the REAL assembled shell host + inventory-ui remote (ADR-0006/0045)
 * against the REAL auth / inventory-api / notify-api. Nothing is mocked or
 * stubbed.
 *
 * Journey 1 (AC-2.3, AC-4.1, AC-9.6): an inventory manager registers a device
 * through the form and assigns it to an employee who holds NO grant at all. The
 * employee has no Inventory entry in the navigation, `/inventory` sends them to
 * `/no-access`, yet `/devices` (the ungated second federated entry, ADR-0045)
 * lists the offered device with its description, category, serial number and
 * date and no price, and confirming it makes the employee the holder, which the
 * manager then sees on the asset.
 *
 * Journey 2 (AC-2.8, AC-2.9 and AC-2.4): the same people, through the
 * notification centre. The assignee finds the "waiting for your confirmation"
 * notification in the shell bell, follows its link to `/devices` and confirms;
 * the manager who created the assignment is told it was confirmed. A second
 * assignment is declined, and the manager is told that. These two ACs depend on
 * inventory-api's scoped service-JWT push to notify-api (ADR-0044); see the
 * `E2E_INVENTORY_PUSH` note on the test.
 *
 * Fixtures: inventoryFixtures.ts grants the REAL `inventory-manager` role and
 * the user's entity (the same Role/UserRole rows an admin would write), so
 * inventory-api's live `GET /authz/resolve` resolves it like production.
 *
 * Data written: users `inv-*@operai.test` (auth DB) and assets whose
 * descriptions start with `e2e-` (inventory DB) on welld_ch. Nothing here closes
 * a fiscal year. The assets are dated in the first year still open
 * (`openRegistrationYear`), because inventory-ledger.spec.ts closes years for good
 * and a date in a closed year is refused; inventory-api's own tests truncate.
 */
import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { seedUserSession, seedAdminSession, applySessionCookie, type SeededSession } from './helpers/adminSession'
import {
  E2E_ASSET_PREFIX,
  fetchNotifications,
  grantInventoryRole,
  inventoryCall,
  openRegistrationYear,
  registerAssetViaApi,
} from './helpers/inventoryFixtures'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
/** Set in beforeAll: a date in a year that is still open (the ledger journey closes years for good). */
let PURCHASE_DATE = ''

const MANAGER_NAME = `Inv Manager ${runId}`
const EMPLOYEE_NAME = `Inv Employee ${runId}`

async function inContext(browser: Browser, session: SeededSession): Promise<BrowserContext> {
  const context = await browser.newContext()
  await applySessionCookie(context, session)
  return context
}

async function seedPeople(): Promise<{ manager: SeededSession; employee: SeededSession }> {
  const manager = await seedUserSession(`inv-mgr-${runId}@operai.test`, MANAGER_NAME)
  // The grant must exist BEFORE the first resolve; the token minted above carries
  // identity only (ADR-0007), so there is nothing to re-mint.
  grantInventoryRole(manager.email, 'inventory-manager', 'welld_ch')
  // The assignee: a signed-in user with no role beyond the baseline `employee`.
  const employee = await seedUserSession(`inv-emp-${runId}@operai.test`, EMPLOYEE_NAME)
  return { manager, employee }
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/015 T45: assignment journeys', () => {
  let manager: SeededSession
  let employee: SeededSession

  test.beforeAll(async () => {
    ;({ manager, employee } = await seedPeople())
    const admin = await seedAdminSession(`inv-asg-admin-${runId}@operai.test`, `Inv Assign Admin ${runId}`)
    PURCHASE_DATE = `${await openRegistrationYear(admin, 'welld_ch', new Date().getUTCFullYear())}-01-15`
  })

  test('Journey 1 — manager registers and assigns; an employee with zero grants confirms on /devices (AC-2.3/4.1/9.6)', async ({
    browser,
  }) => {
    const description = `${E2E_ASSET_PREFIX}laptop-${runId}`
    const serial = `SN-${runId}`

    // ── The manager registers the device through the form (AC-1.1) ───────────
    const managerCtx = await inContext(browser, manager)
    const mgr = await managerCtx.newPage()
    await mgr.goto('/inventory/assets/new')
    await expect(mgr.getByRole('heading', { name: 'Register asset' })).toBeVisible({ timeout: 20_000 })
    await mgr.getByLabel(/^Category/).selectOption({ label: 'Laptop' })
    await mgr.getByLabel(/^Description/).fill(description)
    await mgr.getByLabel(/^Purchase date/).fill(PURCHASE_DATE)
    await mgr.getByLabel(/^Total price/).fill('1200')
    await mgr.getByLabel(/^Serial number/).fill(serial)
    await mgr.getByRole('button', { name: 'Register asset' }).click()

    // Registered: the asset's own page, with its actions.
    await expect(mgr.getByText('Asset registered.')).toBeVisible({ timeout: 20_000 })
    await expect(mgr).toHaveURL(/\/inventory\/assets\/[^/]+$/)
    const assetId = mgr.url().split('/').pop()!

    // ── ...and assigns it to the employee (AC-2.1) ───────────────────────────
    await mgr.getByRole('button', { name: 'Assign...' }).click()
    const dialog = mgr.getByRole('dialog', { name: 'Assign asset' })
    await dialog.getByRole('combobox', { name: 'Holder' }).fill(EMPLOYEE_NAME)
    await dialog.getByRole('option', { name: new RegExp(EMPLOYEE_NAME) }).click()
    await dialog.getByRole('button', { name: 'Assign', exact: true }).click()
    await expect(mgr.getByText(`Awaiting confirmation from ${EMPLOYEE_NAME}`).first()).toBeVisible({
      timeout: 20_000,
    })

    // The asset is still in stock until the employee confirms (AC-2.1).
    const pending = await inventoryCall<{ status: string; holder: unknown }>(manager, 'GET', `/assets/${assetId}`)
    expect(pending.body.status).toBe('in_stock')

    // ── The employee: no grants, so no Inventory in the navigation (AC-9.6) ──
    const employeeCtx = await inContext(browser, employee)
    const emp = await employeeCtx.newPage()
    await emp.goto('/')
    await expect(emp).toHaveURL(/\/no-access$/, { timeout: 20_000 })
    await expect(emp.getByRole('link', { name: 'Inventory' })).toHaveCount(0)
    // The one inventory entry they do have: "My devices" in the user menu.
    await emp.getByRole('button', { name: EMPLOYEE_NAME }).click()
    await expect(emp.getByRole('menuitem', { name: 'My devices' })).toBeVisible()
    await emp.keyboard.press('Escape')

    // The tool itself is not reachable by URL either (AC-9.6).
    await emp.goto('/inventory')
    await expect(emp).toHaveURL(/\/no-access$/, { timeout: 20_000 })

    // ── ...but their devices view works with zero grants (AC-4.1) ────────────
    await emp.goto('/devices')
    await expect(emp.getByTestId('devices-heading')).toBeVisible({ timeout: 20_000 })
    await expect(emp).toHaveURL(/\/devices$/)
    const card = emp.getByTestId('device-card').filter({ hasText: description })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(emp.getByRole('heading', { name: /Waiting for your confirmation \(1\)/ })).toBeVisible()
    // description, category, serial number and the offered date; no money (AC-4.1/4.2)
    await expect(card).toContainText('Laptop')
    await expect(card).toContainText(serial)
    await expect(card).toContainText(/offered /)
    await expect(card).not.toContainText(/1[ '’.,]?200|CHF|EUR|price|book value|depreciation/i)

    // ── Confirm (AC-2.3) ─────────────────────────────────────────────────────
    await card.getByRole('button', { name: 'I have received this device' }).click()
    await expect(emp.getByText(`Confirmed: ${description}`)).toBeVisible({ timeout: 20_000 })
    const held = emp.getByRole('heading', { name: /Devices I hold \(1\)/ })
    await expect(held).toBeVisible()
    await expect(emp.getByTestId('device-card').filter({ hasText: description })).toContainText(/assigned /)
    await expect(emp.getByRole('heading', { name: /Waiting for your confirmation/ })).toHaveCount(0)

    // ── The manager sees the employee as the holder (AC-2.3) ─────────────────
    await mgr.reload()
    await expect(mgr.getByText(EMPLOYEE_NAME).first()).toBeVisible({ timeout: 20_000 })
    const confirmed = await inventoryCall<{ status: string }>(manager, 'GET', `/assets/${assetId}`)
    expect(confirmed.body.status).toBe('assigned')

    await managerCtx.close()
    await employeeCtx.close()
  })

  test('Journey 3 — the assignee declines on /devices: the asset is back in stock and can be assigned again; nobody else can answer (AC-2.4/2.7)', async ({
    browser,
  }) => {
    const asset = await registerAssetViaApi(manager, {
      entity: 'welld_ch',
      category: 'tablet',
      description: `${E2E_ASSET_PREFIX}decline-${runId}`,
      purchaseDate: PURCHASE_DATE,
      totalPriceCents: 60000,
    })
    const first = await inventoryCall<{ pendingAssignment: { id: string } | null }>(
      manager,
      'POST',
      `/assets/${asset.id}/assignments`,
      { assigneeUserId: employee.userId },
    )
    const assignmentId = first.body.pendingAssignment?.id
    expect(assignmentId, 'the assignment view must expose the pending assignment id').toBeTruthy()

    // AC-2.7: any user other than the assignee is refused by the server (and, per
    // ADR-0045, told it does not exist).
    const outsider = await seedUserSession(`inv-out-${runId}@operai.test`, `Inv Outsider ${runId}`)
    const refused = await inventoryCall(outsider, 'POST', `/me/assignments/${assignmentId}/confirm`, undefined, [404])
    expect(refused.status).toBe(404)
    const stillOffered = await inventoryCall<{ status: string }>(manager, 'GET', `/assets/${asset.id}`)
    expect(stillOffered.body.status).toBe('in_stock')

    // AC-2.4: the assignee declines through the UI, behind a confirmation.
    const employeeCtx = await inContext(browser, employee)
    const emp = await employeeCtx.newPage()
    await emp.goto('/devices')
    const card = emp.getByTestId('device-card').filter({ hasText: asset.description })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: /^Decline\b/ }).click()
    const dialog = emp.getByRole('alertdialog', { name: `Decline ${asset.description}?` })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Decline device' }).click()
    await expect(emp.getByText(`Declined: ${asset.description}`)).toBeVisible({ timeout: 20_000 })
    await expect(emp.getByTestId('device-card').filter({ hasText: asset.description })).toHaveCount(0)

    // Back in stock with no holder, and assignable again.
    const back = await inventoryCall<{ status: string; holder: unknown }>(manager, 'GET', `/assets/${asset.id}`)
    expect(back.body.status).toBe('in_stock')
    expect(back.body.holder).toBeNull()
    await inventoryCall(manager, 'POST', `/assets/${asset.id}/assignments`, { assigneeUserId: employee.userId })

    await employeeCtx.close()
  })

  // AC-2.8 / AC-2.9 need the notification push of ADR-0044, which only works when
  // `auth` has SERVICE_AUDIENCE + SERVICE_CLIENTS, `notify-api` has SERVICE_AUDIENCE
  // and `inventory-api` has SERVICE_CLIENT_ID + SERVICE_CLIENT_SECRET (a client
  // `auth` knows). Without them the push fails soft (the assignment still
  // succeeds) and the notification never exists, so this test fails on its
  // missing-notification assertion rather than passing vacuously. On a machine
  // that has deliberately not configured them, set E2E_INVENTORY_PUSH=unconfigured:
  // the test is then reported as fixme with this reason, never silently green.
  test('Journey 2 — the assignee is notified, follows the link and confirms; the manager is told; a decline is announced too (AC-2.8/2.9/2.4)', async ({
    browser,
  }) => {
    test.fixme(
      process.env['E2E_INVENTORY_PUSH'] === 'unconfigured',
      'BLOCKED on env: auth SERVICE_AUDIENCE + SERVICE_CLIENTS and notify-api SERVICE_AUDIENCE are unset, so inventory-api cannot push (ADR-0044).',
    )

    const confirmedAsset = await registerAssetViaApi(manager, {
      entity: 'welld_ch',
      category: 'laptop',
      description: `${E2E_ASSET_PREFIX}notify-confirm-${runId}`,
      purchaseDate: PURCHASE_DATE,
      totalPriceCents: 150000,
    })
    const declinedAsset = await registerAssetViaApi(manager, {
      entity: 'welld_ch',
      category: 'phone',
      description: `${E2E_ASSET_PREFIX}notify-decline-${runId}`,
      purchaseDate: PURCHASE_DATE,
      totalPriceCents: 80000,
    })

    const managerCtx = await inContext(browser, manager)
    const employeeCtx = await inContext(browser, employee)
    const mgr = await managerCtx.newPage()
    const emp = await employeeCtx.newPage()
    // Both people are signed in and listening (SSE) before anything happens.
    await mgr.goto('/inventory/assets')
    await emp.goto('/no-access')
    await expect(emp.getByRole('link', { name: 'Notifications' })).toBeVisible({ timeout: 20_000 })

    // ── AC-2.8: assigning notifies the assignee, with a link ─────────────────
    for (const asset of [confirmedAsset, declinedAsset]) {
      await inventoryCall(manager, 'POST', `/assets/${asset.id}/assignments`, { assigneeUserId: employee.userId })
    }
    await expect
      .poll(
        async () =>
          (await fetchNotifications(employee.token)).filter(
            (n) =>
              n.title === 'A device is waiting for your confirmation' &&
              // Scoped to THIS journey's two assets: the same employee is also offered
              // devices by Journey 1 and Journey 3, which run first.
              [confirmedAsset.description, declinedAsset.description].some((d) => n.body.includes(d)),
          ).length,
        {
          timeout: 20_000,
          message: 'AC-2.8: the assignee must receive an in-app notification for each assignment',
        },
      )
      .toBe(2)

    await emp.getByRole('link', { name: 'Notifications' }).click()
    await expect(emp).toHaveURL(/\/notify$/)
    const offer = emp
      .getByRole('link', { name: /A device is waiting for your confirmation/ })
      .filter({ hasText: confirmedAsset.description })
    await expect(offer).toBeVisible({ timeout: 20_000 })
    await offer.click()
    await expect(emp).toHaveURL(/\/devices$/, { timeout: 20_000 })

    // ── confirm one (AC-2.3) ─────────────────────────────────────────────────
    await emp
      .getByTestId('device-card')
      .filter({ hasText: confirmedAsset.description })
      .getByRole('button', { name: 'I have received this device' })
      .click()
    await expect(emp.getByText(`Confirmed: ${confirmedAsset.description}`)).toBeVisible({ timeout: 20_000 })

    // ── decline the other (AC-2.4) ───────────────────────────────────────────
    await emp
      .getByTestId('device-card')
      .filter({ hasText: declinedAsset.description })
      .getByRole('button', { name: /^Decline\b/ })
      .click()
    await emp.getByRole('alertdialog').getByRole('button', { name: 'Decline device' }).click()
    await expect(emp.getByText(`Declined: ${declinedAsset.description}`)).toBeVisible({ timeout: 20_000 })

    // ── AC-2.9: the manager who created the assignments is told which ───────
    // Scoped to THIS journey's two assets: the manager is also told about Journey 1's
    // confirmation and Journey 3's decline.
    const thisJourneyLinks = new Set([
      `/inventory/assets/${confirmedAsset.id}`,
      `/inventory/assets/${declinedAsset.id}`,
    ])
    await expect
      .poll(
        async () =>
          (await fetchNotifications(manager.token))
            .filter((n) => n.link && thisJourneyLinks.has(n.link.href))
            .map((n) => n.title)
            .sort(),
        {
          timeout: 20_000,
          message: 'AC-2.9: the manager must be notified of both the confirmation and the decline',
        },
      )
      .toEqual(['Assignment confirmed', 'Assignment declined'])

    await mgr.getByRole('link', { name: 'Notifications' }).click()
    await expect(mgr).toHaveURL(/\/notify$/)
    const confirmedNote = mgr
      .getByRole('link', { name: /Assignment confirmed/ })
      .filter({ hasText: EMPLOYEE_NAME })
      .filter({ hasText: confirmedAsset.description })
    const declinedNote = mgr
      .getByRole('link', { name: /Assignment declined/ })
      .filter({ hasText: EMPLOYEE_NAME })
      .filter({ hasText: declinedAsset.description })
    await expect(confirmedNote).toBeVisible({ timeout: 20_000 })
    await expect(declinedNote).toBeVisible()
    // each links to the asset it concerns
    await expect(confirmedNote).toHaveAttribute('href', `/inventory/assets/${confirmedAsset.id}`)
    await expect(declinedNote).toHaveAttribute('href', `/inventory/assets/${declinedAsset.id}`)

    // the declined asset is back in stock and assignable (AC-2.4)
    const back = await inventoryCall<{ status: string }>(manager, 'GET', `/assets/${declinedAsset.id}`)
    expect(back.body.status).toBe('in_stock')

    await managerCtx.close()
    await employeeCtx.close()
  })
})
