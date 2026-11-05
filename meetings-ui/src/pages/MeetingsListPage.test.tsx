/**
 * @vitest-environment jsdom
 *
 * The meetings list, both entries (specs/021-meetings T55; AC-10.1, 10.2, 10.3, 10.5, 10.7, 11.5):
 * `./App` at /meetings and `./MyMeetings` at /my-meetings. Pages are rendered inside the real inner
 * routers (a memory history), against `fakeApi` standing in for `shell/session`'s `apiFetch`.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  apps: ['meetings'] as string[],
}))

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  navigateSuite: vi.fn(),
  registerNavigationBlocker: vi.fn(() => () => undefined),
  usePermissions: vi.fn(() => ({
    epoch: 0,
    apps: session.apps,
    roles: [],
    departments: [],
    permissions: [],
  })),
}))

import { apiFetch, navigateSuite } from 'shell/session'
import { createAppRouter, createMyMeetingsRouter } from '../router'
import { en } from '../strings'
import { crmDealHost, fakeApi, hostView, meetingRow, page, problem } from '../test-support/fakeApi'

beforeEach(() => {
  // jsdom does not implement scrolling; the router's scroll restoration calls it on navigation.
  window.scrollTo = () => undefined
  session.apps = ['meetings']
})

afterEach(() => {
  cleanup()
  vi.mocked(navigateSuite).mockReset()
  vi.mocked(apiFetch).mockReset()
})

const serve = (routes: Parameters<typeof fakeApi>[0]) => {
  const api = fakeApi({ 'GET /hosts': () => ({ status: 200, body: { items: [crmDealHost] } }), ...routes })
  vi.mocked(apiFetch).mockImplementation(api)
  return api
}

const renderList = async (mine = false, state?: { meetingDeleted?: boolean }) => {
  const base = mine ? '/my-meetings' : '/meetings'
  const history = createMemoryHistory({ initialEntries: [base] })
  if (state) history.replace(base, state)
  const router = mine
    ? createMyMeetingsRouter(base, undefined, history)
    : createAppRouter(base, undefined, history)
  render(<RouterProvider router={router} />)
  await screen.findByTestId('meetings-list-page')
}

/** The search params of every `GET /meetings` the page made, in order. */
const listQueries = () =>
  vi
    .mocked(apiFetch)
    .mock.calls.map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === '/meetings')
    .map((url) => Object.fromEntries(url.searchParams))

const lastQuery = () => listQueries().at(-1)

describe('the table (AC-10.2)', () => {
  it('shows title, date, format, host, status and role for each row', async () => {
    serve({
      'GET /meetings': () => ({
        status: 200,
        body: page([
          meetingRow({
            id: 'm1',
            title: 'Kick-off with Acme',
            startsAt: '2026-11-03T09:30:00.000Z',
            format: 'online',
            status: 'ready',
            role: 'creator',
          }),
          meetingRow({ id: 'm2', title: 'Retro', format: 'in_person', status: 'processing', role: 'participant' }),
        ]),
      }),
    })
    await renderList()

    const table = await screen.findByRole('table', { name: en.list.table.caption })
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
    expect(headers).toEqual([
      en.list.table.title,
      en.list.table.date,
      en.list.table.format,
      en.list.table.host,
      en.list.table.status,
      en.list.table.role,
    ])

    const first = within(table).getByRole('row', { name: /Kick-off with Acme/ })
    expect(within(first).getByText(en.list.format.online)).not.toBeNull()
    expect(within(first).getByText(en.common.status.meeting.ready)).not.toBeNull()
    expect(within(first).getByText(en.list.role.creator)).not.toBeNull()
    expect(within(first).getByText(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/)).not.toBeNull()

    const second = within(table).getByRole('row', { name: /Retro/ })
    expect(within(second).getByText(en.list.format.in_person)).not.toBeNull()
    expect(within(second).getByText(en.common.status.meeting.processing)).not.toBeNull()
    expect(within(second).getByText(en.list.role.participant)).not.toBeNull()
  })

  it('the title opens the meeting inside the entry that is showing the list', async () => {
    serve({ 'GET /meetings': () => ({ status: 200, body: page([meetingRow({ id: 'm9', title: 'Standup' })]) }) })
    await renderList()
    expect((await screen.findByRole('link', { name: 'Standup' })).getAttribute('href')).toBe('/meetings/m/m9')
    cleanup()

    await renderList(true)
    expect((await screen.findByRole('link', { name: 'Standup' })).getAttribute('href')).toBe('/my-meetings/m/m9')
  })

  it('the host column has four states and a standalone one (AC-10.3)', async () => {
    serve({
      'GET /meetings': () => ({
        status: 200,
        body: page([
          meetingRow({ id: 'a', title: 'Open one', host: hostView() }),
          meetingRow({
            id: 'b',
            title: 'Closed one',
            host: hostView({ state: 'closed', title: null, href: null }),
          }),
          meetingRow({
            id: 'c',
            title: 'Unreachable one',
            host: hostView({ state: 'unavailable', title: null, href: null }),
          }),
          meetingRow({
            id: 'd',
            title: 'Missing one',
            host: hostView({ state: 'missing', title: null, href: null }),
          }),
          meetingRow({ id: 'e', title: 'Plain one', host: null }),
        ]),
      }),
    })
    await renderList()
    await screen.findByRole('table')

    const hostCell = (title: string) => {
      const row = screen.getByRole('row', { name: new RegExp(title) })
      return within(row).getAllByRole('cell')[2]!
    }

    // open: "Deal · title" as a link into the host app, through the shell router
    const link = await within(hostCell('Open one')).findByRole('link', { name: 'Deal · Acme renewal' })
    expect(link.getAttribute('href')).toBe('/crm/deals/d1')
    await userEvent.click(link)
    expect(navigateSuite).toHaveBeenCalledWith('/crm/deals/d1')

    // closed and unavailable: the app and the kind only, never the title, no link
    for (const title of ['Closed one', 'Unreachable one']) {
      expect(hostCell(title).textContent).toBe('CRM · deal')
      expect(within(hostCell(title)).queryByRole('link')).toBeNull()
    }

    // gone, and none at all
    expect(hostCell('Missing one').textContent).toBe(en.list.host.missing)
    expect(hostCell('Plain one').textContent).toBe(en.list.host.standalone)
  })

  it('a failed host registry degrades silently: no error, the raw app and kind', async () => {
    serve({
      'GET /hosts': () => ({ status: 500, body: problem(500) }),
      'GET /meetings': () => ({
        status: 200,
        body: page([meetingRow({ title: 'Closed one', host: hostView({ state: 'closed', title: null, href: null }) })]),
      }),
    })
    await renderList()

    const row = await screen.findByRole('row', { name: /Closed one/ })
    expect(within(row).getByText('crm · deal')).not.toBeNull()
    expect(screen.queryByTestId('meetings-load-error')).toBeNull()
  })
})

describe('the confirmation after a meeting is deleted (design.md F14)', () => {
  it.each([false, true])('shows "Meeting deleted" when the meeting page sent the person here (mine: %s)', async (mine) => {
    serve({ 'GET /meetings': () => ({ status: 200, body: page([meetingRow()]) }) })
    await renderList(mine, { meetingDeleted: true })
    expect(await screen.findByText(en.list.deleted)).not.toBeNull()
  })

  it('shows nothing on an ordinary visit', async () => {
    serve({ 'GET /meetings': () => ({ status: 200, body: page([meetingRow()]) }) })
    await renderList()
    expect(screen.queryByText(en.list.deleted)).toBeNull()
  })

  it('the confirmation can be dismissed', async () => {
    serve({ 'GET /meetings': () => ({ status: 200, body: page([meetingRow()]) }) })
    await renderList(false, { meetingDeleted: true })
    await userEvent.click(await screen.findByRole('button', { name: en.common.dismiss }))
    expect(screen.queryByText(en.list.deleted)).toBeNull()
  })
})

describe('states', () => {
  it('shows a loading line while the list loads', async () => {
    serve({ 'GET /meetings': () => new Promise(() => undefined) })
    await renderList()
    expect(await screen.findByText(en.list.loading)).not.toBeNull()
  })

  it('a failed load is a warning with Retry, and Retry loads again', async () => {
    let attempt = 0
    serve({
      'GET /meetings': () => {
        attempt += 1
        return attempt === 1
          ? { status: 500, body: problem(500) }
          : { status: 200, body: page([meetingRow({ title: 'Back again' })]) }
      },
    })
    await renderList()

    const banner = await screen.findByTestId('meetings-load-error')
    await userEvent.click(within(banner).getByRole('button', { name: en.common.retry }))
    expect(await screen.findByRole('link', { name: 'Back again' })).not.toBeNull()
  })

  it('no meetings at all: says so, and the header offers New meeting to a holder (AC-10.7)', async () => {
    serve({ 'GET /meetings': () => ({ status: 200, body: page([]) }) })
    await renderList()

    expect(await screen.findByRole('heading', { name: en.list.empty.none.title })).not.toBeNull()
    expect(screen.getByText(en.list.empty.none.body)).not.toBeNull()
    expect(screen.getByRole('link', { name: en.list.newMeeting })).not.toBeNull()
  })

  it('no match for the filters: names the situation and clears them', async () => {
    serve({
      'GET /meetings': (url) =>
        url.searchParams.get('role') === 'participant'
          ? { status: 200, body: page([]) }
          : { status: 200, body: page([meetingRow({ title: 'Everything' })]) },
    })
    await renderList()
    await screen.findByRole('link', { name: 'Everything' })

    await userEvent.selectOptions(screen.getByLabelText(en.list.filters.role), 'participant')

    expect(await screen.findByRole('heading', { name: en.list.empty.filtered.title })).not.toBeNull()
    expect(screen.queryByRole('heading', { name: en.list.empty.none.title })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: en.list.filters.clear }))
    expect(await screen.findByRole('link', { name: 'Everything' })).not.toBeNull()
    expect((screen.getByLabelText(en.list.filters.role) as HTMLSelectElement).value).toBe('')
    expect(screen.queryByRole('button', { name: en.list.filters.clear })).toBeNull()
  })
})

describe('filters and paging (AC-10.2)', () => {
  const rows = () => serve({ 'GET /meetings': () => ({ status: 200, body: page([meetingRow()], 60) }) })

  it('starts with no filter, on page 1', async () => {
    rows()
    await renderList()
    await screen.findByRole('table')
    expect(lastQuery()).toEqual({ page: '1' })
    expect(screen.queryByRole('button', { name: en.list.filters.clear })).toBeNull()
  })

  it('role, status and host app go to the query, and each change returns to page 1', async () => {
    rows()
    await renderList()
    await screen.findByRole('table')

    await userEvent.click(screen.getByTestId('meetings-list-pagination-next'))
    await waitFor(() => expect(lastQuery()).toEqual({ page: '2' }))

    await userEvent.selectOptions(screen.getByLabelText(en.list.filters.role), 'creator')
    await waitFor(() => expect(lastQuery()).toEqual({ role: 'creator', page: '1' }))

    await userEvent.selectOptions(screen.getByLabelText(en.list.filters.status), 'ready')
    await waitFor(() => expect(lastQuery()).toEqual({ role: 'creator', status: 'ready', page: '1' }))

    await userEvent.selectOptions(screen.getByLabelText(en.list.filters.hostApp), 'crm')
    await waitFor(() => expect(lastQuery()).toEqual({ role: 'creator', status: 'ready', hostApp: 'crm', page: '1' }))

    await userEvent.click(screen.getByRole('button', { name: en.list.filters.clear }))
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1' }))
  })

  it('offers each registered app by name in the host app filter', async () => {
    rows()
    await renderList()
    await screen.findByRole('table')
    const select = screen.getByLabelText(en.list.filters.hostApp)
    await waitFor(() => expect(within(select).getByRole('option', { name: 'CRM' })).not.toBeNull())
    expect(within(select).getByRole('option', { name: en.list.filters.all })).not.toBeNull()
  })

  it('searches by title after a pause in typing, and at once on Enter', async () => {
    rows()
    await renderList()
    await screen.findByRole('table')
    const callsBefore = listQueries().length

    const search = screen.getByRole('searchbox', { name: en.list.filters.search })
    await userEvent.type(search, 'acme')
    // typing alone has not searched yet (the debounce is 300 ms)
    expect(listQueries()).toHaveLength(callsBefore)
    await waitFor(() => expect(lastQuery()).toEqual({ q: 'acme', page: '1' }))

    await userEvent.clear(search)
    await userEvent.type(search, 'retro{Enter}')
    expect(lastQuery()).toEqual({ q: 'retro', page: '1' })
  })

  it('pages with Previous/Next and says where the person is', async () => {
    rows()
    await renderList()
    await screen.findByRole('table')

    expect(screen.getByText('Page 1 of 3 — showing 1–25 of 60')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.list.pagination.next }))
    await waitFor(() => expect(lastQuery()).toEqual({ page: '2' }))
    expect(await screen.findByText('Page 2 of 3 — showing 26–50 of 60')).not.toBeNull()
  })

  it('shows no pager for a single page', async () => {
    serve({ 'GET /meetings': () => ({ status: 200, body: page([meetingRow()]) }) })
    await renderList()
    await screen.findByRole('table')
    expect(screen.queryByRole('navigation', { name: en.list.pagination.label })).toBeNull()
  })
})

describe('entry points (AC-10.5, AC-10.7, AC-1.4)', () => {
  beforeEach(() => {
    serve({ 'GET /meetings': () => ({ status: 200, body: page([meetingRow()]) }) })
  })

  it('./App: the heading is "Meetings" and New meeting is a link to the new-meeting page', async () => {
    await renderList()
    expect(await screen.findByRole('heading', { level: 2, name: en.list.heading })).not.toBeNull()
    expect(screen.getByRole('link', { name: en.list.newMeeting }).getAttribute('href')).toBe('/meetings/new')
    // the Templates tab belongs to the tool frame, not to this page
    expect(screen.queryByRole('link', { name: en.nav.tabs.templates })).toBeNull()
  })

  it('./MyMeetings: "My meetings"; New meeting and Templates leave through the shell router', async () => {
    await renderList(true)
    expect(await screen.findByRole('heading', { level: 2, name: en.list.myHeading })).not.toBeNull()

    const create = screen.getByRole('link', { name: en.list.newMeeting })
    expect(create.getAttribute('href')).toBe('/meetings/new')
    await userEvent.click(create)
    expect(navigateSuite).toHaveBeenCalledWith('/meetings/new')

    const templates = screen.getByRole('link', { name: en.nav.tabs.templates })
    expect(templates.getAttribute('href')).toBe('/meetings/templates')
    await userEvent.click(templates)
    expect(navigateSuite).toHaveBeenCalledWith('/meetings/templates')
  })

  it.each([false, true])('without meetings:access there is no New meeting and no Templates (mine=%s)', async (mine) => {
    session.apps = []
    await renderList(mine)
    await screen.findByRole('table')
    expect(screen.queryByRole('link', { name: en.list.newMeeting })).toBeNull()
    expect(screen.queryByRole('link', { name: en.nav.tabs.templates })).toBeNull()
    // reading still works
    expect(screen.getByRole('row', { name: /Kick-off with Acme/ })).not.toBeNull()
  })
})
