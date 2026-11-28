/**
 * tableGrid — the Week view's grid, folded from one complete read of a person's week (specs/20261116-record-hours-in-place
 * T8; plan § `tableGrid`; AC-5.3, AC-5.6–5.10, AC-5.23, AC-5.24). The figures are sums over the one set of entries the
 * function is given, so they agree by construction (ADR 20261116-week-view-sums-a-complete-read-in-the-browser):
 * Σ cells = row, Σ rows = week = Σ days, each entry in exactly one cell.
 */
import { describe, expect, it, vi } from 'vitest'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import type { EntryOn, MeetingProject, TimeEntryView } from './hoursApi.types'
import { tableGrid } from './tableGrid'
import type { TableGrid } from './tableGrid'
import { daysOf, holding } from './tablePeriod'

// 2026-11-16 is a Monday: the week is Monday 16 – Sunday 22 November. The grid is folded over the days of a period
// (T18: `tableGrid(entries, daysOf(period))`), here that week's.
const MONDAY = '2026-11-16'
const DAYS = daysOf(holding('week', MONDAY))
const MON = '2026-11-16'
const TUE = '2026-11-17'
const WED = '2026-11-18'
const THU = '2026-11-19'
const SUN = '2026-11-22'

let sequence = 0
/** An entry of the author on `day`, `minutes` long, on `on`; each gets an id of its own. */
const entry = (day: string, minutes: number, on: EntryOn, overrides: Partial<TimeEntryView> = {}): TimeEntryView =>
  timeEntryView({ id: `e${++sequence}`, day, minutes, on, ...overrides })

const keys = (grid: TableGrid): string[] => grid.rows.map((row) => row.key)

describe('tableGrid: one row for what the person worked on, one cell for each day (AC-5.3, AC-5.6, AC-5.9)', () => {
  it('has the seven days of the week, Monday to Sunday, and nothing else for a week with no entries', () => {
    const grid = tableGrid([], DAYS)
    expect(grid.days).toEqual([MON, TUE, WED, THU, '2026-11-20', '2026-11-21', SUN])
    expect(grid.rows).toEqual([])
    expect(grid.dayMinutes).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(grid.totalMinutes).toBe(0)
  })

  it('puts two entries on one project on two days in one row with two cells (AC-5.6)', () => {
    const monday = entry(MON, 240, projectOn('p1', 'Alpenstrom'))
    const wednesday = entry(WED, 150, projectOn('p1', 'Alpenstrom'))
    const grid = tableGrid([monday, wednesday], DAYS)

    expect(grid.rows).toHaveLength(1)
    const [row] = grid.rows
    expect(row?.key).toBe('project:p1')
    expect(row?.kind).toBe('project')
    expect(Object.keys(row?.cells ?? {})).toEqual([MON, WED])
    expect(row?.cells[MON]).toEqual({ minutes: 240, entries: [monday] })
    expect(row?.cells[WED]).toEqual({ minutes: 150, entries: [wednesday] })
  })

  it('has a row for a project, a deal, a meeting and two categories of other work: five rows (AC-5.6)', () => {
    const grid = tableGrid(
      [
        entry(MON, 60, projectOn('p1', 'Alpenstrom')),
        entry(MON, 60, dealOn('d1', 'Brera')),
        entry(MON, 60, meetingOn('m1', 'Retrospective')),
        entry(TUE, 60, otherWorkOn('Training', 'c-training')),
        entry(TUE, 60, otherWorkOn('Administration', 'c-admin')),
      ],
      DAYS,
    )
    expect(keys(grid).sort()).toEqual(
      ['category:c-admin', 'category:c-training', 'deal:d1', 'meeting:m1', 'project:p1'].sort(),
    )
  })

  it('keeps a project, a deal and a meeting with the same id apart, and two categories apart', () => {
    const grid = tableGrid(
      [
        entry(MON, 30, projectOn('x', 'A project')),
        entry(MON, 30, dealOn('x', 'A deal')),
        entry(MON, 30, meetingOn('x', 'A meeting')),
        entry(MON, 30, otherWorkOn('Training', 'x')),
      ],
      DAYS,
    )
    expect(keys(grid)).toEqual(['project:x', 'deal:x', 'meeting:x', 'category:x'])
  })

  it('has one row for one category however many entries it has', () => {
    const grid = tableGrid(
      [
        entry(MON, 30, otherWorkOn('Training', 'c-training')),
        entry(THU, 60, otherWorkOn('Training', 'c-training')),
        entry(THU, 90, otherWorkOn('Training', 'c-training')),
      ],
      DAYS,
    )
    expect(keys(grid)).toEqual(['category:c-training'])
    expect(grid.rows[0]?.name).toBe('Training')
  })

  it('totals a cell over the entries of that row and that day, and has no cell for a day with none (AC-5.9)', () => {
    const first = entry(TUE, 60, projectOn('p1', 'Alpenstrom'))
    const second = entry(TUE, 150, projectOn('p1', 'Alpenstrom'))
    const other = entry(TUE, 30, projectOn('p2', 'Operai'))
    const grid = tableGrid([first, second, other], DAYS)

    const alpenstrom = grid.rows.find((row) => row.key === 'project:p1')
    expect(alpenstrom?.cells[TUE]).toEqual({ minutes: 210, entries: [first, second] })
    expect(Object.keys(alpenstrom?.cells ?? {})).toEqual([TUE])
    expect(alpenstrom?.cells[MON]).toBeUndefined()
    const operai = grid.rows.find((row) => row.key === 'project:p2')
    expect(operai?.cells[TUE]).toEqual({ minutes: 30, entries: [other] })
  })

  it("lists a cell's entries in the order they came, which is the server's", () => {
    const early = entry(WED, 30, projectOn('p1', 'Alpenstrom'), { id: 'z-first' })
    const late = entry(WED, 60, projectOn('p1', 'Alpenstrom'), { id: 'a-second' })
    const grid = tableGrid([early, late], DAYS)
    expect(grid.rows[0]?.cells[WED]?.entries.map((e) => e.id)).toEqual(['z-first', 'a-second'])
  })

  it('does not change the entries it is given', () => {
    const entries = [entry(MON, 60, projectOn('p1', 'Alpenstrom')), entry(TUE, 30, dealOn('d1', 'Brera'))]
    const before = structuredClone(entries)
    tableGrid(entries, DAYS)
    expect(entries).toEqual(before)
  })
})

describe("tableGrid: a meeting's hours stay on the meeting's row (AC-5.7, D10)", () => {
  const linked = (id: string) =>
    ({ state: 'linked', visibility: 'visible', id, label: 'Brera', href: `/crm/deals/${id}` }) as const

  it('puts an entry on a meeting linked to a visible deal on the meeting row, and makes no row for the deal', () => {
    const meeting = entry(WED, 60, meetingOn('m1', 'Retrospective', linked('d1')))
    const grid = tableGrid([meeting], DAYS)

    expect(keys(grid)).toEqual(['meeting:m1'])
    expect(grid.rows[0]?.cells[WED]?.entries).toEqual([meeting])
  })

  it("leaves the deal's own row as it is when the person also recorded on the deal", () => {
    const onDeal = entry(WED, 120, dealOn('d1', 'Brera'))
    const onMeeting = entry(WED, 60, meetingOn('m1', 'Retrospective', linked('d1')))
    const grid = tableGrid([onDeal, onMeeting], DAYS)

    const deal = grid.rows.find((row) => row.key === 'deal:d1')
    expect(deal?.cells[WED]).toEqual({ minutes: 120, entries: [onDeal] })
    expect(deal?.minutes).toBe(120)
    const meeting = grid.rows.find((row) => row.key === 'meeting:m1')
    expect(meeting?.minutes).toBe(60)
    expect(grid.totalMinutes).toBe(180)
  })

  it('does the same for a meeting linked to a deal the person cannot read, or whose link is not known', () => {
    const grid = tableGrid(
      [
        entry(MON, 30, meetingOn('m1', 'One', { state: 'linked', visibility: 'hidden' })),
        entry(MON, 30, meetingOn('m2', 'Two', { state: 'linked', visibility: 'unavailable' })),
        entry(MON, 30, meetingOn('m3', 'Three', { state: 'unknown' })),
        entry(MON, 30, meetingOn('m4', 'Four', { state: 'none' })),
      ],
      DAYS,
    )
    expect(keys(grid).sort()).toEqual(['meeting:m1', 'meeting:m2', 'meeting:m3', 'meeting:m4'])
  })
})

describe("tableGrid: the hours of a meeting that counts for a project stay on the meeting's row (specs/20261112-project-hours AC-4.11)", () => {
  const alpha: MeetingProject = {
    state: 'linked',
    visibility: 'visible',
    id: 'p1',
    label: 'Alpenstrom',
    href: '/projects/p1',
  }
  const meetingFor = (id: string, title: string, project: MeetingProject | undefined) =>
    project === undefined ? meetingOn(id, title) : { ...meetingOn(id, title), project }

  it('puts an entry on a meeting linked to a visible project on the meeting row, and makes no row for the project', () => {
    const meeting = entry(WED, 60, meetingFor('m1', 'Kick-off', alpha))
    const grid = tableGrid([meeting], DAYS)

    expect(keys(grid)).toEqual(['meeting:m1'])
    expect(grid.rows[0]?.kind).toBe('meeting')
    expect(grid.rows[0]?.cells[WED]?.entries).toEqual([meeting])
  })

  it("leaves the project's own row as it is when the person also recorded on the project", () => {
    const onProject = entry(WED, 120, projectOn('p1', 'Alpenstrom'))
    const onMeeting = entry(WED, 60, meetingFor('m1', 'Kick-off', alpha))
    const grid = tableGrid([onProject, onMeeting], DAYS)

    const project = grid.rows.find((row) => row.key === 'project:p1')
    expect(project?.cells[WED]).toEqual({ minutes: 120, entries: [onProject] })
    expect(project?.minutes).toBe(120)
    expect(grid.rows.find((row) => row.key === 'meeting:m1')?.minutes).toBe(60)
    expect(grid.totalMinutes).toBe(180)
  })

  it('does the same for a meeting whose project the person cannot read, is unavailable, unknown, none, or missing from the answer', () => {
    const grid = tableGrid(
      [
        entry(MON, 30, meetingFor('m1', 'One', { state: 'linked', visibility: 'hidden' })),
        entry(MON, 30, meetingFor('m2', 'Two', { state: 'linked', visibility: 'unavailable' })),
        entry(MON, 30, meetingFor('m3', 'Three', { state: 'unknown' })),
        entry(MON, 30, meetingFor('m4', 'Four', { state: 'none' })),
        entry(MON, 30, meetingFor('m5', 'Five', undefined)),
      ],
      DAYS,
    )
    expect(keys(grid).sort()).toEqual(['meeting:m1', 'meeting:m2', 'meeting:m3', 'meeting:m4', 'meeting:m5'])
  })

  it('keeps two meetings linked to one project on two rows of their own, each with its own minutes', () => {
    const grid = tableGrid(
      [entry(MON, 30, meetingFor('m1', 'Kick-off', alpha)), entry(TUE, 90, meetingFor('m2', 'Review', alpha))],
      DAYS,
    )
    expect(keys(grid).sort()).toEqual(['meeting:m1', 'meeting:m2'])
    expect(grid.rows.map((row) => row.minutes).sort()).toEqual([30, 90])
  })
})

describe('tableGrid: projects, deals, meetings, other work, and by name inside each (AC-5.8, WA8)', () => {
  const one = (on: EntryOn) => entry(MON, 30, on)

  it('orders the kinds projects, deals, meetings, other work, whatever order the entries came in', () => {
    const entries = [
      one(otherWorkOn('Training', 'c1')),
      one(meetingOn('m1', 'Retrospective')),
      one(dealOn('d1', 'Brera')),
      one(projectOn('p1', 'Alpenstrom')),
    ]
    expect(keys(tableGrid(entries, DAYS))).toEqual(['project:p1', 'deal:d1', 'meeting:m1', 'category:c1'])
    expect(keys(tableGrid([...entries].reverse(), DAYS))).toEqual([
      'project:p1',
      'deal:d1',
      'meeting:m1',
      'category:c1',
    ])
  })

  it('orders by name inside a kind, ignoring case and accents, the way the suite reads a list', () => {
    const grid = tableGrid(
      [
        one(projectOn('p-zeta', 'Zeta')),
        one(projectOn('p-eclair', 'Éclair')),
        one(projectOn('p-beta', 'beta')),
        one(projectOn('p-alpha', 'Alpha')),
        one(otherWorkOn('Training', 'c-training')),
        one(otherWorkOn('administration', 'c-admin')),
      ],
      DAYS,
    )
    expect(keys(grid)).toEqual([
      'project:p-alpha',
      'project:p-beta',
      'project:p-eclair',
      'project:p-zeta',
      'category:c-admin',
      'category:c-training',
    ])
  })

  it('reads names that differ only by case or accents as equal, and tells them apart by key', () => {
    const entries = [one(projectOn('p-c', 'cafe')), one(projectOn('p-a', 'Café')), one(projectOn('p-b', 'CAFÉ'))]
    expect(keys(tableGrid(entries, DAYS))).toEqual(['project:p-a', 'project:p-b', 'project:p-c'])
  })

  it('puts the rows with no name after the named ones of their kind, never after another kind', () => {
    const grid = tableGrid(
      [
        one(projectOn('p-hidden', null, 'hidden')),
        one(dealOn('d-zulu', 'Zulu')),
        one(projectOn('p-named', 'Zeta')),
        one(projectOn('p-unavailable', null, 'unavailable')),
        one(dealOn('d-hidden', null, 'hidden')),
      ],
      DAYS,
    )
    expect(keys(grid)).toEqual([
      'project:p-named',
      'project:p-hidden',
      'project:p-unavailable',
      'deal:d-zulu',
      'deal:d-hidden',
    ])
  })

  it('tells equal names apart by the row key, so the order does not depend on the order the entries came in', () => {
    const entries = [
      one(projectOn('p-b', 'Same')),
      one(projectOn('p-a', 'Same')),
      one(projectOn('p-d', null, 'hidden')),
      one(projectOn('p-c', null, 'hidden')),
    ]
    const expected = ['project:p-a', 'project:p-b', 'project:p-c', 'project:p-d']
    expect(keys(tableGrid(entries, DAYS))).toEqual(expected)
    expect(keys(tableGrid([...entries].reverse(), DAYS))).toEqual(expected)
  })

  it('collates by the language of the page: in Swedish "Ärlig" comes after "Zeta", in English before', () => {
    const entries = [one(projectOn('p-zeta', 'Zeta')), one(projectOn('p-arlig', 'Ärlig'))]
    try {
      vi.stubGlobal('document', { documentElement: { lang: 'sv' } })
      expect(keys(tableGrid(entries, DAYS))).toEqual(['project:p-zeta', 'project:p-arlig'])
      vi.stubGlobal('document', { documentElement: { lang: 'en' } })
      expect(keys(tableGrid(entries, DAYS))).toEqual(['project:p-arlig', 'project:p-zeta'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still orders when the page has no language, or one that is not a language tag', () => {
    const entries = [one(projectOn('p-zeta', 'Zeta')), one(projectOn('p-alpha', 'Alpha'))]
    try {
      vi.stubGlobal('document', { documentElement: { lang: '' } })
      expect(keys(tableGrid(entries, DAYS))).toEqual(['project:p-alpha', 'project:p-zeta'])
      vi.stubGlobal('document', { documentElement: { lang: 'not a tag!' } })
      expect(keys(tableGrid(entries, DAYS))).toEqual(['project:p-alpha', 'project:p-zeta'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('tableGrid: every figure is a sum over the one set, so they agree (AC-5.10)', () => {
  it('totals each row, each day and the week, each equal to the entries it covers', () => {
    const grid = tableGrid(
      [
        entry(MON, 240, projectOn('p1', 'Alpenstrom')),
        entry(TUE, 300, projectOn('p1', 'Alpenstrom')),
        entry(TUE, 60, projectOn('p2', 'Operai')),
        entry(WED, 150, projectOn('p2', 'Operai')),
        entry(WED, 60, dealOn('d1', 'Brera')),
        entry(THU, 120, otherWorkOn('Training', 'c1')),
      ],
      DAYS,
    )
    const minutesOf = (key: string) => grid.rows.find((row) => row.key === key)?.minutes
    expect(minutesOf('project:p1')).toBe(540)
    expect(minutesOf('project:p2')).toBe(210)
    expect(minutesOf('deal:d1')).toBe(60)
    expect(minutesOf('category:c1')).toBe(120)
    // Monday 240, Tuesday 300 + 60, Wednesday 150 + 60, Thursday 120, then three days with nothing.
    expect(grid.dayMinutes).toEqual([240, 360, 210, 120, 0, 0, 0])
    expect(grid.totalMinutes).toBe(930)
  })

  it('counts a Sunday and a Monday: the first and the last day of the week are in it', () => {
    const grid = tableGrid([entry(MON, 30, projectOn('p1', 'A')), entry(SUN, 60, projectOn('p1', 'A'))], DAYS)
    expect(grid.dayMinutes).toEqual([30, 0, 0, 0, 0, 0, 60])
    expect(grid.totalMinutes).toBe(90)
    expect(Object.keys(grid.rows[0]?.cells ?? {})).toEqual([MON, SUN])
  })

  it('holds for any mix of entries: Σ cells = row, Σ rows = week = Σ days, each entry in exactly one cell', () => {
    // A fixed pseudo-random generator, so the mix is the same on every run.
    let seed = 20261116
    const next = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return Math.floor(seed / 65_536) % limit
    }
    const linked = { state: 'linked', visibility: 'visible', id: 'd1', label: 'Brera', href: '/crm/deals/d1' } as const
    const ons: EntryOn[] = [
      projectOn('p1', 'Alpenstrom'),
      projectOn('p2', 'Operai'),
      projectOn('p3', null, 'hidden'),
      projectOn('p4', null, 'unavailable'),
      dealOn('d1', 'Brera'),
      dealOn('d2', null, 'hidden'),
      meetingOn('m1', 'Retrospective', linked),
      meetingOn('m2', 'Planning'),
      otherWorkOn('Training', 'c1'),
      otherWorkOn('Administration', 'c2', true),
    ]
    const days = tableGridDays()
    const entries = Array.from({ length: 300 }, () =>
      entry(days[next(7)]!, (next(48) + 1) * 30, ons[next(ons.length)]!),
    )
    const grid = tableGrid(entries, DAYS)

    const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
    expect(grid.totalMinutes).toBe(sum(entries.map((e) => e.minutes)))
    expect(sum(grid.rows.map((row) => row.minutes))).toBe(grid.totalMinutes)
    expect(sum(grid.dayMinutes)).toBe(grid.totalMinutes)
    for (const row of grid.rows) {
      const cells = Object.values(row.cells)
      expect(sum(cells.map((cell) => cell.minutes)), row.key).toBe(row.minutes)
      for (const cell of cells) expect(sum(cell.entries.map((e) => e.minutes)), row.key).toBe(cell.minutes)
    }
    // Each day's total is the sum of that day's cells over every row.
    grid.days.forEach((day, index) => {
      expect(sum(grid.rows.map((row) => row.cells[day]?.minutes ?? 0)), day).toBe(grid.dayMinutes[index])
    })
    // Each entry is in exactly one cell, on its own day.
    const placed = grid.rows.flatMap((row) =>
      Object.entries(row.cells).flatMap(([day, cell]) => cell.entries.map((e) => [e.id, day] as const)),
    )
    expect(placed).toHaveLength(entries.length)
    expect(new Set(placed.map(([id]) => id)).size).toBe(entries.length)
    for (const [id, day] of placed) expect(entries.find((e) => e.id === id)?.day).toBe(day)
    expect(grid.rows.length).toBeGreaterThan(5)
    expect(new Set(entries.map((e) => e.day)).size).toBe(7)
  })
})

/** The seven days of the week under test, written out so the test does not use the code it checks. */
const tableGridDays = () => [MON, TUE, WED, THU, '2026-11-20', '2026-11-21', SUN]

describe('tableGrid: a row whose name cannot be read, and a retired category (AC-5.23, AC-5.24, D12)', () => {
  it('names a project, a deal and a meeting as the server did, and a category by its name, and keeps what they are', () => {
    const grid = tableGrid(
      [
        entry(MON, 30, projectOn('p1', 'Alpenstrom')),
        entry(MON, 30, dealOn('d1', 'Brera')),
        entry(MON, 30, meetingOn('m1', 'Retrospective')),
        entry(MON, 30, otherWorkOn('Training', 'c1')),
      ],
      DAYS,
    )
    expect(grid.rows.map((row) => [row.kind, row.name, row.visibility, row.retired])).toEqual([
      ['project', 'Alpenstrom', 'visible', false],
      ['deal', 'Brera', 'visible', false],
      ['meeting', 'Retrospective', 'visible', false],
      ['none', 'Training', 'visible', false],
    ])
  })

  it('has no name for an entry whose project, deal or meeting is hidden, and says it is hidden (AC-5.23)', () => {
    const grid = tableGrid(
      [
        entry(MON, 30, projectOn('p1', null, 'hidden')),
        entry(MON, 30, dealOn('d1', null, 'hidden')),
        entry(MON, 30, meetingOn('m1', null, { state: 'none' }, 'hidden')),
      ],
      DAYS,
    )
    expect(grid.rows.map((row) => [row.key, row.name, row.visibility, row.preset])).toEqual([
      ['project:p1', null, 'hidden', null],
      ['deal:d1', null, 'hidden', null],
      ['meeting:m1', null, 'hidden', null],
    ])
  })

  it('has no name for one whose owner did not answer, and for a visible one that arrived without a label', () => {
    const noLabel = { ...projectOn('p2', 'x'), label: null }
    const grid = tableGrid([entry(MON, 30, projectOn('p1', null, 'unavailable')), entry(MON, 30, noLabel)], DAYS)
    expect(grid.rows.map((row) => [row.key, row.name, row.visibility, row.preset])).toEqual([
      ['project:p1', null, 'unavailable', null],
      ['project:p2', null, 'unavailable', null],
    ])
  })

  it('never carries the label of a record the server said is hidden, even when it (wrongly) sent one', () => {
    const wrong = { ...projectOn('p1', 'Classified project', 'hidden'), label: 'Classified project' }
    const grid = tableGrid([entry(MON, 30, wrong)], DAYS)
    expect(grid.rows[0]?.name).toBeNull()
    expect(JSON.stringify(grid.rows[0]?.preset)).not.toContain('Classified')
  })

  it('gives each row that has a name what Add hours sets: its project, deal, meeting or category (AC-5.12, AC-5.18)', () => {
    const grid = tableGrid(
      [
        entry(MON, 30, projectOn('p1', 'Alpenstrom')),
        entry(MON, 30, dealOn('d1', 'Brera')),
        entry(MON, 30, meetingOn('m1', 'Retrospective')),
        entry(MON, 30, otherWorkOn('Training', 'c1')),
      ],
      DAYS,
    )
    expect(grid.rows.map((row) => row.preset)).toEqual([
      { kind: 'project', project: { id: 'p1', name: 'Alpenstrom', companyName: null } },
      { kind: 'deal', deal: { id: 'd1', title: 'Brera', companyName: null } },
      { kind: 'meeting', meeting: { id: 'm1', title: 'Retrospective', startsAt: null } },
      { kind: 'none', categoryId: 'c1' },
    ])
  })

  it('offers no recording on a retired category, and still names it and keeps its hours (AC-5.24)', () => {
    const grid = tableGrid(
      [entry(TUE, 90, otherWorkOn('Old training', 'c-old', true)), entry(TUE, 30, otherWorkOn('Training', 'c1'))],
      DAYS,
    )
    const old = grid.rows.find((row) => row.key === 'category:c-old')
    expect(old).toMatchObject({ name: 'Old training', visibility: 'visible', retired: true, preset: null, minutes: 90 })
    expect(old?.cells[TUE]?.minutes).toBe(90)
    const live = grid.rows.find((row) => row.key === 'category:c1')
    expect(live).toMatchObject({ retired: false, preset: { kind: 'none', categoryId: 'c1' } })
    expect(grid.totalMinutes).toBe(120)
  })

  it('says a category is retired when any of its entries says so', () => {
    const grid = tableGrid(
      [entry(MON, 30, otherWorkOn('Training', 'c1', false)), entry(TUE, 30, otherWorkOn('Training', 'c1', true))],
      DAYS,
    )
    expect(grid.rows).toHaveLength(1)
    expect(grid.rows[0]).toMatchObject({ retired: true, preset: null })
  })

  it('keeps the name a row has when its owner answered on one page of the read and not on the other', () => {
    const grid = tableGrid(
      [entry(MON, 30, projectOn('p1', null, 'unavailable')), entry(TUE, 30, projectOn('p1', 'Alpenstrom'))],
      DAYS,
    )
    expect(grid.rows).toHaveLength(1)
    expect(grid.rows[0]).toMatchObject({ name: 'Alpenstrom', visibility: 'visible', minutes: 60 })
    expect(grid.rows[0]?.preset).toMatchObject({ kind: 'project' })
  })

  it("hides the name when any of the row's entries says it is hidden: the more careful answer wins", () => {
    const grid = tableGrid(
      [entry(MON, 30, projectOn('p1', 'Alpenstrom')), entry(TUE, 30, projectOn('p1', null, 'hidden'))],
      DAYS,
    )
    expect(grid.rows).toHaveLength(1)
    expect(grid.rows[0]).toMatchObject({ name: null, visibility: 'hidden', preset: null })
  })
})

describe('tableGrid: an entry with no id, and an entry outside the week', () => {
  it("puts an own entry with no target id on the kind's one unknown row, with no name and no Add hours", () => {
    const noId = (on: EntryOn): EntryOn => (on.type === 'none' ? on : { ...on, id: null })
    const grid = tableGrid(
      [
        entry(MON, 30, noId(projectOn('p1', 'Alpenstrom'))),
        entry(TUE, 60, noId(projectOn('p2', 'Operai'))),
        entry(WED, 30, noId(dealOn('d1', 'Brera'))),
        entry(WED, 30, noId(meetingOn('m1', 'Retrospective'))),
        entry(WED, 30, projectOn('p3', 'Real')),
      ],
      DAYS,
    )
    expect(grid.rows.map((row) => [row.key, row.name, row.preset, row.minutes])).toEqual([
      ['project:p3', 'Real', { kind: 'project', project: { id: 'p3', name: 'Real', companyName: null } }, 30],
      ['project:unknown', null, null, 90],
      ['deal:unknown', null, null, 30],
      ['meeting:unknown', null, null, 30],
    ])
    expect(grid.rows[1]?.visibility).not.toBe('visible')
    expect(grid.totalMinutes).toBe(180)
  })

  it('throws for an entry before the week or after it: the read asked for the week, anything else is a server bug', () => {
    const inWeek = entry(MON, 30, projectOn('p1', 'A'))
    expect(() => tableGrid([inWeek, entry('2026-11-15', 30, projectOn('p1', 'A'))], DAYS)).toThrow(RangeError)
    expect(() => tableGrid([inWeek, entry('2026-11-23', 30, projectOn('p1', 'A'))], DAYS)).toThrow(RangeError)
    expect(() => tableGrid([entry('2026-11-1', 30, projectOn('p1', 'A'))], DAYS)).toThrow(RangeError)
    expect(() => tableGrid([entry('', 30, projectOn('p1', 'A'))], DAYS)).toThrow(RangeError)
  })

  it('does not put the note of the offending entry in the error', () => {
    const offender = entry('2026-12-24', 30, projectOn('p1', 'A'), { note: 'private words' })
    expect(() => tableGrid([offender], DAYS)).toThrow(/2026-12-24/)
    expect(() => tableGrid([offender], DAYS)).not.toThrow(/private words/)
  })

  it("refuses days that are not a period's: none, or not in ascending order, are a caller bug and never a grid", () => {
    expect(() => tableGrid([], [])).toThrow(TypeError)
    expect(() => tableGrid([], [...DAYS].reverse())).toThrow(TypeError)
    expect(() => tableGrid([], [MON, MON, TUE])).toThrow(TypeError)
  })
})

describe('tableGrid folds over the days it is given, not over a week it assumes (decision 8)', () => {
  // Ten consecutive days from Monday 16 November: a span of a period that is not seven days long.
  const SPAN = Array.from({ length: 10 }, (_, index) => `2026-11-${String(16 + index).padStart(2, '0')}`)

  it('has one column for each day it is given, the totals following them', () => {
    const grid = tableGrid([entry(SPAN[0]!, 30, projectOn('p1', 'A')), entry(SPAN[9]!, 90, projectOn('p1', 'A'))], SPAN)
    expect(grid.days).toEqual(SPAN)
    expect(grid.dayMinutes).toHaveLength(10)
    expect(grid.dayMinutes[0]).toBe(30)
    expect(grid.dayMinutes[9]).toBe(90)
    expect(grid.totalMinutes).toBe(120)
    expect(Object.keys(grid.rows[0]!.cells)).toEqual([SPAN[0], SPAN[9]])
  })

  it('throws for an entry on a day it was not given: the days decide what is outside, not a week', () => {
    const tuesdayAfter = '2026-11-24' // in the ten days, outside the week of Monday 16 November
    expect(() => tableGrid([entry(tuesdayAfter, 30, projectOn('p1', 'A'))], DAYS)).toThrow(RangeError)
    expect(() => tableGrid([entry(tuesdayAfter, 30, projectOn('p1', 'A'))], SPAN)).not.toThrow()
    expect(() => tableGrid([entry('2026-11-26', 30, projectOn('p1', 'A'))], SPAN)).toThrow(RangeError)
  })
})
