/**
 * @vitest-environment jsdom
 *
 * Edit and Delete under `<html lang="it">` (specs/029-time-tracking T28, AC-5.5): the edit dialog, the "not
 * visible" variant, the delete confirmation and the words after a delete come from the Italian catalog and none
 * of the English one; a name the person or an administrator typed ("Formazione", "Project Alpha") stays verbatim.
 * Completeness of the catalog is checked once for the whole app (strings.test.ts); this proves the screens read it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test sets `<html lang>`
 * and imports the page afresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

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

const setup = async (overrides: Record<string, unknown> = {}) => {
  document.documentElement.setAttribute('lang', 'it')
  const { entriesPage, fakeApi, listsHandler } = await import('../test-support/fakeApi')
  const { totalsWithDays, ALPHA, HIDDEN_PROJECT } = await import('../test-support/fixtures/entries')
  const { ENTRY_LISTS, refusal } = await import('../test-support/fixtures/entry')
  const { createAppRouter } = await import('../router')
  const { strings } = await import('../strings')
  apiFetch.mockImplementation(
    fakeApi({
      'GET /time-lists': listsHandler(ENTRY_LISTS),
      'GET /time-entries': () => ({ status: 200, body: entriesPage([ALPHA, HIDDEN_PROJECT]) }),
      'GET /time-entries/totals': totalsWithDays,
      ...overrides,
    }),
  )
  const history = createMemoryHistory({ initialEntries: ['/hours'] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-my-page')
  await screen.findByTestId('hours-day-list')
  return { strings, refusal }
}

describe('Edit and Delete in Italian', () => {
  it('the row buttons name the entry in Italian', async () => {
    await setup()
    expect(screen.getByTestId('hours-entry-e-alpha-edit').getAttribute('aria-label')).toBe(
      'Modifica 4 h su Project Alpha, 12.11.2026',
    )
    expect(screen.getByTestId('hours-entry-e-alpha-delete').getAttribute('aria-label')).toBe(
      'Elimina 4 h su Project Alpha, 12.11.2026',
    )
  })

  it('the edit dialog is "Modifica registrazione", and the not-visible variant says why in Italian', async () => {
    const { strings } = await setup()
    await userEvent.click(screen.getByTestId('hours-entry-e-hidden-edit'))

    const dialog = screen.getByRole('dialog', { name: 'Modifica registrazione' })
    expect(strings.entry.dialog.editTitle).toBe('Modifica registrazione')
    expect((within(dialog).getByRole('combobox', { name: 'Progetto' }) as HTMLInputElement).value).toBe(
      'Non visibile a te',
    )
    expect(within(dialog).getByText(strings.entry.fields.project.hiddenHint)).not.toBeNull()
    expect(within(dialog).getByText(strings.activity.locked.project)).not.toBeNull()
    expect(dialog.textContent).not.toContain('Not visible to you')
    expect(dialog.textContent).not.toContain("You can't open")
  })

  it('the delete confirmation is in Italian: the sentence, the hidden wording and the buttons', async () => {
    await setup()
    await userEvent.click(screen.getByTestId('hours-entry-e-alpha-delete'))
    const dialog = screen.getByRole('alertdialog', { name: 'Eliminare questa registrazione?' })
    expect(within(dialog).getByText("4 h su Project Alpha, 12.11.2026. L'azione non si può annullare.")).not.toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Elimina registrazione' })).not.toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Annulla' })).not.toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }))

    await userEvent.click(screen.getByTestId('hours-entry-e-hidden-delete'))
    expect(
      screen.getByText("2 h su un progetto non visibile a te, 12.11.2026. L'azione non si può annullare."),
    ).not.toBeNull()
  })

  it('after a delete the banner is in Italian; "already gone" is too', async () => {
    const { refusal } = await import('../test-support/fixtures/entry')
    await setup({ 'DELETE /time-entries/:id': () => ({ status: 204 }) })
    await userEvent.click(screen.getByTestId('hours-entry-e-alpha-delete'))
    await userEvent.click(screen.getByRole('button', { name: 'Elimina registrazione' }))
    expect((await screen.findByTestId('hours-entry-deleted')).textContent).toBe('Registrazione eliminata.')
    void refusal
  })

  it('"already gone" and a failed delete are in Italian', async () => {
    const { refusal } = await import('../test-support/fixtures/entry')
    await setup({
      'DELETE /time-entries/:id': () => refusal(404, 'not_found'),
    })
    await userEvent.click(screen.getByTestId('hours-entry-e-alpha-delete'))
    await userEvent.click(screen.getByRole('button', { name: 'Elimina registrazione' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect((await screen.findByTestId('hours-entry-gone')).textContent).toContain(
      'Questa registrazione non esiste più. L’elenco è stato aggiornato.',
    )
  })

  it('a 404 on a save that kept the target is said in Italian', async () => {
    const { refusal } = await import('../test-support/fixtures/entry')
    const { strings } = await setup({ 'PATCH /time-entries/:id': () => refusal(404, 'not_found') })
    await userEvent.click(screen.getByTestId('hours-entry-e-alpha-edit'))
    const dialog = screen.getByRole('dialog', { name: 'Modifica registrazione' })
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Durata' }), '60')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva registrazione' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(strings.entry.errors.entryGone)
    expect(strings.entry.errors.entryGone).toContain('non si trova più')
  })
})
