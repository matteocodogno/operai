/**
 * @vitest-environment jsdom
 *
 * EntryRow — the "From meeting" mark of an automatic entry (specs/20261112-meeting-hours T10, T16; AC-2.3 as changed, AC-3.6
 * (display), AC-4.1, AC-4.3; design S1). One row draws both the List's entry and the entry of a table cell's dialog, so what is
 * shown here is shown in both views. The mark follows where the entry is recorded NOW (`showsFromMeetingMark`, D67, A47): an
 * entry Operai recorded from a meeting keeps it while it is on a meeting — its own, another one, or one the viewer can no
 * longer see — and loses it, with no wrapper left behind, when the person moves it to a project, a deal or other work. A
 * hand-made entry (or one from an hours-api that does not send `origin`) draws exactly the row it always did.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { MeetingProject, TimeEntryView } from '../lib/hoursApi.types'
import { strings } from '../strings'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import EntryRow from './EntryRow'

afterEach(() => cleanup())

const MARK = 'From meeting'

const SYNC = meetingOn('m1', 'Weekly sync')

/** The entry as Operai recorded it for a meeting: `origin: meeting`, an hour on the meeting's day. */
const automatic = (overrides: Partial<TimeEntryView> = {}) =>
  timeEntryView({ id: 'a1', minutes: 60, origin: 'meeting', on: SYNC, ...overrides })

const renderRow = (entry: TimeEntryView, handlers = true) =>
  render(<EntryRow entry={entry} {...(handlers ? { onEdit: vi.fn(), onDelete: vi.fn() } : {})} />)

const row = (id = 'a1') => screen.getByTestId(`hours-entry-${id}`)
const markIn = (id = 'a1') => within(row(id)).queryByText(MARK)

/** True when `first` comes before `second` in the document. */
const before = (first: Node, second: Node) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('an automatic entry carries the mark (AC-2.3)', () => {
  it('says "From meeting" on the row of an entry whose origin is meeting', () => {
    renderRow(automatic())
    expect(markIn()).not.toBeNull()
  })

  it('puts the mark right after the kind badge and before the name: "[Meeting] [From meeting] Weekly sync"', () => {
    renderRow(automatic())
    const kind = within(row()).getByText('Meeting')
    const mark = within(row()).getByText(MARK)
    const name = within(row()).getByText('Weekly sync')

    expect(before(kind, mark)).toBe(true)
    expect(before(mark, name)).toBe(true)
  })

  it('draws the mark as plain text: not a control, no tab stop added, nothing that would rename it for a screen reader', () => {
    const tabStops = (container: HTMLElement) =>
      container.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])').length
    renderRow(timeEntryView({ id: 'a1', minutes: 60, on: SYNC }))
    const handMade = tabStops(row())
    cleanup()

    renderRow(automatic({ on: SYNC }))
    expect(tabStops(row())).toBe(handMade)
    const mark = within(row()).getByText(MARK)
    expect(mark.closest('button, a, [role]')).toBeNull()
    expect(mark.closest('[aria-label], [title]')).toBeNull()
  })

  it('keeps the name of Edit and Delete as it is: the mark is not part of them', () => {
    renderRow(automatic())
    expect(within(row()).getByRole('button', { name: 'Edit 1 h on Weekly sync, 12.11.2026' })).not.toBeNull()
    expect(within(row()).getByRole('button', { name: 'Delete 1 h on Weekly sync, 12.11.2026' })).not.toBeNull()
  })

  it('draws the mark on a row that has no Edit and no Delete handlers too', () => {
    renderRow(automatic(), false)
    expect(markIn()).not.toBeNull()
  })
})

describe('the mark follows where the entry is recorded now, not where it came from (AC-2.3, D67, A47)', () => {
  it('stays on an entry the person moved to ANOTHER meeting: "[Meeting] [From meeting] Retro"', () => {
    renderRow(automatic({ on: meetingOn('m2', 'Retro') }))
    const kind = within(row()).getByText('Meeting')
    const mark = within(row()).getByText(MARK)
    const name = within(row()).getByText('Retro')
    expect(before(kind, mark)).toBe(true)
    expect(before(mark, name)).toBe(true)
  })

  it('is gone from an entry moved to a project: "[Project] Project Alpha", the kind badge alone and no wrapper', () => {
    renderRow(automatic({ on: projectOn('p1', 'Project Alpha') }))
    expect(markIn()).toBeNull()
    expect(screen.queryByTestId('hours-entry-a1-from-meeting')).toBeNull()
    const kind = within(row()).getByText('Project').parentElement!
    const name = within(row()).getByText('Project Alpha')
    // the kind badge and the name are neighbours in the first line, exactly as on a hand-made row: no cluster around it
    expect(kind.nextElementSibling).toBe(name)
    expect(kind.parentElement).toBe(name.parentElement)
  })

  it('is gone from an entry moved to a deal: "[Deal] Brera"', () => {
    renderRow(automatic({ on: dealOn('d1', 'Brera') }))
    expect(markIn()).toBeNull()
    const kind = within(row()).getByText('Deal').parentElement!
    expect(kind.nextElementSibling).toBe(within(row()).getByText('Brera'))
  })

  it('is gone from an entry moved to other work, which has no name: "[Other work]" alone, the category on the meta line', () => {
    renderRow(automatic({ on: otherWorkOn('Training', 'c-training') }))
    expect(markIn()).toBeNull()
    const kind = within(row()).getByText('Other work').parentElement!
    // the first line holds the kind badge and nothing else: no cluster wrapper, no mark, no name
    expect(kind.parentElement!.children).toHaveLength(1)
    expect(within(row()).getByText('Training')).not.toBeNull()
  })

  it('draws a moved entry exactly as the same entry typed by hand: the same markup, mark apart', () => {
    for (const on of [projectOn('p1', 'Project Alpha'), dealOn('d1', 'Brera'), otherWorkOn('Training', 'c-training')]) {
      const moved = renderRow(automatic({ on }))
      const html = moved.container.innerHTML
      moved.unmount()
      const handMade = renderRow(timeEntryView({ id: 'a1', minutes: 60, on }))
      expect(handMade.container.innerHTML).toBe(html)
      handMade.unmount()
    }
  })

  it('comes back when the entry is recorded on a meeting again: the same entry, moved off and back, changes only the mark', () => {
    const { rerender } = renderRow(automatic({ on: SYNC }))
    expect(markIn()).not.toBeNull()

    rerender(
      <EntryRow entry={automatic({ on: projectOn('p1', 'Project Alpha') })} onEdit={vi.fn()} onDelete={vi.fn()} />,
    )
    expect(markIn()).toBeNull()
    const moved = within(row()).getByText('Project').parentElement!
    expect(moved.nextElementSibling).toBe(within(row()).getByText('Project Alpha'))

    rerender(<EntryRow entry={automatic({ on: SYNC })} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(markIn()).not.toBeNull()
    const kind = within(row()).getByText('Meeting')
    expect(before(kind, within(row()).getByText(MARK))).toBe(true)
    expect(before(within(row()).getByText(MARK), within(row()).getByText('Weekly sync'))).toBe(true)
  })

  it('stays on an entry the person edited and left on its meeting: the view is the same, the row is the same', () => {
    // hours-api answers `origin: meeting` after a PATCH (AC-2.3, AC-2.7): a changed note and minutes change nothing about the mark.
    renderRow(automatic({ minutes: 150, note: 'Prepared the agenda' }))
    expect(markIn()).not.toBeNull()
    expect(within(row()).getByText('Prepared the agenda')).not.toBeNull()
  })
})

describe('a meeting the viewer cannot read (AC-3.6 display, AC-4.1)', () => {
  it('reads "[Meeting] [From meeting] Not visible to you": the placeholder, no link, and the mark stays', () => {
    renderRow(automatic({ on: meetingOn('m1', null, { state: 'none' }, 'hidden') }))
    const kind = within(row()).getByText('Meeting')
    const mark = within(row()).getByText(MARK)
    const name = within(row()).getByText('Not visible to you')

    expect(before(kind, mark)).toBe(true)
    expect(before(mark, name)).toBe(true)
    expect(within(row()).queryByRole('link')).toBeNull()
  })

  it('shows no title of the meeting whatever the server sent with a hidden one, and no id', () => {
    const hidden = { ...meetingOn('m1', null, { state: 'none' }, 'hidden'), label: 'Secret board meeting' }
    renderRow(automatic({ on: hidden }))
    expect(row().textContent).not.toContain('Secret board meeting')
    expect(row().textContent).not.toContain('m1')
  })

  it('reads "[Meeting] [From meeting] Name unavailable" when Meetings did not answer: the mark does not need Meetings (AC-4.2)', () => {
    renderRow(automatic({ on: meetingOn('m1', null, { state: 'none' }, 'unavailable') }))
    expect(markIn()).not.toBeNull()
    expect(within(row()).getByText('Name unavailable')).not.toBeNull()
  })
})

describe('an entry that is not automatic draws the row it always drew', () => {
  const NAME = 'Weekly sync'

  it.each([
    ['person', 'person' as const],
    ['one with no origin (an hours-api that does not send it)', undefined],
  ])('has no mark when its origin is %s', (_label, origin) => {
    renderRow(timeEntryView({ id: 'h1', minutes: 60, on: SYNC, ...(origin ? { origin } : {}) }))
    expect(within(row('h1')).queryByText(MARK)).toBeNull()
    expect(row('h1').textContent).not.toMatch(/from meeting/i)
    expect(screen.queryByTestId('hours-entry-h1-from-meeting')).toBeNull()
  })

  it.each([
    ['person', 'person' as const],
    ['no origin', undefined],
  ])(
    'keeps the kind badge and the name as neighbours when the origin is %s: nothing wraps the badge',
    (_label, origin) => {
      renderRow(timeEntryView({ id: 'h1', minutes: 60, on: SYNC, ...(origin ? { origin } : {}) }))
      const kindBadge = within(row('h1')).getByText('Meeting').parentElement!
      expect(kindBadge.nextElementSibling).toBe(within(row('h1')).getByText(NAME))
      // ...and both are children of the row's first line, as before
      expect(kindBadge.parentElement).toBe(within(row('h1')).getByText(NAME).parentElement)
    },
  )

  it('draws exactly the same row for person and for no origin', () => {
    const person = renderRow(timeEntryView({ id: 'h1', minutes: 60, on: SYNC, origin: 'person' }))
    const html = person.container.innerHTML
    person.unmount()
    const missing = renderRow(timeEntryView({ id: 'h1', minutes: 60, on: SYNC }))
    expect(missing.container.innerHTML).toBe(html)
  })

  it('marks one row of a day and not its neighbour: the mark is per entry', () => {
    render(
      <>
        <EntryRow entry={automatic({ id: 'auto' })} />
        <EntryRow entry={timeEntryView({ id: 'hand', minutes: 60, on: SYNC })} />
      </>,
    )
    expect(markIn('auto')).not.toBeNull()
    expect(markIn('hand')).toBeNull()
  })
})

describe('the project a meeting counts for (specs/20261112-project-hours AC-4.4, AC-4.7; design S4 "The screen line")', () => {
  const n = strings.names
  const forProject = (project: MeetingProject | undefined) =>
    timeEntryView({
      id: 'k1',
      minutes: 60,
      on: project === undefined ? meetingOn('m1', 'Kick-off call') : { ...meetingOn('m1', 'Kick-off call'), project },
    })
  const countsLines = (id = 'k1') => within(row(id)).queryAllByText(/^(Counts for|The deal or project)/)

  it('names a project the viewer can read, as plain text under the name: "Counts for project Project Alpha"', () => {
    renderRow(
      forProject({ state: 'linked', visibility: 'visible', id: 'p1', label: 'Project Alpha', href: '/projects/p1' }),
    )
    const line = within(row('k1')).getByText('Counts for project Project Alpha')
    expect(before(within(row('k1')).getByText('Kick-off call'), line)).toBe(true)
    expect(line.closest('a')).toBeNull()
    expect(within(row('k1')).queryByRole('link', { name: /Project Alpha/ })).toBeNull()
    expect(countsLines()).toHaveLength(1)
  })

  it.each([
    ['hidden', { state: 'linked', visibility: 'hidden' } as const, n.countsForHiddenProject],
    ['unavailable', { state: 'linked', visibility: 'unavailable' } as const, n.countsForUnavailableProject],
  ])('says "%s" in the design’s words, never the project or its id', (_name, project, words) => {
    const leaked = { ...project, id: 'p-secret', label: 'Leaked project' } as unknown as MeetingProject
    renderRow(forProject(leaked))
    expect(within(row('k1')).getByText(words)).not.toBeNull()
    expect(row('k1').textContent).not.toContain('Leaked project')
    expect(row('k1').textContent).not.toContain('p-secret')
    expect(countsLines()).toHaveLength(1)
  })

  it('says the one "deal or project … unknown right now" line when both are unknown, once', () => {
    renderRow(
      timeEntryView({
        id: 'k1',
        minutes: 60,
        on: { ...meetingOn('m1', 'Kick-off call', { state: 'unknown' }), project: { state: 'unknown' } },
      }),
    )
    expect(within(row('k1')).getAllByText(n.countsForUnknownDeal)).toHaveLength(1)
    expect(countsLines()).toHaveLength(1)
  })

  it.each([
    ['linked to no project', { state: 'none' } as const],
    ['from an hours-api that sends no `project`', undefined],
  ])('says nothing about a project for a meeting %s', (_name, project) => {
    renderRow(forProject(project))
    expect(countsLines()).toHaveLength(0)
    expect(row('k1').textContent).not.toContain('Counts for')
  })

  it('says nothing for the project entry itself: its name is the row’s own', () => {
    renderRow(timeEntryView({ id: 'k1', minutes: 60, on: projectOn('p1', 'Project Alpha') }))
    expect(countsLines()).toHaveLength(0)
  })

  it('draws no deal line for a meeting that counts for a project (a meeting has one host)', () => {
    renderRow(forProject({ state: 'linked', visibility: 'hidden' }))
    expect(within(row('k1')).queryByText(/Counts for deal|a deal/)).toBeNull()
  })
})
