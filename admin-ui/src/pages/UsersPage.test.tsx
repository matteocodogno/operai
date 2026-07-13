/**
 * @vitest-environment jsdom
 *
 * Component tests for UsersPage — Screen C1 (T20, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) Loading: adminApi.listUsers is pending → SkeletonListRows is visible.
 *   (B) Loaded/populated: renders the table (Name/Email/Entity/Job
 *       title/Roles/Departments) with each user's row, name as a link to
 *       `/users/$id`.
 *   (C) Empty: listUsers resolves a zero-total page → "No users match your
 *       search." (design.md's search-scoped empty state), no table, no
 *       skeleton.
 *   (D) Error: listUsers rejects (ApiError) → ErrorBanner renders the RFC
 *       7807 detail + a Retry button that re-fetches.
 *   (E) Search: typing into the search input re-calls listUsers with `q` set
 *       and resets to page 1.
 *   (F) Pagination: Pagination renders with the right total and clicking
 *       Next re-calls listUsers with page 2.
 *
 * Strategy mirrors ../pages/AuditPage.test.tsx: `../lib/adminApi` mocked at
 * module level, keeping the real `ApiError` class via `importOriginal`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import UsersPage from './UsersPage'
import type { Paginated, UserSummary } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Module mock — must be declared before importing the mocked module.
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    listUsers: vi.fn(),
  }
})

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
    expect(headerTexts).toEqual(['Name', 'Email', 'Entity', 'Job title', 'Roles', 'Departments'])

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
})
