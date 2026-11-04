/**
 * @vitest-environment jsdom
 *
 * The host panel and its link dialog (specs/021-meetings T76; AC-1.4, 1.7, 11.2, 11.3, 11.6, 14.1;
 * design.md S6, F1b; plan G2): `HostMeetings` as the shell's `HostExtension` renders it inside a
 * host's page (no router of its own), against `fakeApi`.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ apps: ['meetings'] as string[] }))

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  navigateSuite: vi.fn(),
  registerNavigationBlocker: vi.fn(() => () => undefined),
  usePermissions: vi.fn(() => ({ epoch: 0, apps: session.apps, roles: [], departments: [], permissions: [] })),
}))

import { apiFetch, navigateSuite } from 'shell/session'
import { en } from '../strings'
import { ADA, GONE, crmDealHost, fakeApi, hostView, meeting, meetingRow, page, problem } from '../test-support/fakeApi'
import HostMeetings from './HostMeetings'

const DEAL = { hostApp: 'crm', entityType: 'deal', entityId: 'd1' }
const START_URL = '/meetings/new?hostApp=crm&hostType=deal&hostId=d1'

beforeEach(() => {
  session.apps = ['meetings']
})

afterEach(() => {
  cleanup()
  vi.mocked(navigateSuite).mockReset()
  vi.mocked(apiFetch).mockReset()
})

const serve = (routes: Parameters<typeof fakeApi>[0] = {}) => {
  const api = fakeApi({
    'GET /hosts': () => ({ status: 200, body: { items: [crmDealHost] } }),
    'GET /hosts/:app/:type/:id/meetings': () => ({ status: 200, body: page([meetingRow()]) }),
    ...routes,
  })
  vi.mocked(apiFetch).mockImplementation(api)
  return api
}

const renderPanel = async () => {
  render(<HostMeetings {...DEAL} />)
  await screen.findByTestId('meetings-host-panel')
}

const requests = (method: string, pattern: RegExp) =>
  vi
    .mocked(apiFetch)
    .mock.calls.filter(([input, init]) => (init?.method ?? 'GET') === method && pattern.test(String(input)))
    .map(([input, init]) => ({
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }))

const startLink = () => screen.queryByRole('link', { name: en.host.panel.start })
const linkButton = () => screen.queryByRole('button', { name: en.host.panel.link })

describe('the list (AC-11.2)', () => {
  it('lists what the caller may open on this record, as links into My meetings', async () => {
    const api = serve({
      'GET /hosts/:app/:type/:id/meetings': () => ({
        status: 200,
        body: page([
          meetingRow({ id: 'm1', title: 'Kick-off', status: 'ready', summaryCount: 3, creator: ADA }),
          meetingRow({ id: 'm 2', title: 'Retro', status: 'processing', summaryCount: 1, creator: GONE }),
        ]),
      }),
    })
    await renderPanel()

    const first = await screen.findByRole('link', { name: /Kick-off/ })
    expect(first.getAttribute('href')).toBe('/my-meetings/m/m1')
    expect(within(first).getByText(/^\d{2}\.\d{2}\.\d{4} · Ada Lovelace$/)).not.toBeNull()
    expect(within(first).getByText(en.common.status.meeting.ready)).not.toBeNull()
    expect(within(first).getByText('3 summaries')).not.toBeNull()

    const second = screen.getByRole('link', { name: /Retro/ })
    expect(second.getAttribute('href')).toBe('/my-meetings/m/m%202')
    expect(within(second).getByText(/· Former colleague$/)).not.toBeNull()
    expect(within(second).getByText('1 summary')).not.toBeNull()

    expect(api).toHaveBeenCalledWith('http://meetings-api.test/hosts/crm/deal/d1/meetings?page=1', expect.anything())
    await userEvent.click(first)
    expect(navigateSuite).toHaveBeenCalledWith('/my-meetings/m/m1')
  })

  it('addresses the record by its three props, path-encoded', async () => {
    const api = serve()
    render(<HostMeetings hostApp="crm" entityType="deal" entityId="d/1 x" />)
    await screen.findByRole('link', { name: /Kick-off/ })
    expect(api).toHaveBeenCalledWith(
      'http://meetings-api.test/hosts/crm/deal/d%2F1%20x/meetings?page=1',
      expect.anything(),
    )
    expect(screen.getByRole('link', { name: en.host.panel.start }).getAttribute('href')).toBe(
      '/meetings/new?hostApp=crm&hostType=deal&hostId=d%2F1%20x',
    )
  })

  it('pages beyond 25, and shows no pager for one page', async () => {
    serve({ 'GET /hosts/:app/:type/:id/meetings': () => ({ status: 200, body: page([meetingRow()], 60) }) })
    await renderPanel()
    expect(await screen.findByText('Page 1 of 3 — showing 1–25 of 60')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.host.panel.pagination.next }))
    await waitFor(() =>
      expect(requests('GET', /\/meetings\?page=2$/).map((r) => r.url.pathname)).toEqual([
        '/hosts/crm/deal/d1/meetings',
      ]),
    )
    cleanup()

    serve()
    await renderPanel()
    await screen.findByRole('link', { name: /Kick-off/ })
    expect(screen.queryByRole('navigation', { name: en.host.panel.pagination.label })).toBeNull()
  })

  it('shows a loading line while it loads', async () => {
    serve({ 'GET /hosts/:app/:type/:id/meetings': () => new Promise(() => undefined) })
    await renderPanel()
    expect(await screen.findByText(en.host.panel.loading)).not.toBeNull()
  })
})

describe('Start meeting and Link an existing meeting (AC-1.4)', () => {
  it('a holder sees both; Start meeting is a real link that goes through navigateSuite (F1)', async () => {
    serve()
    await renderPanel()
    const start = await screen.findByRole('link', { name: en.host.panel.start })
    expect(start.getAttribute('href')).toBe(START_URL)
    expect(linkButton()).not.toBeNull()

    await userEvent.click(start)
    expect(navigateSuite).toHaveBeenCalledWith(START_URL)
  })

  it('without meetings:access neither control exists, and the list is still readable', async () => {
    session.apps = []
    serve()
    await renderPanel()
    expect(await screen.findByRole('link', { name: /Kick-off/ })).not.toBeNull()
    expect(startLink()).toBeNull()
    expect(linkButton()).toBeNull()
  })

  it('the Link button announces that it opens a dialog', async () => {
    serve()
    await renderPanel()
    await screen.findByRole('link', { name: /Kick-off/ })
    expect(linkButton()!.getAttribute('aria-haspopup')).toBe('dialog')
  })
})

describe('empty (AC-11.2)', () => {
  const empty = () => serve({ 'GET /hosts/:app/:type/:id/meetings': () => ({ status: 200, body: page([]) }) })

  it('a holder is offered Start meeting right there (once)', async () => {
    empty()
    await renderPanel()
    expect(await screen.findByRole('heading', { name: en.host.panel.empty.title })).not.toBeNull()
    expect(screen.getByText(en.host.panel.empty.body('deal'))).not.toBeNull()
    expect(screen.getAllByRole('link', { name: en.host.panel.start })).toHaveLength(1)
    expect(linkButton()).not.toBeNull()
  })

  it('a non-holder is told there are none, with no action', async () => {
    session.apps = []
    empty()
    await renderPanel()
    expect(await screen.findByRole('heading', { name: en.host.panel.empty.title })).not.toBeNull()
    expect(startLink()).toBeNull()
    expect(linkButton()).toBeNull()
  })
})

describe('when meetings cannot be loaded (AC-11.6)', () => {
  it.each([
    ['503', () => ({ status: 503, body: problem(503) })],
    ['500', () => ({ status: 500, body: problem(500) })],
    [
      'a network failure',
      () => {
        throw new TypeError('failed to fetch')
      },
    ],
  ])('%s: the card keeps its title and says so, with Retry; nothing throws', async (_label, answer) => {
    let attempt = 0
    serve({
      'GET /hosts/:app/:type/:id/meetings': () => {
        attempt += 1
        return attempt === 1 ? answer() : { status: 200, body: page([meetingRow({ title: 'Back again' })]) }
      },
    })
    await renderPanel()

    const banner = await screen.findByTestId('meetings-host-unavailable')
    expect(within(banner).getByText(en.host.panel.unavailable.title)).not.toBeNull()
    expect(screen.getByRole('heading', { name: en.host.panel.title })).not.toBeNull()

    await userEvent.click(within(banner).getByRole('button', { name: en.common.retry }))
    expect(await screen.findByRole('link', { name: /Back again/ })).not.toBeNull()
  })

  it('403 reads the same: the panel never takes the host page down with a permission screen', async () => {
    serve({ 'GET /hosts/:app/:type/:id/meetings': () => ({ status: 403, body: problem(403) }) })
    await renderPanel()
    expect(await screen.findByTestId('meetings-host-unavailable')).not.toBeNull()
  })

  it('a host that could not be asked for its readers adds a note, and never a count of what is hidden (AC-11.2)', async () => {
    serve({
      'GET /hosts/:app/:type/:id/meetings': () => ({
        status: 200,
        body: { ...page([meetingRow({ title: 'Mine' })], 1), hostReadersUnavailable: true },
      }),
    })
    await renderPanel()
    expect(await screen.findByText(en.host.panel.someHidden)).not.toBeNull()
    expect(screen.getByRole('link', { name: /Mine/ })).not.toBeNull()
    const text = screen.getByTestId('meetings-host-panel').textContent ?? ''
    expect(text).not.toMatch(/hidden|\bmore\b|\d+ (other|meetings)/i)
  })

  it('the note is absent when the host answered', async () => {
    serve()
    await renderPanel()
    await screen.findByRole('link', { name: /Kick-off/ })
    expect(screen.queryByText(en.host.panel.someHidden)).toBeNull()
  })
})

describe('Link an existing meeting (G2, F1b)', () => {
  const LINKABLE = [
    meetingRow({ id: 'a', title: 'Standalone sync', host: null }),
    meetingRow({
      id: 'b',
      title: 'Other deal call',
      host: hostView({ entityId: 'd2', title: 'Globex renewal', href: '/crm/deals/d2' }),
    }),
    meetingRow({
      id: 'c',
      title: 'Closed deal call',
      host: hostView({ entityId: 'd3', state: 'closed', title: null, href: null }),
    }),
  ]

  const open = async (routes: Parameters<typeof fakeApi>[0] = {}) => {
    const api = serve({
      'GET /hosts/:app/:type/:id/linkable-meetings': () => ({ status: 200, body: page(LINKABLE) }),
      ...routes,
    })
    await renderPanel()
    await screen.findByRole('link', { name: /Kick-off/ })
    await userEvent.click(linkButton()!)
    const dialog = await screen.findByRole('dialog', { name: en.host.dialog.title })
    return { api, dialog }
  }

  const submit = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: en.host.dialog.submit })

  it('lists the caller’s own meetings with where each is now, from the linkable route', async () => {
    const { api, dialog } = await open()

    await within(dialog).findByRole('radio', { name: /Standalone sync/ })
    expect(api).toHaveBeenCalledWith(
      'http://meetings-api.test/hosts/crm/deal/d1/linkable-meetings?page=1',
      expect.anything(),
    )
    expect(within(dialog).getByRole('radio', { name: /Standalone sync.*Standalone/ })).not.toBeNull()
    expect(within(dialog).getByRole('radio', { name: /Other deal call.*Deal · Globex renewal/ })).not.toBeNull()
    expect(within(dialog).getByRole('radio', { name: /Closed deal call.*CRM · deal/ })).not.toBeNull()
    // the search field has the focus first
    expect(document.activeElement).toBe(within(dialog).getByRole('searchbox', { name: en.host.dialog.search }))
  })

  it('Link meeting is disabled until a meeting is chosen', async () => {
    const { dialog } = await open()
    await within(dialog).findByRole('radio', { name: /Standalone sync/ })
    expect((submit(dialog) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(within(dialog).getByRole('radio', { name: /Standalone sync/ }))
    expect((submit(dialog) as HTMLButtonElement).disabled).toBe(false)
  })

  it('chooses one, sends the current host reference to the meeting, and refreshes the list (AC-1.7)', async () => {
    let linked = false
    const { dialog } = await open({
      'GET /hosts/:app/:type/:id/meetings': () => ({
        status: 200,
        body: page(linked ? [meetingRow({ id: 'a', title: 'Standalone sync' }), meetingRow()] : [meetingRow()]),
      }),
      'PATCH /meetings/:id': () => {
        linked = true
        return { status: 200, body: meeting({ id: 'a' }) }
      },
    })
    await userEvent.click(await within(dialog).findByRole('radio', { name: /Standalone sync/ }))
    await userEvent.click(submit(dialog))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const [patch] = requests('PATCH', /\/meetings\/a$/)
    expect(patch!.body).toEqual({ host: { app: 'crm', entityType: 'deal', entityId: 'd1' } })

    const row = await screen.findByRole('link', { name: /Standalone sync/ })
    expect(screen.getByText(en.host.panel.linked)).not.toBeNull()
    // focus lands on the row that was just added
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  it('a meeting on another record says it will be moved', async () => {
    const { dialog } = await open()
    await userEvent.click(await within(dialog).findByRole('radio', { name: /Other deal call/ }))
    expect(within(dialog).getByText(en.host.dialog.moved('Deal · Globex renewal', 'deal'))).not.toBeNull()

    await userEvent.click(within(dialog).getByRole('radio', { name: /Standalone sync/ }))
    expect(within(dialog).queryByText(/will be moved/)).toBeNull()
  })

  it('searches by title after a pause, and offers a pager beyond 25', async () => {
    const { dialog } = await open({
      'GET /hosts/:app/:type/:id/linkable-meetings': () => ({ status: 200, body: page(LINKABLE, 60) }),
    })
    await within(dialog).findByRole('radio', { name: /Standalone sync/ })
    expect(within(dialog).getByText('Page 1 of 3 — showing 1–25 of 60')).not.toBeNull()

    await userEvent.type(within(dialog).getByRole('searchbox', { name: en.host.dialog.search }), 'globex')
    await waitFor(() =>
      expect(requests('GET', /linkable-meetings/).some((r) => r.url.searchParams.get('q') === 'globex')).toBe(true),
    )
    const last = requests('GET', /linkable-meetings/).at(-1)!
    expect(last.url.searchParams.get('page')).toBe('1')
  })

  it('nothing to link: says who can be linked, with Cancel to leave', async () => {
    const { dialog } = await open({
      'GET /hosts/:app/:type/:id/linkable-meetings': () => ({ status: 200, body: page([]) }),
    })
    expect(await within(dialog).findByRole('heading', { name: en.host.dialog.empty.title })).not.toBeNull()
    expect(within(dialog).getByText(en.host.dialog.empty.body('deal'))).not.toBeNull()
    expect((submit(dialog) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed list is a warning with Retry, inside the dialog', async () => {
    let attempt = 0
    const { dialog } = await open({
      'GET /hosts/:app/:type/:id/linkable-meetings': () => {
        attempt += 1
        return attempt === 1 ? { status: 500, body: problem(500) } : { status: 200, body: page(LINKABLE) }
      },
    })
    const banner = await within(dialog).findByTestId('meetings-load-error')
    await userEvent.click(within(banner).getByRole('button', { name: en.common.retry }))
    expect(await within(dialog).findByRole('radio', { name: /Standalone sync/ })).not.toBeNull()
  })

  it('403 on the list is the permission-denied panel inside the dialog; 503 is the authorization banner', async () => {
    const denied = await open({
      'GET /hosts/:app/:type/:id/linkable-meetings': () => ({
        status: 403,
        body: problem(403, 'meetings_access_required'),
      }),
    })
    expect(await within(denied.dialog).findByTestId('meetings-permission-denied')).not.toBeNull()
    cleanup()
    vi.mocked(apiFetch).mockReset()

    const down = await open({
      'GET /hosts/:app/:type/:id/linkable-meetings': () => ({ status: 503, body: problem(503) }),
    })
    expect(await within(down.dialog).findByText(en.common.authUnavailable.heading)).not.toBeNull()
  })

  describe('when linking is refused', () => {
    const choose = async (routes: Parameters<typeof fakeApi>[0]) => {
      const { dialog } = await open(routes)
      await userEvent.click(await within(dialog).findByRole('radio', { name: /Standalone sync/ }))
      await userEvent.click(submit(dialog))
      return dialog
    }

    it.each([
      ['host_entity_not_found', 422, en.host.dialog.errors.cannotLink],
      ['host_not_registered', 422, en.host.dialog.errors.cannotLink],
    ])(
      '%s: "You can’t link to this item" — the same words for missing and closed (AC-1.5)',
      async (code, status, message) => {
        const dialog = await choose({ 'PATCH /meetings/:id': () => ({ status, body: problem(status, code) }) })
        const alert = await within(dialog).findByText(message)
        expect(alert.getAttribute('role')).toBe('alert')
        expect(screen.getByRole('dialog')).not.toBeNull()
      },
    )

    it('503 host_unavailable: never linked unverified (AC-11.6); the choice is kept for another try', async () => {
      const dialog = await choose({
        'PATCH /meetings/:id': () => ({ status: 503, body: problem(503, 'host_unavailable') }),
      })
      expect(await within(dialog).findByText(en.host.dialog.errors.unavailable('deal'))).not.toBeNull()
      expect((within(dialog).getByRole('radio', { name: /Standalone sync/ }) as HTMLInputElement).checked).toBe(true)
      expect((submit(dialog) as HTMLButtonElement).disabled).toBe(false)
    })

    it('404: the meeting went away meanwhile; the list refreshes and the choice is dropped', async () => {
      const dialog = await choose({ 'PATCH /meetings/:id': () => ({ status: 404, body: problem(404, 'not_found') }) })
      expect(await within(dialog).findByText(en.host.dialog.errors.gone)).not.toBeNull()
      await waitFor(() => expect(requests('GET', /linkable-meetings/).length).toBeGreaterThan(1))
      expect((submit(dialog) as HTMLButtonElement).disabled).toBe(true)
    })

    it('403 frozen: the reason from the server, in the dialog', async () => {
      const dialog = await choose({ 'PATCH /meetings/:id': () => ({ status: 403, body: problem(403, 'frozen') }) })
      expect(await within(dialog).findByText(en.common.errors.frozen)).not.toBeNull()
    })
  })

  it('while the request runs the dialog cannot be dismissed, and cannot send twice', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { dialog } = await open({
      'PATCH /meetings/:id': async () => {
        await gate
        return { status: 200, body: meeting({ id: 'a' }) }
      },
    })
    await userEvent.click(await within(dialog).findByRole('radio', { name: /Standalone sync/ }))
    await userEvent.click(submit(dialog))

    const busy = await within(dialog).findByRole('button', { name: en.host.dialog.busy })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(
      within(dialog)
        .getByRole('radio', { name: /Standalone sync/ })
        .matches(':disabled'),
    ).toBe(true)

    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requests('PATCH', /\/meetings\/a$/)).toHaveLength(1)
  })

  it('Cancel closes without linking and returns focus to the button that opened it', async () => {
    const { dialog } = await open()
    await within(dialog).findByRole('radio', { name: /Standalone sync/ })
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requests('PATCH', /\/meetings\//)).toEqual([])
    expect(document.activeElement).toBe(linkButton())
  })

  describe('the host did not take the notice (AC-14.8)', () => {
    const linkAndFail = async (retry: Parameters<typeof fakeApi>[0] = {}) => {
      const { dialog } = await open({
        'PATCH /meetings/:id': () => ({
          status: 200,
          body: meeting({ id: 'a', hostNotice: { state: 'failed', event: 'linked' } }),
        }),
        ...retry,
      })
      await userEvent.click(await within(dialog).findByRole('radio', { name: /Standalone sync/ }))
      await userEvent.click(submit(dialog))
      return screen.findByTestId('meetings-host-notice-failed')
    }

    it("shows the host's own sentence with Try again, which asks the server again and clears on success", async () => {
      const banner = await linkAndFail({
        'POST /meetings/:id/host-notice/retry': () => ({ status: 200, body: meeting({ id: 'a', hostNotice: null }) }),
      })
      expect(within(banner).getByText("The deal's activity could not be added")).not.toBeNull()

      await userEvent.click(within(banner).getByRole('button', { name: en.host.panel.noticeTryAgain }))
      await waitFor(() => expect(screen.queryByTestId('meetings-host-notice-failed')).toBeNull())
      expect(requests('POST', /\/meetings\/a\/host-notice\/retry$/)).toHaveLength(1)
    })

    it('stays, with the reason, when the retry fails too', async () => {
      const banner = await linkAndFail({
        'POST /meetings/:id/host-notice/retry': () => ({ status: 403, body: problem(403, 'creator_only') }),
      })
      await userEvent.click(within(banner).getByRole('button', { name: en.host.panel.noticeTryAgain }))
      expect(await within(banner).findByText(en.common.errors.creator_only)).not.toBeNull()
    })
  })
})
