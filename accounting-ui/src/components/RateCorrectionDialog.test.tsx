/**
 * @vitest-environment jsdom
 *
 * RateCorrectionDialog (T31, specs/20261119-accounting, design FA8, AS6c, UX-6, UX-10; AC-2.4, AC-2.5, AC-8.4): UX-10's
 * description (what was booked keeps its rate; no re-export sentence), the rate in the entity's own currency, AC-2.5's limit as text
 * (above 0, below 1000, up to 6 decimals, dot or comma, sent canonically), Save disabled while empty or equal to the rate in
 * effect, the 422 codes, 403 and 404 reaching the frame, values kept on failure, focus on the field with no `ErrorSummary`, and
 * axe on every state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { fakeApi, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'
import type { Rate } from '../lib/exchangeRatesApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import RateCorrectionDialog from './RateCorrectionDialog'

const PUT = 'PUT /v1/entities/welld_ch/exchange-rates/2026-03/EUR'
const never = (): Promise<FakeAnswer> => new Promise(() => {})
const serve = (handler: FakeHandler) => apiFetch.mockImplementation(fakeApi({ [PUT]: handler }))
const puts = () => apiFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
const sent = () => JSON.parse(String(puts()[0]![1]!.body))

const EUR_FETCHED: Rate = { status: 'fetched', rateMicros: 924600, rate: '0.9246' }
const EUR_CORRECTED: Rate = { status: 'corrected', rateMicros: 934000, rate: '0.934' }
const MISSING: Rate = { status: 'missing' }

const ROW = {
  month: '2026-03',
  rates: { EUR: { status: 'corrected', rateMicros: 930000, rate: '0.93' }, USD: { status: 'missing' } },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const setup = (rate: Rate = EUR_FETCHED) => {
  const handlers = { onCancel: vi.fn(), onSaved: vi.fn(), onForbidden: vi.fn(), onGone: vi.fn() }
  const view = render(
    <RateCorrectionDialog
      entity="welld_ch"
      ownCurrency="CHF"
      currencies={['EUR', 'USD']}
      month="2026-03"
      currency="EUR"
      rate={rate}
      {...handlers}
    />,
  )
  return { ...handlers, ...view }
}

const type = (value: string) => fireEvent.change(screen.getByTestId('accounting-fx-correction-value'), { target: { value } })
const save = () => fireEvent.click(screen.getByTestId('accounting-fx-correction-submit'))
const fieldError = () => screen.getByTestId('accounting-fx-correction-value-error').textContent
const generalError = () => screen.getByTestId('accounting-fx-correction-error').textContent
const RATE_INVALID = 'Enter a rate greater than 0 and below 1000, with up to 6 decimals.'

describe('RateCorrectionDialog', () => {
  it('names currency and month in its title, the own currency in the label, and says what was already booked keeps its rate (UX-10)', () => {
    setup()
    const dialog = screen.getByRole('dialog', { name: 'Correct rate — EUR · March 2026' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(
      screen.getByText(
        'Anything booked from now on uses this rate. What was already booked with the previous rate keeps it. The previous value is kept in the audit trail.',
      ),
    ).not.toBeNull()
    // the 20261118 sentence is false after AC-5.3 and must be gone
    expect(dialog.textContent).not.toMatch(/exported before|export differently|exported again/i)
    expect(screen.getByLabelText(/Rate \(CHF per 1 EUR\)/)).not.toBeNull()
  })

  it('states the limit and the rate in effect with its origin as the hint; never prefills the field', () => {
    setup(EUR_CORRECTED)
    const input = screen.getByTestId('accounting-fx-correction-value') as HTMLInputElement
    expect(input.value).toBe('')
    const hint = document.getElementById(input.getAttribute('aria-describedby')!.split(' ')[0]!)!
    expect(hint.textContent).toBe('Greater than 0 and below 1000, up to 6 decimals. In effect: 0.934 (Corrected)')
  })

  it('for a missing month has only the limit as its hint, and a manager may type a rate', async () => {
    serve(() => ({ status: 200, body: ROW }))
    setup(MISSING)
    const input = screen.getByTestId('accounting-fx-correction-value')
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Greater than 0 and below 1000, up to 6 decimals.',
    )
    type('0.93')
    save()
    await waitFor(() => expect(puts()).toHaveLength(1))
  })

  it('focuses the field on open and keeps Save disabled while it is empty', () => {
    setup()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-fx-correction-value'))
    expect((screen.getByTestId('accounting-fx-correction-submit') as HTMLButtonElement).disabled).toBe(true)
    type('0.93')
    expect((screen.getByTestId('accounting-fx-correction-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it.each(['0.9246', '0,9246', '0.924600', ' 0.9246 '])('keeps Save disabled for %j, the rate already in effect (a no-op writes nothing)', (value) => {
    setup(EUR_FETCHED)
    type(value)
    expect((screen.getByTestId('accounting-fx-correction-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    ['0.93', '0.93'],
    ['0,93', '0.93'],
    ['0.930000', '0.93'],
    ['1', '1'],
    ['1.000000', '1'],
    ['0.000001', '0.000001'],
    ['999.999999', '999.999999'],
    ['999', '999'],
    [' 0.9300 ', '0.93'],
  ])('accepts %j (AC-2.5) and sends it as the canonical string %j', async (typed, canonical) => {
    serve(() => ({ status: 200, body: ROW }))
    setup()
    type(typed)
    save()
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(sent()).toEqual({ rate: canonical })
    expect(String(puts()[0]![0])).toBe('http://accounting-api.test/v1/entities/welld_ch/exchange-rates/2026-03/EUR')
  })

  it.each(['0', '0.0', '0.000000', '1000', '1000.5', '9999', '0.0000001', '-1', '1e3', 'abc', '1..2', '1,2,3', '.5'])(
    'refuses %j without a request, names the limit, marks the field and focuses it (AC-2.5)',
    async (typed) => {
      setup()
      type(typed)
      save()
      expect(fieldError()).toBe(RATE_INVALID)
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-fx-correction-value')))
      expect(screen.getByTestId('accounting-fx-correction-value').getAttribute('aria-invalid')).toBe('true')
      expect(puts()).toHaveLength(0)
    },
  )

  it('says the same on blur, before any submit, and clears the error as soon as the value changes', () => {
    setup()
    type('1000')
    fireEvent.blur(screen.getByTestId('accounting-fx-correction-value'))
    expect(fieldError()).toBe(RATE_INVALID)
    type('999')
    expect(screen.queryByTestId('accounting-fx-correction-value-error')).toBeNull()
  })

  it('has no ErrorSummary: a refused value is one alert on its own field, announced once (UX-6)', () => {
    setup()
    type('0')
    save()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('reports the month row the server answers and nothing else', async () => {
    serve(() => ({ status: 200, body: ROW }))
    const { onSaved } = setup()
    type('0.93')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaved.mock.calls[0]![0]).toEqual({
      month: '2026-03',
      rates: { EUR: { status: 'corrected', rateMicros: 930000, rate: '0.93' }, USD: { status: 'missing' } },
    })
  })

  it('reports null when the server recorded nothing (a 200 with no row)', async () => {
    serve(() => ({ status: 200 }))
    const { onSaved } = setup()
    type('0.93')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null))
  })

  it('a 422 invalid_rate is a field error with focus; month_not_completed and currency_not_convertible are general errors', async () => {
    const answers = [
      problem(422, 'invalid_rate'),
      problem(422, 'month_not_completed'),
      problem(422, 'currency_not_convertible'),
    ]
    serve(() => answers.shift()!)
    setup()
    type('0.93')
    save()
    await waitFor(() => expect(fieldError()).toBe(RATE_INVALID))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-fx-correction-value')))

    type('0.94')
    save()
    await waitFor(() => expect(generalError()).toBe('This month is not finished yet; its rate cannot be corrected.'))
    save()
    await waitFor(() => expect(generalError()).toBe("This currency has no rate: it is the entity's own currency."))
    expect((screen.getByTestId('accounting-fx-correction-value') as HTMLInputElement).value).toBe('0.94')
  })

  it('a 403 says permission and tells the frame; a 404 says generic and tells the frame; a failure says retry; values stay', async () => {
    const answers: Array<FakeAnswer | 'offline'> = [problem(403, 'accounting_manage_required'), problem(404, 'not_found'), 'offline', problem(500)]
    apiFetch.mockImplementation(async () => {
      const next = answers.shift()!
      if (next === 'offline') throw new TypeError('offline')
      return new Response(JSON.stringify(next.body), { status: next.status })
    })
    const { onForbidden, onGone } = setup()
    type('0.93')
    save()
    await waitFor(() => expect(generalError()).toBe("You don't have permission to do this."))
    expect(onForbidden).toHaveBeenCalledTimes(1)
    save()
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1))
    expect(generalError()).toBe('Could not save. Try again.')
    save()
    await waitFor(() => expect(puts()).toHaveLength(3))
    await waitFor(() => expect(generalError()).toBe('Could not save. Try again.'))
    save()
    await waitFor(() => expect(puts()).toHaveLength(4))
    expect((screen.getByTestId('accounting-fx-correction-value') as HTMLInputElement).value).toBe('0.93')
  })

  it('is busy while saving: "Saving…", the field disabled, and a second submit sends nothing', async () => {
    serve(never)
    setup()
    type('0.93')
    save()
    await waitFor(() => expect(screen.getByTestId('accounting-fx-correction-submit').textContent).toBe('Saving…'))
    expect(screen.getByTestId('accounting-fx-correction-value').matches(':disabled')).toBe(true)
    save()
    expect(puts()).toHaveLength(1)
  })

  it('Cancel and Escape cancel', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByTestId('accounting-fx-correction-cancel'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('RateCorrectionDialog: accessibility (axe)', () => {
  it('has no violations: idle, filled, refused, a general error and while saving', async () => {
    const answers: FakeAnswer[] = [problem(422, 'month_not_completed')]
    serve(() => answers.shift() ?? never())
    setup(EUR_CORRECTED)
    await expectNoAxeViolations()
    type('0.95')
    await expectNoAxeViolations()
    type('1000')
    save()
    await screen.findByTestId('accounting-fx-correction-value-error')
    await expectNoAxeViolations()
    type('0.95')
    save()
    await screen.findByTestId('accounting-fx-correction-error')
    await expectNoAxeViolations()
    save()
    await waitFor(() => expect(screen.getByTestId('accounting-fx-correction-submit').textContent).toBe('Saving…'))
    await expectNoAxeViolations()
  })
})
