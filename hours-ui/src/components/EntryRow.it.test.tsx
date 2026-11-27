/**
 * @vitest-environment jsdom
 *
 * The entry row's mark under `<html lang="it">` (specs/20261112-meeting-hours T10; AC-2.3, AC-4.3; design § Copy): "Da riunione",
 * not the product's English and not "Dal meeting" — the kind badge of the very same row says "Riunione", and one thing is not
 * named twice. Its own file because the language is resolved when `strings` is first imported, so each test sets `<html lang>`
 * and imports the row afresh.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

/** A row of one hour on the meeting "Sync settimanale", imported after the language is set. */
const setup = async (lang: 'it' | 'en', origin?: 'meeting' | 'person') => {
  document.documentElement.setAttribute('lang', lang)
  const { default: EntryRow } = await import('./EntryRow')
  const { meetingOn, timeEntryView } = await import('../test-support/fakeApi')
  render(
    <EntryRow
      entry={timeEntryView({
        id: 'a1',
        minutes: 60,
        on: meetingOn('m1', 'Sync settimanale'),
        ...(origin ? { origin } : {}),
      })}
    />,
  )
  return within(screen.getByTestId('hours-entry-a1'))
}

describe('the mark in Italian (AC-2.3, AC-4.3)', () => {
  it('says "Da riunione" next to the kind badge "Riunione", and none of the English', async () => {
    const row = await setup('it', 'meeting')
    expect(row.getByText('Riunione')).not.toBeNull()
    expect(row.getByText('Da riunione')).not.toBeNull()
    expect(row.queryByText('From meeting')).toBeNull()
    expect(row.queryByText(/dal meeting/i)).toBeNull()
  })

  it('draws no mark, in either language, on an entry typed by hand', async () => {
    const italian = await setup('it', 'person')
    expect(italian.queryByText('Da riunione')).toBeNull()
    cleanup()
    vi.resetModules()
    const english = await setup('en', 'person')
    expect(english.queryByText('From meeting')).toBeNull()
  })

  it('says "From meeting" in English with the same row', async () => {
    const row = await setup('en', 'meeting')
    expect(row.getByText('From meeting')).not.toBeNull()
    expect(row.queryByText('Da riunione')).toBeNull()
  })
})

describe('the project a meeting counts for, in Italian (specs/20261112-project-hours AC-4.4, AC-4.7)', () => {
  const setupProject = async (project: unknown, deal: unknown = { state: 'none' }) => {
    document.documentElement.setAttribute('lang', 'it')
    const { default: EntryRow } = await import('./EntryRow')
    const { meetingOn, timeEntryView } = await import('../test-support/fakeApi')
    render(
      <EntryRow
        entry={timeEntryView({
          id: 'a1',
          minutes: 60,
          on: { ...meetingOn('m1', 'Sync settimanale', deal as never), project } as never,
        })}
      />,
    )
    return within(screen.getByTestId('hours-entry-a1'))
  }

  it('names a visible project: "Conta per il progetto Progetto Alfa", and none of the English', async () => {
    const row = await setupProject({
      state: 'linked',
      visibility: 'visible',
      id: 'p1',
      label: 'Progetto Alfa',
      href: '/projects/p1',
    })
    expect(row.getByText('Conta per il progetto Progetto Alfa')).not.toBeNull()
    expect(row.queryByText(/Counts for/)).toBeNull()
  })

  it('says a hidden and an unavailable project in the design’s words', async () => {
    const hidden = await setupProject({ state: 'linked', visibility: 'hidden' })
    expect(hidden.getByText('Conta per un progetto non visibile a te')).not.toBeNull()
    cleanup()
    vi.resetModules()
    const unavailable = await setupProject({ state: 'linked', visibility: 'unavailable' })
    expect(unavailable.getByText('Conta per un progetto il cui nome non è disponibile')).not.toBeNull()
  })

  it('says the one unknown line for the deal or the project, once', async () => {
    const row = await setupProject({ state: 'unknown' }, { state: 'unknown' })
    expect(row.getAllByText("L'opportunità o il progetto a cui contano queste ore al momento non è noto")).toHaveLength(
      1,
    )
  })
})
