/**
 * @vitest-environment jsdom
 *
 * My hours, the cells of the table: what an empty cell does not do, Add hours in a cell's list, a cell's entries with
 * Edit and Delete, and the figures and the focus after any write (specs/20261116-record-hours-in-place; AC-5.13,
 * AC-5.14, AC-5.15–AC-5.20, AC-5.24, AC-5.32; plan § Sequences "The Week view", § `EntryDialog` contract and its first
 * amendment G7; design F5, F6, S7 "Focus after a write", S8, S9). An empty cell no longer records (AC-5.12 withdrawn,
 * T20): hours are recorded with Record hours or with Add hours in the list of a cell that holds hours. Rendered through
 * the inner router with a memory history and `fakeApi` behind `apiFetch`, so an assertion about a request is about the
 * body the real `hoursApi` builds. The dialog's own rules are `EntryDialog.test.tsx` and `EntryDialog.preset.test.tsx`;
 * the grid is `TableView.test.tsx`; this is the page around them.
 *
 * Today is Friday 13 November 2026 (`TODAY_INSTANT`): this week is Monday 9 – Sunday 15 November, and Saturday 14 and
 * Sunday 15 have not come.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { createAppRouter } from '../router'
import { strings } from '../strings'
import {
  dealItem,
  dealOn,
  deferred,
  entriesPage,
  fakeApi,
  listsHandler,
  meetingOn,
  otherWorkOn,
  page,
  problem,
  projectItem,
  projectOn,
  requests,
  timeEntryView,
} from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { afterAFrame, emulateFocusFixup } from '../test-support/focusFixup'
import { LISTS, TODAY_INSTANT, totalsHandler } from '../test-support/fixtures/myHours'
import { typeDuration } from '../test-support/typeDuration'
import type { EntryInput, EntryOnInput, EntryPatch, TimeEntryView } from '../lib/hoursApi.types'

const e = strings.entry
const f = e.fields
const w = strings.table

let api: ReturnType<typeof fakeApi>

const THIS_MONDAY = '2026-11-09'
const THIS_SUNDAY = '2026-11-15'
const LAST_MONDAY = '2026-11-02'
const LAST_SUNDAY = '2026-11-08'

let entrySeq = 0
const entry = (day: string, minutes: number, on: TimeEntryView['on']): TimeEntryView =>
  timeEntryView({ id: `e${++entrySeq}`, day, minutes, on })

/**
 * What the person worked on this week: 4 h and 2 h 30 on the project Alpenstrom (Monday, Tuesday) and 1 h on the deal
 * Brera (Wednesday). So Alpenstrom has Wednesday, Thursday and Friday (today) empty, and Brera has Monday, Tuesday,
 * Thursday and Friday.
 */
const SEED: TimeEntryView[] = [
  entry('2026-11-09', 240, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-11-10', 150, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-11-11', 60, dealOn('d-brera', 'Brera configurator')),
]

/** The names the fake server gives a target it was asked to record on (the real one resolves them from the owners). */
const NAMES: Record<string, string> = {
  'p-alpha': 'Alpenstrom',
  p1: 'Project Alpha',
  'd-brera': 'Brera configurator',
  d1: 'Acme renewal',
  'm-retro': 'Retrospective',
}

/** `GET /time-entries` over `items`: the ones whose day is within `from`..`to`, as the server answers a ranged read. */
const entriesInRange =
  (items: () => TimeEntryView[]): FakeHandler =>
  (url) => {
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    return { status: 200, body: entriesPage(items().filter((item) => item.day >= from && item.day <= to)) }
  }

/** The `on` the server answers for the target a body names. */
const onViewOf = (on: EntryOnInput): TimeEntryView['on'] =>
  on.type === 'none'
    ? otherWorkOn(
        LISTS.categories.find((category) => category.id === on.categoryId)?.name ?? on.categoryId,
        on.categoryId,
      )
    : on.type === 'project'
      ? projectOn(on.id, NAMES[on.id])
      : on.type === 'deal'
        ? dealOn(on.id, NAMES[on.id])
        : meetingOn(on.id, NAMES[on.id])

/** The entry the server makes of a `POST /time-entries` body. */
const madeOf = (input: EntryInput): TimeEntryView => entry(input.day, input.minutes, onViewOf(input.on))

/** The server: what it holds, which a `POST` adds to, so the next read of the week holds the new entry. */
let held: TimeEntryView[]

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  held = [...SEED]
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesInRange(() => held),
    'POST /time-entries': (_url, init) => {
      const created = madeOf(JSON.parse(String(init?.body)) as EntryInput)
      held.push(created)
      return { status: 201, body: created }
    },
    'PATCH /time-entries/:id': (_url, init, params) => {
      const patch = JSON.parse(String(init?.body)) as EntryPatch
      const index = held.findIndex((item) => item.id === params['id'])
      if (index === -1) return { status: 404, body: problem(404) }
      const patched: TimeEntryView = {
        ...held[index]!,
        ...(patch.day !== undefined ? { day: patch.day } : {}),
        ...(patch.minutes !== undefined ? { minutes: patch.minutes } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.on !== undefined ? { on: onViewOf(patch.on) } : {}),
      }
      held[index] = patched
      return { status: 200, body: patched }
    },
    'DELETE /time-entries/:id': (_url, _init, params) => {
      const before = held.length
      held = held.filter((item) => item.id !== params['id'])
      return held.length === before ? { status: 404, body: problem(404) } : { status: 204 }
    },
    'GET /time-entries/totals': totalsHandler,
    'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter('/hours', undefined, history)
  render(<RouterProvider router={router} />)
  await screen.findByTestId('hours-my-page')
  return router
}

const entriesCalls = () => requests(api, 'GET /time-entries')
const postCalls = () => requests(api, 'POST /time-entries')

const dialog = () => screen.getByRole('dialog', { name: e.dialog.recordTitle })
const inDialog = () => within(dialog())
const dayField = () => inDialog().getByLabelText(new RegExp(`^${f.day}`)) as HTMLInputElement
const durationField = () => inDialog().getByRole('textbox', { name: f.duration.label })
const save = () => userEvent.click(inDialog().getByRole('button', { name: e.dialog.save }))
const heading = () => screen.getByTestId('hours-table-heading')
const cellButton = (key: string, day: string) => document.querySelector(`[data-cell="${key}:${day}"]`)

const ALPENSTROM = 'Alpenstrom'

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** The `td` of a row on a day, found by the row's test id and the day's place in the week that begins on `monday`. */
const tdOf = (rowKey: string, day: string, monday = THIS_MONDAY) =>
  within(screen.getByTestId(`hours-table-row-${rowKey}`)).getAllByRole('cell')[
    Number(day.slice(8)) - Number(monday.slice(8))
  ]!

describe('an empty cell does nothing, on any day and any row (AC-5.14, AC-5.32)', () => {
  const recordButtons = () => screen.queryAllByRole('button', { name: /^Record hours on / })

  it.each([
    ['an earlier day', '2026-11-12'],
    ['today', '2026-11-13'],
    ['a day that has not come', '2026-11-14'],
  ])('a click on the empty cell of %s opens no dialog, sends nothing and reads nothing', async (_when, day) => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    const reads = apiFetch.mock.calls.length

    await userEvent.click(tdOf('project:p-alpha', day))
    await userEvent.click(tdOf('deal:d-brera', day))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(postCalls()).toHaveLength(0)
    expect(apiFetch.mock.calls).toHaveLength(reads)
    expect(document.activeElement?.hasAttribute('data-cell')).toBe(false)
  })

  it('offers no "Record hours on" button, and no cell is a control but the three that hold hours', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    expect(recordButtons()).toEqual([])
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(SEED.length)
  })

  it('a week that is over offers nothing either: its empty days, its weekend included, are blank', async () => {
    useApi()
    held.push(entry('2026-11-03', 180, projectOn('p-alpha', 'Alpenstrom')))
    await renderPage(`/hours?week=${LAST_MONDAY}`)
    await screen.findByTestId('hours-table-table')

    expect(heading().textContent).toContain('02.11.2026 – 08.11.2026')
    expect(recordButtons()).toEqual([])
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(1)
    await userEvent.click(tdOf('project:p-alpha', '2026-11-04', LAST_MONDAY))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

/** Opens the list of a cell that holds hours and presses Add hours in it: My hours' own entry dialog on that day and row. */
const addHoursIn = async (rowKey: string, day: string) => {
  await userEvent.click(cellButton(rowKey, day) as HTMLElement)
  await userEvent.click(screen.getByTestId('hours-table-cell-add'))
}

describe('Add hours in a cell’s list keeps the day and the target changeable (AC-5.13, AC-5.18, WA6)', () => {
  it('a save after changing the day and the target posts the changed values, not the cell’s', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await addHoursIn('project:p-alpha', '2026-11-09')
    expect(dayField().value).toBe('2026-11-09')
    fireEvent.change(dayField(), { target: { value: '2026-11-11' } })
    await typeDuration(durationField(), '1:30')
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.deal }))
    await userEvent.type(inDialog().getByRole('combobox', { name: f.deal.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
    await save()

    await waitFor(() => expect(postCalls()).toHaveLength(1))
    expect(postCalls()[0]!.body).toEqual({ day: '2026-11-11', minutes: 90, on: { type: 'deal', id: 'd1' } })
  })

  it('saved untouched, it posts the cell’s own day and the row’s own target', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await addHoursIn('project:p-alpha', '2026-11-09')
    await typeDuration(durationField(), '2')
    await save()

    await waitFor(() => expect(postCalls()).toHaveLength(1))
    expect(postCalls()[0]!.body).toEqual({ day: '2026-11-09', minutes: 120, on: { type: 'project', id: 'p-alpha' } })
  })

  it('a deal’s row opens on that deal, a meeting’s on that meeting, and other work’s on its category', async () => {
    useApi()
    held.push(
      entry('2026-11-09', 60, meetingOn('m-retro', 'Retrospective')),
      entry('2026-11-10', 120, otherWorkOn('Formazione', 'tc-formazione')),
    )
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await addHoursIn('deal:d-brera', '2026-11-11')
    expect(inDialog().getByRole('radio', { name: f.on.options.deal })).toHaveProperty('checked', true)
    expect((inDialog().getByRole('combobox', { name: f.deal.label }) as HTMLInputElement).value).toBe(
      'Brera configurator',
    )
    await userEvent.click(inDialog().getByRole('button', { name: strings.common.cancel }))
    await userEvent.click(screen.getByTestId('hours-table-cell-done'))

    await addHoursIn('meeting:m-retro', '2026-11-09')
    expect(inDialog().getByRole('radio', { name: f.on.options.meeting })).toHaveProperty('checked', true)
    expect((inDialog().getByRole('combobox', { name: f.meeting.label }) as HTMLInputElement).value).toBe(
      'Retrospective',
    )
    await userEvent.click(inDialog().getByRole('button', { name: strings.common.cancel }))
    await userEvent.click(screen.getByTestId('hours-table-cell-done'))

    await addHoursIn('category:tc-formazione', '2026-11-10')
    expect(inDialog().getByRole('radio', { name: f.on.options.none })).toHaveProperty('checked', true)
    expect((inDialog().getByRole('combobox', { name: f.category.label }) as HTMLSelectElement).value).toBe(
      'tc-formazione',
    )
  })

  it('is the same dialog as Record hours in the header: nothing fixed, the kind and the pickers are there', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await addHoursIn('project:p-alpha', '2026-11-09')

    expect(inDialog().getAllByRole('radio')).toHaveLength(4)
    expect(dialog().getAttribute('aria-describedby')).toBeNull()
  })

  it('Cancel closes it with nothing sent and the week as it was, and gives focus back to Add hours', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await userEvent.click(cellButton('project:p-alpha', '2026-11-09') as HTMLElement)
    const before = entriesCalls().length

    await userEvent.click(screen.getByTestId('hours-table-cell-add'))
    await userEvent.click(inDialog().getByRole('button', { name: strings.common.cancel }))

    expect(screen.queryByRole('dialog', { name: e.dialog.recordTitle })).toBeNull()
    expect(postCalls()).toHaveLength(0)
    expect(entriesCalls()).toHaveLength(before)
    expect(document.activeElement).toBe(screen.getByTestId('hours-table-cell-add'))
  })
})

/** The eight figures of a row of the table — Monday to Sunday, then its total — as the grid draws them. */
const figuresOf = (rowKey: string) =>
  within(screen.getByTestId(`hours-table-row-${rowKey}`))
    .getAllByRole('cell')
    .map((cell) => cell.textContent)
const NONE = strings.common.none

describe('the figures follow a save without a reload (AC-5.20)', () => {
  it('closes the dialog, reads the same week again, and the cell, its row, its day and the week all show the new hours', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    expect(figuresOf('project:p-alpha')).toEqual(['4 h', '2 h 30', '', '', '', '', '', '6 h 30'])
    const before = entriesCalls().length

    await addHoursIn('project:p-alpha', '2026-11-09')
    await typeDuration(durationField(), '2')
    await save()

    await waitFor(() => expect(screen.queryByRole('dialog', { name: e.dialog.recordTitle })).toBeNull())
    await waitFor(() => expect(figuresOf('project:p-alpha')[0]).toBe('6 h'))
    // One more read, of the same week, asked for in full.
    expect(entriesCalls()).toHaveLength(before + 1)
    expect(entriesCalls().at(-1)!.query).toMatchObject({
      whose: 'mine',
      from: THIS_MONDAY,
      to: THIS_SUNDAY,
      limit: '500',
    })
    // The cell, its row, the day and the week.
    expect(figuresOf('project:p-alpha')).toEqual(['6 h', '2 h 30', '', '', '', '', '', '8 h 30'])
    expect(figuresOf('total')).toEqual(['6 h', '2 h 30', '1 h', NONE, NONE, NONE, NONE, '9 h 30'])
    // Nothing of the List was read.
    expect(requests(api, 'GET /time-entries/totals')).toHaveLength(0)
  })

  it('says so where the person acted: "Entry saved."', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await addHoursIn('project:p-alpha', '2026-11-09')
    await typeDuration(durationField(), '2')
    await save()

    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('an entry moved by the dialog onto a day or a row of its own is a cell of its own, and the cell it came from is as it was', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await addHoursIn('project:p-alpha', '2026-11-09')
    fireEvent.change(dayField(), { target: { value: '2026-11-12' } })
    await typeDuration(durationField(), '1')
    await save()

    await waitFor(() => expect(figuresOf('project:p-alpha')[3]).toBe('1 h'))
    expect(figuresOf('project:p-alpha')).toEqual(['4 h', '2 h 30', '', '1 h', '', '', '', '7 h 30'])
    expect(cellButton('project:p-alpha', '2026-11-09')).not.toBeNull()
  })
})

describe('a save on a day outside the week shown says so (design F6, S7)', () => {
  const recordFromHeader = async (day: string) => {
    await userEvent.click(screen.getByTestId('hours-record'))
    fireEvent.change(dayField(), { target: { value: day } })
    await typeDuration(durationField(), '1')
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.none }))
    await userEvent.selectOptions(inDialog().getByRole('combobox', { name: f.category.label }), 'Formazione')
    await save()
  }

  it('Record hours in the header on a day of an earlier week: the week shown is not the one it landed in', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await recordFromHeader('2026-11-02')

    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(w.week.savedOutside('02.11.2026'))
  })

  it('says the plain "Entry saved." for a day of the week shown, the first and the last of it included', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await recordFromHeader(THIS_MONDAY)
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('Add hours in a cell of an earlier week whose day was changed to another week says so; the week shown stays the one it was', async () => {
    useApi()
    held.push(entry('2026-11-03', 180, projectOn('p-alpha', 'Alpenstrom')))
    const router = await renderPage(`/hours?week=${LAST_MONDAY}`)
    await screen.findByTestId('hours-table-table')

    await addHoursIn('project:p-alpha', '2026-11-03')
    expect(dayField().value).toBe('2026-11-03')
    fireEvent.change(dayField(), { target: { value: THIS_MONDAY } })
    await typeDuration(durationField(), '1')
    await save()

    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(w.week.savedOutside('09.11.2026'))
    expect(new URLSearchParams(router.state.location.searchStr).get('week')).toBe(LAST_MONDAY)
    expect(entriesCalls().at(-1)!.query).toMatchObject({ from: LAST_MONDAY, to: LAST_SUNDAY })
  })

  it('the List still says it about its period, as it did', async () => {
    useApi()
    await renderPage('/hours?view=list&period=thisMonth')
    await screen.findByTestId('hours-entries')

    await recordFromHeader('2026-10-30')

    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.savedOutsidePeriod('30.10.2026'))
  })
})

describe('Record hours in the header while the Week is shown (AC-5.19, F6)', () => {
  const recordOnProjectAlpha = async (day?: string) => {
    await userEvent.click(screen.getByTestId('hours-record'))
    if (day !== undefined) fireEvent.change(dayField(), { target: { value: day } })
    await typeDuration(durationField(), '3')
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.project }))
    await userEvent.type(inDialog().getByRole('combobox', { name: f.project.label }), 'p')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
    await save()
  }

  it('a target with no hours in the week gets its row, in its place, and the week total follows', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    expect(screen.queryByTestId('hours-table-row-project:p1')).toBeNull()

    await recordOnProjectAlpha('2026-11-12')

    const row = await screen.findByTestId('hours-table-row-project:p1')
    expect(within(row).getByText(NAMES['p1']!)).not.toBeNull()
    expect(figuresOf('project:p1')).toEqual(['', '', '', '3 h', '', '', '', '3 h'])
    // Projects come in name order: Alpenstrom, then Project Alpha.
    const keys = within(screen.getByTestId('hours-table-table'))
      .getAllByRole('row')
      .map((r) => r.getAttribute('data-testid'))
    expect(keys.indexOf('hours-table-row-project:p-alpha')).toBeLessThan(keys.indexOf('hours-table-row-project:p1'))
    expect(figuresOf('total')[7]).toBe('10 h 30')
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('a target that already has a row adds to it, and does not make a second', async () => {
    useApi()
    held.push(entry('2026-11-12', 60, projectOn('p1', 'Project Alpha')))
    await renderPage()
    await screen.findByTestId('hours-table-table')
    expect(figuresOf('project:p1')[7]).toBe('1 h')

    await recordOnProjectAlpha('2026-11-12')

    await waitFor(() => expect(figuresOf('project:p1')[7]).toBe('4 h'))
    expect(screen.getAllByTestId('hours-table-row-project:p1')).toHaveLength(1)
  })

  it('focus comes back to Record hours, which is not in the grid that was replaced', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await recordOnProjectAlpha()

    await screen.findByTestId('hours-table-row-project:p1')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('hours-record')))
  })
})

describe('focus after a Retry of the deal filter’s refusal that then works (T10’s open corner)', () => {
  let healthy: boolean
  const refusedUnlessHealthy: FakeHandler = (url, init, params) =>
    url.searchParams.has('dealId') && !healthy
      ? { status: 503, body: problem(503, 'host_unavailable') }
      : entriesInRange(() => held)(url, init, params)

  const pickDeal = async () => {
    await userEvent.type(screen.getByRole('combobox', { name: f.deal.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
  }

  it('goes to the Week card’s heading: the Retry button that had it is gone, and the new grid is where the person looks', async () => {
    healthy = false
    useApi({ 'GET /time-entries': refusedUnlessHealthy })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')
    healthy = true

    await userEvent.click(
      within(screen.getByTestId('hours-deal-filter-unavailable')).getByRole('button', { name: strings.common.retry }),
    )

    await screen.findByTestId('hours-table-table')
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('a Retry that fails again keeps focus on the alert, as before', async () => {
    healthy = false
    useApi({ 'GET /time-entries': refusedUnlessHealthy })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await pickDeal()
    const alert = await screen.findByTestId('hours-deal-filter-unavailable')

    await userEvent.click(within(alert).getByRole('button', { name: strings.common.retry }))

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('hours-deal-filter-unavailable')))
  })
})

describe('a refused save leaves everything as it was (AC-5.13, WA3)', () => {
  it('a 403 not_on_project is worded on the project picker with every value kept, and the week is not read again', async () => {
    useApi({ 'POST /time-entries': () => ({ status: 403, body: problem(403, 'not_on_project') }) })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    const before = entriesCalls().length

    await addHoursIn('project:p-alpha', '2026-11-09')
    await typeDuration(durationField(), '2')
    await save()

    await screen.findByText(e.errors.notOnProject)
    expect(dialog()).not.toBeNull()
    expect(durationField()).toHaveProperty('value', '2')
    expect(dayField().value).toBe('2026-11-09')
    expect((inDialog().getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe(ALPENSTROM)
    expect(entriesCalls()).toHaveLength(before)
    expect(screen.queryByTestId('hours-entry-saved')).toBeNull()
  })
})

describe('a retired category’s row and a project the person may not read are blank where they hold nothing, as every row is (AC-5.24, AC-5.32, D12)', () => {
  it('their empty days are blank cells, and so are a readable row’s: no row has a control on a day without hours', async () => {
    useApi()
    held.push(
      entry('2026-11-09', 60, otherWorkOn('Seminars', 'tc-seminars', true)),
      entry('2026-11-10', 60, projectOn('p-secret', null, 'hidden')),
    )
    await renderPage()
    await screen.findByTestId('hours-table-table')

    // The keys are the rows' real ones: the cell that HOLDS hours is a button on each, so a wrong key cannot pass the
    // absences below by finding nothing (QE: this once asserted on `project:unknown`, a key no row here has).
    expect(cellButton('category:tc-seminars', '2026-11-09')).not.toBeNull()
    expect(cellButton('project:p-secret', '2026-11-10')).not.toBeNull()
    expect(cellButton('category:tc-seminars', '2026-11-12')).toBeNull()
    expect(cellButton('project:p-secret', '2026-11-12')).toBeNull()
    expect(screen.queryAllByRole('button', { name: /^Record hours on / })).toEqual([])
    // The rows with a name offer nothing on their empty days either (AC-5.32): the three cells of the seed, and these two.
    expect(cellButton('project:p-alpha', '2026-11-12')).toBeNull()
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(SEED.length + 2)
  })
})

describe('after a write whose re-read fails (design S7 "States")', () => {
  it('shows the error with Retry and no stale grid, and the keyboard is on Record hours, never on the page body', async () => {
    let failing = false
    useApi({
      'GET /time-entries': (url, init, params) =>
        failing ? { status: 500, body: problem(500) } : entriesInRange(() => held)(url, init, params),
      'POST /time-entries': (_url, init) => {
        failing = true
        return { status: 201, body: madeOf(JSON.parse(String(init?.body))) }
      },
    })
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await userEvent.click(screen.getByTestId('hours-record'))
    await typeDuration(durationField(), '2')
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.none }))
    await userEvent.selectOptions(inDialog().getByRole('combobox', { name: f.category.label }), 'Formazione')
    await save()

    await screen.findByTestId('hours-table-error')
    expect(screen.queryByTestId('hours-table-table')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('hours-record')))
  })

  it('a request for focus left over from the Week is dropped with the view: coming back to it later takes nothing', async () => {
    const reading = deferred<{ status: number; body: unknown }>()
    let holdNext = false
    useApi({
      'GET /time-entries': (url, init, params) =>
        holdNext ? reading.promise : entriesInRange(() => held)(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-table-table')

    // A cell's list is open and an edit of its entry is being saved: the week is read again behind it. Closing the list now
    // asks for focus on the cell, which has to wait for the read to settle.
    await openCellOf('project:p-alpha', '2026-11-09')
    await userEvent.click(editOf(MON_1))
    await typeDuration(editDuration(), '2')
    holdNext = true
    await saveEdit()
    await screen.findByTestId('hours-table-skeleton')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    // The person goes to the List before it answers, and back.
    await userEvent.click(screen.getByRole('tab', { name: w.view.list }))
    holdNext = false
    reading.resolve({ status: 200, body: entriesPage(held) })
    await screen.findByTestId('hours-entries')
    await userEvent.click(screen.getByRole('tab', { name: w.view.table }))
    await screen.findByTestId('hours-table-table')

    expect(document.activeElement).toBe(screen.getByRole('tab', { name: w.view.table }))
  })
})

describe('the Week never shows what it read before the entries changed (useHoursQuery, T12)', () => {
  it('Week → List, an entry deleted there → Week: a skeleton, then the new figures — never the old ones, not even for one read', async () => {
    const reading = deferred<{ status: number; body: unknown }>()
    let holdWeek = false
    useApi({
      'GET /time-entries': (url, init, params) =>
        holdWeek && url.searchParams.get('to') === THIS_SUNDAY
          ? reading.promise
          : entriesInRange(() => held)(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    expect(figuresOf('project:p-alpha')[7]).toBe('6 h 30')

    await userEvent.click(screen.getByRole('tab', { name: w.view.list }))
    await screen.findByTestId('hours-day-list')
    await userEvent.click(screen.getByTestId(`hours-entry-${SEED[0]!.id}-delete`))
    await userEvent.click(
      within(screen.getByRole('alertdialog', { name: e.delete.title })).getByRole('button', { name: e.delete.confirm }),
    )
    await waitFor(() => expect(screen.queryByTestId(`hours-entry-${SEED[0]!.id}`)).toBeNull())

    // Back to the Week, whose read is slow: what it held before the delete (6 h 30 on Alpenstrom) must not come back.
    holdWeek = true
    await userEvent.click(screen.getByRole('tab', { name: w.view.table }))

    expect(screen.queryByTestId('hours-table-table')).toBeNull()
    expect(screen.getByTestId('hours-table-skeleton')).not.toBeNull()
    reading.resolve({ status: 200, body: entriesPage(held.filter((item) => item.day >= THIS_MONDAY)) })
    await screen.findByTestId('hours-table-table')
    expect(figuresOf('project:p-alpha')).toEqual(['', '2 h 30', '', '', '', '', '', '2 h 30'])
    expect(figuresOf('total')[7]).toBe('3 h 30')
  })
})

/* ─── T12: a cell's entries ───────────────────────────────────────────────────────────────────────────────────── */

const MONDAY_LONG = 'Monday 9 November 2026'
const patchCalls = () => requests(api, 'PATCH /time-entries/:id')
const deleteCalls = () => requests(api, 'DELETE /time-entries/:id')
const cellOpener = (key: string, day: string) => cellButton(key, day) as HTMLElement
const openCellOf = (key: string, day: string) => userEvent.click(cellOpener(key, day))
const cellDialog = (name = 'Project: Alpenstrom') => screen.getByRole('dialog', { name })
const editDialog = () => screen.getByRole('dialog', { name: e.dialog.editTitle })
const deleteDialog = () => screen.getByRole('alertdialog', { name: e.delete.title })
const editOf = (id: string) => screen.getByTestId(`hours-entry-${id}-edit`)
const deleteOf = (id: string) => screen.getByTestId(`hours-entry-${id}-delete`)
const cellHeading = (name = 'Project: Alpenstrom') => screen.getByRole('heading', { name })
const saveEdit = () => userEvent.click(within(editDialog()).getByRole('button', { name: e.dialog.save }))
const editDuration = () => within(editDialog()).getByRole('textbox', { name: f.duration.label })
const editDay = () => within(editDialog()).getByLabelText(new RegExp(`^${f.day}`)) as HTMLInputElement
const confirmDelete = () => userEvent.click(within(deleteDialog()).getByRole('button', { name: e.delete.confirm }))

/** A second entry of Alpenstrom on Monday, so that cell holds two: 4 h and 1 h 30. */
const SUPPORT_CALL = (): TimeEntryView =>
  timeEntryView({
    id: 'e-mon2',
    day: '2026-11-09',
    minutes: 90,
    on: projectOn('p-alpha', 'Alpenstrom'),
    note: 'Support call',
  })

/** The ids the first Monday entry and the second Tuesday one of the seed have. */
const MON_1 = SEED[0]!.id
const TUE_1 = SEED[1]!.id
const WED_BRERA = SEED[2]!.id

describe('a cell that holds hours opens its entries (AC-5.15)', () => {
  it('is titled with the row and the day, lists the cell’s entries as the List does, and opens on the first Edit', async () => {
    useApi()
    held.push(SUPPORT_CALL())
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await userEvent.click(screen.getByRole('button', { name: w.cell.open('5 h 30', ALPENSTROM, MONDAY_LONG, 2) }))

    const open = cellDialog()
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Monday 9 November 2026 · 2 entries, 5 h 30',
    )
    const items = within(open).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]!).getByTestId(`hours-entry-${MON_1}`)).not.toBeNull()
    expect(within(items[1]!).getByTestId('hours-entry-e-mon2')).not.toBeNull()
    expect(within(open).getByTestId('hours-entry-e-mon2').textContent).toContain('Support call')
    expect(editOf('e-mon2').getAttribute('aria-label')).toBe('Edit 1 h 30 on Alpenstrom, 09.11.2026')
    expect(document.activeElement).toBe(editOf(MON_1))
    // Nothing was written or read for it: the entries are the grid's.
    expect(postCalls()).toHaveLength(0)
    expect(entriesCalls()).toHaveLength(1)
  })

  it.each([
    ['Close', () => userEvent.click(screen.getByTestId('hours-table-cell-done'))],
    ['×', () => userEvent.click(screen.getByTestId('hours-table-cell-close'))],
    ['Escape', () => userEvent.keyboard('{Escape}')],
  ])('%s closes it with nothing sent or read, and focus goes back to the cell', async (_how, close) => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    const before = entriesCalls().length

    await openCellOf('project:p-alpha', '2026-11-09')
    await close()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(entriesCalls()).toHaveLength(before)
    expect(document.activeElement).toBe(cellOpener('project:p-alpha', '2026-11-09'))
  })

  it('a deal’s cell opens on the deal, and the dialog is that row’s alone', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await openCellOf('deal:d-brera', '2026-11-11')

    expect(cellDialog('Deal: Brera configurator')).not.toBeNull()
    expect(within(cellDialog('Deal: Brera configurator')).getAllByRole('listitem')).toHaveLength(1)
  })

  it('leaving the week while it is open closes it for good: coming back does not find it open', async () => {
    useApi()
    const router = await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')
    expect(cellDialog()).not.toBeNull()

    act(() => router.history.push(`/hours?week=${LAST_MONDAY}`))
    await waitFor(() => expect(heading().textContent).toContain('02.11.2026'))
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => router.history.back())
    await waitFor(() => expect(heading().textContent).toContain('09.11.2026'))
    await screen.findByTestId('hours-table-table')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Edit from the cell (AC-5.16, AC-5.20)', () => {
  it('opens the entry dialog on that entry over the cell dialog, PATCHes only what changed, and the figures follow', async () => {
    useApi()
    held.push(SUPPORT_CALL())
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')

    await userEvent.click(editOf('e-mon2'))

    // Over it: both are there, the entry dialog filled from the entry.
    expect(cellDialog()).not.toBeNull()
    expect(editDay().value).toBe('2026-11-09')
    expect(editDuration()).toHaveProperty('value', '1 h 30')
    await typeDuration(editDuration(), '2')
    await saveEdit()

    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    expect(patchCalls()[0]).toMatchObject({ path: '/time-entries/e-mon2', body: { minutes: 120 } })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: e.dialog.editTitle })).toBeNull())
    // The week is read again and every figure follows, behind the dialog and in it.
    await waitFor(() => expect(figuresOf('project:p-alpha')).toEqual(['6 h', '2 h 30', '', '', '', '', '', '8 h 30']))
    expect(within(cellDialog()).getByTestId('hours-entry-e-mon2').textContent).toContain('2 h')
    expect(document.getElementById(cellDialog().getAttribute('aria-describedby')!)!.textContent).toBe(
      'Monday 9 November 2026 · 2 entries, 6 h',
    )
    // Focus is back on that entry’s Edit, in the dialog: not on the page behind it.
    expect(document.activeElement).toBe(editOf('e-mon2'))
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('Cancel sends nothing and gives focus back to that entry’s Edit', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')
    const before = entriesCalls().length

    await userEvent.click(editOf(MON_1))
    await userEvent.click(within(editDialog()).getByRole('button', { name: strings.common.cancel }))

    expect(patchCalls()).toHaveLength(0)
    expect(entriesCalls()).toHaveLength(before)
    expect(cellDialog()).not.toBeNull()
    expect(document.activeElement).toBe(editOf(MON_1))
  })

  it('moving an entry to another day takes it out of the cell: the dialog lists what is left, focus on its heading', async () => {
    useApi()
    held.push(SUPPORT_CALL())
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')

    await userEvent.click(editOf('e-mon2'))
    fireEvent.change(editDay(), { target: { value: '2026-11-10' } })
    await saveEdit()

    await waitFor(() => expect(patchCalls()[0]?.body).toEqual({ day: '2026-11-10' }))
    await waitFor(() => expect(screen.queryByTestId('hours-entry-e-mon2')).toBeNull())
    expect(within(cellDialog()).getAllByRole('listitem')).toHaveLength(1)
    expect(figuresOf('project:p-alpha')).toEqual(['4 h', '4 h', '', '', '', '', '', '8 h'])
    await waitFor(() => expect(document.activeElement).toBe(cellHeading()))
    expect(cellDialog().contains(document.activeElement)).toBe(true)
  })

  it('moving the only entry of a cell closes the dialog once the new figures are there, and focus is on the card’s heading: the cell is blank now', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('deal:d-brera', '2026-11-11')

    await userEvent.click(editOf(WED_BRERA))
    fireEvent.change(editDay(), { target: { value: '2026-11-12' } })
    await saveEdit()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Brera’s Wednesday is empty, and an empty cell is no control; Thursday holds the hour.
    expect(figuresOf('deal:d-brera')).toEqual(['', '', '', '1 h', '', '', '', '1 h'])
    expect(cellButton('deal:d-brera', '2026-11-11')).toBeNull()
    expect(tdOf('deal:d-brera', '2026-11-11').children).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('an entry that is already gone when saved: the dialog says so, and closing it leaves focus in the cell dialog, not on the page', async () => {
    useApi({
      'PATCH /time-entries/:id': (_url, _init, params) => {
        held = held.filter((item) => item.id !== params['id'])
        return { status: 404, body: problem(404) }
      },
    })
    held.push(SUPPORT_CALL())
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')
    const before = entriesCalls().length

    await userEvent.click(editOf('e-mon2'))
    await typeDuration(editDuration(), '2')
    await saveEdit()
    expect((await within(editDialog()).findByRole('alert')).textContent).toBe(e.errors.entryGone)
    await userEvent.click(within(editDialog()).getByRole('button', { name: strings.common.cancel }))

    await waitFor(() => expect(entriesCalls()).toHaveLength(before + 1))
    await waitFor(() => expect(screen.queryByTestId('hours-entry-e-mon2')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(cellHeading()))
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { level: 2, name: strings.myHours.heading }))
  })
})

describe('Delete from the cell (AC-5.17, AC-5.20)', () => {
  it('asks first: nothing is sent until Confirm, and Cancel sends nothing and gives focus back to Delete', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')
    const before = entriesCalls().length

    await userEvent.click(deleteOf(MON_1))

    expect(deleteDialog().textContent).toContain("4 h on Alpenstrom, 09.11.2026. This can't be undone.")
    expect(cellDialog()).not.toBeNull()
    expect(deleteCalls()).toHaveLength(0)
    await userEvent.click(within(deleteDialog()).getByRole('button', { name: strings.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(deleteCalls()).toHaveLength(0)
    expect(entriesCalls()).toHaveLength(before)
    expect(document.activeElement).toBe(deleteOf(MON_1))
  })

  it('Confirm deletes it, the figures follow, the dialog lists the rest with focus on its heading, and the page says so', async () => {
    useApi()
    held.push(SUPPORT_CALL())
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')

    await userEvent.click(deleteOf('e-mon2'))
    await confirmDelete()

    await waitFor(() => expect(deleteCalls()).toHaveLength(1))
    expect(deleteCalls()[0]).toMatchObject({ method: 'DELETE', path: '/time-entries/e-mon2' })
    await waitFor(() => expect(screen.queryByTestId('hours-entry-e-mon2')).toBeNull())
    expect(figuresOf('project:p-alpha')).toEqual(['4 h', '2 h 30', '', '', '', '', '', '6 h 30'])
    expect(figuresOf('total')[7]).toBe('7 h 30')
    expect(within(cellDialog()).getAllByRole('listitem')).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(cellHeading()))
    expect((await screen.findByTestId('hours-entry-deleted')).textContent).toBe(e.delete.deleted)
  })

  it('deleting the last entry of a cell closes the dialog after the new figures, leaves the cell blank, and focus goes to the card’s heading', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-10')

    await userEvent.click(deleteOf(TUE_1))
    await confirmDelete()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(figuresOf('project:p-alpha')).toEqual(['4 h', '', '', '', '', '', '', '4 h'])
    expect(cellButton('project:p-alpha', '2026-11-10')).toBeNull()
    expect(tdOf('project:p-alpha', '2026-11-10').children).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(heading()))
    expect(screen.getByTestId('hours-entry-deleted')).not.toBeNull()
  })

  it('deleting the only entry of a row leaves the week without that row, and focus goes to the card’s heading', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('deal:d-brera', '2026-11-11')

    await userEvent.click(deleteOf(WED_BRERA))
    await confirmDelete()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByTestId('hours-table-row-deal:d-brera')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('an entry that is already gone (404) is what the person wanted: it says so and the emptied cell is handled the same way', async () => {
    useApi({
      'DELETE /time-entries/:id': (_url, _init, params) => {
        held = held.filter((item) => item.id !== params['id'])
        return { status: 404, body: problem(404) }
      },
    })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-10')

    await userEvent.click(deleteOf(TUE_1))
    await confirmDelete()

    expect((await screen.findByTestId('hours-entry-gone')).textContent).toBe(e.delete.gone)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('a failed delete keeps the confirmation open with the error, the cell dialog and its entries as they were, and reads nothing', async () => {
    useApi({ 'DELETE /time-entries/:id': () => ({ status: 500, body: problem(500) }) })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-10')
    const before = entriesCalls().length

    await userEvent.click(deleteOf(TUE_1))
    await confirmDelete()

    expect((await within(deleteDialog()).findByRole('alert')).textContent).toBe(e.delete.error)
    expect(cellDialog()).not.toBeNull()
    expect(screen.getByTestId(`hours-entry-${TUE_1}`)).not.toBeNull()
    expect(entriesCalls()).toHaveLength(before)
  })
})

describe('Add hours from the cell (AC-5.18, AC-5.20)', () => {
  it('opens the entry dialog on that day and row with focus on Duration, over the cell dialog; once saved the entry is in the list', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')

    await userEvent.click(screen.getByTestId('hours-table-cell-add'))

    expect(dayField().value).toBe('2026-11-09')
    expect(inDialog().getByRole('radio', { name: f.on.options.project })).toHaveProperty('checked', true)
    expect((inDialog().getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe(ALPENSTROM)
    expect(document.activeElement).toBe(durationField())
    expect(cellDialog()).not.toBeNull()
    await typeDuration(durationField(), '1')
    await save()

    await waitFor(() => expect(postCalls()).toHaveLength(1))
    expect(postCalls()[0]!.body).toEqual({ day: '2026-11-09', minutes: 60, on: { type: 'project', id: 'p-alpha' } })
    await waitFor(() => expect(within(cellDialog()).getAllByRole('listitem')).toHaveLength(2))
    expect(figuresOf('project:p-alpha')).toEqual(['5 h', '2 h 30', '', '', '', '', '', '7 h 30'])
    // Focus is where it was before the dialog opened: Add hours, in the cell dialog — not the page behind it.
    expect(document.activeElement).toBe(screen.getByTestId('hours-table-cell-add'))
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('is not offered on a row the person cannot read nor on a retired category’s, whose entries still offer Edit and Delete', async () => {
    useApi()
    const secret = timeEntryView({
      id: 'e-secret',
      day: '2026-11-09',
      minutes: 60,
      on: projectOn('p-secret', null, 'hidden'),
    })
    const seminar = timeEntryView({
      id: 'e-seminar',
      day: '2026-11-10',
      minutes: 120,
      on: otherWorkOn('Seminars', 'tc-seminars', true),
    })
    held.push(secret, seminar)
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await openCellOf('project:p-secret', '2026-11-09')
    expect(cellDialog(`Project: ${strings.names.hidden}`)).not.toBeNull()
    expect(screen.queryByTestId('hours-table-cell-add')).toBeNull()
    expect(editOf('e-secret')).not.toBeNull()
    expect(deleteOf('e-secret')).not.toBeNull()
    await userEvent.click(screen.getByTestId('hours-table-cell-done'))

    await openCellOf('category:tc-seminars', '2026-11-10')
    expect(cellDialog('Other work: Seminars (retired)')).not.toBeNull()
    expect(screen.queryByTestId('hours-table-cell-add')).toBeNull()
    expect(editOf('e-seminar')).not.toBeNull()
    expect(deleteOf('e-seminar')).not.toBeNull()
  })

  it('is not offered on a day after today, should the server hold hours on one', async () => {
    useApi()
    held.push(
      timeEntryView({ id: 'e-future', day: '2026-11-14', minutes: 60, on: otherWorkOn('Formazione', 'tc-formazione') }),
    )
    await renderPage()
    await screen.findByTestId('hours-table-table')

    await openCellOf('category:tc-formazione', '2026-11-14')

    expect(cellDialog('Other work: Formazione')).not.toBeNull()
    expect(screen.queryByTestId('hours-table-cell-add')).toBeNull()
  })
})

describe('after a write from the cell dialog (AC-5.20, design S8)', () => {
  it('closing the dialog puts focus on the cell: the button it was opened from went with the grid that was read again', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-table-table')
    const opener = cellOpener('project:p-alpha', '2026-11-09')
    await userEvent.click(opener)

    await userEvent.click(editOf(MON_1))
    await typeDuration(editDuration(), '2')
    await saveEdit()
    await waitFor(() => expect(figuresOf('project:p-alpha')[0]).toBe('2 h'))
    expect(opener.isConnected).toBe(false)
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(cellOpener('project:p-alpha', '2026-11-09')))
  })

  it('keeps its entries and its buttons while the week is read again — the grid behind it is a skeleton — and updates in place when the new one lands', async () => {
    const reading = deferred<{ status: number; body: unknown }>()
    let holdNext = false
    useApi({
      'GET /time-entries': (url, init, params) =>
        holdNext ? reading.promise : entriesInRange(() => held)(url, init, params),
    })
    held.push(SUPPORT_CALL())
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')
    const row = screen.getByTestId('hours-entry-e-mon2')

    await userEvent.click(editOf('e-mon2'))
    await typeDuration(editDuration(), '2')
    holdNext = true
    await saveEdit()

    // The read is in flight: the grid is replaced by its skeleton, and the dialog is as it was, in the same DOM.
    await screen.findByTestId('hours-table-skeleton')
    expect(screen.queryByTestId('hours-table-table')).toBeNull()
    expect(cellDialog()).not.toBeNull()
    expect(screen.getByTestId('hours-entry-e-mon2')).toBe(row)
    expect(row.textContent).toContain('1 h 30')
    expect(document.activeElement).toBe(editOf('e-mon2'))

    holdNext = false
    reading.resolve({ status: 200, body: entriesPage(held.filter((item) => item.day >= THIS_MONDAY)) })
    await screen.findByTestId('hours-table-table')
    expect(screen.getByTestId('hours-entry-e-mon2')).toBe(row)
    expect(row.textContent).toContain('2 h')
    expect(document.activeElement).toBe(editOf('e-mon2'))
  })

  it('a re-read that fails leaves the dialog usable with the entries it last had, the error behind it, and closing it goes to the heading', async () => {
    let failing = false
    useApi({
      'GET /time-entries': (url, init, params) =>
        failing ? { status: 500, body: problem(500) } : entriesInRange(() => held)(url, init, params),
      'PATCH /time-entries/:id': (_url, init) => {
        failing = true
        return { status: 200, body: { ...held[0]!, ...(JSON.parse(String(init?.body)) as object) } }
      },
    })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')

    await userEvent.click(editOf(MON_1))
    await typeDuration(editDuration(), '2')
    await saveEdit()

    await screen.findByTestId('hours-table-error')
    expect(cellDialog()).not.toBeNull()
    expect(screen.getByTestId(`hours-entry-${MON_1}`)).not.toBeNull()
    expect((editOf(MON_1) as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(screen.getByTestId('hours-table-cell-done'))

    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })
})

describe('where the keyboard is after a delete from the cell that failed (QE round 1; design S8 and § Accessibility)', () => {
  // A request takes a frame or more, and a browser takes focus off the disabled Confirm in that time.
  let stopFixup: () => void
  beforeEach(() => {
    stopFixup = emulateFocusFixup()
  })
  afterEach(() => stopFixup())

  const confirmButton = () => within(deleteDialog()).getByRole('button', { name: e.delete.confirm })

  it('Confirm has it again with the error shown, the cell dialog still behind it, and Enter on it asks again', async () => {
    let calls = 0
    useApi({
      'DELETE /time-entries/:id': (_url, _init, params) => {
        if (++calls === 1) return afterAFrame({ status: 503, body: problem(503) })
        held = held.filter((item) => item.id !== params['id'])
        return { status: 204 }
      },
    })
    await renderPage()
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-10')

    await userEvent.click(deleteOf(TUE_1))
    await confirmDelete()

    expect((await within(deleteDialog()).findByRole('alert')).textContent).toBe(e.delete.error)
    await waitFor(() => expect(document.activeElement).toBe(confirmButton()))
    expect(cellDialog()).not.toBeNull()

    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(deleteCalls()).toHaveLength(2))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })
})

/**
 * The same cells in the month (specs/20261116-record-hours-in-place T22; AC-5.15–AC-5.20, D15, MA1): a month cell that holds
 * hours opens the same list with the same Edit, Delete and Add hours, each of which reads the month again in whole and shows
 * the new figures, the month's row total and day totals included. The week's own cases above are the reference; this block
 * runs the ones that depend on what the person acted on (the span of the re-read, the sentence for a day outside the period,
 * the row a first entry makes) against the month, so a month that drifted from the week fails here.
 */
describe('the same from the cells of the month (AC-5.15–AC-5.20, MA1)', () => {
  const MONTH = '/hours?view=month'
  /** The month's figures of a row: one cell for each of November's 30 days, then the row's total. */
  const monthCells = (rowKey: string) =>
    within(screen.getByTestId(`hours-table-row-${rowKey}`))
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
  const onDay = (rowKey: string, day: string) => monthCells(rowKey)[Number(day.slice(8)) - 1]
  const rowTotal = (rowKey: string) => monthCells(rowKey).at(-1)
  const NOVEMBER = ['2026-11-01', '2026-11-30']
  const spanOf = (call: ReturnType<typeof entriesCalls>[number]) => [call.query['from'], call.query['to']]

  it('is the month that is read: its first and last day, in full, and the Monday entry is a cell of it', async () => {
    useApi()
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')

    expect(entriesCalls().map(spanOf)).toEqual([NOVEMBER])
    expect(monthCells('project:p-alpha')).toHaveLength(31)
    expect(onDay('project:p-alpha', '2026-11-09')).toBe('4 h')
    expect(onDay('project:p-alpha', '2026-11-10')).toBe('2 h 30')
    expect(rowTotal('project:p-alpha')).toBe('6 h 30')
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(SEED.length)
  })

  it('a month cell opens its entries as a week cell does: titled with the row and the day, the first Edit focused', async () => {
    useApi()
    held.push(SUPPORT_CALL())
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')

    await userEvent.click(screen.getByRole('button', { name: w.cell.open('5 h 30', ALPENSTROM, MONDAY_LONG, 2) }))

    const open = cellDialog()
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Monday 9 November 2026 · 2 entries, 5 h 30',
    )
    expect(within(open).getAllByRole('listitem')).toHaveLength(2)
    expect(document.activeElement).toBe(editOf(MON_1))
    expect(entriesCalls()).toHaveLength(1)
  })

  it('Add hours in a month cell: the dialog has that day and that row, and once saved the month is read again, the figures following (AC-5.18, AC-5.20)', async () => {
    useApi()
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')
    expect(rowTotal('project:p-alpha')).toBe('6 h 30')
    const before = entriesCalls().length

    await addHoursIn('project:p-alpha', '2026-11-09')
    expect(dayField().value).toBe('2026-11-09')
    await typeDuration(durationField(), '2')
    await save()

    await waitFor(() => expect(postCalls()).toHaveLength(1))
    expect(postCalls()[0]!.body).toEqual({ day: '2026-11-09', minutes: 120, on: { type: 'project', id: 'p-alpha' } })
    await waitFor(() => expect(onDay('project:p-alpha', '2026-11-09')).toBe('6 h'))
    expect(entriesCalls()).toHaveLength(before + 1)
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(NOVEMBER)
    expect(entriesCalls().at(-1)!.query['limit']).toBe('500')
    expect(rowTotal('project:p-alpha')).toBe('8 h 30')
    // the month's day total and the month's total follow, in the totals row
    expect(onDay('total', '2026-11-09')).toBe('6 h')
    expect(rowTotal('total')).toBe('9 h 30')
    expect(requests(api, 'GET /time-entries/totals')).toHaveLength(0)
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('Edit from a month cell PATCHes only what changed, reads the month again, and the focus is back on that entry’s Edit', async () => {
    useApi()
    held.push(SUPPORT_CALL())
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')

    await userEvent.click(editOf('e-mon2'))
    await typeDuration(editDuration(), '2')
    await saveEdit()

    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    expect(patchCalls()[0]).toMatchObject({ path: '/time-entries/e-mon2', body: { minutes: 120 } })
    await waitFor(() => expect(onDay('project:p-alpha', '2026-11-09')).toBe('6 h'))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(NOVEMBER)
    expect(rowTotal('project:p-alpha')).toBe('8 h 30')
    expect(document.activeElement).toBe(editOf('e-mon2'))
  })

  it('Delete from a month cell asks first, deletes on Confirm, reads the month again, and the figures follow', async () => {
    useApi()
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')

    await userEvent.click(deleteOf(MON_1))
    expect(deleteCalls()).toHaveLength(0)
    await confirmDelete()

    await waitFor(() => expect(deleteCalls()).toHaveLength(1))
    // the only entry of that cell: the dialog closes, the cell is blank, and focus goes to the card's heading
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onDay('project:p-alpha', '2026-11-09')).toBe('')
    expect(cellButton('project:p-alpha', '2026-11-09')).toBeNull()
    expect(rowTotal('project:p-alpha')).toBe('2 h 30')
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(NOVEMBER)
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('deleting the only entry of a row leaves the month without that row, and focus goes to the card’s heading', async () => {
    useApi()
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')
    await openCellOf('deal:d-brera', '2026-11-11')

    await userEvent.click(deleteOf(WED_BRERA))
    await confirmDelete()

    await waitFor(() => expect(screen.queryByTestId('hours-table-row-deal:d-brera')).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('Record hours in the header on a target with no hours this month gets its row, the month total following (AC-5.19)', async () => {
    useApi()
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')
    expect(screen.queryByTestId('hours-table-row-project:p1')).toBeNull()

    await userEvent.click(screen.getByTestId('hours-record'))
    fireEvent.change(dayField(), { target: { value: '2026-11-12' } })
    await typeDuration(durationField(), '3')
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.project }))
    await userEvent.type(inDialog().getByRole('combobox', { name: f.project.label }), 'p')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
    await save()

    await screen.findByTestId('hours-table-row-project:p1')
    expect(onDay('project:p1', '2026-11-12')).toBe('3 h')
    expect(rowTotal('project:p1')).toBe('3 h')
    expect(rowTotal('total')).toBe('10 h 30')
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(NOVEMBER)
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('a save on a day of another month says so in the month’s words, and the month shown stays the one it was', async () => {
    useApi()
    const router = await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')

    await userEvent.click(screen.getByTestId('hours-record'))
    fireEvent.change(dayField(), { target: { value: '2026-10-30' } })
    await typeDuration(durationField(), '1')
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.none }))
    await userEvent.selectOptions(inDialog().getByRole('combobox', { name: f.category.label }), 'Formazione')
    await save()

    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(w.month.savedOutside('30.10.2026'))
    expect(new URLSearchParams(router.state.location.searchStr).get('view')).toBe('month')
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(NOVEMBER)
  })

  it('a day of the month shown, its first and its last included, is the plain "Entry saved."', async () => {
    useApi()
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')

    await userEvent.click(screen.getByTestId('hours-record'))
    fireEvent.change(dayField(), { target: { value: '2026-11-01' } })
    await typeDuration(durationField(), '1')
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.none }))
    await userEvent.selectOptions(inDialog().getByRole('combobox', { name: f.category.label }), 'Formazione')
    await save()

    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('leaving the month while a cell is open closes it for good: the previous month does not find it open', async () => {
    useApi()
    await renderPage(MONTH)
    await screen.findByTestId('hours-table-table')
    await openCellOf('project:p-alpha', '2026-11-09')
    expect(cellDialog()).not.toBeNull()

    act(() => {
      screen.getByRole('button', { name: w.month.nav.previous }).click()
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(heading().textContent).toBe('October 2026'))
  })
})
