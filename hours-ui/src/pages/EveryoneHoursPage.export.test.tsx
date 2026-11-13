/**
 * @vitest-environment jsdom
 *
 * Everyone's hours, T30's part: the Export button in the Entries card and what a refused export does to the
 * page (specs/029-time-tracking; AC-4.3, AC-4.6, AC-4.10, AC-4.11, AC-1.6; design F5, S4). Rendered through the
 * inner router with `fakeApi` behind `apiFetch`; the real `ExportButton`, walk and builder run, and only the
 * browser seams a download crosses are faked and recorded. The button's own states are `HoursExport.test.tsx`,
 * the file's cells `hoursWorkbook.test.ts`, My hours' side of this is `MyHoursPage.export.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import type { FakePermissions } from '../test-support/fakeSession'

const { apiFetch, exceljsLoaded, permissions } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  exceljsLoaded: vi.fn(),
  permissions: { current: { epoch: 0, apps: [], roles: [], departments: [], permissions: [] } as FakePermissions },
}))
vi.mock('shell/session', async () => ({
  ...(await import('../test-support/fakeSession')).shellSessionMock(apiFetch),
  usePermissions: () => permissions.current,
}))
vi.mock('exceljs', async (importOriginal) => {
  exceljsLoaded()
  return importOriginal()
})

import { createAppRouter } from '../router'
import { strings } from '../strings'
import {
  dealItem,
  deferred,
  entriesPage,
  fakeApi,
  listsHandler,
  page,
  problem,
  requests,
} from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { EMPLOYEE, READ_ALL_HOLDER } from '../test-support/fakeSession'
import { PAGE_ONE, PAGE_TWO, entriesHandler, totalsWithPeople } from '../test-support/fixtures/everyone'
import { LISTS, TODAY_INSTANT } from '../test-support/fixtures/myHours'

const f = strings.filters
const t = strings.totals
const e = strings.entries
const x = strings.export

let api: ReturnType<typeof fakeApi>
let downloads: { name: string; href: string }[]
let blobs: Blob[]

const serveApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesHandler,
    'GET /time-entries/totals': totalsWithPeople,
    'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours/all') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-everyone-page')
}

/** The calls of the walk: the only ones that carry `limit` (the screen's own reads take the server's default). */
const walkCalls = () => requests(api, 'GET /time-entries').filter((request) => request.query['limit'] !== undefined)
const screenCalls = () => requests(api, 'GET /time-entries').filter((request) => request.query['limit'] === undefined)

const entriesCard = () => screen.getByTestId('hours-entries')
const exportButton = () => within(entriesCard()).getByRole('button', { name: x.button })
const queryExportButton = () => screen.queryByRole('button', { name: x.button })
const dealInput = () => screen.getByRole('combobox', { name: f.deal.label })

const pickDeal = async () => {
  await userEvent.type(dealInput(), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
}

const refusingTheWalk =
  (otherwise: FakeHandler): FakeHandler =>
  (url, init, params) =>
    url.searchParams.has('limit')
      ? { status: 503, body: problem(503, 'host_unavailable') }
      : otherwise(url, init, params)

const sheetOf = async (blob: Blob) => {
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
  const { default: ExcelJS } = await vi.importActual<{ default: typeof import('exceljs') }>('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)
  return workbook.worksheets[0]!
}

beforeEach(() => {
  apiFetch.mockReset()
  exceljsLoaded.mockClear()
  permissions.current = READ_ALL_HOLDER
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
  downloads = []
  blobs = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob)
      return `blob:fake-${blobs.length}`
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href })
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the Export button on Everyone’s hours (AC-4.3, AC-4.6)', () => {
  it('sits in the Entries card, beside its heading, once the entries are on screen', async () => {
    serveApi()
    await renderPage()
    await screen.findByTestId('hours-entries-table')
    expect(exportButton()).not.toBeNull()
    expect(within(screen.getByTestId('hours-filters')).queryByRole('button', { name: x.button })).toBeNull()
    expect(within(screen.getByTestId('hours-totals')).queryByRole('button', { name: x.button })).toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      f.title,
      t.title,
      e.title,
    ])
  })

  it('is not there for a person who may not see everyone’s hours: nothing is asked, so there is nothing to export', async () => {
    permissions.current = EMPLOYEE
    serveApi()
    await renderPage()
    await screen.findByTestId('hours-permission-denied')
    expect(queryExportButton()).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('is not there when no entry matches', async () => {
    serveApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([]) }) })
    await renderPage()
    await screen.findByTestId('hours-entries-empty')
    expect(queryExportButton()).toBeNull()
  })

  it('is not there while the entries load, and the page does not load the spreadsheet library by being shown', async () => {
    const slow = deferred<FakeAnswer>()
    serveApi({ 'GET /time-entries': () => slow.promise })
    await renderPage()
    await screen.findByTestId('hours-entries-skeleton')
    expect(queryExportButton()).toBeNull()
    slow.resolve({ status: 200, body: PAGE_TWO })
    await screen.findByTestId('hours-entries-table')
    expect(exportButton()).not.toBeNull()
    expect(exceljsLoaded).not.toHaveBeenCalled()
  })

  it('exports everyone’s entries: whose=all, the Person filter, every page, limit=500, one file named from the period', async () => {
    serveApi()
    await renderPage('/hours/all?period=custom&from=2026-10-05&to=2026-10-11&person=u-ada')
    await screen.findByTestId('hours-entries-table')
    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))

    expect(screenCalls()).toHaveLength(1)
    expect(walkCalls().map((request) => request.query['cursor'])).toEqual([undefined, 'cursor-2'])
    for (const request of walkCalls()) {
      expect(request.query).toMatchObject({
        whose: 'all',
        userId: 'u-ada',
        from: '2026-10-05',
        to: '2026-10-11',
        limit: '500',
      })
    }
    expect(downloads[0]!.name).toBe('hours-2026-10-05_2026-10-11.xlsx')

    const sheet = await sheetOf(blobs[0]!)
    expect(sheet.rowCount).toBe(1 + PAGE_ONE.items.length + PAGE_TWO.items.length)
    // The person column is the screen's own naming, a deactivated account included.
    const people = Array.from({ length: sheet.rowCount - 1 }, (_, index) => sheet.getRow(index + 2).getCell(2).value)
    expect(people).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Unknown user (deactivated)',
      'Unknown user',
      'Ada Lovelace',
    ])
  })

  it('says the file is ready with names missing when a page could not ask a source (AC-4.7)', async () => {
    serveApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit')
          ? { status: 200, body: { ...PAGE_TWO, unavailable: ['identities'] } }
          : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-entries-table')
    await userEvent.click(exportButton())
    await waitFor(() => expect(screen.getByTestId('hours-export-status').textContent).toBe(x.readyNamesMissing))
  })

  it('a refusal of the grant on the export is the button’s alert; the view is left as it is', async () => {
    serveApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit')
          ? { status: 403, body: problem(403, 'read_all_required') }
          : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-entries-table')
    await userEvent.click(exportButton())
    expect((await screen.findByTestId('hours-export-error')).textContent).toBe(x.failed)
    expect(downloads).toHaveLength(0)
    expect(screen.getByTestId('hours-entries-table')).not.toBeNull()
  })
})

describe('an export refused because Meetings cannot say which meetings belong to the deal (AC-4.11, D45)', () => {
  const blocker = () => screen.getByTestId('hours-deal-filter-unavailable')

  const exportUnderDeal = async (overrides: Parameters<typeof fakeApi>[0] = {}) => {
    serveApi({ 'GET /time-entries': refusingTheWalk(entriesHandler), ...overrides })
    await renderPage()
    await screen.findByTestId('hours-entries-table')
    await pickDeal()
    await waitFor(() => expect(screenCalls().length).toBe(2))
    await screen.findByTestId('hours-entries-table')
    // By keyboard: a mouse press on a library button leaves focus in the field the person was in, and it is
    // the key that leaves the focus ON the button, which is what the refusal then takes away.
    exportButton().focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByTestId('hours-deal-filter-unavailable')
  }

  it('switches the page to the one deal-filter-unavailable state: the button, Totals and Entries are gone', async () => {
    await exportUnderDeal()
    expect(blocker().getAttribute('role')).toBe('alert')
    expect(within(blocker()).getByText(e.dealFilterUnavailable.title)).not.toBeNull()
    expect(queryExportButton()).toBeNull()
    expect(screen.queryByTestId('hours-totals')).toBeNull()
    expect(screen.queryByTestId('hours-entries')).toBeNull()
    expect(screen.queryByTestId('hours-entries-table')).toBeNull()
    expect(screen.queryByTestId('hours-export-error')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(downloads).toHaveLength(0)
    expect(blobs).toHaveLength(0)
    expect(exceljsLoaded).not.toHaveBeenCalled()
    expect((dealInput() as HTMLInputElement).value).toBe('Acme renewal')
  })

  it('takes focus: the Export button that had it is gone', async () => {
    await exportUnderDeal()
    await waitFor(() => expect(document.activeElement).toBe(blocker()))
  })

  it('Retry asks every read again, and the old refusal does not come back: the view is shown and the export works', async () => {
    let healthy = false
    await exportUnderDeal({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit') && !healthy
          ? { status: 503, body: problem(503, 'host_unavailable') }
          : entriesHandler(url, init, params),
    })
    healthy = true
    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    const heading = await screen.findByRole('heading', { level: 3, name: t.title })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(await screen.findByTestId('hours-entries-table')).not.toBeNull()
    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))
  })

  it('"Clear the deal filter" shows the view without it, and choosing the same deal again is not blocked by the old refusal', async () => {
    await exportUnderDeal()
    await userEvent.click(within(blocker()).getByRole('button', { name: e.dealFilterUnavailable.clear }))
    await screen.findByTestId('hours-entries-table')
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()

    await pickDeal()
    await waitFor(() => expect(screenCalls().length).toBe(4))
    expect(await screen.findByTestId('hours-entries-table')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(exportButton()).not.toBeNull()
  })

  it('a refusal that arrives after the person changed the filters does not block the view they changed to', async () => {
    const slow = deferred<FakeAnswer>()
    serveApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit') ? slow.promise : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-entries-table')
    await pickDeal()
    await screen.findByTestId('hours-entries-table')
    await userEvent.click(exportButton())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'tc-formazione')
    await waitFor(() => expect(screenCalls().length).toBe(3))
    await screen.findByTestId('hours-entries-table')

    await act(async () => {
      slow.resolve({ status: 503, body: problem(503, 'host_unavailable') })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(screen.getByTestId('hours-entries-table')).not.toBeNull()
  })
})
