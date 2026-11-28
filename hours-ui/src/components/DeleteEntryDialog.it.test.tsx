/**
 * @vitest-environment jsdom
 *
 * The delete confirmation of an automatic entry under `<html lang="it">` (specs/20261112-meeting-hours T10; AC-2.7, AC-4.3;
 * design § Copy, S4): the second paragraph is "Operai non la registrerà di nuovo dalla riunione. Puoi comunque registrare le ore
 * tu." ("la": an entry is "la registrazione" in hours-ui's Italian). Its own file because the language is resolved when
 * `strings` is first imported, so each test sets `<html lang>` and imports the dialog afresh.
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
  const { default: DeleteEntryDialog } = await import('./DeleteEntryDialog')
  const { strings } = await import('../strings')
  const { meetingOn, timeEntryView } = await import('../test-support/fakeApi')
  render(
    <DeleteEntryDialog
      entry={timeEntryView({
        id: 'a1',
        minutes: 60,
        on: meetingOn('m1', 'Sync settimanale'),
        ...(origin ? { origin } : {}),
      })}
      onConfirm={() => Promise.resolve()}
      onCancel={() => {}}
    />,
  )
  return within(screen.getByRole('alertdialog', { name: strings.entry.delete.title }))
}

describe('the confirmation in Italian (AC-2.7, AC-4.3)', () => {
  it('says the existing sentence, then the second paragraph, for an automatic entry', async () => {
    const dialog = await setup('it', 'meeting')
    expect(dialog.getByText("1 h su Sync settimanale, 12.11.2026. L'azione non si può annullare.")).not.toBeNull()
    expect(
      dialog.getByText('Operai non la registrerà di nuovo dalla riunione. Puoi comunque registrare le ore tu.'),
    ).not.toBeNull()
    expect(dialog.queryByText(/won't record it again/)).toBeNull()
  })

  it('says only the existing sentence for an entry typed by hand', async () => {
    const dialog = await setup('it', 'person')
    expect(dialog.getByText("1 h su Sync settimanale, 12.11.2026. L'azione non si può annullare.")).not.toBeNull()
    expect(dialog.queryByText(/non la registrerà/)).toBeNull()
  })

  it('says the two English sentences in English', async () => {
    const dialog = await setup('en', 'meeting')
    expect(
      dialog.getByText("Operai won't record it again from its meeting. You can still record hours yourself."),
    ).not.toBeNull()
    expect(dialog.queryByText(/non la registrerà/)).toBeNull()
  })
})
