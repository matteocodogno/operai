/**
 * @vitest-environment jsdom
 *
 * AddVatCodeDialog (T30, specs/20261119-accounting, design FA4, AS6b, UX-3, UX-6; AC-1.5, AC-1.6, AC-1.7, AC-8.4): the entity in
 * the title, required fields, the code upper-cased, the limits of `lib/limits.ts` with one sentence per reason, the rate as
 * text (dot or comma, 0 to 100, 2 decimals, sent canonically), a case-insensitive duplicate with the reactivation pointer decided
 * by the server's `reactivate` flag (G9), the server's `fields[]` mapped to the same sentences, values kept on failure, focus on
 * the first refused field with no `ErrorSummary`, and axe on every state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { fakeApi, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'
import type { VatCode } from '../lib/catalogApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import AddVatCodeDialog from './AddVatCodeDialog'

const POST = 'POST /v1/entities/welld_ch/vat-codes'
const never = (): Promise<FakeAnswer> => new Promise(() => {})
const serve = (handler: FakeHandler) => apiFetch.mockImplementation(fakeApi({ [POST]: handler }))
const posts = () => apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
const sent = () => JSON.parse(String(posts()[0]![1]!.body))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const vat = (overrides: Partial<VatCode> = {}): VatCode => ({
  code: 'IMP81',
  label: 'Imposta 8.1%',
  ratePercent: '8.1',
  active: true,
  ...overrides,
})

const setup = (vatCodes: VatCode[] = []) => {
  const handlers = { onAdded: vi.fn(), onCancel: vi.fn(), onStale: vi.fn(), onForbidden: vi.fn(), onGone: vi.fn() }
  const view = render(<AddVatCodeDialog entity="welld_ch" vatCodes={vatCodes} {...handlers} />)
  return { ...handlers, ...view }
}

const fill = (code: string, label: string, rate: string) => {
  fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: code } })
  fireEvent.change(screen.getByTestId('accounting-vat-label'), { target: { value: label } })
  fireEvent.change(screen.getByTestId('accounting-vat-rate'), { target: { value: rate } })
}
const submit = () => fireEvent.click(screen.getByTestId('accounting-vat-dialog-submit'))
const err = (field: 'code' | 'label' | 'rate') => screen.getByTestId(`accounting-vat-${field}-error`).textContent

describe('AddVatCodeDialog', () => {
  it('names the entity in its title and says the rate cannot be changed later (AC-1.7)', () => {
    setup()
    const dialog = screen.getByRole('dialog', { name: 'Add VAT code — WellD CH' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('The rate cannot be changed later: a new rate needs a new code.')).not.toBeNull()
    expect(screen.getByText('Letters, digits, - and _ (up to 16). Saved in capitals.')).not.toBeNull()
    expect(screen.getByText('Between 0 and 100, up to 2 decimals.')).not.toBeNull()
    expect(screen.getByLabelText(/VAT rate \(%\)/)).not.toBeNull()
  })

  it('focuses the code on open and keeps Save disabled until all three fields have text', () => {
    setup()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-code'))
    const save = screen.getByTestId('accounting-vat-dialog-submit') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: 'IMP81' } })
    fireEvent.change(screen.getByTestId('accounting-vat-label'), { target: { value: 'Imposta' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('accounting-vat-rate'), { target: { value: '8,1' } })
    expect(save.disabled).toBe(false)
  })

  it('upper-cases the code on blur and sends it in capitals with trimmed values (AC-1.5)', async () => {
    serve(() => ({ status: 201, body: vat({ code: 'IMP81' }) }))
    const { onAdded } = setup()
    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: ' imp81 ' } })
    fireEvent.blur(screen.getByTestId('accounting-vat-code'))
    expect((screen.getByTestId('accounting-vat-code') as HTMLInputElement).value).toBe('IMP81')
    fireEvent.change(screen.getByTestId('accounting-vat-label'), { target: { value: '  Imposta 8.1%  ' } })
    fireEvent.change(screen.getByTestId('accounting-vat-rate'), { target: { value: '8.1' } })
    submit()
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(String(posts()[0]![0])).toBe('http://accounting-api.test/v1/entities/welld_ch/vat-codes')
    expect(sent()).toEqual({ code: 'IMP81', label: 'Imposta 8.1%', ratePercent: '8.1' })
  })

  it('upper-cases a code that was never blurred, on submit', async () => {
    serve(() => ({ status: 201, body: vat() }))
    setup()
    fill('imp81', 'Imposta', '8.1')
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(sent().code).toBe('IMP81')
  })

  it.each([
    ['8.1', '8.1'],
    ['8,1', '8.1'],
    ['8,10', '8.1'],
    ['8.00', '8'],
    ['0', '0'],
    ['0,05', '0.05'],
    ['100', '100'],
    ['100.00', '100'],
    [' 7.7 ', '7.7'],
  ])('accepts the rate %j and sends it as %j (text, never through a float)', async (typed, canonical) => {
    serve(() => ({ status: 201, body: vat() }))
    setup()
    fill('IMP81', 'Imposta', typed)
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(sent().ratePercent).toBe(canonical)
  })

  it.each(['100.01', '101', '1000', '8.123', '-1', 'abc', '8..1', '8,1,2', '8%', '.5'])(
    'refuses the rate %j without a request, names the limit and focuses the field',
    async (typed) => {
      setup()
      fill('IMP81', 'Imposta', typed)
      submit()
      expect(err('rate')).toBe('Enter a rate between 0 and 100, with up to 2 decimals.')
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-rate')))
      expect(screen.getByTestId('accounting-vat-rate').getAttribute('aria-invalid')).toBe('true')
      expect(posts()).toHaveLength(0)
    },
  )

  it.each([
    ['a b', 'Use letters, digits, - or _ only.'],
    ['IMP.81', 'Use letters, digits, - or _ only.'],
    ['IMPÔ', 'Use letters, digits, - or _ only.'],
    ['X'.repeat(17), 'The code can have up to 16 characters.'],
  ])('refuses the code %j for its own reason', (value, sentence) => {
    setup()
    fill(value, 'Imposta', '8.1')
    submit()
    expect(err('code')).toBe(sentence)
    expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-code'))
    expect(posts()).toHaveLength(0)
  })

  it('accepts a code of 16 characters with - and _', async () => {
    serve(() => ({ status: 201, body: vat() }))
    setup()
    fill('A-1_' + 'B'.repeat(12), 'Imposta', '8.1')
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('refuses a label longer than 80 characters, and 80 passes', async () => {
    serve(() => ({ status: 201, body: vat() }))
    setup()
    fill('IMP81', 'x'.repeat(81), '8.1')
    submit()
    expect(err('label')).toBe('The label can have up to 80 characters.')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-label'))
    fill('IMP81', 'x'.repeat(80), '8.1')
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('focuses the FIRST refused field, and shows one alert per refused field, no ErrorSummary (UX-6)', () => {
    setup()
    fill('a b', 'y'.repeat(81), 'abc')
    submit()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-code'))
    expect(screen.getAllByRole('alert')).toHaveLength(3)
  })

  it('names a case-insensitive duplicate on blur and submit, before any request (AC-1.6)', () => {
    setup([vat({ code: 'IMP81' })])
    fill('imp81', 'Imposta', '8.1')
    fireEvent.blur(screen.getByTestId('accounting-vat-code'))
    expect(err('code')).toBe('VAT code IMP81 already exists in WellD CH.')
    submit()
    expect(err('code')).toBe('VAT code IMP81 already exists in WellD CH.')
    expect(posts()).toHaveLength(0)
  })

  it('points to Reactivate when the existing code is deactivated', () => {
    setup([vat({ code: 'IMP81', active: false })])
    fill('Imp81', 'Imposta', '8.1')
    fireEvent.blur(screen.getByTestId('accounting-vat-code'))
    expect(err('code')).toBe('VAT code IMP81 already exists but is deactivated. Reactivate it from the list.')
  })

  it('clears a field’s error as soon as its value changes', () => {
    setup()
    fill('a b', 'Imposta', '8.1')
    submit()
    expect(screen.getByTestId('accounting-vat-code-error')).not.toBeNull()
    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: 'AB' } })
    expect(screen.queryByTestId('accounting-vat-code-error')).toBeNull()
  })

  describe('a 409 from the server (G9)', () => {
    it.each([
      [{ reactivate: false }, 'VAT code IMP81 already exists in WellD CH.'],
      [{ reactivate: true }, 'VAT code IMP81 already exists but is deactivated. Reactivate it from the list.'],
    ])('with %j the sentence follows the flag, keeps the values, focuses the code and asks the card to reload', async (extras, sentence) => {
      serve(() => problem(409, 'vat_code_duplicate', { vatCode: 'IMP81', ...extras }))
      const { onAdded, onStale } = setup()
      fill('imp81', 'Imposta', '8.1')
      submit()
      await waitFor(() => expect(err('code')).toBe(sentence))
      expect((screen.getByTestId('accounting-vat-label') as HTMLInputElement).value).toBe('Imposta')
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-code')))
      expect(onAdded).not.toHaveBeenCalled()
      expect(onStale).toHaveBeenCalledTimes(1)
    })

    it('an ACTIVE duplicate never gets the reactivation pointer, even if the list is stale and says deactivated', async () => {
      serve(() => problem(409, 'vat_code_duplicate', { vatCode: 'IMP77', reactivate: false }))
      setup([vat({ code: 'IMP77', active: false })])
      fill('IMP78', 'Imposta', '7.7')
      submit()
      await waitFor(() => expect(err('code')).toBe('VAT code IMP77 already exists in WellD CH.'))
    })
  })

  describe('a 422 from the server maps fields[] to the same sentences (UX-6)', () => {
    it.each([
      ['code', 'empty', 'code', 'Enter a code.'],
      ['code', 'format', 'code', 'Use letters, digits, - or _ only.'],
      ['code', 'too_long', 'code', 'The code can have up to 16 characters.'],
      ['label', 'empty', 'label', 'Enter a label.'],
      ['label', 'too_long', 'label', 'The label can have up to 80 characters.'],
      ['ratePercent', 'format', 'rate', 'Enter a rate between 0 and 100, with up to 2 decimals.'],
      ['ratePercent', 'range', 'rate', 'Enter a rate between 0 and 100, with up to 2 decimals.'],
    ] as const)('%s %s → the %s field says %j and takes focus', async (field, reason, shown, sentence) => {
      serve(() => problem(422, 'invalid_vat_code', { fields: [{ field, reason }] }))
      setup()
      fill('IMP81', 'Imposta', '8.1')
      submit()
      await waitFor(() => expect(err(shown)).toBe(sentence))
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId(`accounting-vat-${shown}`)))
    })

    it('several refused fields: all show, the first in form order takes focus', async () => {
      serve(() =>
        problem(422, 'invalid_vat_code', {
          fields: [
            { field: 'ratePercent', reason: 'format' },
            { field: 'label', reason: 'empty' },
          ],
        }),
      )
      setup()
      fill('IMP81', 'Imposta', '8.1')
      submit()
      await waitFor(() => expect(err('rate')).not.toBeNull())
      expect(err('label')).toBe('Enter a label.')
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-label')))
    })

    it('a 422 naming no field of this dialog is a general error, never a blank one', async () => {
      serve(() => problem(422, 'invalid_vat_code', { fields: [] }))
      setup()
      fill('IMP81', 'Imposta', '8.1')
      submit()
      await waitFor(() => expect(screen.getByTestId('accounting-vat-dialog-error').textContent).toBe('Could not save. Try again.'))
    })
  })

  it('a 403 is a permission message, tells the frame and keeps the values; a network failure is a retry message; a 404 tells the frame', async () => {
    const answers: Array<FakeAnswer | 'offline'> = [problem(403, 'accounting_manage_required'), 'offline', problem(404, 'not_found')]
    apiFetch.mockImplementation(async () => {
      const next = answers.shift()!
      if (next === 'offline') throw new TypeError('offline')
      return new Response(JSON.stringify(next.body), { status: next.status })
    })
    const { onForbidden, onGone } = setup()
    fill('IMP81', 'Imposta', '8.1')
    submit()
    await waitFor(() =>
      expect(screen.getByTestId('accounting-vat-dialog-error').textContent).toBe("You don't have permission to do this."),
    )
    expect(onForbidden).toHaveBeenCalledTimes(1)
    submit()
    await waitFor(() => expect(screen.getByTestId('accounting-vat-dialog-error').textContent).toBe('Could not save. Try again.'))
    submit()
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1))
    expect((screen.getByTestId('accounting-vat-rate') as HTMLInputElement).value).toBe('8.1')
  })

  it('is busy while saving: "Adding…", fields disabled, and a second submit sends nothing', async () => {
    serve(never)
    setup()
    fill('IMP81', 'Imposta', '8.1')
    submit()
    await waitFor(() => expect(screen.getByTestId('accounting-vat-dialog-submit').textContent).toBe('Adding…'))
    expect(screen.getByTestId('accounting-vat-rate').matches(':disabled')).toBe(true)
    submit()
    expect(posts()).toHaveLength(1)
  })

  it('Cancel and Escape cancel', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByTestId('accounting-vat-dialog-cancel'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('AddVatCodeDialog: accessibility (axe)', () => {
  it('has no violations: idle, filled, each field refused, a duplicate on blur', async () => {
    setup([vat({ code: 'IMP81', active: false })])
    await expectNoAxeViolations()
    fill('IMP77', 'Imposta', '7.7')
    await expectNoAxeViolations()
    fill('IMP81', 'Imposta', '7.7')
    fireEvent.blur(screen.getByTestId('accounting-vat-code'))
    await screen.findByTestId('accounting-vat-code-error')
    await expectNoAxeViolations()
    cleanup()

    setup()
    fill('a b', 'x'.repeat(81), 'abc')
    submit()
    await screen.findByTestId('accounting-vat-rate-error')
    await expectNoAxeViolations()
  })

  it('has no violations: a server duplicate, a general failure, and while saving', async () => {
    const answers: FakeAnswer[] = [problem(409, 'vat_code_duplicate', { vatCode: 'IMP81', reactivate: true }), problem(500)]
    serve(() => answers.shift() ?? never())
    setup()
    fill('IMP81', 'Imposta', '8.1')
    submit()
    await screen.findByTestId('accounting-vat-code-error')
    await expectNoAxeViolations()

    fill('IMP82', 'Imposta', '8.1')
    submit()
    await screen.findByTestId('accounting-vat-dialog-error')
    await expectNoAxeViolations()

    submit()
    await waitFor(() => expect(screen.getByTestId('accounting-vat-dialog-submit').textContent).toBe('Adding…'))
    await expectNoAxeViolations()
  })
})
