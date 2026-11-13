/**
 * @vitest-environment jsdom
 *
 * HoursExport — the Export button of both views (specs/029-time-tracking T30; design F5, S1, S4; AC-4.6, AC-4.7,
 * AC-4.9, AC-4.10, AC-4.11). The real `ExportButton` of `@operai/ui`, the real walk (`exportPages`) and the real
 * builder run, with `fakeApi` behind `apiFetch`; only the browser seams a download crosses — `URL.createObjectURL`
 * and the anchor click — are faked and recorded, so the file a test inspects is the one the person would get.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { apiFetch, exceljsLoaded } = vi.hoisted(() => ({ apiFetch: vi.fn(), exceljsLoaded: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))
// The factory runs the first time anything imports `exceljs`: the count says WHEN that is.
vi.mock('exceljs', async (importOriginal) => {
  exceljsLoaded()
  return importOriginal()
})

import { strings } from '../strings'
import { deferred, fakeApi, problem, requests } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { ALPHA_DEV, EXPORT_ENTRIES, KICKOFF_ACME, exportPage } from '../test-support/fixtures/export'
import type { EntryFilters } from '../lib/hoursApi'
import type { EntriesPage } from '../lib/hoursApi.types'
import HoursExport from './HoursExport'

const t = strings.export

const FILTERS: EntryFilters = { whose: 'mine', from: '2026-11-01', to: '2026-11-30' }
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type Download = { name: string; href: string; connected: boolean }
let downloads: Download[]
let blobs: Blob[]
let api: ReturnType<typeof fakeApi>

const useApi = (handler: FakeHandler) => {
  api = fakeApi({ 'GET /time-entries': handler })
  apiFetch.mockImplementation(api)
}

/** `GET /time-entries` over a chain of pages: the first without a cursor, each next one by the cursor before it. */
const pages =
  (...chain: EntriesPage[]): FakeHandler =>
  (url) => {
    const cursor = url.searchParams.get('cursor')
    return { status: 200, body: chain[cursor === null ? 0 : Number(cursor.replace('c', ''))] }
  }

beforeEach(() => {
  apiFetch.mockReset()
  exceljsLoaded.mockClear()
  downloads = []
  blobs = []
  let made = 0
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob)
      return `blob:fake-${++made}`
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href, connected: this.isConnected })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const button = () => screen.getByRole('button', { name: t.button })
const click = () => fireEvent.click(button())
const status = () => screen.getByTestId('hours-export-status')

/** The workbook a downloaded blob holds, read back from its bytes (jsdom's Blob has no `arrayBuffer`). */
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

describe('the button', () => {
  it('is an enabled "Export" button with an empty polite status, and has asked for and built nothing yet', () => {
    useApi(pages(exportPage([ALPHA_DEV])))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    expect((button() as HTMLButtonElement).disabled).toBe(false)
    expect(button().getAttribute('aria-busy')).toBeNull()
    expect(button().getAttribute('data-testid')).toBe('hours-export')
    expect(status().getAttribute('role')).toBe('status')
    expect(status().textContent).toBe('')
    expect(apiFetch).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('loads the spreadsheet library when the person clicks, not before (the heavy dependency stays out of the page)', async () => {
    // Forget every module a test before this one may have loaded: what is counted is the load THIS click makes, so
    // the result does not depend on which test ran first. A library imported statically (by the component, or by
    // any module it imports) would be loaded already, and the click would load nothing.
    vi.resetModules()
    useApi(pages(exportPage([ALPHA_DEV])))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    expect(exceljsLoaded).not.toHaveBeenCalled()
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(exceljsLoaded).toHaveBeenCalledTimes(1)
  })
})

describe('Export (AC-4.6)', () => {
  it('walks every page of the active filters with limit=500, then downloads one XLSX holding every entry in order', async () => {
    useApi(
      pages(
        exportPage(EXPORT_ENTRIES.slice(0, 6), 'c1'),
        exportPage(EXPORT_ENTRIES.slice(6, 12), 'c2'),
        exportPage(EXPORT_ENTRIES.slice(12)),
      ),
    )
    const filters: EntryFilters = { ...FILTERS, whose: 'all', userId: 'u-ada', dealId: 'd1' }
    render(<HoursExport filters={filters} resetKey="a" />)
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))

    const asked = requests(api, 'GET /time-entries')
    expect(asked.map((request) => request.query['cursor'])).toEqual([undefined, 'c1', 'c2'])
    for (const request of asked) {
      expect(request.query).toMatchObject({
        whose: 'all',
        from: '2026-11-01',
        to: '2026-11-30',
        userId: 'u-ada',
        dealId: 'd1',
        limit: '500',
      })
    }

    expect(blobs).toHaveLength(1)
    expect(blobs[0]!.type).toBe(XLSX)
    const sheet = await sheetOf(blobs[0]!)
    expect(sheet.rowCount).toBe(1 + EXPORT_ENTRIES.length)
    expect(sheet.getRow(1).getCell(3).value).toBe('Hours')
    // The rows are the pages, in order: rows 2, 8 and 14 are the first entry of each page, where the cuts fell
    // (a project, a deal whose name did not come, and other work, which has no name).
    expect([2, 8, 14].map((row) => sheet.getRow(row).getCell(5).value)).toEqual([
      'Project Alpha',
      'Name unavailable',
      null,
    ])
    expect(sheet.getRow(14).getCell(2).value).toBe('Unknown user')
  })

  it('names the file hours-<from>_<to>.xlsx from the view, and attaches it as a download', async () => {
    useApi(pages(exportPage([ALPHA_DEV])))
    render(<HoursExport filters={{ ...FILTERS, from: '2026-10-05', to: '2026-10-11' }} resetKey="a" />)
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]).toEqual({ name: 'hours-2026-10-05_2026-10-11.xlsx', href: 'blob:fake-1', connected: true })
  })

  it('says it is preparing, politely and with the button aria-busy and not disabled, then that the file is ready', async () => {
    const release = deferred<{ status: number; body: unknown }>()
    useApi(() => release.promise)
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    await waitFor(() => expect(button().getAttribute('aria-busy')).toBe('true'))
    expect((button() as HTMLButtonElement).disabled).toBe(false)
    expect(status().textContent).toBe(t.busy)
    release.resolve({ status: 200, body: exportPage([ALPHA_DEV]) })
    await waitFor(() => expect(status().textContent).toBe(t.ready))
    expect(button().getAttribute('aria-busy')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a second click while the walk runs: one walk, one file', async () => {
    useApi(pages(exportPage([ALPHA_DEV])))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(requests(api, 'GET /time-entries')).toHaveLength(1)
  })

  it('writes hours as numbers, so the downloaded file sums (AC-4.9, D39)', async () => {
    useApi(pages(exportPage([{ ...KICKOFF_ACME }])))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    const sheet = await sheetOf(blobs[0]!)
    expect(sheet.getRow(2).getCell(3).value).toBe(2.5)
  })
})

describe('a source that did not answer (AC-4.7)', () => {
  it('still makes the file, and says in the ready line that some names are missing', async () => {
    useApi(pages(exportPage([ALPHA_DEV], 'c1'), exportPage([KICKOFF_ACME], null, ['crm'])))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    await waitFor(() => expect(status().textContent).toBe(t.readyNamesMissing))
    expect(downloads).toHaveLength(1)
    expect(t.readyNamesMissing).toBe('File ready. Some names could not be loaded and are missing.')
  })

  it('says plain "File ready" when every source answered', async () => {
    useApi(pages(exportPage([ALPHA_DEV])))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    await waitFor(() => expect(status().textContent).toBe('File ready'))
  })
})

describe('a failure', () => {
  it('shows an alert, downloads nothing and lets the same button try again, when a page fails', async () => {
    let failing = true
    useApi((url, init, params) =>
      failing ? { status: 500, body: problem(500) } : pages(exportPage([ALPHA_DEV]))(url, init, params),
    )
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(t.failed)
    expect(downloads).toHaveLength(0)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(button().getAttribute('aria-busy')).toBeNull()

    failing = false
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('writes no file from the pages that did arrive when a later one fails', async () => {
    useApi((url) =>
      url.searchParams.get('cursor') === null
        ? { status: 200, body: exportPage([ALPHA_DEV], 'c1') }
        : { status: 500, body: problem(500) },
    )
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    await screen.findByRole('alert')
    expect(downloads).toHaveLength(0)
    expect(blobs).toHaveLength(0)
  })

  it('shows the alert for a network failure too', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    expect((await screen.findByRole('alert')).textContent).toBe(t.failed)
  })

  it('shows the alert, and builds no file, when an entry cannot be written (minutes that are not whole)', async () => {
    useApi(pages(exportPage([{ ...ALPHA_DEV, minutes: Number.NaN }])))
    render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    expect((await screen.findByRole('alert')).textContent).toBe(t.failed)
    expect(downloads).toHaveLength(0)
  })
})

describe('under a deal filter, Meetings cannot say which meetings are linked to the deal (AC-4.11)', () => {
  const refused: FakeHandler = () => ({ status: 503, body: problem(503, 'host_unavailable') })

  it('tells the page, so it can show its one state, and downloads nothing', async () => {
    useApi(refused)
    const onDealFilterUnavailable = vi.fn()
    render(
      <HoursExport
        filters={{ ...FILTERS, dealId: 'd1' }}
        resetKey="a"
        onDealFilterUnavailable={onDealFilterUnavailable}
      />,
    )
    click()
    await waitFor(() => expect(onDealFilterUnavailable).toHaveBeenCalledTimes(1))
    expect(downloads).toHaveLength(0)
    expect(exceljsLoaded).not.toHaveBeenCalled()
  })

  it('does not take a refusal with no deal filter for that state: the same 503 is an ordinary failure', async () => {
    useApi(refused)
    const onDealFilterUnavailable = vi.fn()
    render(<HoursExport filters={FILTERS} resetKey="a" onDealFilterUnavailable={onDealFilterUnavailable} />)
    click()
    expect((await screen.findByRole('alert')).textContent).toBe(t.failed)
    expect(onDealFilterUnavailable).not.toHaveBeenCalled()
  })

  it('does not take any other refusal under a deal filter for that state either', async () => {
    useApi(() => ({ status: 503, body: problem(503, 'authz_unavailable') }))
    const onDealFilterUnavailable = vi.fn()
    render(
      <HoursExport
        filters={{ ...FILTERS, dealId: 'd1' }}
        resetKey="a"
        onDealFilterUnavailable={onDealFilterUnavailable}
      />,
    )
    click()
    expect((await screen.findByRole('alert')).textContent).toBe(t.failed)
    expect(onDealFilterUnavailable).not.toHaveBeenCalled()
  })
})

describe('the status belongs to what was exported', () => {
  it('clears "File ready" when the filters change, because it described another file', async () => {
    useApi(pages(exportPage([ALPHA_DEV])))
    const { rerender } = render(<HoursExport filters={FILTERS} resetKey="a" />)
    click()
    await waitFor(() => expect(status().textContent).toBe(t.ready))
    rerender(<HoursExport filters={{ ...FILTERS, to: '2026-11-15' }} resetKey="b" />)
    expect(status().textContent).toBe('')
  })

  it('exports the filters it has now: the next click walks the new ones and names the file from them', async () => {
    useApi(pages(exportPage([ALPHA_DEV])))
    const { rerender } = render(<HoursExport filters={FILTERS} resetKey="a" />)
    rerender(<HoursExport filters={{ ...FILTERS, to: '2026-11-15', projectId: 'p1' }} resetKey="b" />)
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]!.name).toBe('hours-2026-11-01_2026-11-15.xlsx')
    expect(requests(api, 'GET /time-entries')[0]!.query).toMatchObject({ to: '2026-11-15', projectId: 'p1' })
  })
})
