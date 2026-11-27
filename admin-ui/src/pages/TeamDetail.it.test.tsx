/**
 * @vitest-environment jsdom
 *
 * TeamDetail in Italian (specs/20261126-teams T5; AC-3.3): the page, its dialogs and the refusals come from the Italian
 * catalog, and a date is dd.mm.yyyy in both languages. The language is the one the shell sets on `<html lang>`, read when
 * the catalog module loads, hence the late imports (as `ProtectedChange.it.test.tsx`).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return { ...original, getTeam: vi.fn(), patchTeam: vi.fn(), addTeamMember: vi.fn(), listUsers: vi.fn() }
})

beforeAll(() => {
  document.documentElement.setAttribute('lang', 'it')
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  window.history.pushState(null, '', '/')
})

const team = {
  id: 't1',
  name: 'Backend',
  description: null,
  archived: true,
  activeMemberCount: 1,
  version: 2,
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-02T12:00:00.000Z',
  members: [
    { id: 'u1', name: 'Ada Rossi', email: 'ada@example.com', deactivated: false, addedAt: '2026-11-03T12:00:00.000Z' },
    { id: 'u2', name: 'Gina Gone', email: 'gina@example.com', deactivated: true, addedAt: '2026-11-04T12:00:00.000Z' },
  ],
}

const renderIt = async () => {
  const { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = await import('@tanstack/react-router')
  const { default: TeamDetail } = await import('./TeamDetail')
  const adminApi = await import('../lib/adminApi')
  vi.mocked(adminApi.getTeam).mockResolvedValue(team)
  window.history.pushState(null, '', '/teams/t1')
  const rootRoute = createRootRoute({ component: Outlet })
  const list = createRoute({ getParentRoute: () => rootRoute, path: '/teams', component: () => null })
  const detail = createRoute({ getParentRoute: () => rootRoute, path: '/teams/$id', component: TeamDetail })
  render(<RouterProvider router={createRouter({ routeTree: rootRoute.addChildren([list, detail]) })} />)
  await screen.findByTestId('team-members-section')
  return adminApi
}

describe('TeamDetail in Italian', () => {
  it('shows the page, the members and the dd.mm.yyyy dates in Italian', async () => {
    await renderIt()
    expect(screen.getByTestId('team-detail-back-link').textContent).toContain('Torna ai team')
    expect(screen.getByTestId('team-status').textContent).toContain('Archiviato')
    expect(screen.getByTestId('team-archived-note').textContent).toContain('Questo team è archiviato.')
    expect(screen.getByTestId('team-restore').textContent).toBe('Ripristina team')
    expect(screen.getByTestId('team-members-count').textContent).toBe('2 membri su 100 · 1 disattivato')
    expect(within(screen.getByTestId('team-details-section')).getByText('Nessuna descrizione')).toBeTruthy()
    const row = screen.getByTestId('team-member-u1')
    expect(within(row).getByText('03.11.2026')).toBeTruthy()
    expect(screen.getByTestId('team-member-deactivated-u2').textContent).toContain('Disattivato')
    expect(screen.getByTestId('team-member-remove-u1').getAttribute('aria-label')).toBe(
      'Rimuovi Ada Rossi da questo team',
    )
  })

  it('says the refusals in Italian: stale edit, not an active user', async () => {
    const adminApi = await renderIt()
    const { ApiError } = adminApi
    vi.mocked(adminApi.patchTeam).mockRejectedValue(
      new ApiError({ type: 'x', title: 'Conflict', status: 409, code: 'version_conflict' }),
    )
    fireEvent.click(screen.getByTestId('team-edit-details'))
    fireEvent.change(screen.getByTestId('edit-team-name-input'), { target: { value: 'Core' } })
    fireEvent.click(screen.getByTestId('edit-team-submit'))
    expect((await screen.findByTestId('edit-team-error')).textContent).toContain(
      'Qualcun altro ha modificato questo team',
    )
    fireEvent.click(screen.getByTestId('edit-team-cancel'))
    expect(screen.getByTestId('team-stale-banner').textContent).toContain('Questo team è cambiato')

    vi.mocked(adminApi.listUsers).mockResolvedValue({
      items: [
        {
          id: 'u3',
          name: 'Carla Verdi',
          email: 'c@example.com',
          entity: null,
          jobTitle: null,
          roles: [],
          departments: [],
        },
      ],
      page: 1,
      pageSize: 10,
      total: 1,
    })
    vi.mocked(adminApi.addTeamMember).mockRejectedValue(
      new ApiError({ type: 'x', title: 'U', status: 422, code: 'user_not_active' }),
    )
    fireEvent.change(screen.getByTestId('team-member-picker-input'), { target: { value: 'car' } })
    fireEvent.click(await screen.findByTestId('team-member-picker-input-option-u3'))
    fireEvent.click(screen.getByTestId('team-member-add'))
    await waitFor(() =>
      expect(screen.getByTestId('team-members-error').textContent).toBe(
        'Questa persona non è un utente attivo e non può essere aggiunta.',
      ),
    )
  })
})
