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
