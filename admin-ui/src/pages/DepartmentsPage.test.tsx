/**
 * @vitest-environment jsdom
 *
 * Component tests for DepartmentsPage — Screen B1 (T19, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) Loading: adminApi.listDepartments is pending → SkeletonListRows visible.
 *   (B) Loaded/populated: renders the table (Name/Description columns) with
 *       both departments' rows.
 *   (C) Empty: listDepartments resolves [] → "No departments yet." — no
 *       table, no skeleton.
 *   (D) Error: listDepartments rejects (ApiError) → ErrorBanner with the RFC
 *       7807 detail + Retry re-fetches.
 *   (E) Create (Modal M2): "+ New department" opens the modal; a valid
 *       submit calls adminApi.createDepartment and navigates to the new
 *       department's detail route.
 *   (F) Create 409 duplicate: createDepartment rejects with a 409 ApiError →
 *       the modal stays open with the inline error, no navigation.
 *   (G) Delete (Dialog D1): clicking a row's delete opens ConfirmDeleteModal;
 *       confirming calls adminApi.deleteDepartment and re-fetches the list.
 *   (H) Delete error: deleteDepartment rejects → inline error in the modal,
 *       modal stays open.
 *
 * Strategy: `../lib/adminApi` is mocked at the module level (mirrors
 * AuditPage.test.tsx / estimai-ui's EstimatesPage.test.tsx conventions);
 * `useNavigate` is mocked to a spy so navigation can be asserted without a
 * real router.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import DepartmentsPage from './DepartmentsPage'
import type { Department } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the mocked modules.
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    listDepartments: vi.fn(),
    createDepartment: vi.fn(),
    deleteDepartment: vi.fn(),
  }
})

const navigateSpy = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...original,
    useNavigate: () => navigateSpy,
  }
})

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const deptA: Department = {
  id: 'dept-eng',
  name: 'Engineering',
  description: 'Builds the product',
  createdAt: '2026-07-01T09:00:00.000Z',
  updatedAt: '2026-07-01T09:00:00.000Z',
}

const deptB: Department = {
  id: 'dept-hr',
  name: 'HR',
  description: null,
  createdAt: '2026-07-02T09:00:00.000Z',
  updatedAt: '2026-07-02T09:00:00.000Z',
}

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
})

describe('DepartmentsPage — list states', () => {
  it('renders SkeletonListRows while listDepartments is in-flight', () => {
    vi.mocked(adminApi.listDepartments).mockReturnValue(pendingPromise())

    render(<DepartmentsPage />)

    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.queryByTestId('departments-table')).toBeNull()
  })

  it('renders the departments table with Name/Description columns and both rows', async () => {
    vi.mocked(adminApi.listDepartments).mockResolvedValue([deptA, deptB])

    render(<DepartmentsPage />)

    await waitFor(() => {
      expect(screen.getByTestId('departments-table')).not.toBeNull()
    })

    const table = screen.getByTestId('departments-table')
    const headerTexts = Array.from(table.querySelectorAll('th[scope="col"]')).map((th) => th.textContent?.trim())
    expect(headerTexts).toEqual(expect.arrayContaining(['Name', 'Description']))

    expect(screen.getByText('Engineering')).not.toBeNull()
    expect(screen.getByText('Builds the product')).not.toBeNull()
    expect(screen.getByText('HR')).not.toBeNull()
    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
  })

  it('renders "No departments yet." when the list is empty', async () => {
    vi.mocked(adminApi.listDepartments).mockResolvedValue([])

    render(<DepartmentsPage />)

    await waitFor(() => {
      expect(screen.getByTestId('departments-empty-state')).not.toBeNull()
    })
    expect(screen.getByText('No departments yet.')).not.toBeNull()
    expect(screen.queryByTestId('departments-table')).toBeNull()
  })

  it('renders an ErrorBanner with the RFC 7807 detail and retries on click', async () => {
    vi.mocked(adminApi.listDepartments)
      .mockRejectedValueOnce(
        new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Not an admin.' }),
      )
      .mockResolvedValueOnce([deptA])

    render(<DepartmentsPage />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    expect(screen.getByRole('alert').textContent).toContain('Not an admin.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('departments-table')).not.toBeNull()
    })
    expect(adminApi.listDepartments).toHaveBeenCalledTimes(2)
  })
})

describe('DepartmentsPage — create (Modal M2)', () => {
  it('opens the modal, submits, creates the department, and navigates to its detail', async () => {
    vi.mocked(adminApi.listDepartments).mockResolvedValue([])
    vi.mocked(adminApi.createDepartment).mockResolvedValue({
      id: 'dept-new',
      name: 'Finance',
      description: null,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    })

    render(<DepartmentsPage />)

    await waitFor(() => expect(screen.getByTestId('departments-empty-state')).not.toBeNull())

    fireEvent.click(screen.getByTestId('new-department-button'))
    expect(screen.getByTestId('create-department-modal')).not.toBeNull()

    fireEvent.change(screen.getByTestId('create-department-name-input'), { target: { value: 'Finance' } })
    fireEvent.click(screen.getByTestId('create-department-submit'))

    await waitFor(() => {
      expect(adminApi.createDepartment).toHaveBeenCalledWith({ name: 'Finance', description: undefined })
    })
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith({ to: '/departments/$id', params: { id: 'dept-new' } })
    })
    expect(screen.queryByTestId('create-department-modal')).toBeNull()
  })

  it('shows the 409 duplicate-name error inline and keeps the modal open', async () => {
    vi.mocked(adminApi.listDepartments).mockResolvedValue([deptA])
    vi.mocked(adminApi.createDepartment).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'A department named "Engineering" already exists',
      }),
    )

    render(<DepartmentsPage />)
    await waitFor(() => expect(screen.getByTestId('departments-table')).not.toBeNull())

    fireEvent.click(screen.getByTestId('new-department-button'))
    fireEvent.change(screen.getByTestId('create-department-name-input'), { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByTestId('create-department-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('create-department-error').textContent).toContain('already exists')
    })
    expect(screen.getByTestId('create-department-modal')).not.toBeNull()
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})

describe('DepartmentsPage — delete (Dialog D1)', () => {
  it('opens ConfirmDeleteModal, deletes on confirm, and re-fetches the list', async () => {
    vi.mocked(adminApi.listDepartments).mockResolvedValueOnce([deptA]).mockResolvedValueOnce([])
    vi.mocked(adminApi.deleteDepartment).mockResolvedValue(undefined)

    render(<DepartmentsPage />)
    await waitFor(() => expect(screen.getByTestId('departments-table')).not.toBeNull())

    fireEvent.click(screen.getByTestId('department-delete-dept-eng'))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/Engineering/)).not.toBeNull()

    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => {
      expect(adminApi.deleteDepartment).toHaveBeenCalledWith('dept-eng')
    })
    await waitFor(() => {
      expect(screen.getByTestId('departments-empty-state')).not.toBeNull()
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(adminApi.listDepartments).toHaveBeenCalledTimes(2)
  })

  it('shows an inline error in the modal when delete fails, and keeps it open', async () => {
    vi.mocked(adminApi.listDepartments).mockResolvedValue([deptA])
    vi.mocked(adminApi.deleteDepartment).mockRejectedValue(new Error('network down'))

    render(<DepartmentsPage />)
    await waitFor(() => expect(screen.getByTestId('departments-table')).not.toBeNull())

    fireEvent.click(screen.getByTestId('department-delete-dept-eng'))
    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => {
      expect(screen.getByTestId('confirm-delete-error').textContent).toBe('Delete failed. Try again.')
    })
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })
})
