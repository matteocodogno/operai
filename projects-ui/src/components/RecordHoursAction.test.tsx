/**
 * @vitest-environment jsdom
 *
 * RecordHoursAction — the host's seam wrapper for hours-ui's Record hours widget (specs/20261116-record-hours-in-place
 * AC-4.5, ADR 20261116-record-hours-widget-through-the-host-extension-seam; the shape of crm-ui's MeetingsSection). Whatever happens on
 * the far side of `shell/extensions` — a module without the export, a throwing export, a widget that throws while
 * rendering — the page keeps working and shows its own link to My hours where the button would be. Nothing is shown
 * while the seam loads (no placeholder), and the widget gets only the six plain strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import RecordHoursAction from './RecordHoursAction'
import type { RecordHoursProps } from '../lib/recordHours'

type Mode = 'ready' | 'fallsBack' | 'noExport' | 'exportThrows' | 'renderThrows'
const seam = vi.hoisted(() => ({ mode: 'ready' as Mode, received: [] as Array<Record<string, unknown>> }))

vi.mock('shell/extensions', () => {
  // A shell with the widget loaded: it renders its button.
  const Ready = (received: Record<string, unknown>) => {
    seam.received.push(received)
    return <button type="button">widget</button>
  }
  // A shell whose remote failed to load, timed out or threw: it renders the host's fallback, as the real one does.
  const FallsBack = ({ fallback }: { fallback: ReactNode }) => <>{fallback}</>
  const Throws = () => {
    throw new Error('the widget failed to render')
  }
  return {
    get HostExtension() {
      if (seam.mode === 'exportThrows') throw new Error('a module namespace that throws on access')
      if (seam.mode === 'noExport') return undefined
      if (seam.mode === 'fallsBack') return FallsBack
      return seam.mode === 'renderThrows' ? Throws : Ready
    },
  }
})

const PAGE: RecordHoursProps = {
  on: 'project',
  targetId: 'p-1',
  targetName: 'Intranet',
  activityId: '',
  activityName: '',
  placement: 'page',
}

const link = () => screen.queryByRole('link', { name: 'Record hours in My hours' })

beforeEach(() => {
  seam.mode = 'ready'
  seam.received = []
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RecordHoursAction', () => {
  it('shows nothing at all while the seam loads: no placeholder and no link', () => {
    render(<RecordHoursAction {...PAGE} />)
    expect(screen.queryByText('widget')).toBeNull()
    expect(link()).toBeNull()
  })

  it('hands the widget the extension’s name and the six plain strings as they are, and no loading placeholder', async () => {
    render(<RecordHoursAction {...PAGE} />)
    await screen.findByText('widget')
    expect(seam.received).toHaveLength(1)
    expect(seam.received[0]).toEqual({ name: 'hours.recordHours', props: PAGE, fallback: expect.anything() })
    expect(seam.received[0]).not.toHaveProperty('loading')
    // The link is the widget's fallback only: a ready widget shows no link beside it.
    expect(link()).toBeNull()
  })

  it('passes nothing but the six plain strings across the seam, whatever else the caller spreads in (OWASP N1)', async () => {
    // A call site that spreads a wider object (a project with its note, a handler) must not carry it across the seam.
    const extra = {
      ...PAGE,
      note: 'a project note',
      onSaved: () => undefined,
      'data-testid': 'nope',
    } as RecordHoursProps
    render(<RecordHoursAction {...extra} />)

    await screen.findByText('widget')
    expect(Object.keys(seam.received[0]!.props as object).sort()).toEqual([
      'activityId',
      'activityName',
      'on',
      'placement',
      'targetId',
      'targetName',
    ])
    expect(seam.received[0]!.props).toEqual(PAGE)
  })

  it('gives the widget, as its fallback, a link to My hours that is a plain path in the shell (AC-4.5)', async () => {
    seam.mode = 'fallsBack'
    render(<RecordHoursAction {...PAGE} />)
    await waitFor(() => expect(link()).not.toBeNull())
    expect(link()!.getAttribute('href')).toBe('/hours')
  })

  it('draws the page placement’s link as plain link text, and the row’s centred in its actions', async () => {
    seam.mode = 'fallsBack'
    const { unmount } = render(<RecordHoursAction {...PAGE} />)
    await waitFor(() => expect(link()).not.toBeNull())
    expect(link()!.className).toContain('link')
    expect(link()!.className).not.toContain('self-center')
    unmount()

    render(<RecordHoursAction {...PAGE} placement="row" />)
    await waitFor(() => expect(link()).not.toBeNull())
    expect(link()!.className).toContain('link')
    expect(link()!.className).toContain('self-center')
  })

  it('shows the link when the module has no HostExtension (a shell that predates the expose)', async () => {
    seam.mode = 'noExport'
    render(<RecordHoursAction {...PAGE} />)
    await waitFor(() => expect(link()).not.toBeNull())
    expect(screen.queryByText('widget')).toBeNull()
  })

  it('shows the link when reading the export throws', async () => {
    seam.mode = 'exportThrows'
    render(<RecordHoursAction {...PAGE} />)
    await waitFor(() => expect(link()).not.toBeNull())
  })

  it('shows the link when the widget throws while rendering, and nothing else on the page is affected', async () => {
    seam.mode = 'renderThrows'
    render(
      <div>
        <p>the rest of the page</p>
        <RecordHoursAction {...PAGE} />
      </div>,
    )
    await waitFor(() => expect(link()).not.toBeNull())
    expect(screen.getByText('the rest of the page')).not.toBeNull()
  })
})
