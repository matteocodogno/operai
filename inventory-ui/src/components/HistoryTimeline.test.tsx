/**
 * @vitest-environment jsdom
 *
 * Component tests for HistoryTimeline (T36, specs/015-hardware-inventory; design.md
 * F13, § T2 History, § Accessibility "T2 detail"; refs AC-11.3, AC-11.4 and the
 * Resolutions G2/G9). `historyApi.getAssetHistory` is the data seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { AssetView, HistoryEvent, Identity } from '../lib/types'

const { getAssetHistory } = vi.hoisted(() => ({ getAssetHistory: vi.fn() }))
vi.mock('../lib/historyApi', () => ({ getAssetHistory }))

import HistoryTimeline from './HistoryTimeline'

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

const person = (name: string | null, status: Identity['status'] = 'active', id = 'u1'): Identity => ({
  id,
  name,
  status,
})
const ANNA = person('Anna Rossi', 'active', 'u1')
const MARCO = person('Marco Bianchi', 'active', 'u2')

const event = (id: string, at: string, over: Partial<HistoryEvent> = {}): HistoryEvent => ({
  id,
  action: 'edited',
  actor: ANNA,
  at,
  changes: [],
  ...over,
})

const MANAGER = { canManageAssets: true, canManageLedger: false }
const ACCOUNTANT = { canManageAssets: false, canManageLedger: true }

const renderTimeline = (revision = 0, a: AssetView = asset(), capabilities = MANAGER) =>
  render(<HistoryTimeline asset={a} capabilities={capabilities} revision={revision} />)

/** The timeline's own entries: the children of the `<ol>`, not the nested change lists. */
const entries = () => Array.from(timeline().children) as HTMLElement[]
const timeline = () => screen.getByTestId('history-timeline').querySelector('ol') as HTMLOListElement

beforeEach(() => {
  getAssetHistory.mockResolvedValue({ events: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HistoryTimeline — events (AC-11.3)', () => {
  it('shows a loading state with a polite announcement while the events load', async () => {
    getAssetHistory.mockReturnValue(new Promise(() => undefined))
    renderTimeline()

    expect(screen.getByRole('status').textContent).toBe('Loading history')
    expect(screen.getByTestId('skeleton-list-rows')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('requests the history of this asset', async () => {
    renderTimeline()
    await screen.findByText('No history yet.')
    expect(getAssetHistory).toHaveBeenCalledTimes(1)
    expect(getAssetHistory.mock.calls[0][0]).toBe('a1')
  })

  it('lists the events oldest first as an ordered list, whatever order the server sent them in', async () => {
    getAssetHistory.mockResolvedValue({
      events: [
        event('e3', '2026-10-03T09:00:00Z', { action: 'returned' }),
        event('e1', '2026-10-01T09:00:00Z', { action: 'registered' }),
        event('e2', '2026-10-02T09:00:00Z', { action: 'assignment_created' }),
      ],
    })
    renderTimeline()

    await screen.findByRole('list')
    expect(timeline().tagName).toBe('OL')
    expect(entries().map((item) => item.textContent)).toEqual([
      expect.stringContaining('Registered'),
      expect.stringContaining('Assignment offered'),
      expect.stringContaining('Returned'),
    ])
  })

  it('gives each entry a machine-readable time and the actor', async () => {
    getAssetHistory.mockResolvedValue({ events: [event('e1', '2026-10-01T09:00:00Z', { action: 'registered' })] })
    renderTimeline()

    const [item] = await waitFor(() => entries())
    const time = item.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe('2026-10-01T09:00:00Z')
    expect(time?.textContent).toMatch(/^\d{2}\.\d{2}\.2026, \d{2}:\d{2}$/)
    expect(item.textContent).toContain('Anna Rossi')
  })

  it('renders each change as "field: from → to"', async () => {
    getAssetHistory.mockResolvedValue({
      events: [
        event('e1', '2026-10-01T09:00:00Z', {
          changes: [
            { field: 'supplier', from: null, to: 'Digitec' },
            { field: 'toVerify', from: true, to: false },
            { field: 'purchaseDate', from: '2026-09-25', to: '2026-09-26' },
            { field: 'purchasePriceCents', from: 99815, to: 100000 },
            { field: 'status', from: 'in_stock', to: 'assigned' },
          ],
        }),
      ],
    })
    renderTimeline()

    const [item] = await waitFor(() => entries())
    expect(
      within(item)
        .getAllByRole('listitem')
        .map((change) => change.textContent),
    ).toEqual([
      'Supplier: none → Digitec',
      'To verify: Yes → No',
      'Purchase date: 25.09.2026 → 26.09.2026',
      'Purchase price: 998,15 CHF → 1000,00 CHF',
      'Status: In stock → Assigned',
    ])
  })

  it('names holder identities and labels deleted, unknown and system ones', async () => {
    getAssetHistory.mockResolvedValue({
      events: [
        event('e1', '2026-10-01T09:00:00Z', {
          action: 'returned',
          actor: person(null, 'system', 'system:seed'),
          changes: [{ field: 'holder', from: ANNA, to: null }],
        }),
        event('e2', '2026-10-02T09:00:00Z', {
          action: 'assignment_confirmed',
          actor: person(null, 'deleted', 'u9'),
          changes: [{ field: 'holder', from: null, to: MARCO }],
        }),
        event('e3', '2026-10-03T09:00:00Z', {
          action: 'returned',
          actor: person(null, 'unknown', 'u8'),
          changes: [
            { field: 'holder', from: person('Gone Person', 'deleted', 'u7'), to: person(null, 'unknown', 'u6') },
          ],
        }),
      ],
    })
    renderTimeline()

    const items = await waitFor(() => entries())
    expect(within(items[0]).getByText('Holder: Anna Rossi → none')).toBeTruthy()
    expect(items[0].textContent).toContain('System')
    expect(within(items[1]).getByText('Holder: none → Marco Bianchi')).toBeTruthy()
    expect(items[1].textContent).toContain('Deleted account')
    expect(items[2].textContent).toContain('Unknown')
    expect(within(items[2]).getByText('Holder: Gone Person (deleted account) → Unknown')).toBeTruthy()
  })

  it('labels the assignee field and renders its identities like holder values', async () => {
    getAssetHistory.mockResolvedValue({
      events: [
        event('e1', '2026-10-01T09:00:00Z', {
          action: 'assignment_created',
          changes: [{ field: 'assignee', from: null, to: MARCO }],
        }),
        event('e2', '2026-10-02T09:00:00Z', {
          action: 'assignment_declined',
          changes: [{ field: 'assignee', from: person('Gone Person', 'deleted', 'u7'), to: null }],
        }),
        event('e3', '2026-10-03T09:00:00Z', {
          action: 'assignment_cancelled',
          changes: [{ field: 'assignee', from: person(null, 'unknown', 'u6'), to: person(null, 'system', 'system:x') }],
        }),
      ],
    })
    renderTimeline()

    const items = await waitFor(() => entries())
    expect(within(items[0]).getByText('Assignee: none → Marco Bianchi')).toBeTruthy()
    expect(within(items[1]).getByText('Assignee: Gone Person (deleted account) → none')).toBeTruthy()
    expect(within(items[2]).getByText('Assignee: Unknown → System')).toBeTruthy()
  })

  it('falls back to the raw action and field names a newer server adds, never throwing', async () => {
    getAssetHistory.mockResolvedValue({
      events: [
        event('e1', '2026-10-01T09:00:00Z', {
          action: 'brand_new_action' as HistoryEvent['action'],
          changes: [{ field: 'brandNewField', from: 'a', to: 'b' }],
        }),
      ],
    })
    renderTimeline()

    const [item] = await waitFor(() => entries())
    expect(item.textContent).toContain('brand_new_action')
    expect(within(item).getByText('brandNewField: a → b')).toBeTruthy()
  })

  it('has no edit or delete control (AC-11.2)', async () => {
    getAssetHistory.mockResolvedValue({ events: [event('e1', '2026-10-01T09:00:00Z')] })
    renderTimeline()

    await screen.findByRole('list')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it.each([
    ['manager', MANAGER],
    ['accountant', ACCOUNTANT],
  ])('is shown to a %s, and for a disposed asset', async (_name, capabilities) => {
    getAssetHistory.mockResolvedValue({ events: [event('e1', '2026-10-01T09:00:00Z', { action: 'disposed' })] })
    renderTimeline(
      0,
      asset({ status: 'disposed', disposal: { disposedOn: '2026-10-01', reason: 'scrapped', salePriceCents: null } }),
      capabilities,
    )

    expect(await screen.findByRole('list')).toBeTruthy()
    expect(entries()[0].textContent).toContain('Disposed')
  })
})

describe('HistoryTimeline — states and reload', () => {
  it('shows an empty state when there are no events', async () => {
    renderTimeline()
    expect(await screen.findByText('No history yet.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows a local error with Retry, and loads again on Retry', async () => {
    getAssetHistory
      .mockRejectedValueOnce(new ApiError({ status: 500, title: 'x', detail: 'History is down.' }))
      .mockResolvedValueOnce({ events: [event('e1', '2026-10-01T09:00:00Z', { action: 'registered' })] })
    renderTimeline()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('History is down.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('list')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uses the authorization-unavailable presentation for a 503', async () => {
    getAssetHistory.mockRejectedValue(new ApiError({ status: 503, title: 'x' }))
    renderTimeline()

    expect((await screen.findByTestId('error-banner-heading')).textContent).toBe('Authorization service unavailable')
  })

  it('says it could not reach the server on a network failure', async () => {
    getAssetHistory.mockRejectedValue(new TypeError('Failed to fetch'))
    renderTimeline()

    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the server.')
  })

  it('reloads whenever revision changes, keeping the shown events until the new ones arrive', async () => {
    getAssetHistory.mockResolvedValueOnce({ events: [event('e1', '2026-10-01T09:00:00Z', { action: 'registered' })] })
    const view = renderTimeline(0)
    await screen.findByRole('list')

    let release: (value: unknown) => void = () => undefined
    getAssetHistory.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    view.rerender(<HistoryTimeline asset={asset()} capabilities={MANAGER} revision={1} />)

    await waitFor(() => expect(getAssetHistory).toHaveBeenCalledTimes(2))
    expect(entries()).toHaveLength(1)
    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()

    release({
      events: [
        event('e1', '2026-10-01T09:00:00Z', { action: 'registered' }),
        event('e2', '2026-10-02T09:00:00Z', { action: 'returned' }),
      ],
    })
    await waitFor(() => expect(entries()).toHaveLength(2))
  })

  it('does not reload when only an unrelated prop changes', async () => {
    const view = renderTimeline(3)
    await screen.findByText('No history yet.')
    view.rerender(<HistoryTimeline asset={asset({ description: 'Renamed' })} capabilities={MANAGER} revision={3} />)
    expect(getAssetHistory).toHaveBeenCalledTimes(1)
  })

  it('never shows another asset’s events while a different asset loads', async () => {
    getAssetHistory.mockResolvedValueOnce({ events: [event('e1', '2026-10-01T09:00:00Z', { action: 'registered' })] })
    const view = renderTimeline(0)
    await screen.findByRole('list')

    getAssetHistory.mockReturnValueOnce(new Promise(() => undefined))
    view.rerender(<HistoryTimeline asset={asset({ id: 'a2' })} capabilities={MANAGER} revision={0} />)

    await waitFor(() => expect(screen.getByTestId('skeleton-list-rows')).toBeTruthy())
    expect(screen.queryByRole('list')).toBeNull()
  })
})
