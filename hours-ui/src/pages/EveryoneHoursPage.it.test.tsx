/**
 * @vitest-environment jsdom
 *
 * Everyone's hours under `<html lang="it">` (specs/029-time-tracking T29, AC-5.5, AC-3.8, AC-4.8): the page, the
 * Person filter, the Totals by person, the table and the denial come from the Italian catalog and none of the
 * English one, and the names of people, projects and categories are shown as they were typed. Completeness of
 * the catalog is checked once for the whole app (strings.test.ts); this proves the page reads it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test sets `<html
 * lang>` and imports the page afresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch, grants } = vi.hoisted(() => ({ apiFetch: vi.fn(), grants: { holder: true } }))
vi.mock('shell/session', async () => {
  const { shellSessionMock, EMPLOYEE, READ_ALL_HOLDER } = await import('../test-support/fakeSession')
  return {
    ...shellSessionMock(apiFetch),
    usePermissions: () => (grants.holder ? READ_ALL_HOLDER : EMPLOYEE),
  }
})

beforeEach(() => {
  apiFetch.mockReset()
  grants.holder = true
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
const setup = async (lang: 'it' | 'en', path = '/hours/all') => {
  document.documentElement.setAttribute('lang', lang)
  const { fakeApi, listsHandler } = await import('../test-support/fakeApi')
  const { LISTS } = await import('../test-support/fixtures/myHours')
  const { entriesHandler, totalsWithPeople } = await import('../test-support/fixtures/everyone')
  const { createAppRouter } = await import('../router')
  const { strings } = await import('../strings')
  apiFetch.mockImplementation(
    fakeApi({
      'GET /time-lists': listsHandler(LISTS),
      'GET /time-entries': entriesHandler,
      'GET /time-entries/totals': totalsWithPeople,
    }),
  )
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-everyone-page')
  return strings
}

const optionTexts = (name: string) =>
  within(screen.getByRole('combobox', { name }))
    .getAllByRole('option')
    .map((option) => option.textContent)

describe('Everyone’s hours in Italian', () => {
  it('names the page, its description and the cards in Italian', async () => {
    const strings = await setup('it')
    expect(strings.everyone.heading).toBe('Le ore di tutti')

    await screen.findByRole('table', { name: 'Registrazioni di tutti, dal giorno più recente' })
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Le ore di tutti')
    expect(
      screen.getByText('Sola lettura. Le ore possono essere modificate solo da chi le ha registrate.'),
    ).not.toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Filtri',
      'Totali',
      'Registrazioni',
    ])
    expect(screen.queryByText("Everyone's hours")).toBeNull()
    expect(screen.queryByText('Read only.', { exact: false })).toBeNull()
  })

  it('the Person filter and the person totals are in Italian, the names are as auth resolved them', async () => {
    await setup('it')
    await waitFor(() => expect(optionTexts('Persona').length).toBe(5))
    expect(optionTexts('Persona')).toEqual([
      'Tutti',
      'Ada Lovelace',
      'Grace Hopper',
      'Utente sconosciuto (disattivato)',
      'Utente sconosciuto',
    ])
    expect(optionTexts('Raggruppa per')).toEqual(['Persona', 'Progetto', 'Opportunità', 'Categoria', 'Mese'])
    const totals = await screen.findByRole('table', { name: 'Ore per persona' })
    expect(
      within(totals)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Persona', 'Tempo'])
    expect(within(totals).getByText('Utente sconosciuto (disattivato)')).not.toBeNull()
    expect(within(totals).getByText('Ada Lovelace')).not.toBeNull()
  })

  it('the table has Italian columns, "Non visibile a te" for a name the holder may not read, and the note in Italian', async () => {
    await setup('it')
    const table = await screen.findByRole('table', { name: 'Registrazioni di tutti, dal giorno più recente' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Giorno', 'Persona', 'Su', 'Dettagli', 'Tempo'])
    const hidden = screen.getByTestId('hours-entry-e-grace-hidden')
    expect(within(hidden).getByText('Non visibile a te')).not.toBeNull()
    expect(within(hidden).getByText('Progetto')).not.toBeNull()
    expect(within(hidden).getByText('Development')).not.toBeNull()
    expect(screen.getByRole('note', { name: 'Registrazioni senza nome visibile' }).textContent).toContain(
      'Alcuni progetti, opportunità o riunioni non sono visibili a te',
    )
  })

  it('the denial and its link are in Italian', async () => {
    grants.holder = false
    await setup('it')
    const panel = await screen.findByTestId('hours-permission-denied')
    expect(within(panel).getByRole('heading', { name: 'Non puoi vedere le ore di tutti' })).not.toBeNull()
    expect(within(panel).getByRole('link', { name: 'Vai alle mie ore' })).not.toBeNull()
    expect(screen.queryByText("You can't see everyone's hours")).toBeNull()
  })

  it('a Custom range before 01.01.2000 is refused in Italian on its field', async () => {
    await setup('it', '/hours/all?period=custom&from=1999-12-31&to=2026-11-13')
    const from = screen.getByLabelText('Dal')
    from.focus()
    await userEvent.tab()
    expect(await screen.findByText('La data non può essere precedente al 01.01.2000.')).not.toBeNull()
  })

  it('in English the same page says the English words (the catalog is chosen, not mixed)', async () => {
    await setup('en')
    await waitFor(() => expect(optionTexts('Person').length).toBe(5))
    expect(optionTexts('Person')[0]).toBe('Everyone')
    expect(screen.queryByText('Tutti')).toBeNull()
  })
})
