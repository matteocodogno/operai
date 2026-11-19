/**
 * @vitest-environment jsdom
 *
 * VatCodesCard (T30, specs/20261119-accounting, design AS4, FA4, FA5, FA6, UX-3 to UX-8, UX-15; AC-1.5 to AC-1.8, AC-1.10,
 * AC-8.3, AC-8.4): the list and every state of it, Add, the Deactivate confirm, Reactivate, a stale list's 409, read-only without
 * `canManage`, NO EDIT CONTROL for a rate (AC-1.7), no dialog inside a form, and axe on every state. accounting-api is faked at
 * `shell/session`'s `apiFetch`, so the real `catalogApi` paths and bodies are exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'
import type { VatCode } from '../lib/catalogApi'
import type { EntityId } from '../lib/meApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import VatCodesCard from './VatCodesCard'

const ACTIVE: VatCode = { code: 'IMP81', label: 'Imposta 8.1%', ratePercent: '8.1', active: true }
const INACTIVE: VatCode = { code: 'IMP77', label: 'Imposta 7.7%', ratePercent: '7.7', active: false }

const LIST = 'GET /v1/entities/welld_ch/vat-codes'
const list = (...items: VatCode[]): FakeAnswer => ({
  status: 200,
  body: { entity: 'welld_ch', items: items.map((item) => ({ ...item, rateBasisPoints: Math.round(Number(item.ratePercent) * 100) })) },
})
const never = (): Promise<FakeAnswer> => new Promise(() => {})

const onEntityGone = vi.fn()
const onWriteRefused = vi.fn()

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
  <VatCodesCard entity={entity} canManage={canManage} onEntityGone={onEntityGone} onWriteRefused={onWriteRefused} />
)

const renderCard = async (canManage = true) => {
  const view = render(card(canManage))
  await screen.findByTestId('accounting-vat-table')
  return view
}

describe('VatCodesCard: the list (AS4)', () => {
  it('shows a polite loading line and a skeleton while the list loads', async () => {
    serve({ [LIST]: never })
    const { container } = render(card())
    expect(screen.getByRole('status').textContent).toBe('Loading VAT codes…')
    expect(screen.queryByTestId('accounting-vat-table')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('names the entity in the title, the caption and the description, and lists code (row header, mono), label, rate and status', async () => {
    const { container } = await renderCard()
    expect(screen.getByRole('heading', { name: 'VAT codes — WellD CH' })).not.toBeNull()
    expect(screen.getByRole('table', { name: 'WellD CH VAT codes' })).not.toBeNull()
    expect(screen.getByText('The VAT codes of WellD CH. Each carries one fixed rate.')).not.toBeNull()
    const row = screen.getByTestId('accounting-vat-row-IMP81')
    const header = within(row).getByRole('rowheader')
    expect(header.textContent).toBe('IMP81')
    expect(header.querySelector('.font-mono')).not.toBeNull()
    expect(within(row).getByText('Imposta 8.1%')).not.toBeNull()
    expect(within(row).getByText('8.1%')).not.toBeNull()
    expect(within(row).getByText('Active')).not.toBeNull()
    expect(within(screen.getByTestId('accounting-vat-row-IMP77')).getByText('Inactive')).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Code',
      'Label',
      'VAT rate',
      'Status',
      'Actions',
    ])
    expect(screen.queryByText(/@/)).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('reads the list of the entity it is given, by path (WellD Italia)', async () => {
    serve({
      'GET /v1/entities/welld_it/vat-codes': () => ({
        status: 200,
        body: { entity: 'welld_it', items: [{ code: 'IVA22', label: 'IVA 22%', ratePercent: '22', rateBasisPoints: 2200, active: true }] },
      }),
    })
    render(card(true, 'welld_it'))
    await screen.findByTestId('accounting-vat-table')
    expect(screen.getByRole('heading', { name: 'VAT codes — WellD Italia' })).not.toBeNull()
    expect(screen.getByTestId('accounting-vat-row-IVA22')).not.toBeNull()
  })

  it('manager, empty: a state for the entity, not an error (AC-8.3)', async () => {
    serve({ [LIST]: () => list() })
    const { container } = render(card())
    const empty = await screen.findByTestId('accounting-empty')
    expect(empty.textContent).toContain('Nothing entered yet for WellD CH')
    expect(empty.textContent).toContain("Add the entity's VAT codes with Add VAT code.")
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('accounting-vat-add')).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('reader, empty (WellD Italia): the reader sentence, no Add', async () => {
    serve({ 'GET /v1/entities/welld_it/vat-codes': () => ({ status: 200, body: { entity: 'welld_it', items: [] } }) })
    const { container } = render(card(false, 'welld_it'))
    const empty = await screen.findByTestId('accounting-empty')
    expect(empty.textContent).toContain('Nothing entered yet for WellD Italia')
    expect(empty.textContent).toContain('Accounting managers enter them.')
    expect(screen.queryByTestId('accounting-vat-add')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('failed: a warning banner with the card’s sentence, and Retry loads again; 503 is the authorization banner', async () => {
    let reads = 0
    serve({ [LIST]: () => (++reads === 1 ? problem(500) : list(ACTIVE)) })
    const { container } = render(card())
    expect((await screen.findByTestId('accounting-load-error')).textContent).toContain('Could not load the VAT codes.')
    await expectNoAxeViolations(container)
    fireEvent.click(screen.getByTestId('accounting-load-error-retry'))
    await screen.findByTestId('accounting-vat-table')
    expect(calls(LIST)).toHaveLength(2)
    cleanup()

    serve({ [LIST]: () => problem(503) })
    const unavailable = render(card())
    expect((await screen.findByTestId('accounting-load-error')).textContent).toContain('Authorization service unavailable')
    await expectNoAxeViolations(unavailable.container)
  })

  it('403: PermissionDenied replaces the view, with no retry', async () => {
    serve({ [LIST]: () => problem(403, 'accounting_forbidden') })
    const { container } = render(card())
    expect((await screen.findByTestId('accounting-denied')).textContent).toContain('No access to Accounting')
    expect(screen.queryByTestId('accounting-vat-card')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('404: tells the frame once that the entity is gone', async () => {
    serve({ [LIST]: () => problem(404, 'not_found') })
    render(card())
    await screen.findByTestId('accounting-load-error')
    await waitFor(() => expect(onEntityGone).toHaveBeenCalledTimes(1))
  })
})

describe('VatCodesCard: reader (UX-4, AC-3.4)', () => {
  it('shows the table, the one quiet sentence, and no Add, no Actions column, no row button', async () => {
    const { container } = await renderCard(false)
    expect(screen.getByTestId('accounting-vat-read-only').textContent).toBe(
      'You can view this list. Accounting managers add and deactivate VAT codes.',
    )
    expect(screen.queryByTestId('accounting-vat-add')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull()
    expect(within(screen.getByTestId('accounting-vat-table')).queryAllByRole('button')).toHaveLength(0)
    await expectNoAxeViolations(container)
  })
})

describe('VatCodesCard: no edit control for a rate (AC-1.7)', () => {
  it('shows each rate as plain text and offers only Deactivate and Reactivate on a row: no input, no edit, no delete', async () => {
    await renderCard()
    const table = screen.getByTestId('accounting-vat-table')
    expect(within(screen.getByTestId('accounting-vat-row-IMP81')).getByText('8.1%').closest('td')?.querySelector('input, select, textarea, button')).toBeNull()
    expect(table.querySelector('input, select, textarea')).toBeNull()
    expect(within(table).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Deactivate VAT code IMP81',
      'Reactivate VAT code IMP77',
    ])
    expect(screen.queryByRole('button', { name: /edit|modify|change|rate|delete|remove/i })).toBeNull()
    // and the client has no function that could send one
    const verbs = apiFetch.mock.calls.map(([, init]) => init?.method ?? 'GET')
    expect(verbs.every((verb) => verb === 'GET')).toBe(true)
  })
})

describe('VatCodesCard: Add VAT code (AC-1.5, AC-1.6)', () => {
  const created: VatCode = { code: 'RID26', label: 'Ridotta 2.6%', ratePercent: '2.6', active: true }

  it('opens the dialog beside the card naming the entity, adds the code, shows the row and a confirmation, and returns focus to Add', async () => {
    let added = false
    serve({
      [LIST]: () => list(ACTIVE, INACTIVE, ...(added ? [created] : [])),
      'POST /v1/entities/welld_ch/vat-codes': () => ((added = true), { status: 201, body: created }),
    })
    await renderCard()
    const addButton = screen.getByTestId('accounting-vat-add')
    expect(addButton.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(addButton)
    const dialog = screen.getByRole('dialog', { name: 'Add VAT code — WellD CH' })
    expect(screen.getByTestId('accounting-vat-card').contains(dialog)).toBe(false)
    expect(document.querySelectorAll('form form')).toHaveLength(0)

    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: 'rid26' } })
    fireEvent.change(screen.getByTestId('accounting-vat-label'), { target: { value: 'Ridotta 2.6%' } })
    fireEvent.change(screen.getByTestId('accounting-vat-rate'), { target: { value: '2,60' } })
    fireEvent.click(screen.getByTestId('accounting-vat-dialog-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // upper-cased, comma accepted, the canonical rate sent
    expect(JSON.parse(String(calls('POST /v1/entities/welld_ch/vat-codes')[0]![1]!.body))).toEqual({
      code: 'RID26',
      label: 'Ridotta 2.6%',
      ratePercent: '2.6',
    })
    expect(screen.getByTestId('accounting-vat-row-RID26')).not.toBeNull()
    expect(screen.getByTestId('accounting-saved').textContent).toBe('VAT code RID26 added')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-add'))
    await waitFor(() => expect(calls(LIST)).toHaveLength(2))
    expect(screen.getAllByTestId(/^accounting-vat-row-/)).toHaveLength(3)
  })

  it('names a case-insensitive duplicate on the field, with the reactivation pointer only when it is deactivated (AC-1.6)', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-add'))
    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: 'imp77' } })
    fireEvent.blur(screen.getByTestId('accounting-vat-code'))
    expect(screen.getByTestId('accounting-vat-code-error').textContent).toBe(
      'VAT code IMP77 already exists but is deactivated. Reactivate it from the list.',
    )
    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: 'imp81' } })
    fireEvent.blur(screen.getByTestId('accounting-vat-code'))
    expect(screen.getByTestId('accounting-vat-code-error').textContent).toBe('VAT code IMP81 already exists in WellD CH.')
    expect(calls('POST /v1/entities/welld_ch/vat-codes')).toHaveLength(0)
  })

  it('Cancel closes the dialog without a request and returns focus to Add', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-add'))
    fireEvent.click(screen.getByTestId('accounting-vat-dialog-cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls('POST /v1/entities/welld_ch/vat-codes')).toHaveLength(0)
    expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-add'))
  })
})

describe('VatCodesCard: Deactivate (AC-1.8, AC-1.10, UX-7)', () => {
  const deactivate = 'POST /v1/entities/welld_ch/vat-codes/IMP81/deactivate'

  it('asks first, saying the rate never changes and naming no consumer, and Cancel does nothing', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-IMP81'))
    const dialog = screen.getByRole('alertdialog', { name: 'Deactivate VAT code IMP81?' })
    expect(within(dialog).getByText(/Its rate never changes\./)).not.toBeNull()
    expect(within(dialog).getByText(/You can reactivate it at any time\./)).not.toBeNull()
    expect(dialog.textContent).not.toMatch(/refund|request|line/i)
    expect(screen.getByTestId('accounting-vat-deactivate-dialog-confirm').className).toContain('btn-primary')
    expect(document.activeElement).toBe(screen.getByTestId('accounting-vat-deactivate-dialog-cancel'))
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-dialog-cancel'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(calls(deactivate)).toHaveLength(0)
  })

  it('on confirm marks the row inactive, offers Reactivate, confirms, and moves focus to the row header', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [deactivate]: () => ({ status: 200, body: { ...ACTIVE, active: false } }) })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-IMP81'))
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-dialog-confirm'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const row = screen.getByTestId('accounting-vat-row-IMP81')
    expect(within(row).getByText('Inactive')).not.toBeNull()
    expect(within(row).getByText('8.1%')).not.toBeNull()
    expect(screen.getByTestId('accounting-vat-reactivate-IMP81')).not.toBeNull()
    expect(screen.getByTestId('accounting-saved').textContent).toBe('VAT code IMP81 deactivated')
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
    await expectNoAxeViolations()
  })

  it('is busy while saving: not dismissible, and the row actions are disabled', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [deactivate]: never })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-IMP81'))
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-dialog-confirm'))
    await waitFor(() => expect(screen.getByTestId('accounting-vat-deactivate-dialog-confirm').textContent).toBe('Deactivating…'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect((screen.getByTestId('accounting-vat-reactivate-IMP77') as HTMLButtonElement).disabled).toBe(true)
    await expectNoAxeViolations()
  })

  it('a failure keeps the confirm open with a retry message, and a 403 says permission and re-reads /v1/me', async () => {
    let call = 0
    serve({
      [LIST]: () => list(ACTIVE, INACTIVE),
      [deactivate]: () => (++call === 1 ? problem(500) : problem(403, 'accounting_manage_required')),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-IMP81'))
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-vat-deactivate-dialog-error').textContent).toBe('Could not save. Try again.'),
    )
    await expectNoAxeViolations()
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-vat-deactivate-dialog-error').textContent).toBe("You don't have permission to do this."),
    )
    expect(onWriteRefused).toHaveBeenCalledTimes(1)
  })

  it('a stale list (409 already_inactive) is said in an alert, closes the confirm and reloads (AC-1.11)', async () => {
    let reads = 0
    serve({
      [LIST]: () => (++reads === 1 ? list(ACTIVE, INACTIVE) : list({ ...ACTIVE, active: false }, INACTIVE)),
      [deactivate]: () => problem(409, 'already_inactive'),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-IMP81'))
    fireEvent.click(screen.getByTestId('accounting-vat-deactivate-dialog-confirm'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('accounting-vat-action-error').textContent).toContain('VAT code IMP81 is already deactivated.')
    await waitFor(() => expect(within(screen.getByTestId('accounting-vat-row-IMP81')).getByText('Inactive')).not.toBeNull())
    await expectNoAxeViolations()
  })
})

describe('VatCodesCard: Reactivate (AC-1.8, AC-1.10, AC-1.11)', () => {
  const reactivate = 'POST /v1/entities/welld_ch/vat-codes/IMP77/reactivate'

  it('acts at once, with no dialog, marks the row active, confirms and moves focus to the row header', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [reactivate]: () => ({ status: 200, body: { ...INACTIVE, active: true } }) })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-reactivate-IMP77'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('accounting-vat-deactivate-IMP77')).not.toBeNull())
    const row = screen.getByTestId('accounting-vat-row-IMP77')
    expect(within(row).getByText('Active')).not.toBeNull()
    expect(screen.getByTestId('accounting-saved').textContent).toBe('VAT code IMP77 reactivated')
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
    await expectNoAxeViolations()
  })

  it('a stale list (409 already_active) shows the alert and reloads; a 403 or 500 shows in the same alert', async () => {
    let call = 0
    let reads = 0
    serve({
      [LIST]: () => (++reads === 1 ? list(ACTIVE, INACTIVE) : list(ACTIVE, { ...INACTIVE, active: true })),
      [reactivate]: () => (++call === 1 ? problem(409, 'already_active') : problem(500)),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-reactivate-IMP77'))
    const alert = await screen.findByTestId('accounting-vat-action-error')
    expect(alert.textContent).toContain('VAT code IMP77 is already active.')
    expect(alert.getAttribute('role')).toBe('alert')
    await waitFor(() => expect(screen.getByTestId('accounting-vat-deactivate-IMP77')).not.toBeNull())
    await expectNoAxeViolations()
  })

  it('shows a permission failure in the alert, tells the frame, and changes nothing', async () => {
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), [reactivate]: () => problem(403, 'accounting_manage_required') })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-reactivate-IMP77'))
    expect((await screen.findByTestId('accounting-vat-action-error')).textContent).toContain("You don't have permission to do this.")
    expect(onWriteRefused).toHaveBeenCalledTimes(1)
    expect(within(screen.getByTestId('accounting-vat-row-IMP77')).getByText('Inactive')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('accounting-vat-action-error')).toBeNull()
  })

  it('addresses a code by its natural key, encoded in the path', async () => {
    const odd: VatCode = { code: 'A-1_B', label: 'x', ratePercent: '1', active: false }
    serve({
      [LIST]: () => list(odd),
      'POST /v1/entities/welld_ch/vat-codes/A-1_B/reactivate': () => ({ status: 200, body: { ...odd, active: true } }),
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-reactivate-A-1_B'))
    await screen.findByTestId('accounting-saved')
  })
})

describe('VatCodesCard: Add dialog states under axe (AS6b)', () => {
  it('is clean: idle, a field refused, a server duplicate, a general error and while saving', async () => {
    const answers: FakeAnswer[] = [
      problem(409, 'vat_code_duplicate', { vatCode: 'NEW1', reactivate: false }),
      problem(500),
    ]
    serve({ [LIST]: () => list(ACTIVE, INACTIVE), 'POST /v1/entities/welld_ch/vat-codes': () => answers.shift() ?? never() })
    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-vat-add'))
    await expectNoAxeViolations()

    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: 'a b' } })
    fireEvent.blur(screen.getByTestId('accounting-vat-code'))
    await screen.findByTestId('accounting-vat-code-error')
    await expectNoAxeViolations()

    fireEvent.change(screen.getByTestId('accounting-vat-code'), { target: { value: 'NEW1' } })
    fireEvent.change(screen.getByTestId('accounting-vat-label'), { target: { value: 'New' } })
    fireEvent.change(screen.getByTestId('accounting-vat-rate'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('accounting-vat-dialog-submit'))
    await waitFor(() => expect(screen.getByTestId('accounting-vat-code-error').textContent).toContain('already exists'))
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('accounting-vat-dialog-submit'))
    await screen.findByTestId('accounting-vat-dialog-error')
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('accounting-vat-dialog-submit'))
    await waitFor(() => expect(screen.getByTestId('accounting-vat-dialog-submit').textContent).toBe('Adding…'))
    await expectNoAxeViolations()
  })
})
