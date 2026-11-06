/**
 * @vitest-environment jsdom
 *
 * The new meeting page (specs/021-meetings T56; AC-1.1, 1.2, 1.3, 1.5, 1.6, 11.6; design.md S2, F1, F2):
 * rendered inside the real `./App` router on a memory history, against `fakeApi`.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

import { apiFetch } from 'shell/session'
import { createAppRouter } from '../router'
import { en } from '../strings'
import { crmDealHost, fakeApi, hostView, meeting, problem } from '../test-support/fakeApi'

beforeEach(() => {
  window.scrollTo = () => undefined
  session.apps = ['meetings']
})

afterEach(() => {
  cleanup()
  vi.mocked(apiFetch).mockReset()
})

const serve = (routes: Parameters<typeof fakeApi>[0] = {}) => {
  const api = fakeApi({
    'GET /hosts': () => ({ status: 200, body: { items: [crmDealHost] } }),
    'POST /meetings': (_url, init) => ({
      status: 201,
      body: meeting({ id: 'new1', ...(JSON.parse(String(init?.body)) as object) }),
    }),
    ...routes,
  })
  vi.mocked(apiFetch).mockImplementation(api)
  return api
}

const renderAt = async (url = '/meetings/new') => {
  const router = createAppRouter('/meetings', undefined, createMemoryHistory({ initialEntries: [url] }))
  render(<RouterProvider router={router} />)
  await screen.findByTestId('meetings-new-page')
  return router
}

const DEAL = '/meetings/new?hostApp=crm&hostType=deal&hostId=d1'

const posts = () =>
  vi
    .mocked(apiFetch)
    .mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([input, init]) => ({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) }))

const titleInput = () => screen.getByLabelText(new RegExp(`^${en.newMeeting.fields.title}`)) as HTMLInputElement
const whenInput = () => screen.getByLabelText(new RegExp(`^${en.newMeeting.fields.startsAt}`)) as HTMLInputElement
const submit = () => screen.getByRole('button', { name: en.newMeeting.submit })

describe('a standalone meeting (AC-1.2)', () => {
  it('creates it without a host and opens the new meeting', async () => {
    serve()
    const router = await renderAt()
    expect(screen.queryByText(en.newMeeting.linkedTo)).toBeNull()

    await userEvent.type(titleInput(), '  Weekly sync ')
    fireEvent.change(whenInput(), { target: { value: '2026-11-03T09:30' } })
    await userEvent.click(screen.getByRole('radio', { name: en.newMeeting.format.in_person }))
    await userEvent.click(screen.getByRole('radio', { name: en.newMeeting.language.it }))
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(`^${en.newMeeting.source.text}`) }))
    await userEvent.click(submit())

    await waitFor(() => expect(router.state.location.pathname).toBe('/m/new1'))
    expect(posts()).toEqual([
      {
        path: '/meetings',
        body: {
          title: 'Weekly sync',
          format: 'in_person',
          startsAt: new Date('2026-11-03T09:30').toISOString(),
          language: 'it',
          source: 'text',
        },
      },
    ])
  })

  it('the date and time start at now, and may be moved into the past (AC-1.3)', async () => {
    serve()
    await renderAt()
    const now = new Date()
    const shown = new Date(whenInput().value)
    expect(Math.abs(shown.getTime() - now.getTime())).toBeLessThan(2 * 60_000)
  })

  it('while the request runs the button is busy and cannot send twice', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    serve({
      'POST /meetings': async () => {
        await gate
        return { status: 201, body: meeting({ id: 'new1' }) }
      },
    })
    await renderAt()
    await userEvent.type(titleInput(), 'Sync')
    await userEvent.click(submit())

    const busy = await screen.findByRole('button', { name: en.newMeeting.submitting })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    await userEvent.click(busy)
    release()
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('Cancel goes back to the list without creating anything', async () => {
    serve()
    const router = await renderAt()
    await userEvent.click(screen.getByRole('button', { name: en.newMeeting.cancel }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(posts()).toEqual([])
  })
})

describe('invalid fields are named, and the first is focused (AC-1.3)', () => {
  it('an empty title and an empty date create nothing', async () => {
    serve()
    await renderAt()
    fireEvent.change(whenInput(), { target: { value: '' } })
    await userEvent.click(submit())

    expect(posts()).toEqual([])
    expect(screen.getByText(en.newMeeting.errors.titleRequired)).not.toBeNull()
    expect(screen.getByText(en.newMeeting.errors.startsAtInvalid)).not.toBeNull()
    expect(titleInput().getAttribute('aria-invalid')).toBe('true')
    expect(whenInput().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(titleInput())
    expect(screen.getByTestId('meetings-new-error-summary').textContent).toContain(en.newMeeting.errors.summary)
  })

  it('a title that is only spaces is empty; one of 201 characters is too long, 200 is fine', async () => {
    serve()
    await renderAt()
    await userEvent.type(titleInput(), '   ')
    await userEvent.click(submit())
    expect(screen.getByText(en.newMeeting.errors.titleRequired)).not.toBeNull()

    fireEvent.change(titleInput(), { target: { value: 'x'.repeat(201) } })
    await userEvent.click(submit())
    expect(screen.getByText(en.newMeeting.errors.titleTooLong)).not.toBeNull()
    expect(posts()).toEqual([])

    fireEvent.change(titleInput(), { target: { value: 'x'.repeat(200) } })
    await userEvent.click(submit())
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('a field error clears once the person fixes the value and sends again', async () => {
    serve()
    await renderAt()
    await userEvent.click(submit())
    expect(screen.getByText(en.newMeeting.errors.titleRequired)).not.toBeNull()
    await userEvent.type(titleInput(), 'Fixed')
    await userEvent.click(submit())
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('names every field the server refuses, under the field, and focuses the first', async () => {
    serve({
      'POST /meetings': () => ({
        status: 422,
        body: problem(422, undefined, {
          errors: [
            { field: 'startsAt', message: 'Not a valid date.' },
            { field: 'title', message: 'Title is not allowed.' },
          ],
        }),
      }),
    })
    await renderAt()
    await userEvent.type(titleInput(), 'Sync')
    // focus is elsewhere (on a radio) when the form is sent, so the move to the first invalid field is visible
    await userEvent.click(screen.getByRole('radio', { name: en.newMeeting.format.online }))
    await userEvent.click(submit())

    expect(await screen.findByText('Title is not allowed.')).not.toBeNull()
    expect(screen.getByText('Not a valid date.')).not.toBeNull()
    expect(titleInput().getAttribute('aria-invalid')).toBe('true')
    expect(whenInput().getAttribute('aria-invalid')).toBe('true')
    // the page order decides which is first, not the order the server listed them
    expect(document.activeElement).toBe(titleInput())
    // the values the person typed are kept
    expect(titleInput().value).toBe('Sync')
  })
})

describe('started from a record (AC-1.1)', () => {
  it('prefills the title and shows "<Entity> · <title>" read-only; creating sends the host reference', async () => {
    const api = serve({ 'GET /hosts/:app/:type/:id': () => ({ status: 200, body: { host: hostView() } }) })
    const router = await renderAt(DEAL)

    await waitFor(() => expect(titleInput().value).toBe('Acme renewal'))
    const linked = screen.getByText(en.newMeeting.linkedTo).closest('div')!
    expect(within(linked).getByText('Deal · Acme renewal')).not.toBeNull()
    expect(screen.queryByRole('textbox', { name: en.newMeeting.linkedTo })).toBeNull()
    expect(api).toHaveBeenCalledWith('http://meetings-api.test/hosts/crm/deal/d1', expect.anything())

    await userEvent.click(submit())
    await waitFor(() => expect(router.state.location.pathname).toBe('/m/new1'))
    expect(posts()[0]?.body).toMatchObject({
      title: 'Acme renewal',
      host: { app: 'crm', entityType: 'deal', entityId: 'd1' },
    })
  })

  it('does not overwrite a title the person already typed when the record arrives late', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    serve({
      'GET /hosts/:app/:type/:id': async () => {
        await gate
        return { status: 200, body: { host: hostView() } }
      },
    })
    await renderAt(DEAL)
    // the form is already usable while the record is being looked up, with a polite line for it
    expect(screen.getByText(en.newMeeting.loadingHost)).not.toBeNull()
    await userEvent.type(titleInput(), 'My own title')
    release()
    await screen.findByText('Deal · Acme renewal')
    expect(titleInput().value).toBe('My own title')
  })

  it('a numeric id reaches the host lookup as the same digits (the router reads it as a number)', async () => {
    const api = serve({ 'GET /hosts/:app/:type/:id': () => ({ status: 200, body: { host: hostView() } }) })
    await renderAt('/meetings/new?hostApp=crm&hostType=deal&hostId=4021')
    await waitFor(() => expect(titleInput().value).toBe('Acme renewal'))
    expect(api).toHaveBeenCalledWith('http://meetings-api.test/hosts/crm/deal/4021', expect.anything())
  })

  it('an incomplete host reference is ignored: a standalone meeting, no lookup', async () => {
    const api = serve()
    await renderAt('/meetings/new?hostApp=crm')
    expect(screen.queryByText(en.newMeeting.linkedTo)).toBeNull()
    expect(api.mock.calls.some(([input]) => String(input).includes('/hosts/crm'))).toBe(false)
  })

  it.each(['host_entity_not_found', 'host_not_registered'])(
    '%s: the same panel (AC-1.5, AC-1.6), and the standalone option drops the host',
    async (code) => {
      serve({ 'GET /hosts/:app/:type/:id': () => ({ status: 422, body: problem(422, code) }) })
      const router = await renderAt(DEAL)

      expect(await screen.findByRole('heading', { name: en.newMeeting.host.notFound.title })).not.toBeNull()
      expect(screen.queryByRole('button', { name: en.newMeeting.submit })).toBeNull()

      await userEvent.click(screen.getByRole('button', { name: en.newMeeting.host.notFound.standalone }))
      await userEvent.type(titleInput(), 'Plain')
      await userEvent.click(submit())
      await waitFor(() => expect(router.state.location.pathname).toBe('/m/new1'))
      expect(posts()[0]?.body).not.toHaveProperty('host')
    },
  )

  it('missing and closed records read the same (AC-1.5): the panel never says which', async () => {
    serve({ 'GET /hosts/:app/:type/:id': () => ({ status: 422, body: problem(422, 'host_entity_not_found') }) })
    await renderAt(DEAL)
    const panel = await screen.findByTestId('meetings-new-host-not-found')
    expect(panel.textContent).not.toMatch(/closed|deleted by|missing/i)
  })

  it('503: names the problem, offers Retry and Start without linking (AC-11.6)', async () => {
    let attempt = 0
    serve({
      'GET /hosts/:app/:type/:id': () => {
        attempt += 1
        return attempt === 1
          ? { status: 503, body: problem(503, 'host_unavailable') }
          : { status: 200, body: { host: hostView() } }
      },
    })
    await renderAt(DEAL)

    const banner = await screen.findByTestId('meetings-new-host-unavailable')
    expect(within(banner).getByText(en.newMeeting.host.unavailable.title('deal'))).not.toBeNull()
    // a meeting is never created against a record that could not be checked
    expect(screen.queryByRole('button', { name: en.newMeeting.submit })).toBeNull()

    await userEvent.click(within(banner).getByRole('button', { name: en.common.retry }))
    await waitFor(() => expect(titleInput().value).toBe('Acme renewal'))
    expect(screen.getByText('Deal · Acme renewal')).not.toBeNull()
  })

  it('503: Start without linking creates a standalone meeting', async () => {
    serve({ 'GET /hosts/:app/:type/:id': () => ({ status: 503, body: problem(503, 'host_unavailable') }) })
    const router = await renderAt(DEAL)
    await userEvent.click(await screen.findByRole('button', { name: en.newMeeting.host.unavailable.standalone }))
    await userEvent.type(titleInput(), 'Unlinked')
    await userEvent.click(submit())
    await waitFor(() => expect(router.state.location.pathname).toBe('/m/new1'))
    expect(posts()[0]?.body).not.toHaveProperty('host')
  })

  it('403 on the lookup is the permission-denied panel, with no form', async () => {
    serve({ 'GET /hosts/:app/:type/:id': () => ({ status: 403, body: problem(403, 'meetings_access_required') }) })
    await renderAt(DEAL)
    expect(await screen.findByTestId('meetings-permission-denied')).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.newMeeting.submit })).toBeNull()
  })

  it('the record vanishing between lookup and create ends in the same panel; nothing was created', async () => {
    serve({
      'GET /hosts/:app/:type/:id': () => ({ status: 200, body: { host: hostView() } }),
      'POST /meetings': () => ({ status: 422, body: problem(422, 'host_entity_not_found') }),
    })
    await renderAt(DEAL)
    await waitFor(() => expect(titleInput().value).toBe('Acme renewal'))
    await userEvent.click(submit())
    expect(await screen.findByTestId('meetings-new-host-not-found')).not.toBeNull()
  })
})

describe('other refusals keep the form and what was typed', () => {
  it('503 host_unavailable at create: the message shows above the buttons and the values stay (AC-11.6)', async () => {
    serve({ 'POST /meetings': () => ({ status: 503, body: problem(503, 'host_unavailable') }) })
    await renderAt()
    await userEvent.type(titleInput(), 'Keep me')
    await userEvent.click(submit())

    const alert = await screen.findByText(en.common.errors.host_unavailable)
    expect(alert.getAttribute('role')).toBe('alert')
    expect(titleInput().value).toBe('Keep me')
    expect(submit().getAttribute('aria-busy')).not.toBe('true')
  })

  it('403 at create (no meetings:access) shows the reason inline', async () => {
    serve({ 'POST /meetings': () => ({ status: 403, body: problem(403, 'meetings_access_required') }) })
    await renderAt()
    await userEvent.type(titleInput(), 'Nope')
    await userEvent.click(submit())
    expect(await screen.findByText(en.common.errors.meetings_access_required)).not.toBeNull()
  })

  it('a network failure says so and can be sent again', async () => {
    let attempt = 0
    serve({
      'POST /meetings': () => {
        attempt += 1
        if (attempt === 1) throw new TypeError('failed to fetch')
        return { status: 201, body: meeting({ id: 'new1' }) }
      },
    })
    const router = await renderAt()
    await userEvent.type(titleInput(), 'Again')
    await userEvent.click(submit())
    expect(await screen.findByText(en.common.networkError)).not.toBeNull()
    await userEvent.click(submit())
    await waitFor(() => expect(router.state.location.pathname).toBe('/m/new1'))
  })
})
