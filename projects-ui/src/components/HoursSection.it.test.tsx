/**
 * @vitest-environment jsdom
 *
 * The Hours card under `<html lang="it">` (specs/20261112-project-hours AC-3.2; design § Copy): every word of the card and
 * its consumption block comes from the Italian catalog and none from the English one, dates and durations are the
 * library's in Italian, and "Sforato di" replaces "Ore rimaste" once a package is exceeded (D81). Completeness of the
 * catalog is checked once for the whole app (strings.test.ts); this proves the card reads it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test sets `<html lang>` and
 * imports the card afresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { fakeApi, problem, termsOf } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import type { Terms } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getHoursApiBaseUrl: () => 'http://hours-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const serve = (answer: () => FakeAnswer) =>
  apiFetch.mockImplementation(fakeApi({ 'GET /time-entries/summary': answer }))
const summary = (windowMinutes: number | null, totalMinutes = 6000) => ({
  status: 200,
  body: {
    on: { type: 'project', id: 'p1' },
    totalMinutes,
    windowMinutes,
    byWorkType: [],
    byPerson: null,
    unavailable: [],
  },
})

const yearly: Terms = termsOf('maintenance', {
  sla: null,
  hourPackage: {
    hours: 120,
    kind: 'yearly',
    startDate: '2026-03-01',
    expiryDate: null,
    currentPeriod: { from: '2026-03-01', to: '2027-02-28', ended: false },
  },
})
const capacityEnded: Terms = termsOf('maintenance', {
  sla: null,
  hourPackage: {
    hours: 120,
    kind: 'capacity',
    startDate: '2026-03-01',
    expiryDate: null,
    currentPeriod: { from: '2026-03-01', to: '2026-11-27', ended: true },
  },
})

beforeEach(() => {
  apiFetch.mockReset()
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.doUnmock('shell/extensions')
  vi.resetModules()
})

/** The card, its strings and the seam, all imported after the language is set. */
const setup = async (
  lang: 'it' | 'en',
  terms: Terms | null,
  extensions: () => Record<string, unknown> = () => ({}),
) => {
  document.documentElement.setAttribute('lang', lang)
  vi.resetModules()
  vi.doMock('shell/extensions', extensions)
  const HoursSection = (await import('./HoursSection')).default
  render(<HoursSection projectId="p1" terms={terms} />)
}

const visible = (element: Element): string => {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('.visually-hidden').forEach((node) => node.remove())
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}
const fact = (term: string) =>
  visible(within(screen.getByTestId('project-hours-consumption-facts')).getByText(term).nextElementSibling!)

describe('the Hours card in Italian', () => {
  it('names the card, the package, its period and its hours in Italian, with the library formatters in Italian', async () => {
    serve(() => summary(5070))
    await setup('it', yearly)

    await screen.findByTestId('project-hours-consumption-facts')

    expect(screen.getByRole('heading', { level: 3, name: 'Ore' })).not.toBeNull()
    expect(fact('Pacchetto annuale')).toBe('120 h')
    expect(fact('Periodo in corso')).toBe('01.03.2026 – 28.02.2027')
    expect(fact('Ore usate nel periodo')).toBe('84 h 30')
    expect(fact('Ore rimaste')).toBe('35 h 30')
    expect(screen.getByText('Le ore non usate in un periodo non passano a quello successivo.')).not.toBeNull()
    // The spoken twin is Italian too.
    const dd = within(screen.getByTestId('project-hours-consumption-facts')).getByText(
      'Ore usate nel periodo',
    ).nextElementSibling!
    expect(dd.querySelector('.visually-hidden')?.textContent).toBe('84 ore e 30 minuti')
    expect(screen.getByRole('group', { name: 'Consumo' })).not.toBeNull()
  })

  it('says "Sforato di" for an exceeded package, "Scaduto" for an expired one and "Dal …, senza scadenza" for an open one', async () => {
    serve(() => summary(9000))
    await setup('it', capacityEnded)

    await screen.findByTestId('project-hours-consumption-facts')

    expect(fact('Sforato di')).toBe('30 h')
    expect(screen.queryByText('Ore rimaste')).toBeNull()
    expect(fact('Periodo del pacchetto')).toBe('Dal 01.03.2026, senza scadenza Scaduto')
    expect(screen.getByTestId('project-hours-consumption-expired').textContent).toContain('Scaduto')
  })

  it('names man-days "giornate" with one decimal', async () => {
    serve(() => summary(null, 3600))
    await setup('it', termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: 10, maxEffortManDays: 12 }))

    await screen.findByTestId('project-hours-consumption-facts')

    expect(fact('Giornate usate')).toBe('7,5 giornate')
    expect(fact('Giornate stimate')).toBe('10,0 giornate')
    expect(fact('Impegno massimo')).toBe('12,0 giornate')
    expect(
      screen.getByText('Conta tutte le ore registrate sul progetto. Una giornata equivale a 8 ore.'),
    ).not.toBeNull()
  })

  it('says the consumption and the hours are unavailable in Italian, with an Italian Retry', async () => {
    serve(() => problem(503, 'host_unavailable'))
    await setup('it', yearly, () => ({ HostExtension: ({ fallback }: { fallback: unknown }) => fallback }))

    const banner = await screen.findByTestId('project-hours-consumption-unavailable')
    expect(banner.textContent).toContain('Il consumo non è disponibile')
    expect(banner.textContent).toContain('Operai non è riuscito a caricare le ore registrate su questo progetto')
    expect(within(banner).getByRole('button', { name: 'Riprova' })).not.toBeNull()
    expect((await screen.findByTestId('project-hours-unavailable')).textContent).toBe(
      'Le ore non sono disponibili. Ricarica la pagina per riprovare.',
    )
  })

  it('shows the loading lines in Italian', async () => {
    apiFetch.mockImplementation(() => new Promise(() => undefined))
    await setup('it', yearly, () => new Promise(() => undefined) as unknown as Record<string, unknown>)

    expect(screen.getByText('Caricamento del consumo…')).not.toBeNull()
    expect(screen.getByText('Caricamento delle ore…')).not.toBeNull()
  })

  it('and none of it leaks into English: the same card in English says the English words', async () => {
    serve(() => summary(5070))
    await setup('en', yearly)

    await screen.findByTestId('project-hours-consumption-facts')

    expect(screen.getByRole('heading', { level: 3, name: 'Hours' })).not.toBeNull()
    expect(fact('Yearly package')).toBe('120 h')
    expect(screen.queryByText('Pacchetto annuale')).toBeNull()
  })
})
