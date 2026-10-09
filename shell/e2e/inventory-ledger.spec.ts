/**
 * T45 — Inventory ledger journey (specs/015-hardware-inventory).
 *
 * Drives the REAL assembled shell host + inventory-ui remote against the REAL
 * auth / inventory-api; nothing is mocked. A hardware accountant (the real
 * seeded `accounting` role, entity-scoped to the user's own entity) works one
 * fiscal year end to end:
 *
 *   1. sees an asset's depreciation schedule (AC-6.x on the asset page);
 *   2. disposes of an asset (AC-7.x), behind the irreversible-action dialog;
 *   3. opens the open year, which is marked provisional, and exports it: the
 *      file is marked provisional too (AC-8.9);
 *   4. closes the year (AC-8.4), and the closed roll-forward reconciles;
 *   5. exports the closed year (AC-8.8): an XLSX with one row per asset
 *      (purchase date, description, serial number, holder, purchase price,
 *      depreciation for the year, book value at year end) and the five
 *      roll-forward lines, no provisional marker.
 *
 * DATA AND WHY IT IS SAFE TO RE-RUN. Closing a year is irreversible (row-level
 * triggers, ADR-0046) and the `inventory` database is the one local dev uses, so
 * this spec never assumes a clean database. `pickClosableYear` (see
 * inventoryFixtures.ts) closes the next closable year of an entity, in order,
 * starting from 2020 and never past the current UTC year (that is a 409
 * `year_in_future`), and refuses a year that already holds an asset it did not
 * create. Each run therefore consumes one year of one entity: about 7 runs per
 * entity before the supply of years is exhausted, after which the spec FAILS with
 * an explicit message rather than skipping. inventory-api's own `bun test`
 * truncates these tables in its setup, so closed years left here never affect it,
 * and a `bun test` between runs simply resets the supply.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { seedUserSession, seedAdminSession, applySessionCookie } from './helpers/adminSession'
import {
  E2E_ASSET_PREFIX,
  grantInventoryRole,
  inventoryCall,
  pickClosableYear,
  registerAssetViaApi,
  type InventoryEntity,
} from './helpers/inventoryFixtures'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

const ENTITY_LABEL: Record<InventoryEntity, string> = { welld_ch: 'WellD CH', welld_it: 'WellD Italia' }
/** The ISO code, as the export prints it. */
const CURRENCY: Record<InventoryEntity, string> = { welld_ch: 'CHF', welld_it: 'EUR' }
/** How the UI suffixes an amount (inventory-ui lib/money.ts): `€` for EUR, the code for CHF. */
const SUFFIX: Record<InventoryEntity, string> = { welld_ch: 'CHF', welld_it: '€' }

/** The suite's money format (inventory-ui lib/money.ts): `1234,56 CHF`. */
const money = (cents: number, suffix: string) =>
  `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, '0')} ${suffix}`

interface FiscalYearView {
  status: 'open' | 'closed'
  currency: string
  rollForward: {
    openingCents: number
    disposalsCents: number
    purchasesCents: number
    depreciationCents: number
    closingCents: number
  }
  assets: {
    assetId: string
    description: string
    serialNumber: string | null
    purchasePriceCents: number
    depreciationCents: number
    closingCents: number
  }[]
}

/** Reads an XLSX the way the file is stored: every shared string plus every numeric cell value. */
function readWorkbook(file: string): { strings: string[]; numbers: number[] } {
  const part = (name: string) => {
    try {
      return execFileSync('unzip', ['-p', file, name], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
    } catch {
      return ''
    }
  }
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  const shared = part('xl/sharedStrings.xml')
  const sheet = part('xl/worksheets/sheet1.xml')
  const strings = [
    ...[...shared.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decode(m[1]!)),
    ...[...sheet.matchAll(/<is>\s*<t[^>]*>([^<]*)<\/t>/g)].map((m) => decode(m[1]!)),
  ]
  const numbers = [...sheet.matchAll(/<c ([^>]*)>\s*<v>(-?[\d.]+)<\/v>\s*<\/c>/g)]
    .filter((m) => !/\bt="(s|str|inlineStr)"/.test(m[1]!))
    .map((m) => Number(m[2]))
  return { strings, numbers }
}

test.describe('specs/015 T45: ledger journey', () => {
  test('an accountant sees the schedule, disposes, exports the open year, closes it and exports the closed year (AC-8.4/8.8/8.9)', async ({
    browser,
  }) => {
    const admin = await seedAdminSession(`inv-led-admin-${runId}@operai.test`, `Inv Ledger Admin ${runId}`)

    // ── Which entity and year may this run close without harming shared data? ──
    const today = new Date()
    const pick = await pickClosableYear(admin, today.getUTCFullYear())
    expect(
      pick,
      'no entity has a closable year that holds only e2e data: the supply of years (2020..current, per entity) is used up, ' +
        'or both entities hold real assets in their first open year. Run `cd inventory-api && direnv exec . bun test` ' +
        '(it truncates the inventory tables) or use a fresh inventory database.',
    ).not.toBeNull()
    const { entity, year } = pick!
    const currency = CURRENCY[entity]

    // ── Setup (API): the year's assets ─────────────────────────────────────────
    const kept = await registerAssetViaApi(admin, {
      entity,
      category: 'laptop',
      description: `${E2E_ASSET_PREFIX}ledger-kept-${runId}`,
      purchaseDate: `${year}-01-03`,
      totalPriceCents: 120000,
      serialNumbers: [`LK-${runId}`],
    })
    const sold = await registerAssetViaApi(admin, {
      entity,
      category: 'monitor',
      description: `${E2E_ASSET_PREFIX}ledger-disposed-${runId}`,
      purchaseDate: `${year}-01-02`,
      totalPriceCents: 45000,
      serialNumbers: [`LD-${runId}`],
    })
    const years = await inventoryCall<{ years: { year: number; closable: boolean; status: string }[] }>(
      admin,
      'GET',
      `/fiscal-years?entity=${entity}`,
    )
    expect(
      years.body.years.find((y) => y.year === year)?.closable,
      `precondition: ${entity} ${year} must be closable once its assets are registered`,
    ).toBe(true)

    // ── The accountant: the real seeded role, scoped to this entity ────────────
    const accountant = await seedUserSession(`inv-acc-${runId}@operai.test`, `Inv Accountant ${runId}`)
    grantInventoryRole(accountant.email, 'accounting', entity)
    const context = await browser.newContext({ acceptDownloads: true })
    await applySessionCookie(context, accountant)
    const page = await context.newPage()

    // 1. The depreciation schedule on the asset page (AC-6.x).
    await page.goto(`/inventory/assets/${kept.id}`)
    await expect(page.getByTestId('ledger-block')).toBeVisible({ timeout: 20_000 })
    const schedule = page.getByRole('table', { name: 'Depreciation schedule' })
    await expect(schedule).toBeVisible()
    await expect(schedule.getByRole('row', { name: new RegExp(`^${year}\\b`) })).toBeVisible()
    await expect(page.getByTestId('ledger-book-value')).toContainText(SUFFIX[entity])

    // 2. Dispose of the other asset (AC-7.x): the dialog states the consequence and needs an acknowledgement.
    await page.goto(`/inventory/assets/${sold.id}`)
    await page.getByRole('button', { name: 'Dispose...' }).click()
    const dispose = page.getByRole('alertdialog', { name: `Dispose of ${sold.description}?` })
    await expect(dispose).toBeVisible({ timeout: 20_000 })
    await expect(dispose).toContainText('This cannot be undone.')
    await dispose.getByLabel('Disposal date').fill(`${year}-01-04`)
    await dispose.getByRole('radio', { name: 'Scrapped' }).check()
    const confirmDispose = dispose.getByRole('button', { name: 'Dispose asset' })
    await dispose.getByRole('checkbox', { name: 'I understand this cannot be undone.' }).check()
    await confirmDispose.click()
    await expect(page.getByText('Asset disposed.')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('ledger-disposal')).toBeVisible()
    const disposed = await inventoryCall<{ status: string }>(admin, 'GET', `/assets/${sold.id}`)
    expect(disposed.body.status).toBe('disposed')

    // 3. The open year is provisional, and so is its export (AC-8.9).
    await page.goto('/inventory/years')
    const section = page.getByTestId(`fiscal-years-section-${entity}`)
    await expect(section).toBeVisible({ timeout: 20_000 })
    await section.getByRole('link', { name: `Open fiscal year ${year} for ${ENTITY_LABEL[entity]}` }).click()
    await expect(page.getByRole('heading', { name: `Fiscal year ${year}` })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('year-status')).toContainText('Open')
    await expect(page.getByText('Provisional: figures change until this year is closed.')).toBeVisible()

    const provisionalDownload = page.waitForEvent('download')
    await page.getByTestId('export-year-button').click()
    const provisionalFile = await provisionalDownload
    expect(provisionalFile.suggestedFilename()).toBe(`${entity}_fiscal-year-${year}_provisional.xlsx`)
    const dir = mkdtempSync(path.join(tmpdir(), 'inv-e2e-'))
    const provisionalPath = path.join(dir, 'provisional.xlsx')
    await provisionalFile.saveAs(provisionalPath)
    expect(readWorkbook(provisionalPath).strings).toContain('PROVISIONAL: figures change until this year is closed.')

    // 4. Close the year (AC-8.4): irreversible, so an acknowledgement is required.
    await page.getByRole('button', { name: `Close year ${year}` }).click()
    const closeDialog = page.getByRole('alertdialog', { name: `Close fiscal year ${year}?` })
    await expect(closeDialog).toBeVisible()
    await expect(closeDialog).toContainText('can never be reopened')
    await closeDialog.getByRole('checkbox', { name: 'I understand a closed year cannot be reopened.' }).check()
    await closeDialog.getByRole('button', { name: `Close ${year}` }).click()
    await expect(page.getByTestId('year-status')).toContainText('Closed', { timeout: 20_000 })
    await expect(page.getByText('Provisional: figures change until this year is closed.')).toHaveCount(0)
    await expect(page.getByRole('button', { name: `Close year ${year}` })).toHaveCount(0)

    // The stored, closed roll-forward is what the page shows, and it reconciles.
    const closed = await inventoryCall<FiscalYearView>(admin, 'GET', `/fiscal-years/${entity}/${year}`)
    expect(closed.body.status).toBe('closed')
    const rf = closed.body.rollForward
    expect(rf.closingCents).toBe(rf.openingCents - rf.disposalsCents + rf.purchasesCents - rf.depreciationCents)
    expect(rf.purchasesCents).toBeGreaterThanOrEqual(120000 + 45000)
    for (const cents of Object.values(rf)) {
      await expect(page.getByRole('table', { name: /Roll-forward of fiscal year/ })).toContainText(
        money(cents, SUFFIX[entity]),
      )
    }

    // 5. The closed year's export (AC-8.8): one row per asset and the five roll-forward lines.
    const closedDownload = page.waitForEvent('download')
    await page.getByTestId('export-year-button').click()
    const closedFile = await closedDownload
    expect(closedFile.suggestedFilename()).toBe(`${entity}_fiscal-year-${year}.xlsx`)
    const closedPath = path.join(dir, 'closed.xlsx')
    await closedFile.saveAs(closedPath)
    const sheet = readWorkbook(closedPath)
    expect(sheet.strings, 'a closed year is not marked provisional').not.toContain(
      'PROVISIONAL: figures change until this year is closed.',
    )
    for (const heading of [
      'Purchase date',
      'Description',
      'Serial number',
      'Holder',
      `Purchase price (${currency})`,
      `Depreciation for the year (${currency})`,
      `Book value at year end (${currency})`,
      `Roll-forward (${currency})`,
      'Opening book value',
      'Less disposals',
      'Plus purchases',
      'Less depreciation',
      'Closing book value',
    ]) {
      expect(sheet.strings, `the export must contain the heading "${heading}"`).toContain(heading)
    }
    // one row per asset: our two (and any other of that year), with their serials
    expect(closed.body.assets.length).toBeGreaterThanOrEqual(2)
    for (const asset of closed.body.assets) {
      expect(sheet.strings).toContain(asset.description)
      if (asset.serialNumber !== null) expect(sheet.strings).toContain(asset.serialNumber)
      expect(sheet.numbers).toContain(asset.purchasePriceCents / 100)
      expect(sheet.numbers).toContain(asset.closingCents / 100)
    }
    for (const asset of [kept, sold]) {
      expect(closed.body.assets.map((a) => a.assetId)).toContain(asset.id)
    }
    for (const cents of [
      rf.openingCents,
      rf.disposalsCents,
      rf.purchasesCents,
      rf.depreciationCents,
      rf.closingCents,
    ]) {
      expect(sheet.numbers, `the roll-forward line ${cents} must be in the file`).toContain(cents / 100)
    }

    await context.close()
  })
})
