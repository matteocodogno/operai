/**
 * @vitest-environment jsdom
 *
 * Tests for HostExtension (specs/20261104-meetings, T51, AC-11.6, ADR 20261104-host-extension-federated-panel-through-the-shell):
 * the seam through which a host (crm-ui's deal page) embeds the Meetings panel.
 * Its one job beyond mounting is to NEVER become the host page's failure: a
 * rejected import, a 5 s timeout, a missing export and a render-time throw all
 * render the host's own `fallback`, and nothing is rethrown (ADR 20260803-suite-version-generated-file-federated-export).
 *
 * The federated module is replaced per test with `vi.doMock` + a fresh import of
 * `./extensions`, the shape router.inventory.test.tsx uses for a failing remote.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { ExtensionProps } from './extensions'

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
  vi.doUnmock('hours/RecordHours')
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

// specs/20261116-record-hours-in-place, T3 (AC-4.5, AC-1.1, AC-2.1, AC-3.1; ADR 20261116-record-hours-widget-through-the-host-extension-seam):
// `hours.recordHours` is hours-ui's own Record hours button, embedded by the project page, the deal page and the
// task rows. Same seam, same failure rule: whatever goes wrong on hours-ui's side shows the HOST's fallback (a
// link to My hours), never a broken page. Each test asserts that the federated module was actually asked for, so
// none can pass by way of the "unknown extension name" fallback.
type RecordHoursProps = ExtensionProps['hours.recordHours']

const RECORD_PROPS: RecordHoursProps = {
  on: 'project',
  targetId: 'project-1',
  targetName: 'Atlas',
  activityId: 'task-9',
  activityName: 'Write the API',
  placement: 'row',
}

const myHoursLink = (
  <a data-testid="fallback" href="/hours">
    My hours
  </a>
)

describe('ExtensionProps["hours.recordHours"] — the contract is six strings and nothing else', () => {
  it('has exactly the members of plan § "The shell\'s extension", all strings or string unions', () => {
    // Checked by `tsc -b` (the build), not at run time: an extra, a missing or a retyped member fails the build.
    expectTypeOf<RecordHoursProps>().toEqualTypeOf<{
      on: 'project' | 'deal' | 'none'
      targetId: string
      targetName: string
      activityId: string
      activityName: string
      placement: 'page' | 'row'
    }>()
    expectTypeOf<RecordHoursProps[keyof RecordHoursProps]>().toBeString()
  })
})

describe('HostExtension — hours.recordHours', () => {
  it('imports hours/RecordHours and renders it with exactly the six props, nothing else', async () => {
    const seen = vi.fn()
    const factory = vi.fn(() => ({
      default: (props: RecordHoursProps) => {
        seen(props)
        return <p data-testid="panel">Record hours on {props.targetName}</p>
      },
    }))
    vi.doMock('hours/RecordHours', factory)
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="hours.recordHours" props={RECORD_PROPS} fallback={myHoursLink} />)
    await flush()

    expect(factory).toHaveBeenCalled()
    expect(screen.getByTestId('panel').textContent).toBe('Record hours on Atlas')
    expect(seen).toHaveBeenCalledWith(RECORD_PROPS)
    expect(Object.keys(seen.mock.calls[0]?.[0] as object).sort()).toEqual([
      'activityId',
      'activityName',
      'on',
      'placement',
      'targetId',
      'targetName',
    ])
    expect(screen.queryByTestId('fallback')).toBeNull()
  })

  it('renders nothing while the remote loads (the host passes no `loading`) and leaves no timer once loaded', async () => {
    const factory = vi.fn(() => ({ default: () => <p data-testid="panel">Record hours</p> }))
    vi.doMock('hours/RecordHours', factory)
    const { HostExtension } = await loadHostExtension()

    const { container } = render(<HostExtension name="hours.recordHours" props={RECORD_PROPS} fallback={myHoursLink} />)
    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('fallback')).toBeNull()

    await flush()
    expect(factory).toHaveBeenCalled()
    expect(screen.getByTestId('panel')).toBeDefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a rejected import (hours remote down, or one that predates the expose) shows the host fallback (AC-4.5)', async () => {
    const factory = vi.fn(() => {
      throw new Error('Failed to fetch remoteEntry.js')
    })
    vi.doMock('hours/RecordHours', factory)
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="hours.recordHours" props={RECORD_PROPS} fallback={myHoursLink} />)
    await flush()

    expect(factory).toHaveBeenCalled()
    expect(screen.getByTestId('fallback').textContent).toBe('My hours')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a remote that never answers shows the host fallback after 5 s, not before (AC-4.5)', async () => {
    const factory = vi.fn(() => new Promise(() => {}))
    vi.doMock('hours/RecordHours', factory)
    const { HostExtension, EXTENSION_TIMEOUT_MS } = await loadHostExtension()
    expect(EXTENSION_TIMEOUT_MS).toBe(5000)

    render(<HostExtension name="hours.recordHours" props={RECORD_PROPS} fallback={myHoursLink} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999)
    })
    expect(factory).toHaveBeenCalled()
    expect(screen.queryByTestId('fallback')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(screen.getByTestId('fallback').textContent).toBe('My hours')
  })

  it('a widget that throws on render (an invalid prop set is a host bug) shows the host fallback and the host page is intact (AC-4.5)', async () => {
    const factory = vi.fn(() => ({
      default: () => {
        throw new Error('invalid RecordHours props')
      },
    }))
    vi.doMock('hours/RecordHours', factory)
    const { HostExtension } = await loadHostExtension()

    expect(() => {
      render(
        <div data-testid="host-page">
          <HostExtension name="hours.recordHours" props={RECORD_PROPS} fallback={myHoursLink} />
        </div>,
      )
    }).not.toThrow()
    await flush()

    expect(factory).toHaveBeenCalled()
    expect(screen.getByTestId('fallback')).toBeDefined()
    expect(screen.getByTestId('host-page')).toBeDefined()
  })

  it('a module without a default export shows the host fallback', async () => {
    const factory = vi.fn(() => ({ somethingElse: 1 }))
    vi.doMock('hours/RecordHours', factory)
    const { HostExtension } = await loadHostExtension()

    render(<HostExtension name="hours.recordHours" props={RECORD_PROPS} fallback={myHoursLink} />)
    await flush()

    expect(factory).toHaveBeenCalled()
    expect(screen.getByTestId('fallback')).toBeDefined()
  })

  it('several instances on one page (a task list) each get their own props, and one that throws blanks only itself', async () => {
    const factory = vi.fn(() => ({
      default: (props: RecordHoursProps) => {
        if (props.activityId === 'bad') {
          throw new Error('bad row')
        }
        return <p data-testid="panel">Record hours on {props.activityName}</p>
      },
    }))
    vi.doMock('hours/RecordHours', factory)
    const { HostExtension } = await loadHostExtension()
    const row = (activityId: string, activityName: string) => (
      <li key={activityId}>
        <HostExtension
          name="hours.recordHours"
          props={{ ...RECORD_PROPS, activityId, activityName }}
          fallback={myHoursLink}
        />
      </li>
    )

    // One row is mounted and loaded before the next arrives: under vitest only the first of several CONCURRENT
    // imports of one `doMock`ed specifier gets the factory's module (in the browser Module Federation
    // de-duplicates the load), so a list that mounts every row in one tick cannot be reproduced here.
    const rows = [row('task-1', 'First task'), row('bad', 'Broken task'), row('task-3', 'Third task')]
    const { rerender } = render(<ul>{rows.slice(0, 1)}</ul>)
    await flush()
    for (const count of [2, 3]) {
      rerender(<ul>{rows.slice(0, count)}</ul>)
      await flush()
    }

    expect(factory).toHaveBeenCalled()
    expect(screen.getAllByTestId('panel').map((node) => node.textContent)).toEqual([
      'Record hours on First task',
      'Record hours on Third task',
    ])
    expect(screen.getAllByTestId('fallback')).toHaveLength(1)
  })
})
