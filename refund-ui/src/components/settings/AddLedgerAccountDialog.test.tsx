/**
 * @vitest-environment jsdom
 *
 * AddLedgerAccountDialog (T24, specs/20261118-refund-accounting-export, design S6a, F1; AC-1.1, AC-1.2): required
 * fields, the client checks that mirror the server, the duplicate named on blur and on a 409 (with the
 * "deactivated: reactivate it" variant), values kept on failure, focus on the invalid field.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, createLedgerAccount: vi.fn() }
})

import * as accountingApi from '../../lib/accountingApi'
import type { LedgerAccount } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import AddLedgerAccountDialog from './AddLedgerAccountDialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const account = (overrides: Partial<LedgerAccount> = {}): LedgerAccount => ({
  id: 'a1',
  number: '5905',
  name: 'Spese rimborsi',
  active: true,
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
  ...overrides,
})

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const setup = (accounts: LedgerAccount[] = []) => {
  const onAdded = vi.fn()
  const onCancel = vi.fn()
  render(<AddLedgerAccountDialog accounts={accounts} onAdded={onAdded} onCancel={onCancel} />)
  return { onAdded, onCancel }
}

const fill = (number: string, name: string) => {
  fireEvent.change(screen.getByTestId('add-ledger-account-number'), { target: { value: number } })
  fireEvent.change(screen.getByTestId('add-ledger-account-name'), { target: { value: name } })
}

const submit = () => fireEvent.click(screen.getByTestId('add-ledger-account-submit'))

describe('AddLedgerAccountDialog', () => {
  it('is a labelled dialog that says the number and name cannot be edited later', () => {
    setup()
    const dialog = screen.getByRole('dialog', { name: 'Add ledger account' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(
      screen.getByText('The number and name cannot be edited later. An account can be deactivated and reactivated.'),
    ).not.toBeNull()
    expect(screen.getByLabelText(/Account number/)).not.toBeNull()
    expect(screen.getByText('For example 5905 or 2620.1')).not.toBeNull()
  })

  it('focuses the number field on open and keeps Save disabled until both fields have text', () => {
    setup()
    expect(document.activeElement).toBe(screen.getByTestId('add-ledger-account-number'))
    const save = screen.getByTestId('add-ledger-account-submit') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fillNumberOnly()
    expect(save.disabled).toBe(true)
    fill('5905', 'Spese rimborsi')
    expect(save.disabled).toBe(false)
  })

  it('creates the account with trimmed values and reports the server’s account', async () => {
    const created = account({ id: 'a9', number: '2620.1', name: 'Anticipi' })
    vi.mocked(accountingApi.createLedgerAccount).mockResolvedValue(created)
    const { onAdded } = setup()

    fill('  2620.1 ', '  Anticipi  ')
    submit()

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(created))
    expect(accountingApi.createLedgerAccount).toHaveBeenCalledWith({ number: '2620.1', name: 'Anticipi' })
  })

  it('submits on Enter in a field', async () => {
    vi.mocked(accountingApi.createLedgerAccount).mockResolvedValue(account())
    const { onAdded } = setup()
    fill('5905', 'Spese')
    fireEvent.submit(screen.getByTestId('add-ledger-account-number').closest('form') as HTMLFormElement)
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
  })

  it.each(['59', '1234567', 'abc', '5905.', '5905.1234', '59 05', '-5905', '5905,1'])(
    'refuses the number %j without calling the API, names the fix and focuses the field',
    async (number) => {
      setup()
      fill(number, 'Spese')
      submit()

      expect(screen.getByTestId('add-ledger-account-number-error').textContent).toBe(
        'Enter an account number such as 5905 or 2620.1.',
      )
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('add-ledger-account-number')))
      expect(screen.getByTestId('add-ledger-account-number').getAttribute('aria-invalid')).toBe('true')
      expect(accountingApi.createLedgerAccount).not.toHaveBeenCalled()
    },
  )

  it.each(['5905', '590', '123456', '2620.1', '2620.123'])('accepts the number %j', async (number) => {
    vi.mocked(accountingApi.createLedgerAccount).mockResolvedValue(account())
    setup()
    fill(number, 'Spese')
    submit()
    await waitFor(() => expect(accountingApi.createLedgerAccount).toHaveBeenCalled())
  })

  it('refuses a name longer than 120 characters, and one of 120 passes', async () => {
    vi.mocked(accountingApi.createLedgerAccount).mockResolvedValue(account())
    setup()
    fill('5905', 'x'.repeat(121))
    submit()
    expect(screen.getByTestId('add-ledger-account-name-error').textContent).toBe(
      'Enter a name of up to 120 characters.',
    )
    expect(document.activeElement).toBe(screen.getByTestId('add-ledger-account-name'))
    expect(accountingApi.createLedgerAccount).not.toHaveBeenCalled()

    fill('5905', 'x'.repeat(120))
    submit()
    await waitFor(() => expect(accountingApi.createLedgerAccount).toHaveBeenCalledTimes(1))
  })

  it('names the duplicate number on blur, before any request (AC-1.2)', () => {
    setup([account({ number: '5905' })])
    fireEvent.change(screen.getByTestId('add-ledger-account-number'), { target: { value: '5905' } })
    fireEvent.blur(screen.getByTestId('add-ledger-account-number'))
    expect(screen.getByTestId('add-ledger-account-number-error').textContent).toBe('Account 5905 already exists.')
  })

  it('says a deactivated duplicate can be reactivated, on blur and on submit (which also blocks it)', () => {
    setup([account({ number: '5905', active: false })])
    fill('5905', 'Spese')
    fireEvent.blur(screen.getByTestId('add-ledger-account-number'))
    const reactivate = 'Account 5905 already exists but is deactivated. Reactivate it from the list.'
    expect(screen.getByTestId('add-ledger-account-number-error').textContent).toBe(reactivate)

    fireEvent.change(screen.getByTestId('add-ledger-account-number'), { target: { value: '5905' } })
    submit()
    expect(screen.getByTestId('add-ledger-account-number-error').textContent).toBe(reactivate)
    expect(accountingApi.createLedgerAccount).not.toHaveBeenCalled()
  })

  it('clears a field’s error as soon as its value changes', () => {
    setup()
    fill('x', 'Spese')
    submit()
    expect(screen.getByTestId('add-ledger-account-number-error')).not.toBeNull()
    fireEvent.change(screen.getByTestId('add-ledger-account-number'), { target: { value: '59' } })
    expect(screen.queryByTestId('add-ledger-account-number-error')).toBeNull()
  })

  it('shows a 409 duplicate from the server on the number field, naming it, keeping both values and focusing it', async () => {
    vi.mocked(accountingApi.createLedgerAccount).mockRejectedValue(problem(409, 'ledger_account_duplicate'))
    const { onAdded } = setup()
    fill('5905', 'Spese rimborsi')
    submit()

    await waitFor(() =>
      expect(screen.getByTestId('add-ledger-account-number-error').textContent).toBe('Account 5905 already exists.'),
    )
    expect((screen.getByTestId('add-ledger-account-number') as HTMLInputElement).value).toBe('5905')
    expect((screen.getByTestId('add-ledger-account-name') as HTMLInputElement).value).toBe('Spese rimborsi')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('add-ledger-account-number')))
    expect(onAdded).not.toHaveBeenCalled()
    expect((screen.getByTestId('add-ledger-account-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a server 422 as the number error', async () => {
    vi.mocked(accountingApi.createLedgerAccount).mockRejectedValue(problem(422, 'invalid_ledger_account'))
    setup()
    fill('5905', 'Spese')
    submit()
    await waitFor(() =>
      expect(screen.getByTestId('add-ledger-account-number-error').textContent).toBe(
        'Enter an account number such as 5905 or 2620.1.',
      ),
    )
  })

  it('shows a 403 as a permission message and a 5xx or network failure as a retry message, values kept', async () => {
    vi.mocked(accountingApi.createLedgerAccount).mockRejectedValueOnce(problem(403))
    setup()
    fill('5905', 'Spese')
    submit()
    await waitFor(() =>
      expect(screen.getByTestId('add-ledger-account-error').textContent).toBe("You don't have permission to do this."),
    )

    vi.mocked(accountingApi.createLedgerAccount).mockRejectedValueOnce(new TypeError('offline'))
    submit()
    await waitFor(() =>
      expect(screen.getByTestId('add-ledger-account-error').textContent).toBe('Could not save. Try again.'),
    )
    expect((screen.getByTestId('add-ledger-account-number') as HTMLInputElement).value).toBe('5905')
    expect((screen.getByTestId('add-ledger-account-name') as HTMLInputElement).value).toBe('Spese')
  })

  it('is busy while saving: "Adding…", fields disabled, and a second submit sends nothing', async () => {
    let resolve!: (value: LedgerAccount) => void
    vi.mocked(accountingApi.createLedgerAccount).mockReturnValue(new Promise((r) => (resolve = r)))
    setup()
    fill('5905', 'Spese')
    submit()

    await waitFor(() => expect(screen.getByTestId('add-ledger-account-submit').textContent).toBe('Adding…'))
    expect(screen.getByTestId('add-ledger-account-number').matches(':disabled')).toBe(true)
    submit()
    expect(accountingApi.createLedgerAccount).toHaveBeenCalledTimes(1)
    resolve(account())
  })

  it('Cancel and Escape cancel', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByTestId('add-ledger-account-cancel'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

function fillNumberOnly() {
  fireEvent.change(screen.getByTestId('add-ledger-account-number'), { target: { value: '5905' } })
}
