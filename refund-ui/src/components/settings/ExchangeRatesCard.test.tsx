/**
 * @vitest-environment jsdom
 *
 * ExchangeRatesCard (T26, specs/20261118-refund-accounting-export, design S5, F8, UX-10, UX-11; AC-5.2, AC-5.3, AC-5.5,
 * AC-5.6, AC-5.7): origin badges and Missing, the last fetch, the auto-fetch exactly once per visit (also after a
 * failure) that never moves focus, the persistent failure banner, Fetch now, a correction updating its cell, the
 * history drawer, controls hidden without manage, and the `&month=` deep link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../../lib/exchangeRatesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/exchangeRatesApi')>()
  return { ...original, listExchangeRates: vi.fn(), fetchExchangeRates: vi.fn(), putExchangeRate: vi.fn() }
})

import * as exchangeRatesApi from '../../lib/exchangeRatesApi'
import type {
  ExchangeRateMonth,
  ExchangeRates,
  FetchResult,
  LastFetch,
  Rate,
  RecordedRate,
} from '../../lib/exchangeRatesApi'
import { ApiError } from '../../lib/refundApi'
import ExchangeRatesCard from './ExchangeRatesCard'

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })
const pending = <T,>() => new Promise<T>(() => {})

const fetched = (rate: string, micros: number): RecordedRate => ({
  status: 'fetched',
  rateMicros: micros,
  rate,
  fetchedAt: '2026-04-02T07:00:00Z',
  history: [{ origin: 'fetched', rate, at: '2026-04-02T07:00:00Z', byEmail: 'system' }],
})

const corrected: RecordedRate = {
  status: 'corrected',
  rateMicros: 934000,
  rate: '0.934',
  correctedAt: '2026-04-10T10:00:00Z',
  correctedByEmail: 'admin@welld.ch',
  history: [
    { origin: 'fetched', rate: '0.9301', at: '2026-04-02T07:00:00Z', byEmail: 'system' },
    { origin: 'corrected', rate: '0.934', at: '2026-04-10T10:00:00Z', byEmail: 'admin@welld.ch' },
  ],
}

const MISSING: Rate = { status: 'missing' }

const MARCH: ExchangeRateMonth = {
  month: '2026-03',
  rates: { EUR: fetched('0.9246', 924600), USD: fetched('0.8102', 810200), GBP: MISSING },
}
const FEBRUARY: ExchangeRateMonth = {
  month: '2026-02',
  rates: { EUR: corrected, USD: fetched('0.8130', 813000), GBP: fetched('1.0750', 1075000) },
}

const OK_FETCH: LastFetch = { at: '2026-11-18T09:14:00Z', outcome: 'ok', errorCode: null, month: '2026-10' }
const FAILED_FETCH: LastFetch = { at: '2026-11-18T09:14:00Z', outcome: 'failed', errorCode: 'timeout', month: '2026-10' }

const rates = (overrides: Partial<ExchangeRates> = {}): ExchangeRates => ({
  months: [MARCH, FEBRUARY],
  lastFetch: OK_FETCH,
  fetchDue: false,
  ...overrides,
})

const result = (
  outcome: FetchResult['attempts'][number]['outcome'],
  extra: Partial<FetchResult['attempts'][number]> = {},
  lastFetch: LastFetch | null = OK_FETCH,
): FetchResult => ({
  attempts: [{ month: '2026-03', outcome, errorCode: null, recorded: null, ...extra }],
  lastFetch,
})

beforeEach(() => {
  vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderCard = async (props: { canManage?: boolean; month?: string } = {}) => {
  const view = render(<ExchangeRatesCard canManage={props.canManage ?? true} month={props.month} />)
  await screen.findByTestId('settings-fx-table')
  return view
}

const cell = (month: string, currency: string) => screen.getByTestId(`settings-fx-cell-${month}-${currency}`)
const fetchNow = () => screen.getByTestId('settings-fx-fetch-now') as HTMLButtonElement

describe('ExchangeRatesCard: the table', () => {
  it('shows a polite loading line and a skeleton while it loads', () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockReturnValue(pending())
    render(<ExchangeRatesCard canManage />)
    expect(screen.getByText('Loading exchange rates…').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('lists months newest first as row headers, in words, with EUR, USD and GBP columns', async () => {
    await renderCard()
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Month',
      'EUR',
      'USD',
      'GBP',
    ])
    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
      'March 2026',
      'February 2026',
    ])
    expect(screen.getByRole('heading', { name: 'Monthly exchange rates' })).not.toBeNull()
  })

  it('shows each rate as the server sends it, in mono, with its origin badge', async () => {
    await renderCard()
    const eur = cell('2026-03', 'EUR')
    expect(within(eur).getByText('0.9246').className).toContain('font-mono')
    expect(within(eur).getByText('Fetched')).not.toBeNull()
    // Trailing zero kept: no number formatting on a rate.
    expect(within(cell('2026-02', 'GBP')).getByText('1.0750')).not.toBeNull()
    const feb = cell('2026-02', 'EUR')
    expect(within(feb).getByText('0.934')).not.toBeNull()
    expect(within(feb).getByText('Corrected')).not.toBeNull()
  })

  it('shows a missing rate as a Missing badge, not as zero or a dash, and the row is otherwise normal', async () => {
    await renderCard()
    const gbp = cell('2026-03', 'GBP')
    expect(within(gbp).getByText('Missing')).not.toBeNull()
    expect(gbp.textContent).not.toMatch(/[0-9]|—/)
    expect(within(gbp).queryByText('Fetched')).toBeNull()
    expect(within(cell('2026-03', 'EUR')).queryByText('Missing')).toBeNull()
  })

  it('names every cell for a screen reader: currency, month, rate and origin', async () => {
    await renderCard()
    expect(cell('2026-03', 'EUR').getAttribute('aria-label')).toBe('EUR, March 2026: 0.9246, Fetched')
    expect(cell('2026-03', 'GBP').getAttribute('aria-label')).toBe('GBP, March 2026: missing')
  })

  it('says when the last fetch happened', async () => {
    await renderCard()
    expect(screen.getByTestId('settings-fx-last-fetch').textContent).toMatch(/Last fetch.*18\.11\.2026.*succeeded/)
  })

  it('says there has been no fetch yet', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ lastFetch: null }))
    await renderCard()
    expect(screen.getByTestId('settings-fx-last-fetch').textContent).toContain('No fetch yet')
  })

  it('says there are no months yet', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ months: [] }))
    render(<ExchangeRatesCard canManage />)
    expect((await screen.findByTestId('settings-fx-empty')).textContent).toContain('No months to show yet')
  })

  it('shows a retryable error when the load fails', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockRejectedValueOnce(problem(500))
    render(<ExchangeRatesCard canManage />)
    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not load the exchange rates.')
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByTestId('settings-fx-table')
    expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalledTimes(2)
  })

  it('is left out entirely when the load answers 403', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockRejectedValue(problem(403))
    const { container } = render(<ExchangeRatesCard canManage />)
    await waitFor(() => expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })
})

describe('ExchangeRatesCard: read-only without settings:manage (AC-5.7)', () => {
  it('hides Fetch now and every Correct, keeps History, and never auto-fetches even when due', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ fetchDue: true }))
    await renderCard({ canManage: false })
    expect(screen.queryByTestId('settings-fx-fetch-now')).toBeNull()
    expect(screen.queryByRole('button', { name: /Correct the/ })).toBeNull()
    expect(screen.getByTestId('settings-fx-history-2026-03-EUR')).not.toBeNull()
    await act(async () => {})
    expect(exchangeRatesApi.fetchExchangeRates).not.toHaveBeenCalled()
  })

  it('offers both with manage, one Correct per cell named after its cell (a missing one too)', async () => {
    await renderCard()
    expect(fetchNow().textContent).toBe('Fetch now')
    expect(screen.getAllByRole('button', { name: /^Correct the / })).toHaveLength(6)
    expect(screen.getByRole('button', { name: 'Correct the GBP rate for March 2026' })).not.toBeNull()
    // No History for a month with no rate: there is nothing to show.
    expect(screen.queryByTestId('settings-fx-history-2026-03-GBP')).toBeNull()
  })
})

describe('ExchangeRatesCard: the auto-fetch (UX-11)', () => {
  it('does not fetch when the server says nothing is due', async () => {
    await renderCard()
    await act(async () => {})
    expect(exchangeRatesApi.fetchExchangeRates).not.toHaveBeenCalled()
  })

  it('fetches exactly once when due, with a polite status line, then reloads the months and confirms', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates)
      .mockResolvedValueOnce(rates({ fetchDue: true }))
      .mockResolvedValue(
        rates({ months: [{ ...MARCH, rates: { ...MARCH.rates, GBP: fetched('1.0100', 1010000) } }, FEBRUARY] }),
      )
    let resolveFetch!: (value: FetchResult) => void
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )
    await renderCard()

    expect((await screen.findByTestId('settings-fx-checking')).textContent).toBe('Checking for new rates…')
    expect(screen.getByTestId('settings-fx-checking').getAttribute('role')).toBe('status')
    // The table stays usable while it runs.
    expect(screen.getByTestId('settings-fx-table')).not.toBeNull()

    await act(async () => resolveFetch(result('ok', { recorded: { GBP: 1010000 } })))

    expect((await screen.findByTestId('settings-fx-success')).textContent).toBe('Recorded the rates for 1 month.')
    await waitFor(() => expect(within(cell('2026-03', 'GBP')).getByText('1.0100')).not.toBeNull())
    expect(screen.queryByTestId('settings-fx-checking')).toBeNull()
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledTimes(1)
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledWith(undefined, 'settings_view')
  })

  it('says "No new rates to record." when the fetch recorded nothing', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ fetchDue: true }))
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(result('ok'))
    await renderCard()
    expect((await screen.findByTestId('settings-fx-success')).textContent).toBe('No new rates to record.')
    // Nothing recorded: the months are not loaded again.
    expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalledTimes(1)
  })

  it('never moves focus', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ fetchDue: true }))
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(result('ok', { recorded: { GBP: 1010000 } }))
    await renderCard()
    const before = document.activeElement
    await screen.findByTestId('settings-fx-success')
    await waitFor(() => expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalledTimes(2))
    expect(document.activeElement).toBe(before)
    expect(screen.getByTestId('settings-fx-card').contains(document.activeElement)).toBe(false)
  })

  it('does not fetch a second time after a failure, even though the server keeps saying it is due', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ fetchDue: true }))
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(
      result('failed', { errorCode: 'timeout' }, FAILED_FETCH),
    )
    await renderCard()
    await screen.findByTestId('settings-fx-failed')
    await act(async () => {})
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledTimes(1)
  })

  it('does not fetch again when "due" turns false and then true again within the same visit', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates)
      .mockResolvedValueOnce(rates({ fetchDue: true }))
      .mockResolvedValueOnce(rates({ fetchDue: false }))
      .mockResolvedValue(rates({ fetchDue: true }))
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(result('ok', { recorded: { GBP: 1 } }))
    await renderCard()
    // The automatic fetch recorded something, so the months reloaded (and are no longer due)...
    await waitFor(() => expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalledTimes(2))
    // ...then a manual fetch reloads them and the server says due again.
    fireEvent.click(fetchNow())
    await waitFor(() => expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalledTimes(3))
    await act(async () => {})
    // One automatic, one manual; the third "due" did not start another.
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledTimes(2)
  })

  it('shows an HTTP failure of the fetch call itself as a danger banner, and does not retry on its own', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ fetchDue: true }))
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockRejectedValue(problem(502))
    await renderCard()
    expect((await screen.findByTestId('settings-fx-fetch-error')).textContent).toContain(
      'Could not fetch the rates. Try again.',
    )
    await act(async () => {})
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledTimes(1)
  })
})

describe('ExchangeRatesCard: Fetch now and the persistent failure banner (AC-5.6)', () => {
  it('shows the failure the server remembers: when, why, and that the recorded rates are unchanged, with no ×', async () => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(rates({ lastFetch: FAILED_FETCH }))
    await renderCard()
    const banner = screen.getByTestId('settings-fx-failed')
    expect(banner.textContent).toContain('The last fetch failed')
    expect(banner.textContent).toMatch(/On 18\.11\.2026.*the official source did not answer in time/)
    expect(banner.textContent).toContain('The rates already recorded are unchanged.')
    expect(banner.getAttribute('aria-live')).toBe('polite')
    expect(within(banner).queryByRole('button')).toBeNull()
  })

  it.each([
    ['timeout', 'did not answer in time'],
    ['http_503', 'returned an error'],
    ['parse', 'could not be read'],
    ['month_mismatch', 'different month'],
    ['currency_missing', 'currency was missing'],
    ['something_new', 'an unknown error occurred'],
  ])('puts a plain reason on the error code %s', async (errorCode, text) => {
    vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue(
      rates({ lastFetch: { ...FAILED_FETCH, errorCode } }),
    )
    await renderCard()
    expect(screen.getByTestId('settings-fx-failed').textContent).toContain(text)
    expect(screen.getByTestId('settings-fx-failed').textContent).not.toContain(errorCode === 'timeout' ? 'http' : errorCode)
  })

  it('a failed Fetch now puts the banner up at once, leaves the rates alone, and a later success takes it down', async () => {
    await renderCard()
    expect(screen.queryByTestId('settings-fx-failed')).toBeNull()

    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValueOnce(
      result('failed', { errorCode: 'http_500' }, { ...FAILED_FETCH, errorCode: 'http_500' }),
    )
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('settings-fx-failed')).textContent).toContain('returned an error')
    // A failed fetch is not a recorded rate: no months reload, no confirmation, nothing changed.
    expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('settings-fx-success')).toBeNull()
    expect(within(cell('2026-03', 'EUR')).getByText('0.9246')).not.toBeNull()

    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValueOnce(result('ok', {}, OK_FETCH))
    fireEvent.click(fetchNow())
    await waitFor(() => expect(screen.queryByTestId('settings-fx-failed')).toBeNull())
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledTimes(2)
  })

  it('the button is busy and says so while a fetch runs, and cannot be pressed twice', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockReturnValue(pending())
    await renderCard()
    fireEvent.click(fetchNow())
    await waitFor(() => expect(fetchNow().textContent).toBe('Fetching…'))
    expect(fetchNow().getAttribute('aria-busy')).toBe('true')
    fireEvent.click(fetchNow())
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledTimes(1)
  })

  it('says how many months a manual fetch recorded', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue({
      attempts: [
        { month: '2026-03', outcome: 'ok', errorCode: null, recorded: { GBP: 1010000 } },
        { month: '2026-02', outcome: 'ok', errorCode: null, recorded: { EUR: 930100, USD: 810200 } },
        { month: '2026-01', outcome: 'ok', errorCode: null, recorded: null },
      ],
      lastFetch: OK_FETCH,
    })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('settings-fx-success')).textContent).toBe('Recorded the rates for 2 months.')
  })

  it('a month not published yet is a note, not an error, and not "no new rates"', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(result('not_fetchable', { month: '2026-10' }))
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('settings-fx-note')).textContent).toBe(
      'The rates for October 2026 are not published yet.',
    )
    expect(screen.queryByTestId('settings-fx-success')).toBeNull()
    expect(screen.queryByTestId('settings-fx-failed')).toBeNull()
    expect(screen.queryByTestId('settings-fx-fetch-error')).toBeNull()
  })

  it('Fetch now tells the server an administrator asked', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(result('ok'))
    await renderCard()
    fireEvent.click(fetchNow())
    await screen.findByTestId('settings-fx-success')
    expect(exchangeRatesApi.fetchExchangeRates).toHaveBeenCalledWith(undefined, 'admin')
  })

  it('a throttled fetch is information: nothing recorded, no error, no "no new rates"', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(result('throttled'))
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('settings-fx-note')).textContent).toBe(
      'The rates were checked a moment ago. Try again in a few minutes.',
    )
    expect(screen.queryByTestId('settings-fx-success')).toBeNull()
    expect(screen.queryByTestId('settings-fx-fetch-error')).toBeNull()
    expect(screen.queryByTestId('settings-fx-failed')).toBeNull()
  })

  it('tells the administrator that more months remain when the server deferred some', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue({
      ...result('ok', { recorded: { GBP: 1 } }),
      deferredMonths: ['2026-01', '2026-02'],
    })
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('settings-fx-success')).textContent).toBe('Recorded the rates for 1 month.')
    expect(screen.getByTestId('settings-fx-note').textContent).toBe(
      '2 more months are still to fetch. Fetch again to continue.',
    )
  })

  it('says fetching is switched off in this environment', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockResolvedValue(result('disabled'))
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('settings-fx-disabled')).textContent).toBe(
      'Automatic fetching is turned off in this environment. Enter the rates by hand.',
    )
    expect(screen.queryByTestId('settings-fx-success')).toBeNull()
  })

  it('a 403 on Fetch now reads as a permission problem', async () => {
    vi.mocked(exchangeRatesApi.fetchExchangeRates).mockRejectedValue(problem(403))
    await renderCard()
    fireEvent.click(fetchNow())
    expect((await screen.findByTestId('settings-fx-fetch-error')).textContent).toContain(
      "You don't have permission to do this.",
    )
  })
})

describe('ExchangeRatesCard: correcting a rate (AC-5.3)', () => {
  const open = (month: string, currency: string) =>
    fireEvent.click(screen.getByTestId(`settings-fx-correct-${month}-${currency}`))

  it('opens the dialog for that cell, saves, updates the cell to Corrected and confirms', async () => {
    const saved: ExchangeRateMonth = { ...MARCH, rates: { ...MARCH.rates, EUR: { ...corrected, rate: '0.93', rateMicros: 930000 } } }
    vi.mocked(exchangeRatesApi.putExchangeRate).mockResolvedValue(saved)
    await renderCard()

    open('2026-03', 'EUR')
    expect(await screen.findByRole('dialog', { name: 'Correct rate — EUR · March 2026' })).not.toBeNull()
    fireEvent.change(screen.getByTestId('rate-correction-value'), { target: { value: '0,93' } })
    fireEvent.click(screen.getByTestId('rate-correction-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(exchangeRatesApi.putExchangeRate).toHaveBeenCalledWith('2026-03', 'EUR', '0.93')
    const eur = cell('2026-03', 'EUR')
    expect(within(eur).getByText('0.93')).not.toBeNull()
    expect(within(eur).getByText('Corrected')).not.toBeNull()
    expect(screen.getByTestId('settings-fx-success').textContent).toBe('EUR rate for March 2026 corrected')
    // The other cells are untouched, and the server's answer was used as it is: no second GET.
    expect(within(cell('2026-03', 'USD')).getByText('0.8102')).not.toBeNull()
    expect(exchangeRatesApi.listExchangeRates).toHaveBeenCalledTimes(1)
  })

  it('lets an administrator enter the rate for a month the source never published, and returns focus to its button', async () => {
    const saved: ExchangeRateMonth = { ...MARCH, rates: { ...MARCH.rates, GBP: corrected } }
    vi.mocked(exchangeRatesApi.putExchangeRate).mockResolvedValue(saved)
    await renderCard()

    open('2026-03', 'GBP')
    await screen.findByRole('dialog')
    expect(screen.queryByText(/In effect:/)).toBeNull()
    fireEvent.change(screen.getByTestId('rate-correction-value'), { target: { value: '0.934' } })
    fireEvent.click(screen.getByTestId('rate-correction-submit'))

    await waitFor(() => expect(within(cell('2026-03', 'GBP')).getByText('Corrected')).not.toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('settings-fx-correct-2026-03-GBP')))
  })

  it('Cancel returns focus to the Correct button that opened the dialog', async () => {
    await renderCard()
    open('2026-02', 'USD')
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByTestId('rate-correction-cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('settings-fx-correct-2026-02-USD')))
    expect(exchangeRatesApi.putExchangeRate).not.toHaveBeenCalled()
  })

  it('is mounted beside the card, never inside a form', async () => {
    await renderCard()
    open('2026-03', 'EUR')
    await screen.findByRole('dialog')
    expect(document.querySelectorAll('form form')).toHaveLength(0)
    expect(screen.getByTestId('settings-fx-card').querySelector('form')).toBeNull()
  })
})

describe('ExchangeRatesCard: the history of one rate (S6e)', () => {
  it('opens a drawer with the rate and its origin, newest first, and returns focus to its button', async () => {
    await renderCard()
    const opener = screen.getByTestId('settings-fx-history-2026-02-EUR')
    expect(opener.getAttribute('aria-label')).toBe('Show the history of the EUR rate for February 2026')
    fireEvent.click(opener)

    const table = await screen.findByTestId('refund-history-table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(within(rows[0]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['admin@welld.ch', '0.934', 'Corrected'])
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['system', '0.9301', 'Fetched'])
    expect(screen.getByRole('dialog', { name: 'History — the EUR rate for February 2026' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close the history' }))
    await waitFor(() => expect(screen.queryByTestId('refund-history-table')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})

describe('ExchangeRatesCard: the &month= deep link (AC-5.7, F8 step 5)', () => {
  it('puts focus on that month’s row header when the table appears', async () => {
    await renderCard({ month: '2026-02' })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(screen.getByTestId('settings-fx-row-2026-02')).getByRole('rowheader')),
    )
  })

  it('shows the table from the top, with no focus move, for a month outside the window', async () => {
    await renderCard({ month: '2024-01' })
    await act(async () => {})
    expect(screen.getByTestId('settings-fx-card').contains(document.activeElement)).toBe(false)
  })

  it('moves no focus without a month', async () => {
    await renderCard()
    expect(screen.getByTestId('settings-fx-card').contains(document.activeElement)).toBe(false)
  })
})
