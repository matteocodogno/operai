/**
 * @vitest-environment jsdom
 *
 * My hours, T30's part: the Export button in the Entries card and what a refused export does to the page
 * (specs/20261112-time-tracking; AC-4.6, AC-4.10, AC-4.11; design F5, S1). Rendered through the inner router with
 * `fakeApi` behind `apiFetch`; the real `ExportButton`, walk and builder run, and only the browser seams a
 * download crosses are faked and recorded. The button's own states are `HoursExport.test.tsx`, the file's
 * cells `hoursWorkbook.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch, exceljsLoaded } = vi.hoisted(() => ({ apiFetch: vi.fn(), exceljsLoaded: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))
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
  projectItem,
  requests,
} from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { PAGE_ONE, PAGE_TWO, entriesHandler, totalsWithDays } from '../test-support/fixtures/entries'
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
    'GET /time-entries/totals': totalsWithDays,
    'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours?view=list') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-my-page')
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
const projectInput = () => screen.getByRole('combobox', { name: f.project.label })

const pickProject = async () => {
  await userEvent.type(projectInput(), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
}

/** 503 `host_unavailable` for the walk only (Meetings went down after the view was read). */
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

describe('the Export button (AC-4.6)', () => {
  it('sits in the Entries card, beside its heading, once the entries are on screen', async () => {
    serveApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')
    expect(exportButton()).not.toBeNull()
    expect(queryExportButton()).toBe(exportButton())
    // Not in the Filters or the Totals card, and the heading outline is the one of before it.
    expect(within(screen.getByTestId('hours-filters')).queryByRole('button', { name: x.button })).toBeNull()
    expect(within(screen.getByTestId('hours-totals')).queryByRole('button', { name: x.button })).toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      f.title,
      t.title,
      e.title,
    ])
  })

  it('is not there while the entries load, and the page does not load the spreadsheet library by being shown', async () => {
    const slow = deferred<FakeAnswer>()
    serveApi({ 'GET /time-entries': () => slow.promise })
    await renderPage()
    await screen.findByTestId('hours-entries-skeleton')
    expect(queryExportButton()).toBeNull()
    slow.resolve({ status: 200, body: PAGE_TWO })
    await screen.findByTestId('hours-day-list')
    expect(exportButton()).not.toBeNull()
    expect(exceljsLoaded).not.toHaveBeenCalled()
  })

  it('is not there when the view has no entries (the empty state, filtered or not)', async () => {
    serveApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([]) }) })
    await renderPage()
    await screen.findByTestId('hours-entries-empty')
    expect(queryExportButton()).toBeNull()
  })

  it('is not there when the entries could not be loaded', async () => {
    serveApi({ 'GET /time-entries': () => ({ status: 500, body: problem(500) }) })
    await renderPage()
    await screen.findByTestId('hours-entries-error')
    expect(queryExportButton()).toBeNull()
  })

  it('is not there for a Custom range that cannot be sent: nothing is asked and there is nothing to export', async () => {
    serveApi()
    await renderPage('/hours?view=list&period=custom&from=2026-11-10&to=2026-11-01')
    await screen.findByTestId('hours-entries-invalid')
    expect(queryExportButton()).toBeNull()
  })

  it('exports every page of the filters the view applies, with limit=500, as one file named from the period', async () => {
    serveApi()
    await renderPage('/hours?view=list&period=custom&from=2026-10-05&to=2026-10-11&category=tc-formazione')
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))

    // The screen read the first page without a size; the walk is two requests of 500 for the same filters.
    expect(screenCalls()).toHaveLength(1)
    expect(walkCalls().map((request) => request.query['cursor'])).toEqual([undefined, 'cursor-2'])
    for (const request of walkCalls()) {
      expect(request.query).toMatchObject({
        whose: 'mine',
        from: '2026-10-05',
        to: '2026-10-11',
        categoryId: 'tc-formazione',
        limit: '500',
      })
    }
    expect(downloads[0]!.name).toBe('hours-2026-10-05_2026-10-11.xlsx')
    // Both pages of the fixture, in order: 2 + 3 entries and the header.
    const sheet = await sheetOf(blobs[0]!)
    expect(sheet.rowCount).toBe(1 + PAGE_ONE.items.length + PAGE_TWO.items.length)
    expect(screen.getByTestId('hours-export-status').textContent).toBe(x.ready)
  })

  it('exports the project the person picked as a filter, and the deal', async () => {
    serveApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await waitFor(() => expect(screenCalls().length).toBe(2))
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(walkCalls()[0]!.query['dealId']).toBe('d1')
  })

  it('exports the Recorded on the view applies (T44, D52): every page of the walk carries target, the one now chosen and not a stale one', async () => {
    serveApi()
    await renderPage('/hours?view=list&target=meeting')
    await screen.findByTestId('hours-day-list')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.recordedOn.label }), 'Other work')
    await waitFor(() => expect(screenCalls().at(-1)!.query['target']).toBe('none'))
    await screen.findByTestId('hours-day-list')

    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))

    expect(walkCalls().map((request) => request.query['cursor'])).toEqual([undefined, 'cursor-2'])
    for (const request of walkCalls()) {
      expect(request.query).toMatchObject({ whose: 'mine', target: 'none', limit: '500' })
    }
  })

  it('with Recorded on at All the walk sends no target', async () => {
    serveApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))
    for (const request of walkCalls()) expect(request.query).not.toHaveProperty('target')
  })

  it('shows the button’s own alert, and keeps the page as it is, when the export fails', async () => {
    serveApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit') ? { status: 500, body: problem(500) } : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    expect((await screen.findByTestId('hours-export-error')).textContent).toBe(x.failed)
    expect(downloads).toHaveLength(0)
    expect(screen.getByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
  })
})

describe('an export refused because Meetings cannot say which meetings belong to the deal (AC-4.11, D45)', () => {
  const blocker = () => screen.getByTestId('hours-deal-filter-unavailable')

  const exportUnderDeal = async (overrides: Parameters<typeof fakeApi>[0] = {}) => {
    serveApi({ 'GET /time-entries': refusingTheWalk(entriesHandler), ...overrides })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await waitFor(() => expect(screenCalls().length).toBe(2))
    await screen.findByTestId('hours-day-list')
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
    expect(screen.queryByTestId('hours-day-list')).toBeNull()
    expect(screen.queryByTestId('hours-export-error')).toBeNull()
    // One alert, and it is the banner's: the export adds none of its own.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(downloads).toHaveLength(0)
    expect(blobs).toHaveLength(0)
    expect(exceljsLoaded).not.toHaveBeenCalled()
    // The filter stays picked, so the person can see which one to clear.
    expect((dealInput() as HTMLInputElement).value).toBe('Acme renewal')
  })

  it('takes focus: the Export button that had it is gone', async () => {
    await exportUnderDeal()
    await waitFor(() => expect(document.activeElement).toBe(blocker()))
  })

  it('does not take focus from a person who has gone on to another control while the export ran', async () => {
    const slow = deferred<FakeAnswer>()
    serveApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit') ? slow.promise : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    const clear = screen.getByRole('button', { name: f.clear })
    clear.focus()
    slow.resolve({ status: 503, body: problem(503, 'host_unavailable') })
    // Only focus moved, so the refusal still switches the page to its state — without taking focus from the person.
    await screen.findByTestId('hours-deal-filter-unavailable')
    expect(document.activeElement).toBe(clear)
    expect(document.activeElement).not.toBe(blocker())
  })

  it('Retry asks every read again, and the old refusal does not come back: the view is shown, focus on the Totals heading', async () => {
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
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(exportButton()).not.toBeNull()
    // ...and the export works now.
    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))
  })

  it('"Clear the deal filter" shows the view without the filter, and choosing the same deal again is not blocked by the old refusal', async () => {
    await exportUnderDeal()
    await userEvent.click(within(blocker()).getByRole('button', { name: e.dealFilterUnavailable.clear }))
    await screen.findByTestId('hours-day-list')
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()

    await pickDeal()
    // The same filters as the click that was refused: the first read, the deal, no deal, and the deal again.
    await waitFor(() => expect(screenCalls().length).toBe(4))
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
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
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    // While the walk is out, the person narrows the view to another category.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'tc-formazione')
    await waitFor(() => expect(screenCalls().length).toBe(3))
    await screen.findByTestId('hours-day-list')

    // The refusal is for the filters of the click; the view now shows others. Let everything it sets off settle.
    await act(async () => {
      slow.resolve({ status: 503, body: problem(503, 'host_unavailable') })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(screen.getByTestId('hours-day-list')).not.toBeNull()
  })
})

describe('an export refused because Meetings cannot say which meetings are linked to the project (AC-4.8, D45, D78)', () => {
  const blocker = () => screen.getByTestId('hours-project-filter-unavailable')

  const exportUnderProject = async (overrides: Parameters<typeof fakeApi>[0] = {}) => {
    serveApi({ 'GET /time-entries': refusingTheWalk(entriesHandler), ...overrides })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await waitFor(() => expect(screenCalls().length).toBe(2))
    await screen.findByTestId('hours-day-list')
    // By keyboard, as for the deal: it is the key that leaves the focus ON the button, which the refusal takes away.
    exportButton().focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByTestId('hours-project-filter-unavailable')
  }

  it('switches the page to the one project-filter-unavailable state, exactly as for a deal: the button, Totals and Entries are gone', async () => {
    await exportUnderProject()
    expect(blocker().getAttribute('role')).toBe('alert')
    expect(within(blocker()).getByText(e.projectFilterUnavailable.title)).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(queryExportButton()).toBeNull()
    expect(screen.queryByTestId('hours-totals')).toBeNull()
    expect(screen.queryByTestId('hours-entries')).toBeNull()
    expect(screen.queryByTestId('hours-day-list')).toBeNull()
    // One alert, and it is the banner's: the button shows no failure of its own.
    expect(screen.queryByTestId('hours-export-error')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(downloads).toHaveLength(0)
    expect(blobs).toHaveLength(0)
    expect(exceljsLoaded).not.toHaveBeenCalled()
    // The filter stays picked, so the person can see which one to clear.
    expect((projectInput() as HTMLInputElement).value).toBe('Project Alpha')
  })

  it('takes focus: the Export button that had it is gone', async () => {
    await exportUnderProject()
    await waitFor(() => expect(document.activeElement).toBe(blocker()))
  })

  it('Retry asks every read again, and the old refusal does not come back: the view is shown and the export works', async () => {
    let healthy = false
    await exportUnderProject({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit') && !healthy
          ? { status: 503, body: problem(503, 'host_unavailable') }
          : entriesHandler(url, init, params),
    })
    healthy = true
    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    const heading = await screen.findByRole('heading', { level: 3, name: t.title })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    await userEvent.click(exportButton())
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(walkCalls().at(-1)!.query['projectId']).toBe('p1')
  })

  it('"Clear the project filter" shows the view without it and puts focus in the Project field; choosing the same project again is not blocked by the old refusal', async () => {
    await exportUnderProject()
    await userEvent.click(within(blocker()).getByRole('button', { name: e.projectFilterUnavailable.clear }))
    await screen.findByTestId('hours-day-list')
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect((projectInput() as HTMLInputElement).value).toBe('')

    await pickProject()
    // The same filters as the click that was refused: the first read, the project, no project, and the project again.
    await waitFor(() => expect(screenCalls().length).toBe(4))
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(exportButton()).not.toBeNull()
  })

  it('a refusal that arrives after the person changed the filters does not block the view they changed to', async () => {
    const slow = deferred<FakeAnswer>()
    serveApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit') ? slow.promise : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'tc-formazione')
    await waitFor(() => expect(screenCalls().length).toBe(3))
    await screen.findByTestId('hours-day-list')

    await act(async () => {
      slow.resolve({ status: 503, body: problem(503, 'host_unavailable') })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(screen.getByTestId('hours-day-list')).not.toBeNull()
  })

  it('any other failure of the export under a project filter is still the button’s own alert, and the page stays', async () => {
    serveApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('limit') ? { status: 500, body: problem(500) } : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(exportButton())
    expect((await screen.findByTestId('hours-export-error')).textContent).toBe(x.failed)
    expect(downloads).toHaveLength(0)
    expect(screen.getByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
  })

  it('with a deal filter set as well the project’s words show, and clearing the project leaves the deal filter set', async () => {
    serveApi({ 'GET /time-entries': refusingTheWalk(entriesHandler) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await waitFor(() => expect(screenCalls().at(-1)!.query).toHaveProperty('projectId'))
    await screen.findByTestId('hours-day-list')
    exportButton().focus()
    await userEvent.keyboard('{Enter}')

    await screen.findByTestId('hours-project-filter-unavailable')
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    within(blocker()).getByRole('button', { name: e.projectFilterUnavailable.clear }).focus()
    await userEvent.keyboard('{Enter}')

    // Only the walk was refused and the view reads again, so the old refusal is gone; the deal is still picked.
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect((projectInput() as HTMLInputElement).value).toBe('')
    expect((dealInput() as HTMLInputElement).value).toBe('Acme renewal')
  })
})
