/**
 * @vitest-environment jsdom
 *
 * TotalsCard — the Totals card of My hours (specs/029-time-tracking T24; AC-4.5, AC-4.9, AC-3.8, AC-4.10;
 * design S1 "Totals"). Presentational: the page hands it the state of the totals read. It shows the
 * server's total and groups, in the server's order and re-sorted by nothing, with each merged row once and
 * the design's words, months through `formatMonth` and durations through `formatDuration` `short`.
 */
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDuration, formatMonth } from '@operai/ui'
import { strings } from '../strings'
import type { TotalsAnswer, TotalsGroup } from '../lib/hoursApi.types'
import { totalsAnswer } from '../test-support/fakeApi'
import { PERSON_TOTALS } from '../test-support/fixtures/everyone'
import { CATEGORY_TOTALS, DEAL_TOTALS, MONTH_TOTALS, PROJECT_TOTALS } from '../test-support/fixtures/myHours'
import TotalsCard from './TotalsCard'
import type { TotalsCardHandle, TotalsCardProps } from './TotalsCard'
import { EVERYONE_GROUP_CHOICES } from './TotalsCardRows'
import type { GroupChoice } from './TotalsCardRows'

afterEach(() => cleanup())

const t = strings.totals

const loaded = (answer: TotalsAnswer): TotalsCardProps['view'] => ({ status: 'loaded', answer })

const renderCard = (props: Partial<TotalsCardProps> & Pick<TotalsCardProps, 'view'>) => {
  const onGroupByChange = vi.fn()
  const onRetry = vi.fn()
  const groupBy: GroupChoice = props.groupBy ?? 'project'
  render(<TotalsCard groupBy={groupBy} onGroupByChange={onGroupByChange} onRetry={onRetry} {...props} />)
  return { onGroupByChange, onRetry }
}

/** Each body row of the totals table as [name, time]. */
const tableRows = (caption: string) => {
  const table = screen.getByRole('table', { name: caption })
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent))
}

describe('the total and the groups (AC-4.5, AC-4.9)', () => {
  it('shows the total as the server states it, as hours and minutes', () => {
    renderCard({ view: loaded(PROJECT_TOTALS) })
    const total = screen.getByTestId('hours-totals-total')
    expect(within(total).getByText(t.total)).not.toBeNull()
    expect(within(total).getByText('137 h')).not.toBeNull()
  })

  it('is a card whose heading is Totals, at the card level (h3)', () => {
    renderCard({ view: loaded(PROJECT_TOTALS) })
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(t.title)
  })

  it('lists the groups in the server’s order, never re-sorted: Beta (more minutes) before Alpha', () => {
    renderCard({ view: loaded(PROJECT_TOTALS) })
    const names = tableRows(t.caption.project).map(([name]) => name)
    expect(names.slice(0, 2)).toEqual(['Project Beta', 'Project Alpha'])
  })

  it('writes each time through formatDuration short: 50 h, 40 h, 12 h, 2 h 30, 32 h 30', () => {
    renderCard({ view: loaded(PROJECT_TOTALS) })
    expect(tableRows(t.caption.project).map(([, time]) => time)).toEqual(['50 h', '40 h', '12 h', '2 h 30', '32 h 30'])
  })

  it('names the table by its grouping and its columns Project and Time', () => {
    renderCard({ view: loaded(PROJECT_TOTALS) })
    const table = screen.getByRole('table', { name: t.caption.project })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([t.groupBy.project, t.columnTime])
  })

  it('shows the hidden, unavailable and none groups as ONE row each, in the design’s words (AC-4.10, AC-4.7)', () => {
    renderCard({ view: loaded(PROJECT_TOTALS) })
    expect(tableRows(t.caption.project).map(([name]) => name)).toEqual([
      'Project Beta',
      'Project Alpha',
      t.rows.project.hidden,
      t.rows.project.unavailable,
      t.rows.project.none,
    ])
    expect(t.rows.project.hidden).toBe('Projects not visible to you')
    expect(t.rows.project.unavailable).toBe('Projects whose name is unavailable')
    expect(t.rows.project.none).toBe('Not on a project')
  })

  it('by deal: the same merged rows in deal words, plus the meetings whose deal is unknown right now', () => {
    renderCard({ view: loaded(DEAL_TOTALS), groupBy: 'deal' })
    expect(tableRows(t.caption.deal)).toEqual([
      ['Acme renewal', '80 h'],
      ['Globex pilot', '1 h 30'],
      ['Deals not visible to you', '2 h'],
      ['Deals whose name is unavailable', '30 min'],
      ['Meetings whose deal is unknown right now', '2 h 30'],
      ['Not on a deal', '10 h'],
    ])
  })

  it('by category: a retired category is marked, names are shown exactly as typed, none says what it is', () => {
    renderCard({ view: loaded(CATEGORY_TOTALS), groupBy: 'category' })
    expect(tableRows(t.caption.category)).toEqual([
      ['Formazione', '10 h'],
      ['Seminars (retired)', '3 h'],
      ['On a project, deal or meeting', '124 h'],
    ])
  })

  it('by month: the key is written by formatMonth, newest first as sent, and a month with no entries is absent', () => {
    renderCard({ view: loaded(MONTH_TOTALS), groupBy: 'month' })
    expect(tableRows(t.caption.month)).toEqual([
      [formatMonth('2026-11'), '60 h'],
      [formatMonth('2026-09'), '77 h'],
    ])
    expect(formatMonth('2026-11')).toBe('November 2026')
  })

  it('by person (Everyone’s hours): names in the server’s order, "Unknown user" and "(deactivated)" in words, no merged row', () => {
    renderCard({ view: loaded(PERSON_TOTALS), groupBy: 'person' })
    expect(tableRows(t.caption.person)).toEqual([
      ['Ada Lovelace', '12 h'],
      ['Grace Hopper', '10 h 30'],
      ['Unknown user (deactivated)', '4 h'],
      ['Unknown user', '1 h'],
    ])
    const table = screen.getByRole('table', { name: t.caption.person })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([t.groupBy.person, t.columnTime])
    expect(t.caption.person).toBe('Hours by person')
  })

  it('a month key it cannot read is shown as it is, not a crash', () => {
    renderCard({
      view: loaded(totalsAnswer([{ kind: 'keyed', key: '2026-1x', label: null, minutes: 60 }])),
      groupBy: 'month',
    })
    expect(tableRows(t.caption.month)).toEqual([['2026-1x', '1 h']])
  })

  it('a named group whose name did not come is "Name unavailable", never an id', () => {
    renderCard({
      view: loaded(totalsAnswer([{ kind: 'keyed', key: 'p-secret-id', label: null, minutes: 60 }])),
    })
    const [[name]] = tableRows(t.caption.project)
    expect(name).toBe(t.nameUnavailable)
    expect(screen.queryByText(/p-secret-id/)).toBeNull()
  })

  it('a group kind this build has no words for still shows its hours, as "Other hours" (a server one step ahead)', () => {
    const future = { kind: 'brand-new', minutes: 90 } as unknown as TotalsGroup
    renderCard({ view: loaded(totalsAnswer([future])) })
    expect(tableRows(t.caption.project)).toEqual([[t.rows.other, '1 h 30']])
  })
})

describe('Group by (design S1: Project, Deal, Category, Month)', () => {
  it('offers exactly Project, Deal, Category and Month, and shows the current one', () => {
    renderCard({ view: loaded(PROJECT_TOTALS), groupBy: 'category' })
    const select = screen.getByRole('combobox', { name: t.groupBy.label })
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Project', 'Deal', 'Category', 'Month'])
    expect((select as HTMLSelectElement).value).toBe('category')
  })

  it('Everyone’s hours offers Person first, then the four: the card is told which groupings to offer', () => {
    renderCard({ view: loaded(PERSON_TOTALS), groupBy: 'person', choices: EVERYONE_GROUP_CHOICES })
    const select = screen.getByRole('combobox', { name: t.groupBy.label })
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Person', 'Project', 'Deal', 'Category', 'Month'])
    expect((select as HTMLSelectElement).value).toBe('person')
  })

  it('reports the choice', async () => {
    const { onGroupByChange } = renderCard({ view: loaded(PROJECT_TOTALS) })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: t.groupBy.label }), 'month')
    expect(onGroupByChange).toHaveBeenCalledWith('month')
  })

  it('stays in the card while the totals load or fail, so a keyboard user keeps their place', () => {
    renderCard({ view: { status: 'loading' } })
    expect(screen.getByRole('combobox', { name: t.groupBy.label })).not.toBeNull()
    cleanup()
    renderCard({ view: { status: 'error', message: 'x' } })
    expect(screen.getByRole('combobox', { name: t.groupBy.label })).not.toBeNull()
  })
})

describe('states', () => {
  it('nothing matched: "0 min" and "Nothing to total.", no table', () => {
    renderCard({ view: loaded(totalsAnswer([])) })
    expect(within(screen.getByTestId('hours-totals-total')).getByText('0 min')).not.toBeNull()
    expect(screen.getByText(t.empty)).not.toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('loading: skeleton rows (hidden from assistive technology), a polite "Loading totals…", no figure, no table', () => {
    renderCard({ view: { status: 'loading' } })
    expect(screen.getByTestId('hours-totals-skeleton').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText(t.loading).getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByTestId('hours-totals-total')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('a failed read: a warning with Retry inside the card, and never "0 min" or an empty table', async () => {
    const { onRetry } = renderCard({ view: { status: 'error', message: 'Try again in a moment.' } })
    const card = screen.getByTestId('hours-totals')
    const alert = within(card).getByRole('alert')
    expect(alert.textContent).toContain(t.error.title)
    expect(alert.textContent).toContain('Try again in a moment.')
    await userEvent.click(within(alert).getByRole('button', { name: strings.common.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('0 min')).toBeNull()
    expect(screen.queryByText(t.empty)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('a Custom range that cannot be sent says why nothing is shown, and shows no figure', () => {
    renderCard({ view: { status: 'invalid' } })
    expect(screen.getByText(t.invalidPeriod)).not.toBeNull()
    expect(screen.queryByTestId('hours-totals-total')).toBeNull()
    expect(screen.queryByText('0 min')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('announcements (design § Accessibility: "<total> in total", focus never moves)', () => {
  const announcement = () => document.querySelector('[data-testid="hours-totals-live"]')!

  it('reads the total politely, in the spoken form, once the totals arrive', () => {
    renderCard({ view: loaded(PROJECT_TOTALS) })
    expect(announcement().getAttribute('aria-live')).toBe('polite')
    expect(announcement().textContent).toBe(t.announce(formatDuration(137 * 3_600_000, { style: 'spoken' })))
    expect(announcement().textContent).toContain('137 hours')
  })

  it('reads "No entries match" when there is nothing to total', () => {
    renderCard({ view: loaded(totalsAnswer([])) })
    expect(announcement().textContent).toBe(t.announceEmpty)
  })

  it('says nothing for a failure (the alert says it) and "Loading totals…" while loading', () => {
    renderCard({ view: { status: 'loading' } })
    expect(announcement().textContent).toBe(t.loading)
    cleanup()
    renderCard({ view: { status: 'error', message: 'x' } })
    expect(announcement().textContent).toBe('')
  })
})

describe('focus (design S1 "Deal filter unavailable": after a good retry focus moves to the Totals heading)', () => {
  it('moves focus to its heading when the page asks, and the heading is not a tab stop', () => {
    const ref = createRef<TotalsCardHandle>()
    renderCard({ view: loaded(PROJECT_TOTALS), ref })
    const heading = screen.getByRole('heading', { level: 3, name: t.title })
    expect(document.activeElement).toBe(document.body)

    act(() => ref.current!.focusHeading())

    expect(document.activeElement).toBe(heading)
    expect(heading.getAttribute('tabindex')).toBe('-1')
  })

  it('never moves focus by itself: not on mount, not when the totals arrive', () => {
    renderCard({ view: { status: 'loading' } })
    expect(document.activeElement).toBe(document.body)
    cleanup()
    renderCard({ view: loaded(PROJECT_TOTALS) })
    expect(document.activeElement).toBe(document.body)
  })
})
