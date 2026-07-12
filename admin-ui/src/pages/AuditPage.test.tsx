/**
 * @vitest-environment jsdom
 *
 * Component tests for AuditPage — Screen D1 (T21, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) Loading: adminApi.listAudit is pending → SkeletonListRows is visible.
 *   (B) Loaded/populated: renders the semantic table (`<th scope="col">` per
 *       column: Timestamp/Actor/Action/Target/Summary) with each entry's row.
 *   (C) Empty: listAudit resolves a zero-total page → "No authorization
 *       changes recorded yet." (AC-5.2 empty state), no table, no skeleton.
 *   (D) Error: listAudit rejects (ApiError) → ErrorBanner renders the RFC
 *       7807 detail + a Retry button that re-fetches the same page.
 *   (E) Pagination: Pagination renders with the right total and clicking
 *       Next re-calls listAudit with page 2.
 *   (F) Row-expand: a row's toggle button starts collapsed (aria-expanded
 *       false, no diff panel in the DOM) and expanding it reveals the
 *       before/after diff; collapsing hides it again.
 *   (G) No mutate affordance anywhere (AC-5.3 by omission): no button/link
 *       whose accessible name suggests edit/delete/update, and no <form>.
 *
 * Strategy: `../lib/adminApi` is mocked at the module level (mirrors
 * estimai-ui/src/pages/EstimatesPage.test.tsx's `vi.mock('../lib/estimatesApi', ...)`
 * pattern) so tests control exactly what `listAudit` resolves/rejects to,
 * while keeping the real `ApiError` class via `importOriginal` (AuditPage
 * branches on `error instanceof ApiError`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AuditPage from './AuditPage'
import type { AuditLogEntry, Paginated } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Module mock — must be declared before importing the mocked module.
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    listAudit: vi.fn(),
  }
})

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const entryA: AuditLogEntry = {
  id: 'audit-1',
  actorUserId: 'user-admin-1',
  action: 'role.create',
  targetType: 'role',
  targetId: 'role-accounting-lead',
  summary: 'Created role "Accounting Lead"',
  data: { before: null, after: { name: 'Accounting Lead' } },
  createdAt: '2026-07-10T09:15:00.000Z',
}

const entryB: AuditLogEntry = {
  id: 'audit-2',
  actorUserId: null,
  action: 'user_role.revoke',
  targetType: 'user',
  targetId: 'user-42',
  summary: 'Revoked role "admin" from user-42',
  data: { before: { roles: ['admin', 'employee'] }, after: { roles: ['employee'] } },
  createdAt: '2026-07-09T08:00:00.000Z',
}

const pageOf = (items: AuditLogEntry[], total = items.length): Paginated<AuditLogEntry> => ({
  items,
  page: 1,
  pageSize: 20,
  total,
})

/** Returns a promise that never resolves — keeps listAudit "pending" (loading). */
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
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditPage', () => {
  // (A) Loading
  it('renders SkeletonListRows while listAudit is in-flight', () => {
    vi.mocked(adminApi.listAudit).mockReturnValue(pendingPromise())

    render(<AuditPage />)

    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('audit-table')).toBeNull()
  })

  // (B) Loaded / populated
  it('renders the audit table with Timestamp/Actor/Action/Target/Summary columns and both entries', async () => {
    vi.mocked(adminApi.listAudit).mockResolvedValue(pageOf([entryA, entryB]))

    render(<AuditPage />)

    await waitFor(() => {
      expect(screen.getByTestId('audit-table')).not.toBeNull()
    })

    const table = screen.getByTestId('audit-table')
    const columnHeaders = table.querySelectorAll('th[scope="col"]')
    // 6 columns: expand toggle (sr-only label) + the 5 named columns.
    expect(columnHeaders.length).toBe(6)
    const headerTexts = Array.from(columnHeaders).map((th) => th.textContent?.trim())
    expect(headerTexts).toEqual(
      expect.arrayContaining(['Timestamp', 'Actor', 'Action', 'Target', 'Summary']),
    )

    // Row content for both entries.
    expect(screen.getByText('Created role "Accounting Lead"')).not.toBeNull()
    expect(screen.getByText('role.create')).not.toBeNull()
    expect(screen.getByText('role · role-accounting-lead')).not.toBeNull()
    expect(screen.getByText('user-admin-1')).not.toBeNull()

    expect(screen.getByText('Revoked role "admin" from user-42')).not.toBeNull()
    expect(screen.getByText('user_role.revoke')).not.toBeNull()
    // Null actor renders a human-readable fallback, not a blank cell.
    expect(screen.getByText('Deleted user')).not.toBeNull()

    // Skeleton must be gone once loaded.
    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // (C) Empty
  it('renders "No authorization changes recorded yet." when the page is empty', async () => {
    vi.mocked(adminApi.listAudit).mockResolvedValue(pageOf([], 0))

    render(<AuditPage />)

    await waitFor(() => {
      expect(screen.getByTestId('audit-empty-state')).not.toBeNull()
    })

    expect(screen.getByText('No authorization changes recorded yet.')).not.toBeNull()
    expect(screen.queryByTestId('audit-table')).toBeNull()
    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // (D) Error
  it('renders an ErrorBanner with the RFC 7807 detail and retries on click', async () => {
    vi.mocked(adminApi.listAudit)
      .mockRejectedValueOnce(
        new ApiError({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'You are not an administrator.',
        }),
      )
      .mockResolvedValueOnce(pageOf([entryA]))

    render(<AuditPage />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    expect(screen.getByRole('alert').textContent).toContain('You are not an administrator.')
    expect(screen.queryByTestId('audit-table')).toBeNull()
    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('audit-table')).not.toBeNull()
    })
    expect(adminApi.listAudit).toHaveBeenCalledTimes(2)
    expect(adminApi.listAudit).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 })
  })

  // (E) Pagination
  it('renders Pagination reflecting the total and re-fetches page 2 on Next', async () => {
    vi.mocked(adminApi.listAudit)
      .mockResolvedValueOnce(pageOf([entryA, entryB], 45))
      .mockResolvedValueOnce(pageOf([entryA], 45))

    render(<AuditPage />)

    await waitFor(() => {
      expect(screen.getByTestId('pagination')).not.toBeNull()
    })
    expect(screen.getByTestId('pagination-status').textContent).toBe('Page 1 of 3 — Showing 1–20 of 45')

    fireEvent.click(screen.getByTestId('pagination-next'))

    await waitFor(() => {
      expect(adminApi.listAudit).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 })
    })
  })

  // (F) Row-expand diff
  it('expands a row to reveal the before/after diff, and collapses it again', async () => {
    vi.mocked(adminApi.listAudit).mockResolvedValue(pageOf([entryB]))

    render(<AuditPage />)

    await waitFor(() => {
      expect(screen.getByTestId('audit-table')).not.toBeNull()
    })

    const toggle = screen.getByTestId('audit-row-toggle-audit-2')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('audit-diff-audit-2')).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const diffRow = screen.getByTestId('audit-diff-audit-2')
    expect(diffRow).not.toBeNull()
    expect(diffRow.textContent).toContain('admin')
    expect(diffRow.textContent).toContain('employee')
    expect(screen.getByText('Before')).not.toBeNull()
    expect(screen.getByText('After')).not.toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('audit-diff-audit-2')).toBeNull()
  })

  // (G) No mutate affordance anywhere (AC-5.3 by omission)
  it('renders no edit/delete/update control and no form anywhere on the screen', async () => {
    vi.mocked(adminApi.listAudit).mockResolvedValue(pageOf([entryA, entryB], 45))

    const { container } = render(<AuditPage />)

    await waitFor(() => {
      expect(screen.getByTestId('audit-table')).not.toBeNull()
    })

    expect(container.querySelector('form')).toBeNull()

    const mutateNamePattern = /edit|delete|remove|update|save/i
    const interactiveEls = container.querySelectorAll('button, a, input, select, textarea')
    for (const el of interactiveEls) {
      const accessibleName = el.getAttribute('aria-label') ?? el.textContent ?? ''
      expect(accessibleName).not.toMatch(mutateNamePattern)
    }
  })
})
