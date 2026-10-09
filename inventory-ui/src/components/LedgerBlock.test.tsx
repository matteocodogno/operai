/**
 * @vitest-environment jsdom
 *
 * Component tests for LedgerBlock (T34, specs/015-hardware-inventory; design.md
 * § T2 ledger region, F9, F10, § Accessibility "T2 detail"; refs AC-5.8, AC-7.1,
 * AC-7.3, AC-7.5). DisposeDialog is replaced by a fake (it has its own tests)
 * that exposes the callbacks the block reacts to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AssetView, Ledger } from '../lib/types'

const fakeState = vi.hoisted(() => ({ updated: null as unknown }))
const { disposeFake } = await vi.hoisted(async () => {
  const { createElement: h } = await import('react')
  return {
    disposeFake: (props: {
      onDisposed: (asset: unknown) => void
      onCancel: () => void
      onConflict: (kind: string) => void
    }) =>
      h(
        'div',
        { role: 'alertdialog', 'data-testid': 'dispose-fake' },
        h('button', { onClick: () => props.onDisposed(fakeState.updated) }, 'fake disposed'),
        h('button', { onClick: props.onCancel }, 'fake cancel'),
        h('button', { onClick: () => props.onConflict('asset_disposed') }, 'fake disposed-conflict'),
        h('button', { onClick: () => props.onConflict('not_found') }, 'fake not-found'),
        h('button', { onClick: () => props.onConflict('assignment_pending') }, 'fake pending'),
      ),
  }
})
vi.mock('./DisposeDialog', () => ({ default: disposeFake }))

import LedgerBlock from './LedgerBlock'

const LEDGER: Ledger = {
  bookValueCents: 33272,
  rule: {
    id: 'r1',
    effectiveFrom: '2026-01-01',
    usefulLifeYears: 3,
    firstYearShare: 'full',
    lowValueThresholdCents: null,
    residualCents: 100,
  },
  schedule: [
    { year: 2026, depreciationCents: 33272, closingCents: 66543, closed: true },
    { year: 2027, depreciationCents: 33271, closingCents: 33272, closed: false },
    { year: 2028, depreciationCents: 33172, closingCents: 100, closed: false },
  ],
}

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  id: 'a1',
  entity: 'welld_ch',
  currency: 'CHF',
  category: 'laptop',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  purchaseDate: '2026-09-25',
  purchasePriceCents: 99815,
  status: 'assigned',
  holder: { id: 'u1', name: 'Anna Rossi', status: 'active' },
  pendingAssignment: null,
  locationNote: null,
  supplier: null,
  invoiceRef: null,
  invoiceFile: null,
  toVerify: false,
  disposal: null,
  ledger: LEDGER,
  ...over,
})

const ACCOUNTANT = { canManageAssets: false, canManageLedger: true }
const onChanged = vi.fn()
const announce = vi.fn()
const focusHeading = vi.fn()

const renderBlock = (over: Partial<AssetView> = {}, capabilities = ACCOUNTANT) =>
  render(
    <LedgerBlock
      asset={asset(over)}
      capabilities={capabilities}
      onChanged={onChanged}
      announce={announce}
      focusHeading={focusHeading}
    />,
  )

const disposeButton = () => screen.getByRole('button', { name: 'Dispose...' })

beforeEach(() => {
  fakeState.updated = asset({ status: 'disposed' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the block (AC-5.8)', () => {
  it('is a section with its own Ledger heading', () => {
    renderBlock()
    const section = screen.getByRole('region', { name: 'Ledger' })
    expect(within(section).getByRole('heading', { level: 3, name: 'Ledger' })).not.toBeNull()
  })

  it('shows the book value today with its currency', () => {
    renderBlock()
    expect(screen.getByTestId('ledger-book-value').textContent).toContain('Book value today')
    expect(screen.getByTestId('ledger-book-value').textContent).toContain('332,72 CHF')
  })

  it('states the rule in force with its effective date', () => {
    renderBlock()
    const rule = screen.getByTestId('ledger-rule')
    expect(rule.textContent).toContain('Rule applied: life 3 y, full first year, no threshold, residual 1,00 CHF')
    expect(rule.textContent).toContain('In force from 01.01.2026')
  })

  it('states a half first year and a low-value threshold', () => {
    renderBlock({
      ledger: {
        ...LEDGER,
        rule: { ...LEDGER.rule, firstYearShare: 'half', lowValueThresholdCents: 80000, usefulLifeYears: 4 },
      },
    })
    expect(screen.getByTestId('ledger-rule').textContent).toContain(
      'Rule applied: life 4 y, half first year, threshold 800,00 CHF, residual 1,00 CHF',
    )
  })

  it('renders every year of the schedule, each with the currency', () => {
    renderBlock()
    const table = screen.getByRole('table', { name: 'Depreciation schedule' })
    const bodyRows = within(table).getAllByRole('row').slice(1)
    expect(bodyRows).toHaveLength(3)
    for (const row of bodyRows) expect(row.textContent).toContain('CHF')
  })

  it('renders nothing when the server sent no ledger (not an empty block)', () => {
    const { container } = renderBlock({ ledger: undefined })
    expect(container.textContent).toBe('')
  })

  it('renders nothing for a viewer without the ledger capability', () => {
    const { container } = renderBlock({}, { canManageAssets: true, canManageLedger: false })
    expect(container.textContent).toBe('')
  })
})

describe('Dispose (AC-7.1)', () => {
  it('is offered inside the block, and opens the dispose dialog', () => {
    renderBlock()
    const section = screen.getByRole('region', { name: 'Ledger' })
    expect(within(section).getByRole('button', { name: 'Dispose...' })).not.toBeNull()

    fireEvent.click(disposeButton())

    expect(screen.getByTestId('dispose-fake')).not.toBeNull()
  })

  it('is offered for every status that is not disposed', () => {
    for (const status of ['ordered', 'in_stock', 'assigned', 'in_repair', 'lost'] as const) {
      const { unmount } = renderBlock({ status })
      expect(screen.queryByRole('button', { name: 'Dispose...' })).not.toBeNull()
      unmount()
    }
  })

  it('on success hands the disposed asset over, announces it, closes the dialog and focuses the heading', () => {
    renderBlock()
    fireEvent.click(disposeButton())

    fireEvent.click(screen.getByText('fake disposed'))

    expect(onChanged).toHaveBeenCalledWith(fakeState.updated)
    expect(announce).toHaveBeenCalledWith('Asset disposed.')
    expect(focusHeading).toHaveBeenCalled()
    expect(screen.queryByTestId('dispose-fake')).toBeNull()
  })

  it('Cancel closes the dialog without any change', () => {
    renderBlock()
    fireEvent.click(disposeButton())

    fireEvent.click(screen.getByText('fake cancel'))

    expect(screen.queryByTestId('dispose-fake')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect(focusHeading).not.toHaveBeenCalled()
  })

  it('asset_disposed closes the dialog, explains in a guardrail and reloads once acknowledged', () => {
    renderBlock()
    fireEvent.click(disposeButton())
    fireEvent.click(screen.getByText('fake disposed-conflict'))

    expect(screen.queryByTestId('dispose-fake')).toBeNull()
    expect(screen.getByTestId('guardrail-dialog').textContent).toContain(
      'This asset has been disposed of and can no longer be changed.',
    )
    expect(onChanged).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))
    expect(onChanged).toHaveBeenCalledWith(null)
  })

  it('a vanished asset reloads the page at once', () => {
    renderBlock()
    fireEvent.click(disposeButton())
    fireEvent.click(screen.getByText('fake not-found'))

    expect(onChanged).toHaveBeenCalledWith(null)
    expect(screen.queryByTestId('dispose-fake')).toBeNull()
  })

  it('a pending assignment found by the server reloads the asset but keeps the dialog and its message', () => {
    renderBlock()
    fireEvent.click(disposeButton())
    fireEvent.click(screen.getByText('fake pending'))

    expect(onChanged).toHaveBeenCalledWith(null)
    expect(screen.getByTestId('dispose-fake')).not.toBeNull()
  })
})

describe('a pending assignment blocks Dispose (AC-7.5)', () => {
  const pending = {
    pendingAssignment: {
      id: 'p1',
      assignee: { id: 'u2', name: 'Marco Bianchi', status: 'active' as const },
      createdAt: '2026-10-05T08:00:00Z',
    },
    status: 'in_stock' as const,
    holder: null,
  }

  it('is aria-disabled, still focusable, and names the assignee in a described reason', () => {
    renderBlock(pending)

    const button = disposeButton()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    const reason = document.getElementById(button.getAttribute('aria-describedby')!)!
    expect(reason.textContent).toBe(
      'Cancel the pending assignment to Marco Bianchi first. Only an inventory manager can do that.',
    )
  })

  it('does nothing when activated', () => {
    renderBlock(pending)
    fireEvent.click(disposeButton())
    expect(screen.queryByTestId('dispose-fake')).toBeNull()
  })

  it('has no reason or aria-disabled without a pending assignment', () => {
    renderBlock()
    expect(disposeButton().getAttribute('aria-disabled')).toBeNull()
    expect(disposeButton().getAttribute('aria-describedby')).toBeNull()
  })
})

describe('after disposal (AC-7.3)', () => {
  const disposed = (salePriceCents: number | null) =>
    asset({
      status: 'disposed',
      holder: null,
      disposal: { disposedOn: '2026-10-01', reason: 'sold', salePriceCents },
      ledger: { ...LEDGER, bookValueCents: 0 },
    })

  it('shows the disposal and offers no Dispose button', () => {
    renderBlock(disposed(12050))

    expect(screen.queryByRole('button', { name: 'Dispose...' })).toBeNull()
    const panel = screen.getByTestId('ledger-disposal')
    expect(panel.textContent).toContain('01.10.2026')
    expect(panel.textContent).toContain('Sold')
    expect(panel.textContent).toContain('120,50 CHF')
  })

  it('shows book value zero and the Disposed row in the schedule', () => {
    renderBlock(disposed(null))

    expect(screen.getByTestId('ledger-book-value').textContent).toContain('0,00 CHF')
    expect(screen.getByRole('rowheader', { name: 'Disposed 01.10.2026' })).not.toBeNull()
  })

  it('shows no sale price when none was recorded, and labels a lost write-off', () => {
    renderBlock({ ...disposed(null), disposal: { disposedOn: '2026-10-01', reason: 'lost', salePriceCents: null } })

    const panel = screen.getByTestId('ledger-disposal')
    expect(panel.textContent).not.toContain('Sale price')
    expect(panel.textContent).toContain('Written off as lost')
  })

  it('has no disposal panel for a live asset', () => {
    renderBlock()
    expect(screen.queryByTestId('ledger-disposal')).toBeNull()
  })
})
