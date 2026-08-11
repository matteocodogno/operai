/**
 * T15 — Motivo-autocomplete end-to-end journeys (specs/014-motivo-autocomplete,
 * QE verification pass). Drives the REAL assembled shell host + refund-ui
 * remote (ADR-0006) against the REAL refund-api/auth services — no mocking of
 * the feature itself — mirroring this suite's cross-app e2e convention
 * (refund-headline.spec.ts specs/007, mileage-rate.spec.ts specs/009).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE LIVES IN `shell/e2e/`, NEVER IN `refund-ui`.                   │
 * │                                                                          │
 * │ refund-ui is a federated REMOTE: it has no standalone authed bootstrap   │
 * │ (no router guard, no session, no chrome of its own — ADR-0006), so every │
 * │ remote's journeys run through the host. specs/003 retired                │
 * │ `estimai-ui/e2e/` for exactly this reason.                               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ## Journey 1 — happy path (AC-1.2/1.4/1.5/1.7/2.1/2.2/2.3/2.5/3.1–3.7/5.3/5.6)
 *
 * A brand-new employee is granted the refund permission set, five past
 * `travel_km` lines are seeded THROUGH THE REAL API (`POST /requests` +
 * `POST /requests/{id}/lines`, Bearer JWT, exactly the rows a real employee
 * would have created), a fresh draft is opened in the browser, Travel by car
 * is chosen, three characters are typed, and the suggestion the employee wants
 * is navigated to and picked WITHOUT EVER TOUCHING A POINTER (AC-5.6): the
 * Motivo field is reached by Tab from the Expense-type select, the list is
 * navigated with ArrowDown/ArrowUp, and the pick is Enter. Then the three
 * filled fields and the recomputed mileage amount are asserted, it is asserted
 * that NOTHING has been saved (AC-3.7), and only then is the line added.
 *
 * ## Journey 2 — silent degradation (AC-5.1, AC-5.2)
 *
 * The SAME employee — so the corpus is known to be non-empty and a missing
 * list can only be caused by the failure being injected — composes another
 * line with `page.route('**\/line-suggestions*').abort()` in force. The
 * assertion is the ABSENCE of a surface: no listbox, no `role="alert"`, no
 * error banner, no composer error, no shell toast, and an EMPTY polite live
 * region (a spoken "no suggestions" would be AC-1.6's forbidden empty state in
 * the audio channel). The line still composes and still adds.
 *
 * ## Why the corpus is deterministic despite a shared local dev DB
 *
 * Each run mints a UNIQUE `@operai.test` employee. Suggestions are strictly
 * self-scoped to the verified JWT `sub` (AC-4.1/4.2, ADR-0042), so that
 * employee's corpus is EXACTLY the five lines this run seeds and nothing else
 * — no leftovers from a previous run, and no need for a rare-trigram query.
 * That property is itself a live, incidental check of AC-4.1: if the endpoint
 * leaked another subject's lines, these exact-count assertions would fail.
 *
 * ## Prerequisites
 *
 * The full stack (`mise run dev` from the repo root): Postgres, auth :3001
 * with `ENABLE_TEST_AUTH=true`, refund-api :8082. Playwright builds and
 * previews the five frontends itself (see `shell/playwright.config.ts`).
 * `refundFixtures.ts`/`adminSession.ts` shell out to `direnv exec .` inside
 * `auth/`, so direnv + an unlocked 1Password are required.
 */
import { test, expect, type Page } from '@playwright/test'
import { seedUserSession, seedAdminSession, applySessionCookie, type SeededSession } from './helpers/adminSession'
import { grantRefundEmployee } from './helpers/refundFixtures'

const REFUND_API_URL = (
  process.env['E2E_REFUND_API_URL'] ??
  process.env['VITE_REFUND_API_URL'] ??
  'http://localhost:8082'
).replace(/\/$/, '')

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

const isoDay = (offsetDays = 0): string => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

// ─── Real-API seeding (no direct DB access — these are the same calls the UI makes) ──

async function refundApi<T>(session: SeededSession, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${REFUND_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) {
    throw new Error(`[motivo-autocomplete] ${method} ${path} failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as T
}

interface SeedLine {
  readonly motivo: string
  readonly km: number
  readonly entity: 'welld_it' | 'welld_ch'
  /** `YYYY-MM-DD`. */
  readonly date: string
}

/**
 * Creates one draft request and appends every line to it. A single request is
 * enough: the trip signature is `(folded motivo, km, entity)` and deliberately
 * carries no request identity (AC-2.1), and `draft` lines are eligible
 * (AC-2.6, the user's accepted trade-off).
 */
async function seedPastMileageLines(session: SeededSession, lines: readonly SeedLine[]): Promise<string> {
  const created = await refundApi<{ id: string }>(session, 'POST', '/requests')
  for (const line of lines) {
    await refundApi(session, 'POST', `/requests/${created.id}/lines`, {
      date: line.date,
      type: 'travel_km',
      motivo: line.motivo,
      entity: line.entity,
      km: line.km,
    })
  }
  return created.id
}

interface EffectiveRate {
  inEffect: boolean
  ratePerKm?: string
  ratePerKmMicros?: number
}

/** ADR-0025's canonical rule, mirrored here so the expected amount is computed, never hardcoded. */
const computeAmountCents = (km: number, ratePerKmMicros: number): number =>
  Math.floor((km * ratePerKmMicros) / 10_000 + 0.5)

/** `refund-ui/src/lib/money.ts`'s `formatMoney` / `formatRatePerKm`, mirrored for the assertion. */
const formatMoney = (cents: number, currency: string): string =>
  `${Math.trunc(cents / 100)},${(cents % 100).toString().padStart(2, '0')} ${currency}`

test.describe.configure({ mode: 'serial' })

test.describe('specs/014-motivo-autocomplete T15: motivo autocomplete through the shell', () => {
  test('a past trip is offered while typing, picked BY KEYBOARD ONLY, fills motivo + km + entity and re-derives the amount — and saves nothing until Add is pressed (AC-1.2/1.4/1.5/1.7/2.1/2.2/2.3/2.5/3.1–3.7/5.3/5.6)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const empEmail = `e2e-motivo-emp-${tag}@operai.test`
    const adminEmail = `e2e-motivo-admin-${tag}@operai.test`
    const today = isoDay(0)

    const empSession = await seedUserSession(empEmail, 'E2E Motivo Employee')
    grantRefundEmployee(empEmail)
    // `admin` carries rate:read + rate:manage (auth's seed, specs/009 T1) — the
    // rate is what makes the post-pick amount a real recompute rather than
    // "No mileage rate configured yet".
    const adminSession = await seedAdminSession(adminEmail, 'E2E Motivo Admin')
    await refundApi(adminSession, 'POST', '/rates', {
      entity: 'welld_ch',
      ratePerKm: '0.81',
      validFrom: today,
    })

    // ─── The corpus: five past travel_km lines, seeded through the real API ──
    //
    //  Trip A — THREE lines whose motivos differ only by casing, whitespace and
    //  an accent, so they must fold-merge into ONE suggestion with count 3
    //  (AC-2.1), displaying the MOST RECENT line's motivo VERBATIM (AC-2.5).
    //  Trip B — the SAME words at a DIFFERENT km and entity: a different trip,
    //  never merged (AC-2.2), and with count 1 it must rank BELOW A (AC-2.3).
    //  Trip C — a motivo `lug` does not match at all, so it must not appear
    //  (AC-1.4's substring filter is a filter, not a no-op).
    const TRIP_A_DISPLAY = 'Milano → Lugàno cliente ACME'
    await seedPastMileageLines(empSession, [
      { motivo: 'Milano → Lugano cliente ACME', km: 62, entity: 'welld_ch', date: isoDay(60) },
      { motivo: 'milano  →  LUGANO cliente acme', km: 62, entity: 'welld_ch', date: isoDay(30) },
      { motivo: TRIP_A_DISPLAY, km: 62, entity: 'welld_ch', date: isoDay(10) },
      { motivo: 'Milano → Lugano cliente ACME', km: 45, entity: 'welld_it', date: isoDay(20) },
      { motivo: 'Riunione interna Torino', km: 12, entity: 'welld_it', date: isoDay(5) },
    ])

    const rate = await refundApi<EffectiveRate>(empSession, 'GET', `/rates/effective?entity=welld_ch&date=${today}`)
    expect(rate.inEffect, 'a welld_ch mileage rate must be in effect for today').toBe(true)
    const ratePerKmMicros = rate.ratePerKmMicros ?? 0
    const expectedBreakdown = `62 km × ${(rate.ratePerKm ?? '').replace('.', ',')} CHF/km = ${formatMoney(
      computeAmountCents(62, ratePerKmMicros),
      'CHF',
    )}`

    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const page = await empContext.newPage()

    // Every request the browser makes to the suggestions endpoint, so the
    // lazy/once-per-session fetch contract (plan D6) is observed, not assumed.
    const suggestionCalls: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/line-suggestions')) suggestionCalls.push(req.url())
    })

    await page.goto('/refund/requests')
    await expect(page.getByTestId('refund-my-requests-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('my-requests-new-button').click()
    await expect(page.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('composer-date').fill(today)

    // AC-1.1 — before Travel by car is chosen, the Motivo input is an ordinary
    // text input: no combobox role, and no request has been issued.
    await expect(page.getByTestId('composer-motivo')).not.toHaveAttribute('role', 'combobox')
    expect(suggestionCalls, 'nothing may be fetched before travel_km is selected').toHaveLength(0)

    await page.getByTestId('composer-type').selectOption('travel_km')
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute('role', 'combobox')
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute('aria-expanded', 'false')
    // plan D6 — the corpus fetch is LAZY: selecting the type costs nothing.
    expect(suggestionCalls, 'selecting travel_km must not fetch (plan D6)').toHaveLength(0)

    // ─── KEYBOARD ONLY from here to the pick (AC-5.6) ────────────────────────
    // Motivo is reached by Tab from the Expense-type select — no click, no
    // programmatic focus on the field itself.
    await page.getByTestId('composer-type').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('composer-motivo')).toBeFocused()

    await page.keyboard.type('lug')

    const listbox = page.getByTestId('composer-motivo-listbox')
    await expect(listbox).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute('aria-expanded', 'true')

    // AC-1.4/1.5 — exactly the two trips whose folded motivo contains "lug";
    // "Riunione interna Torino" is filtered out.
    const options = page.locator('[data-testid^="composer-motivo-option-"]')
    await expect(options).toHaveCount(2)

    // AC-2.1/2.3/2.5/1.7 — option 0 is the fold-merged trip: count 3 (three
    // lines collapsed into one), the MOST RECENT line's motivo verbatim
    // (accent and casing intact — never the folded form), its km and entity.
    const first = page.getByTestId('composer-motivo-option-0')
    await expect(first).toContainText(TRIP_A_DISPLAY)
    await expect(first).toContainText('62 km')
    await expect(first).toContainText('WellD CH')
    await expect(first).toContainText('Used 3×')
    // AC-1.7's five facts, as one unambiguous accessible name (design.md).
    await expect(first).toHaveAttribute(
      'aria-label',
      new RegExp(`^${escapeRegExp(TRIP_A_DISPLAY)}, 62 km, WellD CH, used 3 times, last used .+$`),
    )

    // AC-2.2 — the same words at a different km/entity stayed a SEPARATE trip,
    // and AC-2.3/1.7 — its lower count places it below, never above.
    const second = page.getByTestId('composer-motivo-option-1')
    await expect(second).toContainText('45 km')
    await expect(second).toContainText('WellD Italia')
    await expect(second).toContainText('Used 1×')

    // AC-5.6 — the polite region announces the COUNT (and never the option text).
    await expect(page.getByTestId('composer-motivo-live')).toHaveText('2 suggestions available')

    // plan D1/D6 — one fetch for the whole composing session, and the typed
    // text never went on the wire (there is no query parameter to carry it).
    expect(suggestionCalls).toHaveLength(1)
    expect(suggestionCalls[0]).toContain('type=travel_km')
    expect(suggestionCalls[0]).not.toContain('lug')

    // ─── AC-5.3 — navigate and pick with the keyboard alone ──────────────────
    // Opening never auto-highlights (AC-5.4), so nothing is armed yet.
    await expect(page.getByTestId('composer-motivo')).not.toHaveAttribute('aria-activedescendant', /.*/)

    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute(
      'aria-activedescendant',
      'composer-motivo-option-0',
    )
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute(
      'aria-activedescendant',
      'composer-motivo-option-1',
    )
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute(
      'aria-activedescendant',
      'composer-motivo-option-0',
    )

    await page.keyboard.press('Enter')

    // ─── AC-3.1/3.4 — motivo, km and entity are all overwritten ──────────────
    await expect(page.getByTestId('composer-motivo')).toHaveValue(TRIP_A_DISPLAY)
    await expect(page.getByTestId('composer-km')).toHaveValue('62')
    await expect(page.getByTestId('composer-entity')).toHaveValue('welld_ch')

    // AC-3.2 — the expense date is NOT carried forward from the past trip.
    await expect(page.getByTestId('composer-date')).toHaveValue(today)

    // AC-3.5 — the list closed, and the amount re-derived from the PICKED km
    // and entity against the employee's own date.
    await expect(listbox).toHaveCount(0)
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('mileage-amount-status')).toHaveText(expectedBreakdown, { timeout: 15_000 })

    // AC-3.3 — no amount and no currency control exists for this type, before
    // or after a pick.
    await expect(page.getByTestId('composer-amount')).toHaveCount(0)
    await expect(page.getByTestId('composer-currency')).toHaveCount(0)

    // AC-3.6 — the three filled fields are ordinary editable values.
    await expect(page.getByTestId('composer-km')).not.toHaveAttribute('readonly', /.*/)
    await expect(page.getByTestId('composer-km')).toBeEnabled()
    await expect(page.getByTestId('composer-entity')).toBeEnabled()
    await expect(page.getByTestId('composer-motivo')).toBeEnabled()

    // AC-5.6 — the multi-field change is announced on the composer's existing
    // polite status line, naming the untouched date.
    await expect(page.getByTestId('composer-km-status')).toHaveText(
      `Filled from a past trip: ${TRIP_A_DISPLAY}, 62 km, WellD CH. The date is unchanged.`,
    )

    // ─── AC-3.7 — NOTHING has been saved. The pick fills; the employee adds. ──
    await expect(page.locator('[data-testid^="expense-line-row-"]')).toHaveCount(0)

    await page.getByTestId('composer-add-button').click()
    const rows = page.locator('[data-testid^="expense-line-row-"]')
    await expect(rows).toHaveCount(1, { timeout: 15_000 })
    await expect(rows.first()).toContainText(TRIP_A_DISPLAY)
    await expect(rows.first()).toContainText(formatMoney(computeAmountCents(62, ratePerKmMicros), 'CHF'))

    await empContext.close()
  })

  test('the suggestions endpoint failing surfaces NOTHING and never blocks composing or adding a line (AC-5.1, AC-5.2)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const empEmail = `e2e-motivo-degraded-${tag}@operai.test`
    const today = isoDay(0)

    const empSession = await seedUserSession(empEmail, 'E2E Motivo Degraded')
    grantRefundEmployee(empEmail)

    // A NON-EMPTY corpus, so a missing list can only be caused by the failure
    // injected below — never by there being nothing to suggest.
    await seedPastMileageLines(empSession, [
      { motivo: 'Milano → Lugano cliente ACME', km: 62, entity: 'welld_ch', date: isoDay(30) },
      { motivo: 'Milano → Lugano cliente ACME', km: 62, entity: 'welld_ch', date: isoDay(10) },
      { motivo: 'Aeroporto Malpensa', km: 45, entity: 'welld_it', date: isoDay(5) },
    ])

    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const page = await empContext.newPage()

    // AC-5.2's "fails, errors, or does not answer" — the hardest form: the
    // socket is killed outright.
    let aborted = 0
    await page.route('**/line-suggestions*', async (route) => {
      aborted += 1
      await route.abort()
    })

    await page.goto('/refund/requests')
    await expect(page.getByTestId('refund-my-requests-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('my-requests-new-button').click()
    await expect(page.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('composer-date').fill(today)
    await page.getByTestId('composer-type').selectOption('travel_km')

    await page.getByTestId('composer-type').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('composer-motivo')).toBeFocused()
    await page.keyboard.type('lug')

    // Let the 150 ms debounce fire, the request be aborted, and React settle.
    await expect(async () => {
      expect(aborted).toBeGreaterThanOrEqual(1)
    }).toPass({ timeout: 10_000 })
    await page.waitForTimeout(1_000)

    // ─── The whole assertion is an ABSENCE (AC-5.2, AC-1.6) ──────────────────
    await expect(page.getByTestId('composer-motivo-listbox')).toHaveCount(0)
    await expect(page.getByTestId('composer-motivo')).toHaveAttribute('aria-expanded', 'false')
    // An announced "no suggestions" would be the forbidden empty state in the
    // audio channel — the region must be present and EMPTY.
    await expect(page.getByTestId('composer-motivo-live')).toHaveText('')
    await assertNoErrorSurface(page)

    // AC-5.1 — the typed text was never altered, completed in place, or blocked.
    await expect(page.getByTestId('composer-motivo')).toHaveValue('lug')

    // …and the line still composes and still adds, exactly as before the
    // feature existed.
    await page.keyboard.type('ano — nuova trasferta')
    await expect(page.getByTestId('composer-motivo')).toHaveValue('lugano — nuova trasferta')
    await page.getByTestId('composer-entity').selectOption('welld_it')
    await page.getByTestId('composer-km').fill('33')

    await page.getByTestId('composer-add-button').click()
    await expect(page.locator('[data-testid^="expense-line-row-"]')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('[data-testid^="expense-line-row-"]').first()).toContainText('lugano — nuova trasferta')

    // Still nothing, after the add.
    await assertNoErrorSurface(page)

    await empContext.close()
  })
})

/**
 * AC-5.2/AC-1.6: this feature may never surface an error, a banner, a toast, a
 * retry affordance or an empty state — on ANY failure path.
 *
 * `role="status"` is deliberately NOT asserted away: `MileageAmountField`
 * (specs/009) legitimately renders one for every `travel_km` line, and it is
 * not this feature's surface. Shell toasts have no `data-testid`, so they are
 * matched by the `sr-only` "Severity: …" line every toast renders.
 */
async function assertNoErrorSurface(page: Page): Promise<void> {
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('error-banner')).toHaveCount(0)
  await expect(page.getByTestId('composer-error')).toHaveCount(0)
  await expect(page.locator('text=/^Severity: /')).toHaveCount(0)
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
