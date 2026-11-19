/**
 * @vitest-environment jsdom
 *
 * The table view under `<html lang="it">`, a week and a month (specs/20261116-record-hours-in-place T9, T22; AC-4.6): the heading, the days, the
 * navigator, the names of the cell buttons and every state come from the Italian catalog and none of the English one,
 * a weekday and a date are written in Italian, and a name an administrator typed ("Formazione") is shown verbatim.
 * Completeness of the catalog is checked once for the whole app (strings.test.ts); this proves the view reads it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test sets `<html lang>` and
 * imports the view afresh.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { EntryOn } from '../lib/hoursApi.types'
import { daysOf, holding } from '../lib/tablePeriod'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

const MONDAY = '2026-11-16'
const TODAY = '2026-11-19'

/** The view, its strings and a week of entries, all imported after the language is set. */
const setup = async (lang: 'it' | 'en') => {
  document.documentElement.setAttribute('lang', lang)
  const { default: TableView } = await import('./TableView')
  const { strings } = await import('../strings')
  const { tableGrid } = await import('../lib/tableGrid')
  const { dealOn, otherWorkOn, projectOn, timeEntryView } = await import('../test-support/fakeApi')
  const entry = (id: string, day: string, minutes: number, on: EntryOn) => timeEntryView({ id, day, minutes, on })
  const entries = [
    entry('a', '2026-11-16', 240, projectOn('p1', 'Alpenstrom')),
    entry('b', '2026-11-18', 60, projectOn('p2', 'Operai')),
    entry('c', '2026-11-18', 90, projectOn('p2', 'Operai')),
    entry('d', '2026-11-17', 60, dealOn('d1', 'Brera')),
    entry('e', '2026-11-19', 120, otherWorkOn('Formazione', 'c-training')),
    entry('f', '2026-11-17', 120, projectOn('p3', 'Segreto', 'hidden')),
  ]
  const grid = tableGrid(entries, daysOf(holding('week', MONDAY)))
  const monthGrid = tableGrid(entries, daysOf(holding('month', MONDAY)))
  const draw = (props: Record<string, unknown> = {}) =>
    render(
      <TableView
        period={{ kind: 'week', monday: MONDAY }}
        today={TODAY}
        filtered={false}
        state={{ status: 'loaded', grid }}
        onPeriodChange={vi.fn()}
        onKindChange={vi.fn()}
        onRetry={vi.fn()}
        onClearFilters={vi.fn()}
        onOpenCell={vi.fn()}
        {...props}
      />,
    )
  /** The same entries in the month that holds them, November 2026. */
  const drawMonth = (props: Record<string, unknown> = {}) =>
    draw({ period: { kind: 'month', month: '2026-11' }, state: { status: 'loaded', grid: monthGrid }, ...props })
  return { strings, draw, drawMonth, tableGrid }
}

describe('Italian', () => {
  it('words the heading, the navigator and the table in Italian, with the week as two dates and an en dash', async () => {
    const { draw } = await setup('it')
    draw()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Settimana 16.11.2026 – 22.11.2026')
    const navigator = screen.getByRole('group', { name: 'Scegli una settimana' })
    expect(within(navigator).getByRole('button', { name: 'Settimana precedente' })).not.toBeNull()
    expect(within(navigator).getByRole('button', { name: 'Questa settimana' })).not.toBeNull()
    expect(within(navigator).getByRole('button', { name: 'Settimana successiva' })).not.toBeNull()
    expect(
      screen.getByRole('table', {
        name: 'Ore per progetto, opportunità, riunione e altro lavoro, 16.11.2026 – 22.11.2026',
      }),
    ).not.toBeNull()
  })

  it('has Monday to Sunday as Lun to Dom, marks today "Oggi", and calls the last column and the last row "Totale"', async () => {
    const { draw } = await setup('it')
    draw()
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader')
    expect(headers.slice(1, 8).map((header) => header.textContent?.slice(0, 3))).toEqual([
      'Lun',
      'Mar',
      'Mer',
      'Gio',
      'Ven',
      'Sab',
      'Dom',
    ])
    expect(headers[4]?.textContent).toContain('Oggi')
    expect(headers[8]?.textContent).toBe('Totale')
    expect(within(screen.getByTestId('hours-table-row-total')).getByRole('rowheader').textContent).toBe('Totale')
  })

  it('names the cell buttons with the Italian weekday and date, and the entries in the singular and the plural', async () => {
    const { draw } = await setup('it')
    draw()
    expect(
      screen.getByRole('button', { name: '2 h 30 su Operai, mercoledì 18 novembre 2026, 2 registrazioni' }),
    ).not.toBeNull()
    expect(
      screen.getByRole('button', { name: '4 h su Alpenstrom, lunedì 16 novembre 2026, 1 registrazione' }),
    ).not.toBeNull()
    expect(
      screen.getByRole('button', {
        name: '2 h su altro lavoro (Formazione), giovedì 19 novembre 2026, 1 registrazione',
      }),
    ).not.toBeNull()
  })

  it('has a button only for a cell that holds hours: an empty cell offers no "Registra ore" and no name of any kind (AC-5.32)', async () => {
    const { draw } = await setup('it')
    draw()
    expect(screen.queryAllByRole('button', { name: /^Registra ore/ })).toHaveLength(0)
    // five cells hold hours in this week, and nothing else in the table is a button
    expect(within(screen.getByRole('table')).getAllByRole('button')).toHaveLength(5)
  })

  it('shows a category as its administrator typed it, the kinds and the hidden name in Italian, and no English', async () => {
    const { draw } = await setup('it')
    const { container } = draw()
    const training = within(screen.getByTestId('hours-table-row-category:c-training')).getByRole('rowheader')
    expect(within(training).getByText('Altro lavoro')).not.toBeNull()
    expect(within(training).getByText('Formazione')).not.toBeNull()
    const hidden = within(screen.getByTestId('hours-table-row-project:p3')).getByRole('rowheader')
    expect(within(hidden).getByText('Progetto')).not.toBeNull()
    expect(within(hidden).getByText('Non visibile a te')).not.toBeNull()
    expect(container.textContent).not.toMatch(/\b(Week|Total|Project|Deal|Mon|Tue|Today|Not visible)\b/)
    expect(container.textContent).not.toContain('Segreto')
  })

  it('announces the week and its total in Italian, and says so in Italian when it is empty or still loading', async () => {
    const { draw, tableGrid } = await setup('it')
    const { unmount } = draw()
    expect(screen.getByTestId('hours-table-live').textContent).toBe(
      '16.11.2026 – 22.11.2026: 11 ore e 30 minuti in totale.',
    )
    unmount()
    draw({ state: { status: 'loaded', grid: tableGrid([], daysOf(holding('week', MONDAY))) } })
    expect(screen.getByTestId('hours-table-live').textContent).toBe('16.11.2026 – 22.11.2026: nessuna ora registrata.')
    cleanup()
    draw({ state: { status: 'loading' } })
    expect(screen.getByTestId('hours-table-live').textContent).toBe('Caricamento della tua settimana…')
  })

  it('words the empty week, the empty filtered week and the error in Italian, and has no sentence for a week that has not started', async () => {
    const { draw, tableGrid } = await setup('it')
    const loaded = { status: 'loaded', grid: tableGrid([], daysOf(holding('week', MONDAY))) }
    draw({ state: loaded })
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('Nessuna ora registrata in questa settimana')
    cleanup()
    draw({ state: loaded, filtered: true })
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe(
      'Nessuna registrazione corrisponde a questi filtri',
    )
    expect(screen.getByRole('button', { name: 'Azzera i filtri' })).not.toBeNull()
    cleanup()
    draw({ state: { status: 'error', message: 'Riprova tra un momento.' } })
    expect(within(screen.getByTestId('hours-table-error')).getByText('Impossibile caricare le tue ore')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Riprova' })).not.toBeNull()
  })

  it('says in Italian that the grid scrolls sideways, under the heading and before the table, and not in English', async () => {
    const { draw } = await setup('it')
    draw()
    const hint = screen.getByText('Scorri di lato per vedere tutti e sette i giorni.')
    expect(hint.getAttribute('aria-hidden')).toBe('true')
    expect(hint.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText('Scroll sideways to see all seven days.')).toBeNull()
  })

  it('keeps English as English, so the test above proves the view follows the language and not a default', async () => {
    const { draw } = await setup('en')
    draw()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Week 16.11.2026 – 22.11.2026')
    expect(screen.getByRole('button', { name: '4 h on Alpenstrom, Monday 16 November 2026, 1 entry' })).not.toBeNull()
  })
})

describe('Italian, the toolbar and the Period switch (AC-4.6)', () => {
  it('words the Period group, its two radios and the navigator in Italian, for a week and for a month, and no English', async () => {
    const { draw, drawMonth } = await setup('it')
    const { container } = draw()
    const group = screen.getByRole('radiogroup', { name: 'Periodo' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Settimana', 'Mese'])
    expect(container.textContent).not.toMatch(/\b(Period|Week|Month)\b/)
    cleanup()
    drawMonth()
    expect(screen.getByRole('radiogroup', { name: 'Periodo' })).not.toBeNull()
    expect(within(screen.getByRole('radiogroup')).getByRole('radio', { name: 'Mese' })).toHaveProperty('checked', true)
  })
})

describe('Italian, the date field (AC-4.6, AC-5.30, AC-5.31)', () => {
  const descriptionOf = (input: HTMLElement) =>
    document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent

  it('is labelled "Mostra la settimana del" on a week and "Mostra il mese del" on a month, and described "Fino a oggi."', async () => {
    const { draw, drawMonth } = await setup('it')
    const { container } = draw()
    const week = screen.getByLabelText('Mostra la settimana del')
    expect(descriptionOf(week)).toBe('Fino a oggi.')
    expect(container.textContent).not.toMatch(/Show the|Up to today/)
    cleanup()
    const month = drawMonth()
    const field = screen.getByLabelText('Mostra il mese del')
    expect(descriptionOf(field)).toBe('Fino a oggi.')
    expect(month.container.textContent).not.toMatch(/Show the|Up to today/)
  })

  it('keeps the field in English as English, so the above proves the view follows the language and not a default', async () => {
    const { draw, drawMonth } = await setup('en')
    draw()
    expect(descriptionOf(screen.getByLabelText('Show the week of'))).toBe('Up to today.')
    cleanup()
    drawMonth()
    expect(descriptionOf(screen.getByLabelText('Show the month of'))).toBe('Up to today.')
  })
})

describe('Italian, the month (AC-4.6, AC-5.25)', () => {
  it('heads the card with the month and the year in Italian, and names the table and the navigator for the month', async () => {
    const { drawMonth } = await setup('it')
    drawMonth()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('novembre 2026')
    const navigator = screen.getByRole('group', { name: 'Scegli un mese' })
    expect(within(navigator).getByRole('button', { name: 'Mese precedente' })).not.toBeNull()
    expect(within(navigator).getByRole('button', { name: 'Questo mese' })).not.toBeNull()
    expect(within(navigator).getByRole('button', { name: 'Mese successivo' })).not.toBeNull()
    expect(
      screen.getByRole('table', { name: 'Ore per progetto, opportunità, riunione e altro lavoro, novembre 2026' }),
    ).not.toBeNull()
  })

  it('heads the days compactly in Italian and names each for a reader by its long Italian date, today as "oggi"', async () => {
    const { drawMonth } = await setup('it')
    drawMonth()
    const table = screen.getByRole('table')
    // 1 November 2026 is a Sunday: "Dom", not "Lun"
    expect(within(table).getByRole('columnheader', { name: 'domenica 1 novembre 2026' })).not.toBeNull()
    expect(within(table).getByRole('columnheader', { name: 'giovedì 19 novembre 2026, oggi' })).not.toBeNull()
    expect(within(table).getByRole('columnheader', { name: 'lunedì 30 novembre 2026' })).not.toBeNull()
    const first = within(table).getAllByRole('columnheader')[1]!
    expect(first.querySelector('[aria-hidden="true"]')?.textContent).toBe('Dom1')
    expect(within(table).getAllByRole('columnheader').at(-1)?.textContent).toBe('Totale')
  })

  it('says in Italian that the month scrolls sideways, and not in English', async () => {
    const { drawMonth } = await setup('it')
    drawMonth()
    const hint = screen.getByText('Scorri di lato per vedere tutti i giorni del mese.')
    expect(hint.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByText('Scroll sideways to see every day of the month.')).toBeNull()
  })

  it('announces the month and its total in Italian, words the empty month and its loading, and names a cell by its Italian date', async () => {
    const { drawMonth, tableGrid } = await setup('it')
    const { unmount } = drawMonth()
    expect(screen.getByTestId('hours-table-live').textContent).toBe('novembre 2026: 11 ore e 30 minuti in totale.')
    expect(
      screen.getByRole('button', { name: '4 h su Alpenstrom, lunedì 16 novembre 2026, 1 registrazione' }),
    ).not.toBeNull()
    unmount()
    drawMonth({ state: { status: 'loaded', grid: tableGrid([], daysOf(holding('month', MONDAY))) } })
    expect(screen.getByTestId('hours-table-live').textContent).toBe('novembre 2026: nessuna ora registrata.')
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('Nessuna ora registrata in questo mese')
    cleanup()
    drawMonth({ state: { status: 'loading' } })
    expect(screen.getByTestId('hours-table-live').textContent).toBe('Caricamento del tuo mese…')
  })

  it('has no English left on the month: not the heading, the header, the navigator, nor the states', async () => {
    const { drawMonth } = await setup('it')
    const { container } = drawMonth()
    expect(container.textContent).not.toMatch(
      /\b(Week|Month|Total|Project|Deal|Mon|Tue|Sun|Today|today|November|Not visible)\b/,
    )
  })

  it('keeps the month in English as English, so the above proves the view follows the language and not a default', async () => {
    const { drawMonth } = await setup('en')
    drawMonth()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('November 2026')
    expect(screen.getByRole('columnheader', { name: 'Thursday 19 November 2026, today' })).not.toBeNull()
  })
})
