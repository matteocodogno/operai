/**
 * @vitest-environment jsdom
 *
 * My hours under `<html lang="it">` (specs/20261112-time-tracking T24, AC-5.5, AC-3.8): the filters and the Totals
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
import { typeDuration } from '../test-support/typeDuration'

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
const setup = async (lang: 'it' | 'en', path = '/hours?view=list', overrides: Record<string, unknown> = {}) => {
  document.documentElement.setAttribute('lang', lang)
  const { dealItem, fakeApi, listsHandler, page } = await import('../test-support/fakeApi')
  const { LISTS } = await import('../test-support/fixtures/myHours')
  const { entriesHandler, totalsWithDays } = await import('../test-support/fixtures/entries')
  const { createAppRouter } = await import('../router')
  const { strings } = await import('../strings')
  apiFetch.mockImplementation(
    fakeApi({
      'GET /time-lists': listsHandler(LISTS),
      'GET /time-entries': entriesHandler,
      'GET /time-entries/totals': totalsWithDays,
      'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
      ...overrides,
    }),
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
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Filtri',
      'Totali',
      'Registrazioni',
    ])
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

  it('Recorded on is "Registrato su": Tutti, Progetto, Opportunità, Riunione, Altro lavoro — the words of the rows’ badges and of Group by (T44)', async () => {
    await setup('it')
    expect(optionTexts('Registrato su')).toEqual(['Tutti', 'Progetto', 'Opportunità', 'Riunione', 'Altro lavoro'])
    expect(optionTexts('Raggruppa per')).toContain('Opportunità')
    expect(screen.queryByRole('combobox', { name: 'Recorded on' })).toBeNull()
    expect(screen.queryByText('Other work')).toBeNull()
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
    await setup('it', '/hours?view=list&group=category')
    const table = await screen.findByRole('table', { name: 'Ore per categoria' })
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('th')?.textContent)
    expect(names).toEqual(['Formazione', 'Seminars (archiviata)', "Su un progetto, un'opportunità o una riunione"])
  })

  it('months are written in Italian', async () => {
    await setup('it', '/hours?view=list&group=month')
    const table = await screen.findByRole('table', { name: 'Ore per mese' })
    expect(within(table).getByText('novembre 2026')).not.toBeNull()
    expect(within(table).getByText('settembre 2026')).not.toBeNull()
  })

  it('the Custom range’s errors and the empty-period line are Italian', async () => {
    await setup('it', '/hours?view=list&period=custom&from=2026-11-10&to=2026-11-01')
    expect(await screen.findByText('La data di fine non può precedere quella di inizio.')).not.toBeNull()
    expect(screen.getByText('Scegli un periodo valido per vedere i totali.')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2024-01-01' } })
    fireEvent.change(screen.getByLabelText('Al'), { target: { value: '2026-11-30' } })
    expect(await screen.findByText('Il periodo non può superare 366 giorni.')).not.toBeNull()
  })

  it('a Custom range before 01.01.2000 names the wrong field in Italian: "data di inizio" and "data di fine"', async () => {
    await setup('it', '/hours?view=list&period=custom&from=1999-01-01&to=1999-12-31')
    screen.getByLabelText('Dal').focus()
    await userEvent.tab() // leaves Dal
    await userEvent.tab() // leaves Al

    expect(await screen.findByText('La data di fine non può precedere il 01.01.2000.')).not.toBeNull()
    const filters = within(screen.getByTestId('hours-filters'))
    expect(filters.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      'La data di inizio non può precedere il 01.01.2000.',
      'La data di fine non può precedere il 01.01.2000.',
    ])
    expect(screen.getByLabelText('Dal').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('Al').getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByText('La data non può essere precedente al 01.01.2000.')).toBeNull()
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

describe('the entries by day in Italian (AC-5.5, AC-3.8, AC-4.10)', () => {
  it('writes the day heading, the day total, the types and the rows in Italian, and a typed list name verbatim', async () => {
    await setup('it')
    const day = await screen.findByTestId('hours-day-2026-11-12')

    expect(within(day).getByRole('heading', { level: 4 }).textContent).toBe('12 novembre 2026')
    const total = screen.getByTestId('hours-day-total-2026-11-12')
    expect(within(total).getByText('Totale del giorno')).not.toBeNull()
    expect(within(total).getByText('8 h 30')).not.toBeNull()
    expect(within(total).getByText('8 ore e 30 minuti')).not.toBeNull()
    expect(within(day).getAllByText('Progetto')).toHaveLength(2)
    expect(within(day).getByText('Non visibile a te')).not.toBeNull()
    expect(within(day).getByText('Attività: non visibile a te')).not.toBeNull()
    expect(within(day).getByText('Attività: Write the offer')).not.toBeNull()
    expect(screen.getByRole('list', { name: 'Registrazioni del 12 novembre 2026' })).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Carica altre' }))
    const kickoff = await screen.findByTestId('hours-entry-e-kickoff')
    expect(within(kickoff).getByText('Riunione')).not.toBeNull()
    expect(within(kickoff).getByText("Conta per l'opportunità Acme renewal")).not.toBeNull()
    const training = screen.getByTestId('hours-entry-e-training')
    expect(within(training).getByText('Altro lavoro')).not.toBeNull()
    expect(within(training).getByText('Formazione')).not.toBeNull()
    expect(within(screen.getByTestId('hours-entry-e-deal')).getByText('Legacy demo (archiviata)')).not.toBeNull()
  })

  it('says the banners, the empty state and the failed load in Italian, and none of the English', async () => {
    const strings = await setup('it', '/hours?view=list', {
      'GET /time-entries': () => ({
        status: 200,
        body: { items: [], nextCursor: null, unavailable: ['projects', 'meeting-deals'] },
      }),
    })
    expect(await screen.findByText('Nessuna ora registrata in questo periodo')).not.toBeNull()
    expect(screen.getByText('Registra le ore lavorate e compaiono qui, giorno per giorno.')).not.toBeNull()
    expect(screen.getByTestId('hours-banner-unavailable').textContent).toBe(
      "Le ore sono complete; questi nomi non sono stati caricati e risultano non disponibili: i nomi dei progetti, l'opportunità a cui contano le ore delle riunioni.",
    )
    expect(screen.getByRole('note', { name: 'Registrazioni senza nome visibile' })).not.toBeNull()
    expect(strings.entries.title).toBe('Registrazioni')
    expect(screen.queryByText('No hours recorded in this period')).toBeNull()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
  })

  it('says the deal-filter-unavailable state in Italian', async () => {
    await setup('it', '/hours?view=list', {
      'GET /time-entries': (url: URL) =>
        url.searchParams.has('dealId')
          ? {
              status: 503,
              body: { type: 'about:blank', title: 'Problem 503', status: 503, code: 'host_unavailable' },
            }
          : { status: 200, body: { items: [], nextCursor: null, unavailable: [] } },
    })
    await screen.findByText('Nessuna ora registrata in questo periodo')
    await userEvent.type(screen.getByRole('combobox', { name: 'Opportunità' }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))

    const alert = await screen.findByTestId('hours-deal-filter-unavailable')
    expect(within(alert).getByText('Al momento non è possibile mostrare le ore di questa opportunità')).not.toBeNull()
    expect(within(alert).getByRole('button', { name: 'Riprova' })).not.toBeNull()
    expect(within(alert).getByRole('button', { name: 'Rimuovi il filtro opportunità' })).not.toBeNull()
  })
})

describe('the entry dialog in Italian (AC-5.5, AC-3.8; specs/20261112-time-tracking T27)', () => {
  it('writes the action, the dialog, the choices and the first errors in Italian, and a typed category verbatim', async () => {
    await setup('it')
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore' }))
    const dialog = screen.getByRole('dialog', { name: 'Registra ore' })
    const inside = within(dialog)

    expect(
      within(inside.getByRole('radiogroup', { name: 'Su cosa hai lavorato' }))
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Progetto', 'Opportunità', 'Riunione', 'Altro lavoro'])
    expect(inside.getByText('A intervalli di 30 minuti, fino a 24 ore.')).not.toBeNull()
    // The Duration is typed (T45, D53): how it was read, and each refusal, in Italian.
    const duration = inside.getByRole('textbox', { name: 'Durata' })
    await typeDuration(duration, '2,5')
    expect(inside.getByText('= 2 h 30')).not.toBeNull()
    for (const [typed, message] of [
      ['2:15', 'In passi di 30 minuti (per esempio 2:00 o 2:30).'],
      ['25', 'Tra 30 minuti e 24 ore.'],
      ['abc', 'Scrivi una durata come 2:30, 2,5 o 2h30.'],
    ] as const) {
      await typeDuration(duration, typed)
      await userEvent.tab()
      expect(inside.getByText(message)).not.toBeNull()
    }
    await typeDuration(duration, '')
    expect(inside.getByText('0 su 1000')).not.toBeNull()

    await userEvent.click(inside.getByRole('radio', { name: 'Altro lavoro' }))
    // A name the administrator typed is shown as typed; a retired one is not offered (AC-3.4).
    expect(
      within(inside.getByRole('combobox', { name: 'Categoria' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Formazione', 'Administration'])

    await userEvent.click(inside.getByRole('button', { name: 'Salva registrazione' }))
    expect(inside.getByText('Scrivi una durata come 2:30, 2,5 o 2h30.')).not.toBeNull()
    expect(inside.getByText('Scegli una categoria.')).not.toBeNull()
    expect(screen.queryByText('Write a duration such as 2:30, 2,5 or 2h30.')).toBeNull()
    expect(screen.queryByText('Save entry')).toBeNull()
  })

  it('says the Day rules as design.md § Date rules — copy writes them: an empty or impossible day, and a day before 01.01.2000', async () => {
    await setup('it')
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore' }))
    const inside = within(screen.getByRole('dialog', { name: 'Registra ore' }))
    const day = inside.getByLabelText(/^Giorno/) as HTMLInputElement

    fireEvent.change(day, { target: { value: '' } })
    fireEvent.blur(day)
    expect(inside.getByText('Scegli un giorno valido.').getAttribute('role')).toBe('alert')
    expect(day.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(day, { target: { value: '0050-01-01' } })
    fireEvent.blur(day)
    expect(inside.getByText('Scegli un giorno valido.')).not.toBeNull()

    fireEvent.change(day, { target: { value: '1999-12-31' } })
    fireEvent.blur(day)
    expect(inside.getByText('Il giorno non può precedere il 01.01.2000.').getAttribute('role')).toBe('alert')
    expect(inside.queryByText('Scegli un giorno valido.')).toBeNull()
    // None of the words the build used to say.
    expect(screen.queryByText('Scegli un giorno che esista nel calendario.')).toBeNull()
    expect(screen.queryByText('Il giorno non può essere precedente al 01.01.2000.')).toBeNull()
  })

  it('says the pickers and a refusal in Italian', async () => {
    await setup('it', '/hours?view=list', {
      'POST /time-entries': () => ({
        status: 403,
        body: { type: 'about:blank', title: 'Problem 403', status: 403, code: 'not_on_project' },
      }),
      'GET /projects': () => ({
        status: 200,
        body: { items: [{ id: 'p1', name: 'Project Alpha', company: null }], total: 1, page: 1, pageSize: 25 },
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore' }))
    const inside = within(screen.getByRole('dialog', { name: 'Registra ore' }))
    await typeDuration(inside.getByRole('textbox', { name: 'Durata' }), '1:00')
    await userEvent.click(inside.getByRole('radio', { name: 'Progetto' }))
    expect(
      inside.getByText('Puoi registrare ore sui progetti di cui sei project manager o in cui fai parte del team.'),
    ).not.toBeNull()
    await userEvent.type(inside.getByRole('combobox', { name: 'Progetto' }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
    await userEvent.click(inside.getByRole('button', { name: 'Salva registrazione' }))

    expect(
      await inside.findByText('Non sei il project manager né fai parte del team di questo progetto.'),
    ).not.toBeNull()
  })
})
