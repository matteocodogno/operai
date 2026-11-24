/**
 * @vitest-environment jsdom
 *
 * EntriesTable — the flat, read-only table of Everyone's hours (specs/20261112-time-tracking T29; AC-1.6, AC-4.3,
 * AC-4.7, AC-4.8, AC-4.9, AC-4.10, AC-2.6, AC-3.8; design S4 "Entries card"). Columns Day, Person, On,
 * Details and Time, in the server's order and never re-sorted, with the words for a name the viewer may not
 * read or that did not come, and nothing to write with: no Edit, no Delete, no row action of any kind. The last
 * block is the "From meeting" mark of an automatic entry (specs/20261112-meeting-hours T10, T16; AC-2.3 as changed, D-P5, D67; design
 * S2): shown exactly while the entry is recorded on a meeting, by the same predicate as the List's rows (`showsFromMeetingMark`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { strings } from '../strings'
import type { TimeEntryView } from '../lib/hoursApi.types'
import {
  dealOn,
  meetingOn,
  otherWorkOn,
  projectOn,
  seenByOthers,
  timeEntryView,
  withIds,
} from '../test-support/fakeApi'
import {
  ADA_DEAL,
  ADA_PROJECT,
  GONE_MEETING,
  GRACE_HIDDEN,
  UNKNOWN,
  UNKNOWN_TRAINING,
} from '../test-support/fixtures/everyone'
import EntriesTable from './EntriesTable'

afterEach(() => cleanup())

const e = strings.everyone.entries
const n = strings.names

const ALL = [ADA_PROJECT, GRACE_HIDDEN, GONE_MEETING, UNKNOWN_TRAINING, ADA_DEAL]

const renderTable = (entries: readonly TimeEntryView[] = ALL) => render(<EntriesTable entries={entries} />)

const table = () => screen.getByRole('table', { name: e.caption })
const bodyRows = () => within(table()).getAllByRole('row').slice(1)
/** The cells of body row `index` by column name. */
const cells = (index: number) => {
  const [day, person, on, details, time] = Array.from(bodyRows()[index]!.querySelectorAll('td'))
  return { day: day!, person: person!, on: on!, details: details!, time: time! }
}
/** The lines of a cell as text: spaces collapsed, the middle dot between pieces written with its spaces. */
const lines = (cell: HTMLElement) =>
  Array.from(cell.querySelectorAll('p')).map((line) =>
    line.textContent
      ?.replace(/\s*·\s*/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim(),
  )

describe('the table', () => {
  it('is named by its caption and has the columns Day, Person, On, Details and Time', () => {
    renderTable()
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Day', 'Person', 'On', 'Details', 'Time'])
  })

  it('lists the entries in the order given, one row each: the server’s order, never re-sorted', () => {
    renderTable()
    expect(bodyRows()).toHaveLength(5)
    expect(cells(0).person.textContent).toBe('Ada Lovelace')
    expect(cells(1).person.textContent).toBe('Grace Hopper')
    expect(cells(4).person.textContent).toBe('Ada Lovelace')
    expect(bodyRows().map((row) => cells(bodyRows().indexOf(row)).day.textContent)).toEqual([
      '12.11.2026',
      '12.11.2026',
      '10.11.2026',
      '10.11.2026',
      '09.11.2026',
    ])
  })

  it('an order the days do not follow stays as given (a client sort would change it)', () => {
    renderTable([ADA_DEAL, ADA_PROJECT])
    expect(cells(0).day.textContent).toBe('09.11.2026')
    expect(cells(1).day.textContent).toBe('12.11.2026')
  })

  it('has no write control: no Edit, no Delete, no button of any kind (AC-1.6)', () => {
    renderTable()
    expect(within(table()).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByText(strings.entries.edit)).toBeNull()
    expect(within(table()).queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('draws no row-level heading: it is a table of entries, not a list by day', () => {
    renderTable()
    expect(screen.queryAllByRole('heading')).toHaveLength(0)
  })
})

describe('ids (D44): the table reads none', () => {
  it('the entries are what hours-api answers a holder about other people: no id for a record they cannot read', () => {
    expect(GRACE_HIDDEN.on).toMatchObject({ visibility: 'hidden', id: null })
    expect(GRACE_HIDDEN.activity).toMatchObject({ visibility: 'hidden', id: null })
    expect(ADA_DEAL.on).toMatchObject({ visibility: 'unavailable', id: null })
    expect(ADA_DEAL.activity).toMatchObject({ visibility: 'unavailable', id: null })
    // A record the holder can read keeps its id.
    expect(ADA_PROJECT.on).toMatchObject({ id: 'p1' })
    expect(ADA_PROJECT.activity).toMatchObject({ id: 'a1' })
  })

  it('draws the same table whether or not the ids were withheld: no cell, link or label depends on one', () => {
    const withheld = renderTable(ALL)
    const html = withheld.container.innerHTML
    withheld.unmount()
    const carried = renderTable(ALL.map(withIds))
    expect(carried.container.innerHTML).toBe(html)
    // ...and the rows really are the ones with something withheld, so the comparison is about them.
    expect(html).toContain(n.hidden)
  })
})

describe('Day, Person and Time', () => {
  it('writes the day with the library’s date format', () => {
    renderTable([ADA_PROJECT])
    expect(cells(0).day.textContent).toBe('12.11.2026')
  })

  it('names the person as the page does: the resolved name, "Unknown user", "(deactivated)" (AC-4.8)', () => {
    renderTable([
      ADA_PROJECT,
      GONE_MEETING,
      UNKNOWN_TRAINING,
      timeEntryView({ id: 'e-renamed', person: { id: 'u-ada', name: 'Ada King', status: 'active' } }),
    ])
    expect(bodyRows().map((_row, index) => cells(index).person.textContent)).toEqual([
      'Ada Lovelace',
      'Unknown user (deactivated)',
      'Unknown user',
      'Ada King',
    ])
  })

  it('shows no id: not the person’s, not the entry’s', () => {
    renderTable()
    const text = table().textContent ?? ''
    for (const id of [UNKNOWN.id, 'u-ada', 'u-grace', 'u-gone', 'e-ada-alpha', 'p-secret', 'a-secret', 'd2']) {
      expect(text).not.toContain(id)
    }
  })

  it('writes the time as hours and minutes, with the spoken form for assistive technology (AC-4.9)', () => {
    renderTable([GONE_MEETING, ADA_PROJECT])
    expect(within(cells(0).time).getByText('2 h 30')).not.toBeNull()
    expect(within(cells(0).time).getByText('2 hours, 30 minutes')).not.toBeNull()
    expect(within(cells(1).time).getByText('4 h')).not.toBeNull()
  })

  it('has its Time column right-aligned as a number (the library’s numeric column)', () => {
    renderTable([ADA_PROJECT])
    expect(cells(0).time.className).toContain('is-numeric')
    expect(bodyRows()[0]!.querySelectorAll('td.is-numeric')).toHaveLength(1)
  })
})

describe('On: the name, the kind and what the hours count for (AC-2.6, AC-4.10, AC-4.7)', () => {
  it('a project the viewer can read: its name as a link, then "Project · Development"', () => {
    renderTable([ADA_PROJECT])
    const link = within(cells(0).on).getByRole('link', { name: 'Project Alpha' })
    expect(link.getAttribute('href')).toBe('/projects/p1')
    expect(lines(cells(0).on)).toEqual(['Project Alpha', 'Project · Development'])
  })

  it('a project the viewer may not read: "Not visible to you" in words, no link, the kind still said', () => {
    renderTable([GRACE_HIDDEN])
    expect(within(cells(0).on).queryByRole('link')).toBeNull()
    expect(lines(cells(0).on)).toEqual([n.hidden, 'Project · Development'])
    expect(n.hidden).toBe('Not visible to you')
  })

  it('a name whose owner did not answer: "Name unavailable", no link', () => {
    renderTable([ADA_DEAL])
    expect(within(cells(0).on).queryByRole('link')).toBeNull()
    expect(lines(cells(0).on)).toEqual([n.unavailable, 'Deal · Legacy demo (retired)'])
  })

  it('a visible name that arrived without a label is "Name unavailable", never an id', () => {
    renderTable([timeEntryView({ on: { ...projectOn('p-x', 'x'), label: null } })])
    expect(lines(cells(0).on)[0]).toBe(n.unavailable)
    expect(cells(0).on.textContent).not.toContain('p-x')
  })

  it('never makes a link of a path that leaves the suite', () => {
    renderTable([timeEntryView({ on: { ...projectOn('p1', 'Alpha'), href: 'https://elsewhere.example/x' } })])
    expect(within(cells(0).on).queryByRole('link')).toBeNull()
    expect(lines(cells(0).on)[0]).toBe('Alpha')
  })

  it('other work has no name: the kind and the category, as typed (AC-3.8)', () => {
    renderTable([UNKNOWN_TRAINING])
    expect(lines(cells(0).on)).toEqual(['Other work · Formazione'])
  })

  it('a retired category and a retired work type say so (AC-3.4)', () => {
    renderTable([
      timeEntryView({ on: otherWorkOn('Seminars', 'tc-seminars', true) }),
      timeEntryView({ workType: { id: 'wt-x', name: 'Legacy support', retired: true } }),
    ])
    expect(lines(cells(0).on)).toEqual(['Other work · Seminars (retired)'])
    expect(lines(cells(1).on)[1]).toBe('Project · Legacy support (retired)')
  })

  it('a project with no work type is just the kind', () => {
    renderTable([timeEntryView({ workType: null })])
    expect(lines(cells(0).on)).toEqual(['Project Alpha', 'Project'])
  })

  it('a meeting linked to a deal the viewer can read: its title, the kind, then "Counts for deal …"', () => {
    renderTable([GONE_MEETING])
    expect(lines(cells(0).on)).toEqual(['Kick-off call', 'Meeting', 'Counts for deal Acme renewal'])
  })

  it.each([
    ['hidden', { state: 'linked', visibility: 'hidden' } as const, n.countsForHiddenDeal],
    ['unavailable', { state: 'linked', visibility: 'unavailable' } as const, n.countsForUnavailableDeal],
    ['unknown', { state: 'unknown' } as const, n.countsForUnknownDeal],
  ])('a meeting whose deal is %s: the design’s words, never the deal or its id', (_name, deal, words) => {
    renderTable([timeEntryView({ on: meetingOn('m9', 'Weekly', deal) })])
    expect(lines(cells(0).on)).toEqual(['Weekly', 'Meeting', words])
  })

  it('a meeting linked to no deal says nothing about one', () => {
    renderTable([timeEntryView({ on: meetingOn('m9', 'Weekly') })])
    expect(lines(cells(0).on)).toEqual(['Weekly', 'Meeting'])
  })
})

describe('Details: the activity and the note', () => {
  it('shows "Activity: <subject>" and the full note, line breaks kept', () => {
    renderTable([ADA_PROJECT, timeEntryView({ note: 'Line one\nline two' })])
    expect(lines(cells(0).details)).toEqual(['Activity: Write the offer'])
    const note = within(cells(1).details).getByText(/Line one/)
    expect(note.textContent).toBe('Line one\nline two')
    expect(note.className).toContain('whitespace-pre-wrap')
  })

  it('an activity the viewer may not read, or whose name did not come, is said in words, never a subject', () => {
    renderTable([GRACE_HIDDEN, ADA_DEAL])
    expect(lines(cells(0).details)).toEqual([n.activityHidden, 'Line one line two'])
    expect(lines(cells(1).details)).toEqual([n.activityUnavailable])
    expect(cells(0).details.textContent).not.toContain('a-secret')
  })

  it('an entry on no activity and with no note has an empty cell', () => {
    renderTable([timeEntryView({ activity: null, note: null })])
    expect(cells(0).details.textContent).toBe('')
  })

  it('a note long enough to need it breaks inside the cell rather than widening the table', () => {
    renderTable([timeEntryView({ note: 'x'.repeat(1000) })])
    expect(within(cells(0).details).getByText('x'.repeat(1000)).className).toContain('wrap-anywhere')
  })
})

describe('the "From meeting" mark of an automatic entry (specs/20261112-meeting-hours AC-2.3, D-P5; design S2)', () => {
  const MARK = 'From meeting'

  /** An entry Operai recorded for Ada on a meeting, as a holder sees it. */
  const automatic = (overrides: Parameters<typeof timeEntryView>[0] = {}) =>
    timeEntryView({ id: 'e-auto', origin: 'meeting', on: meetingOn('m1', 'Weekly sync'), ...overrides })

  /** The same entry typed by hand: what the cell drew before the mark existed. */
  const handMade = (overrides: Parameters<typeof timeEntryView>[0] = {}) =>
    timeEntryView({ id: 'e-hand', on: meetingOn('m1', 'Weekly sync'), ...overrides })

  const before = (first: Node, second: Node) =>
    Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('marks the On cell of an entry whose origin is meeting, before the name: "[From meeting] Weekly sync"', () => {
    renderTable([automatic()])
    const on = cells(0).on
    const mark = within(on).getByText(MARK)
    expect(before(mark, within(on).getByText('Weekly sync'))).toBe(true)
  })

  it('keeps the badge outside every <p> of the cell: the lines it holds are the lines it held without the mark', () => {
    renderTable([automatic()])
    const on = cells(0).on
    expect(within(on).getByText(MARK).closest('p')).toBeNull()
    expect(lines(on)).toEqual(['Weekly sync', 'Meeting'])
    cleanup()

    renderTable([handMade()])
    expect(lines(cells(0).on)).toEqual(['Weekly sync', 'Meeting'])
  })

  it('keeps the lines of a meeting linked to a deal as they were: the mark adds none', () => {
    const deal = {
      state: 'linked',
      visibility: 'visible',
      id: 'd1',
      label: 'Acme renewal',
      href: '/crm/deals/d1',
    } as const
    renderTable([automatic({ on: meetingOn('m1', 'Kick-off call', deal) })])
    expect(lines(cells(0).on)).toEqual(['Kick-off call', 'Meeting', 'Counts for deal Acme renewal'])
  })

  it('stays on an entry the person moved to ANOTHER meeting: it is on a meeting, and the mark says where it came from, not where it is', () => {
    renderTable([automatic({ on: meetingOn('m2', 'Retro') })])
    const on = cells(0).on
    expect(before(within(on).getByText(MARK), within(on).getByText('Retro'))).toBe(true)
    expect(lines(on)).toEqual(['Retro', 'Meeting'])
  })

  it('is gone from an entry the person moved to a project, a deal or other work: a holder no longer learns from it that the person attended a meeting (AC-2.3, D67)', () => {
    const ids = ['to-project', 'to-deal', 'to-other']
    renderTable([
      automatic({ id: ids[0]!, on: projectOn('p1', 'Project Alpha') }),
      automatic({ id: ids[1]!, on: dealOn('d1', 'Brera') }),
      automatic({ id: ids[2]!, on: otherWorkOn('Training', 'c-training') }),
    ])
    ids.forEach((id, index) => {
      expect(cells(index).on.textContent, `row ${index}`).not.toContain(MARK)
      expect(screen.queryByTestId(`hours-entry-${id}-from-meeting`)).toBeNull()
    })
    expect(lines(cells(0).on)).toEqual(['Project Alpha', 'Project'])
    expect(lines(cells(1).on)).toEqual(['Brera', 'Deal'])
    expect(lines(cells(2).on)).toEqual(['Other work · Training'])
  })

  it('draws a moved entry exactly as the same entry typed by hand: no badge and no wrapper around the name line', () => {
    for (const on of [projectOn('p1', 'Project Alpha'), dealOn('d1', 'Brera'), otherWorkOn('Training', 'c-training')]) {
      renderTable([automatic({ on })])
      const html = cells(0).on.innerHTML
      cleanup()
      renderTable([handMade({ on })])
      expect(cells(0).on.innerHTML).toBe(html)
      cleanup()
    }
  })

  it('comes back when the entry is recorded on a meeting again: the same entry, moved off and back, changes only the mark', () => {
    const { rerender } = renderTable([automatic({ on: meetingOn('m1', 'Weekly sync') })])
    expect(cells(0).on.textContent).toContain(MARK)

    rerender(<EntriesTable entries={[automatic({ on: projectOn('p1', 'Project Alpha') })]} />)
    expect(cells(0).on.textContent).not.toContain(MARK)

    rerender(<EntriesTable entries={[automatic({ on: meetingOn('m1', 'Weekly sync') })]} />)
    const on = cells(0).on
    expect(before(within(on).getByText(MARK), within(on).getByText('Weekly sync'))).toBe(true)
    expect(lines(on)).toEqual(['Weekly sync', 'Meeting'])
  })

  it('says "[From meeting] Not visible to you" for a meeting the viewer cannot read — a deleted one reads as hidden: it is still on a meeting — and never its title', () => {
    const hidden = { ...meetingOn('m1', null, { state: 'none' }, 'hidden'), label: 'Secret board meeting' }
    renderTable([seenByOthers(automatic({ on: hidden }))])
    const on = cells(0).on
    expect(before(within(on).getByText(MARK), within(on).getByText(n.hidden))).toBe(true)
    expect(on.textContent).not.toContain('Secret board meeting')
    expect(lines(on)).toEqual([n.hidden, 'Meeting'])
  })

  it('is in the On column only: no other cell, no new column, and the same five headers', () => {
    renderTable([automatic({ note: 'Prepared the agenda' })])
    const { day, person, details, time } = cells(0)
    for (const cell of [day, person, details, time]) expect(cell.textContent).not.toContain(MARK)
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Day', 'Person', 'On', 'Details', 'Time'])
  })

  it.each([
    ['person', 'person' as const],
    ['no origin (an hours-api that does not send it)', undefined],
  ])('draws no mark, and the cell it always drew, when the origin is %s', (_label, origin) => {
    renderTable([handMade(origin ? { origin } : {})])
    const on = cells(0).on
    expect(on.textContent).not.toContain(MARK)
    // the cell is the column of lines it was: the name line is its first child, with no wrapper around it
    expect(on.firstElementChild?.firstElementChild?.tagName).toBe('P')
    expect(lines(on)).toEqual(['Weekly sync', 'Meeting'])
  })

  it('draws the same cell for person and for no origin', () => {
    renderTable([handMade({ origin: 'person' })])
    const html = cells(0).on.innerHTML
    cleanup()
    renderTable([handMade()])
    expect(cells(0).on.innerHTML).toBe(html)
  })

  it('marks one row of the table and not its neighbour', () => {
    renderTable([automatic({ id: 'auto' }), handMade()])
    expect(cells(0).on.textContent).toContain(MARK)
    expect(cells(1).on.textContent).not.toContain(MARK)
  })

  it('stays read-only with an automatic entry in it: no Edit, no Delete, no button (AC-1.6)', () => {
    renderTable([automatic()])
    expect(within(table()).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByText(strings.entries.edit)).toBeNull()
  })
})
