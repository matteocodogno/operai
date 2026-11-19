/**
 * @vitest-environment jsdom
 *
 * The Record hours button under `<html lang="it">` (specs/20261116-record-hours-in-place T2; AC-4.6): the button's name on
 * a task row, the sentence under the dialog's title, and the message after a save come from the Italian catalog and
 * none of the English one; the duration and the date are written the Italian way, and a name an administrator or a
 * person typed ("Alpenstrom — portale clienti", "Formazione") is shown verbatim. Completeness of the catalog is checked
 * once for the whole app (strings.test.ts); this proves the widget reads it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test sets `<html lang>` and
 * imports the widget afresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch, navigateSuite } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  navigateSuite: vi.fn<(to: string) => void>(),
}))
vi.mock('shell/session', async () =>
  (await import('./test-support/fakeSession')).shellSessionMock(apiFetch, { navigateSuite }),
)

beforeEach(() => {
  apiFetch.mockReset()
  navigateSuite.mockReset()
  // Only the clock: the waits below run on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

const PROJECT_TASK = {
  on: 'project',
  targetId: 'p1',
  targetName: 'Alpenstrom — portale clienti',
  activityId: 'a-offer',
  activityName: 'Scrivere l’offerta',
  placement: 'row',
} as const
const CRM_TASK = {
  on: 'none',
  targetId: '',
  targetName: '',
  activityId: '',
  activityName: 'Chiamare Acme',
  placement: 'row',
} as const

/** The widget, its strings and its fake API, all imported after the language is set. */
const setup = async (lang: 'it' | 'en') => {
  document.documentElement.setAttribute('lang', lang)
  const { default: RecordHours } = await import('./RecordHours')
  const { strings } = await import('./strings')
  const { fakeApi } = await import('./test-support/fakeApi')
  const { ENTRY_LISTS } = await import('./test-support/fixtures/entry')
  apiFetch.mockImplementation(fakeApi({ 'GET /time-lists': () => ({ status: 200, body: ENTRY_LISTS }) }))
  const { typeDuration } = await import('./test-support/typeDuration')
  return { RecordHours, strings, typeDuration }
}

describe('Record hours in Italian (AC-4.6)', () => {
  it('names the button after the task, in Italian, with the visible label of My hours', async () => {
    const { RecordHours, strings } = await setup('it')
    render(<RecordHours {...PROJECT_TASK} />)

    const button = screen.getByRole('button', { name: 'Registra ore su Scrivere l’offerta' })
    expect(button.textContent).toBe('Registra ore')
    expect(button.textContent).toBe(strings.entry.record)
    expect(screen.queryByRole('button', { name: /^Record/ })).toBeNull()
  })

  it('opens a dialog that says in Italian what the hours are recorded on, and nothing in English', async () => {
    const { RecordHours } = await setup('it')
    render(<RecordHours {...PROJECT_TASK} />)
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore su Scrivere l’offerta' }))

    const dialog = await screen.findByRole('dialog', { name: 'Registra ore' })
    const description = document.getElementById(dialog.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe('Stai registrando ore sul progetto Alpenstrom — portale clienti.')
    expect(within(dialog).getByText('Scrivere l’offerta', { selector: 'dd' })).not.toBeNull()
    expect(
      within(dialog).getByText('Le ore vengono registrate su questa attività. Qui non si può cambiare.'),
    ).not.toBeNull()
    expect(within(dialog).queryByText(/Recording hours|Hours are recorded/)).toBeNull()
  })

  it('says what was recorded in Italian, with the link and the dismissal', async () => {
    const { RecordHours, typeDuration } = await setup('it')
    render(<RecordHours {...PROJECT_TASK} />)
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore su Scrivere l’offerta' }))
    await screen.findByRole('dialog')
    await typeDuration(screen.getByRole('textbox', { name: 'Durata' }), '2:30')
    await userEvent.click(screen.getByRole('button', { name: 'Salva registrazione' }))

    const message = await screen.findByTestId('hours-record-hours-message')
    expect(within(message).getByTestId('hours-record-hours-recorded').textContent).toBe(
      'Hai registrato 2 h 30 su Alpenstrom — portale clienti.',
    )
    expect(within(message).getByRole('link', { name: 'Vedi in Le mie ore' }).getAttribute('href')).toBe('/hours')
    expect(within(message).getByRole('button', { name: 'Chiudi avviso' })).not.toBeNull()
    expect(message.textContent).not.toMatch(/recorded|See in|Dismiss/)
  })

  // The first draft, "{duration} registrate su …", made a participle agree with a duration: "registrate" is feminine
  // plural, which suits "ore" but not "1 h" or "30 min" (design § Copy, QE observation). The verb is now in the person,
  // so nothing agrees with the figure and the sentence is right for a half hour, one hour and two and a half.
  it.each([
    ['0:30', '30 min'],
    ['1:00', '1 h'],
    ['2:30', '2 h 30'],
  ])('says "Hai registrato" with %s as "%s", a verb that agrees with no figure', async (typed, shown) => {
    const { RecordHours, typeDuration } = await setup('it')
    render(<RecordHours {...PROJECT_TASK} />)
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore su Scrivere l’offerta' }))
    await screen.findByRole('dialog')
    await typeDuration(screen.getByRole('textbox', { name: 'Durata' }), typed)
    await userEvent.click(screen.getByRole('button', { name: 'Salva registrazione' }))

    const recorded = (await screen.findByTestId('hours-record-hours-recorded')).textContent
    expect(recorded).toBe(`Hai registrato ${shown} su Alpenstrom — portale clienti.`)
    expect(recorded).not.toMatch(/registrate/)
  })

  it('says "altro lavoro" with the category, shown as typed, for a CRM task with no deal', async () => {
    const { RecordHours, typeDuration } = await setup('it')
    render(<RecordHours {...CRM_TASK} />)
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore su Chiamare Acme' }))
    await screen.findByRole('dialog')
    await typeDuration(screen.getByRole('textbox', { name: 'Durata' }), '1:30')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Categoria/ }), 'Formazione')
    await userEvent.click(screen.getByRole('button', { name: 'Salva registrazione' }))

    expect((await screen.findByTestId('hours-record-hours-recorded')).textContent).toBe(
      'Hai registrato 1 h 30 su altro lavoro: Formazione.',
    )
  })

  it('says "questa opportunità" for a deal the host could not name', async () => {
    const { RecordHours, typeDuration } = await setup('it')
    render(<RecordHours on="deal" targetId="d1" targetName="" activityId="" activityName="" placement="page" />)
    await userEvent.click(screen.getByRole('button', { name: 'Registra ore' }))
    await screen.findByRole('dialog')
    await typeDuration(screen.getByRole('textbox', { name: 'Durata' }), '1:00')
    await userEvent.click(screen.getByRole('button', { name: 'Salva registrazione' }))

    expect((await screen.findByTestId('hours-record-hours-recorded')).textContent).toBe(
      'Hai registrato 1 h su questa opportunità.',
    )
  })
})
