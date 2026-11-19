/**
 * @vitest-environment jsdom
 *
 * RecordHoursAction (specs/20261116-record-hours-in-place AC-4.5, AC-4.6; ADR
 * 20261116-record-hours-widget-through-the-host-extension-seam, ADR 20260803-suite-version-generated-file-federated-export):
 * the host's seam wrapper. Record hours is hours-ui's own widget, loaded through `shell/extensions`; crm-ui imports the
 * seam dynamically and keeps its own fallback — a link to My hours — so a shell that predates the expose, a failing
 * import or a widget that cannot load never takes the page down. Nothing shows while it loads.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { RecordHoursProps } from '../lib/recordHours'

type Rendered = { name: string; props: unknown; hasLoading: boolean }
const rendered: Rendered[] = []

const hostExtension = ({
  name,
  props,
  loading,
}: {
  name: string
  props: unknown
  fallback: ReactNode
  loading?: ReactNode
}) => {
  rendered.push({ name, props, hasLoading: loading !== undefined })
  return createElement('div', { 'data-testid': 'host-extension' }, 'widget')
}

const DEAL_PROPS: RecordHoursProps = {
  on: 'deal',
  targetId: 'd1',
  targetName: 'Platform rebuild',
  activityId: '',
  activityName: '',
  placement: 'page',
}

/** Load RecordHoursAction against a freshly mocked `shell/extensions`. */
const load = async (factory: () => Record<string, unknown>) => {
  vi.resetModules()
  vi.doMock('shell/extensions', factory)
  return (await import('./RecordHoursAction')).default
}

beforeEach(() => {
  rendered.length = 0
})

afterEach(() => {
  cleanup()
  vi.doUnmock('shell/extensions')
})

const FALLBACK = 'Record hours in My hours'

describe('RecordHoursAction', () => {
  it('shows nothing while the seam loads, then hands the six props to HostExtension as hours.recordHours', async () => {
    const RecordHoursAction = await load(() => ({ HostExtension: hostExtension }))
    const view = render(<RecordHoursAction {...DEAL_PROPS} />)

    // no placeholder, no spinner, no fallback link while loading
    expect(view.container.textContent).toBe('')

    await screen.findByTestId('host-extension')
    expect(rendered).toEqual([{ name: 'hours.recordHours', props: DEAL_PROPS, hasLoading: false }])
  })

  it('passes nothing but the six plain strings across the seam, whatever else the caller spreads in', async () => {
    const RecordHoursAction = await load(() => ({ HostExtension: hostExtension }))
    const extra = { ...DEAL_PROPS, onSaved: () => undefined, 'data-testid': 'nope' } as RecordHoursProps
    render(<RecordHoursAction {...extra} />)

    await screen.findByTestId('host-extension')
    expect(Object.keys(rendered[0]!.props as object).sort()).toEqual([
      'activityId',
      'activityName',
      'on',
      'placement',
      'targetId',
      'targetName',
    ])
  })

  it('passes a fallback that is a link to My hours, so the widget failing later still leaves the offer (AC-4.5)', async () => {
    let seen: ReactNode = null
    const RecordHoursAction = await load(() => ({
      HostExtension: ({ fallback }: { fallback: ReactNode }) => {
        seen = fallback
        return null
      },
    }))
    render(<RecordHoursAction {...DEAL_PROPS} />)
    await waitFor(() => expect(seen).not.toBeNull())
    cleanup()
    render(<>{seen}</>)
    const link = screen.getByRole('link', { name: FALLBACK })
    expect(link.getAttribute('href')).toBe('/hours')
  })

  it('a rejected import of shell/extensions shows the link at once (AC-4.5)', async () => {
    const RecordHoursAction = await load(() => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    render(<RecordHoursAction {...DEAL_PROPS} />)

    const link = await screen.findByRole('link', { name: FALLBACK })
    expect(link.getAttribute('href')).toBe('/hours')
    expect(screen.queryByTestId('host-extension')).toBeNull()
  })

  it('a shell whose module lacks HostExtension shows the link instead of throwing', async () => {
    const RecordHoursAction = await load(() => ({}))
    render(<RecordHoursAction {...DEAL_PROPS} />)
    expect(await screen.findByRole('link', { name: FALLBACK })).not.toBeNull()
  })

  it('a HostExtension that throws while rendering is contained: the link, and the rest of the page stays', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const RecordHoursAction = await load(() => ({
      HostExtension: () => {
        throw new Error('boom')
      },
    }))
    render(
      <div>
        <p>rest of the page</p>
        <RecordHoursAction {...DEAL_PROPS} />
      </div>,
    )
    expect(await screen.findByRole('link', { name: FALLBACK })).not.toBeNull()
    expect(screen.getByText('rest of the page')).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    spy.mockRestore()
    warn.mockRestore()
  })

  it('unmounting before the import settles does not update state', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const RecordHoursAction = await load(() => ({ HostExtension: hostExtension }))
    const view = render(<RecordHoursAction {...DEAL_PROPS} />)
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rendered).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('many rows share one load: a second one mounted later renders the widget without waiting again', async () => {
    const RecordHoursAction = await load(() => ({ HostExtension: hostExtension }))
    const row: RecordHoursProps = { ...DEAL_PROPS, placement: 'row', activityId: 't1', activityName: 'Write the offer' }
    const view = render(<RecordHoursAction {...row} />)
    await screen.findByTestId('host-extension')
    view.rerender(
      <>
        <RecordHoursAction {...row} />
        <RecordHoursAction {...row} activityId="t2" />
      </>,
    )
    // the second mounts already knowing the seam: its widget is in the same commit, no empty beat
    expect(screen.getAllByTestId('host-extension')).toHaveLength(2)
  })
})
