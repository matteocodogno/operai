/**
 * @vitest-environment jsdom
 *
 * RateCorrectionDialog (T26, specs/20261118-refund-accounting-export, design S6f, F8; AC-5.3): the rate parsed exactly from
 * a dot or a comma and sent canonical, the server's bound (0 < rate < 1000, 6 decimals), the rate in effect in
 * the hint, the two 422s, permission and generic failures, and every typed value kept.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expectNoAxeViolations } from '../../test-support/axe'

vi.mock('../../lib/exchangeRatesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/exchangeRatesApi')>()
  return { ...original, putExchangeRate: vi.fn() }
})

import * as exchangeRatesApi from '../../lib/exchangeRatesApi'
import type { ExchangeRateMonth, Rate } from '../../lib/exchangeRatesApi'
import { ApiError } from '../../lib/refundApi'
import RateCorrectionDialog from './RateCorrectionDialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const FETCHED: Rate = {
  status: 'fetched',
  rateMicros: 924600,
  rate: '0.9246',
  history: [{ origin: 'fetched', rate: '0.9246', at: '2026-04-02T07:00:00Z', byEmail: 'system' }],
}

const ROW: ExchangeRateMonth = {
  month: '2026-03',
  rates: { EUR: { status: 'corrected', rateMicros: 930000, rate: '0.93', history: [] }, USD: FETCHED, GBP: FETCHED },
}

const setup = (rate: Rate = FETCHED) => {
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  render(<RateCorrectionDialog month="2026-03" currency="EUR" rate={rate} onSaved={onSaved} onCancel={onCancel} />)
  return { onSaved, onCancel }
}

const input = () => screen.getByTestId('rate-correction-value') as HTMLInputElement
const type = (value: string) => fireEvent.change(input(), { target: { value } })
const submit = () => fireEvent.click(screen.getByTestId('rate-correction-submit'))
const submitButton = () => screen.getByTestId('rate-correction-submit') as HTMLButtonElement

describe('RateCorrectionDialog', () => {
  it('names the currency and the month, says the old value stays in the history, and shows the rate in effect', () => {
    setup()
    expect(screen.getByRole('dialog', { name: 'Correct rate — EUR · March 2026' })).not.toBeNull()
    expect(screen.getByText(/The previous value stays in the history\./).textContent).toContain(
      'A batch exported before this correction will export differently if it is exported again.',
    )
    expect(screen.getByLabelText(/Rate \(CHF per 1 EUR\)/)).toBe(input())
    expect(screen.getByText('In effect: 0.9246 (Fetched)')).not.toBeNull()
  })

  it('has no "in effect" hint for a month with no rate yet', () => {
    setup({ status: 'missing' })
    expect(screen.queryByText(/In effect:/)).toBeNull()
  })

  it('sends a typed comma as the canonical dot string and reports the whole month row', async () => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockResolvedValue(ROW)
    const { onSaved } = setup()
    type('0,93')
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(ROW))
    expect(exchangeRatesApi.putExchangeRate).toHaveBeenCalledWith('2026-03', 'EUR', '0.93')
  })

  it('sends six decimals exactly, and trailing zeros trimmed', async () => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockResolvedValue(ROW)
    setup({ status: 'missing' })
    type('0.100000')
    submit()
    await waitFor(() => expect(exchangeRatesApi.putExchangeRate).toHaveBeenCalledWith('2026-03', 'EUR', '0.1'))
  })

  it('accepts 999.999999 and refuses 1000, 0, a seventh decimal and text, without calling the server', async () => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockResolvedValue(ROW)
    setup({ status: 'missing' })
    type('999.999999')
    submit()
    await waitFor(() => expect(exchangeRatesApi.putExchangeRate).toHaveBeenCalledWith('2026-03', 'EUR', '999.999999'))
    vi.mocked(exchangeRatesApi.putExchangeRate).mockClear()
    cleanup()

    for (const bad of ['1000', '0', '0.0000001', 'abc', '-1']) {
      setup({ status: 'missing' })
      type(bad)
      submit()
      expect((await screen.findByTestId('rate-correction-value-error')).textContent).toBe(
        'Enter a rate greater than 0, with up to 6 decimals.',
      )
      expect(document.activeElement).toBe(input())
      cleanup()
    }
    expect(exchangeRatesApi.putExchangeRate).not.toHaveBeenCalled()
  })

  it('disables Save while empty and while the value equals the rate in effect', () => {
    setup()
    expect(submitButton().disabled).toBe(true)
    type('0.92460')
    expect(submitButton().disabled).toBe(true)
    type('0.9247')
    expect(submitButton().disabled).toBe(false)
  })

  it('shows a field error for 422 invalid_rate, keeps the typed value and focuses the field', async () => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockRejectedValue(problem(422, 'invalid_rate'))
    setup()
    type('0.95')
    submit()
    expect((await screen.findByTestId('rate-correction-value-error')).textContent).toBe(
      'Enter a rate greater than 0, with up to 6 decimals.',
    )
    expect(input().value).toBe('0.95')
    await waitFor(() => expect(document.activeElement).toBe(input()))
  })

  it('shows a general error for 422 month_not_completed (no field can fix it)', async () => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockRejectedValue(problem(422, 'month_not_completed'))
    setup()
    type('0.95')
    submit()
    expect(await screen.findByText('This month is not finished yet; its rate cannot be corrected.')).not.toBeNull()
    expect(screen.queryByTestId('rate-correction-value-error')).toBeNull()
    expect(input().value).toBe('0.95')
  })

  it.each([
    [422, 'Could not save. Try again.', 'invalid_month'],
    [404, 'Could not save. Try again.', undefined],
  ])('a %i (%s) is a general error, not a field error', async (status, message, code) => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockRejectedValue(problem(status, code))
    setup()
    type('0.95')
    submit()
    expect(await screen.findByText(message)).not.toBeNull()
    expect(screen.queryByTestId('rate-correction-value-error')).toBeNull()
  })

  it.each([
    [403, "You don't have permission to do this."],
    [500, 'Could not save. Try again.'],
  ])('a %i answers with its own message, and the value stays for another try', async (status, message) => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockRejectedValue(problem(status))
    setup()
    type('0.95')
    submit()
    expect(await screen.findByText(message)).not.toBeNull()
    expect(input().value).toBe('0.95')
    expect(submitButton().disabled).toBe(false)
  })

  it('is busy and not dismissible while saving', async () => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockReturnValue(new Promise(() => {}))
    const { onCancel } = setup()
    type('0.95')
    submit()
    await waitFor(() => expect(submitButton().textContent).toBe('Saving…'))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Cancel reports without writing', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByTestId('rate-correction-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(exchangeRatesApi.putExchangeRate).not.toHaveBeenCalled()
  })
})

// T44: automated axe checks (test-support/axe.ts) on every state of the dialog.
describe('RateCorrectionDialog: accessibility (axe)', () => {
  it('has no violations: a month with a rate in effect, a missing month, and a typed value', async () => {
    setup()
    await expectNoAxeViolations()
    type('0,93')
    await expectNoAxeViolations()
    cleanup()

    setup({ status: 'missing' })
    await expectNoAxeViolations()
  })

  it.each([
    ['a field error (422 invalid_rate)', 422, 'invalid_rate', 'rate-correction-value-error'],
    ['a general error (422 month_not_completed)', 422, 'month_not_completed', undefined],
    ['a permission error (403)', 403, undefined, undefined],
    ['a server error (500)', 500, undefined, undefined],
  ])('has no violations: %s', async (_name, status, code, fieldTestId) => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockRejectedValue(problem(status, code))
    setup()
    type('0.95')
    submit()
    await waitFor(() => expect(submitButton().disabled).toBe(false))
    if (fieldTestId) await screen.findByTestId(fieldTestId)
    await expectNoAxeViolations()
  })

  it('has no violations while saving', async () => {
    vi.mocked(exchangeRatesApi.putExchangeRate).mockReturnValue(new Promise(() => {}))
    setup()
    type('0.95')
    submit()
    await waitFor(() => expect(submitButton().textContent).toBe('Saving…'))
    await expectNoAxeViolations()
  })
})
