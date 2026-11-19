/**
 * @vitest-environment jsdom
 *
 * AddLedgerAccountDialog (T29, specs/20261119-accounting, design FA3, AS6a, UX-3, UX-6; AC-1.2, AC-1.3, AC-8.4): the entity in
 * the title, required fields, the client checks of `lib/limits.ts` with one sentence per reason, the duplicate named on blur and
 * on a 409 (the server's `reactivate` flag decides the pointer, G9), the server's `fields[]` mapped to the same sentences, values
 * kept on failure, focus on the first refused field with no `ErrorSummary`, and axe on every state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { fakeApi, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'
import type { LedgerAccount } from '../lib/catalogApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import AddLedgerAccountDialog from './AddLedgerAccountDialog'

const POST = 'POST /v1/entities/welld_ch/ledger-accounts'
const never = (): Promise<FakeAnswer> => new Promise(() => {})
const serve = (handler: FakeHandler) => apiFetch.mockImplementation(fakeApi({ [POST]: handler }))
const posts = () => apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const account = (overrides: Partial<LedgerAccount> = {}): LedgerAccount => ({
  number: '5905',
  name: 'Spese rimborsi',
  active: true,
  ...overrides,
})

const setup = (accounts: LedgerAccount[] = []) => {
  const handlers = { onAdded: vi.fn(), onCancel: vi.fn(), onStale: vi.fn(), onForbidden: vi.fn(), onGone: vi.fn() }
  const view = render(<AddLedgerAccountDialog entity="welld_ch" accounts={accounts} {...handlers} />)
  return { ...handlers, ...view }
}

const fill = (number: string, name: string) => {
  fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: number } })
  fireEvent.change(screen.getByTestId('accounting-ledger-name'), { target: { value: name } })
}
const submit = () => fireEvent.click(screen.getByTestId('accounting-ledger-dialog-submit'))
const numberError = () => screen.getByTestId('accounting-ledger-number-error').textContent
const nameError = () => screen.getByTestId('accounting-ledger-name-error').textContent

describe('AddLedgerAccountDialog', () => {
  it('names the entity in its title and says the number and name cannot be edited later', () => {
    setup()
    const dialog = screen.getByRole('dialog', { name: 'Add ledger account — WellD CH' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(
      screen.getByText('The number and name cannot be edited later. An account can be deactivated and reactivated.'),
    ).not.toBeNull()
    expect(screen.getByLabelText(/Account number/)).not.toBeNull()
    expect(screen.getByText('Digits separated by single dots, up to 20 characters. For example 5905 or 2620.1.')).not.toBeNull()
  })

  it('focuses the number field on open and keeps Save disabled until both fields have text', () => {
    setup()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number'))
    const save = screen.getByTestId('accounting-ledger-dialog-submit') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5905' } })
    expect(save.disabled).toBe(true)
    fill('5905', 'Spese rimborsi')
    expect(save.disabled).toBe(false)
  })

  it('creates the account with trimmed values under the entity’s path and reports the server’s account', async () => {
    const created = account({ number: '2620.1', name: 'Anticipi' })
    serve(() => ({ status: 201, body: created }))
    const { onAdded } = setup()

    fill('  2620.1 ', '  Anticipi  ')
    submit()

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(created))
    expect(String(posts()[0]![0])).toBe('http://accounting-api.test/v1/entities/welld_ch/ledger-accounts')
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ number: '2620.1', name: 'Anticipi' })
  })

  it('submits on Enter in a field', async () => {
    serve(() => ({ status: 201, body: account() }))
    const { onAdded } = setup()
    fill('5905', 'Spese')
    fireEvent.submit(screen.getByTestId('accounting-ledger-number').closest('form') as HTMLFormElement)
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
  })

  it.each([
    ['5905.', 'format'],
    ['.5905', 'format'],
    ['59..05', 'format'],
    ['abc', 'format'],
    ['59 05', 'format'],
    ['-5905', 'format'],
    ['5905,1', 'format'],
  ])('refuses the number %j for its format, without calling the API, and focuses the field', async (value) => {
    setup()
    fill(value, 'Spese')
    submit()
    expect(numberError()).toBe('Use digits separated by single dots, such as 5905 or 2620.1.')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number')))
    expect(screen.getByTestId('accounting-ledger-number').getAttribute('aria-invalid')).toBe('true')
    expect(posts()).toHaveLength(0)
  })

  it('refuses a number longer than 20 characters for its length, and 20 passes (AC-1.2)', async () => {
    serve(() => ({ status: 201, body: account() }))
    setup()
    fill('1'.repeat(21), 'Spese')
    submit()
    expect(numberError()).toBe('The number can have up to 20 characters.')
    expect(posts()).toHaveLength(0)
    fill('1'.repeat(20), 'Spese')
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it.each(['5905', '1', '123456', '2620.1', '2620.123', '1.2.3'])('accepts the number %j (digits separated by single dots)', async (value) => {
    serve(() => ({ status: 201, body: account() }))
    setup()
    fill(value, 'Spese')
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('refuses a name longer than 120 characters, and one of 120 passes', async () => {
    serve(() => ({ status: 201, body: account() }))
    setup()
    fill('5905', 'x'.repeat(121))
    submit()
    expect(nameError()).toBe('The name can have up to 120 characters.')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-name'))
    expect(posts()).toHaveLength(0)

    fill('5905', 'x'.repeat(120))
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('focuses the FIRST refused field when both are refused', () => {
    setup()
    fill('x', 'y'.repeat(121))
    submit()
    expect(numberError()).not.toBeNull()
    expect(nameError()).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number'))
  })

  it('has no ErrorSummary: a refused value is one alert on its own field, announced once (UX-6)', () => {
    setup()
    fill('x', 'Spese')
    submit()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByTestId('accounting-ledger-number').getAttribute('aria-describedby')).toContain(
      screen.getByRole('alert').id,
    )
  })

  it('names the duplicate number on blur, before any request, with this entity’s name (AC-1.2, AC-1.3)', () => {
    setup([account({ number: '5905' })])
    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5905' } })
    fireEvent.blur(screen.getByTestId('accounting-ledger-number'))
    expect(numberError()).toBe('Account 5905 already exists in WellD CH.')
    expect(posts()).toHaveLength(0)
  })

  it('says a deactivated duplicate can be reactivated, on blur and on submit (which also blocks it)', () => {
    setup([account({ number: '5905', active: false })])
    fill('5905', 'Spese')
    fireEvent.blur(screen.getByTestId('accounting-ledger-number'))
    const pointer = 'Account 5905 already exists but is deactivated. Reactivate it from the list.'
    expect(numberError()).toBe(pointer)

    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5905' } })
    submit()
    expect(numberError()).toBe(pointer)
    expect(posts()).toHaveLength(0)
  })

  it('clears a field’s error as soon as its value changes', () => {
    setup()
    fill('x', 'Spese')
    submit()
    expect(screen.getByTestId('accounting-ledger-number-error')).not.toBeNull()
    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '59' } })
    expect(screen.queryByTestId('accounting-ledger-number-error')).toBeNull()
  })

  describe('a 409 from the server (G9)', () => {
    it.each([
      [{ reactivate: false }, 'Account 5905 already exists in WellD CH.'],
      [{ reactivate: true }, 'Account 5905 already exists but is deactivated. Reactivate it from the list.'],
    ])('with %j the sentence follows the flag, keeps both values, focuses the number and asks the card to reload', async (extras, sentence) => {
      serve(() => problem(409, 'ledger_account_duplicate', { number: '5905', ...extras }))
      const { onAdded, onStale } = setup()
      fill('5905', 'Spese rimborsi')
      submit()

      await waitFor(() => expect(numberError()).toBe(sentence))
      expect((screen.getByTestId('accounting-ledger-number') as HTMLInputElement).value).toBe('5905')
      expect((screen.getByTestId('accounting-ledger-name') as HTMLInputElement).value).toBe('Spese rimborsi')
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number')))
      expect(onAdded).not.toHaveBeenCalled()
      expect(onStale).toHaveBeenCalledTimes(1)
      expect((screen.getByTestId('accounting-ledger-dialog-submit') as HTMLButtonElement).disabled).toBe(false)
    })

    it('the flag beats a stale list: the list says deactivated, the server says active', async () => {
      serve(() => problem(409, 'ledger_account_duplicate', { number: '5906', reactivate: false }))
      setup([account({ number: '5905', active: false })])
      fill('5906', 'Spese')
      submit()
      await waitFor(() => expect(numberError()).toBe('Account 5906 already exists in WellD CH.'))
    })

    it('without a flag, falls back to what the loaded list says', async () => {
      serve(() => problem(409, 'ledger_account_duplicate'))
      setup([account({ number: '5901', active: false })])
      fill('5902', 'Spese')
      submit()
      await waitFor(() => expect(numberError()).toBe('Account 5902 already exists in WellD CH.'))
    })
  })

  describe('a 422 from the server maps fields[] to the same sentences (UX-6)', () => {
    it.each([
      ['number', 'empty', 'Enter an account number.'],
      ['number', 'format', 'Use digits separated by single dots, such as 5905 or 2620.1.'],
      ['number', 'too_long', 'The number can have up to 20 characters.'],
      ['number', 'something_new', 'Use digits separated by single dots, such as 5905 or 2620.1.'],
    ])('number %s → %s', async (field, reason, sentence) => {
      serve(() => problem(422, 'invalid_ledger_account', { fields: [{ field, reason }] }))
      setup()
      fill('5905', 'Spese')
      submit()
      await waitFor(() => expect(numberError()).toBe(sentence))
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number')))
    })

    it('name too_long, focused when it is the only refused field; both refused focuses the number', async () => {
      serve(() =>
        problem(422, 'invalid_ledger_account', { fields: [{ field: 'name', reason: 'too_long' }] }),
      )
      setup()
      fill('5905', 'Spese')
      submit()
      await waitFor(() => expect(nameError()).toBe('The name can have up to 120 characters.'))
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-name')))
      cleanup()

      serve(() =>
        problem(422, 'invalid_ledger_account', {
          fields: [
            { field: 'name', reason: 'empty' },
            { field: 'number', reason: 'format' },
          ],
        }),
      )
      setup()
      fill('5905', 'Spese')
      submit()
      await waitFor(() => expect(nameError()).toBe('Enter a name.'))
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number')))
    })

    it('a 422 with no field this dialog knows is a general error, never a blank one', async () => {
      serve(() => problem(422, 'invalid_ledger_account', { fields: [{ field: 'other', reason: 'format' }] }))
      setup()
      fill('5905', 'Spese')
      submit()
      await waitFor(() => expect(screen.getByTestId('accounting-ledger-dialog-error').textContent).toBe('Could not save. Try again.'))
    })
  })

  it('a 403 is a permission message, tells the frame, and keeps the values; a 5xx or network failure is a retry message', async () => {
    const answers: Array<FakeAnswer | 'offline'> = [problem(403, 'accounting_manage_required'), 'offline']
    apiFetch.mockImplementation(async () => {
      const next = answers.shift()!
      if (next === 'offline') throw new TypeError('offline')
      return new Response(JSON.stringify(next.body), { status: next.status })
    })
    const { onForbidden } = setup()
    fill('5905', 'Spese')
    submit()
    await waitFor(() =>
      expect(screen.getByTestId('accounting-ledger-dialog-error').textContent).toBe("You don't have permission to do this."),
    )
    expect(onForbidden).toHaveBeenCalledTimes(1)

    submit()
    await waitFor(() =>
      expect(screen.getByTestId('accounting-ledger-dialog-error').textContent).toBe('Could not save. Try again.'),
    )
    expect((screen.getByTestId('accounting-ledger-number') as HTMLInputElement).value).toBe('5905')
    expect((screen.getByTestId('accounting-ledger-name') as HTMLInputElement).value).toBe('Spese')
  })

  it('a 404 (the entity is not covered any more) says the generic failure and tells the frame', async () => {
    serve(() => problem(404, 'not_found'))
    const { onGone } = setup()
    fill('5905', 'Spese')
    submit()
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('accounting-ledger-dialog-error').textContent).toBe('Could not save. Try again.')
  })

  it('is busy while saving: "Adding…", fields disabled, and a second submit sends nothing', async () => {
    serve(never)
    setup()
    fill('5905', 'Spese')
    submit()

    await waitFor(() => expect(screen.getByTestId('accounting-ledger-dialog-submit').textContent).toBe('Adding…'))
    expect(screen.getByTestId('accounting-ledger-number').matches(':disabled')).toBe(true)
    submit()
    expect(posts()).toHaveLength(1)
  })

  it('Cancel and Escape cancel', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-cancel'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('AddLedgerAccountDialog: accessibility (axe)', () => {
  it('has no violations: idle, filled, and with each field refused', async () => {
    setup([account({ number: '5905', active: false })])
    await expectNoAxeViolations()
    fill('5901', 'Spese')
    await expectNoAxeViolations()
    fill('5905', 'Spese')
    fireEvent.blur(screen.getByTestId('accounting-ledger-number'))
    await screen.findByTestId('accounting-ledger-number-error')
    await expectNoAxeViolations()
    cleanup()

    setup()
    fill('5905', 'x'.repeat(121))
    submit()
    await screen.findByTestId('accounting-ledger-name-error')
    await expectNoAxeViolations()
  })

  it('has no violations: a server duplicate, a general failure, and while saving', async () => {
    const answers: FakeAnswer[] = [problem(409, 'ledger_account_duplicate', { number: '5905', reactivate: true }), problem(500)]
    serve(() => answers.shift() ?? never())
    setup()
    fill('5905', 'Spese')
    submit()
    await screen.findByTestId('accounting-ledger-number-error')
    await expectNoAxeViolations()

    fill('5906', 'Spese')
    submit()
    await screen.findByTestId('accounting-ledger-dialog-error')
    await expectNoAxeViolations()

    submit()
    await waitFor(() => expect(screen.getByTestId('accounting-ledger-dialog-submit').textContent).toBe('Adding…'))
    await expectNoAxeViolations()
  })
})

describe('AddLedgerAccountDialog: blank and invisible names, characters not units (T53, T56; AC-1.2)', () => {
  it.each([
    ['a zero-width space', '\u200B'],
    ['a soft hyphen and a word joiner', '\u00AD\u2060'],
    ['a Hangul filler', '\u3164\u3164'],
    ['a Braille blank', '\u2800'],
    ['zero-width spaces between spaces', ' \u200B\u200B '],
  ])('a name of only %s is "Enter a name.", focused, with no request', (_what, blank) => {
    serve(() => ({ status: 201, body: account() }))
    setup()
    fill('5905', blank)
    // Save is enabled (the field has text), the check on submit says what is wrong.
    submit()
    expect(nameError()).toBe('Enter a name.')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-name'))
    expect(screen.getByTestId('accounting-ledger-name').getAttribute('aria-invalid')).toBe('true')
    expect(posts()).toHaveLength(0)
  })

  it('names the blank on blur, before submit', () => {
    setup()
    fill('5905', '\u200B')
    fireEvent.blur(screen.getByTestId('accounting-ledger-name'))
    expect(nameError()).toBe('Enter a name.')
  })

  it('a name with a control character is refused for its format, not as empty', () => {
    setup()
    fill('5905', 'a\u0007b')
    submit()
    expect(nameError()).toBe('The name cannot contain control characters.')
    expect(posts()).toHaveLength(0)
  })

  it('counts a name in characters: 120 emoji pass and are sent as typed, 121 are too long', async () => {
    serve(() => ({ status: 201, body: account() }))
    setup()
    const emoji = '\u{1F600}'
    fill('5905', emoji.repeat(121))
    submit()
    expect(nameError()).toBe('The name can have up to 120 characters.')
    expect(posts()).toHaveLength(0)

    fill('5905', ` ${emoji.repeat(120)} `)
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ number: '5905', name: emoji.repeat(120) })
  })

  it('keeps a visible name that has invisible characters inside it', async () => {
    serve(() => ({ status: 201, body: account() }))
    setup()
    fill('5905', 'Spese\u200Brimborsi')
    submit()
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('maps a server `format` of the name to its own sentence, never "Enter a name."', async () => {
    serve(() => problem(422, 'invalid_ledger_account', { fields: [{ field: 'name', reason: 'format' }] }))
    setup()
    fill('5905', 'Spese')
    submit()
    await waitFor(() => expect(nameError()).toBe('The name cannot contain control characters.'))
  })
})

describe('AddLedgerAccountDialog: 409 catalog_full (T53, T56; F-01)', () => {
  const generalError = () => screen.getByTestId('accounting-ledger-dialog-error')

  it('says the entity holds the most it may, names the limit, says nothing was added, and keeps the typed values', async () => {
    serve(() => problem(409, 'catalog_full', { limit: 200 }))
    const { onAdded, onStale, onForbidden, onGone } = setup()
    fill('5905', 'Spese rimborsi')
    submit()

    await waitFor(() =>
      expect(generalError().textContent).toBe(
        'WellD CH already has the most accounts it can hold (200, deactivated ones included). Nothing was added. Use an existing account instead.',
      ),
    )
    expect(generalError().getAttribute('role')).toBe('alert')
    expect((screen.getByTestId('accounting-ledger-number') as HTMLInputElement).value).toBe('5905')
    expect((screen.getByTestId('accounting-ledger-name') as HTMLInputElement).value).toBe('Spese rimborsi')
    // No field is at fault: no field error, no duplicate handling, no frame callback.
    expect(screen.queryByTestId('accounting-ledger-number-error')).toBeNull()
    expect(screen.queryByTestId('accounting-ledger-name-error')).toBeNull()
    expect(onAdded).not.toHaveBeenCalled()
    expect(onStale).not.toHaveBeenCalled()
    expect(onForbidden).not.toHaveBeenCalled()
    expect(onGone).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Add ledger account — WellD CH' })).not.toBeNull()
    expect((screen.getByTestId('accounting-ledger-dialog-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('names the limit the server sent, whatever it is', async () => {
    serve(() => problem(409, 'catalog_full', { limit: 321 }))
    setup()
    fill('5905', 'Spese')
    submit()
    await waitFor(() => expect(generalError().textContent).toContain('(321, deactivated ones included)'))
  })

  it.each([undefined, 0, '200', null, 1.5])('falls back to the mirrored cap of 200 when `limit` is %j', async (limit) => {
    serve(() => problem(409, 'catalog_full', limit === undefined ? {} : { limit }))
    setup()
    fill('5905', 'Spese')
    submit()
    await waitFor(() => expect(generalError().textContent).toContain('(200, deactivated ones included)'))
    expect(generalError().textContent).not.toContain('undefined')
  })

  it('keeps focus inside the dialog (never on the page behind) and a later submit clears the message', async () => {
    const answers: FakeAnswer[] = [problem(409, 'catalog_full', { limit: 200 }), { status: 201, body: account() }]
    serve(() => answers.shift()!)
    const { onAdded } = setup()
    fill('5905', 'Spese')
    const button = screen.getByTestId('accounting-ledger-dialog-submit')
    button.focus()
    submit()
    await screen.findByTestId('accounting-ledger-dialog-error')
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).not.toBe(document.body)

    submit()
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1))
  })

  it('has no axe violations with the message shown', async () => {
    serve(() => problem(409, 'catalog_full', { limit: 200 }))
    setup()
    fill('5905', 'Spese')
    submit()
    await screen.findByTestId('accounting-ledger-dialog-error')
    await expectNoAxeViolations()
  })

  it('has no axe violations with a blank-name refusal shown', async () => {
    setup()
    fill('5905', '\u200B')
    submit()
    await screen.findByTestId('accounting-ledger-name-error')
    await expectNoAxeViolations()
  })
})
