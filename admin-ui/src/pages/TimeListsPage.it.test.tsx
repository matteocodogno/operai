/**
 * @vitest-environment jsdom
 *
 * TimeListsPage under `<html lang="it">` (T31, specs/029-time-tracking, AC-5.5): every string of
 * the page's states comes from the Italian catalog, none from the English one, and the server's own
 * (English) problem text never reaches the screen. The catalog's completeness is checked once for
 * the whole app by strings.test.tsx (`catalogGaps`); this proves the page reads it.
 *
 * Its own file because the language is resolved when `strings` is first imported, so each test
 * sets `<html lang>` and imports the page afresh.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../lib/timeListsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/timeListsApi')>()
  return {
    ...original,
    listTimeLists: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    createWorkType: vi.fn(),
    updateWorkType: vi.fn(),
  }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

/** The page, its fake API and its permissions, all imported after the language is set. */
const setup = async (grantsManage: boolean) => {
  document.documentElement.setAttribute('lang', 'it')
  // One at a time: concurrent imports of a mocked module can evaluate its factory twice.
  const session = await import('shell/session')
  const api = await import('../lib/timeListsApi')
  const { default: TimeListsPage } = await import('./TimeListsPage')
  const { ApiError } = api
  vi.mocked(session.usePermissions).mockReturnValue({
    epoch: 1,
    apps: ['admin'],
    roles: [],
    departments: [],
    permissions: grantsManage ? [{ resource: 'time-list', action: 'manage', conditions: null }] : [],
  })
  return { TimeListsPage, api, ApiError }
}

describe('TimeListsPage in Italian', () => {
  it('names the page, its description and its loading state in Italian', async () => {
    const { TimeListsPage, api } = await setup(true)
    vi.mocked(api.listTimeLists).mockReturnValue(new Promise(() => {}))

    render(<TimeListsPage />)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Elenchi ore')
    expect(
      screen.getByText('Categorie e tipi di lavoro tra cui si sceglie quando si registrano le ore.'),
    ).not.toBeNull()
    expect(screen.getByText('Caricamento degli elenchi ore…')).not.toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Categorie',
      'Tipi di lavoro per progetto',
      'Tipi di lavoro per opportunità',
    ])
  })

  it('shows the authorization banner in Italian, with an Italian Retry', async () => {
    const { TimeListsPage, api, ApiError } = await setup(true)
    vi.mocked(api.listTimeLists).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        code: 'authz_unavailable',
        detail: 'auth did not answer',
      }),
    )

    render(<TimeListsPage />)

    expect((await screen.findByTestId('error-banner-title')).textContent).toBe(
      'Servizio di autorizzazione non disponibile',
    )
    const banner = screen.getByTestId('error-banner')
    expect(banner.textContent).toContain('Non è stato possibile verificare i permessi.')
    expect(banner.textContent).not.toContain('auth did not answer')
    expect(screen.getByTestId('error-banner-retry').textContent).toBe('Riprova')
  })

  it('shows the load failure and the permission denial in Italian', async () => {
    const failing = await setup(true)
    vi.mocked(failing.api.listTimeLists).mockRejectedValue(new TypeError('Failed to fetch'))
    render(<failing.TimeListsPage />)
    expect((await screen.findByTestId('error-banner')).textContent).toContain('Impossibile caricare gli elenchi ore.')
    cleanup()

    const denied = await setup(false)
    render(<denied.TimeListsPage />)
    const alert = await screen.findByTestId('permission-denied')
    expect(screen.getByTestId('permission-denied-heading').textContent).toBe('Non si possono gestire gli elenchi ore')
    expect(alert.textContent).toContain(
      'Gestire categorie e tipi di lavoro richiede un permesso che il proprio ruolo non ha.',
    )
  })
})

// ---------------------------------------------------------------------------
// The cards (T32): every word around the names is Italian; the names are the admin's, as typed
// ---------------------------------------------------------------------------

describe('the cards in Italian', () => {
  /**
   * An Italian name, an English name, an accent-and-case name and a retired one: AC-3.8 says each is
   * shown exactly as typed, whatever the language around it.
   */
  const lists = () => ({
    categories: [
      { id: 'c-1', name: 'Formazione', requiresNote: false, retired: false },
      { id: 'c-2', name: 'Training', requiresNote: false, retired: false },
      { id: 'c-3', name: 'Altro — è già ÀÈ', requiresNote: true, retired: false },
      { id: 'c-4', name: 'Seminars', requiresNote: false, retired: true },
    ],
    workTypes: {
      project: [{ id: 'wp-1', list: 'project' as const, name: 'Development', retired: false }],
      deal: [],
    },
  })

  const loaded = async () => {
    const ctx = await setup(true)
    vi.mocked(ctx.api.listTimeLists).mockResolvedValue(lists())
    render(<ctx.TimeListsPage />)
    await screen.findByTestId('time-lists-loaded')
    return ctx
  }

  it('shows the column headers, statuses, buttons and notes in Italian, and the names as typed', async () => {
    await loaded()

    const table = within(screen.getByTestId('time-lists-card-categories')).getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Nome', 'Richiede una nota', 'Stato', 'Azioni'])
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Formazione', 'Training', 'Altro — è già ÀÈ', 'Seminars'])
    const badges = within(table)
      .getAllByTestId('time-list-status-badge')
      .map((b) => b.textContent)
    expect(badges).toEqual(['Attivo', 'Attivo', 'Attivo', 'Ritirato'])
    expect(within(screen.getByTestId('time-lists-row-categories-c-3')).getAllByRole('cell')[0].textContent).toBe('Sì')
    expect(within(screen.getByTestId('time-lists-row-categories-c-1')).getAllByRole('cell')[0].textContent).toBe('No')
    expect(screen.getByRole('button', { name: 'Rinomina Formazione' }).textContent).toBe('Rinomina')
    expect(screen.getByRole('button', { name: 'Ritira Training' }).textContent).toBe('Ritira')
    expect(screen.getByRole('button', { name: 'Ripristina Seminars' }).textContent).toBe('Ripristina')
    expect(screen.getByTestId('time-lists-add-categories').textContent).toBe('Aggiungi categoria')
    expect(screen.getByTestId('time-lists-add-project').textContent).toBe('Aggiungi tipo di lavoro')
    expect(screen.getByText(/Le registrazioni conservano la loro categoria/)).not.toBeNull()
  })

  it('has no English left on the cards, and no Delete in Italian either', async () => {
    await loaded()

    const text = screen.getByTestId('time-lists-loaded').textContent ?? ''
    for (const english of ['Retire', 'Restore', 'Rename', 'Active', 'Status', 'Actions', 'Add category']) {
      expect(text).not.toContain(english)
    }
    for (const button of screen.getAllByRole('button')) {
      expect(`${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`).not.toMatch(
        /elimin|rimuov|cancella|delete|remove/i,
      )
    }
  })

  it('shows an empty list in Italian', async () => {
    await loaded()

    const empty = screen.getByTestId('time-lists-empty-deal')
    expect(within(empty).getByRole('heading', { level: 4 }).textContent).toBe('Ancora nessun tipo di lavoro')
    expect(empty.textContent).toContain('Le ore si possono registrare anche senza.')
  })

  it('says what a Retire did in Italian, with the name untouched, in the noun’s gender', async () => {
    const ctx = await loaded()
    vi.mocked(ctx.api.updateCategory).mockResolvedValue({
      id: 'c-2',
      name: 'Training',
      requiresNote: false,
      retired: true,
    })
    vi.mocked(ctx.api.updateWorkType).mockResolvedValue({
      id: 'wp-1',
      list: 'project',
      name: 'Development',
      retired: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ritira Training' }))

    expect((await screen.findByTestId('time-lists-notice')).textContent).toBe(
      '“Training” ritirata. Le registrazioni che la hanno la conservano. Si può ripristinare da questo elenco.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ritira Development' }))

    await waitFor(() =>
      expect(screen.getByTestId('time-lists-notice').textContent).toBe(
        '“Development” ritirato. Le registrazioni che lo hanno lo conservano. Si può ripristinare da questo elenco.',
      ),
    )
    expect(screen.getByRole('button', { name: 'Ripristina Training' })).not.toBeNull()
  })

  it('says a failed Retire in Italian, with Italian Retry and Dismiss', async () => {
    const ctx = await loaded()
    vi.mocked(ctx.api.updateCategory).mockRejectedValue(
      new ctx.ApiError({ type: 'about:blank', title: 'Boom', status: 500, detail: 'server detail' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ritira Training' }))

    const banner = await screen.findByTestId('error-banner')
    expect(banner.textContent).toContain('Qualcosa è andato storto. Non è stato modificato nulla.')
    expect(screen.getByTestId('error-banner-retry').textContent).toBe('Riprova')
    expect(screen.getByTestId('error-banner-dismiss').getAttribute('aria-label')).toBe('Chiudi')
    expect(banner.textContent).not.toContain('server detail')
  })

  it('opens the Add dialog in Italian: title, hint, checkbox, buttons and the Name check', async () => {
    await loaded()
    fireEvent.click(screen.getByTestId('time-lists-add-categories'))

    const dialog = screen.getByRole('dialog', { name: 'Aggiungi categoria' })
    expect(within(dialog).getByText('Mostrato esattamente come lo si scrive, in inglese e in italiano.')).not.toBeNull()
    expect(
      within(dialog).getByRole('checkbox', { name: 'Le registrazioni di questa categoria richiedono una nota' }),
    ).not.toBeNull()
    expect(within(dialog).getByTestId('time-lists-dialog-submit').textContent).toBe('Aggiungi')
    expect(within(dialog).getByTestId('time-lists-dialog-cancel').textContent).toBe('Annulla')

    fireEvent.click(within(dialog).getByTestId('time-lists-dialog-submit'))
    expect(within(dialog).getByTestId('time-lists-dialog-name-error').textContent).toBe('Il nome è obbligatorio.')

    fireEvent.change(within(dialog).getByTestId('time-lists-dialog-name'), { target: { value: 'a'.repeat(81) } })
    fireEvent.click(within(dialog).getByTestId('time-lists-dialog-submit'))
    expect(within(dialog).getByTestId('time-lists-dialog-name-error').textContent).toBe(
      'Usare al massimo 80 caratteri.',
    )
  })

  it('opens the work-type and rename dialogs with Italian titles', async () => {
    await loaded()

    fireEvent.click(screen.getByTestId('time-lists-add-project'))
    expect(screen.getByRole('dialog', { name: 'Aggiungi tipo di lavoro per progetto' })).not.toBeNull()
    fireEvent.click(screen.getByTestId('time-lists-dialog-cancel'))

    fireEvent.click(screen.getByRole('button', { name: 'Rinomina Formazione' }))
    const dialog = screen.getByRole('dialog', { name: 'Rinomina categoria' })
    expect((within(dialog).getByTestId('time-lists-dialog-name') as HTMLInputElement).value).toBe('Formazione')
    expect(within(dialog).getByTestId('time-lists-dialog-submit').textContent).toBe('Salva')
  })

  it('says a duplicate name, an addition and a rename in Italian', async () => {
    const ctx = await loaded()
    vi.mocked(ctx.api.createCategory).mockRejectedValueOnce(
      new ctx.ApiError({ type: 'about:blank', title: 'Conflict', status: 409, code: 'name_taken' }),
    )
    vi.mocked(ctx.api.createCategory).mockResolvedValueOnce({
      id: 'c-9',
      name: 'Workshop',
      requiresNote: false,
      retired: false,
    })
    fireEvent.click(screen.getByTestId('time-lists-add-categories'))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('time-lists-dialog-name'), { target: { value: 'Training' } })
    fireEvent.click(within(dialog).getByTestId('time-lists-dialog-submit'))

    expect((await within(dialog).findByTestId('time-lists-dialog-name-error')).textContent).toBe(
      'Esiste già una categoria con questo nome. Potrebbe essere ritirata.',
    )

    fireEvent.change(within(dialog).getByTestId('time-lists-dialog-name'), { target: { value: 'Workshop' } })
    fireEvent.click(within(dialog).getByTestId('time-lists-dialog-submit'))

    expect((await screen.findByTestId('time-lists-notice')).textContent).toBe('Categoria “Workshop” aggiunta.')
    expect(screen.getByRole('button', { name: 'Rinomina Workshop' })).not.toBeNull()
  })
})
