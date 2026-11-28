/**
 * @vitest-environment jsdom
 *
 * The hours panel under `<html lang="it">` (specs/20261112-project-hours T13; AC-3.2): its words, the unavailable state and the notes inside
 * the breakdown come from the Italian catalog and none of the English one, a work type or a person an administrator or a person named
 * ("Sviluppo", "Ada Lovelace") is shown verbatim, and the duration is written the Italian way. Completeness of the catalog is checked once
 * for the whole app (strings.test.ts); this proves the panel reads it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test sets `<html lang>` and imports the panel afresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('./test-support/fakeSession')).shellSessionMock(apiFetch))

beforeEach(() => {
  apiFetch.mockReset()
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const ANSWER = {
  on: { type: 'project', id: 'p1' },
  totalMinutes: 5400,
  windowMinutes: null,
  byWorkType: [
    { kind: 'keyed', key: 'wt-dev', label: 'Sviluppo', minutes: 3000, retired: true },
    { kind: 'none', minutes: 2400 },
  ],
  byPerson: [{ kind: 'keyed', key: 'u1', label: null, minutes: 5400, status: 'deleted' }],
  unavailable: ['identities'],
}

/** The panel and its strings, imported after the language is set. */
const setup = async (lang: 'it' | 'en') => {
  document.documentElement.setAttribute('lang', lang)
  const { default: HostHours } = await import('./HostHours')
  const { strings } = await import('./strings')
  return { HostHours, strings }
}

describe('the hours panel in Italian (AC-3.2)', () => {
  it('says the total, what it includes and the disclosure in Italian, and nothing in English', async () => {
    apiFetch.mockResolvedValue(json(ANSWER))
    const { HostHours } = await setup('it')
    render(<HostHours on="project" targetId="p1" />)

    const total = await screen.findByTestId('hours-host-hours-total')
    expect(within(total).getByText('Totale registrato')).not.toBeNull()
    expect(within(total).getByText('90 h')).not.toBeNull()
    expect(screen.getByText('Comprende le ore registrate sulle riunioni collegate a questo progetto.')).not.toBeNull()
    expect(screen.getByRole('group', { name: 'Ore su questo progetto' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Mostra dettaglio' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('hours-host-hours').textContent).not.toMatch(/Total recorded|Includes|breakdown/)
  })

  it('opens onto Italian tables with the names as sent, and the notes in Italian', async () => {
    apiFetch.mockResolvedValue(json(ANSWER))
    const { HostHours, strings } = await setup('it')
    render(<HostHours on="project" targetId="p1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Mostra dettaglio' }))

    expect(screen.getByRole('button', { name: 'Nascondi dettaglio' })).not.toBeNull()
    const workTypes = screen.getByRole('table', { name: 'Per tipo di lavoro' })
    expect(within(workTypes).getByRole('columnheader', { name: 'Tipo di lavoro' })).not.toBeNull()
    expect(within(workTypes).getByRole('columnheader', { name: 'Tempo' })).not.toBeNull()
    expect(within(workTypes).getByText(strings.entries.retired('Sviluppo'))).not.toBeNull()
    expect(within(workTypes).getByText('Senza tipo di lavoro')).not.toBeNull()
    const people = screen.getByRole('table', { name: 'Per persona' })
    expect(
      within(people).getByText(strings.everyone.person.deactivated(strings.everyone.person.unknown)),
    ).not.toBeNull()
    expect(screen.getByText(/Le ore sono complete; questi nomi non sono stati caricati/)).not.toBeNull()
  })

  it('says in Italian that the person breakdown could not be checked', async () => {
    apiFetch.mockResolvedValue(json({ ...ANSWER, byPerson: null, unavailable: ['authz'] }))
    const { HostHours } = await setup('it')
    render(<HostHours on="deal" targetId="d1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Mostra dettaglio' }))

    expect(
      screen.getByText(
        'Al momento non è stato possibile verificare il dettaglio per persona, quindi non viene mostrato.',
      ),
    ).not.toBeNull()
    expect(screen.getByRole('group', { name: 'Ore su questa opportunità' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Riprova' })).not.toBeNull()
  })

  it('words the empty and the unavailable states in Italian', async () => {
    apiFetch.mockResolvedValue(json({ ...ANSWER, totalMinutes: 0, byWorkType: [], byPerson: null, unavailable: [] }))
    const { HostHours } = await setup('it')
    render(<HostHours on="deal" targetId="d1" />)
    expect((await screen.findByTestId('hours-host-hours-empty')).textContent).toBe(
      'Nessuna ora registrata finora. Le ore registrate su questa opportunità, o sulle riunioni collegate, compaiono qui.',
    )
    cleanup()

    apiFetch.mockResolvedValue(json({ status: 503, code: 'host_unavailable' }, 503))
    render(<HostHours on="deal" targetId="d1" />)
    const banner = await screen.findByTestId('hours-host-hours-error')
    expect(banner.textContent).toContain('Le ore non sono disponibili')
    expect(banner.textContent).toContain('Riprova tra un momento.')
    expect(within(banner).getByRole('button', { name: 'Riprova' })).not.toBeNull()
  })
})
