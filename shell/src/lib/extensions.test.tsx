/**
 * @vitest-environment jsdom
 *
 * Tests for HostExtension (specs/021-meetings, T51, AC-11.6, ADR-0060):
 * the seam through which a host (crm-ui's deal page) embeds the Meetings panel.
 * Its one job beyond mounting is to NEVER become the host page's failure: a
 * rejected import, a 5 s timeout, a missing export and a render-time throw all
 * render the host's own `fallback`, and nothing is rethrown (ADR-0030).
 *
 * The federated module is replaced per test with `vi.doMock` + a fresh import of
 * `./extensions`, the shape router.inventory.test.tsx uses for a failing remote.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'

type HostProps = { hostApp: string; entityType: string; entityId: string }

const PROPS: HostProps = { hostApp: 'crm', entityType: 'deal', entityId: 'deal-1' }

const fallback = <p data-testid="fallback">Meetings are unavailable</p>
const loading = <p data-testid="loading">Loading meetings</p>

async function loadHostExtension() {
  return (await import('./extensions')) as typeof import('./extensions')
}

function mockPanel(Panel: ComponentType<HostProps>) {
  vi.doMock('meetings/HostMeetings', () => ({ default: Panel }))
}

/** Lets the dynamic import and the state updates it triggers settle. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.doUnmock('meetings/HostMeetings')
})

describe('HostExtension — the happy path', () => {
  it('shows `loading` while the remote loads, then mounts the panel with the three string props', async () => {
    const seen = vi.fn()
    mockPanel((props) => {
      seen(props)
      return <p data-testid="panel">Panel for {props.entityId}</p>
    })
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />)
    expect(screen.getByTestId('loading')).toBeDefined()

    await flush()

    expect(screen.getByTestId('panel').textContent).toBe('Panel for deal-1')
    expect(seen).toHaveBeenCalledWith(PROPS)
    expect(screen.queryByTestId('loading')).toBeNull()
    expect(screen.queryByTestId('fallback')).toBeNull()
  })

  it('renders nothing while loading when no `loading` is given', async () => {
    mockPanel(() => <p data-testid="panel">Panel</p>)
    const { HostExtension } = await loadHostExtension()

    const { container } = render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} />)

    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('fallback')).toBeNull()

    await flush()
    expect(screen.getByTestId('panel')).toBeDefined()
  })

  it('leaves no timer running once the panel has loaded', async () => {
    mockPanel(() => <p data-testid="panel">Panel</p>)
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} />)
    await flush()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('HostExtension — every failure renders the host fallback and never rethrows (AC-11.6)', () => {
  it('a rejected import (remote down, version skew) renders the fallback', async () => {
    vi.doMock('meetings/HostMeetings', () => {
      throw new Error('Failed to fetch remoteEntry.js')
    })
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />)
    await flush()

    expect(screen.getByTestId('fallback')).toBeDefined()
    expect(screen.queryByTestId('loading')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a remote that never answers renders the fallback after 5 s, not before', async () => {
    vi.doMock('meetings/HostMeetings', () => new Promise(() => {}))
    const { HostExtension, EXTENSION_TIMEOUT_MS } = await loadHostExtension()
    expect(EXTENSION_TIMEOUT_MS).toBe(5000)

    render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999)
    })
    expect(screen.getByTestId('loading')).toBeDefined()
    expect(screen.queryByTestId('fallback')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(screen.getByTestId('fallback')).toBeDefined()
    expect(screen.queryByTestId('loading')).toBeNull()
  })

  it('a module without the export renders the fallback', async () => {
    vi.doMock('meetings/HostMeetings', () => ({ somethingElse: 1 }))
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />)
    await flush()

    expect(screen.getByTestId('fallback')).toBeDefined()
  })

  it('a default export that is not a component renders the fallback', async () => {
    vi.doMock('meetings/HostMeetings', () => ({ default: 'not a component' }))
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />)
    await flush()

    expect(screen.getByTestId('fallback')).toBeDefined()
  })

  it('a panel that throws on render renders the fallback (error boundary) and the throw does not escape', async () => {
    mockPanel(() => {
      throw new Error('render bug in the panel')
    })
    const { HostExtension } = await loadHostExtension()

    expect(() => {
      render(
        <div data-testid="host-page">
          <HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />
        </div>,
      )
    }).not.toThrow()
    await flush()

    expect(screen.getByTestId('fallback')).toBeDefined()
    // The host page around the extension is intact.
    expect(screen.getByTestId('host-page')).toBeDefined()
  })

  it('an extension name this shell does not know renders the fallback', async () => {
    const { HostExtension } = await loadHostExtension()

    render(
      <HostExtension
        // A host newer than this shell: cast past the compile-time contract on purpose.
        name={'meetings.somethingNew' as 'meetings.hostMeetings'}
        props={PROPS}
        fallback={fallback}
        loading={loading}
      />,
    )
    await flush()

    expect(screen.getByTestId('fallback')).toBeDefined()
  })

  it('a late resolution after the timeout does not replace the fallback with the panel', async () => {
    let resolveModule: (value: { default: ComponentType<HostProps> }) => void = () => {}
    vi.doMock(
      'meetings/HostMeetings',
      () =>
        new Promise((resolve) => {
          resolveModule = resolve
        }),
    )
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByTestId('fallback')).toBeDefined()

    await act(async () => {
      resolveModule({ default: () => <p data-testid="panel">Late panel</p> })
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByTestId('fallback')).toBeDefined()
    expect(screen.queryByTestId('panel')).toBeNull()
  })

  it('unmounting while the remote is loading is silent: no timer left, no late state update', async () => {
    vi.doMock('meetings/HostMeetings', () => new Promise(() => {}))
    const { HostExtension } = await loadHostExtension()

    const { unmount } = render(
      <HostExtension name="meetings.hostMeetings" props={PROPS} fallback={fallback} loading={loading} />,
    )
    unmount()

    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('HostExtension — a new entity gets a fresh panel', () => {
  it('after a render failure for one entity, another entity mounts the panel again', async () => {
    mockPanel((props) => {
      if (props.entityId === 'bad') {
        throw new Error('bad deal')
      }
      return <p data-testid="panel">ok {props.entityId}</p>
    })
    const { HostExtension } = await loadHostExtension()

    const { rerender } = render(
      <HostExtension
        name="meetings.hostMeetings"
        props={{ ...PROPS, entityId: 'bad' }}
        fallback={fallback}
        loading={loading}
      />,
    )
    await flush()
    expect(screen.getByTestId('fallback')).toBeDefined()

    rerender(
      <HostExtension
        name="meetings.hostMeetings"
        props={{ ...PROPS, entityId: 'good' }}
        fallback={fallback}
        loading={loading}
      />,
    )
    await flush()

    expect(screen.getByTestId('panel').textContent).toBe('ok good')
  })
})
