/**
 * @vitest-environment jsdom
 *
 * EntryDayList — the entries of My hours, one section per day (specs/029-time-tracking T25; AC-4.1, AC-2.6,
 * AC-2.9, AC-4.7, AC-4.9, AC-4.10; design S1 "Entries", "Names the viewer cannot read"). Presentational: it
 * is handed the entries in the server's order and the day totals the server stated, and it computes nothing —
 * a day whose total has not arrived has no figure, never a sum of the rows on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strings } from '../strings'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import { ALPHA, DEAL_ENTRY, HIDDEN_PROJECT, KICKOFF, TRAINING } from '../test-support/fixtures/entries'
import EntryDayList from './EntryDayList'
import type { EntryDayListProps } from './EntryDayList'

afterEach(() => cleanup())

const n = strings.names
const e = strings.entries

const TOTALS = new Map([
  ['2026-11-12', 510],
  ['2026-11-10', 330],
])

const renderList = (props: Partial<EntryDayListProps> & Pick<EntryDayListProps, 'entries'>) =>
  render(<EntryDayList dayTotals={TOTALS} {...props} />)

const day = (key: string) => screen.getByTestId(`hours-day-${key}`)
const row = (id: string) => screen.getByTestId(`hours-entry-${id}`)

describe('one section per day (AC-4.1)', () => {
  it('has a heading per day in formatDateLong, in the order the entries came, entries of a day together', () => {
    renderList({ entries: [ALPHA, HIDDEN_PROJECT, KICKOFF, TRAINING, DEAL_ENTRY] })

    const headings = screen.getAllByRole('heading', { level: 4 })
    expect(headings.map((heading) => heading.textContent)).toEqual(['12 November 2026', '10 November 2026'])
    expect(within(day('2026-11-12')).getAllByRole('listitem')).toHaveLength(3)
    expect(within(day('2026-11-10')).getAllByRole('listitem')).toHaveLength(2)
  })

  it('each day is a region named by its heading, and its list is named "Entries on <date>"', () => {
    renderList({ entries: [ALPHA, TRAINING] })
    expect(screen.getByRole('region', { name: '12 November 2026' })).toBe(day('2026-11-12'))
    expect(within(day('2026-11-12')).getByRole('list', { name: e.dayList('12 November 2026') })).not.toBeNull()
  })

  it('shows the day total the server stated, as hours and minutes with a spoken form (AC-4.9)', () => {
    renderList({ entries: [ALPHA] })
    const total = screen.getByTestId('hours-day-total-2026-11-12')
    expect(within(total).getByText(e.dayTotal)).not.toBeNull()
    expect(within(total).getByText('8 h 30')).not.toBeNull()
    expect(within(total).getByText('8 hours, 30 minutes')).not.toBeNull()
  })

  it('a day whose total has not arrived shows no figure at all — not "0", not a sum of its rows', () => {
    // The two rows of the 12th add up to 6 h on screen: that sum must not be offered as the day's total.
    renderList({ entries: [ALPHA, HIDDEN_PROJECT, TRAINING], dayTotals: new Map([['2026-11-10', 330]]) })
    expect(screen.queryByTestId('hours-day-total-2026-11-12')).toBeNull()
    expect(within(day('2026-11-12')).queryByText(e.dayTotal)).toBeNull()
    expect(within(day('2026-11-12')).queryByText('6 h')).toBeNull()
    expect(within(day('2026-11-12')).queryByText('0 min')).toBeNull()
    expect(screen.getByTestId('hours-day-total-2026-11-10')).not.toBeNull()
  })

  it('no day totals yet (loading or failed) shows no day figure at all', () => {
    renderList({ entries: [ALPHA, TRAINING], dayTotals: null })
    expect(screen.queryByText(e.dayTotal)).toBeNull()
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(2)
  })

  it('the total is the server’s even when it is not the sum of the rows shown (the rest is on the next page)', () => {
    // Two of the day's three entries are here (6 h); the server says 8 h 30.
    renderList({ entries: [ALPHA, HIDDEN_PROJECT] })
    expect(within(screen.getByTestId('hours-day-total-2026-11-12')).getByText('8 h 30')).not.toBeNull()
  })

  it('marks no day as incomplete, however long, and carries no reminder (D23)', () => {
    const { container } = renderList({
      entries: [ALPHA],
      dayTotals: new Map([['2026-11-12', 1440]]),
    })
    expect(within(day('2026-11-12')).getByText('24 h')).not.toBeNull()
    expect(container.textContent).not.toMatch(/incomplete|missing|reminder|remind|short of/i)
    expect(container.querySelector('[role="alert"], [role="status"]')).toBeNull()
  })
})

describe('a row (AC-4.9, AC-2.6, AC-2.9)', () => {
  it('shows the type badge, the name as a link to the API’s path, and the duration as hours and minutes', () => {
    renderList({ entries: [ALPHA] })
    const alpha = row('e-alpha')
    expect(within(alpha).getByText(e.type.project)).not.toBeNull()
    const link = within(alpha).getByRole('link', { name: 'Project Alpha' })
    expect(link.getAttribute('href')).toBe('/projects/p1')
    expect(within(alpha).getByText('4 h')).not.toBeNull()
    expect(within(alpha).getByText('4 hours')).not.toBeNull()
  })

  it('writes 30 and 150 minutes as "30 min" and "2 h 30"', () => {
    renderList({
      entries: [timeEntryView({ id: 'a', minutes: 30 }), timeEntryView({ id: 'b', minutes: 150 })],
      dayTotals: null,
    })
    expect(within(row('a')).getByText('30 min')).not.toBeNull()
    expect(within(row('b')).getByText('2 h 30')).not.toBeNull()
  })

  it('names a deal and a meeting the same way, each with its own badge', () => {
    renderList({ entries: [DEAL_ENTRY, KICKOFF] })
    expect(within(row('e-deal')).getByText(e.type.deal)).not.toBeNull()
    expect(within(row('e-deal')).getByRole('link', { name: 'Globex pilot' }).getAttribute('href')).toBe('/crm/deals/d2')
    expect(within(row('e-kickoff')).getByText(e.type.meeting)).not.toBeNull()
    expect(within(row('e-kickoff')).getByRole('link', { name: 'Kick-off call' }).getAttribute('href')).toBe(
      '/my-meetings/m/m1',
    )
  })

  it('shows the work type, "Activity: <subject>" and the note', () => {
    renderList({ entries: [{ ...ALPHA, note: 'Pair-reviewed with Grace' }] })
    const alpha = row('e-alpha')
    expect(within(alpha).getByText('Development')).not.toBeNull()
    expect(within(alpha).getByText('Activity: Write the offer')).not.toBeNull()
    expect(within(alpha).getByText('Pair-reviewed with Grace')).not.toBeNull()
  })

  it('an activity that was deleted (activity: null) leaves no activity line, and the entry stays (AC-2.9)', () => {
    renderList({ entries: [{ ...ALPHA, activity: null }] })
    expect(within(row('e-alpha')).queryByText(/^Activity/)).toBeNull()
    expect(within(row('e-alpha')).getByText('Project Alpha')).not.toBeNull()
  })

  it('a meeting shows the deal its hours count for (AC-2.6); a meeting linked to no deal shows no such line', () => {
    renderList({
      entries: [KICKOFF, timeEntryView({ id: 'e-solo', on: meetingOn('m2', 'Retro', { state: 'none' }) })],
      dayTotals: null,
    })
    expect(within(row('e-kickoff')).getByText('Counts for deal Acme renewal')).not.toBeNull()
    expect(within(row('e-kickoff')).getByText('Walked through the scope')).not.toBeNull()
    expect(within(row('e-solo')).queryByText(/Counts for/)).toBeNull()
  })

  it('other work has the badge and its category as the details line, and no name', () => {
    renderList({ entries: [TRAINING] })
    const training = row('e-training')
    expect(within(training).getByText(e.type.none)).not.toBeNull()
    expect(within(training).getByText('Formazione')).not.toBeNull()
    expect(within(training).queryByRole('link')).toBeNull()
  })

  it('a retired work type or category keeps its name and says it is retired (AC-3.4)', () => {
    renderList({
      entries: [DEAL_ENTRY, timeEntryView({ id: 'e-old', on: otherWorkOn('Seminars', 'tc-seminars', true) })],
      dayTotals: null,
    })
    expect(within(row('e-deal')).getByText(e.retired('Legacy demo'))).not.toBeNull()
    expect(within(row('e-old')).getByText(e.retired('Seminars'))).not.toBeNull()
  })

  it('shows a multi-line note as written, as text (never as markup)', () => {
    renderList({ entries: [{ ...ALPHA, note: 'Line one\n<b>not bold</b>' }] })
    const note = within(row('e-alpha')).getByText(/Line one/)
    expect(note.textContent).toBe('Line one\n<b>not bold</b>')
    expect(note.querySelector('b')).toBeNull()
  })
})

describe('names the viewer cannot read (AC-4.10, AC-4.7)', () => {
  it('a hidden project is "Not visible to you", plain text with no link, and keeps its badge', () => {
    renderList({ entries: [HIDDEN_PROJECT] })
    const hidden = row('e-hidden')
    expect(within(hidden).getByText(e.type.project)).not.toBeNull()
    expect(within(hidden).getByText(n.hidden)).not.toBeNull()
    expect(within(hidden).queryByRole('link')).toBeNull()
    expect(within(hidden).getByText(n.activityHidden)).not.toBeNull()
  })

  it('shows neither a name nor an id of what is withheld, even when the server sent them', () => {
    const leaked: TimeEntryView = {
      ...HIDDEN_PROJECT,
      on: {
        ...projectOn('p-secret-id', 'Secret project', 'hidden'),
        label: 'Secret project',
        href: '/projects/p-secret-id',
      },
      activity: { id: 'a-secret-id', subject: 'Secret subject', visibility: 'hidden' },
    }
    const { container } = renderList({ entries: [leaked] })
    expect(container.textContent).not.toContain('Secret project')
    expect(container.textContent).not.toContain('Secret subject')
    expect(container.innerHTML).not.toContain('p-secret-id')
    expect(container.innerHTML).not.toContain('a-secret-id')
  })

  it('an unavailable name is "Name unavailable", not a link', () => {
    renderList({ entries: [timeEntryView({ id: 'e-u', on: dealOn('d9', 'x', 'unavailable') })], dayTotals: null })
    expect(within(row('e-u')).getByText(n.unavailable)).not.toBeNull()
    expect(within(row('e-u')).queryByRole('link')).toBeNull()
  })

  it('an activity whose subject did not come is "Activity: name unavailable"', () => {
    renderList({
      entries: [{ ...ALPHA, activity: { id: 'a1', subject: null, visibility: 'unavailable' } }],
      dayTotals: null,
    })
    expect(within(row('e-alpha')).getByText(n.activityUnavailable)).not.toBeNull()
  })

  it('the three states of the deal a meeting counts for use the design’s words, never a name', () => {
    const meeting = (id: string, deal: Parameters<typeof meetingOn>[2]) =>
      timeEntryView({ id, on: meetingOn(`m-${id}`, 'Sync', deal) })
    renderList({
      entries: [
        meeting('h', { state: 'linked', visibility: 'hidden' }),
        meeting('u', { state: 'linked', visibility: 'unavailable' }),
        meeting('k', { state: 'unknown' }),
      ],
      dayTotals: null,
    })
    expect(within(row('h')).getByText(n.countsForHiddenDeal)).not.toBeNull()
    expect(within(row('u')).getByText(n.countsForUnavailableDeal)).not.toBeNull()
    expect(within(row('k')).getByText(n.countsForUnknownDeal)).not.toBeNull()
  })

  it('a link that is not a suite path is shown as plain text', () => {
    renderList({
      entries: [
        timeEntryView({ id: 'e-bad', on: { ...projectOn('p1', 'Project Alpha'), href: 'javascript:alert(1)' } }),
      ],
      dayTotals: null,
    })
    expect(within(row('e-bad')).queryByRole('link')).toBeNull()
    expect(within(row('e-bad')).getByText('Project Alpha')).not.toBeNull()
  })
})

describe('Edit and Delete (AC-1.5; the dialogs are T27 and T28)', () => {
  it('offers neither until the page gives a handler: no control that does nothing', () => {
    renderList({ entries: [ALPHA] })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('calls the handlers with the entry, and names it in each label so the buttons of a day can be told apart', async () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    renderList({ entries: [ALPHA, HIDDEN_PROJECT], onEdit, onDelete })

    const edit = within(row('e-alpha')).getByRole('button', { name: 'Edit 4 h on Project Alpha, 12.11.2026' })
    const del = within(row('e-alpha')).getByRole('button', { name: 'Delete 4 h on Project Alpha, 12.11.2026' })
    await userEvent.click(edit)
    await userEvent.click(del)

    expect(onEdit).toHaveBeenCalledExactlyOnceWith(ALPHA)
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(ALPHA)
  })

  it('names an entry whose target is not visible by the kind of record, not by a name or an id', () => {
    renderList({ entries: [HIDDEN_PROJECT], onEdit: vi.fn(), onDelete: vi.fn() })
    expect(
      within(row('e-hidden')).getByRole('button', { name: 'Edit 2 h on a project not visible to you, 12.11.2026' }),
    ).not.toBeNull()
    expect(
      within(row('e-hidden')).getByRole('button', { name: 'Delete 2 h on a project not visible to you, 12.11.2026' }),
    ).not.toBeNull()
  })

  it('names other work by its category', () => {
    renderList({ entries: [TRAINING], onEdit: vi.fn(), onDelete: vi.fn() })
    expect(
      within(row('e-training')).getByRole('button', { name: 'Edit 4 h on other work (Formazione), 10.11.2026' }),
    ).not.toBeNull()
  })

  it('the Edit button shows "Edit"; Delete is icon-only, so it has no visible text', () => {
    renderList({ entries: [ALPHA], onEdit: vi.fn(), onDelete: vi.fn() })
    const [edit, del] = within(row('e-alpha')).getAllByRole('button')
    expect(edit!.textContent).toBe(e.edit)
    expect(del!.textContent).toBe('')
    expect(del!.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})
