/**
 * @vitest-environment jsdom
 *
 * MeetingsSection (specs/021 AC-11.2, AC-11.6; ADR-0060, ADR-0030): the deal
 * page's Meetings section is Meetings' own panel, loaded through
 * `shell/extensions`. crm-ui imports the seam dynamically and keeps its own
 * fallback, so a shell that predates the expose, a failing import or a panel
 * that cannot load never takes the deal page down.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

type Rendered = { name: string; props: unknown }
const rendered: Rendered[] = []

const hostExtension = ({ name, props }: { name: string; props: unknown; fallback: ReactNode; loading?: ReactNode }) => {
  rendered.push({ name, props })
  return createElement('div', { 'data-testid': 'host-extension' }, 'panel')
}

/** Load MeetingsSection against a freshly mocked `shell/extensions`. */
const load = async (factory: () => Record<string, unknown>) => {
  vi.resetModules()
  vi.doMock('shell/extensions', factory)
  return (await import('./MeetingsSection')).default
}

beforeEach(() => {
  rendered.length = 0
})

afterEach(() => {
  cleanup()
  vi.doUnmock('shell/extensions')
})

describe('MeetingsSection', () => {
  it('shows the loading card, then hands the deal to HostExtension as {hostApp, entityType, entityId}', async () => {
    const MeetingsSection = await load(() => ({ HostExtension: hostExtension }))
    render(<MeetingsSection dealId="d1" />)

    expect(screen.getByRole('heading', { name: 'Meetings' })).not.toBeNull()
    expect(screen.getByText('Loading meetings…')).not.toBeNull()

    await screen.findByTestId('host-extension')
    expect(rendered).toEqual([
      { name: 'meetings.hostMeetings', props: { hostApp: 'crm', entityType: 'deal', entityId: 'd1' } },
    ])
  })

  it('passes a fallback carrying the same heading, so the remote failing later still leaves the section', async () => {
    let seen: ReactNode = null
    const MeetingsSection = await load(() => ({
      HostExtension: ({ fallback }: { fallback: ReactNode }) => {
        seen = fallback
        return null
      },
    }))
    render(<MeetingsSection dealId="d1" />)
    await waitFor(() => expect(seen).not.toBeNull())
    cleanup()
    render(<>{seen}</>)
    expect(screen.getByRole('heading', { name: 'Meetings' })).not.toBeNull()
    expect(screen.getByText('Meetings are unavailable. Reload the page to try again.')).not.toBeNull()
  })

  it('a rejected import of shell/extensions shows the fallback with the same heading (AC-11.6)', async () => {
    const MeetingsSection = await load(() => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    render(<MeetingsSection dealId="d1" />)

    expect(await screen.findByText('Meetings are unavailable. Reload the page to try again.')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Meetings' })).not.toBeNull()
    expect(screen.queryByText('Loading meetings…')).toBeNull()
    expect(screen.queryByTestId('host-extension')).toBeNull()
  })

  it('a shell whose module lacks HostExtension shows the fallback instead of throwing', async () => {
    const MeetingsSection = await load(() => ({}))
    render(<MeetingsSection dealId="d1" />)
    expect(await screen.findByText('Meetings are unavailable. Reload the page to try again.')).not.toBeNull()
  })

  it('a HostExtension that throws while rendering is contained to the section', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const MeetingsSection = await load(() => ({
      HostExtension: () => {
        throw new Error('boom')
      },
    }))
    render(
      <div>
        <p>rest of the page</p>
        <MeetingsSection dealId="d1" />
      </div>,
    )
    expect(await screen.findByText('Meetings are unavailable. Reload the page to try again.')).not.toBeNull()
    expect(screen.getByText('rest of the page')).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    spy.mockRestore()
    warn.mockRestore()
  })

  it('unmounting before the import settles does not update state', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const MeetingsSection = await load(() => ({ HostExtension: hostExtension }))
    const view = render(<MeetingsSection dealId="d1" />)
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rendered).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
