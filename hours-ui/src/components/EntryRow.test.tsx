/**
 * @vitest-environment jsdom
 *
 * EntryRow — the "From meeting" mark of an automatic entry (specs/20261112-meeting-hours T10; AC-2.3, AC-3.6 (display),
 * AC-4.1, AC-4.3; design S1). One row draws both the List's entry and the entry of a table cell's dialog, so what is shown
 * here is shown in both views. The mark follows `origin` and nothing else: an entry the person changed, moved to another
 * kind of work or whose meeting is no longer visible keeps it, and a hand-made entry (or one from an hours-api that does not
 * send `origin`) draws exactly the row it always did.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TimeEntryView } from '../lib/hoursApi.types'
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
    renderRow(timeEntryView({ id: 'a1', minutes: 60, on: projectOn('p1', 'Alpenstrom') }))
    const handMade = tabStops(row())
    cleanup()

    renderRow(automatic({ on: projectOn('p1', 'Alpenstrom') }))
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

describe('the mark follows origin, not what the entry is on now (AC-2.3, D57)', () => {
  it('stays on an entry the person moved to a project: "[Project] [From meeting] Project Alpha"', () => {
    renderRow(automatic({ on: projectOn('p1', 'Project Alpha') }))
    const kind = within(row()).getByText('Project')
    const mark = within(row()).getByText(MARK)
    const name = within(row()).getByText('Project Alpha')
    expect(before(kind, mark)).toBe(true)
    expect(before(mark, name)).toBe(true)
  })

  it('stays on an entry moved to a deal', () => {
    renderRow(automatic({ on: dealOn('d1', 'Brera') }))
    expect(markIn()).not.toBeNull()
    expect(within(row()).getByText('Deal')).not.toBeNull()
  })

  it('stays on an entry moved to other work, which has no name: "[Other work] [From meeting]", the category on the meta line', () => {
    renderRow(automatic({ on: otherWorkOn('Training', 'c-training') }))
    expect(markIn()).not.toBeNull()
    expect(before(within(row()).getByText('Other work'), within(row()).getByText(MARK))).toBe(true)
    // the category is still the second line
    expect(within(row()).getByText('Training')).not.toBeNull()
  })

  it('stays on an entry the person edited: the view is the same, the row is the same', () => {
    // hours-api answers `origin: meeting` after a PATCH (AC-2.3): a changed note and minutes change nothing about the mark.
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
