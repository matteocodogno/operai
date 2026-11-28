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
  render(<HoursSection projectId="p1" terms={terms} state="active" />)
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

describe('the signals of the consumption block in Italian (specs/20261112-project-hours US-5, AC-3.2, AC-5.9, D95; design § Copy)', () => {
  const on = (terms: Terms, asOf: string): Terms => ({ ...terms, asOf })
  /** The 120 h yearly package of the fixtures above, on 2026-09-01: 184 of its 365 days gone, 50 %. */
  const yearlyOn = (asOf = '2026-09-01', endDate: string | null = null): Terms => on({ ...yearly, endDate }, asOf)
  const fixedOn = (
    over: { deadline?: string; endDate?: string | null; estimatedManDays?: number | null; maxEffortManDays?: number },
    asOf: string,
  ): Terms =>
    on(
      termsOf(
        'fixed_price',
        {
          deadline: over.deadline ?? '2026-12-01',
          estimatedManDays: over.estimatedManDays === undefined ? 10 : over.estimatedManDays,
          maxEffortManDays: over.maxEffortManDays ?? 12,
        },
        { endDate: over.endDate ?? null },
      ),
      asOf,
    )

  const part = (name: string) => screen.queryByTestId(`project-hours-consumption-${name}`)
  const words = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()

  it.each([
    [0, 'In linea'],
    [5760, 'Vicino al limite'],
    [7200, 'Limite raggiunto'],
    [7230, 'Oltre il limite'],
  ] as const)('with %i minutes of 7 200 the state line says "%s", from the Italian catalog', async (minutes, state) => {
    serve(() => summary(minutes))
    await setup('it', yearlyOn())

    await screen.findByTestId('project-hours-consumption-facts')

    expect(words(part('state'))).toBe(state)
    // The English words are nowhere.
    expect(document.body.textContent).not.toMatch(/On track|Close to the limit|Limit reached|Over the limit/)
  })

  it('"Limite raggiunto" at exactly 100 %, "Oltre il limite" above it though the percentage still reads 100% (D95)', async () => {
    serve(() => summary(7200))
    await setup('it', yearlyOn())
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('state'))).toBe('Limite raggiunto')
    expect(words(part('percent'))).toBe('100%')
    expect(fact('Ore rimaste')).toBe('0 min')
    expect(screen.queryByText('Sforato di')).toBeNull()
    cleanup()

    serve(() => summary(7230))
    await setup('it', yearlyOn())
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('state'))).toBe('Oltre il limite')
    expect(words(part('percent'))).toBe('100%')
    expect(fact('Sforato di')).toBe('30 min')
  })

  it('"Limite raggiunto" and "Oltre il limite" for a fixed price too: exactly its impegno massimo, then one minute above it with "Meno di 0,1 giornate"', async () => {
    serve(() => summary(null, 5760))
    await setup('it', fixedOn({}, '2026-11-27'))
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('state'))).toBe('Limite raggiunto')
    expect(screen.queryByText('Sforato di')).toBeNull()
    cleanup()

    serve(() => summary(null, 5761))
    await setup('it', fixedOn({}, '2026-11-27'))
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('state'))).toBe('Oltre il limite')
    expect(words(part('percent'))).toBe('100%')
    expect(fact('Sforato di')).toBe('Meno di 0,1 giornate')
  })

  it('writes the pace line with the Italian article of each figure and no English word', async () => {
    serve(() => summary(5904))
    await setup('it', yearlyOn())
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('pace'))).toBe('Usato l’82% delle ore con il 50% del periodo trascorso')
    cleanup()

    serve(() => summary(0))
    await setup('it', yearlyOn())
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('pace'))).toBe('Usato lo 0% delle ore con il 50% del periodo trascorso')
    cleanup()

    serve(() => summary(null, 4320))
    await setup('it', fixedOn({ deadline: '2026-02-10' }, '2026-02-05'))
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('pace'))).toBe(
      'Usato il 75% dell’impegno massimo con il 40% del tempo fino alla scadenza trascorso',
    )
    cleanup()

    serve(() => summary(null, 3600))
    await setup(
      'it',
      on(
        termsOf('t_and_m', {
          positions: [
            { profile: 'Senior developer', plannedManDays: 20 },
            { profile: 'Designer', plannedManDays: 4 },
          ],
        }),
        '2026-11-27',
      ),
    )
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('pace'))).toBe('Usato il 31% delle giornate previste')
  })

  it('names the marks and the scale of the bar in Italian, from the formatter', async () => {
    serve(() => summary(null, 3600))
    await setup('it', fixedOn({ estimatedManDays: 10, deadline: '2026-12-31' }, '2026-11-27'))

    await screen.findByTestId('project-hours-consumption-facts')

    expect(words(part('bar'))).toBe('Oggi80%100%125%Stima')
  })

  it('says the dates in Italian: the plural of "giorni", the singular, today, and the date in dd.mm.yyyy', async () => {
    serve(() => summary(null, 0))
    await setup('it', fixedOn({ deadline: '2026-10-31', endDate: '2026-12-20' }, '2026-11-27'))
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('date-deadline'))).toBe('Scadenza superata da 27 giorni31.10.2026')
    expect(words(part('date-end-date'))).toBe('Data di fine tra 23 giorni20.12.2026')
    cleanup()

    serve(() => summary(null, 0))
    await setup('it', fixedOn({ deadline: '2026-11-26', endDate: '2026-11-28' }, '2026-11-27'))
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('date-deadline'))).toBe('Scadenza superata da 1 giorno26.11.2026')
    expect(words(part('date-end-date'))).toBe('Data di fine tra 1 giorno28.11.2026')
    cleanup()

    serve(() => summary(null, 0))
    await setup('it', fixedOn({ deadline: '2026-11-27', endDate: '2026-11-27' }, '2026-11-27'))
    await screen.findByTestId('project-hours-consumption-facts')
    expect(words(part('date-deadline'))).toBe('La scadenza è oggi27.11.2026')
    expect(words(part('date-end-date'))).toBe('La data di fine è oggi27.11.2026')
  })

  it('says the date line alone of terms with an SLA in Italian, with no figure', async () => {
    await setup(
      'it',
      on(
        termsOf('maintenance', { sla: { highDays: 1, normalDays: 3 }, hourPackage: null }, { endDate: '2026-11-15' }),
        '2026-11-27',
      ),
    )

    const line = await screen.findByTestId('project-hours-consumption-date-end-date')

    expect(words(line)).toBe('Data di fine superata da 12 giorni15.11.2026')
    expect(part('facts')).toBeNull()
  })

  it('and none of it leaks into English: the same state line in English says the English words', async () => {
    serve(() => summary(7200))
    await setup('en', yearlyOn())

    await screen.findByTestId('project-hours-consumption-facts')

    expect(words(part('state'))).toBe('Limit reached')
    expect(words(part('pace'))).toBe('Used 100% of the hours with 50% of the period elapsed')
  })
})
