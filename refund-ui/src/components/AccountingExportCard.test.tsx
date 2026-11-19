/**
 * @vitest-environment jsdom
 *
 * AccountingExportCard (T30, specs/20261118-refund-accounting-export, design S10, F9, UX-6, UX-7, UX-9, UX-12; AC-6.1, AC-6.5,
 * AC-6.6, AC-6.7, AC-6.9, AC-6.11, AC-7.2): the ready, header-only, blocked, out-of-scope, loading and failed
 * states, the blockers and where they link, a Download that is `aria-disabled` with its reason, the Blob download
 * under a client-built filename, a 409 during the download, a failed download and a double press.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expectNoAxeViolations } from '../test-support/axe'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import type { Permission, PermissionsResult } from 'shell/session'

vi.mock('../lib/accountingExportApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/accountingExportApi')>()
  return { ...original, getAccountingExport: vi.fn(), downloadAccountingCsv: vi.fn() }
})

const { usePermissionsMock } = vi.hoisted(() => ({ usePermissionsMock: vi.fn<() => PermissionsResult>() }))
vi.mock('shell/session', () => ({ usePermissions: () => usePermissionsMock() }))

import * as exportApi from '../lib/accountingExportApi'
import type { AccountingExportSummary, ExportBlockers } from '../lib/accountingExportApi'
import { ApiError } from '../lib/refundApi'
import AccountingExportCard from './AccountingExportCard'

const permissionsWith = (...permissions: Permission[]): PermissionsResult => ({
  epoch: 0,
  apps: ['refund'],
  roles: [],
  departments: [],
  permissions,
})
const SETTINGS_READ: Permission = { resource: 'settings', action: 'read' }

const NO_BLOCKERS: ExportBlockers = { missingRates: [], unclassifiedLines: [], unnumberedLines: [] }

const summary = (overrides: Partial<AccountingExportSummary> = {}): AccountingExportSummary => ({
  batchId: 'batch-1',
  batchStatus: 'compiled',
  exportable: true,
  rowCount: 12,
  excludedLineCount: 0,
  blockers: NO_BLOCKERS,
  fetchAttempted: false,
  ...overrides,
})

const BLOCKED = summary({
  exportable: false,
  rowCount: 0,
  blockers: {
    missingRates: [
      { currency: 'EUR', month: '2026-03' },
      { currency: 'USD', month: '2026-03' },
    ],
    unclassifiedLines: [
      {
        lineId: 'l1',
        requestId: 'req-9',
        date: '2026-03-19',
        type: 'travel_train',
        employee: 'Matteo Codogno',
        receiptNumber: 'MC26/014',
        missing: ['vatCode'],
      },
    ],
    unnumberedLines: [],
  },
})

const problem = (status: number, code?: string, extras?: Record<string, unknown>) =>
  new ApiError({ type: 't', title: 'x', status, code }, extras)

const pending = <T,>() => new Promise<T>(() => {})

const clickSpy = vi.fn()
let downloadName = ''

beforeEach(() => {
  usePermissionsMock.mockReturnValue(permissionsWith(SETTINGS_READ))
  vi.mocked(exportApi.getAccountingExport).mockResolvedValue(summary())
  URL.createObjectURL = vi.fn(() => 'blob:csv')
  URL.revokeObjectURL = vi.fn()
  clickSpy.mockReset()
  downloadName = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloadName = this.download
    clickSpy(this.href)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

const renderCard = async (onBatchDiscarded = vi.fn(), waitForLoad = true) => {
  window.history.pushState(null, '', '/')
  const rootRoute = createRootRoute()
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <AccountingExportCard batchId="batch-1" cutoff="2026-07-19T00:00:00.000Z" onBatchDiscarded={onBatchDiscarded} />
    ),
  })
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => null,
    validateSearch: (search: Record<string, unknown>): { section?: string; month?: string } => ({
      section: typeof search.section === 'string' ? search.section : undefined,
      month: typeof search.month === 'string' ? search.month : undefined,
    }),
  })
  const review = createRoute({ getParentRoute: () => rootRoute, path: '/review/$id', component: () => null })
  const router = createRouter({ routeTree: rootRoute.addChildren([index, settings, review]) })
  render(<RouterProvider router={router} />)
  await screen.findByTestId('accounting-export-card')
  if (waitForLoad) await waitFor(() => expect(screen.queryByTestId('accounting-export-skeleton')).toBeNull())
  return { onBatchDiscarded }
}

const download = () => screen.getByTestId('accounting-export-download') as HTMLButtonElement

describe('AccountingExportCard: loading and failing', () => {
  it('shows a polite loading line and a skeleton while the check runs, with no button yet', async () => {
    vi.mocked(exportApi.getAccountingExport).mockReturnValue(pending())
    await renderCard(vi.fn(), false)
    expect(screen.getByText('Checking the export…').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('accounting-export-skeleton')).not.toBeNull()
    expect(screen.queryByTestId('accounting-export-download')).toBeNull()
  })

  it('shows a retryable error when the check fails', async () => {
    vi.mocked(exportApi.getAccountingExport).mockRejectedValueOnce(problem(500))
    await renderCard()
    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not check the export.')
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByTestId('accounting-export-ready')
    expect(exportApi.getAccountingExport).toHaveBeenCalledTimes(2)
  })

  it('says the export is for WellD CH reviewers, with no button, on a 403 (AC-6.11)', async () => {
    vi.mocked(exportApi.getAccountingExport).mockRejectedValue(problem(403, 'accounting_export_out_of_scope'))
    await renderCard()
    expect((await screen.findByTestId('accounting-export-denied')).textContent).toBe(
      'The accounting export is available to reviewers with WellD CH access.',
    )
    expect(screen.queryByTestId('accounting-export-download')).toBeNull()
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('tells the page when the batch turns out to be discarded, and renders nothing (AC-6.9)', async () => {
    vi.mocked(exportApi.getAccountingExport).mockRejectedValue(problem(409, 'batch_discarded'))
    const onBatchDiscarded = vi.fn()
    window.history.pushState(null, '', '/')
    const { container } = render(
      <AccountingExportCard batchId="batch-1" cutoff="2026-07-19T00:00:00.000Z" onBatchDiscarded={onBatchDiscarded} />,
    )
    await waitFor(() => expect(onBatchDiscarded).toHaveBeenCalledTimes(1))
    expect(container.innerHTML).toBe('')
  })
})

describe('AccountingExportCard: ready', () => {
  it('says how many rows will be exported, offers Download, and stays quiet about WellD Italia when none (AC-6.1, G12)', async () => {
    await renderCard()
    expect(screen.getByRole('heading', { name: 'Accounting export' })).not.toBeNull()
    expect(screen.getByTestId('accounting-export-ready').textContent).toBe('12 rows will be exported.')
    expect(screen.queryByTestId('accounting-export-excluded')).toBeNull()
    expect(download().textContent).toBe('Download CSV')
    expect(download().getAttribute('aria-disabled')).toBeNull()
  })

  it('says one row in the singular', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(summary({ rowCount: 1 }))
    await renderCard()
    expect(screen.getByTestId('accounting-export-ready').textContent).toBe('1 row will be exported.')
  })

  it('states how many WellD Italia lines are left out, only above zero (AC-6.6)', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(summary({ excludedLineCount: 3 }))
    await renderCard()
    expect(screen.getByTestId('accounting-export-excluded').textContent).toBe(
      '3 WellD Italia lines are left out: the export covers WellD CH only.',
    )
  })

  it('says the file will hold only the header row when there are no lines, and still offers Download (AC-6.7)', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(summary({ rowCount: 0, excludedLineCount: 2 }))
    await renderCard()
    const ready = screen.getByTestId('accounting-export-ready')
    expect(ready.textContent).toContain(
      'There are no approved WellD CH lines in this batch. The file will contain only the header row.',
    )
    expect(ready.textContent).not.toContain('0 rows')
    expect(ready.textContent).toContain('2 WellD Italia lines are left out')
    expect(download().getAttribute('aria-disabled')).toBeNull()
  })
})

describe('AccountingExportCard: blocked (UX-6, UX-7)', () => {
  beforeEach(() => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(BLOCKED)
  })

  it('is a warning, not an error, that says the batch can still be paid or discarded (AC-6.5)', async () => {
    await renderCard()
    const banner = screen.getByTestId('accounting-export-blocked')
    expect(banner.textContent).toContain('The export is blocked')
    expect(banner.textContent).toContain('You can still pay or discard this batch.')
    expect(banner.getAttribute('role')).toBe('note')
    expect(screen.queryByTestId('error-banner')).toBeNull()
    expect(screen.queryByTestId('accounting-export-ready')).toBeNull()
  })

  it('lists each missing rate with its month in words, linking to that month in Settings with settings:read', async () => {
    await renderCard()
    const list = screen.getByTestId('accounting-export-missing-rates')
    expect(within(list).getByText('Missing exchange rates')).not.toBeNull()
    expect(within(list).getByText('EUR · March 2026')).not.toBeNull()
    expect(within(list).getByText('USD · March 2026')).not.toBeNull()
    const links = within(list).getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0].getAttribute('href')).toBe('/settings?section=exchange-rates&month=2026-03')
    expect(links[0].getAttribute('aria-label')).toBe('Open exchange rates: EUR · March 2026')
    expect(within(list).queryByText('Ask an administrator to enter or fetch it.')).toBeNull()
  })

  it('without settings:read there is no link, and it says to ask an administrator', async () => {
    usePermissionsMock.mockReturnValue(permissionsWith())
    await renderCard()
    const list = screen.getByTestId('accounting-export-missing-rates')
    expect(within(list).queryByRole('link')).toBeNull()
    expect(within(list).getByText('Ask an administrator to enter or fetch it.')).not.toBeNull()
    expect(within(list).getByText('EUR · March 2026')).not.toBeNull()
  })

  it('lists a line without an account or VAT code with its employee, receipt and what is missing, and links to the request (AC-7.2)', async () => {
    await renderCard()
    const list = screen.getByTestId('accounting-export-unclassified')
    expect(within(list).getByText('Matteo Codogno · MC26/014: no VAT code')).not.toBeNull()
    const link = within(list).getByRole('link', { name: /Open request/ })
    expect(link.getAttribute('href')).toBe('/review/req-9')
    expect(link.getAttribute('aria-label')).toBe('Open request: Matteo Codogno · MC26/014: no VAT code')
  })

  it('links to the request even without settings:read', async () => {
    usePermissionsMock.mockReturnValue(permissionsWith())
    await renderCard()
    expect(
      within(screen.getByTestId('accounting-export-unclassified')).getByRole('link', { name: /Open request/ }),
    ).not.toBeNull()
  })

  it('names a line with no receipt number yet by its date and type, and says "account or VAT code" when both are missing', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(
      summary({
        exportable: false,
        blockers: {
          ...NO_BLOCKERS,
          unclassifiedLines: [
            {
              lineId: 'l2',
              requestId: 'req-2',
              date: '2026-03-19',
              type: 'travel_train',
              employee: 'Anna',
              receiptNumber: null,
              missing: ['account', 'vatCode'],
            },
          ],
        },
      }),
    )
    await renderCard()
    expect(screen.getByTestId('accounting-export-unclassified').textContent).toMatch(
      /Anna · 19\.03\.2026 .+: no account or VAT code/,
    )
  })

  it('says "Contact an administrator." for an unnumbered line, and that the fetch was tried only when it was', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(
      summary({
        exportable: false,
        fetchAttempted: true,
        blockers: { ...NO_BLOCKERS, unnumberedLines: [{ lineId: 'l3', requestId: 'req-3', employee: 'Bea' }] },
      }),
    )
    await renderCard()
    expect(screen.getByTestId('accounting-export-unnumbered').textContent).toContain('Contact an administrator.')
    expect(screen.getByTestId('accounting-export-fetch-tried').textContent).toBe(
      'Refund just tried to fetch the missing rates from the official source.',
    )
    cleanup()
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(BLOCKED)
    await renderCard()
    expect(screen.queryByTestId('accounting-export-fetch-tried')).toBeNull()
    expect(screen.queryByTestId('accounting-export-unnumbered')).toBeNull()
  })

  it('keeps Download on screen, aria-disabled, with the reason as its description, and a press does nothing', async () => {
    await renderCard()
    const button = download()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.disabled).toBe(false)
    const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe('The export is blocked. See the items above.')
    fireEvent.click(button)
    expect(exportApi.downloadAccountingCsv).not.toHaveBeenCalled()
  })

  it('Check again loads the summary again, busy meanwhile, and shows the new answer', async () => {
    await renderCard()
    let resolve!: (value: AccountingExportSummary) => void
    vi.mocked(exportApi.getAccountingExport).mockReturnValueOnce(new Promise((r) => (resolve = r)))
    fireEvent.click(screen.getByTestId('accounting-export-check-again'))
    await waitFor(() => expect(screen.getByTestId('accounting-export-check-again').getAttribute('aria-busy')).toBe('true'))
    // A second press while it runs is ignored.
    fireEvent.click(screen.getByTestId('accounting-export-check-again'))
    expect(exportApi.getAccountingExport).toHaveBeenCalledTimes(2)

    await act(async () => resolve(summary({ rowCount: 5 })))
    expect((await screen.findByTestId('accounting-export-ready')).textContent).toBe('5 rows will be exported.')
    expect(download().getAttribute('aria-disabled')).toBeNull()
  })
})

describe('AccountingExportCard: the result of Check again (A-3)', () => {
  const result = () => screen.getByTestId('accounting-export-recheck-result')
  beforeEach(() => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(BLOCKED)
  })

  it('when it becomes ready, announces the result politely and moves focus to Download', async () => {
    await renderCard()
    vi.mocked(exportApi.getAccountingExport).mockResolvedValueOnce(summary({ rowCount: 12 }))
    const button = screen.getByTestId('accounting-export-check-again')
    button.focus()
    fireEvent.click(button)

    await waitFor(() => expect(screen.queryByTestId('accounting-export-blocked')).toBeNull())
    expect(result().textContent).toBe('The export is ready: 12 rows.')
    expect(result().getAttribute('aria-live')).toBe('polite')
    expect(document.activeElement).toBe(download())
  })

  it('when it is still blocked, announces how many items remain and keeps focus on Check again', async () => {
    await renderCard()
    const button = screen.getByTestId('accounting-export-check-again')
    button.focus()
    fireEvent.click(button)

    await waitFor(() => expect(result().textContent).toBe('Still blocked: 3 items.'))
    expect(document.activeElement).toBe(screen.getByTestId('accounting-export-check-again'))
  })

  it('says "1 item" for a single blocker and "1 row" for a single row', async () => {
    await renderCard()
    vi.mocked(exportApi.getAccountingExport).mockResolvedValueOnce(
      summary({
        exportable: false,
        blockers: { ...NO_BLOCKERS, missingRates: [{ currency: 'EUR', month: '2026-03' }] },
      }),
    )
    fireEvent.click(screen.getByTestId('accounting-export-check-again'))
    await waitFor(() => expect(result().textContent).toBe('Still blocked: 1 item.'))
    vi.mocked(exportApi.getAccountingExport).mockResolvedValueOnce(summary({ rowCount: 1 }))
    fireEvent.click(screen.getByTestId('accounting-export-check-again'))
    await waitFor(() => expect(result().textContent).toBe('The export is ready: 1 row.'))
  })

  it('announces nothing on first load, and the region is empty until a recheck finishes', async () => {
    await renderCard()
    expect(result().textContent).toBe('')
  })
})

describe('AccountingExportCard: downloading (UX-12)', () => {
  it('saves the Blob the API returned under refund-accounting-<cutoff>-<id>.csv, releases the handle, and confirms', async () => {
    const blob = new Blob(['﻿Employee;Receipt number\r\n'], { type: 'text/csv' })
    vi.mocked(exportApi.downloadAccountingCsv).mockResolvedValue(blob)
    await renderCard()
    fireEvent.click(download())

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1))
    expect(exportApi.downloadAccountingCsv).toHaveBeenCalledWith('batch-1')
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
    expect(downloadName).toBe('refund-accounting-2026-07-19-batch-1.csv')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv')
    expect((await screen.findByTestId('accounting-export-downloaded')).textContent).toBe('Export downloaded: 12 rows')
  })

  it('is busy while it runs and ignores a second press, so one click writes one log row (AC-6.10)', async () => {
    let resolve!: (blob: Blob) => void
    vi.mocked(exportApi.downloadAccountingCsv).mockReturnValue(new Promise((r) => (resolve = r)))
    await renderCard()
    fireEvent.click(download())
    await waitFor(() => expect(download().textContent).toBe('Preparing file…'))
    expect(download().getAttribute('aria-busy')).toBe('true')
    fireEvent.click(download())
    fireEvent.click(download())
    expect(exportApi.downloadAccountingCsv).toHaveBeenCalledTimes(1)

    await act(async () => resolve(new Blob(['x'])))
    await waitFor(() => expect(download().textContent).toBe('Download CSV'))
  })

  it('a 409 blocked switches to Blocked from the body of the answer, with an alert, and no file', async () => {
    const body = {
      batchId: 'batch-1',
      batchStatus: 'compiled',
      rowCount: 0,
      excludedLineCount: 0,
      fetchAttempted: false,
      blockers: { missingRates: [{ currency: 'GBP', month: '2026-02' }], unclassifiedLines: [], unnumberedLines: [] },
    }
    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(problem(409, 'accounting_export_blocked', body))
    await renderCard()
    fireEvent.click(download())

    expect((await screen.findByTestId('accounting-export-turned-blocked')).textContent).toBe(
      'The export became blocked while you were downloading. See the items below.',
    )
    expect(screen.getByTestId('accounting-export-turned-blocked').getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('accounting-export-blocked')).not.toBeNull()
    expect(within(screen.getByTestId('accounting-export-missing-rates')).getByText('GBP · February 2026')).not.toBeNull()
    expect(download().getAttribute('aria-disabled')).toBe('true')
    expect(clickSpy).not.toHaveBeenCalled()
    // The body was enough: no second request for the summary.
    expect(exportApi.getAccountingExport).toHaveBeenCalledTimes(1)
  })

  it('a 409 blocked with an unreadable body still blocks, and checks again', async () => {
    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(problem(409, 'accounting_export_blocked', {}))
    await renderCard()
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(BLOCKED)
    fireEvent.click(download())

    await screen.findByTestId('accounting-export-turned-blocked')
    await waitFor(() => expect(screen.getByTestId('accounting-export-missing-rates')).not.toBeNull())
    expect(exportApi.getAccountingExport).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('accounting-export-turned-blocked')).not.toBeNull()
  })

  it('a 500 is "No file was produced", with Download still there to try again', async () => {
    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(problem(500))
    await renderCard()
    fireEvent.click(download())

    const alert = await screen.findByTestId('accounting-export-download-error')
    expect(alert.textContent).toBe('No file was produced. Try again.')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(clickSpy).not.toHaveBeenCalled()
    expect(screen.queryByTestId('accounting-export-downloaded')).toBeNull()
    expect(download().getAttribute('aria-disabled')).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('a network failure is the same: no file was produced', async () => {
    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(new TypeError('Failed to fetch'))
    await renderCard()
    fireEvent.click(download())
    expect((await screen.findByTestId('accounting-export-download-error')).textContent).toBe(
      'No file was produced. Try again.',
    )
  })

  it('a 409 batch_discarded during the download tells the page', async () => {
    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(problem(409, 'batch_discarded'))
    const { onBatchDiscarded } = await renderCard()
    fireEvent.click(download())
    await waitFor(() => expect(onBatchDiscarded).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('accounting-export-download-error')).toBeNull()
  })

  it('a 403 during the download turns the card into the out-of-scope note', async () => {
    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(problem(403, 'accounting_export_out_of_scope'))
    await renderCard()
    fireEvent.click(download())
    await screen.findByTestId('accounting-export-denied')
    expect(screen.queryByTestId('accounting-export-download')).toBeNull()
  })
})

// T44: automated axe checks (test-support/axe.ts) on every state of the card, whole document so nothing is left out.
describe('AccountingExportCard: accessibility (axe)', () => {
  it('has no violations: loading, a failed check, the out-of-scope note', async () => {
    vi.mocked(exportApi.getAccountingExport).mockReturnValueOnce(pending())
    await renderCard(vi.fn(), false)
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(exportApi.getAccountingExport).mockRejectedValueOnce(problem(500))
    await renderCard()
    await screen.findByTestId('error-banner')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(exportApi.getAccountingExport).mockRejectedValue(problem(403, 'accounting_export_out_of_scope'))
    await renderCard()
    await screen.findByTestId('accounting-export-denied')
    await expectNoAxeViolations()
  })

  it.each([
    ['ready', summary()],
    ['ready, one row', summary({ rowCount: 1 })],
    ['ready, WellD Italia lines left out', summary({ excludedLineCount: 3 })],
    ['ready, header row only', summary({ rowCount: 0, excludedLineCount: 2 })],
  ])('has no violations: %s', async (_name, value) => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(value)
    await renderCard()
    await expectNoAxeViolations()
  })

  it('has no violations: blocked, with missing rates and unclassified lines, with and without settings:read', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(BLOCKED)
    await renderCard()
    await expectNoAxeViolations()
    cleanup()

    usePermissionsMock.mockReturnValue(permissionsWith())
    await renderCard()
    await expectNoAxeViolations()
  })

  it('has no violations: blocked with every kind of blocker, and the fetch note', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(
      summary({
        exportable: false,
        fetchAttempted: true,
        blockers: {
          missingRates: BLOCKED.blockers.missingRates,
          unclassifiedLines: [
            ...BLOCKED.blockers.unclassifiedLines,
            {
              lineId: 'l2',
              requestId: 'req-2',
              date: '2026-03-19',
              type: 'travel_train',
              employee: 'Anna',
              receiptNumber: null,
              missing: ['account', 'vatCode'],
            },
          ],
          unnumberedLines: [{ lineId: 'l3', requestId: 'req-3', employee: 'Bea' }],
        },
      }),
    )
    await renderCard()
    await screen.findByTestId('accounting-export-unnumbered')
    await expectNoAxeViolations()
  })

  it('has no violations: Check again busy, and its result when ready and when still blocked', async () => {
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(BLOCKED)
    await renderCard()
    vi.mocked(exportApi.getAccountingExport).mockReturnValueOnce(pending())
    fireEvent.click(screen.getByTestId('accounting-export-check-again'))
    await waitFor(() => expect(screen.getByTestId('accounting-export-check-again').getAttribute('aria-busy')).toBe('true'))
    await expectNoAxeViolations()
    cleanup()

    await renderCard()
    fireEvent.click(screen.getByTestId('accounting-export-check-again'))
    await waitFor(() => expect(screen.getByTestId('accounting-export-recheck-result').textContent).toBe('Still blocked: 3 items.'))
    await expectNoAxeViolations()
    cleanup()

    await renderCard()
    vi.mocked(exportApi.getAccountingExport).mockResolvedValueOnce(summary({ rowCount: 12 }))
    fireEvent.click(screen.getByTestId('accounting-export-check-again'))
    await waitFor(() => expect(screen.getByTestId('accounting-export-recheck-result').textContent).toBe('The export is ready: 12 rows.'))
    await expectNoAxeViolations()
  })

  it('has no violations: downloading (busy), downloaded, no file produced, and became blocked', async () => {
    vi.mocked(exportApi.downloadAccountingCsv).mockReturnValueOnce(pending())
    await renderCard()
    fireEvent.click(download())
    await waitFor(() => expect(download().textContent).toBe('Preparing file…'))
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(exportApi.downloadAccountingCsv).mockResolvedValue(new Blob(['x'], { type: 'text/csv' }))
    await renderCard()
    fireEvent.click(download())
    await screen.findByTestId('accounting-export-downloaded')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(problem(500))
    await renderCard()
    fireEvent.click(download())
    await screen.findByTestId('accounting-export-download-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(exportApi.downloadAccountingCsv).mockRejectedValue(
      problem(409, 'accounting_export_blocked', {
        batchId: 'batch-1',
        batchStatus: 'compiled',
        rowCount: 0,
        excludedLineCount: 0,
        fetchAttempted: false,
        blockers: { missingRates: [{ currency: 'GBP', month: '2026-02' }], unclassifiedLines: [], unnumberedLines: [] },
      }),
    )
    await renderCard()
    fireEvent.click(download())
    await screen.findByTestId('accounting-export-turned-blocked')
    await expectNoAxeViolations()
  })
})
