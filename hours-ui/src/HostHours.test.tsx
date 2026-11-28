/**
 * @vitest-environment jsdom
 *
 * The hours panel other tools embed (specs/20261112-project-hours T13; plan § API contracts "`hours/HostHours`", § Refreshing after Record
 * hours; design S3 and § Gap resolutions; AC-1.7, AC-2.1–2.8, AC-4.3, AC-4.9, AC-3.2). It is rendered the way the shell's `HostExtension`
 * renders it, with the two props and nothing else; `shell/session` is the test's own `apiFetch` over the real `lib/hoursApi.ts`, so the
 * path and the query are the contract's, and each answer is released by the test, so what is shown while a read is on its way is observed
 * and not assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('./test-support/fakeSession')).shellSessionMock(apiFetch))

import HostHours from './HostHours'
import type { HostHoursProps } from './HostHoursModel'
import type { SummaryAnswer, TotalsGroup } from './lib/hoursApi.types'
import { TIME_ENTRY_RECORDED } from './lib/timeEntryRecordedEvent'
import { strings } from './strings'

const t = strings.hostHours
const PROJECT: HostHoursProps = { on: 'project', targetId: 'p1' }
const DEAL: HostHoursProps = { on: 'deal', targetId: 'd1' }

const DEVELOPMENT: TotalsGroup = { kind: 'keyed', key: 'wt-dev', label: 'Development', minutes: 3000 }
const UNTYPED: TotalsGroup = { kind: 'none', minutes: 2400 }
const ADA: TotalsGroup = { kind: 'keyed', key: 'u-ada', label: 'Ada Lovelace', minutes: 3600, status: 'active' }
const GRACE: TotalsGroup = { kind: 'keyed', key: 'u-grace', label: 'Grace Hopper', minutes: 1800, status: 'active' }

/** 90 h in all: 50 h of development and 40 h without a work type; no per-person part unless a test gives one. */
const answer = (overrides: Partial<SummaryAnswer> = {}): SummaryAnswer => ({
  on: { type: 'project', id: 'p1' },
  totalMinutes: 5400,
  windowMinutes: null,
  byWorkType: [DEVELOPMENT, UNTYPED],
  byPerson: null,
  unavailable: [],
  ...overrides,
})
const EMPTY = answer({ totalMinutes: 0, byWorkType: [], byPerson: null })
/** 120 h, all of it without a work type: a later answer than `answer()`. */
const MORE = answer({ totalMinutes: 7200, byWorkType: [{ kind: 'none', minutes: 7200 }] })
/** 1 h: what another record, or a read that was dropped, would answer. */
const LITTLE = answer({ totalMinutes: 60, byWorkType: [{ kind: 'none', minutes: 60 }] })
const REFUSED = { status: 503, body: { status: 503, code: 'host_unavailable' } }

type Reply = { status?: number; body?: unknown } | 'network'
type Request = {
  query: Record<string, string>
  signal: AbortSignal | null | undefined
  /** Answers this request; for a read the test held back. */
  reply: (reply: Reply) => void
}

const requests: Request[] = []
/** What a request is answered with straight away; `null` holds it until the test calls `reply`. */
let standing: Reply | null = null
/** A real fetch rejects once its signal aborts; a test that wants the late answer to arrive anyway turns this off. */
let rejectOnAbort = true

beforeEach(() => {
  requests.length = 0
  standing = { body: answer() }
  rejectOnAbort = true
  apiFetch.mockReset()
  apiFetch.mockImplementation(
    (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input))
        if (url.pathname !== '/time-entries/summary') {
          reject(new Error(`unexpected request ${url.pathname}`))
          return
        }
        const request: Request = {
          query: Object.fromEntries(url.searchParams),
          signal: init?.signal,
          reply: (reply) => {
            if (reply === 'network') reject(new TypeError('Failed to fetch'))
            else resolve(new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 }))
          },
        }
        init?.signal?.addEventListener('abort', () => {
          if (rejectOnAbort) reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        requests.push(request)
        if (standing !== null) request.reply(standing)
      }),
  )
})
afterEach(() => {
  cleanup()
})

const root = () => screen.getByTestId('hours-host-hours')
const toggle = () => screen.getByTestId('hours-host-hours-toggle')
const region = () => screen.getByTestId('hours-host-hours-breakdown')
const total = () => screen.getByTestId('hours-host-hours-total')
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
/** Not under a `hidden` ancestor: what a person can reach (jsdom has no layout, but it does know the `hidden` attribute). */
const shown = (element: Element) => element.closest('[hidden]') === null
const focused = (element: Element) => document.activeElement === element
const expanded = () => toggle().getAttribute('aria-expanded')
const showBreakdown = () => userEvent.click(toggle())
/** The panel with its first answer on screen. */
const loaded = async (props: HostHoursProps = PROJECT) => {
  render(<HostHours {...props} />)
  await screen.findByTestId('hours-host-hours-total')
}
const record = (detail: unknown) =>
  act(() => void window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail })))
const answerTo = (index: number, body: SummaryAnswer) => act(async () => requests[index]?.reply({ body }))

describe('what it asks (AC-2.1, AC-2.2; plan § `GET /time-entries/summary`)', () => {
  it('makes ONE summary call on mount, for the project, with its id and nothing else', async () => {
    await loaded(PROJECT)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.query).toEqual({ projectId: 'p1' })
  })

  it('asks for a deal by `dealId`', async () => {
    await loaded(DEAL)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.query).toEqual({ dealId: 'd1' })
  })

  it('does not ask again when the host re-renders it with the same props (the data is kept across re-renders)', async () => {
    const { rerender } = render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-total')
    await showBreakdown()
    rerender(<HostHours {...PROJECT} />)
    rerender(<HostHours on="project" targetId="p1" />)
    expect(requests).toHaveLength(1)
    expect(expanded()).toBe('true')
  })
})

describe('loading', () => {
  it('shows one skeleton row and says "Loading hours…" politely, with no total and no button yet', async () => {
    standing = null
    render(<HostHours {...PROJECT} />)
    const live = await screen.findByTestId('hours-host-hours-loading')
    expect(live.textContent).toBe(t.loading)
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByTestId('hours-host-hours-total')).toBeNull()
    expect(screen.queryByTestId('hours-host-hours-toggle')).toBeNull()
    expect(root().getAttribute('role')).toBe('group')
  })

  it('the group is named for the record it is about', async () => {
    standing = null
    render(<HostHours {...DEAL} />)
    expect(await screen.findByRole('group', { name: t.regionLabel.deal })).toBe(root())
    cleanup()
    render(<HostHours {...PROJECT} />)
    expect(await screen.findByRole('group', { name: t.regionLabel.project })).toBe(root())
  })
})

describe('loaded: the total, always visible (AC-1.7, AC-2.1, AC-4.3)', () => {
  it('shows the total recorded and the line that says it includes the linked meetings, with nothing opened', async () => {
    await loaded(PROJECT)
    expect(within(total()).getByText(t.total)).toBeTruthy()
    expect(within(total()).getByText('90 h')).toBeTruthy()
    expect(shown(screen.getByText(t.includesMeetings.project))).toBe(true)
    expect(screen.queryByTestId('hours-host-hours-loading')).toBeNull()
  })

  it('names a deal in its inclusion line', async () => {
    await loaded(DEAL)
    expect(shown(screen.getByText(t.includesMeetings.deal))).toBe(true)
    expect(screen.queryByText(t.includesMeetings.project)).toBeNull()
  })

  it('reads the total aloud in words, not as "h" (the short text is for the eye)', async () => {
    standing = { body: answer({ totalMinutes: 150, byWorkType: [{ kind: 'none', minutes: 150 }] }) }
    await loaded(PROJECT)
    expect(within(total()).getByText('2 hours, 30 minutes').className).toContain('visually-hidden')
    expect(within(total()).getByText('2 h 30').getAttribute('aria-hidden')).toBe('true')
  })
})

describe('the disclosure (design S3, F8; D80)', () => {
  it('is closed on mount: "Show breakdown", aria-expanded false, controlling a region kept in the DOM with `hidden`', async () => {
    await loaded(PROJECT)
    expect(toggle().textContent).toContain(t.show)
    expect(expanded()).toBe('false')
    const controlled = toggle().getAttribute('aria-controls')
    expect(controlled).toBeTruthy()
    expect(region().id).toBe(controlled)
    expect(region().hasAttribute('hidden')).toBe(true)
    // Out of the accessibility tree and the tab order while closed, but there for `aria-controls` to name.
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('heading', { name: t.byWorkType.heading })).toBeNull()
    expect(screen.getByRole('table', { hidden: true, name: t.byWorkType.heading })).toBeTruthy()
  })

  it('opens on a click with NO new request: "Hide breakdown", aria-expanded true, the work-type table in view', async () => {
    await loaded(PROJECT)
    await showBreakdown()
    expect(requests).toHaveLength(1)
    expect(toggle().textContent).toContain(t.hide)
    expect(expanded()).toBe('true')
    expect(region().hasAttribute('hidden')).toBe(false)
    expect(screen.getByRole('heading', { level: 4, name: t.byWorkType.heading })).toBeTruthy()
    const table = screen.getByRole('table', { name: t.byWorkType.heading })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Development')
    expect(within(rows[0]!).getByText('50 h')).toBeTruthy()
    expect(rows[1]?.textContent).toContain(t.byWorkType.none)
    expect(within(rows[1]!).getByText('40 h')).toBeTruthy()
  })

  it('the table has the Work type and Time columns, named by its visible heading', async () => {
    await loaded(PROJECT)
    await showBreakdown()
    const table = screen.getByRole('table', { name: t.byWorkType.heading })
    expect(within(table).getByRole('columnheader', { name: t.byWorkType.column })).toBeTruthy()
    expect(within(table).getByRole('columnheader', { name: strings.totals.columnTime })).toBeTruthy()
    expect(within(table).getByRole('rowheader', { name: 'Development' })).toBeTruthy()
  })

  it('closes on the next press and keeps focus on the button both ways (it is a disclosure, not a popup)', async () => {
    await loaded(PROJECT)
    await userEvent.tab()
    expect(focused(toggle())).toBe(true)
    await userEvent.keyboard('{Enter}')
    expect(expanded()).toBe('true')
    expect(focused(toggle())).toBe(true)
    await userEvent.keyboard(' ')
    expect(expanded()).toBe('false')
    expect(region().hasAttribute('hidden')).toBe(true)
    expect(focused(toggle())).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it('Escape does nothing to it', async () => {
    await loaded(PROJECT)
    await showBreakdown()
    await userEvent.keyboard('{Escape}')
    expect(expanded()).toBe('true')
  })

  it('reaches no table and no name before it is opened (a reader’s virtual cursor, the tab order)', async () => {
    standing = { body: answer({ byPerson: [ADA, GRACE] }) }
    await loaded(PROJECT)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('heading', { name: t.byPerson.heading })).toBeNull()
    expect(shown(screen.getByText('Ada Lovelace'))).toBe(false)
  })
})

describe('By person: only when the answer carries it (AC-2.3–2.5, AC-2.7)', () => {
  it('shows the person table with every name and time, in the server’s order, below the work types', async () => {
    standing = { body: answer({ byPerson: [ADA, GRACE] }) }
    await loaded(PROJECT)
    await showBreakdown()
    expect(screen.getByRole('heading', { level: 4, name: t.byPerson.heading })).toBeTruthy()
    const table = screen.getByRole('table', { name: t.byPerson.heading })
    expect(within(table).getByRole('columnheader', { name: strings.totals.groupBy.person })).toBeTruthy()
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Ada Lovelace')
    expect(within(rows[0]!).getByText('60 h')).toBeTruthy()
    expect(rows[1]?.textContent).toContain('Grace Hopper')
    expect(within(rows[1]!).getByText('30 h')).toBeTruthy()
    // Work types first, people second.
    expect(screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual([
      t.byWorkType.heading,
      t.byPerson.heading,
    ])
  })

  it('names a person as every other list does: "Unknown user" without a name, "(deactivated)" for a closed account', async () => {
    standing = {
      body: answer({
        byPerson: [
          { kind: 'keyed', key: 'u1', label: null, minutes: 3000, status: 'unknown' },
          { kind: 'keyed', key: 'u2', label: null, minutes: 2400, status: 'deleted' },
        ],
      }),
    }
    await loaded(PROJECT)
    await showBreakdown()
    const table = screen.getByRole('table', { name: t.byPerson.heading })
    expect(within(table).getByText(strings.everyone.person.unknown)).toBeTruthy()
    expect(within(table).getByText(strings.everyone.person.deactivated(strings.everyone.person.unknown))).toBeTruthy()
  })

  it('shows NOTHING about people when the answer has none: no heading, no table, no placeholder, no lock (the caller is not told others see more)', async () => {
    standing = { body: answer({ byPerson: null }) }
    await loaded(PROJECT)
    await showBreakdown()
    expect(screen.queryByText(t.byPerson.heading)).toBeNull()
    expect(screen.queryByRole('table', { name: t.byPerson.heading })).toBeNull()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(region().textContent).not.toMatch(/person|persona|people|hidden|restricted|permission/i)
  })
})

describe('no hours yet (design S3 "empty")', () => {
  it('reads "0 min" and one sentence, with no disclosure, no inclusion line and no tables', async () => {
    standing = { body: EMPTY }
    await loaded(PROJECT)
    expect(within(total()).getByText('0 min')).toBeTruthy()
    expect(screen.getByTestId('hours-host-hours-empty').textContent).toBe(t.empty.project)
    expect(screen.queryByTestId('hours-host-hours-toggle')).toBeNull()
    expect(screen.queryByTestId('hours-host-hours-breakdown')).toBeNull()
    expect(screen.queryByText(t.includesMeetings.project)).toBeNull()
    expect(screen.queryByRole('table', { hidden: true })).toBeNull()
  })

  it('names a deal in its sentence', async () => {
    standing = { body: EMPTY }
    await loaded(DEAL)
    expect(screen.getByTestId('hours-host-hours-empty').textContent).toBe(t.empty.deal)
  })
})

describe('a read that failed shows no figure at all (AC-2.6, AC-4.9)', () => {
  const expectUnavailable = () => {
    const banner = screen.getByTestId('hours-host-hours-error')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain(t.error.title)
    expect(banner.textContent).toContain(t.error.body)
    expect(within(banner).getByRole('button', { name: strings.common.retry })).toBeTruthy()
    expect(screen.queryByTestId('hours-host-hours-total')).toBeNull()
    expect(screen.queryByTestId('hours-host-hours-toggle')).toBeNull()
    expect(screen.queryByTestId('hours-host-hours-breakdown')).toBeNull()
    expect(screen.queryByTestId('hours-host-hours-empty')).toBeNull()
    expect(screen.queryByRole('table', { hidden: true })).toBeNull()
    expect(root().textContent).not.toMatch(/\d+ (h|min)\b/)
  }

  it.each([
    ['503 host_unavailable (Meetings or the owner could not say)', REFUSED],
    ['404 not_found (missing, or not readable: one answer)', { status: 404, body: { status: 404, code: 'not_found' } }],
    ['500 with no code', { status: 500, body: { status: 500 } }],
    ['a network failure', 'network' as const],
  ])('%s → the warning with Retry', async (_what, reply) => {
    standing = reply
    render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-error')
    expectUnavailable()
  })

  it.each([
    ['an answer with no total', { on: { type: 'project', id: 'p1' }, byWorkType: [], byPerson: null, unavailable: [] }],
    ['an answer whose total is text', { ...answer(), totalMinutes: '90' }],
    ['an answer that is not an object', 'ok'],
    ['an answer with groups that are not a list', { ...answer(), byWorkType: 'none' }],
  ])('%s is not shown as a figure (no "0 min" for a total that did not come)', async (_what, malformed) => {
    standing = { body: malformed }
    render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-error')
    expectUnavailable()
  })

  it('Retry shows the loading state, asks again, and shows the figures when the answer comes, with focus on the group', async () => {
    standing = REFUSED
    render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-error')

    standing = null
    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    expect(await screen.findByTestId('hours-host-hours-loading')).toBeTruthy()
    expect(screen.queryByTestId('hours-host-hours-error')).toBeNull()
    expect(requests).toHaveLength(2)

    await answerTo(1, answer())
    expect((await screen.findByTestId('hours-host-hours-total')).textContent).toContain('90 h')
    // The wrapper takes focus: the Retry that had it is gone.
    await waitFor(() => expect(focused(root())).toBe(true))
  })

  it('Retry that fails again shows the warning again and focus is on the group, whatever the answer', async () => {
    standing = REFUSED
    render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-error')
    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    await screen.findByTestId('hours-host-hours-error')
    await waitFor(() => expect(focused(root())).toBe(true))
    expect(requests).toHaveLength(2)
  })

  it('takes no focus on its own: not when its first answer comes, not when it first fails', async () => {
    const before = document.activeElement
    render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-total')
    expect(focused(root())).toBe(false)
    expect(document.activeElement).toBe(before)
    cleanup()
    standing = REFUSED
    render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-error')
    expect(focused(root())).toBe(false)
    expect(document.activeElement).toBe(before)
  })
})

describe('what an answer says it could not ask (design S3 "unavailable")', () => {
  it('`identities`: the figures are complete; one polite note about the names sits INSIDE the region, above the tables', async () => {
    standing = {
      body: answer({
        byPerson: [{ kind: 'keyed', key: 'u1', label: null, minutes: 5400, status: 'unknown' }],
        unavailable: ['identities'],
      }),
    }
    await loaded(PROJECT)
    const note = within(region()).getByText(strings.entries.banners.unavailable(strings.names.sources.identities))
    expect(note.closest('[role="status"]')).not.toBeNull()
    // Closed, it is in the hidden region: nothing of it is in front of the person, and the total is complete.
    expect(shown(note)).toBe(false)
    expect(within(total()).getByText('90 h')).toBeTruthy()
    await showBreakdown()
    expect(shown(note)).toBe(true)
    expect(
      within(screen.getByRole('table', { name: t.byPerson.heading })).getByText(strings.everyone.person.unknown),
    ).toBeTruthy()
    // Above the tables, not below them.
    expect(
      note.compareDocumentPosition(screen.getByRole('table', { name: t.byWorkType.heading })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('`authz`: no person table; one polite note with Retry inside the region says why', async () => {
    standing = { body: answer({ byPerson: null, unavailable: ['authz'] }) }
    await loaded(PROJECT)
    await showBreakdown()
    const note = within(region()).getByText(t.peopleUnavailable)
    expect(note.closest('[role="status"]')).not.toBeNull()
    expect(screen.queryByRole('table', { name: t.byPerson.heading })).toBeNull()
    expect(screen.queryByText(t.byPerson.heading)).toBeNull()
    expect(within(region()).getByRole('button', { name: strings.common.retry })).toBeTruthy()
  })

  it('`authz` with the region closed: nothing of it is reachable, and the total is unaffected', async () => {
    standing = { body: answer({ byPerson: null, unavailable: ['authz'] }) }
    await loaded(PROJECT)
    expect(screen.queryByRole('button', { name: strings.common.retry })).toBeNull()
    expect(region().hasAttribute('hidden')).toBe(true)
    expect(within(total()).getByText('90 h')).toBeTruthy()
  })

  it('the Retry of the `authz` note asks again, and the person table appears when the right could be checked', async () => {
    standing = { body: answer({ byPerson: null, unavailable: ['authz'] }) }
    await loaded(PROJECT)
    await showBreakdown()
    standing = { body: answer({ byPerson: [ADA, GRACE], unavailable: [] }) }
    await userEvent.click(within(region()).getByRole('button', { name: strings.common.retry }))
    expect(await screen.findByRole('table', { name: t.byPerson.heading })).toBeTruthy()
    expect(requests).toHaveLength(2)
    expect(screen.queryByText(t.peopleUnavailable)).toBeNull()
    // The disclosure kept its state across the Retry.
    expect(expanded()).toBe('true')
  })

  it('a note this build does not know shows nothing', async () => {
    standing = { body: answer({ unavailable: ['somethingNew'] as unknown as SummaryAnswer['unavailable'] }) }
    await loaded(PROJECT)
    await showBreakdown()
    expect(region().querySelector('[role="status"]')).toBeNull()
  })
})

describe('invalid props (the RecordHours rule: the host shows its fallback)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['a kind that is not a project or a deal', { on: 'none', targetId: '' }],
    ['a meeting', { on: 'meeting', targetId: 'm1' }],
    ['no id', { on: 'project', targetId: '' }],
    ['an id of spaces', { on: 'deal', targetId: '   ' }],
  ])('throws at render for %s, and asks nothing', (_what, props) => {
    expect(() => render(<HostHours {...(props as unknown as HostHoursProps)} />)).toThrow(/HostHours/)
    expect(requests).toHaveLength(0)
  })
})

describe('re-read after a Record hours save (D84, AC-2.8; plan § Refreshing after Record hours)', () => {
  it('an event naming its project reads again, KEEPING the figures on screen until the answer, then replaces them', async () => {
    await loaded(PROJECT)
    await showBreakdown()
    standing = null
    record({ on: 'project', targetId: 'p1' })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.query).toEqual({ projectId: 'p1' })
    // No skeleton, no layout jump: the old figures and the open breakdown stay.
    expect(screen.queryByTestId('hours-host-hours-loading')).toBeNull()
    expect(within(total()).getByText('90 h')).toBeTruthy()
    expect(expanded()).toBe('true')
    expect(shown(screen.getByRole('table', { name: t.byWorkType.heading }))).toBe(true)

    await answerTo(1, MORE)
    await waitFor(() => expect(within(total()).getByText('120 h')).toBeTruthy())
    expect(within(total()).queryByText('90 h')).toBeNull()
    // The breakdown keeps its open state.
    expect(expanded()).toBe('true')
    expect(requests).toHaveLength(2)
  })

  it('a closed breakdown stays closed through a re-read', async () => {
    await loaded(PROJECT)
    record({ on: 'project', targetId: 'p1' })
    await waitFor(() => expect(requests).toHaveLength(2))
    await settle()
    expect(expanded()).toBe('false')
    expect(region().hasAttribute('hidden')).toBe(true)
  })

  it('a deal listens for its deal', async () => {
    await loaded(DEAL)
    record({ on: 'deal', targetId: 'd1' })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.query).toEqual({ dealId: 'd1' })
  })

  it.each([
    ['another project', { on: 'project', targetId: 'p2' }],
    ['a deal with the project’s id (another kind)', { on: 'deal', targetId: 'p1' }],
    ['other work', { on: 'none', targetId: '' }],
  ])('ignores an event naming %s', async (_what, detail) => {
    await loaded(PROJECT)
    record(detail)
    await settle()
    expect(requests).toHaveLength(1)
  })

  it.each([
    ['no detail at all', undefined],
    ['a null detail', null],
    ['a detail that is text', 'p1'],
    ['a detail with no target', { on: 'project' }],
    ['a detail with a blank target', { on: 'project', targetId: ' ' }],
    ['a detail with more than the fact (minutes, a person…)', { on: 'project', targetId: 'p1', minutes: 60 }],
    ['a detail of the wrong types', { on: 'project', targetId: 7 }],
    ['a list', ['project', 'p1']],
  ])('ignores an event with %s (anyone on the page can dispatch this name)', async (_what, detail) => {
    await loaded(PROJECT)
    record(detail)
    await settle()
    expect(requests).toHaveLength(1)
    expect(within(total()).getByText('90 h')).toBeTruthy()
  })

  it('ignores a plain event of that name that is not a CustomEvent', async () => {
    await loaded(PROJECT)
    act(() => void window.dispatchEvent(new Event(TIME_ENTRY_RECORDED)))
    await settle()
    expect(requests).toHaveLength(1)
  })

  it('takes no figure from the event: it shows what the owner answers', async () => {
    await loaded(PROJECT)
    standing = { body: MORE }
    record({ on: 'project', targetId: 'p1' })
    await waitFor(() => expect(within(total()).getByText('120 h')).toBeTruthy())
    expect(requests).toHaveLength(2)
  })

  it('a burst of events is ONE re-read', async () => {
    await loaded(PROJECT)
    standing = null
    act(() => {
      for (let i = 0; i < 4; i += 1) {
        window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail: { on: 'project', targetId: 'p1' } }))
      }
    })
    await waitFor(() => expect(requests).toHaveLength(2))
    await settle()
    expect(requests).toHaveLength(2)
  })

  it('an event while a re-read is on its way restarts it: the one in flight is dropped, however late its answer', async () => {
    rejectOnAbort = false
    await loaded(PROJECT)
    standing = null
    record({ on: 'project', targetId: 'p1' })
    await waitFor(() => expect(requests).toHaveLength(2))
    record({ on: 'project', targetId: 'p1' })
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[1]?.signal?.aborted).toBe(true)
    expect(requests[2]?.signal?.aborted).toBe(false)

    await answerTo(2, MORE)
    await waitFor(() => expect(within(total()).getByText('120 h')).toBeTruthy())
    // The dropped read answers late with an older figure: it is not shown.
    await answerTo(1, LITTLE)
    expect(within(total()).getByText('120 h')).toBeTruthy()
    expect(within(total()).queryByText('1 h')).toBeNull()
  })

  it('a re-read that fails shows the warning with Retry, and no figure (a stale total beside a failed read could be too low)', async () => {
    await loaded(PROJECT)
    standing = REFUSED
    record({ on: 'project', targetId: 'p1' })
    await screen.findByTestId('hours-host-hours-error')
    expect(screen.queryByTestId('hours-host-hours-total')).toBeNull()
    expect(screen.queryByTestId('hours-host-hours-toggle')).toBeNull()
    expect(screen.getByRole('button', { name: strings.common.retry })).toBeTruthy()
    // It did not take focus: the person was not on it.
    expect(focused(root())).toBe(false)
  })

  it('does not announce the new total and does not move focus (nothing is said beyond what the panel already says)', async () => {
    await loaded(PROJECT)
    await showBreakdown()
    expect(focused(toggle())).toBe(true)
    standing = { body: MORE }
    record({ on: 'project', targetId: 'p1' })
    await waitFor(() => expect(within(total()).getByText('120 h')).toBeTruthy())
    expect(focused(toggle())).toBe(true)
    expect(screen.queryByTestId('hours-host-hours-loading')).toBeNull()
  })

  it('stops listening when it unmounts, and drops a read still on its way', async () => {
    await loaded(PROJECT)
    standing = null
    record({ on: 'project', targetId: 'p1' })
    await waitFor(() => expect(requests).toHaveLength(2))
    cleanup()
    expect(requests[1]?.signal?.aborted).toBe(true)
    record({ on: 'project', targetId: 'p1' })
    await settle()
    expect(requests).toHaveLength(2)
  })

  it('leaves no listener behind on the page when it unmounts (a panel that comes and goes with every page must not pile them up)', async () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    try {
      await loaded(PROJECT)
      const listened = added.mock.calls.filter(([type]) => type === TIME_ENTRY_RECORDED).map(([, listener]) => listener)
      expect(listened).toHaveLength(1)
      cleanup()
      const released = removed.mock.calls
        .filter(([type]) => type === TIME_ENTRY_RECORDED)
        .map(([, listener]) => listener)
      expect(released).toEqual(listened)
    } finally {
      added.mockRestore()
      removed.mockRestore()
    }
  })
})

describe('another record (a host that shows another project or deal)', () => {
  it('resets its data and its disclosure and reads the new record, never showing the old one’s figures under it', async () => {
    const { rerender } = render(<HostHours {...PROJECT} />)
    await screen.findByTestId('hours-host-hours-total')
    await showBreakdown()
    standing = null
    rerender(<HostHours on="project" targetId="p2" />)
    expect(await screen.findByTestId('hours-host-hours-loading')).toBeTruthy()
    expect(screen.queryByTestId('hours-host-hours-total')).toBeNull()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.query).toEqual({ projectId: 'p2' })

    await answerTo(1, LITTLE)
    expect((await screen.findByTestId('hours-host-hours-total')).textContent).toContain('1 h')
    expect(expanded()).toBe('false')
  })

  it('drops the old record’s read, however late its answer, and listens for the new target only', async () => {
    rejectOnAbort = false
    standing = null
    const { rerender } = render(<HostHours {...PROJECT} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    rerender(<HostHours {...DEAL} />)
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]?.signal?.aborted).toBe(true)
    await answerTo(1, LITTLE)
    await screen.findByTestId('hours-host-hours-total')
    await answerTo(0, answer())
    expect(within(total()).getByText('1 h')).toBeTruthy()

    record({ on: 'project', targetId: 'p1' })
    await settle()
    expect(requests).toHaveLength(2)
    record({ on: 'deal', targetId: 'd1' })
    await waitFor(() => expect(requests).toHaveLength(3))
  })
})
