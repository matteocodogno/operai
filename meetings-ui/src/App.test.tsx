/**
 * @vitest-environment jsdom
 *
 * The three exposed React entries (specs/021-meetings, design.md § Conventions › Frame):
 * `./App` (ToolLayout "Meetings" + TabNav; Erase only for `meeting:erase` holders),
 * `./MyMeetings` (ToolLayout "My meetings", no TabNav) and `./HostMeetings` (a Card, no frame).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const permissions = vi.hoisted(() => ({
  value: {
    epoch: 0,
    apps: ['meetings'],
    roles: [],
    departments: [],
    permissions: [] as { resource: string; action: string }[],
  },
}))

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  navigateSuite: vi.fn(),
  registerNavigationBlocker: vi.fn(() => () => undefined),
  usePermissions: vi.fn(() => permissions.value),
}))

beforeEach(() => {
  // jsdom does not implement scrolling; the router's scroll restoration calls it on navigation.
  window.scrollTo = () => undefined
  permissions.value = { epoch: 0, apps: ['meetings'], roles: [], departments: [], permissions: [] }
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('App (./App, gated)', () => {
  it('mounts MeetingsShell under /meetings: the h1, the section tabs and the routed page', async () => {
    window.history.pushState(null, '', '/meetings')
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Meetings' })).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Meetings sections' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Templates' }).getAttribute('href')).toBe('/meetings/templates')
    expect(await screen.findByTestId('meetings-list-page')).not.toBeNull()
  })

  it('hides the Erase tab from a caller without meeting:erase (a UI hint; the server decides)', async () => {
    window.history.pushState(null, '', '/meetings')
    const { default: App } = await import('./App')

    render(<App />)
    await screen.findByTestId('meetings-list-page')

    expect(screen.queryByRole('link', { name: 'Erase' })).toBeNull()
  })

  it('shows the Erase tab to a meeting:erase holder', async () => {
    permissions.value = { ...permissions.value, permissions: [{ resource: 'meeting', action: 'erase' }] }
    window.history.pushState(null, '', '/meetings')
    const { default: App } = await import('./App')

    render(<App />)

    expect((await screen.findByRole('link', { name: 'Erase' })).getAttribute('href')).toBe('/meetings/erase')
  })
})

describe('MyMeetings (./MyMeetings, ungated)', () => {
  it('mounts under /my-meetings with the "My meetings" h1 and NO section tabs', async () => {
    window.history.pushState(null, '', '/my-meetings')
    const { default: MyMeetings } = await import('./MyMeetings')

    render(<MyMeetings />)

    expect(await screen.findByRole('heading', { level: 1, name: 'My meetings' })).not.toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(await screen.findByTestId('meetings-list-page')).not.toBeNull()
  })
})

describe('HostMeetings (./HostMeetings)', () => {
  it('renders a titled card with no frame of its own (no h1, no navigation)', async () => {
    const { default: HostMeetings } = await import('./host/HostMeetings')

    render(<HostMeetings hostApp="crm" entityType="deal" entityId="d1" />)

    expect(await screen.findByRole('heading', { level: 3, name: 'Meetings' })).not.toBeNull()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
  })
})
