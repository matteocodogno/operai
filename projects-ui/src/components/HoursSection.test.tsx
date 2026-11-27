/**
 * @vitest-environment jsdom
 *
 * HoursSection (specs/20261112-project-hours AC-1.1, AC-1.7, AC-2.6, AC-2.8, AC-3.2, AC-4.9; design S1; plan D-P4, D80): the project
 * page's ONE "Hours" card. It owns the whole card — the frame and its title in every state — and holds two parts that
 * fail independently: the consumption block (this app's, from the terms and hours-api's summary) and hours-ui's panel,
 * loaded through `shell/extensions` as `hours.hostHours` with `{ on: 'project', targetId }` and nothing else. Only the
 * panel's slot is swapped for the host's "Hours are unavailable" notice when the remote cannot be had.
 */
import { createElement, useState } from 'react'
import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { fakeApi, problem, termsOf } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import { TIME_ENTRY_RECORDED } from '../lib/timeEntryRecordedEvent'
import type { ProjectState, Terms } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getHoursApiBaseUrl: () => 'http://hours-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

type Rendered = { name: string; props: unknown; resetKey?: string; hasLoading: boolean }
const rendered: Rendered[] = []

type SlotProps = {
  name: string
  props: unknown
  fallback: ReactNode
  loading?: ReactNode
  resetKey?: string
}

/** A panel that records what the card hands it, as the shell's `HostExtension` would. */
const hostExtension = ({ name, props, resetKey, loading }: SlotProps) => {
  rendered.push({ name, props, resetKey, hasLoading: loading !== undefined })
  return createElement('div', { 'data-testid': 'host-hours-panel' }, 'panel')
}

/** Load HoursSection against a freshly mocked `shell/extensions` (the seam's outcome is cached per module load). */
const load = async (factory: () => Record<string, unknown>) => {
  vi.resetModules()
  vi.doMock('shell/extensions', factory)
  return (await import('./HoursSection')).default
}

const UNAVAILABLE = 'Hours are unavailable. Reload the page to try again.'
const SUMMARY = '/time-entries/summary'

const summary = (over: Record<string, unknown> = {}) => ({
  on: { type: 'project', id: 'p1' },
  totalMinutes: 6000,
  windowMinutes: 5070,
  byWorkType: [],
  byPerson: null,
  unavailable: [],
  ...over,
})
const serve = (handler: () => FakeAnswer | Promise<FakeAnswer>) => {
  apiFetch.mockImplementation(fakeApi({ [`GET ${SUMMARY}`]: handler }))
}
const reads = () => apiFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === SUMMARY).length

const yearly = (hours = 120): Terms =>
  termsOf('maintenance', {
    sla: null,
    hourPackage: {
      hours,
      kind: 'yearly',
      startDate: '2026-03-01',
      expiryDate: null,
      currentPeriod: { from: '2026-03-01', to: '2027-02-28', ended: false },
    },
  })
const slaOnly = (): Terms => termsOf('maintenance', { sla: { highDays: 1, normalDays: 3 }, hourPackage: null })
const fixedPrice = (): Terms =>
  termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: 10, maxEffortManDays: 12 })

const card = () => screen.getByTestId('project-hours')
const facts = () => screen.queryByTestId('project-hours-consumption-facts')
const blockBanner = () => screen.queryByTestId('project-hours-consumption-unavailable')

beforeEach(() => {
  rendered.length = 0
  apiFetch.mockReset()
  serve(() => ({ status: 200, body: summary() }))
})

afterEach(() => {
  cleanup()
  vi.doUnmock('shell/extensions')
})

describe('the card', () => {
  it('is one card titled "Hours" with the consumption block, a divider and the panel, in that order', async () => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    await screen.findByTestId('host-hours-panel')
    await screen.findByTestId('project-hours-consumption-facts')

    expect(within(card()).getAllByRole('heading')).toHaveLength(1)
    expect(within(card()).getByRole('heading', { level: 3, name: 'Hours' })).not.toBeNull()
    expect(card().querySelector('[data-testid="project-hours"]')).toBeNull()
    const block = screen.getByTestId('project-hours-consumption')
    const divider = screen.getByTestId('project-hours-divider')
    const panel = screen.getByTestId('host-hours-panel')
    expect(block.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(divider.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const part of [block, divider, panel]) expect(card().contains(part)).toBe(true)
  })

  it('hands the panel the project as { on, targetId } and nothing else, keyed by the project', async () => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    await screen.findByTestId('host-hours-panel')

    expect(rendered).toEqual([
      {
        name: 'hours.hostHours',
        props: { on: 'project', targetId: 'p1' },
        resetKey: 'p1',
        hasLoading: true,
      },
    ])
  })

  it.each([
    ['no terms', null],
    ['terms of an SLA and no hour package (D82)', slaOnly()],
  ])('with %s the card is the panel alone: no block, no divider, no read of the summary', async (_name, terms) => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection projectId="p1" terms={terms} state="active" />)

    await screen.findByTestId('host-hours-panel')

    expect(within(card()).getByRole('heading', { name: 'Hours' })).not.toBeNull()
    expect(screen.queryByTestId('project-hours-consumption')).toBeNull()
    expect(screen.queryByTestId('project-hours-divider')).toBeNull()
    expect(reads()).toBe(0)
  })

  it('a package that has not started shows its static block, the divider and the panel, and reads nothing', async () => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    const notStarted = termsOf('maintenance', {
      sla: null,
      hourPackage: { hours: 120, kind: 'capacity', startDate: '2027-03-01', expiryDate: null, currentPeriod: null },
    })
    render(<HoursSection projectId="p1" terms={notStarted} state="active" />)

    await screen.findByTestId('host-hours-panel')

    expect(within(screen.getByTestId('project-hours-consumption')).getByText('Starts on')).not.toBeNull()
    expect(screen.getByTestId('project-hours-divider')).not.toBeNull()
    expect(reads()).toBe(0)
  })

  it('shows the card, its title and the loading line while the seam is imported, and the block does not wait for it', async () => {
    let release: (value: Record<string, unknown>) => void = () => undefined
    const seam = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve
    })
    const HoursSection = await load(() => seam as unknown as Record<string, unknown>)
    render(<HoursSection projectId="p1" terms={fixedPrice()} state="active" />)

    expect(within(card()).getByRole('heading', { name: 'Hours' })).not.toBeNull()
    expect(screen.getByText('Loading hours…')).not.toBeNull()
    // The block asked hours-api on its own, without waiting for the panel's module.
    expect((await screen.findByTestId('project-hours-consumption-facts')).textContent).toContain('Man-days used')
    expect(screen.queryByTestId('host-hours-panel')).toBeNull()

    await act(async () => release({ HostExtension: hostExtension }))
    await screen.findByTestId('host-hours-panel')
    expect(screen.queryByText('Loading hours…')).toBeNull()
  })
})

describe('when the panel cannot be had (AC-2.6): only its slot changes, the card and the block stay', () => {
  it('a rejected import of shell/extensions shows the notice in the slot, with the block above it', async () => {
    const HoursSection = await load(() => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    const notice = await screen.findByTestId('project-hours-unavailable')

    expect(notice.textContent).toBe(UNAVAILABLE)
    expect(within(card()).getByRole('heading', { name: 'Hours' })).not.toBeNull()
    expect((await screen.findByTestId('project-hours-consumption-facts')).textContent).toContain('Yearly package')
    expect(screen.queryByText('Loading hours…')).toBeNull()
    expect(screen.queryByTestId('host-hours-panel')).toBeNull()
  })

  it('a shell whose module lacks HostExtension shows the same notice instead of throwing', async () => {
    const HoursSection = await load(() => ({}))
    render(<HoursSection projectId="p1" terms={null} state="active" />)

    expect((await screen.findByTestId('project-hours-unavailable')).textContent).toBe(UNAVAILABLE)
    expect(screen.getByRole('heading', { name: 'Hours' })).not.toBeNull()
  })

  it('passes the slot a fallback with the same notice, so the remote failing later still leaves the card', async () => {
    let seen: ReactNode = null
    const HoursSection = await load(() => ({
      HostExtension: ({ fallback }: SlotProps) => {
        seen = fallback
        return fallback
      },
    }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    await waitFor(() => expect(seen).not.toBeNull())
    expect(within(card()).getByTestId('project-hours-unavailable').textContent).toBe(UNAVAILABLE)
    expect(within(card()).getByRole('heading', { name: 'Hours' })).not.toBeNull()
    await screen.findByTestId('project-hours-consumption-facts')
  })

  it('a panel that throws while rendering is contained to its slot; the block and the page around it render', async () => {
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
        <HoursSection projectId="p1" terms={yearly()} state="active" />
      </div>,
    )

    expect((await screen.findByTestId('project-hours-unavailable')).textContent).toBe(UNAVAILABLE)
    await screen.findByTestId('project-hours-consumption-facts')
    expect(screen.getByText('rest of the page')).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    error.mockRestore()
    warn.mockRestore()
  })

  it('after a failure for one project, another project tries the panel again (resetKey = the project id)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const HoursSection = await load(() => ({
      HostExtension: ({ props }: SlotProps) => {
        if ((props as { targetId: string }).targetId === 'bad') throw new Error('bad project')
        return createElement('div', { 'data-testid': 'host-hours-panel' }, (props as { targetId: string }).targetId)
      },
    }))
    const view = render(<HoursSection projectId="bad" terms={null} state="active" />)
    expect(await screen.findByTestId('project-hours-unavailable')).not.toBeNull()

    view.rerender(<HoursSection projectId="good" terms={null} state="active" />)

    expect((await screen.findByTestId('host-hours-panel')).textContent).toBe('good')
    expect(screen.queryByTestId('project-hours-unavailable')).toBeNull()
    error.mockRestore()
    warn.mockRestore()
  })

  it('unmounting before the import settles does not update state', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    const view = render(<HoursSection projectId="p1" terms={null} state="active" />)
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(rendered).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('the block and the panel fail independently (AC-2.6, AC-4.9; design S1 states)', () => {
  /** The panel's own failure: a warning with its own Retry, as hours-ui draws it (the host knows nothing of it). */
  const FailingPanel = ({ onRetry }: { onRetry: () => void }) =>
    createElement(
      'div',
      { role: 'alert', 'data-testid': 'panel-error' },
      'Hours are unavailable',
      createElement('button', { type: 'button', onClick: onRetry }, 'Retry panel'),
    )

  it('block fails, panel loads: the warning of the block, then the panel as usual', async () => {
    serve(() => problem(503, 'host_unavailable'))
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    expect(await screen.findByTestId('project-hours-consumption-unavailable')).not.toBeNull()
    expect(await screen.findByTestId('host-hours-panel')).not.toBeNull()
    expect(facts()).toBeNull()
    expect(card().querySelectorAll('[role="alert"]')).toHaveLength(1)
  })

  it('panel fails, block loads: the consumption facts, then the notice of the slot', async () => {
    const HoursSection = await load(() => ({ HostExtension: ({ fallback }: SlotProps) => fallback }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    expect(await screen.findByTestId('project-hours-unavailable')).not.toBeNull()
    expect(await screen.findByTestId('project-hours-consumption-facts')).not.toBeNull()
    expect(blockBanner()).toBeNull()
  })

  it('both fail: two banners, each with its own Retry, and one does not touch the other', async () => {
    let attempt = 0
    serve(() => (++attempt === 1 ? problem(503, 'host_unavailable') : { status: 200, body: summary() }))
    let panelRetries = 0
    const HoursSection = await load(() => ({
      HostExtension: () => createElement(FailingPanel, { onRetry: () => (panelRetries += 1) }),
    }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    const blockWarning = await screen.findByTestId('project-hours-consumption-unavailable')
    expect(await screen.findByTestId('panel-error')).not.toBeNull()
    expect(card().querySelectorAll('[role="alert"]')).toHaveLength(2)

    // The block's Retry reads again and the panel's banner stays exactly as it was.
    fireEvent.click(within(blockWarning).getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('project-hours-consumption-facts')
    expect(reads()).toBe(2)
    expect(screen.getByTestId('panel-error')).not.toBeNull()
    expect(panelRetries).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Retry panel' }))
    expect(panelRetries).toBe(1)
    expect(reads()).toBe(2)
  })

  it('neither fails: the facts and the panel, and no alert', async () => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    await screen.findByTestId('project-hours-consumption-facts')
    await screen.findByTestId('host-hours-panel')

    expect(card().querySelectorAll('[role="alert"]')).toHaveLength(0)
    expect(screen.queryByTestId('project-hours-unavailable')).toBeNull()
  })

  it('the heading survives whichever part fails', async () => {
    serve(() => problem(503, 'host_unavailable'))
    const HoursSection = await load(() => ({ HostExtension: ({ fallback }: SlotProps) => fallback }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)

    await screen.findByTestId('project-hours-consumption-unavailable')
    await screen.findByTestId('project-hours-unavailable')

    expect(within(card()).getAllByRole('heading')).toHaveLength(1)
    expect(within(card()).getByRole('heading', { name: 'Hours' })).not.toBeNull()
  })
})

describe('a save made with Record hours on this page (AC-2.8, D84)', () => {
  const recorded = (detail: unknown) =>
    act(() => {
      window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail }))
    })

  it('the block reads again and shows the new figures, and the panel is not remounted by it', async () => {
    let windowMinutes = 5070
    serve(() => ({ status: 200, body: summary({ windowMinutes }) }))
    // A panel with a state of its own: an open disclosure the block's re-read must not close.
    const Disclosure = () => {
      const [open, setOpen] = useState(false)
      return createElement(
        'button',
        { type: 'button', 'aria-expanded': open, onClick: () => setOpen(!open) },
        'Show breakdown',
      )
    }
    const HoursSection = await load(() => ({ HostExtension: () => createElement(Disclosure) }))
    render(<HoursSection projectId="p1" terms={yearly(120)} state="active" />)
    await screen.findByTestId('project-hours-consumption-facts')
    const toggle = await screen.findByRole('button', { name: 'Show breakdown' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    windowMinutes = 5130
    recorded({ on: 'project', targetId: 'p1' })

    await waitFor(() => expect(facts()!.textContent).toContain('85 h 30'))
    expect(reads()).toBe(2)
    expect(screen.getByRole('button', { name: 'Show breakdown' })).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('an event naming another project leaves the block as it is', async () => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection projectId="p1" terms={yearly()} state="active" />)
    await screen.findByTestId('project-hours-consumption-facts')

    recorded({ on: 'project', targetId: 'p9' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(reads()).toBe(1)
  })
})

describe('accessibility (design § Accessibility)', () => {
  // jsdom has no layout: contrast and the page-level region rule are the browser's to check, everything structural is here.
  const axeViolations = async (container: Element): Promise<string[]> => {
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
  }

  it.each([
    ['the facts of a package with its panel', yearly(), 5070],
    ['an exceeded package', yearly(), 9000],
    ['a fixed price', fixedPrice(), 3600],
    ['no consumption: the panel alone', null, 0],
  ])('has no axe violation: %s', async (_name, terms, windowMinutes) => {
    serve(() => ({
      status: 200,
      body: summary({ windowMinutes: terms?.type === 'fixed_price' ? null : windowMinutes }),
    }))
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    const { container } = render(<HoursSection projectId="p1" terms={terms} state="active" />)
    await screen.findByTestId('host-hours-panel')
    if (terms !== null) await screen.findByTestId('project-hours-consumption-facts')

    expect(await axeViolations(container)).toEqual([])
  })

  it('has no axe violation with the block unavailable and the panel replaced by the host notice', async () => {
    serve(() => problem(503, 'host_unavailable'))
    const HoursSection = await load(() => ({ HostExtension: ({ fallback }: SlotProps) => fallback }))
    const { container } = render(<HoursSection projectId="p1" terms={yearly()} state="active" />)
    await screen.findByTestId('project-hours-consumption-unavailable')
    await screen.findByTestId('project-hours-unavailable')

    expect(await axeViolations(container)).toEqual([])
  })

  it('has no axe violation for an expired capacity package (the badge) and while loading', async () => {
    serve(() => ({ status: 200, body: summary({ windowMinutes: 3000 }) }))
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    const expired = termsOf('maintenance', {
      sla: null,
      hourPackage: {
        hours: 120,
        kind: 'capacity',
        startDate: '2026-03-01',
        expiryDate: '2026-09-30',
        currentPeriod: { from: '2026-03-01', to: '2026-09-30', ended: true },
      },
    })
    const { container } = render(<HoursSection projectId="p1" terms={expired} state="active" />)
    // Loading first: the polite line and the skeletons.
    expect(await axeViolations(container)).toEqual([])
    await screen.findByTestId('project-hours-consumption-expired')
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('the divider and the project state (AC-1.7 amended, AC-5.24, AC-5.26; plan D-P9): one rule says whether there is a block', () => {
  /** SLA-only terms with an end date and the Europe/Zurich day projects-api derived them for. */
  const ending = (endDate: string | null): Terms => ({
    ...termsOf('maintenance', { sla: { highDays: 1, normalDays: 3 }, hourPackage: null }, { endDate }),
    asOf: '2026-11-27',
  })
  const draws = async (terms: Terms | null, state: ProjectState) => {
    const HoursSection = await load(() => ({ HostExtension: hostExtension }))
    render(<HoursSection projectId="p1" terms={terms} state={state} />)
    await screen.findByTestId('host-hours-panel')
  }

  it.each([
    ['an end date that has passed', '2026-11-26'],
    ['an end date that is today', '2026-11-27'],
    ['an end date 30 days ahead', '2026-12-27'],
  ])(
    'terms of an SLA and no hour package with %s: the divider is drawn, and nothing is read from hours-api',
    async (_label, endDate) => {
      await draws(ending(endDate), 'active')

      expect(screen.getByTestId('project-hours-divider')).not.toBeNull()
      expect(reads()).toBe(0)
    },
  )

  it.each([
    ['no end date', null],
    ['an end date 31 days ahead', '2026-12-28'],
  ])('the same terms with %s: the panel alone, no divider', async (_label, endDate) => {
    await draws(ending(endDate), 'active')

    expect(screen.queryByTestId('project-hours-divider')).toBeNull()
    expect(screen.queryByTestId('project-hours-consumption')).toBeNull()
  })

  it.each<ProjectState>(['closed', 'cancelled'])(
    'the same terms with a passed end date on a %s project: the panel alone',
    async (state) => {
      await draws(ending('2026-11-26'), state)

      expect(screen.queryByTestId('project-hours-divider')).toBeNull()
    },
  )

  it.each<ProjectState>(['planned', 'active', 'on_hold', 'closed', 'cancelled'])(
    'a fixed price keeps its figures, its divider and its panel on a %s project (only the state and the dates go, AC-5.26)',
    async (state) => {
      await draws(fixedPrice(), state)

      expect((await screen.findByTestId('project-hours-consumption-facts')).textContent).toContain('Man-days used')
      expect(screen.getByTestId('project-hours-divider')).not.toBeNull()
    },
  )
})

describe('no money anywhere (AC-1.8)', () => {
  it('none of the files of the card imports a money formatter or names an amount, a price or a rate', () => {
    const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))
    for (const file of [
      './HoursSection.tsx',
      './ConsumptionBlock.tsx',
      '../lib/consumption.ts',
      '../lib/hoursApi.ts',
    ]) {
      const source = readFileSync(here(file), 'utf-8')
      // Code only: the comments say what is NOT there.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/formatMoney|formatAmount|MoneyInput|amountCents|\bprice\b|\brate\b/i)
    }
  })
})
