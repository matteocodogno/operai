/**
 * @vitest-environment jsdom
 *
 * Component tests for UsersPage — Screen C1 (T20, specs/004-auth-roles-permissions)
 * + Screen U1's row soft-delete extension (T10, specs/006-user-invitations).
 *
 * Covers:
 *   (A) Loading: adminApi.listUsers is pending → SkeletonListRows is visible.
 *   (B) Loaded/populated: renders the table (Name/Email/Entity/Job
 *       title/Roles/Departments/Actions) with each user's row, name as a link
 *       to `/users/$id`.
 *   (C) Empty: listUsers resolves a zero-total page → "No users match your
 *       search." (design.md's search-scoped empty state), no table, no
 *       skeleton.
 *   (D) Error: listUsers rejects (ApiError) → ErrorBanner renders the RFC
 *       7807 detail + a Retry button that re-fetches.
 *   (E) Search: typing into the search input re-calls listUsers with `q` set
 *       and resets to page 1.
 *   (F) Pagination: Pagination renders with the right total and clicking
 *       Next re-calls listUsers with page 2.
 *   (G) Row delete (T10): Delete → ConfirmDeleteModal → confirm →
 *       adminApi.deleteUser called → list re-fetches (row vanishes, AC-5.3).
 *   (H) Self-row disabled (T10, AC-5.6): the row matching the current
 *       session's user id renders Delete as aria-disabled + titled +
 *       explained, and clicking it never opens the confirm modal.
 *   (I) 422 (last-admin guard, AC-5.5) → GuardrailDialog, not an inline
 *       dialog error.
 *
 * Strategy mirrors ../pages/AuditPage.test.tsx: `../lib/adminApi` mocked at
 * module level, keeping the real `ApiError` class via `importOriginal`.
 * `shell/session`'s `useSession` is mocked per-test (defaults to no user via
 * vitest.config.ts's stub alias) to control which row is "self".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import UsersPage from './UsersPage'
import type { Paginated, UserSummary } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the mocked modules.
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    listUsers: vi.fn(),
    deleteUser: vi.fn(),
  }
})

const useSessionMock = vi.fn(() => ({ data: null as { user?: { id?: string } } | null }))
vi.mock('shell/session', () => ({
  useSession: () => useSessionMock(),
}))

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Test router harness — UsersPage renders a <Link to="/users/$id">, which
// requires a real router context to resolve `to`. A minimal two-route tree
// (this page + a stub detail route) is enough; navigation itself isn't
// asserted here (row → detail navigation is exercised via UserDetail's own
// tests / e2e).
// ---------------------------------------------------------------------------

function renderUsersPage() {
  window.history.pushState(null, '', '/users')
  const rootRoute = createRootRoute()
  const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/users', component: UsersPage })
  const userDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users/$id',
    component: () => null,
  })
  const routeTree = rootRoute.addChildren([usersRoute, userDetailRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const userA: UserSummary = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@welld.ch',
  entity: 'welld_ch',
  jobTitle: 'Backend Dev',
  roleCount: 2,
  departmentCount: 1,
}

const userB: UserSummary = {
  id: 'user-2',
  name: null,
  email: 'bianca@welld.it',
  entity: 'welld_it',
  jobTitle: null,
  roleCount: 1,
  departmentCount: 0,
}

const pageOf = (items: UserSummary[], total = items.length): Paginated<UserSummary> => ({
  items,
  page: 1,
  pageSize: 20,
  total,
})

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  // Default: no session user — `vi.clearAllMocks()` (afterEach) clears calls
  // but not a prior test's `mockReturnValue`, so this re-pins the default
  // explicitly rather than relying on clear-order across tests.
  useSessionMock.mockReturnValue({ data: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
  window.history.pushState(null, '', '/')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UsersPage', () => {
  // (A) Loading
  it('renders SkeletonListRows while listUsers is in-flight', async () => {
    vi.mocked(adminApi.listUsers).mockReturnValue(pendingPromise())

    renderUsersPage()

    // The RouterProvider resolves its initial route match asynchronously
    // (even with no loader), so the first paint is empty — findByTestId
    // awaits that resolution before asserting the loading state.
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('users-table')).toBeNull()
  })

  // (B) Loaded / populated
  it('renders the users table with both users and a name link to the detail route', async () => {
    vi.mocked(adminApi.listUsers).mockResolvedValue(pageOf([userA, userB]))

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('users-table')).not.toBeNull()
    })

    const table = screen.getByTestId('users-table')
    const headerTexts = Array.from(table.querySelectorAll('th[scope="col"]')).map((th) => th.textContent?.trim())
    expect(headerTexts).toEqual(['Name', 'Email', 'Entity', 'Job title', 'Roles', 'Departments', 'Actions'])

    const rowLinkA = screen.getByTestId('user-row-user-1')
    expect(rowLinkA.tagName).toBe('A')
    expect(rowLinkA.textContent).toBe('Ada Lovelace')
    expect(rowLinkA.getAttribute('href')).toBe('/users/user-1')

    // Null name falls back to email as the link text.
    const rowLinkB = screen.getByTestId('user-row-user-2')
    expect(rowLinkB.textContent).toBe('bianca@welld.it')

    expect(screen.getByText('ada@welld.ch')).not.toBeNull()
    expect(screen.getByText('WellD CH')).not.toBeNull()
    expect(screen.getByText('WellD Italia')).not.toBeNull()
    expect(screen.getByText('Backend Dev')).not.toBeNull()

    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // (C) Empty
  it('renders "No users match your search." when the page is empty', async () => {
    vi.mocked(adminApi.listUsers).mockResolvedValue(pageOf([], 0))

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('users-empty-state')).not.toBeNull()
    })

    expect(screen.getByText('No users match your search.')).not.toBeNull()
    expect(screen.queryByTestId('users-table')).toBeNull()
  })

  // (D) Error
  it('renders an ErrorBanner with the RFC 7807 detail and retries on click', async () => {
    vi.mocked(adminApi.listUsers)
      .mockRejectedValueOnce(
        new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'You are not an administrator.' }),
      )
      .mockResolvedValueOnce(pageOf([userA]))

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    expect(screen.getByRole('alert').textContent).toContain('You are not an administrator.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('users-table')).not.toBeNull()
    })
    expect(adminApi.listUsers).toHaveBeenCalledTimes(2)
  })

  // (E) Search
  it('re-fetches with `q` set and resets to page 1 when the search input changes', async () => {
    vi.mocked(adminApi.listUsers)
      .mockResolvedValueOnce(pageOf([userA, userB], 45))
      .mockResolvedValueOnce(pageOf([userA], 45))
      .mockResolvedValueOnce(pageOf([userA], 1))

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('users-table')).not.toBeNull()
    })

    // Move to page 2 first, to prove a subsequent search resets to page 1.
    fireEvent.click(screen.getByTestId('pagination-next'))
    await waitFor(() => {
      expect(adminApi.listUsers).toHaveBeenLastCalledWith({ q: undefined, page: 2, pageSize: 20 })
    })

    fireEvent.change(screen.getByTestId('users-search-input'), { target: { value: 'ada' } })

    await waitFor(() => {
      expect(adminApi.listUsers).toHaveBeenLastCalledWith({ q: 'ada', page: 1, pageSize: 20 })
    })
  })

  // (F) Pagination
  it('renders Pagination reflecting the total and re-fetches page 2 on Next', async () => {
    vi.mocked(adminApi.listUsers)
      .mockResolvedValueOnce(pageOf([userA, userB], 45))
      .mockResolvedValueOnce(pageOf([userA], 45))

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('pagination')).not.toBeNull()
    })
    expect(screen.getByTestId('pagination-status').textContent).toBe('Page 1 of 3 — Showing 1–20 of 45')

    fireEvent.click(screen.getByTestId('pagination-next'))

    await waitFor(() => {
      expect(adminApi.listUsers).toHaveBeenLastCalledWith({ q: undefined, page: 2, pageSize: 20 })
    })
  })

  // (G) Row delete (T10, specs/006-user-invitations)
  it('Delete on a row opens ConfirmDeleteModal; confirming calls deleteUser and the list re-fetches (row vanishes, AC-5.3)', async () => {
    vi.mocked(adminApi.listUsers)
      .mockResolvedValueOnce(pageOf([userA, userB]))
      .mockResolvedValueOnce(pageOf([userB], 1))
    vi.mocked(adminApi.deleteUser).mockResolvedValue({ id: 'user-1', deletedAt: '2026-07-14T10:00:00.000Z' })

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('users-table')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('user-delete-user-1'))

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/Ada Lovelace/)).not.toBeNull()

    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => {
      expect(adminApi.deleteUser).toHaveBeenCalledWith('user-1')
    })
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    await waitFor(() => {
      expect(adminApi.listUsers).toHaveBeenCalledTimes(2)
    })
  })

  it('Cancel on the delete confirm closes it without calling deleteUser', async () => {
    vi.mocked(adminApi.listUsers).mockResolvedValue(pageOf([userA, userB]))

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('users-table')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('user-delete-user-1'))
    expect(screen.getByRole('alertdialog')).not.toBeNull()

    fireEvent.click(screen.getByTestId('confirm-delete-cancel'))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(adminApi.deleteUser).not.toHaveBeenCalled()
  })

  // (H) Self-row disabled (T10, AC-5.6)
  it('disables Delete on the row matching the current session user, with title + aria-disabled + sr-only explanation', async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: 'user-1' } } })
    vi.mocked(adminApi.listUsers).mockResolvedValue(pageOf([userA, userB]))

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('users-table')).not.toBeNull()
    })

    const selfDeleteButton = screen.getByTestId('user-delete-user-1')
    expect(selfDeleteButton.getAttribute('aria-disabled')).toBe('true')
    expect(selfDeleteButton.getAttribute('title')).toBe("You can't delete your own account")
    expect(selfDeleteButton.textContent).toContain("You can't delete your own account")

    fireEvent.click(selfDeleteButton)
    expect(screen.queryByRole('alertdialog')).toBeNull()

    // The other row's Delete stays enabled.
    const otherDeleteButton = screen.getByTestId('user-delete-user-2')
    expect(otherDeleteButton.getAttribute('aria-disabled')).toBe('false')
  })

  // (I) Guardrail (last-admin, AC-5.5)
  it('a 422 on deleteUser surfaces GuardrailDialog, not an inline dialog error', async () => {
    vi.mocked(adminApi.listUsers).mockResolvedValue(pageOf([userA, userB]))
    vi.mocked(adminApi.deleteUser).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'This is the last remaining administrator',
      }),
    )

    renderUsersPage()

    await waitFor(() => {
      expect(screen.getByTestId('users-table')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('user-delete-user-1'))
    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => {
      expect(screen.getByTestId('guardrail-dialog')).not.toBeNull()
    })
    expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
    expect(screen.getByText(/last administrator/)).not.toBeNull()
  })
})
