/**
 * @vitest-environment jsdom
 *
 * Tests for T12 — ImportOfferModal + useImportOffer wired into EstimatesPage.
 * specs/001-estimate-persistence, AC-5.1, AC-5.3, AC-5.4.
 *
 * Covers:
 *   (A) offer-shown:
 *       With 2 legacy localStorage estimates + a fresh session (no dismissal flag),
 *       the ImportOfferModal renders with "Import all" and "Skip for now" actions
 *       (AC-5.1). With zero legacy estimates, the modal is NOT rendered.
 *
 *   (B) decline-session-remembered:
 *       Clicking "Skip for now" sets sessionStorage 'import_offer_dismissed',
 *       leaves all localStorage keys untouched, and a re-render does NOT re-show
 *       the offer (AC-5.3).
 *
 *   (C) accept-results incl. partial failure:
 *       Clicking "Import all" calls importEstimates; when the API returns one
 *       "imported" + one "failed" result, the results table shows both outcomes
 *       (the failed one with its reason) and NO localStorage key was removed
 *       (AC-5.4); the list-refresh callback was triggered.
 *
 * Strategy:
 *   • projects.ts is mocked to control loadProjects / loadProject output.
 *   • estimatesApi is mocked so importEstimates / list resolve predictably.
 *   • sessionStorage is reset between tests via beforeEach.
 *   • localStorage is observed at the end of each test via a spy on removeItem.
 *   • Non-vacuous: each assertion targets text/role that would not appear if the
 *     code path did not execute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import EstimatesPage from '../pages/EstimatesPage'
import type { ProjectMeta } from '../types'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../lib/projects', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/projects')>()
  return {
    ...original,
    loadProjects: vi.fn(),
    loadProject: vi.fn(),
    importProjectFromJson: vi.fn(),
  }
})

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

// Import mocked modules after vi.mock declarations.
import * as projects from '../lib/projects'
import * as estimatesApi from '../lib/estimatesApi'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const localMeta: ProjectMeta[] = [
  { id: 'local-1', name: 'Alpha Local', author: 'Consultant', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'local-2', name: 'Beta Local', author: 'Consultant', updatedAt: '2026-01-02T00:00:00.000Z' },
]

const localData1 = {
  id: 'local-1',
  name: 'Alpha Local',
  author: 'Consultant',
  params: {
    parallelism: 0.7,
    sprintDays: 10,
    workingDaysMonth: 20,
    qaDeployDays: 0,
    qaTestDays: 0,
    pmDays: 0,
    aiCostCoef: 10,
    aiGain: 0.3,
  },
  releases: [],
  acts: [],
}

const localData2 = {
  id: 'local-2',
  name: 'Beta Local',
  author: 'Consultant',
  params: {
    parallelism: 0.7,
    sprintDays: 10,
    workingDaysMonth: 20,
    qaDeployDays: 0,
    qaTestDays: 0,
    pmDays: 0,
    aiCostCoef: 10,
    aiGain: 0.3,
  },
  releases: [],
  acts: [],
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://api.test')
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')

  // Reset sessionStorage so each test starts with a fresh session.
  sessionStorage.clear()

  // Default: list returns [] so the EstimatesPage doesn't distract from the modal.
  vi.mocked(estimatesApi.list).mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImportOfferModal (T12, specs/001)', () => {
  // -------------------------------------------------------------------------
  // (A) offer-shown
  // -------------------------------------------------------------------------
  describe('(A) offer-shown — AC-5.1', () => {
    it('renders the modal with Import all + Skip for now when legacy estimates exist', async () => {
      // Arrange: 2 local estimates in localStorage, no session dismissal flag.
      vi.mocked(projects.loadProjects).mockReturnValue(localMeta)
      vi.mocked(projects.loadProject).mockImplementation((id) =>
        id === 'local-1' ? localData1 : id === 'local-2' ? localData2 : null,
      )

      render(<EstimatesPage />)

      // The modal should appear — wait for it since it's triggered by a useEffect.
      await waitFor(() => {
        expect(screen.getByTestId('import-offer-modal')).toBeDefined()
      })

      // "Import all" primary action must be present (AC-5.1).
      expect(screen.getByRole('button', { name: /Import all/i })).toBeDefined()

      // "Skip for now" decline action must be present (AC-5.1).
      expect(screen.getByRole('button', { name: /Skip for now/i })).toBeDefined()

      // The count is shown in the offer body.
      expect(screen.getByText(/2 estimates/i)).toBeDefined()
    })

    it('does NOT render the modal when there are zero legacy estimates', async () => {
      // Arrange: no local estimates.
      vi.mocked(projects.loadProjects).mockReturnValue([])

      render(<EstimatesPage />)

      // Wait for the page to settle (list loads).
      await waitFor(() => {
        expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
      })

      // The modal must not appear.
      expect(screen.queryByTestId('import-offer-modal')).toBeNull()
    })

    it('does NOT render the modal when the session dismissal flag is set', async () => {
      // Arrange: local estimates exist but the flag says already dismissed.
      vi.mocked(projects.loadProjects).mockReturnValue(localMeta)
      sessionStorage.setItem('import_offer_dismissed', '1')

      render(<EstimatesPage />)

      await waitFor(() => {
        expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
      })

      expect(screen.queryByTestId('import-offer-modal')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // (B) decline-session-remembered
  // -------------------------------------------------------------------------
  describe('(B) decline-session-remembered — AC-5.3', () => {
    it('clicking Skip sets the sessionStorage flag and hides the modal', async () => {
      vi.mocked(projects.loadProjects).mockReturnValue(localMeta)
      vi.mocked(projects.loadProject).mockImplementation((id) =>
        id === 'local-1' ? localData1 : id === 'local-2' ? localData2 : null,
      )

      // Spy on localStorage.removeItem to verify no keys are deleted (AC-5.3).
      const removeItemSpy = vi.spyOn(localStorage, 'removeItem')

      render(<EstimatesPage />)

      // Wait for the offer modal.
      await waitFor(() => {
        expect(screen.getByTestId('import-offer-modal')).toBeDefined()
      })

      // Click "Skip for now".
      fireEvent.click(screen.getByRole('button', { name: /Skip for now/i }))

      // Modal should be gone immediately.
      expect(screen.queryByTestId('import-offer-modal')).toBeNull()

      // The session dismissal flag must be set (AC-5.3).
      expect(sessionStorage.getItem('import_offer_dismissed')).toBe('1')

      // No localStorage key was removed (AC-5.3).
      expect(removeItemSpy).not.toHaveBeenCalled()
    })

    it('re-rendering after decline does not re-show the modal (session memory)', async () => {
      vi.mocked(projects.loadProjects).mockReturnValue(localMeta)
      vi.mocked(projects.loadProject).mockImplementation((id) =>
        id === 'local-1' ? localData1 : id === 'local-2' ? localData2 : null,
      )

      const { rerender } = render(<EstimatesPage />)

      // Wait for the offer modal.
      await waitFor(() => {
        expect(screen.getByTestId('import-offer-modal')).toBeDefined()
      })

      // Click "Skip for now".
      fireEvent.click(screen.getByRole('button', { name: /Skip for now/i }))

      expect(screen.queryByTestId('import-offer-modal')).toBeNull()

      // Force a re-render (simulates navigation back to the page within the session).
      rerender(<EstimatesPage />)

      // The offer must NOT reappear (the hook reads the sessionStorage flag).
      expect(screen.queryByTestId('import-offer-modal')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // (C) accept-results incl. partial failure
  // -------------------------------------------------------------------------
  describe('(C) accept-results — AC-5.4', () => {
    it('shows both imported and failed results; no localStorage key removed', async () => {
      vi.mocked(projects.loadProjects).mockReturnValue(localMeta)
      vi.mocked(projects.loadProject).mockImplementation((id) =>
        id === 'local-1' ? localData1 : id === 'local-2' ? localData2 : null,
      )

      // Mock importEstimates: one success, one failure (AC-5.4).
      vi.mocked(estimatesApi.importEstimates).mockResolvedValue({
        results: [
          { localId: 'local-1', status: 'imported', id: 'api-id-1' },
          { localId: 'local-2', status: 'failed', error: 'Payload too large' },
        ],
      })

      // Spy on localStorage.removeItem to assert no keys are deleted (AC-5.4).
      const removeItemSpy = vi.spyOn(localStorage, 'removeItem')

      render(<EstimatesPage />)

      // Wait for the offer modal.
      await waitFor(() => {
        expect(screen.getByTestId('import-offer-modal')).toBeDefined()
      })

      // Click "Import all".
      fireEvent.click(screen.getByRole('button', { name: /Import all/i }))

      // Wait for the results phase.
      await waitFor(() => {
        // Summary line must appear.
        expect(screen.getByText(/1 of 2 imported successfully/i)).toBeDefined()
      })

      // "Imported" badge for the first estimate — glyph + text (not colour alone).
      const importedBadges = screen.getAllByText('Imported')
      expect(importedBadges.length).toBeGreaterThanOrEqual(1)

      // "Failed" badge for the second estimate.
      const failedBadges = screen.getAllByText('Failed')
      expect(failedBadges.length).toBeGreaterThanOrEqual(1)

      // The error reason must be visible.
      expect(screen.getByText(/Payload too large/i)).toBeDefined()

      // Estimate names must appear in the results table.
      expect(screen.getByText('Alpha Local')).toBeDefined()
      expect(screen.getByText('Beta Local')).toBeDefined()

      // No localStorage key was removed (AC-5.4).
      expect(removeItemSpy).not.toHaveBeenCalled()

      // The list-refresh was triggered: estimatesApi.list called at least twice
      // (once on mount, once after import).
      expect(vi.mocked(estimatesApi.list).mock.calls.length).toBeGreaterThanOrEqual(2)

      // importEstimates was called with the correct payload shape.
      expect(estimatesApi.importEstimates).toHaveBeenCalledOnce()
      const [payload] = vi.mocked(estimatesApi.importEstimates).mock.calls[0]
      expect(payload.length).toBe(2)
      expect(payload[0].localId).toBe('local-1')
      expect(payload[1].localId).toBe('local-2')
    })

    it('shows the Close button in the results phase and hides the modal on click', async () => {
      vi.mocked(projects.loadProjects).mockReturnValue(localMeta)
      vi.mocked(projects.loadProject).mockImplementation((id) =>
        id === 'local-1' ? localData1 : id === 'local-2' ? localData2 : null,
      )

      vi.mocked(estimatesApi.importEstimates).mockResolvedValue({
        results: [
          { localId: 'local-1', status: 'imported', id: 'api-id-1' },
          { localId: 'local-2', status: 'imported', id: 'api-id-2' },
        ],
      })

      render(<EstimatesPage />)

      await waitFor(() => {
        expect(screen.getByTestId('import-offer-modal')).toBeDefined()
      })

      fireEvent.click(screen.getByRole('button', { name: /Import all/i }))

      // Wait for the results phase — all success → "2 of 2 imported successfully".
      await waitFor(() => {
        expect(screen.getByText(/2 of 2 imported successfully/i)).toBeDefined()
      })

      // The footer "Close" button (data-testid="import-results-close") must be present.
      const footerClose = screen.getByTestId('import-results-close')
      expect(footerClose).toBeDefined()

      // Click Close → modal gone.
      fireEvent.click(footerClose)
      expect(screen.queryByTestId('import-offer-modal')).toBeNull()
    })
  })
})
