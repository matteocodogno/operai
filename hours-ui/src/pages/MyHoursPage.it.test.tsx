/**
 * @vitest-environment jsdom
 *
 * My hours under `<html lang="it">` (specs/029-time-tracking T24, AC-5.5, AC-3.8): the filters and the Totals
 * card come from the Italian catalog and none of the English one, months are written in Italian, and a name
 * the administrator typed ("Formazione") is shown verbatim — in a language that is not the one it was typed
 * in, and in English too. Completeness of the catalog is checked once for the whole app (strings.test.ts);
 * this proves the page reads it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test sets
 * `<html lang>` and imports the page afresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

/** The page, its strings and its fake API, all imported after the language is set. */
const setup = async (lang: 'it' | 'en', path = '/hours') => {
  document.documentElement.setAttribute('lang', lang)
  const { fakeApi, listsHandler } = await import('../test-support/fakeApi')
  const { LISTS, totalsHandler } = await import('../test-support/fixtures/myHours')
  const { createAppRouter } = await import('../router')
  const { strings } = await import('../strings')
  apiFetch.mockImplementation(
    fakeApi({ 'GET /time-lists': listsHandler(LISTS), 'GET /time-entries/totals': totalsHandler }),
  )
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-my-page')
  return strings
}

const optionTexts = (name: string) =>
  within(screen.getByRole('combobox', { name }))
    .getAllByRole('option')
    .map((option) => option.textContent)

describe('My hours in Italian', () => {
  it('names the page, its description, the cards and the periods in Italian', async () => {
    const strings = await setup('it')
    expect(strings.myHours.heading).toBe('Le mie ore')

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Le mie ore')
    expect(screen.getByText(/conta per intero su ciascuna/)).not.toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Filtri', 'Totali'])
    expect(optionTexts('Periodo')).toEqual([
      'Questa settimana',
      'Settimana scorsa',
      'Questo mese',
      'Mese scorso',
      "Quest'anno",
      'Intervallo personalizzato',
    ])
    expect(screen.queryByText('Filters')).toBeNull()
    expect(screen.queryByText('Totals')).toBeNull()
  })

  it('shows a name the administrator typed verbatim, and marks a retired one in Italian (AC-3.8, AC-3.4)', async () => {
    await setup('it')
    await screen.findByText('Progetti non visibili a te')
    await vi.waitFor(() => expect(optionTexts('Categoria').length).toBeGreaterThan(1))

    expect(optionTexts('Categoria')).toEqual([
      'Tutte le categorie',
      'Formazione',
      'Administration',
      'Seminars (archiviata)',
    ])
    expect(optionTexts('Tipo di lavoro')[0]).toBe('Tutti i tipi di lavoro')
    expect(
      within(screen.getByRole('combobox', { name: 'Tipo di lavoro' }))
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toEqual(['Tipi di lavoro dei progetti', 'Tipi di lavoro delle opportunità'])
  })

  it('writes the totals table in Italian: the grouping, the merged rows and the figures', async () => {
    await setup('it')
    const table = await screen.findByRole('table', { name: 'Ore per progetto' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Progetto', 'Tempo'])
    expect(within(table).getByText('Progetti non visibili a te')).not.toBeNull()
    expect(within(table).getByText('Progetti il cui nome non è disponibile')).not.toBeNull()
    expect(within(table).getByText('Non su un progetto')).not.toBeNull()
    expect(within(table).getByText('2 h 30')).not.toBeNull()
    expect(screen.getByTestId('hours-totals-live').textContent).toContain('in totale')
    expect(optionTexts('Raggruppa per')).toEqual(['Progetto', 'Opportunità', 'Categoria', 'Mese'])
  })

  it('a category grouping keeps the typed name and says the rest in Italian', async () => {
    await setup('it', '/hours?group=category')
    const table = await screen.findByRole('table', { name: 'Ore per categoria' })
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('th')?.textContent)
    expect(names).toEqual(['Formazione', 'Seminars (archiviata)', "Su un progetto, un'opportunità o una riunione"])
  })

  it('months are written in Italian', async () => {
    await setup('it', '/hours?group=month')
    const table = await screen.findByRole('table', { name: 'Ore per mese' })
    expect(within(table).getByText('novembre 2026')).not.toBeNull()
    expect(within(table).getByText('settembre 2026')).not.toBeNull()
  })

  it('the Custom range’s errors and the empty-period line are Italian', async () => {
    await setup('it', '/hours?period=custom&from=2026-11-10&to=2026-11-01')
    expect(await screen.findByText('La data di fine non può precedere quella di inizio.')).not.toBeNull()
    expect(screen.getByText('Scegli un periodo valido per vedere i totali.')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2024-01-01' } })
    fireEvent.change(screen.getByLabelText('Al'), { target: { value: '2026-11-30' } })
    expect(await screen.findByText('Il periodo non può superare 366 giorni.')).not.toBeNull()
  })

  it('the project picker says its states in Italian', async () => {
    await setup('it')
    await userEvent.type(screen.getByRole('combobox', { name: 'Progetto' }), 'zzz')
    const listbox = await screen.findByTestId('hours-filter-project-input-listbox')
    await vi.waitFor(() => expect(within(listbox).getByText('Nessun progetto corrisponde.')).not.toBeNull())
  })
})

describe('the same names in English', () => {
  it('shows "Formazione" verbatim here too: a list name is data, never translated (AC-3.8)', async () => {
    await setup('en')
    await vi.waitFor(() => expect(optionTexts('Category').length).toBeGreaterThan(1))
    expect(optionTexts('Category')).toEqual(['All categories', 'Formazione', 'Administration', 'Seminars (retired)'])
  })
})
