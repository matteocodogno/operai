/**
 * @vitest-environment jsdom
 *
 * Component tests for UserDetail — Screen C2 (T20, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) Loading: adminApi.getUser is pending → SkeletonListRows is visible.
 *   (B) Loaded/populated: renders identity (name/email, read-only), the
 *       entity select and jobTitle input seeded from the loaded user, and a
 *       checkbox per catalog role/department reflecting the user's current
 *       assignment.
 *   (C) Attribute edit: changing jobTitle + Save calls `patchUser` with the
 *       new value.
 *   (D) Role assignment: toggling a role checkbox + Save calls `putUserRoles`
 *       with the full resulting id set.
 *   (E) Department assignment: toggling a department checkbox + Save calls
 *       `putUserDepartments` with the full resulting id set.
 *   (F) The 422 → GuardrailDialog path (AC-6.4): `putUserRoles` rejects with
 *       a 422 ApiError → GuardrailDialog renders the exact last-admin
 *       message; dismissing it does NOT reset the pending checkbox
 *       selection — the admin's in-progress edit survives so they can adjust
 *       and retry.
 *   (G) Error: getUser rejects → ErrorBanner + Retry.
 *   (H) "Delete user" (design.md Screen U3, closed post-T10): opens the SAME
 *       `ConfirmDeleteModal` UsersPage.tsx's row action uses; confirming
 *       calls the SAME `adminApi.deleteUser` and navigates to `/users`
 *       (mirrors RoleEditor.test.tsx's delete-then-navigate coverage). The
 *       button is disabled-with-explanation on the acting admin's own page
 *       (same `useSession()` convention as Screen U1); a 422 (last-admin
 *       guard) surfaces via GuardrailDialog, not an inline dialog error.
 *   (I) Address section visibility (T12, specs/012-employee-address, AC-4.2):
 *       with `getMe().roles` lacking `admin`, `AddressSection` is ABSENT from
 *       the DOM (`queryByTestId('address-section')` is `null`) — not merely
 *       disabled, and no `GET /admin/users/:id/address` call is ever made for
 *       such a caller. With `roles: ['admin']` it renders. A failed
 *       `getMe()` call also hides it (fails closed, UX-only).
 *
 * Strategy mirrors ../pages/AuditPage.test.tsx: `../lib/adminApi` mocked at
 * module level, keeping the real `ApiError` class via `importOriginal`. A
 * minimal two-route TanStack Router tree provides the `/users/$id` route
 * context UserDetail's `getRouteApi('/users/$id')` needs, and lets (H)'s
 * navigation assertion be a real router transition (mirrors
 * ../pages/UsersPage.test.tsx's own harness) rather than a mocked
 * `useNavigate`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import UserDetail from './UserDetail'
import type { Department, Role, UserDetail as UserDetailData } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Module mock — must be declared before importing the mocked module.
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    getUser: vi.fn(),
    listRoles: vi.fn(),
    listDepartments: vi.fn(),
    patchUser: vi.fn(),
    putUserRoles: vi.fn(),
    putUserDepartments: vi.fn(),
    deleteUser: vi.fn(),
    getMe: vi.fn(),
  }
})

// AddressSection (T11) fetches its own data independently of everything
// above — mocked here purely so the (I) "visible" case doesn't issue a real
// network call; every other test in this file never renders the section at
// all (getMe defaults to no roles, see beforeEach) so these are unused there.
vi.mock('../lib/addressApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/addressApi')>()
  return {
    ...original,
    getAddress: vi.fn(),
    listAddressHistory: vi.fn(),
  }
})

const useSessionMock = vi.fn(() => ({ data: null as { user?: { id?: string } } | null }))
vi.mock('shell/session', () => ({
  useSession: () => useSessionMock(),
}))

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import * as addressApi from '../lib/addressApi'
import type { EffectivePermissions } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Test router harness
// ---------------------------------------------------------------------------

function renderUserDetail(id: string) {
  window.history.pushState(null, '', `/users/${id}`)
  const rootRoute = createRootRoute()
  const usersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users',
    component: () => <div data-testid="users-page-stub" />,
  })
  const userDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users/$id',
    component: UserDetail,
  })
  const routeTree = rootRoute.addChildren([usersRoute, userDetailRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roleEmployee: Role = {
  id: 'role-employee',
  name: 'employee',
  description: null,
  isSystem: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const roleAdmin: Role = {
  id: 'role-admin',
  name: 'admin',
  description: null,
  isSystem: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const deptEngineering: Department = {
  id: 'dept-engineering',
  name: 'Engineering',
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const userAda: UserDetailData = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@welld.ch',
  entity: 'welld_ch',
  jobTitle: 'Backend Dev',
  roles: [{ id: 'role-employee', name: 'employee' }],
  departments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

const setupLoaded = () => {
  vi.mocked(adminApi.getUser).mockResolvedValue(userAda)
  vi.mocked(adminApi.listRoles).mockResolvedValue([roleEmployee, roleAdmin])
  vi.mocked(adminApi.listDepartments).mockResolvedValue([deptEngineering])
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const noAdminPermissions: EffectivePermissions = { epoch: 0, apps: [], roles: [], departments: [], permissions: [] }

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  // Default: no session user — re-pinned explicitly each test, same rationale
  // as ../pages/UsersPage.test.tsx's identical beforeEach comment.
  useSessionMock.mockReturnValue({ data: null })
  // Default: AddressSection stays hidden (AC-4.2) — every test besides the
  // dedicated "address section visibility" describe block below re-pins this
  // explicitly only when it needs the section visible.
  vi.mocked(adminApi.getMe).mockResolvedValue(noAdminPermissions)
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

describe('UserDetail', () => {
  // (A) Loading
  it('renders SkeletonListRows while getUser is in-flight', async () => {
    vi.mocked(adminApi.getUser).mockReturnValue(pendingPromise())
    vi.mocked(adminApi.listRoles).mockReturnValue(pendingPromise())
    vi.mocked(adminApi.listDepartments).mockReturnValue(pendingPromise())

    renderUserDetail('user-1')

    // The RouterProvider resolves its initial route match asynchronously
    // (even with no loader), so the first paint is empty — findByTestId
    // awaits that resolution before asserting the loading state.
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.queryByTestId('user-detail-name')).toBeNull()
  })

  // (B) Loaded / populated
  it('renders identity, seeded attributes, and role/department checkboxes reflecting current assignment', async () => {
    setupLoaded()

    renderUserDetail('user-1')

    await waitFor(() => {
      expect(screen.getByTestId('user-detail-name')).not.toBeNull()
    })

    expect(screen.getByTestId('user-detail-name').textContent).toBe('Ada Lovelace')
    expect(screen.getByTestId('user-detail-email').textContent).toBe('ada@welld.ch')

    expect((screen.getByTestId('entity-select') as HTMLSelectElement).value).toBe('welld_ch')
    expect((screen.getByTestId('jobtitle-input') as HTMLInputElement).value).toBe('Backend Dev')

    expect((screen.getByTestId('role-checkbox-role-employee') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('role-checkbox-role-admin') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('department-checkbox-dept-engineering') as HTMLInputElement).checked).toBe(false)

    expect(adminApi.getUser).toHaveBeenCalledWith('user-1')
  })

  // (C) Attribute edit
  it('saves entity/jobTitle via patchUser on "Save attributes"', async () => {
    setupLoaded()
    vi.mocked(adminApi.patchUser).mockResolvedValue({ ...userAda, jobTitle: 'Staff Engineer' })

    renderUserDetail('user-1')

    await waitFor(() => {
      expect(screen.getByTestId('jobtitle-input')).not.toBeNull()
    })

    fireEvent.change(screen.getByTestId('jobtitle-input'), { target: { value: 'Staff Engineer' } })
    fireEvent.click(screen.getByTestId('save-attributes-button'))

    await waitFor(() => {
      expect(adminApi.patchUser).toHaveBeenCalledWith('user-1', { entity: 'welld_ch', jobTitle: 'Staff Engineer' })
    })
    expect(screen.queryByTestId('attributes-error')).toBeNull()
  })

  // (D) Role assignment
  it('saves the full selected role id set via putUserRoles on "Save roles"', async () => {
    setupLoaded()
    vi.mocked(adminApi.putUserRoles).mockResolvedValue({
      ...userAda,
      roles: [
        { id: 'role-employee', name: 'employee' },
        { id: 'role-admin', name: 'admin' },
      ],
    })

    renderUserDetail('user-1')

    await waitFor(() => {
      expect(screen.getByTestId('role-checkbox-role-admin')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('role-checkbox-role-admin'))
    fireEvent.click(screen.getByTestId('save-roles-button'))

    await waitFor(() => {
      expect(adminApi.putUserRoles).toHaveBeenCalledTimes(1)
    })
    const [calledId, calledRoleIds] = vi.mocked(adminApi.putUserRoles).mock.calls[0]
    expect(calledId).toBe('user-1')
    expect(new Set(calledRoleIds)).toEqual(new Set(['role-employee', 'role-admin']))
    expect(screen.queryByTestId('roles-error')).toBeNull()
    expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
  })

  // (E) Department assignment
  it('saves the full selected department id set via putUserDepartments on "Save departments"', async () => {
    setupLoaded()
    vi.mocked(adminApi.putUserDepartments).mockResolvedValue({
      ...userAda,
      departments: [{ id: 'dept-engineering', name: 'Engineering' }],
    })

    renderUserDetail('user-1')

    await waitFor(() => {
      expect(screen.getByTestId('department-checkbox-dept-engineering')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('department-checkbox-dept-engineering'))
    fireEvent.click(screen.getByTestId('save-departments-button'))

    await waitFor(() => {
      expect(adminApi.putUserDepartments).toHaveBeenCalledWith('user-1', ['dept-engineering'])
    })
    expect(screen.queryByTestId('departments-error')).toBeNull()
  })

  // (F) 422 → GuardrailDialog, preserving the pending edit (AC-6.4)
  it('shows GuardrailDialog on a 422 last-admin guard and preserves the pending role selection', async () => {
    setupLoaded()
    vi.mocked(adminApi.putUserRoles).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Cannot remove the last administrator.',
      }),
    )

    renderUserDetail('user-1')

    await waitFor(() => {
      expect(screen.getByTestId('role-checkbox-role-employee')).not.toBeNull()
    })

    // Admin unchecks the only role this user has (removing their last admin path).
    fireEvent.click(screen.getByTestId('role-checkbox-role-employee'))
    expect((screen.getByTestId('role-checkbox-role-employee') as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByTestId('save-roles-button'))

    await waitFor(() => {
      expect(screen.getByTestId('guardrail-dialog')).not.toBeNull()
    })
    expect(screen.getByTestId('guardrail-dialog').textContent).toContain(
      'This is the last administrator — removing this role would leave nobody able to manage access. Assign another admin first.',
    )

    // Acknowledge the dialog.
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))

    expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
    // The pending edit (unchecked) survives the dismissed dialog — NOT reset
    // back to the server's last-known state (design.md F4).
    expect((screen.getByTestId('role-checkbox-role-employee') as HTMLInputElement).checked).toBe(false)

    // The admin can immediately retry (e.g. after fixing the edit elsewhere).
    fireEvent.click(screen.getByTestId('save-roles-button'))
    await waitFor(() => {
      expect(adminApi.putUserRoles).toHaveBeenCalledTimes(2)
    })
  })

  // (G) Error
  it('renders an ErrorBanner with the RFC 7807 detail and retries on click', async () => {
    vi.mocked(adminApi.getUser).mockRejectedValueOnce(
      new ApiError({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such user.' }),
    )
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEmployee, roleAdmin])
    vi.mocked(adminApi.listDepartments).mockResolvedValue([deptEngineering])

    renderUserDetail('user-1')

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    expect(screen.getByRole('alert').textContent).toContain('No such user.')

    vi.mocked(adminApi.getUser).mockResolvedValueOnce(userAda)
    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('user-detail-name')).not.toBeNull()
    })
  })

  // (H) "Delete user" (design.md Screen U3, closed post-T10, specs/006-user-invitations)
  describe('delete user', () => {
    it('Delete user opens ConfirmDeleteModal; confirming calls deleteUser and navigates to /users', async () => {
      setupLoaded()
      vi.mocked(adminApi.deleteUser).mockResolvedValue({ id: 'user-1', deletedAt: '2026-07-14T10:00:00.000Z' })

      renderUserDetail('user-1')

      await waitFor(() => {
        expect(screen.getByTestId('user-detail-delete-button')).not.toBeNull()
      })

      fireEvent.click(screen.getByTestId('user-detail-delete-button'))

      const dialog = screen.getByRole('alertdialog')
      expect(dialog.textContent).toContain('Ada Lovelace')

      fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

      await waitFor(() => {
        expect(adminApi.deleteUser).toHaveBeenCalledWith('user-1')
      })
      await waitFor(() => {
        expect(screen.getByTestId('users-page-stub')).not.toBeNull()
      })
    })

    it('Cancel closes the delete confirm without calling deleteUser', async () => {
      setupLoaded()

      renderUserDetail('user-1')

      await waitFor(() => {
        expect(screen.getByTestId('user-detail-delete-button')).not.toBeNull()
      })

      fireEvent.click(screen.getByTestId('user-detail-delete-button'))
      expect(screen.getByRole('alertdialog')).not.toBeNull()

      fireEvent.click(screen.getByTestId('confirm-delete-cancel'))

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(adminApi.deleteUser).not.toHaveBeenCalled()
    })

    it("disables Delete on the caller's own detail page, with title + aria-disabled + sr-only explanation", async () => {
      useSessionMock.mockReturnValue({ data: { user: { id: 'user-1' } } })
      setupLoaded()

      renderUserDetail('user-1')

      await waitFor(() => {
        expect(screen.getByTestId('user-detail-delete-button')).not.toBeNull()
      })

      const deleteButton = screen.getByTestId('user-detail-delete-button')
      expect(deleteButton.getAttribute('aria-disabled')).toBe('true')
      expect(deleteButton.getAttribute('title')).toBe("You can't delete your own account")
      expect(deleteButton.textContent).toContain("You can't delete your own account")

      fireEvent.click(deleteButton)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(adminApi.deleteUser).not.toHaveBeenCalled()
    })

    it('a 422 on deleteUser surfaces GuardrailDialog, not an inline dialog error', async () => {
      setupLoaded()
      vi.mocked(adminApi.deleteUser).mockRejectedValue(
        new ApiError({
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'This is the last remaining administrator',
        }),
      )

      renderUserDetail('user-1')

      await waitFor(() => {
        expect(screen.getByTestId('user-detail-delete-button')).not.toBeNull()
      })

      fireEvent.click(screen.getByTestId('user-detail-delete-button'))
      fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

      await waitFor(() => {
        expect(screen.getByTestId('guardrail-dialog')).not.toBeNull()
      })
      expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
      expect(screen.getByText(/last administrator/)).not.toBeNull()
    })
  })

  // (I) Address section visibility — T12, specs/012-employee-address, AC-4.2
  describe('address section visibility (AC-4.2)', () => {
    it('is absent from the DOM when getMe().roles lacks "admin" — not merely disabled', async () => {
      setupLoaded()
      vi.mocked(adminApi.getMe).mockResolvedValue(noAdminPermissions)

      renderUserDetail('user-1')

      await waitFor(() => {
        expect(screen.getByTestId('user-detail-name')).not.toBeNull()
      })
      // Give the independent getMe() effect a tick to resolve.
      await waitFor(() => expect(adminApi.getMe).toHaveBeenCalled())

      expect(screen.queryByTestId('address-section')).toBeNull()
      expect(addressApi.getAddress).not.toHaveBeenCalled()
    })

    it('renders when getMe().roles includes "admin"', async () => {
      setupLoaded()
      vi.mocked(adminApi.getMe).mockResolvedValue({
        epoch: 1,
        apps: ['admin'],
        roles: ['admin'],
        departments: [],
        permissions: [],
      })
      vi.mocked(addressApi.getAddress).mockResolvedValue({ userId: 'user-1', address: null })
      vi.mocked(addressApi.listAddressHistory).mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 })

      renderUserDetail('user-1')

      await waitFor(() => {
        expect(screen.getByTestId('user-detail-name')).not.toBeNull()
      })

      expect(await screen.findByTestId('address-section')).not.toBeNull()
      await waitFor(() => expect(addressApi.getAddress).toHaveBeenCalledWith('user-1'))
    })

    it('fails closed (hidden, not a crash) when getMe() itself rejects', async () => {
      setupLoaded()
      vi.mocked(adminApi.getMe).mockRejectedValue(new Error('network error'))

      renderUserDetail('user-1')

      await waitFor(() => {
        expect(screen.getByTestId('user-detail-name')).not.toBeNull()
      })
      await waitFor(() => expect(adminApi.getMe).toHaveBeenCalled())

      expect(screen.queryByTestId('address-section')).toBeNull()
    })
  })
})
