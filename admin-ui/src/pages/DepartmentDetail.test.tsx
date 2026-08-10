/**
 * @vitest-environment jsdom
 *
 * Component tests for DepartmentDetail — Screen B2 (T19, specs/004-auth-roles-permissions).
 *
 * Uses a real, minimal TanStack Router harness (mirrors
 * SectionNav.test.tsx's technique) rather than mocking `getRouteApi`/`Link`:
 * this page reads its `id` param via `getRouteApi('/departments/$id').useParams()`
 * and renders a real `<Link to="/departments">`, both of which need an actual
 * route tree with matching route ids to resolve correctly.
 *
 * Covers:
 *   (A) Loading: adminApi.getDepartment pending → SkeletonListRows.
 *   (B) Loaded: heading + name/description inputs prefilled; roles checkboxes
 *       reflect `roleIds`; members list rendered.
 *   (C) Error: getDepartment rejects → ErrorBanner + Retry re-fetches.
 *   (D) Save details: edits name, saves → patchDepartment called with the
 *       trimmed values; a 409 renders an inline error.
 *   (E) Roles conferred: toggling a checkbox and saving calls
 *       putDepartmentRoles with the updated id set; a 422 shows the inline
 *       banner and re-fetches the roles catalog (listRoles called again).
 *   (F) Members: removing a member calls putDepartmentMembers with the
 *       remaining ids; an empty member list shows "No members yet.".
 *   (G) Add member (user-search picker): opens on "+ Add member", searches
 *       via listUsers({q, pageSize}), and adding a result calls
 *       putDepartmentMembers with the existing+new id set and closes the
 *       picker. Empty search results and search errors render inline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import DepartmentDetail from './DepartmentDetail'
import type { DepartmentDetail as DepartmentDetailData, Role, UserSummary } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Module mock — must be declared before importing the mocked module.
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    getDepartment: vi.fn(),
    patchDepartment: vi.fn(),
    putDepartmentRoles: vi.fn(),
    putDepartmentMembers: vi.fn(),
    listRoles: vi.fn(),
    listUsers: vi.fn(),
  }
})

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const memberAda = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' }

const deptDetail: DepartmentDetailData = {
  id: 'dept-eng',
  name: 'Engineering',
  description: 'Builds the product',
  createdAt: '2026-07-01T09:00:00.000Z',
  updatedAt: '2026-07-01T09:00:00.000Z',
  roleIds: ['role-engineer'],
  members: [memberAda],
}

const roleEngineer: Role = {
  id: 'role-engineer',
  name: 'Engineer',
  description: null,
  isSystem: false,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}

const roleManager: Role = {
  id: 'role-manager',
  name: 'Manager',
  description: null,
  isSystem: false,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}

const userGrace: UserSummary = {
  id: 'user-grace',
  name: 'Grace Hopper',
  email: 'grace@example.com',
  entity: null,
  jobTitle: null,
  roleCount: 0,
  departmentCount: 0,
}

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

/** Builds a minimal router with the two real routes DepartmentDetail depends on. */
async function renderAt(id: string) {
  window.history.pushState(null, '', `/departments/${id}`)

  const rootRoute = createRootRoute()
  const departmentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/departments',
    component: () => <p>departments list</p>,
  })
  const departmentDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/departments/$id',
    component: DepartmentDetail,
  })
  const routeTree = rootRoute.addChildren([departmentsRoute, departmentDetailRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  return utils
}

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('DepartmentDetail — load states', () => {
  it('renders SkeletonListRows while getDepartment is in-flight', async () => {
    vi.mocked(adminApi.getDepartment).mockReturnValue(pendingPromise())
    vi.mocked(adminApi.listRoles).mockReturnValue(pendingPromise())

    await renderAt('dept-eng')

    await waitFor(() => {
      expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    })
  })

  it('renders the loaded department: heading, prefilled fields, roles, and members', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer, roleManager])

    await renderAt('dept-eng')

    await waitFor(() => {
      expect(screen.getByTestId('department-details-section')).not.toBeNull()
    })

    expect(screen.getByText('Engineering', { selector: 'h2' })).not.toBeNull()
    expect((screen.getByTestId('department-name-input') as HTMLInputElement).value).toBe('Engineering')
    expect((screen.getByTestId('department-description-input') as HTMLTextAreaElement).value).toBe('Builds the product')

    await waitFor(() => {
      expect(screen.getByTestId('department-roles-list')).not.toBeNull()
    })
    expect((screen.getByTestId('role-checkbox-role-engineer') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('role-checkbox-role-manager') as HTMLInputElement).checked).toBe(false)

    expect(screen.getByTestId('department-member-user-ada')).not.toBeNull()
    expect(screen.getByText(/Ada Lovelace/)).not.toBeNull()
  })

  it('renders an ErrorBanner and retries on click', async () => {
    vi.mocked(adminApi.getDepartment)
      .mockRejectedValueOnce(
        new ApiError({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such department' }),
      )
      .mockResolvedValueOnce(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])

    await renderAt('dept-eng')

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain('No such department')

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('department-details-section')).not.toBeNull()
    })
    expect(adminApi.getDepartment).toHaveBeenCalledTimes(2)
  })
})

describe('DepartmentDetail — save details', () => {
  it('saves the trimmed name/description via patchDepartment', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])
    vi.mocked(adminApi.patchDepartment).mockResolvedValue({
      id: 'dept-eng',
      name: 'Eng',
      description: 'Builds the product',
      createdAt: deptDetail.createdAt,
      updatedAt: '2026-07-13T00:00:00.000Z',
    })

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-details-section')).not.toBeNull())

    fireEvent.change(screen.getByTestId('department-name-input'), { target: { value: '  Eng  ' } })
    fireEvent.click(screen.getByTestId('department-save-details'))

    await waitFor(() => {
      expect(adminApi.patchDepartment).toHaveBeenCalledWith('dept-eng', {
        name: 'Eng',
        description: 'Builds the product',
      })
    })
  })

  it('shows a 409 inline error on rename conflict', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])
    vi.mocked(adminApi.patchDepartment).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'A department named "HR" already exists',
      }),
    )

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-details-section')).not.toBeNull())

    fireEvent.change(screen.getByTestId('department-name-input'), { target: { value: 'HR' } })
    fireEvent.click(screen.getByTestId('department-save-details'))

    await waitFor(() => {
      expect(screen.getByTestId('department-details-error').textContent).toContain('already exists')
    })
  })
})

describe('DepartmentDetail — roles conferred', () => {
  it('saves the toggled role set via putDepartmentRoles', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer, roleManager])
    vi.mocked(adminApi.putDepartmentRoles).mockResolvedValue({
      ...deptDetail,
      roleIds: ['role-engineer', 'role-manager'],
    })

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-roles-list')).not.toBeNull())

    fireEvent.click(screen.getByTestId('role-checkbox-role-manager'))
    fireEvent.click(screen.getByTestId('department-save-roles'))

    await waitFor(() => {
      expect(adminApi.putDepartmentRoles).toHaveBeenCalledWith('dept-eng', ['role-engineer', 'role-manager'])
    })
  })

  it('on a 422 stale-role error, shows the inline banner and re-fetches the roles catalog', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles)
      .mockResolvedValueOnce([roleEngineer, roleManager])
      .mockResolvedValueOnce([roleEngineer])
    vi.mocked(adminApi.putDepartmentRoles).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Unknown role id(s): role-manager',
      }),
    )

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-roles-list')).not.toBeNull())

    fireEvent.click(screen.getByTestId('department-save-roles'))

    await waitFor(() => {
      expect(screen.getByTestId('department-roles-error').textContent).toContain('Unknown role')
    })
    expect(adminApi.listRoles).toHaveBeenCalledTimes(2)
  })
})

describe('DepartmentDetail — members', () => {
  it('removes a member via putDepartmentMembers with the remaining ids', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])
    vi.mocked(adminApi.putDepartmentMembers).mockResolvedValue({ ...deptDetail, members: [] })

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-member-user-ada')).not.toBeNull())

    fireEvent.click(screen.getByTestId('department-remove-member-user-ada'))

    await waitFor(() => {
      expect(adminApi.putDepartmentMembers).toHaveBeenCalledWith('dept-eng', [])
    })
    await waitFor(() => {
      expect(screen.getByTestId('department-members-empty')).not.toBeNull()
    })
  })

  it('shows "No members yet." when the department has no members', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue({ ...deptDetail, members: [] })
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])

    await renderAt('dept-eng')

    await waitFor(() => {
      expect(screen.getByTestId('department-members-empty')).not.toBeNull()
    })
    expect(screen.getByText('No members yet.')).not.toBeNull()
  })

  it('opens the picker, searches, and adds a result via putDepartmentMembers', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])
    vi.mocked(adminApi.listUsers).mockResolvedValue({
      items: [userGrace],
      page: 1,
      pageSize: 10,
      total: 1,
    })
    vi.mocked(adminApi.putDepartmentMembers).mockResolvedValue({
      ...deptDetail,
      members: [memberAda, { id: 'user-grace', name: 'Grace Hopper', email: 'grace@example.com' }],
    })

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-details-section')).not.toBeNull())

    fireEvent.click(screen.getByTestId('department-add-member-button'))
    expect(screen.getByTestId('department-member-picker')).not.toBeNull()

    fireEvent.change(screen.getByTestId('department-picker-query-input'), { target: { value: 'grace' } })
    fireEvent.click(screen.getByTestId('department-picker-search-button'))

    await waitFor(() => {
      expect(adminApi.listUsers).toHaveBeenCalledWith({ q: 'grace', pageSize: 10 })
    })
    await waitFor(() => {
      expect(screen.getByTestId('department-picker-result-user-grace')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('department-picker-add-user-grace'))

    await waitFor(() => {
      expect(adminApi.putDepartmentMembers).toHaveBeenCalledWith('dept-eng', ['user-ada', 'user-grace'])
    })
    await waitFor(() => {
      expect(screen.queryByTestId('department-member-picker')).toBeNull()
    })
    expect(screen.getByTestId('department-member-user-grace')).not.toBeNull()
  })

  it('shows "No users match your search." when the picker search is empty', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])
    vi.mocked(adminApi.listUsers).mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 })

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-details-section')).not.toBeNull())

    fireEvent.click(screen.getByTestId('department-add-member-button'))
    fireEvent.click(screen.getByTestId('department-picker-search-button'))

    await waitFor(() => {
      expect(screen.getByTestId('department-picker-empty')).not.toBeNull()
    })
  })

  it('shows an inline message when the picker search fails', async () => {
    vi.mocked(adminApi.getDepartment).mockResolvedValue(deptDetail)
    vi.mocked(adminApi.listRoles).mockResolvedValue([roleEngineer])
    vi.mocked(adminApi.listUsers).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Not an admin.' }),
    )

    await renderAt('dept-eng')
    await waitFor(() => expect(screen.getByTestId('department-details-section')).not.toBeNull())

    fireEvent.click(screen.getByTestId('department-add-member-button'))
    fireEvent.click(screen.getByTestId('department-picker-search-button'))

    await waitFor(() => {
      expect(screen.getByTestId('department-picker-message').textContent).toBe('Not an admin.')
    })
  })
})
