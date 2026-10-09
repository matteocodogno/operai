/**
 * @vitest-environment jsdom
 *
 * Component tests for AssetActions (T33, specs/015-hardware-inventory; design.md
 * F3, F5, § Dialogs, § Error and conflict catalogue, § Accessibility "T2
 * detail"; refs AC-1.8, AC-2.1, AC-2.2, AC-2.5, AC-2.10, AC-3.1 to AC-3.5).
 * `assetsApi` and `assignmentsApi` are the seams; AssignDialog is replaced by a
 * fake (it has its own tests) that exposes the callbacks the region reacts to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { AssetStatus, AssetView } from '../lib/types'

const api = vi.hoisted(() => ({
  receiveAsset: vi.fn(),
  returnAsset: vi.fn(),
  startRepair: vi.fn(),
  finishRepair: vi.fn(),
  markLost: vi.fn(),
  markFound: vi.fn(),
  cancelAssignment: vi.fn(),
}))
vi.mock('../lib/assetsApi', () => ({
  receiveAsset: api.receiveAsset,
  returnAsset: api.returnAsset,
  startRepair: api.startRepair,
  finishRepair: api.finishRepair,
  markLost: api.markLost,
  markFound: api.markFound,
}))
vi.mock('../lib/assignmentsApi', () => ({ cancelAssignment: api.cancelAssignment }))

const fakeState = vi.hoisted(() => ({
  conflict: null as unknown,
  assigned: {
    id: 'a1',
    status: 'in_stock',
    pendingAssignment: {
      id: 'p9',
      assignee: { id: 'u1', name: 'Anna Rossi', status: 'active' },
      createdAt: '2026-10-07T08:00:00Z',
    },
  } as unknown,
}))

const { assignFake } = await vi.hoisted(async () => {
  const { createElement: h } = await import('react')
  return {
    assignFake: (props: {
      onAssigned: (asset: unknown) => void
      onCancel: () => void
      onConflict: (error: unknown) => void
    }) =>
      h(
        'div',
        { role: 'dialog', 'data-testid': 'assign-fake' },
        h('button', { onClick: () => props.onAssigned(fakeState.assigned) }, 'fake assigned'),
        h('button', { onClick: props.onCancel }, 'fake cancel'),
        h('button', { onClick: () => props.onConflict(fakeState.conflict) }, 'fake conflict'),
      ),
  }
})
vi.mock('./AssignDialog', () => ({ default: assignFake }))

import AssetActions from './AssetActions'

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  id: 'a1',
  entity: 'welld_ch',
  currency: 'CHF',
  category: 'laptop',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  purchaseDate: '2026-09-25',
  purchasePriceCents: 99815,
  status: 'in_stock',
  holder: null,
  pendingAssignment: null,
  locationNote: null,
  supplier: null,
  invoiceRef: null,
  invoiceFile: null,
  toVerify: false,
  disposal: null,
  ...over,
})

const MANAGER = { canManageAssets: true, canManageLedger: false }
const ACCOUNTANT = { canManageAssets: false, canManageLedger: true }

const onChanged = vi.fn()
const announce = vi.fn()
const focusHeading = vi.fn()

const renderActions = (
  over: Partial<AssetView> = {},
  capabilities: { canManageAssets: boolean; canManageLedger: boolean } = MANAGER,
) =>
  render(
    <AssetActions
      asset={asset(over)}
      capabilities={capabilities}
      onChanged={onChanged}
      announce={announce}
      focusHeading={focusHeading}
    />,
  )

const buttonNames = () =>
  within(screen.getByRole('group', { name: 'Asset actions' }))
    .getAllByRole('button')
    .map((button) => button.textContent)

const anna = { id: 'u1', name: 'Anna Rossi', status: 'active' as const }
const pendingAsset = (over: Partial<AssetView> = {}) =>
  asset({ pendingAssignment: { id: 'p1', assignee: anna, createdAt: '2026-10-04T08:00:00Z' }, ...over })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  for (const fn of Object.values(api)) fn.mockResolvedValue(asset({ description: 'Updated' }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the action set per status (F5)', () => {
  it.each<[string, AssetStatus, string[]]>([
    ['ordered', 'ordered', ['Mark as received']],
    ['in stock', 'in_stock', ['Assign...', 'Mark in repair', 'Mark lost']],
    ['assigned', 'assigned', ['Record return', 'Mark in repair', 'Mark lost']],
    ['in repair', 'in_repair', ['Repair finished', 'Mark lost']],
    ['lost', 'lost', ['Mark found']],
  ])('%s offers exactly its actions (AC-1.8, AC-2.10, AC-3.1 to AC-3.5)', (_name, status, expected) => {
    renderActions({ status })
    expect(buttonNames()).toEqual(expected)
  })

  it("an in-stock asset with a pending assignment offers no action but the callout's Cancel (AC-2.2)", () => {
    renderActions(pendingAsset())

    expect(screen.queryByRole('group', { name: 'Asset actions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Assign...' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark in repair' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark lost' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel assignment' })).not.toBeNull()
  })

  it('a disposed asset renders nothing at all', () => {
    const { container } = renderActions({
      status: 'disposed',
      disposal: { disposedOn: '2026-10-01', reason: 'scrapped', salePriceCents: null },
    })
    expect(container.textContent).toBe('')
  })
})

describe('capability (AC-9.3)', () => {
  it('an accountant only has no action group, no Assign and no buttons at all', () => {
    renderActions({ status: 'in_stock' }, ACCOUNTANT)

    expect(screen.queryByRole('group', { name: 'Asset actions' })).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('an accountant sees the pending callout, read-only', () => {
    renderActions(pendingAsset(), ACCOUNTANT)

    expect(screen.getByTestId('pending-callout').textContent).toContain('Awaiting confirmation from Anna Rossi')
    expect(screen.queryByRole('button', { name: 'Cancel assignment' })).toBeNull()
  })

  it('an accountant sees the holder-deleted callout without its button', () => {
    renderActions({ status: 'assigned', holder: { id: 'u1', name: 'Anna Rossi', status: 'deleted' } }, ACCOUNTANT)

    expect(screen.getByTestId('holder-deleted-callout').textContent).toContain("Anna Rossi's account was deleted.")
    expect(screen.queryByRole('button', { name: 'Record return' })).toBeNull()
  })
})

describe('one-click actions: receive, repair, repair finished, found', () => {
  it.each([
    ['Mark as received', 'ordered', 'receiveAsset', 'Marked as received.'],
    ['Mark in repair', 'in_stock', 'startRepair', 'Marked in repair.'],
    ['Repair finished', 'in_repair', 'finishRepair', 'Repair finished.'],
    ['Mark found', 'lost', 'markFound', 'Marked as found.'],
  ] as const)(
    '%s calls the API at once, with no dialog, and reports the result',
    async (label, status, fn, message) => {
      const updated = asset({ status: 'in_stock', description: 'After' })
      api[fn].mockResolvedValue(updated)
      renderActions({ status })

      fireEvent.click(screen.getByRole('button', { name: label }))

      await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated))
      expect(api[fn]).toHaveBeenCalledWith('a1')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(announce).toHaveBeenCalledWith(message)
      // The trigger disappears with the status change: focus goes to the page heading.
      expect(focusHeading).toHaveBeenCalled()
    },
  )

  it('marks the clicked button busy and ignores every other action while in flight', async () => {
    api.markFound.mockReturnValue(new Promise(() => undefined))
    renderActions({ status: 'lost' })

    fireEvent.click(screen.getByRole('button', { name: 'Mark found' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark found' }))

    expect(api.markFound).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Mark found' }).getAttribute('aria-busy')).toBe('true')
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('Return and Lost confirm first (Q4)', () => {
  it('Record return opens a confirm that names the holder; confirming records the return (AC-3.1)', async () => {
    const updated = asset({ status: 'in_stock' })
    api.returnAsset.mockResolvedValue(updated)
    renderActions({ status: 'assigned', holder: anna })

    fireEvent.click(screen.getByRole('button', { name: 'Record return' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Record the return of MacBook Pro 14?' })).not.toBeNull()
    expect(dialog.textContent).toContain('Anna Rossi is no longer recorded as the holder')
    expect(api.returnAsset).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Record return' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated))
    expect(api.returnAsset).toHaveBeenCalledWith('a1')
    expect(announce).toHaveBeenCalledWith('Return recorded.')
    expect(focusHeading).toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Mark lost opens a destructive confirm with the consequence; confirming marks it lost (AC-3.4)', async () => {
    const updated = asset({ status: 'lost' })
    api.markLost.mockResolvedValue(updated)
    renderActions({ status: 'in_stock' })

    fireEvent.click(screen.getByRole('button', { name: 'Mark lost' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Mark MacBook Pro 14 as lost?' })).not.toBeNull()
    expect(dialog.textContent).toContain(
      'Lost assets stay on the books. The holder is cleared and is not restored by Mark found.',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark lost' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated))
    expect(announce).toHaveBeenCalledWith('Marked as lost.')
  })

  it('Cancel closes the confirm without a request and without moving focus to the heading', async () => {
    renderActions({ status: 'in_stock' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark lost' }))
    await screen.findByRole('alertdialog')

    fireEvent.click(screen.getByTestId('confirm-lost-cancel'))

    expect(screen.queryByTestId('confirm-lost-modal')).toBeNull()
    expect(api.markLost).not.toHaveBeenCalled()
    expect(focusHeading).not.toHaveBeenCalled()
  })

  it('a network failure keeps the confirm open with the message, so it can be retried', async () => {
    api.markLost.mockRejectedValue(new TypeError('Failed to fetch'))
    renderActions({ status: 'in_stock' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark lost' }))
    const dialog = await screen.findByRole('alertdialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark lost' }))

    await waitFor(() => expect(within(dialog).getByText(/Could not reach the server/)).not.toBeNull())
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('the pending assignment callout (AC-2.1, AC-2.5)', () => {
  it('names the assignee, the offered date and its age, as a status', () => {
    renderActions(pendingAsset())

    const callout = screen.getByTestId('pending-callout')
    expect(callout.getAttribute('role')).toBe('status')
    expect(callout.textContent).toContain('Awaiting confirmation from Anna Rossi, offered 04.10.2026, 3 days ago')
  })

  it('says "today" for an assignment offered today and has no expiry wording', () => {
    renderActions(pendingAsset({ pendingAssignment: { id: 'p1', assignee: anna, createdAt: '2026-10-07T08:00:00Z' } }))

    const text = screen.getByTestId('pending-callout').textContent!
    expect(text).toContain('today')
    expect(text.toLowerCase()).not.toMatch(/expire|days left|deadline/)
  })

  it('Cancel assignment asks first, then cancels the assignment by its id', async () => {
    const updated = asset({ status: 'in_stock', pendingAssignment: null })
    api.cancelAssignment.mockResolvedValue(updated)
    renderActions(pendingAsset())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Anna Rossi will no longer be asked to confirm this device.')
    expect(api.cancelAssignment).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel assignment' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated))
    expect(api.cancelAssignment).toHaveBeenCalledWith('p1')
    expect(announce).toHaveBeenCalledWith('Assignment cancelled.')
    expect(focusHeading).toHaveBeenCalled()
  })

  it('assignment_not_pending shows "no longer open" as an alert and reloads the asset', async () => {
    api.cancelAssignment.mockRejectedValue(
      new ApiError({ status: 409, title: 'Conflict', code: 'assignment_not_pending' }),
    )
    renderActions(pendingAsset())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment' }))
    const dialog = await screen.findByRole('alertdialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel assignment' }))

    const alert = await screen.findByTestId('asset-actions-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('This assignment is no longer open.')
    expect(onChanged).toHaveBeenCalledWith(null)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a 404 on the cancel reloads the asset', async () => {
    api.cancelAssignment.mockRejectedValue(new ApiError({ status: 404, title: 'Not Found' }))
    renderActions(pendingAsset())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel assignment' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null))
  })
})

describe('the holder-deleted callout', () => {
  const deletedHolder = { id: 'u1', name: 'Anna Rossi', status: 'deleted' as const }

  it('explains it and offers Record return, which uses the same confirm', async () => {
    renderActions({ status: 'assigned', holder: deletedHolder })

    const callout = screen.getByTestId('holder-deleted-callout')
    expect(callout.getAttribute('role')).toBe('status')
    expect(callout.textContent).toContain(
      "Anna Rossi's account was deleted. Record the return to put this asset back in stock.",
    )
    fireEvent.click(within(callout).getByRole('button', { name: 'Record return' }))

    expect(await screen.findByRole('alertdialog')).not.toBeNull()
  })

  it('copes with a deleted account that has no name', () => {
    renderActions({ status: 'assigned', holder: { id: 'u1', name: null, status: 'deleted' } })
    expect(screen.getByTestId('holder-deleted-callout').textContent).toContain("The holder's account was deleted.")
  })

  it('is absent for an active holder', () => {
    renderActions({ status: 'assigned', holder: anna })
    expect(screen.queryByTestId('holder-deleted-callout')).toBeNull()
  })
})

describe('Assign (AC-2.1)', () => {
  it('opens the assign dialog and, once assigned, hands the asset over and moves focus to the heading', async () => {
    renderActions({ status: 'in_stock' })

    fireEvent.click(screen.getByRole('button', { name: 'Assign...' }))
    fireEvent.click(await screen.findByText('fake assigned'))

    expect(onChanged).toHaveBeenCalledWith(fakeState.assigned)
    expect(announce).toHaveBeenCalledWith('Assignment offered. Awaiting confirmation from Anna Rossi.')
    expect(focusHeading).toHaveBeenCalled()
    expect(screen.queryByTestId('assign-fake')).toBeNull()
  })

  it('cancelling the dialog closes it and changes nothing', async () => {
    renderActions({ status: 'in_stock' })
    fireEvent.click(screen.getByRole('button', { name: 'Assign...' }))

    fireEvent.click(await screen.findByText('fake cancel'))

    expect(screen.queryByTestId('assign-fake')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect(focusHeading).not.toHaveBeenCalled()
  })

  it('a conflict from the dialog closes it and shows the guardrail; acknowledging refreshes the asset', async () => {
    fakeState.conflict = new ApiError({
      status: 409,
      title: 'Conflict',
      code: 'invalid_transition',
      extras: { from: 'assigned' },
    })
    renderActions({ status: 'in_stock' })
    fireEvent.click(screen.getByRole('button', { name: 'Assign...' }))
    fireEvent.click(await screen.findByText('fake conflict'))

    expect(screen.queryByTestId('assign-fake')).toBeNull()
    expect((await screen.findByTestId('guardrail-dialog')).textContent).toContain('This asset is now assigned;')
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))
    expect(onChanged).toHaveBeenCalledWith(null)
  })
})

describe('conflicts and failures (error catalogue)', () => {
  const fail = async (label: string, status: AssetStatus, error: unknown, fn: keyof typeof api) => {
    api[fn].mockRejectedValue(error)
    renderActions({ status })
    fireEvent.click(screen.getByRole('button', { name: label }))
  }

  it('invalid_transition shows the guardrail with the current status, and refreshes the asset once acknowledged', async () => {
    await fail(
      'Mark as received',
      'ordered',
      new ApiError({ status: 409, title: 'Conflict', code: 'invalid_transition', extras: { from: 'in_stock' } }),
      'receiveAsset',
    )

    const guardrail = await screen.findByTestId('guardrail-dialog')
    expect(guardrail.textContent).toContain(
      'This asset is now in stock; someone else changed it. The page has been refreshed.',
    )
    expect(onChanged).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))

    expect(onChanged).toHaveBeenCalledWith(null)
    expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
  })

  it('invalid_transition without a status uses the generic sentence', async () => {
    await fail(
      'Mark as received',
      'ordered',
      new ApiError({ status: 409, title: 'Conflict', code: 'invalid_transition' }),
      'receiveAsset',
    )

    expect((await screen.findByTestId('guardrail-dialog')).textContent).toContain(
      'This asset was changed by someone else. The page has been refreshed.',
    )
  })

  it('assignment_pending tells the manager to cancel the pending assignment first', async () => {
    api.markLost.mockRejectedValue(new ApiError({ status: 409, title: 'Conflict', code: 'assignment_pending' }))
    renderActions({ status: 'in_stock' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark lost' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Mark lost' }))

    expect((await screen.findByTestId('guardrail-dialog')).textContent).toContain(
      'This asset has a pending assignment to another person. Cancel it first.',
    )
    expect(screen.queryByTestId('confirm-lost-modal')).toBeNull()
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))
    expect(onChanged).toHaveBeenCalledWith(null)
  })

  it('asset_disposed says so in the guardrail and refreshes once acknowledged', async () => {
    api.markLost.mockRejectedValue(new ApiError({ status: 409, title: 'Conflict', code: 'asset_disposed' }))
    renderActions({ status: 'in_stock' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark lost' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Mark lost' }))

    const guardrail = await screen.findByTestId('guardrail-dialog')
    expect(guardrail.textContent).toContain('This asset has been disposed of and can no longer be changed.')
    expect(screen.queryByTestId('confirm-lost-modal')).toBeNull()
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))
    expect(onChanged).toHaveBeenCalledWith(null)
  })

  it('a 404 reloads the asset at once (the page then shows "not found")', async () => {
    await fail('Mark as received', 'ordered', new ApiError({ status: 404, title: 'Not Found' }), 'receiveAsset')

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null))
    expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
  })

  it('a 503 shows the authorization-unavailable alert and changes nothing', async () => {
    await fail('Mark as received', 'ordered', new ApiError({ status: 503, title: 'Unavailable' }), 'receiveAsset')

    const alert = await screen.findByTestId('asset-actions-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('Authorization service unavailable')
    expect(onChanged).not.toHaveBeenCalled()
    expect(focusHeading).not.toHaveBeenCalled()
  })

  it('a network failure shows the connection message, keeps the button and lets the manager try again', async () => {
    await fail('Mark as received', 'ordered', new TypeError('Failed to fetch'), 'receiveAsset')

    expect((await screen.findByTestId('asset-actions-error')).textContent).toContain('Could not reach the server')
    const retry = screen.getByRole('button', { name: 'Mark as received' })
    expect(retry.getAttribute('aria-busy')).toBeNull()

    api.receiveAsset.mockResolvedValue(asset({ status: 'in_stock' }))
    fireEvent.click(retry)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.queryByTestId('asset-actions-error')).toBeNull()
  })
})

describe('regressions the QE would look for', () => {
  it('an update that arrives while an action is in flight does not re-enable a second request', async () => {
    let resolve: (value: AssetView) => void = () => undefined
    api.receiveAsset.mockReturnValue(new Promise<AssetView>((r) => (resolve = r)))
    renderActions({ status: 'ordered' })

    fireEvent.click(screen.getByRole('button', { name: 'Mark as received' }))
    await act(async () => resolve(asset({ status: 'in_stock' })))

    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})
