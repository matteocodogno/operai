/**
 * @vitest-environment jsdom
 *
 * Tests for T10 — ConfirmDeleteModal + delete wiring in EstimatesPage.
 * specs/001-estimate-persistence, AC-3.1, AC-3.2.
 *
 * Covers:
 *   (A) confirm → estimatesApi.remove called with the right id, list refreshed,
 *       item gone from the list (AC-3.1).
 *   (B) cancel → estimatesApi.remove NOT called, item still present (AC-3.2).
 *   (C) Escape → treated as cancel; estimatesApi.remove NOT called (AC-3.2).
 *   (D) a11y: on open, focus is on the Cancel button (not Delete).
 *   (E) per-row delete trigger has an aria-label including the estimate name.
 *   (F) delete API failure → inline error shown; modal stays open; no crash.
 *
 * Strategy:
 *   • EstimatesPage is rendered with two items already loaded (mock list).
 *   • estimatesApi.remove is mocked to resolve or reject per test.
 *   • Non-vacuous: every assertion targets text/testid that would not appear
 *     if the code path did not execute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import EstimatesPage from '../pages/EstimatesPage'
import type { EstimateListItem } from '../lib/estimatesApi'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../lib/estimatesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/estimatesApi')>()
  return {
    ...original,
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    importEstimates: vi.fn(),
  }
})

vi.mock('../lib/authClient', () => ({
  authClient: {
    useSession: vi.fn(() => ({
      data: { user: { id: 'u1', name: 'Test User', email: 'test@welld.ch', image: null } },
    })),
    signOut: vi.fn(),
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...original,
    useNavigate: vi.fn(() => vi.fn()),
  }
})

vi.mock('../lib/api', () => ({
  clearJwtCache: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock('../lib/projects', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/projects')>()
  return {
    ...original,
    loadProjects: vi.fn(() => []),
    loadProject: vi.fn(),
    importProjectFromJson: vi.fn(),
  }
})

// Import mocked modules after vi.mock declarations.
import * as estimatesApi from '../lib/estimatesApi'
import ConfirmDeleteModal from './ConfirmDeleteModal'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// T15 (specs/013-estimate-sharing/tasks.md) widened EstimateListItem with
// `access`/`owner` (T16's fixture note) — both fixtures here are the
// caller's own estimates, so `access: 'owner'` / `owner: null` matches
// estimatesApi's documented contract ("owner is null when access is
// 'owner' — there is no 'owner of your own estimate' to resolve").
const itemAlpha: EstimateListItem = {
  id: 'est-alpha',
  name: 'Alpha Project',
  author: 'Consultant A',
  updatedAt: '2026-07-01T10:00:00.000Z',
  access: 'owner',
  owner: null,
}

const itemBeta: EstimateListItem = {
  id: 'est-beta',
  name: 'Beta Initiative',
  author: 'Consultant B',
  updatedAt: '2026-06-28T14:30:00.000Z',
  access: 'owner',
  owner: null,
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://api.test')
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// Helper: render EstimatesPage with both items loaded
// ---------------------------------------------------------------------------

const renderWithItems = async () => {
  vi.mocked(estimatesApi.list).mockResolvedValue([itemAlpha, itemBeta])
  render(<EstimatesPage />)
  // Wait until the list is rendered (both names visible)
  await waitFor(() => {
    expect(screen.getByText('Alpha Project')).toBeDefined()
  })
  expect(screen.getByText('Beta Initiative')).toBeDefined()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfirmDeleteModal (T10, specs/001)', () => {
  // (E) Per-row aria-label — checked first since it does not require opening the modal
  describe('(E) per-row delete aria-label', () => {
    it('each delete button has an aria-label that includes the estimate name', async () => {
      await renderWithItems()

      // Alpha row
      const deleteAlpha = screen.getByRole('button', { name: /Delete "Alpha Project"/i })
      expect(deleteAlpha).toBeDefined()

      // Beta row
      const deleteBeta = screen.getByRole('button', { name: /Delete "Beta Initiative"/i })
      expect(deleteBeta).toBeDefined()
    })
  })

  // (D) A11y: focus lands on Cancel by default
  describe('(D) a11y — default focus on Cancel', () => {
    it('moves focus to Cancel (not Delete) when the modal opens', async () => {
      await renderWithItems()

      // Open the modal for Alpha
      fireEvent.click(screen.getByRole('button', { name: /Delete "Alpha Project"/i }))

      // Modal must be visible
      expect(screen.getByTestId('confirm-delete-modal')).toBeDefined()

      // Wait a tick for the useEffect focus to fire
      await waitFor(() => {
        const cancelBtn = screen.getByTestId('confirm-delete-cancel')
        // document.activeElement should be the Cancel button, not Delete
        expect(document.activeElement).toBe(cancelBtn)
      })

      // Confirm that the Delete button is NOT the active element
      const deleteBtn = screen.getByTestId('confirm-delete-confirm')
      expect(document.activeElement).not.toBe(deleteBtn)
    })
  })

  // (A) Confirm → remove called with right id, list refreshed, item gone
  describe('(A) confirm → API call + list refresh (AC-3.1)', () => {
    it('calls estimatesApi.remove with the correct id and refreshes the list', async () => {
      // After remove, list returns only Beta (Alpha is gone)
      vi.mocked(estimatesApi.remove).mockResolvedValue(undefined)
      vi.mocked(estimatesApi.list)
        .mockResolvedValueOnce([itemAlpha, itemBeta]) // initial load
        .mockResolvedValueOnce([itemBeta]) // after delete

      render(<EstimatesPage />)
      await waitFor(() => {
        expect(screen.getByText('Alpha Project')).toBeDefined()
      })

      // Open the confirm modal for Alpha
      fireEvent.click(screen.getByRole('button', { name: /Delete "Alpha Project"/i }))
      expect(screen.getByTestId('confirm-delete-modal')).toBeDefined()

      // Click Delete (confirm)
      fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

      // remove() must have been called with Alpha's id (AC-3.1)
      await waitFor(() => {
        expect(estimatesApi.remove).toHaveBeenCalledWith('est-alpha')
      })

      // Modal closes and list refreshes — Alpha is gone
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
      })

      await waitFor(() => {
        expect(screen.queryByText('Alpha Project')).toBeNull()
      })

      // Beta still present
      expect(screen.getByText('Beta Initiative')).toBeDefined()

      // list() must have been called at least twice (initial + post-delete)
      expect(vi.mocked(estimatesApi.list).mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  // (B) Cancel → no API call, item still present
  describe('(B) cancel → no API call, item unchanged (AC-3.2)', () => {
    it('clicking Cancel closes the modal without calling estimatesApi.remove', async () => {
      await renderWithItems()

      // Open the confirm modal for Alpha
      fireEvent.click(screen.getByRole('button', { name: /Delete "Alpha Project"/i }))
      expect(screen.getByTestId('confirm-delete-modal')).toBeDefined()

      // Click Cancel
      fireEvent.click(screen.getByTestId('confirm-delete-cancel'))

      // Modal must be closed
      expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()

      // remove() must NOT have been called (AC-3.2)
      expect(estimatesApi.remove).not.toHaveBeenCalled()

      // Alpha is still in the list (AC-3.2)
      expect(screen.getByText('Alpha Project')).toBeDefined()
    })
  })

  // (C) Escape → treated as cancel
  describe('(C) Escape → cancel, no API call (AC-3.2)', () => {
    it('pressing Escape closes the modal without calling estimatesApi.remove', async () => {
      await renderWithItems()

      // Open the confirm modal for Beta
      fireEvent.click(screen.getByRole('button', { name: /Delete "Beta Initiative"/i }))
      expect(screen.getByTestId('confirm-delete-modal')).toBeDefined()

      // Press Escape
      fireEvent.keyDown(window, { key: 'Escape' })

      // Modal must close
      expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()

      // remove() must NOT have been called (AC-3.2)
      expect(estimatesApi.remove).not.toHaveBeenCalled()

      // Beta is still in the list
      expect(screen.getByText('Beta Initiative')).toBeDefined()
    })
  })

  // (F) Delete API failure → inline error, modal stays open
  describe('(F) delete failure → inline error shown, modal open', () => {
    it('shows an inline error when estimatesApi.remove rejects and does not close the modal', async () => {
      vi.mocked(estimatesApi.remove).mockRejectedValue(new Error('Network error'))
      vi.mocked(estimatesApi.list).mockResolvedValue([itemAlpha, itemBeta])

      render(<EstimatesPage />)
      await waitFor(() => {
        expect(screen.getByText('Alpha Project')).toBeDefined()
      })

      // Open modal for Alpha
      fireEvent.click(screen.getByRole('button', { name: /Delete "Alpha Project"/i }))

      // Click Delete (confirm)
      fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

      // Wait for the error to surface
      await waitFor(() => {
        expect(screen.getByTestId('confirm-delete-error')).toBeDefined()
      })

      // Modal must still be open
      expect(screen.getByTestId('confirm-delete-modal')).toBeDefined()

      // Error message text
      const errorEl = screen.getByTestId('confirm-delete-error')
      expect(errorEl.textContent).toContain('Delete failed')

      // The list was NOT refreshed with a removal (Alpha still visible after close
      // — but modal is still open, so we just check remove was called once)
      expect(estimatesApi.remove).toHaveBeenCalledWith('est-alpha')
      expect(estimatesApi.remove).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// (G) T19 — generalized title / bodyText / confirmLabel props (specs/013)
//
// Renders ConfirmDeleteModal directly (not via EstimatesPage, whose call site
// deliberately omits the new props to prove the default-copy path). Confirms
// custom copy renders, and that the focus-trap + Escape semantics documented
// in design.md's Accessibility section are unchanged when the copy is
// overridden — same shape, different words.
// ---------------------------------------------------------------------------

describe('ConfirmDeleteModal — generalized title/bodyText/confirmLabel (T19, specs/013)', () => {
  const baseProps = {
    estimateName: 'Alpha Project',
    isDeleting: false,
    errorMessage: null as string | null,
  }

  it('renders custom title, bodyText and confirmLabel instead of the delete-estimate defaults', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmDeleteModal
        {...baseProps}
        title="Remove collaborator?"
        bodyText="jane@welld.ch will lose access to this estimate immediately."
        confirmLabel="Remove"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByText('Remove collaborator?')).toBeDefined()
    expect(screen.getByText('jane@welld.ch will lose access to this estimate immediately.')).toBeDefined()
    expect(screen.getByTestId('confirm-delete-confirm').textContent).toBe('Remove')

    // Defaults must not leak through when overridden.
    expect(screen.queryByText('Delete estimate?')).toBeNull()
    expect(screen.queryByText(/will be permanently deleted/i)).toBeNull()
  })

  it('keeps the focus-trap and Escape semantics unchanged with custom copy', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmDeleteModal
        {...baseProps}
        title="Leave this estimate?"
        bodyText="You will lose access immediately and it will disappear from your estimates list."
        confirmLabel="Leave"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    // Default focus lands on Cancel, same as the delete-estimate flow.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('confirm-delete-cancel'))
    })

    // Escape cancels without invoking confirm — same shape as ConfirmDeleteModal's
    // existing Escape semantics (design.md Accessibility: "matches
    // ConfirmDeleteModal's existing Escape semantics").
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('falls back to the exact default title/body/label when the new props are omitted', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(<ConfirmDeleteModal {...baseProps} onConfirm={onConfirm} onCancel={onCancel} />)

    expect(screen.getByText('Delete estimate?')).toBeDefined()
    expect(screen.getByText('‘Alpha Project’ will be permanently deleted. This cannot be undone.')).toBeDefined()
    expect(screen.getByTestId('confirm-delete-confirm').textContent).toBe('Delete')
  })
})
