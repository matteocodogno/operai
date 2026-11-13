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
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../lib/timeListsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/timeListsApi')>()
  return { ...original, listTimeLists: vi.fn() }
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
