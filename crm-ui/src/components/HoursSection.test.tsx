/**
 * @vitest-environment jsdom
 *
 * HoursSection (specs/20261112-project-hours AC-2.2, AC-2.4, AC-2.6, AC-3.2; design S2; plan D-P4): the deal page's ONE
 * "Hours" card holds hours-ui's read panel alone, loaded through `shell/extensions` as `hours.hostHours` with
 * `{ on: 'deal', targetId }`. The card keeps its title whatever happens to the remote: a shell that predates the
 * expose, a failing import, a module without `HostExtension` or a widget that throws shows the slot's "Hours are
 * unavailable" notice INSIDE the card, and the rest of the page is unaffected (AC-2.6).
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'

type Rendered = { name: string; props: unknown; resetKey?: string }
const rendered: Rendered[] = []

const hostExtension = ({
  name,
  props,
  resetKey,
}: {
  name: string
  props: unknown
  fallback: ReactNode
  loading?: ReactNode
  resetKey?: string
}) => {
  rendered.push({ name, props, resetKey })
  return createElement('div', { 'data-testid': 'host-extension' }, 'panel')
}

/** Load HoursSection against a freshly mocked `shell/extensions`. */
const load = async (factory: () => Record<string, unknown>) => {
  vi.resetModules()
  vi.doMock('shell/extensions', factory)
  return (await import('./HoursSection')).default
}

const UNAVAILABLE = 'Hours are unavailable. Reload the page to try again.'

beforeEach(() => {
  rendered.length = 0
})

afterEach(() => {
  cleanup()
  vi.doUnmock('shell/extensions')
})

describe('HoursSection', () => {
  it('shows the card with its title and the loading line, then hands the deal to HostExtension as { on, targetId } and nothing else', async () => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection dealId="d1" />)

    expect(screen.getByRole('heading', { level: 3, name: 'Hours' })).not.toBeNull()
    expect(screen.getByText('Loading hours…')).not.toBeNull()

    await screen.findByTestId('host-extension')
    expect(rendered).toEqual([{ name: 'hours.hostHours', props: { on: 'deal', targetId: 'd1' }, resetKey: 'd1' }])
    expect(screen.queryByText('Loading hours…')).toBeNull()
  })

  it('is one card, found by its test id, with the panel inside it (cards are never nested)', async () => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection dealId="d1" />)

    const card = await screen.findByTestId('crm-deal-hours')
    expect(within(card).getByTestId('host-extension')).not.toBeNull()
    expect(within(card).getAllByRole('heading')).toHaveLength(1)
    expect(card.querySelector('[data-testid="crm-deal-hours"]')).toBeNull()
  })

  it('passes the slot a fallback that says hours are unavailable, so the remote failing later still leaves the card', async () => {
    let seen: ReactNode = null
    const HoursSection = await load(() => ({
      HostExtension: ({ fallback }: { fallback: ReactNode }) => {
        seen = fallback
        return fallback
      },
    }))
    render(<HoursSection dealId="d1" />)

    await waitFor(() => expect(seen).not.toBeNull())
    const card = screen.getByTestId('crm-deal-hours')
    expect(within(card).getByRole('heading', { name: 'Hours' })).not.toBeNull()
    expect(within(card).getByTestId('crm-deal-hours-unavailable').textContent).toBe(UNAVAILABLE)
  })

  it('a rejected import of shell/extensions shows the notice inside the card, with the title (AC-2.6)', async () => {
    const HoursSection = await load(() => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    render(<HoursSection dealId="d1" />)

    expect(await screen.findByText(UNAVAILABLE)).not.toBeNull()
    expect(within(screen.getByTestId('crm-deal-hours')).getByRole('heading', { name: 'Hours' })).not.toBeNull()
    expect(screen.queryByText('Loading hours…')).toBeNull()
    expect(screen.queryByTestId('host-extension')).toBeNull()
  })

  it('a shell whose module lacks HostExtension shows the notice instead of throwing', async () => {
    const HoursSection = await load(() => ({}))
    render(<HoursSection dealId="d1" />)

    expect(await screen.findByText(UNAVAILABLE)).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Hours' })).not.toBeNull()
  })

  it('a HostExtension that throws while rendering is contained to the card; the page around it renders (AC-2.6)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const HoursSection = await load(() => ({
      HostExtension: () => {
        throw new Error('boom')
      },
    }))
    render(
      <div>
        <p>rest of the page</p>
        <HoursSection dealId="d1" />
      </div>,
    )

    expect(await screen.findByText(UNAVAILABLE)).not.toBeNull()
    expect(within(screen.getByTestId('crm-deal-hours')).getByRole('heading', { name: 'Hours' })).not.toBeNull()
    expect(screen.getByText('rest of the page')).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    error.mockRestore()
    warn.mockRestore()
  })

  it('after a failure for one deal, another deal tries the widget again (resetKey = the deal id)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const HoursSection = await load(() => ({
      HostExtension: ({ props }: { props: { targetId: string } }) => {
        if (props.targetId === 'bad') throw new Error('bad deal')
        return createElement('div', { 'data-testid': 'host-extension' }, props.targetId)
      },
    }))
    const view = render(<HoursSection dealId="bad" />)
    expect(await screen.findByText(UNAVAILABLE)).not.toBeNull()

    view.rerender(<HoursSection dealId="good" />)

    expect((await screen.findByTestId('host-extension')).textContent).toBe('good')
    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
    error.mockRestore()
    warn.mockRestore()
  })

  it('unmounting before the import settles does not update state', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    const view = render(<HoursSection dealId="d1" />)
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(rendered).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
