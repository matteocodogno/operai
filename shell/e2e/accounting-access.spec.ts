/**
 * e2e of who may do what in Accounting (specs/20261119-accounting, T41; plan § Local development and e2e).
 *
 * The REAL stack: every person is made the way an administrator makes one, through auth's admin API (helpers/accountingFixtures.ts
 * `setUpAccountingPeople`, AC-3.1), and accounting-api and the shell enforce what they hold. Every refusal is also asked of the API
 * directly with the person's own token, whatever the screen shows.
 *
 *   AC-3.4  a reader sees the lists and one quiet sentence, no write control anywhere; a direct add, deactivate, correction or
 *           fetch answers 403 `accounting_manage_required`, and nothing changed
 *   AC-3.5  a manager limited to WellD CH sees no switcher, WellD CH's entries, and WellD Italia as an unknown address: the address
 *           `?entity=welld_it` shows the not-found view, `?entity=xyz` falls back to WellD CH, and every direct request for WellD
 *           Italia answers 404 with the body of an entity that does not exist
 *   AC-3.6  a person with neither capability sees no menu entry, is turned away at /accounting, and the remote never calls the API;
 *           a direct request answers 403 `accounting_forbidden`
 *   AC-8.1  a reader and a manager each find Accounting in the menu and open it from there (in Italian too, "Contabilità")
 *   AC-8.4  `axeViolations` is 0 on a reader's lists (light and dark) and on the denied state
 *
 * The administrator, the switcher and WellD Italia's empty states are accounting.spec.ts.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { applySessionCookie } from './helpers/adminSession'
import {
  accountingCall,
  createLedgerAccount,
  setUpAccountingPeople,
  uniqueAccountNumber,
  uniqueVatCode,
  unusedPastMonth,
  type AccountingPeople,
  type LedgerAccount,
  type SeededSession,
} from './helpers/accountingFixtures'
import { axeViolations } from './helpers/meetingsFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = Date.now().toString(36)

let people: AccountingPeople

test.beforeAll(async () => {
  test.setTimeout(180_000)
  people = await setUpAccountingPeople()
})

const toolNav = (page: Page) => page.getByRole('navigation', { name: 'Tool navigation' })

async function signedIn(
  browser: Browser,
  session: SeededSession,
  locale = 'en-US',
  colorScheme: 'light' | 'dark' = 'light',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale, viewport: { width: 1440, height: 1000 } })
  await applySessionCookie(context, session)
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme })
  return { context, page }
}

async function expectNoAxeViolations(page: Page, label: string, include = 'main'): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))))
  const violations = await axeViolations(page, include)
  expect(
    violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)} ${String((n as { failureSummary?: string }).failureSummary ?? '').replace(/\s+/g, ' ')}`)
          .join(' | ')}`,
    ),
    `axe violations on ${label}`,
  ).toEqual([])
}

async function openView(page: Page, view: 'ledger-accounts' | 'vat-codes' | 'exchange-rates', entity: 'welld_ch' | 'welld_it'): Promise<void> {
  await page.goto(`/accounting/${view}?entity=${entity}`)
  await expect(page.getByTestId('accounting-shell')).toBeVisible({ timeout: 30_000 })
}

interface Problem {
  code?: string
  title?: string
  detail?: string
  instance?: string
}

/** What an entity that does not exist answers; the body of a covered-nowhere entity must be this one (AC-3.5). */
const sameAsUnknown = (body: Problem): Omit<Problem, 'instance'> => ({ code: body.code, title: body.title, detail: body.detail })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261119-accounting T41: a person without a grant (AC-3.6, AC-8.1)', () => {
  test('sees no menu entry, is turned away at /accounting, the remote never calls the API, and the API says no (AC-3.6, AC-8.1)', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const { context, page } = await signedIn(browser, people.nobody)
    const toService: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).origin === new URL(process.env['E2E_ACCOUNTING_API_URL'] ?? process.env['VITE_ACCOUNTING_API_URL'] ?? 'http://localhost:8089').origin) {
        toService.push(request.url())
      }
    })

    await page.goto('/')
    await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })
    await expect(toolNav(page).getByRole('link', { name: 'Accounting', exact: true })).toHaveCount(0)

    // The route is refused, a deep link below it the same way; the tool never renders.
    for (const path of ['/accounting', '/accounting/ledger-accounts?entity=welld_ch', '/accounting/exchange-rates?month=2026-03']) {
      await page.goto(path)
      await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => new URL(page.url()).pathname, { message: `${path} is left` }).not.toMatch(/^\/accounting/)
      await expect(page.getByRole('heading', { name: 'Accounting', level: 1 })).toHaveCount(0)
      await expect(page.getByTestId('accounting-shell')).toHaveCount(0)
    }
    expect(toService).toEqual([])

    // And the service itself says no, whatever the shell does: the token is real, the capability is not. No reference data in the body.
    for (const path of ['/v1/entities/welld_ch/ledger-accounts', '/v1/entities/welld_ch/vat-codes', '/v1/entities/welld_ch/exchange-rates', '/v1/entities/welld_it/ledger-accounts']) {
      const read = await accountingCall<Problem>(people.nobody.token, 'GET', path)
      expect(read.status, `GET ${path}`).toBe(403)
      expect(read.body.code, `GET ${path}`).toBe('accounting_forbidden')
      expect(JSON.stringify(read.body)).not.toContain('"items"')
    }
    const write = await accountingCall<Problem>(people.nobody.token, 'POST', '/v1/entities/welld_ch/ledger-accounts', {
      number: uniqueAccountNumber(),
      name: `Refused ${RUN}`,
    })
    expect(write.status).toBe(403)
    // No token at all: the one identical 401.
    expect((await accountingCall(null, 'GET', '/v1/entities/welld_ch/ledger-accounts')).status).toBe(401)
    await context.close()
  })

  test('the denied state of the remote itself is announced and has no axe violation (AC-8.4)', async ({ browser }) => {
    test.setTimeout(120_000)
    // The shell would not mount the remote for this person: the state is reached the way it is in life, a grant withdrawn
    // while the page is open, by answering the one /v1/me read with the refusal the service gives.
    const { context, page } = await signedIn(browser, people.reader)
    await page.route(/\/v1\/me$/, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'No access', instance: '/v1/me', code: 'accounting_forbidden' }),
      }),
    )
    await openView(page, 'ledger-accounts', 'welld_ch')
    const denied = page.getByRole('alert').filter({ hasText: 'No access to Accounting' })
    await expect(denied).toBeVisible({ timeout: 30_000 })
    await expect(denied).toContainText('Ask an administrator to give you access.')
    await expect(page.getByRole('navigation', { name: 'Accounting sections' })).toHaveCount(0)
    await expectNoAxeViolations(page, 'the denied state')
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261119-accounting T41: a reader (AC-3.4, AC-8.1, AC-8.4)', () => {
  let account: LedgerAccount
  let vatCode: string
  let month: string

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    // Something to refuse a change of: an account, a VAT code, a month without a USD rate (the admin's token writes them).
    account = await createLedgerAccount(people.admin.token, { number: uniqueAccountNumber(), name: `E2E reader account ${RUN}` })
    vatCode = uniqueVatCode()
    const created = await accountingCall(people.admin.token, 'POST', '/v1/entities/welld_ch/vat-codes', {
      code: vatCode,
      label: `E2E reader VAT ${RUN}`,
      ratePercent: '2.6',
    })
    expect(created.status).toBe(201)
    month = await unusedPastMonth(people.admin.token, { currency: 'GBP' })
  })

  test('finds Accounting in the menu, reads the three lists, sees no write control and one quiet sentence (AC-8.1, AC-3.4)', async ({
    browser,
  }) => {
    test.setTimeout(150_000)
    const { context, page } = await signedIn(browser, people.reader)
    await page.goto('/')
    await toolNav(page).getByRole('link', { name: 'Accounting', exact: true }).click({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/accounting\/ledger-accounts/, { timeout: 30_000 })

    await openView(page, 'ledger-accounts', 'welld_ch')
    await expect(page.getByTestId(`accounting-ledger-row-${account.number}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('accounting-ledger-read-only')).toContainText('You can view this list. Accounting managers add and deactivate accounts.')
    await expect(page.getByTestId('accounting-ledger-add')).toHaveCount(0)
    await expect(page.locator('[data-testid^="accounting-ledger-deactivate-"], [data-testid^="accounting-ledger-reactivate-"]')).toHaveCount(0)
    // One entity-wide grant covers both entities: the switcher is there for a reader too (AC-8.2).
    await expect(page.getByTestId('accounting-entity-select')).toBeVisible()

    await openView(page, 'vat-codes', 'welld_ch')
    await expect(page.getByTestId(`accounting-vat-row-${vatCode}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('accounting-vat-read-only')).toContainText('add and deactivate VAT codes')
    await expect(page.getByTestId('accounting-vat-add')).toHaveCount(0)
    await expect(page.locator('[data-testid^="accounting-vat-deactivate-"], [data-testid^="accounting-vat-reactivate-"]')).toHaveCount(0)

    await openView(page, 'exchange-rates', 'welld_ch')
    await expect(page.getByTestId(`accounting-fx-cell-${month}-GBP`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('accounting-fx-read-only')).toContainText('fetch and correct rates')
    await expect(page.getByTestId('accounting-fx-fetch-now')).toHaveCount(0)
    await expect(page.locator('[data-testid^="accounting-fx-correct-"]')).toHaveCount(0)
    await context.close()
  })

  test('has no axe violation on the lists, in light and dark, English and Italian (AC-8.4)', async ({ browser }) => {
    test.setTimeout(180_000)
    for (const { locale, scheme, title } of [
      { locale: 'en-US', scheme: 'light', title: 'Accounting' },
      { locale: 'en-US', scheme: 'dark', title: 'Accounting' },
      { locale: 'it-IT', scheme: 'light', title: 'Contabilità' },
      { locale: 'it-IT', scheme: 'dark', title: 'Contabilità' },
    ] as const) {
      const { context, page } = await signedIn(browser, people.reader, locale, scheme)
      await openView(page, 'ledger-accounts', 'welld_ch')
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId(`accounting-ledger-row-${account.number}`)).toBeVisible({ timeout: 30_000 })
      await expectNoAxeViolations(page, `ledger accounts, reader, ${locale} ${scheme}`)
      await openView(page, 'vat-codes', 'welld_ch')
      await expect(page.getByTestId(`accounting-vat-row-${vatCode}`)).toBeVisible({ timeout: 30_000 })
      await expectNoAxeViolations(page, `VAT codes, reader, ${locale} ${scheme}`)
      await openView(page, 'exchange-rates', 'welld_ch')
      await expect(page.getByTestId('accounting-fx-table')).toBeVisible({ timeout: 30_000 })
      await expectNoAxeViolations(page, `exchange rates, reader, ${locale} ${scheme}`)
      await context.close()
    }
  })

  test('a direct add, deactivation, correction or fetch is refused 403 and nothing changes (AC-3.4)', async () => {
    const before = await accountingCall<{ items: LedgerAccount[] }>(people.reader.token, 'GET', '/v1/entities/welld_ch/ledger-accounts')
    expect(before.status).toBe(200)
    const count = before.body.items.length
    const refusedNumber = uniqueAccountNumber()

    const attempts: Array<{ what: string; method: string; path: string; body?: unknown }> = [
      { what: 'add an account', method: 'POST', path: '/v1/entities/welld_ch/ledger-accounts', body: { number: refusedNumber, name: 'Refused' } },
      { what: 'deactivate an account', method: 'POST', path: `/v1/entities/welld_ch/ledger-accounts/${account.number}/deactivate` },
      { what: 'add a VAT code', method: 'POST', path: '/v1/entities/welld_ch/vat-codes', body: { code: uniqueVatCode(), label: 'Refused', ratePercent: '1' } },
      { what: 'deactivate a VAT code', method: 'POST', path: `/v1/entities/welld_ch/vat-codes/${vatCode}/deactivate` },
      { what: 'correct a rate', method: 'PUT', path: `/v1/entities/welld_ch/exchange-rates/${month}/GBP`, body: { rate: '1.1000' } },
      { what: 'ask for a fetch', method: 'POST', path: '/v1/entities/welld_ch/exchange-rates/fetch', body: {} },
    ]
    for (const attempt of attempts) {
      const result = await accountingCall<Problem>(people.reader.token, attempt.method, attempt.path, attempt.body)
      expect(result.status, `a reader tries to ${attempt.what}`).toBe(403)
      expect(result.body.code, `a reader tries to ${attempt.what}`).toBe('accounting_manage_required')
    }

    // Nothing changed: the same accounts, the one still active, no number added, the month still without a GBP rate.
    const after = await accountingCall<{ items: LedgerAccount[] }>(people.reader.token, 'GET', '/v1/entities/welld_ch/ledger-accounts')
    expect(after.body.items).toHaveLength(count)
    expect(after.body.items.find((item) => item.number === account.number)?.active).toBe(true)
    expect(after.body.items.some((item) => item.number === refusedNumber)).toBe(false)
    const rates = await accountingCall<{ months: Array<{ month: string; rates: Record<string, { status: string }> }> }>(
      people.reader.token,
      'GET',
      '/v1/entities/welld_ch/exchange-rates',
    )
    expect(rates.body.months.find((row) => row.month === month)?.rates['GBP']?.status).toBe('missing')
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261119-accounting T41: a manager limited to WellD CH (AC-3.5, AC-8.2)', () => {
  test('sees only WellD CH, no switcher; WellD Italia is not found and an unknown entity falls back (AC-3.5, AC-8.2)', async ({ browser }) => {
    test.setTimeout(150_000)
    const { context, page } = await signedIn(browser, people.chManager)
    await page.goto('/')
    await toolNav(page).getByRole('link', { name: 'Accounting', exact: true }).click({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/accounting\/ledger-accounts/, { timeout: 30_000 })

    await openView(page, 'ledger-accounts', 'welld_ch')
    await expect(page.getByRole('heading', { name: 'Ledger accounts — WellD CH' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('accounting-ledger-add')).toBeVisible()
    // One entity: nothing to switch, and the titles still name it.
    await expect(page.getByTestId('accounting-entity-switch')).toHaveCount(0)

    // WellD Italia is not covered: the address shows the not-found view, with the focus on it, and no list of Italia is asked of the page.
    await openView(page, 'ledger-accounts', 'welld_it')
    const notFound = page.getByTestId('accounting-not-found')
    await expect(notFound).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('accounting-not-found-heading')).toContainText('This page does not exist')
    await expect(page.getByTestId('accounting-ledger-card')).toHaveCount(0)
    await expectNoAxeViolations(page, 'the not-found view of an uncovered entity')

    // An address that is not an entity falls back to the one entity covered, rewritten in the address.
    await openView(page, 'ledger-accounts', 'welld_ch')
    await page.goto('/accounting/ledger-accounts?entity=xyz')
    await expect(page).toHaveURL(/entity=welld_ch/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Ledger accounts — WellD CH' })).toBeVisible({ timeout: 30_000 })
    await context.close()
  })

  test('every direct request for WellD Italia is refused as if it did not exist, and WellD CH can be changed (AC-3.5)', async () => {
    const token = people.chManager.token
    const unknown = await accountingCall<Problem>(token, 'GET', '/v1/entities/welld_xx/ledger-accounts')
    expect(unknown.status).toBe(404)

    const attempts: Array<{ what: string; method: string; path: string; body?: unknown }> = [
      { what: 'list accounts', method: 'GET', path: '/v1/entities/welld_it/ledger-accounts' },
      { what: 'list VAT codes', method: 'GET', path: '/v1/entities/welld_it/vat-codes' },
      { what: 'list rates', method: 'GET', path: '/v1/entities/welld_it/exchange-rates' },
      { what: 'add an account', method: 'POST', path: '/v1/entities/welld_it/ledger-accounts', body: { number: uniqueAccountNumber(), name: 'Refused' } },
      { what: 'add a VAT code', method: 'POST', path: '/v1/entities/welld_it/vat-codes', body: { code: uniqueVatCode(), label: 'Refused', ratePercent: '1' } },
      { what: 'deactivate an account', method: 'POST', path: '/v1/entities/welld_it/ledger-accounts/5905/deactivate' },
      { what: 'correct a rate', method: 'PUT', path: '/v1/entities/welld_it/exchange-rates/2026-03/EUR', body: { rate: '1.1000' } },
      { what: 'ask for a fetch', method: 'POST', path: '/v1/entities/welld_it/exchange-rates/fetch', body: {} },
    ]
    for (const attempt of attempts) {
      const result = await accountingCall<Problem>(token, attempt.method, attempt.path, attempt.body)
      expect(result.status, `a CH-only manager tries to ${attempt.what} at WellD Italia`).toBe(404)
      expect(sameAsUnknown(result.body), `the body of ${attempt.what}`).toEqual(sameAsUnknown(unknown.body))
    }

    // WellD Italia stayed empty of what was refused, and the grant does cover WellD CH, with manage.
    const number = uniqueAccountNumber()
    const added = await accountingCall<LedgerAccount>(token, 'POST', '/v1/entities/welld_ch/ledger-accounts', { number, name: `E2E CH manager ${RUN}` })
    expect(added.status).toBe(201)
    const italia = await accountingCall<{ items: LedgerAccount[] }>(people.admin.token, 'GET', '/v1/entities/welld_it/ledger-accounts')
    expect(italia.body.items.some((item) => item.number === number)).toBe(false)

    // The person's own list of entities names WellD CH only.
    const me = await accountingCall<{ entities: Array<{ entity: string; canManage: boolean }> }>(token, 'GET', '/v1/me')
    expect(me.status).toBe(200)
    expect(me.body.entities.map(({ entity, canManage }) => ({ entity, canManage }))).toEqual([{ entity: 'welld_ch', canManage: true }])
  })
})
