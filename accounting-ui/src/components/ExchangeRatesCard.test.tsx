/**
 * @vitest-environment jsdom
 *
 * ExchangeRatesCard (T31, specs/20261119-accounting, design AS5, FA7 to FA9, UX-8 to UX-11, UX-13, UX-15; AC-2.3 to AC-2.5,
 * AC-2.7 to AC-2.9, AC-2.11, AC-7.3, AC-8.4): the table with origin badges and Missing, the Source and Last-fetch facts with the
 * outcome in words, no history drawer and no trigger, the WellD Italia no-source panel, the auto-fetch exactly once per visit for
 * managers (also after a failure) that never moves focus, the persistent failure banner (readers see it), Fetch now and every
 * answer it can get (G5), a correction updating its cell, controls hidden without manage, the deep link and its "month not
 * listed" note, and axe on every state. accounting-api is faked at `shell/session`'s `apiFetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'
import type { EntityId } from '../lib/meApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import ExchangeRatesCard from './ExchangeRatesCard'

type RateBody = { status: 'missing' } | { status: 'fetched' | 'corrected'; rateMicros: number; rate: string }
type MonthBody = { month: string; rates: Record<string, RateBody> }
type LastFetchBody = { at: string; outcome: string; errorCode: string | null; month: string }

const fetched = (rate: string, micros: number): RateBody => ({ status: 'fetched', rateMicros: micros, rate })
const MISSING: RateBody = { status: 'missing' }

const MARCH: MonthBody = {
  month: '2026-03',
  rates: { EUR: fetched('0.9246', 924600), USD: fetched('0.8102', 810200), GBP: MISSING },
}
const FEBRUARY: MonthBody = {
  month: '2026-02',
  rates: {
    EUR: { status: 'corrected', rateMicros: 934000, rate: '0.934' },
    USD: fetched('0.8130', 813000),
    GBP: fetched('1.0750', 1075000),
  },
}

const OK_FETCH: LastFetchBody = { at: '2026-11-18T09:14:00Z', outcome: 'ok', errorCode: null, month: '2026-10' }
const FAILED_FETCH: LastFetchBody = { at: '2026-11-18T09:14:00Z', outcome: 'failed', errorCode: 'timeout', month: '2026-10' }

const LIST = 'GET /v1/entities/welld_ch/exchange-rates'
const FETCH = 'POST /v1/entities/welld_ch/exchange-rates/fetch'

const rates = (overrides: Record<string, unknown> = {}): FakeAnswer => ({
  status: 200,
  body: {
    entity: 'welld_ch',
    ownCurrency: 'CHF',
    currencies: ['EUR', 'USD', 'GBP'],
    source: { name: 'bazg' },
    months: [MARCH, FEBRUARY],
    lastFetch: OK_FETCH,
    fetchDue: false,
    ...overrides,
  },
})

const attempt = (outcome: string, extra: Record<string, unknown> = {}) => ({
  month: '2026-03',
  outcome,
  errorCode: null,
  recorded: null,
  ...extra,
})
const fetchAnswer = (attempts: unknown[], extra: Record<string, unknown> = {}): FakeAnswer => ({
  status: 200,
  body: { attempts, deferredMonths: [], lastFetch: OK_FETCH, ...extra },
})

const never = (): Promise<FakeAnswer> => new Promise(() => {})
const onEntityGone = vi.fn()
const onWriteRefused = vi.fn()

const serve = (routes: Record<string, FakeHandler>) => apiFetch.mockImplementation(fakeApi({ [LIST]: () => rates(), ...routes }))
const calls = (key: string) =>
  apiFetch.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}` === key)

beforeEach(() => {
  serve({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const card = (props: { canManage?: boolean; month?: string; entity?: EntityId } = {}) => (
  <ExchangeRatesCard
    entity={props.entity ?? 'welld_ch'}
    canManage={props.canManage ?? true}
    month={props.month}
    onEntityGone={onEntityGone}
    onWriteRefused={onWriteRefused}
  />
)

const renderCard = async (props: Parameters<typeof card>[0] = {}) => {
  const view = render(card(props))
  await screen.findByTestId('accounting-fx-table')
  return view
}

const cell = (month: string, currency: string) => screen.getByTestId(`accounting-fx-cell-${month}-${currency}`)
const fetchNow = () => screen.getByTestId('accounting-fx-fetch-now') as HTMLButtonElement

describe('ExchangeRatesCard: the table (AS5)', () => {
  it('shows a polite loading line and a skeleton while it loads', async () => {
    serve({ [LIST]: never })
    const { container } = render(card())
    expect(screen.getByTestId('accounting-loading').textContent).toContain('Loading exchange rates…')
    expect(screen.queryByTestId('accounting-fx-table')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('names the entity in the title and caption, the base currency in the description, and lists months newest first as row headers', async () => {
    const { container } = await renderCard()
    expect(screen.getByRole('heading', { name: 'Exchange rates — WellD CH' })).not.toBeNull()
    expect(screen.getByRole('table', { name: 'WellD CH monthly average exchange rates' })).not.toBeNull()
    expect(screen.getByText('CHF for 1 unit of the foreign currency, monthly average. Other modules convert at these rates.')).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Month', 'EUR', 'USD', 'GBP'])
    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual(['March 2026', 'February 2026'])
    await expectNoAxeViolations(container)
  })

  it('reads the entity’s own path and carries no window parameter by default', async () => {
    await renderCard()
    expect(String(calls(LIST)[0]![0])).toBe('http://accounting-api.test/v1/entities/welld_ch/exchange-rates')
  })

  it('builds the columns from the currencies the entity lists, not from a fixed set', async () => {
    serve({ [LIST]: () => rates({ currencies: ['EUR'], months: [{ month: '2026-03', rates: { EUR: fetched('0.9246', 924600) } }] }) })
    await renderCard()
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Month', 'EUR'])
  })

  it('shows each rate exactly as sent, mono, with its origin; a currency a row does not carry is Missing, never absent', async () => {
    serve({ [LIST]: () => rates({ months: [{ month: '2026-03', rates: { EUR: fetched('0.9246', 924600) } }] }) })
    await renderCard()
    expect(within(cell('2026-03', 'EUR')).getByText('0.9246').className).toContain('font-mono')
    expect(within(cell('2026-03', 'EUR')).getByText('Fetched')).not.toBeNull()
    expect(within(cell('2026-03', 'USD')).getByText('Missing')).not.toBeNull()
  })

  it('gives each cell a group name that reads as one unit', async () => {
    await renderCard()
    expect(cell('2026-03', 'EUR').getAttribute('aria-label')).toBe('EUR, March 2026: 0.9246, Fetched')
    expect(cell('2026-02', 'EUR').getAttribute('aria-label')).toBe('EUR, February 2026: 0.934, Corrected')
    expect(cell('2026-03', 'GBP').getAttribute('aria-label')).toBe('GBP, March 2026: missing')
    expect(within(cell('2026-02', 'EUR')).getByText('Corrected')).not.toBeNull()
  })

  it('a Missing cell is a badge with the word, and a manager can still correct it (AC-2.7)', async () => {
    const { container } = await renderCard()
    const missing = cell('2026-03', 'GBP')
    expect(within(missing).getByText('Missing')).not.toBeNull()
    expect(within(missing).getByRole('button', { name: 'Correct the GBP rate for March 2026' })).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('has NO history drawer and no per-cell history button (UX-8)', async () => {
    await renderCard()
    expect(screen.queryByRole('button', { name: /history/i })).toBeNull()
    expect(screen.queryByTestId(/history/)).toBeNull()
    expect(screen.queryByText(/@/)).toBeNull()
  })

  it('states Source (AFC/ESTV, served by the BAZG) and the last fetch with its outcome in words (UX-9)', async () => {
    await renderCard()
    const facts = screen.getByTestId('accounting-fx-facts')
    expect(within(facts).getByText('Source')).not.toBeNull()
    expect(
      within(facts).getByText('Monthly average rates for VAT of the Swiss Federal Tax Administration (AFC/ESTV), served by the BAZG'),
    ).not.toBeNull()
    expect(within(facts).getByText('Last fetch')).not.toBeNull()
    expect(facts.textContent).toMatch(/18\.11\.2026.*succeeded/)
  })

  it.each([
    ['failed', /— failed/],
    ['disabled', /— switched off/],
    ['throttled', /— checked a moment ago/],
    ['not_fetchable', /— not published yet/],
  ])('says the last fetch outcome %s in words', async (outcome, words) => {
    serve({ [LIST]: () => rates({ lastFetch: { ...OK_FETCH, outcome } }) })
    await renderCard({ canManage: false })
    expect(screen.getByTestId('accounting-fx-facts').textContent).toMatch(words)
  })

  it('says there has been no fetch yet', async () => {
    serve({ [LIST]: () => rates({ lastFetch: null }) })
    await renderCard()
    expect(screen.getByTestId('accounting-fx-facts').textContent).toContain('No fetch yet')
  })

  it('a source with no completed month yet is "No months to show yet", still with its facts and Fetch now', async () => {
    serve({ [LIST]: () => rates({ months: [], lastFetch: null }) })
    const { container } = render(card())
    const empty = await screen.findByTestId('accounting-empty')
    expect(empty.textContent).toContain('No months to show yet')
    expect(screen.getByTestId('accounting-fx-facts')).not.toBeNull()
    expect(fetchNow()).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('failed: a warning banner with the card’s sentence and Retry; 503 is the authorization banner; 403 replaces the view', async () => {
    let reads = 0
    serve({ [LIST]: () => (++reads === 1 ? problem(500) : rates()) })
    const failed = render(card())
    expect((await screen.findByTestId('accounting-load-error')).textContent).toContain('Could not load the exchange rates.')
    await expectNoAxeViolations(failed.container)
    fireEvent.click(screen.getByTestId('accounting-load-error-retry'))
    await screen.findByTestId('accounting-fx-table')
    cleanup()

    serve({ [LIST]: () => problem(503) })
    const unavailable = render(card())
    expect((await screen.findByTestId('accounting-load-error')).textContent).toContain('Authorization service unavailable')
    await expectNoAxeViolations(unavailable.container)
    cleanup()

    serve({ [LIST]: () => problem(403, 'accounting_forbidden') })
    const denied = render(card())
    expect(await screen.findByTestId('accounting-denied')).not.toBeNull()
    expect(screen.queryByTestId('accounting-fx-card')).toBeNull()
    await expectNoAxeViolations(denied.container)
  })

  it('404: tells the frame once that the entity is gone', async () => {
    serve({ [LIST]: () => problem(404, 'not_found') })
    render(card())
    await screen.findByTestId('accounting-load-error')
    await waitFor(() => expect(onEntityGone).toHaveBeenCalledTimes(1))
  })

  it('reads an unreadable answer as no months and no source rather than failing', async () => {
    serve({ [LIST]: () => ({ status: 200, body: {} }) })
    render(card())
    expect(await screen.findByTestId('accounting-fx-no-source')).not.toBeNull()
  })
})

describe('ExchangeRatesCard: WellD Italia has no official source (AC-2.11, UX-13)', () => {
  const IT = 'GET /v1/entities/welld_it/exchange-rates'
  const italia = () => ({ status: 200, body: { entity: 'welld_it', ownCurrency: 'EUR', currencies: [], source: null, months: [], lastFetch: null, fetchDue: true } })

  it.each([true, false])('is one panel for a manager (%s) or a reader: no table, no Fetch now, no last-fetch fact, no auto-fetch', async (canManage) => {
    serve({ [IT]: italia })
    const { container } = render(card({ entity: 'welld_it', canManage }))
    const panel = await screen.findByTestId('accounting-fx-no-source')
    expect(panel.textContent).toContain('No official source for WellD Italia yet')
    expect(panel.textContent).toContain('Exchange rates are not fetched or kept for this entity yet. They will be added when its source is chosen.')
    expect(screen.queryByTestId('accounting-fx-table')).toBeNull()
    expect(screen.queryByTestId('accounting-fx-fetch-now')).toBeNull()
    expect(screen.queryByTestId('accounting-fx-facts')).toBeNull()
    expect(screen.queryByText('Last fetch')).toBeNull()
    expect(screen.queryByTestId('accounting-empty')).toBeNull()
    // even when the server says a fetch is due, with no source nothing is attempted
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await expectNoAxeViolations(container)
  })

  it('is not the lists’ "nothing entered yet" and is not an error', async () => {
    serve({ [IT]: italia })
    render(card({ entity: 'welld_it' }))
    const panel = await screen.findByTestId('accounting-fx-no-source')
    expect(panel.textContent).not.toContain('Nothing entered yet')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('ExchangeRatesCard: reader (UX-4, AC-2.3)', () => {
  it('shows the table, the failure banner and the sentence, with no Fetch now and no Correct', async () => {
    serve({ [LIST]: () => rates({ lastFetch: FAILED_FETCH, fetchDue: true }) })
    const { container } = await renderCard({ canManage: false })
    expect(screen.queryByTestId('accounting-fx-fetch-now')).toBeNull()
    expect(screen.queryByRole('button', { name: /Correct/ })).toBeNull()
    expect(screen.getByTestId('accounting-fx-read-only').textContent).toBe(
      'You can view this list. Accounting managers fetch and correct rates.',
    )
    // AC-2.8: the persistent failure is visible to readers too
    expect(screen.getByTestId('accounting-fx-failed')).not.toBeNull()
    // and a reader never triggers the auto-fetch
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls(FETCH)).toHaveLength(0)
    await expectNoAxeViolations(container)
  })

  it('the manager does not get the reader sentence', async () => {
    await renderCard()
    expect(screen.queryByTestId('accounting-fx-read-only')).toBeNull()
  })
})

describe('ExchangeRatesCard: the last fetch failed (AC-2.8)', () => {
  it('is a persistent warning with the time and a plain reason, not dismissible, polite, and the facts say failed', async () => {
    serve({ [LIST]: () => rates({ lastFetch: FAILED_FETCH }) })
    const { container } = await renderCard()
    const banner = screen.getByTestId('accounting-fx-failed')
    expect(banner.textContent).toContain('The last fetch failed')
    expect(banner.textContent).toContain('the official source did not answer in time')
    expect(banner.textContent).toContain('The rates already recorded are unchanged.')
    expect(within(banner).queryByRole('button')).toBeNull()
    expect(banner.getAttribute('aria-live')).toBe('polite')
    expect(banner.getAttribute('role')).not.toBe('alert')
    expect(screen.getByTestId('accounting-fx-facts').textContent).toContain('— failed')
    await expectNoAxeViolations(container)
  })

  it.each([
    ['http_503', 'the official source returned an error'],
    ['parse', 'the answer could not be read'],
    ['month_mismatch', 'the answer was for a different month'],
    ['currency_missing', 'a currency was missing from the answer'],
    ['something_else', 'an unknown error occurred'],
  ])('names the reason of %s in words, never the code', async (errorCode, words) => {
    serve({ [LIST]: () => rates({ lastFetch: { ...FAILED_FETCH, errorCode } }) })
    await renderCard()
    const banner = screen.getByTestId('accounting-fx-failed')
    expect(banner.textContent).toContain(words)
    expect(banner.textContent).not.toContain(errorCode)
  })

  it('goes away when a later fetch succeeds', async () => {
    serve({
      [LIST]: () => rates({ lastFetch: FAILED_FETCH }),
      [FETCH]: () => fetchAnswer([attempt('ok')], { lastFetch: OK_FETCH }),
    })
    await renderCard()
    fireEvent.click(fetchNow())
    await waitFor(() => expect(screen.queryByTestId('accounting-fx-failed')).toBeNull())
  })
})

describe('ExchangeRatesCard: switched off (AS5)', () => {
  it('tells a manager to enter the rates by hand, and a reader only that fetching is off', async () => {
    serve({ [LIST]: () => rates({ lastFetch: { ...OK_FETCH, outcome: 'disabled' } }) })
    const manager = await renderCard()
    expect(screen.getByTestId('accounting-fx-disabled').textContent).toBe(
      'Automatic fetching is turned off in this environment. Enter the rates by hand.',
    )
    await expectNoAxeViolations(manager.container)
    cleanup()
    const reader = await renderCard({ canManage: false })
    expect(screen.getByTestId('accounting-fx-disabled').textContent).toBe('Automatic fetching is turned off in this environment.')
    await expectNoAxeViolations(reader.container)
  })
})

describe('ExchangeRatesCard: auto-fetch, once per visit, managers only (D26, UX-9)', () => {
  it('fetches once when the list says fetchDue, with no trigger, says so politely and never moves focus', async () => {
    let release!: (answer: FakeAnswer) => void
    serve({
      [LIST]: () => rates({ fetchDue: true }),
      [FETCH]: () => new Promise<FakeAnswer>((resolve) => (release = resolve)),
    })
    const { container } = render(card())
    await screen.findByTestId('accounting-fx-table')
    const status = await screen.findByTestId('accounting-fx-checking')
    expect(status.textContent).toBe('Checking for new rates…')
    expect(status.closest('[role="status"]')).not.toBeNull()
    expect(document.activeElement).toBe(document.body)
    expect(fetchNow().disabled).toBe(true)
    await expectNoAxeViolations(container)

    release(fetchAnswer([attempt('ok', { recorded: { EUR: 924600 } })]))
    await waitFor(() => expect(screen.queryByTestId('accounting-fx-checking')).toBeNull())
    expect(calls(FETCH)).toHaveLength(1)
    // no `trigger`, no months: every fetchable month that lacks a rate
    expect(JSON.parse(String(calls(FETCH)[0]![1]!.body))).toEqual({})
    expect(document.activeElement).toBe(document.body)
  })

  it('never fetches again, also after a failure (the guard is not reset)', async () => {
    serve({ [LIST]: () => rates({ fetchDue: true }), [FETCH]: () => problem(500) })
    await renderCard()
    await screen.findByTestId('accounting-fx-fetch-error')
    // the list is read again (a reload) and still says fetchDue: the card does not loop
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls(FETCH)).toHaveLength(1)
  })

  it('never fetches a second time for the same visit, even if the right to manage is lost and regained (the guard is not reset)', async () => {
    serve({ [LIST]: () => rates({ fetchDue: true }), [FETCH]: () => fetchAnswer([attempt('ok')]) })
    const view = render(card())
    await screen.findByTestId('accounting-fx-table')
    await waitFor(() => expect(calls(FETCH)).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('accounting-fx-checking')).toBeNull())
    view.rerender(card({ canManage: false }))
    view.rerender(card({ canManage: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls(FETCH)).toHaveLength(1)
  })

  it('does not fetch when nothing is due', async () => {
    await renderCard()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls(FETCH)).toHaveLength(0)
  })
})

describe('ExchangeRatesCard: Fetch now (AC-2.9, G5)', () => {
  it('records and confirms "Recorded the rates for 2 months." and reloads the months', async () => {
    let reads = 0
    serve({
      [LIST]: () => (++reads === 1 ? rates() : rates({ months: [{ ...MARCH, rates: { ...MARCH.rates, GBP: fetched('1.0100', 1010000) } }, FEBRUARY] })),
      [FETCH]: () =>
        fetchAnswer([attempt('ok', { recorded: { GBP: 1010000 } }), attempt('ok', { month: '2026-02', recorded: { USD: 813000 } })]),
    })
    await renderCard()
    fireEvent.click(fetchNow())
    expect(screen.getByTestId('accounting-fx-fetch-now').textContent).toBe('Fetching…')
    await waitFor(() => expect(screen.getByTestId('accounting-saved').textContent).toBe('Recorded the rates for 2 months.'))
    await waitFor(() => expect(within(cell('2026-03', 'GBP')).getByText('1.0100')).not.toBeNull())
    expect(JSON.parse(String(calls(FETCH)[0]![1]!.body))).toEqual({})
    await expectNoAxeViolations()
  })

  it('says "No new rates to record." when nothing was newly recorded and nothing else explains it', async () => {
    serve({ [FETCH]: () => fetchAnswer([attempt('ok')]) })
    await renderCard()
    fireEvent.click(fetchNow())
    await waitFor(() => expect(screen.getByTestId('accounting-saved').textContent).toBe('No new rates to record.'))
  })

  it('says a month is not published yet, as a dismissible info note, without "no new rates"', async () => {
    serve({ [FETCH]: () => fetchAnswer([attempt('not_fetchable', { month: '2026-10' })]) })
    await renderCard()
    fireEvent.click(fetchNow())
    const note = await screen.findByTestId('accounting-fx-note')
    expect(note.textContent).toBe('The rates for October 2026 are not published yet.')
    expect(screen.queryByTestId('accounting-saved')).toBeNull()
    await expectNoAxeViolations()
    fireEvent.click(within(note).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('accounting-fx-note')).toBeNull()
  })

  it('says it was checked a moment ago when throttled', async () => {
    serve({ [FETCH]: () => fetchAnswer([attempt('throttled')]) })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('accounting-fx-note')).textContent).toBe('The rates were checked a moment ago. Try again in a few minutes.')
    expect(screen.queryByTestId('accounting-saved')).toBeNull()
    await expectNoAxeViolations()
  })

  it('says how many months are still to fetch (deferred), singular and plural', async () => {
    serve({ [FETCH]: () => fetchAnswer([attempt('ok', { recorded: { EUR: 1 } })], { deferredMonths: ['2026-01', '2026-02'] }) })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('accounting-fx-note')).textContent).toBe('2 more months are still to fetch. Fetch again to continue.')
    cleanup()
    serve({ [FETCH]: () => fetchAnswer([attempt('ok', { recorded: { EUR: 1 } })], { deferredMonths: ['2026-01'] }) })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('accounting-fx-note')).textContent).toBe('1 more month is still to fetch. Fetch again to continue.')
  })

  it('switched off in the answer: the info banner appears, with no "no new rates"', async () => {
    serve({ [FETCH]: () => fetchAnswer([attempt('disabled')], { lastFetch: { ...OK_FETCH, outcome: 'disabled' } }) })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('accounting-fx-disabled')).textContent).toContain('turned off')
    expect(screen.queryByTestId('accounting-saved')).toBeNull()
    await expectNoAxeViolations()
  })

  it('a source failure is a 200: the persistent banner appears, nothing is confirmed, the recorded rates stay', async () => {
    serve({ [FETCH]: () => fetchAnswer([attempt('failed', { errorCode: 'timeout' })], { lastFetch: FAILED_FETCH }) })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('accounting-fx-failed')).textContent).toContain('The last fetch failed')
    expect(screen.queryByTestId('accounting-saved')).toBeNull()
    expect(within(cell('2026-03', 'EUR')).getByText('0.9246')).not.toBeNull()
    await expectNoAxeViolations()
  })

  it('a request that fails is a dismissible danger banner; a 403 says permission and re-reads /v1/me', async () => {
    const answers = [problem(500), problem(403, 'accounting_manage_required')]
    serve({ [FETCH]: () => answers.shift()! })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('accounting-fx-fetch-error')).textContent).toBe('Could not fetch the rates. Try again.')
    await expectNoAxeViolations()
    fireEvent.click(fetchNow())
    await waitFor(() => expect(screen.getByTestId('accounting-fx-fetch-error').textContent).toBe("You don't have permission to do this."))
    expect(onWriteRefused).toHaveBeenCalledTimes(1)
  })

  it('a 422 no_rate_source reads the list again (the entity lost its source meanwhile)', async () => {
    serve({ [FETCH]: () => problem(422, 'no_rate_source') })
    await renderCard()
    fireEvent.click(fetchNow())
    await screen.findByTestId('accounting-fx-fetch-error')
    await waitFor(() => expect(calls(LIST)).toHaveLength(2))
  })
})

describe('ExchangeRatesCard: Correct (AC-2.4, AC-2.5)', () => {
  const put = 'PUT /v1/entities/welld_ch/exchange-rates/2026-03/GBP'

  it('opens the dialog beside the card from the cell, saves, updates that cell with Corrected, confirms and returns focus to the button', async () => {
    serve({
      [put]: () => ({
        status: 200,
        body: { month: '2026-03', rates: { ...MARCH.rates, GBP: { status: 'corrected', rateMicros: 1010000, rate: '1.01' } } },
      }),
    })
    await renderCard()
    const opener = screen.getByTestId('accounting-fx-correct-2026-03-GBP')
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Correct rate — GBP · March 2026' })
    expect(screen.getByTestId('accounting-fx-card').contains(dialog)).toBe(false)
    fireEvent.change(screen.getByTestId('accounting-fx-correction-value'), { target: { value: '1,0100' } })
    fireEvent.click(screen.getByTestId('accounting-fx-correction-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(JSON.parse(String(calls(put)[0]![1]!.body))).toEqual({ rate: '1.01' })
    expect(within(cell('2026-03', 'GBP')).getByText('1.01')).not.toBeNull()
    expect(within(cell('2026-03', 'GBP')).getByText('Corrected')).not.toBeNull()
    expect(screen.getByTestId('accounting-saved').textContent).toBe('GBP rate for March 2026 corrected')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-fx-correct-2026-03-GBP'))
    // the other cells are untouched, and the rest of the table was not re-read for it
    expect(within(cell('2026-03', 'EUR')).getByText('0.9246')).not.toBeNull()
    await expectNoAxeViolations()
  })

  it('a no-op answer (200 with no row) closes the dialog, confirms nothing and reads the list again', async () => {
    serve({ [put]: () => ({ status: 200 }) })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-fx-correct-2026-03-GBP'))
    fireEvent.change(screen.getByTestId('accounting-fx-correction-value'), { target: { value: '1.01' } })
    fireEvent.click(screen.getByTestId('accounting-fx-correction-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByTestId('accounting-saved')).toBeNull()
    await waitFor(() => expect(calls(LIST)).toHaveLength(2))
  })

  it('Cancel closes without a request and returns focus to the button', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-fx-correct-2026-02-EUR'))
    fireEvent.click(screen.getByTestId('accounting-fx-correction-cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls('PUT /v1/entities/welld_ch/exchange-rates/2026-02/EUR')).toHaveLength(0)
    expect(document.activeElement).toBe(screen.getByTestId('accounting-fx-correct-2026-02-EUR'))
  })
})

describe('ExchangeRatesCard: the deep link (AC-7.3, UX-11)', () => {
  it('focuses the month’s row header once, when the table first appears, with no note', async () => {
    const { container } = await renderCard({ month: '2026-02' })
    expect(document.activeElement).toBe(within(screen.getByTestId('accounting-fx-row-2026-02')).getByRole('rowheader'))
    expect(screen.queryByTestId('accounting-fx-deeplink-note')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('a month the table does not list says so in the polite status, names it in words, and takes no focus', async () => {
    const { container } = await renderCard({ month: '2026-11' })
    const note = screen.getByTestId('accounting-fx-deeplink-note')
    expect(note.textContent).toBe(
      'November 2026 is not in the list. A month is listed once it has ended; its rate is published a few days later.',
    )
    expect(note.closest('[role="status"]')?.getAttribute('data-testid')).toBe('accounting-fx-status')
    expect(document.activeElement).toBe(document.body)
    await expectNoAxeViolations(container)
  })

  it('says it in the empty state too, and never for the no-source panel', async () => {
    serve({ [LIST]: () => rates({ months: [] }) })
    render(card({ month: '2026-03' }))
    await screen.findByTestId('accounting-empty')
    expect(screen.getByTestId('accounting-fx-deeplink-note')).not.toBeNull()
    cleanup()

    serve({ 'GET /v1/entities/welld_it/exchange-rates': () => ({ status: 200, body: { entity: 'welld_it', ownCurrency: 'EUR', currencies: [], source: null, months: [] } }) })
    render(card({ entity: 'welld_it', month: '2026-03' }))
    await screen.findByTestId('accounting-fx-no-source')
    expect(screen.queryByTestId('accounting-fx-deeplink-note')).toBeNull()
  })

  it('does not say anything while the list is still loading', () => {
    serve({ [LIST]: never })
    render(card({ month: '2026-11' }))
    expect(screen.queryByTestId('accounting-fx-deeplink-note')).toBeNull()
  })
})
