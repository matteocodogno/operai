/**
 * @vitest-environment jsdom
 *
 * AddVatCodeDialog (T24, specs/20261118-refund-accounting-export, design S6b, F3; AC-1.4, AC-1.5): the code saved in
 * capitals, the rate parsed exactly from a dot or a comma and sent canonical, the duplicate named, values kept.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, createVatCode: vi.fn() }
})

import * as accountingApi from '../../lib/accountingApi'
import type { VatCode } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import AddVatCodeDialog from './AddVatCodeDialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const vatCode = (overrides: Partial<VatCode> = {}): VatCode => ({
  id: 'v1',
  code: 'IMP81',
  label: 'Imposta piena',
  rateBasisPoints: 810,
  ratePercent: '8.1',
  active: true,
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
  ...overrides,
})

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const setup = (vatCodes: VatCode[] = []) => {
  const onAdded = vi.fn()
  const onCancel = vi.fn()
  render(<AddVatCodeDialog vatCodes={vatCodes} onAdded={onAdded} onCancel={onCancel} />)
  return { onAdded, onCancel }
}

const input = (name: 'code' | 'label' | 'rate') => screen.getByTestId(`add-vat-code-${name}`) as HTMLInputElement

const fill = (code: string, label: string, rate: string) => {
  fireEvent.change(input('code'), { target: { value: code } })
  fireEvent.change(input('label'), { target: { value: label } })
  fireEvent.change(input('rate'), { target: { value: rate } })
}

const submit = () => fireEvent.click(screen.getByTestId('add-vat-code-submit'))

describe('AddVatCodeDialog', () => {
  it('says the rate cannot be changed later (AC-1.5) and offers no way to edit one', () => {
    setup()
    expect(screen.getByRole('dialog', { name: 'Add VAT code' })).not.toBeNull()
    expect(screen.getByText('The rate cannot be changed later: a new rate needs a new code.')).not.toBeNull()
    expect(screen.getByText('Letters, digits, - and _ (up to 16). Saved in capitals.')).not.toBeNull()
    expect(screen.getByText('Between 0 and 100, up to 2 decimals.')).not.toBeNull()
  })

  it('upper-cases the code when the field loses focus', () => {
    setup()
    fireEvent.change(input('code'), { target: { value: ' imp81 ' } })
    fireEvent.blur(input('code'))
    expect(input('code').value).toBe('IMP81')
  })

  it('keeps Save disabled until all three fields have text', () => {
    setup()
    const save = screen.getByTestId('add-vat-code-submit') as HTMLButtonElement
    fireEvent.change(input('code'), { target: { value: 'IMP81' } })
    fireEvent.change(input('label'), { target: { value: 'Imposta' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(input('rate'), { target: { value: '8.1' } })
    expect(save.disabled).toBe(false)
  })

  it.each([
    ['8.1', '8.1'],
    ['8,1', '8.1'],
    ['8.10', '8.1'],
    ['8', '8'],
    ['8.00', '8'],
    ['0', '0'],
    ['0.05', '0.05'],
    ['00.5', '0.5'],
    ['100', '100'],
    ['100.00', '100'],
    ['7.70', '7.7'],
    [' 2.6 ', '2.6'],
  ])('sends the rate %j as the canonical string %j', async (typed, sent) => {
    vi.mocked(accountingApi.createVatCode).mockResolvedValue(vatCode())
    setup()
    fill('imp81', 'Imposta', typed)
    submit()
    await waitFor(() => expect(accountingApi.createVatCode).toHaveBeenCalled())
    expect(accountingApi.createVatCode).toHaveBeenCalledWith({ code: 'IMP81', label: 'Imposta', ratePercent: sent })
  })

  it.each(['100.01', '101', '-1', '8.123', '8.', '.5', 'abc', '8,1,2', '1e2', '999'])(
    'refuses the rate %j without calling the API, and focuses the field',
    async (rate) => {
      setup()
      fill('IMP81', 'Imposta', rate)
      submit()
      expect(screen.getByTestId('add-vat-code-rate-error').textContent).toBe(
        'Enter a rate between 0 and 100, with up to 2 decimals.',
      )
      await waitFor(() => expect(document.activeElement).toBe(input('rate')))
      expect(accountingApi.createVatCode).not.toHaveBeenCalled()
    },
  )

  it.each(['IMP 81', 'IMP.81', 'ÄÖ', 'A'.repeat(17), 'imp/81'])('refuses the code %j', (code) => {
    setup()
    fireEvent.change(input('code'), { target: { value: code } })
    fireEvent.change(input('label'), { target: { value: 'x' } })
    fireEvent.change(input('rate'), { target: { value: '8' } })
    fireEvent.submit(input('code').closest('form') as HTMLFormElement)
    expect(screen.getByTestId('add-vat-code-code-error').textContent).toBe(
      'Enter a code of letters, digits, - or _ (up to 16).',
    )
    expect(accountingApi.createVatCode).not.toHaveBeenCalled()
  })

  it('accepts a code of 16 characters with - and _', async () => {
    vi.mocked(accountingApi.createVatCode).mockResolvedValue(vatCode())
    setup()
    fill('a-b_c' + '1'.repeat(11), 'x', '8')
    submit()
    await waitFor(() => expect(accountingApi.createVatCode).toHaveBeenCalled())
  })

  it('refuses a label of more than 80 characters, and one of 80 passes', async () => {
    vi.mocked(accountingApi.createVatCode).mockResolvedValue(vatCode())
    setup()
    fill('IMP81', 'x'.repeat(81), '8')
    submit()
    expect(screen.getByTestId('add-vat-code-label-error').textContent).toBe('Enter a label of up to 80 characters.')
    expect(document.activeElement).toBe(input('label'))
    fill('IMP81', 'x'.repeat(80), '8')
    submit()
    await waitFor(() => expect(accountingApi.createVatCode).toHaveBeenCalledTimes(1))
  })

  it('names a duplicate code on blur, whatever its case, and says so for a deactivated one', () => {
    setup([vatCode({ code: 'IMP81' }), vatCode({ id: 'v2', code: 'OLD', active: false })])
    fireEvent.change(input('code'), { target: { value: 'imp81' } })
    fireEvent.blur(input('code'))
    expect(screen.getByTestId('add-vat-code-code-error').textContent).toBe('VAT code IMP81 already exists.')

    fireEvent.change(input('code'), { target: { value: 'old' } })
    fireEvent.blur(input('code'))
    expect(screen.getByTestId('add-vat-code-code-error').textContent).toBe(
      'VAT code OLD already exists but is deactivated. Reactivate it from the list.',
    )
  })

  it('shows a server 409 duplicate on the code field and keeps every typed value', async () => {
    vi.mocked(accountingApi.createVatCode).mockRejectedValue(problem(409, 'vat_code_duplicate'))
    const { onAdded } = setup()
    fill('imp81', 'Imposta', '8,1')
    submit()

    await waitFor(() =>
      expect(screen.getByTestId('add-vat-code-code-error').textContent).toBe('VAT code IMP81 already exists.'),
    )
    expect(input('code').value).toBe('IMP81')
    expect(input('label').value).toBe('Imposta')
    expect(input('rate').value).toBe('8,1')
    await waitFor(() => expect(document.activeElement).toBe(input('code')))
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('reports the created code, and shows 403 and other failures as general errors', async () => {
    const created = vatCode({ id: 'v7' })
    vi.mocked(accountingApi.createVatCode).mockResolvedValueOnce(created)
    const { onAdded } = setup()
    fill('IMP81', 'Imposta', '8.1')
    submit()
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(created))

    cleanup()
    vi.mocked(accountingApi.createVatCode).mockRejectedValueOnce(problem(403))
    setup()
    fill('IMP81', 'Imposta', '8.1')
    submit()
    await waitFor(() =>
      expect(screen.getByTestId('add-vat-code-error').textContent).toBe("You don't have permission to do this."),
    )
    vi.mocked(accountingApi.createVatCode).mockRejectedValueOnce(problem(500))
    submit()
    await waitFor(() => expect(screen.getByTestId('add-vat-code-error').textContent).toBe('Could not save. Try again.'))
  })
})
