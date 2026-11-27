/**
 * @vitest-environment jsdom
 *
 * The Everyone's hours entries table's mark under `<html lang="it">` (specs/20261112-meeting-hours T10; AC-2.3, AC-4.3; design
 * § Copy, S2): "Da riunione" in the On cell, before the name. Its own file because the language is resolved when `strings` is
 * first imported, so each test sets `<html lang>` and imports the table afresh.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

const setup = async (lang: 'it' | 'en', origin?: 'meeting' | 'person') => {
  document.documentElement.setAttribute('lang', lang)
  const { default: EntriesTable } = await import('./EntriesTable')
  const { strings } = await import('../strings')
  const { meetingOn, timeEntryView } = await import('../test-support/fakeApi')
  render(
    <EntriesTable
      entries={[
        timeEntryView({
          id: 'e1',
          minutes: 60,
          on: meetingOn('m1', 'Sync settimanale'),
          ...(origin ? { origin } : {}),
        }),
      ]}
    />,
  )
  const table = screen.getByRole('table', { name: strings.everyone.entries.caption })
  // the On cell is the third of the one body row
  return within(within(table).getAllByRole('row')[1]!.querySelectorAll('td')[2]! as HTMLElement)
}

describe('the mark in the On cell, in Italian (AC-2.3, AC-4.3)', () => {
  it('says "Da riunione", with the kind "Riunione" on the line under the name, and none of the English', async () => {
    const on = await setup('it', 'meeting')
    expect(on.getByText('Da riunione')).not.toBeNull()
    expect(on.getByText('Sync settimanale')).not.toBeNull()
    expect(on.getByText('Riunione')).not.toBeNull()
    expect(on.queryByText('From meeting')).toBeNull()
  })

  it('draws no mark on a hand-made entry', async () => {
    const on = await setup('it', 'person')
    expect(on.queryByText('Da riunione')).toBeNull()
  })

  it('says "From meeting" in English with the same table', async () => {
    const on = await setup('en', 'meeting')
    expect(on.getByText('From meeting')).not.toBeNull()
    expect(on.queryByText('Da riunione')).toBeNull()
  })
})

describe('the project a meeting counts for in the On cell, in Italian (specs/20261112-project-hours AC-4.4, AC-4.7)', () => {
  const setupProject = async (project: unknown) => {
    document.documentElement.setAttribute('lang', 'it')
    const { default: EntriesTable } = await import('./EntriesTable')
    const { strings } = await import('../strings')
    const { meetingOn, timeEntryView } = await import('../test-support/fakeApi')
    render(
      <EntriesTable
        entries={[
          timeEntryView({
            id: 'e1',
            minutes: 60,
            on: { ...meetingOn('m1', 'Sync settimanale'), project } as never,
          }),
        ]}
      />,
    )
    const table = screen.getByRole('table', { name: strings.everyone.entries.caption })
    return within(within(table).getAllByRole('row')[1]!.querySelectorAll('td')[2]! as HTMLElement)
  }

  it('names a visible project, and none of the English', async () => {
    const on = await setupProject({
      state: 'linked',
      visibility: 'visible',
      id: 'p1',
      label: 'Progetto Alfa',
      href: '/projects/p1',
    })
    expect(on.getByText('Conta per il progetto Progetto Alfa')).not.toBeNull()
    expect(on.queryByText(/Counts for/)).toBeNull()
  })

  it('says a hidden project in the design’s words', async () => {
    const on = await setupProject({ state: 'linked', visibility: 'hidden' })
    expect(on.getByText('Conta per un progetto non visibile a te')).not.toBeNull()
  })
})
