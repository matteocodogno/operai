/**
 * @vitest-environment jsdom
 *
 * LedgerAccountsCard (T29, specs/20261119-accounting, design AS3, FA3, FA5, FA6, UX-3 to UX-8, UX-15; AC-1.1 to AC-1.4,
 * AC-1.9, AC-1.11, AC-1.12, AC-8.3, AC-8.4): the list and every state of it, Add, the Deactivate confirm, Reactivate, a stale
 * list's 409, read-only without `canManage`, no edit control, no dialog inside a form, and axe on every state. accounting-api
 * is faked at `shell/session`'s `apiFetch`, so the real `catalogApi` paths and bodies are exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'
import type { LedgerAccount } from '../lib/catalogApi'
import type { EntityId } from '../lib/meApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import LedgerAccountsCard from './LedgerAccountsCard'

const ACTIVE: LedgerAccount = { number: '5905', name: 'Spese rimborsi', active: true }
const INACTIVE: LedgerAccount = { number: '5901', name: 'Spese viaggi', active: false }

const LIST = 'GET /v1/entities/welld_ch/ledger-accounts'
const list = (...items: LedgerAccount[]): FakeAnswer => ({ status: 200, body: { entity: 'welld_ch', items } })
const never = (): Promise<FakeAnswer> => new Promise(() => {})

const onEntityGone = vi.fn()
const onWriteRefused = vi.fn()

/** Routes the card needs; `extra` adds or replaces. A list of the calls made is read from `apiFetch`. */
const serve = (routes: Record<string, FakeHandler>) => apiFetch.mockImplementation(fakeApi(routes))
const calls = (key: string) =>
  apiFetch.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}` === key)

beforeEach(() => {
  serve({ [LIST]: () => list(ACTIVE, INACTIVE) })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const card = (canManage = true, entity: EntityId = 'welld_ch') => (
  <LedgerAccountsCard entity={entity} canManage={canManage} onEntityGone={onEntityGone} onWriteRefused={onWriteRefused} />
)

const renderCard = async (canManage = true) => {
  const view = render(card(canManage))
  await screen.findByTestId('accounting-ledger-table')
  return view
}

describe('LedgerAccountsCard: the list (AS3)', () => {
  it('shows a polite loading line and a skeleton while the list loads', async () => {
    serve({ [LIST]: never })
    const { container } = render(card())
    expect(screen.getByRole('status').textContent).toBe('Loading ledger accounts…')
    expect(screen.queryByTestId('accounting-ledger-table')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('names the entity in the title, the caption and the description, and lists number (row header, mono), name and status', async () => {
    const { container } = await renderCard()
    expect(screen.getByRole('heading', { name: 'Ledger accounts — WellD CH' })).not.toBeNull()
    expect(screen.getByRole('table', { name: 'WellD CH ledger accounts' })).not.toBeNull()
    expect(screen.getByText('The chart of accounts of WellD CH. Other modules book to these accounts.')).not.toBeNull()
    const row = screen.getByTestId('accounting-ledger-row-5905')
    const header = within(row).getByRole('rowheader')
    expect(header.textContent).toBe('5905')
    expect(header.querySelector('.font-mono')).not.toBeNull()
    expect(within(row).getByText('Spese rimborsi')).not.toBeNull()
    expect(within(row).getByText('Active')).not.toBeNull()
    expect(within(screen.getByTestId('accounting-ledger-row-5901')).getByText('Inactive')).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('has no "Added" column and no who-added (UX-8)', async () => {
    await renderCard()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Number',
      'Name',
      'Status',
      'Actions',
    ])
    expect(screen.queryByText(/@/)).toBeNull()
  })

  it('reads the list of the entity it is given, by path (WellD Italia)', async () => {
    serve({
      'GET /v1/entities/welld_it/ledger-accounts': () => ({
        status: 200,
        body: { entity: 'welld_it', items: [{ number: '1000', name: 'Cassa', active: true }] },
      }),
    })
    render(card(true, 'welld_it'))
    await screen.findByTestId('accounting-ledger-table')
    expect(screen.getByRole('heading', { name: 'Ledger accounts — WellD Italia' })).not.toBeNull()
    expect(screen.getByTestId('accounting-ledger-row-1000')).not.toBeNull()
  })

  it('drops a row it cannot vouch for and reads a missing flag as deactivated', async () => {
    serve({
      [LIST]: () => ({
        status: 200,
        body: { entity: 'welld_ch', items: [{ number: '5905', name: 'Spese', active: true }, { name: 'no number' }, { number: '5906', name: 'x' }] },
      }),
    })
    await renderCard()
    expect(screen.getAllByTestId(/^accounting-ledger-row-/)).toHaveLength(2)
    expect(within(screen.getByTestId('accounting-ledger-row-5906')).getByText('Inactive')).not.toBeNull()
  })

  it('manager, empty: a state for the entity, not an error, with the manager sentence (AC-8.3)', async () => {
    serve({ [LIST]: () => list() })
    const { container } = render(card())
    const empty = await screen.findByTestId('accounting-empty')
    expect(empty.textContent).toContain('Nothing entered yet for WellD CH')
    expect(empty.textContent).toContain("Add the entity's ledger accounts with Add account.")
    expect(within(empty).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('accounting-ledger-add')).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('reader, empty (WellD Italia): the reader sentence, no Add', async () => {
    serve({ 'GET /v1/entities/welld_it/ledger-accounts': () => ({ status: 200, body: { entity: 'welld_it', items: [] } }) })
    const { container } = render(card(false, 'welld_it'))
    const empty = await screen.findByTestId('accounting-empty')
    expect(empty.textContent).toContain('Nothing entered yet for WellD Italia')
    expect(empty.textContent).toContain('Accounting managers enter them.')
    expect(screen.queryByTestId('accounting-ledger-add')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('failed: a warning banner with the card’s sentence, and Retry loads again', async () => {
    let first = true
    serve({ [LIST]: () => (first ? ((first = false), problem(500)) : list(ACTIVE)) })
    const { container } = render(card())
    expect((await screen.findByTestId('accounting-load-error')).textContent).toContain('Could not load the ledger accounts.')
    await expectNoAxeViolations(container)
    fireEvent.click(screen.getByTestId('accounting-load-error-retry'))
    await screen.findByTestId('accounting-ledger-table')
    expect(calls(LIST)).toHaveLength(2)
  })

  it('503: the authorization-unavailable banner with Retry (UX-15)', async () => {
    serve({ [LIST]: () => problem(503) })
    const { container } = render(card())
    const banner = await screen.findByTestId('accounting-load-error')
    expect(banner.textContent).toContain('Authorization service unavailable')
    expect(screen.getByTestId('accounting-load-error-retry')).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('403: PermissionDenied replaces the view, with no retry (UX-15)', async () => {
    serve({ [LIST]: () => problem(403, 'accounting_forbidden') })
    const { container } = render(card())
    expect((await screen.findByTestId('accounting-denied')).textContent).toContain('No access to Accounting')
    expect(screen.queryByTestId('accounting-ledger-card')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('404: tells the frame once that the entity is gone, and still offers Retry (UX-12)', async () => {
    serve({ [LIST]: () => problem(404, 'not_found') })
    render(card())
    await screen.findByTestId('accounting-load-error')
    await waitFor(() => expect(onEntityGone).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('accounting-load-error-retry')).not.toBeNull()
  })
})

describe('LedgerAccountsCard: reader (UX-4, AC-3.4)', () => {
  it('shows the table, the one quiet sentence, and no Add, no Actions column, no row button', async () => {
    const { container } = await renderCard(false)
    expect(screen.getByTestId('accounting-ledger-read-only').textContent).toBe(
      'You can view this list. Accounting managers add and deactivate accounts.',
    )
    expect(screen.queryByTestId('accounting-ledger-add')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull()
    expect(within(screen.getByTestId('accounting-ledger-table')).queryAllByRole('button')).toHaveLength(0)
    await expectNoAxeViolations(container)
  })

  it('the manager does not get the reader sentence', async () => {
    await renderCard(true)
    expect(screen.queryByTestId('accounting-ledger-read-only')).toBeNull()
  })

  it('loses its controls when the frame says canManage turned false', async () => {
    const view = await renderCard(true)
    expect(screen.getByTestId('accounting-ledger-add')).not.toBeNull()
    view.rerender(card(false))
    expect(screen.queryByTestId('accounting-ledger-add')).toBeNull()
    expect(screen.getByTestId('accounting-ledger-read-only')).not.toBeNull()
  })
})

describe('LedgerAccountsCard: no edit control (AC-1.12)', () => {
  it('offers only Deactivate and Reactivate on a row, never an edit or a delete, and no field in the table', async () => {
    await renderCard()
    const buttons = within(screen.getByTestId('accounting-ledger-table')).getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Deactivate account 5905',
      'Reactivate account 5901',
    ])
    expect(screen.getByTestId('accounting-ledger-table').querySelector('input, select, textarea')).toBeNull()
    expect(screen.queryByRole('button', { name: /edit|modify|rename|delete|remove/i })).toBeNull()
  })
})

describe('LedgerAccountsCard: Add account (AC-1.1, AC-1.2, AC-1.3)', () => {
  const created: LedgerAccount = { number: '2620.1', name: 'Anticipi', active: true }

  it('opens the dialog beside the card naming the entity, adds the account, shows the row and a confirmation, and returns focus to Add', async () => {
    let added = false
    serve({
      [LIST]: () => list(ACTIVE, INACTIVE, ...(added ? [created] : [])),
      'POST /v1/entities/welld_ch/ledger-accounts': () => ((added = true), { status: 201, body: created }),
    })
    await renderCard()

    const addButton = screen.getByTestId('accounting-ledger-add')
    expect(addButton.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(addButton)
    const dialog = screen.getByRole('dialog', { name: 'Add ledger account — WellD CH' })
    // ADR 20261118 dialog-beside-form: the dialog is never inside the card, and no form holds another form.
    expect(screen.getByTestId('accounting-ledger-card').contains(dialog)).toBe(false)
    expect(document.querySelectorAll('form form')).toHaveLength(0)

    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: ' 2620.1 ' } })
    fireEvent.change(screen.getByTestId('accounting-ledger-name'), { target: { value: 'Anticipi' } })
    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(JSON.parse(String(calls('POST /v1/entities/welld_ch/ledger-accounts')[0]![1]!.body))).toEqual({
      number: '2620.1',
      name: 'Anticipi',
    })
    expect(screen.getByTestId('accounting-ledger-row-2620.1').textContent).toContain('2620.1')
    expect(screen.getByTestId('accounting-saved').textContent).toBe('Account 2620.1 added')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-add'))
    // the server's list is read again after the optimistic row, and the row is not shown twice
    await waitFor(() => expect(calls(LIST)).toHaveLength(2))
    expect(screen.getAllByTestId(/^accounting-ledger-row-/)).toHaveLength(3)
  })

  it('names a duplicate on the field before any request, with the reactivation pointer when it is deactivated', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-add'))
    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5901' } })
    fireEvent.blur(screen.getByTestId('accounting-ledger-number'))
    expect(screen.getByTestId('accounting-ledger-number-error').textContent).toBe(
      'Account 5901 already exists but is deactivated. Reactivate it from the list.',
    )
    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5905' } })
    fireEvent.blur(screen.getByTestId('accounting-ledger-number'))
    expect(screen.getByTestId('accounting-ledger-number-error').textContent).toBe(
      'Account 5905 already exists in WellD CH.',
    )
    expect(calls('POST /v1/entities/welld_ch/ledger-accounts')).toHaveLength(0)
  })

  it('the same number in another entity is not a duplicate (AC-1.3)', async () => {
    serve({
      'GET /v1/entities/welld_it/ledger-accounts': () => ({ status: 200, body: { entity: 'welld_it', items: [] } }),
      'POST /v1/entities/welld_it/ledger-accounts': () => ({ status: 201, body: ACTIVE }),
    })
    render(card(true, 'welld_it'))
    await screen.findByTestId('accounting-empty')
    fireEvent.click(screen.getByTestId('accounting-ledger-add'))
    expect(screen.getByRole('dialog', { name: 'Add ledger account — WellD Italia' })).not.toBeNull()
    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5905' } })
    fireEvent.change(screen.getByTestId('accounting-ledger-name'), { target: { value: 'Spese rimborsi' } })
    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('accounting-saved').textContent).toBe('Account 5905 added')
  })

  it('Cancel closes the dialog without a request and returns focus to Add', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-add'))
    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls('POST /v1/entities/welld_ch/ledger-accounts')).toHaveLength(0)
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-add'))
  })

  it('a 403 in the dialog says so, keeps the values, and tells the frame to re-read /v1/me', async () => {
    serve({
      [LIST]: () => list(ACTIVE),
      'POST /v1/entities/welld_ch/ledger-accounts': () => problem(403, 'accounting_manage_required'),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-add'))
    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5999' } })
    fireEvent.change(screen.getByTestId('accounting-ledger-name'), { target: { value: 'Spese' } })
    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-submit'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-ledger-dialog-error').textContent).toBe("You don't have permission to do this."),
    )
    expect(onWriteRefused).toHaveBeenCalledTimes(1)
    expect((screen.getByTestId('accounting-ledger-number') as HTMLInputElement).value).toBe('5999')
  })
})

describe('LedgerAccountsCard: Deactivate (AC-1.4, AC-1.9, UX-7)', () => {
  const deactivate = 'POST /v1/entities/welld_ch/ledger-accounts/5905/deactivate'

  it('asks first, in neutral words that name no consumer, and Cancel does nothing', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-5905'))

    const dialog = screen.getByRole('alertdialog', { name: 'Deactivate account 5905?' })
    expect(within(dialog).getByText(/No module can choose it any more\./)).not.toBeNull()
    expect(within(dialog).getByText(/What was already booked with it keeps it\./)).not.toBeNull()
    expect(within(dialog).getByText(/You can reactivate it at any time\./)).not.toBeNull()
    expect(dialog.textContent).not.toMatch(/refund|request|line/i)
    // reversible, so the confirm is the primary tone and not the danger one; Cancel has the focus
    expect(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm').className).toContain('btn-primary')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-deactivate-dialog-cancel'))
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-dialog-cancel'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(calls(deactivate)).toHaveLength(0)
  })

  it('on confirm marks the row inactive, offers Reactivate, confirms, and moves focus to the row header', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [deactivate]: () => ({ status: 200, body: { ...ACTIVE, active: false } }) })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-5905'))
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const row = screen.getByTestId('accounting-ledger-row-5905')
    expect(within(row).getByText('Inactive')).not.toBeNull()
    expect(screen.queryByTestId('accounting-ledger-deactivate-5905')).toBeNull()
    expect(screen.getByTestId('accounting-ledger-reactivate-5905')).not.toBeNull()
    expect(screen.getByTestId('accounting-saved').textContent).toBe('Account 5905 deactivated')
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
    await expectNoAxeViolations()
  })

  it('is busy while saving: not dismissible, and the row actions are disabled', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [deactivate]: never })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-5905'))
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm'))

    await waitFor(() => expect(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm').textContent).toBe('Deactivating…'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect((screen.getByTestId('accounting-ledger-reactivate-5901') as HTMLButtonElement).disabled).toBe(true)
    await expectNoAxeViolations()
  })

  it('keeps the confirm open with a retry message on a server failure, and a permission message plus a re-read on 403', async () => {
    const answers = [problem(500), problem(403, 'accounting_manage_required')]
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [deactivate]: () => answers.shift()! })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-5905'))
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-ledger-deactivate-dialog-error').textContent).toBe('Could not save. Try again.'),
    )
    expect(within(screen.getByTestId('accounting-ledger-row-5905')).getByText('Active')).not.toBeNull()
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-ledger-deactivate-dialog-error').textContent).toBe("You don't have permission to do this."),
    )
    expect(onWriteRefused).toHaveBeenCalledTimes(1)
  })

  it('a stale list (409 already_inactive) is said in an alert, closes the confirm and reloads the list (AC-1.11)', async () => {
    let reads = 0
    serve({
      [LIST]: () => (++reads === 1 ? list(ACTIVE, INACTIVE) : list({ ...ACTIVE, active: false }, INACTIVE)),
      [deactivate]: () => problem(409, 'already_inactive'),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-5905'))
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('accounting-ledger-action-error').textContent).toContain('Account 5905 is already deactivated.')
    await waitFor(() => expect(calls(LIST)).toHaveLength(2))
    await waitFor(() => expect(within(screen.getByTestId('accounting-ledger-row-5905')).getByText('Inactive')).not.toBeNull())
    expect(screen.queryByTestId('accounting-saved')).toBeNull()
    await expectNoAxeViolations()
  })

  it('a number that is no longer there (404) closes the confirm, says the generic failure and reloads', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [deactivate]: () => problem(404, 'not_found') })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-5905'))
    fireEvent.click(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('accounting-ledger-action-error').textContent).toContain('Could not save. Try again.')
    await waitFor(() => expect(calls(LIST)).toHaveLength(2))
  })
})

describe('LedgerAccountsCard: Reactivate (AC-1.9, AC-1.11)', () => {
  const reactivate = 'POST /v1/entities/welld_ch/ledger-accounts/5901/reactivate'

  it('acts at once, with no dialog, marks the row active, confirms and moves focus to the row header', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [reactivate]: () => ({ status: 200, body: { ...INACTIVE, active: true } }) })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-reactivate-5901'))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await waitFor(() => expect(screen.getByTestId('accounting-ledger-deactivate-5901')).not.toBeNull())
    const row = screen.getByTestId('accounting-ledger-row-5901')
    expect(within(row).getByText('Active')).not.toBeNull()
    expect(screen.getByTestId('accounting-saved').textContent).toBe('Account 5901 reactivated')
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
    await expectNoAxeViolations()
  })

  it('a stale list (409 already_active) shows the alert "Account 5901 is already active." and reloads', async () => {
    let reads = 0
    serve({
      [LIST]: () => (++reads === 1 ? list(ACTIVE, INACTIVE) : list(ACTIVE, { ...INACTIVE, active: true })),
      [reactivate]: () => problem(409, 'already_active'),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-reactivate-5901'))

    const alert = await screen.findByTestId('accounting-ledger-action-error')
    expect(alert.textContent).toContain('Account 5901 is already active.')
    expect(alert.getAttribute('role')).toBe('alert')
    await waitFor(() => expect(screen.getByTestId('accounting-ledger-deactivate-5901')).not.toBeNull())
    expect(screen.queryByTestId('accounting-saved')).toBeNull()
    await expectNoAxeViolations()
  })

  it('shows a permission or generic failure in the same alert, and changes nothing', async () => {
    const answers = [problem(403, 'accounting_manage_required'), problem(500)]
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [reactivate]: () => answers.shift()! })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-reactivate-5901'))
    expect((await screen.findByTestId('accounting-ledger-action-error')).textContent).toContain("You don't have permission to do this.")
    expect(onWriteRefused).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('accounting-ledger-reactivate-5901'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-ledger-action-error').textContent).toContain('Could not save. Try again.'),
    )
    expect(within(screen.getByTestId('accounting-ledger-row-5901')).getByText('Inactive')).not.toBeNull()
  })

  it('dismisses the failure alert', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [reactivate]: () => problem(500) })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-reactivate-5901'))
    await screen.findByTestId('accounting-ledger-action-error')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('accounting-ledger-action-error')).toBeNull()
  })

  it('addresses a number by its natural key, encoded in the path', async () => {
    const dotted: LedgerAccount = { number: '2620.1', name: 'Anticipi', active: false }
    serve({
      [LIST]: () => list(dotted),
      'POST /v1/entities/welld_ch/ledger-accounts/2620.1/reactivate': () => ({ status: 200, body: { ...dotted, active: true } }),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-reactivate-2620.1'))
    await screen.findByTestId('accounting-saved')
    expect(calls('POST /v1/entities/welld_ch/ledger-accounts/2620.1/reactivate')).toHaveLength(1)
  })
})

describe('LedgerAccountsCard: Add dialog states under axe (AS6a)', () => {
  it('is clean: idle, a field refused, a server duplicate, a general error and while saving', async () => {
    const answers: FakeAnswer[] = [
      problem(409, 'ledger_account_duplicate', { number: '5999', reactivate: false }),
      problem(500),
    ]
    serve({
      [LIST]: () => list(ACTIVE, INACTIVE),
      'POST /v1/entities/welld_ch/ledger-accounts': () => answers.shift() ?? never(),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-ledger-add'))
    await expectNoAxeViolations()

    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: 'abc' } })
    fireEvent.blur(screen.getByTestId('accounting-ledger-number'))
    await screen.findByTestId('accounting-ledger-number-error')
    await expectNoAxeViolations()

    fireEvent.change(screen.getByTestId('accounting-ledger-number'), { target: { value: '5999' } })
    fireEvent.change(screen.getByTestId('accounting-ledger-name'), { target: { value: 'Spese' } })
    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-submit'))
    await waitFor(() => expect(screen.getByTestId('accounting-ledger-number-error').textContent).toContain('already exists'))
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-submit'))
    await screen.findByTestId('accounting-ledger-dialog-error')
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('accounting-ledger-dialog-submit'))
    await waitFor(() => expect(screen.getByTestId('accounting-ledger-dialog-submit').textContent).toBe('Adding…'))
    await expectNoAxeViolations()
  })
})
