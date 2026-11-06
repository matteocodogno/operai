/**
 * @vitest-environment jsdom
 *
 * The Erase page (specs/021-meetings T75; design.md S9, F14; AC-4.6, AC-4.7, AC-4.8, AC-5.12): find
 * a meeting by title, creator or date and delete it, seeing title, date and creator only, with no
 * way into the content. The Erase tab itself is hidden without the `meeting:erase` hint
 * (App.test.tsx pins that).
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { formatDate } from '@operai/ui'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EraseRow } from '../lib/types'
import { createAppRouter } from '../router'
import { en } from '../strings'
import { ADA, GONE, GRACE, fakeApi, page, problem } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const session = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  apiFetch: session.apiFetch,
  getMeetingsApiBaseUrl: () => 'http://meetings-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  navigateSuite: vi.fn(),
  registerNavigationBlocker: () => () => undefined,
  usePermissions: () => ({ epoch: 0, apps: ['meetings'], roles: [], departments: [], permissions: [] }),
}))

beforeEach(() => {
  window.scrollTo = () => undefined
  session.apiFetch.mockReset()
})

afterEach(() => {
  cleanup()
})

const t = en.erase

const row = (overrides: Partial<EraseRow> = {}): EraseRow => ({
  id: 'm1',
  title: 'Kick-off with Acme',
  startsAt: '2026-11-03T09:30:00.000Z',
  creator: ADA,
  ...overrides,
})

const DIRECTORY = {
  users: [
    { id: 'u-grace', name: 'Grace Hopper', email: 'grace@welld.ch', entity: 'welld_ch' },
    { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@welld.ch', entity: 'welld_it' },
  ],
}

const serve = (rows: EraseRow[], extra: Record<string, FakeHandler> = {}) => {
  const api = fakeApi({
    'GET /erase/meetings': () => ({ status: 200, body: page(rows) }),
    'GET /authz/users/directory': () => ({ status: 200, body: DIRECTORY }),
    ...extra,
  })
  session.apiFetch.mockImplementation(api)
  return api
}

const eraseCalls = (api: ReturnType<typeof fakeApi>) =>
  api.mock.calls
    .filter(([url]) => new URL(String(url)).pathname === '/erase/meetings')
    .map(([url]) => new URL(String(url)).searchParams)

const renderPage = async () => {
  const router = createAppRouter('/meetings', undefined, createMemoryHistory({ initialEntries: ['/meetings/erase'] }))
  render(<RouterProvider router={router} />)
  await router.load()
  await screen.findByTestId('meetings-erase-page')
}

const table = () => screen.findByRole('table', { name: t.table.caption })

describe('ErasePage: what it shows (AC-4.7, AC-4.8)', () => {
  it('always says you can delete here but not read content', async () => {
    serve([])
    await renderPage()
    expect(screen.getByRole('heading', { level: 2, name: t.heading })).not.toBeNull()
    expect(screen.getByText(t.notice)).not.toBeNull()
  })

  it('lists title, date and creator, a Delete button per row, and no link to the meeting or its content', async () => {
    serve([row(), row({ id: 'm2', title: 'Retro', creator: GRACE }), row({ id: 'm3', title: 'Old', creator: GONE })])
    await renderPage()
    const list = await table()

    const headers = within(list)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent)
    expect(headers).toEqual([t.table.title, t.table.date, t.table.creator, t.table.actions])
    expect(within(list).getByText('Kick-off with Acme')).not.toBeNull()
    expect(within(list).getAllByText(formatDate('2026-11-03T09:30:00.000Z')).length).toBe(3)
    expect(within(list).getByText('Grace Hopper')).not.toBeNull()
    expect(within(list).getByText(t.deletedUser)).not.toBeNull()
    expect(within(list).getAllByRole('button', { name: /^Delete meeting / })).toHaveLength(3)

    expect(within(list).queryAllByRole('link')).toHaveLength(0)
    expect(list.querySelector('a')).toBeNull()
  })

  it('asks for the first page with no filters', async () => {
    const api = serve([row()])
    await renderPage()
    await table()
    expect(eraseCalls(api)[0]!.toString()).toBe('')
  })

  it('an empty result says no meetings match', async () => {
    serve([])
    await renderPage()
    expect(await screen.findByRole('heading', { name: t.empty.title })).not.toBeNull()
  })
})

describe('ErasePage: states', () => {
  it('403 is the permission-denied panel, whatever the code (the tab is only a hint)', async () => {
    serve([], { 'GET /erase/meetings': () => ({ status: 403, body: problem(403, 'meetings_access_required') }) })
    await renderPage()
    expect(await screen.findByRole('heading', { name: en.common.permissionDenied.heading })).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.common.retry })).toBeNull()
  })

  it('503 from auth is the authorization-unavailable banner with Retry', async () => {
    let fail = true
    serve([row()], {
      'GET /erase/meetings': () => (fail ? { status: 503, body: problem(503) } : { status: 200, body: page([row()]) }),
    })
    await renderPage()
    expect(await screen.findByText(en.common.authUnavailable.heading)).not.toBeNull()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: en.common.retry }))
    expect(await table()).not.toBeNull()
  })

  it('another failure is a warning with Retry', async () => {
    serve([], { 'GET /erase/meetings': () => ({ status: 500, body: problem(500) }) })
    await renderPage()
    expect(await screen.findByRole('button', { name: en.common.retry })).not.toBeNull()
  })
})

describe('ErasePage: finding a meeting (AC-4.7)', () => {
  const searchButton = () => screen.getByRole('button', { name: t.filters.submit })

  it('searches by title, creator and dates, sent as query parameters, and returns to page 1', async () => {
    const user = userEvent.setup()
    const api = serve([row()])
    await renderPage()
    await table()

    await user.type(screen.getByLabelText(t.filters.search), 'Acme')
    await user.click(screen.getByRole('combobox', { name: new RegExp(t.filters.creator) }))
    await user.click(await screen.findByRole('option', { name: /Grace Hopper/ }))
    fireEvent.change(screen.getByLabelText(t.filters.from), { target: { value: '2026-11-01' } })
    fireEvent.change(screen.getByLabelText(t.filters.to), { target: { value: '2026-11-30' } })
    await user.click(searchButton())

    await vi.waitFor(() => expect(eraseCalls(api).length).toBe(2))
    const params = eraseCalls(api)[1]!
    expect(params.get('q')).toBe('Acme')
    expect(params.get('creatorId')).toBe('u-grace')
    expect(params.get('from')).toBe('2026-11-01')
    expect(params.get('to')).toBe('2026-11-30')
    expect(params.has('page')).toBe(false)
  })

  it('does not search on every keystroke: the typed title is only sent on Search', async () => {
    const user = userEvent.setup()
    const api = serve([row()])
    await renderPage()
    await table()
    await user.type(screen.getByLabelText(t.filters.search), 'Acme')
    expect(eraseCalls(api)).toHaveLength(1)
  })

  it('an end date before the start date is refused on the field and not sent', async () => {
    const user = userEvent.setup()
    const api = serve([row()])
    await renderPage()
    await table()
    fireEvent.change(screen.getByLabelText(t.filters.from), { target: { value: '2026-11-10' } })
    fireEvent.change(screen.getByLabelText(t.filters.to), { target: { value: '2026-11-01' } })
    await user.click(searchButton())
    expect(await screen.findByText(t.filters.toBeforeFrom)).not.toBeNull()
    expect(eraseCalls(api)).toHaveLength(1)
  })

  it('Clear filters starts over', async () => {
    const user = userEvent.setup()
    const api = serve([row()])
    await renderPage()
    await table()
    await user.type(screen.getByLabelText(t.filters.search), 'Acme')
    await user.click(searchButton())
    await vi.waitFor(() => expect(eraseCalls(api)).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: t.filters.clear }))
    await vi.waitFor(() => expect(eraseCalls(api)).toHaveLength(3))
    expect(eraseCalls(api)[2]!.toString()).toBe('')
    expect((screen.getByLabelText(t.filters.search) as HTMLInputElement).value).toBe('')
  })

  it('pages with Next, keeping the filters', async () => {
    const user = userEvent.setup()
    const rows = Array.from({ length: 25 }, (_, index) => row({ id: `m${index}`, title: `Meeting ${index}` }))
    const api = serve(rows, {
      'GET /erase/meetings': (url) => ({
        status: 200,
        body: page(rows, 60, Number(url.searchParams.get('page') ?? 1)),
      }),
    })
    await renderPage()
    await table()
    await user.type(screen.getByLabelText(t.filters.search), 'Meeting')
    await user.click(searchButton())
    await vi.waitFor(() => expect(eraseCalls(api)).toHaveLength(2))

    await user.click(await screen.findByRole('button', { name: t.pagination.next }))
    await vi.waitFor(() => expect(eraseCalls(api)).toHaveLength(3))
    expect(eraseCalls(api)[2]!.get('page')).toBe('2')
    expect(eraseCalls(api)[2]!.get('q')).toBe('Meeting')
  })

  it('the directory is read without appId for the creator picker', async () => {
    const api = serve([row()])
    await renderPage()
    await table()
    await vi.waitFor(() =>
      expect(api.mock.calls.some(([url]) => new URL(String(url)).pathname === '/authz/users/directory')).toBe(true),
    )
    const call = api.mock.calls.find(([url]) => new URL(String(url)).pathname === '/authz/users/directory')!
    expect(new URL(String(call[0])).search).toBe('')
  })
})

describe('ErasePage: deleting (AC-4.6, AC-5.12)', () => {
  const deleteRow = async (title = 'Kick-off with Acme') => {
    await userEvent.click(await screen.findByRole('button', { name: t.table.deleteAria(title) }))
    return screen.getByRole('alertdialog', { name: t.delete.title })
  }
  const confirmDelete = async () => {
    await userEvent.click(screen.getByRole('checkbox', { name: t.delete.acknowledge }))
    await userEvent.click(screen.getByRole('button', { name: t.delete.confirm }))
  }

  it('opens the dialog naming title, date and creator; Cancel leaves everything as it was', async () => {
    const api = serve([row()])
    await renderPage()
    const dialog = await deleteRow()
    expect(
      within(dialog).getByText(
        t.delete.facts('Kick-off with Acme', formatDate('2026-11-03T09:30:00.000Z'), 'Ada Lovelace'),
      ),
    ).not.toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    expect(screen.getByText('Kick-off with Acme')).not.toBeNull()
  })

  it('needs the acknowledgement; then the row goes, "Meeting deleted" is announced and focus lands on the table', async () => {
    const api = serve([row(), row({ id: 'm2', title: 'Retro' })], {
      'DELETE /meetings/:id': () => ({ status: 204 }),
    })
    await renderPage()
    await deleteRow()
    expect((screen.getByRole('button', { name: t.delete.confirm }) as HTMLButtonElement).disabled).toBe(true)
    await confirmDelete()

    await vi.waitFor(() => expect(screen.queryByText('Kick-off with Acme')).toBeNull())
    expect(screen.getByText('Retro')).not.toBeNull()
    expect(screen.getByText(t.deleted)).not.toBeNull()
    const [url, init] = api.mock.calls.find(([, i]) => i?.method === 'DELETE')!
    expect(new URL(String(url)).pathname).toBe('/meetings/m1')
    expect(init?.method).toBe('DELETE')
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('meetings-erase-table-region')))
  })

  it('a row that is already gone (404) is removed as if deleted', async () => {
    serve([row(), row({ id: 'm2', title: 'Retro' })])
    await renderPage()
    await deleteRow()
    await confirmDelete()
    await vi.waitFor(() => expect(screen.queryByText('Kick-off with Acme')).toBeNull())
    expect(screen.getByText(t.deleted)).not.toBeNull()
  })

  it('when storage is down nothing is removed and the dialog says nothing was deleted', async () => {
    serve([row()], {
      'DELETE /meetings/:id': () => ({ status: 503, body: problem(503, 'storage_unavailable') }),
    })
    await renderPage()
    await deleteRow()
    await confirmDelete()
    expect(await screen.findByText(en.common.errors.storage_unavailable)).not.toBeNull()
    expect(screen.getByRole('alertdialog', { name: t.delete.title })).not.toBeNull()
    expect(screen.getByText('Kick-off with Acme')).not.toBeNull()
    expect(screen.queryByText(t.deleted)).toBeNull()
  })

  it('deleting the last row of a page that has more pages loads the page again', async () => {
    let deleted = false
    const api = serve([], {
      'GET /erase/meetings': () => ({
        status: 200,
        body: deleted ? page([row({ id: 'm9', title: 'Next page one' })], 1) : page([row()], 26),
      }),
      'DELETE /meetings/:id': () => {
        deleted = true
        return { status: 204 }
      },
    })
    await renderPage()
    await deleteRow()
    await confirmDelete()
    expect(await screen.findByText('Next page one')).not.toBeNull()
    expect(eraseCalls(api).length).toBeGreaterThanOrEqual(2)
  })
})
