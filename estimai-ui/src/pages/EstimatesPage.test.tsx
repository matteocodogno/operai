/**
 * @vitest-environment jsdom
 *
 * Component tests for EstimatesPage — T8, specs/001-estimate-persistence.
 *
 * Covers:
 *   (A) Loading: estimatesApi.list is pending → SkeletonListRows is visible.
 *   (B) Loaded: estimatesApi.list resolves with 2 items → both rows render with
 *       name and a formatted updatedAt; the actual item names appear (the
 *       assertion would fail if the list did not render).
 *   (C) Empty: estimatesApi.list resolves [] → empty state renders, no error
 *       surface and no SkeletonListRows visible (AC-2.3).
 *   (D) Error: estimatesApi.list rejects → an error surface renders and the
 *       component does not crash.
 *   (E) Chrome dedup (specs/003-suite-shell, T14, AC-4.2): the page no longer
 *       renders its own logo image or UserMenu — those are shell-owned now —
 *       but keeps its tool-scoped "Import JSON" and "+ New estimate" actions.
 *   (F) Shared row (specs/013-estimate-sharing, T23, AC-2.1/AC-2.2/AC-10.4):
 *       a shared row is distinguishable from an owned row by testid (never by
 *       CSS class), carries an `AccessLevelBadge` + the owner's identity via
 *       `formatIdentity`, and has no owner-only Delete action.
 *   (G) Orphaned / unresolved owner identity (T23, AC-10.4/AC-10.5): a
 *       `deleted` owner renders "Former wellD member", an `unknown` owner the
 *       neutral placeholder — never blank, never a raw id, never an error —
 *       and Delete stays absent on the orphaned row.
 *   (H) Empty-state gating (T23, AC-2.3): the empty state keys off the
 *       COMBINED owned+shared list length, so a user with only shared
 *       estimates never sees "Ready to estimate your first project?".
 *
 * Strategy:
 *   • estimatesApi is mocked at the module level so tests control what list()
 *     resolves/rejects to.
 *   • useNavigate from @tanstack/react-router is mocked to a vi.fn().
 *   • waitFor is used to await the async useEffect that calls estimatesApi.list.
 *   • Non-vacuous: every assertion is tied to a specific text/testid that would
 *     not appear if the code path did not execute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import EstimatesPage from './EstimatesPage'
import type { EstimateListItem } from '../lib/estimatesApi'
import { strings } from '../strings'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports of the modules under test.
// ---------------------------------------------------------------------------

vi.mock('../lib/estimatesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/estimatesApi')>()
  return {
    ...original,
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  }
})

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

// Import estimatesApi AFTER vi.mock so we get the mocked version.
import * as estimatesApi from '../lib/estimatesApi'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const itemA: EstimateListItem = {
  id: 'est-alpha',
  name: 'Alpha Project',
  author: 'Consultant A',
  updatedAt: '2026-07-01T10:00:00.000Z',
  access: 'owner',
  owner: null,
}

const itemB: EstimateListItem = {
  id: 'est-beta',
  name: 'Beta Initiative',
  author: 'Consultant B',
  updatedAt: '2026-06-28T14:30:00.000Z',
  access: 'owner',
  owner: null,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a promise that never resolves — used to keep list() in the
 * "pending" (loading) state for test (A).
 */
function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://api.test')
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

describe('EstimatesPage', () => {
  // (A) Loading state
  describe('(A) loading — list() is pending', () => {
    it('renders SkeletonListRows while estimatesApi.list is in-flight', () => {
      vi.mocked(estimatesApi.list).mockReturnValue(pendingPromise())

      render(<EstimatesPage />)

      // SkeletonListRows renders with data-testid="skeleton-list-rows"
      const skeleton = screen.getByTestId('skeleton-list-rows')
      expect(skeleton).toBeDefined()

      // No estimate rows or error banners should be present yet
      expect(screen.queryByRole('alert')).toBeNull()
      // "Ready to estimate" only appears in the empty state — must not appear
      expect(screen.queryByText('Ready to estimate your first project?')).toBeNull()
    })
  })

  // (B) Loaded with items
  describe('(B) loaded — list() resolves with 2 items', () => {
    it('renders both estimate names and their formatted updatedAt dates (AC-2.1)', async () => {
      vi.mocked(estimatesApi.list).mockResolvedValue([itemA, itemB])

      render(<EstimatesPage />)

      // Both names must appear — the assertion would fail if the list didn't render
      await waitFor(() => {
        expect(screen.getByText('Alpha Project')).toBeDefined()
      })
      expect(screen.getByText('Beta Initiative')).toBeDefined()

      // Skeleton must be gone once loaded
      expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()

      // updatedAt strings — formatted by formatDate() — must appear.
      // "1 Jul 2026" (or locale-equivalent). We check via locale-independent
      // partial content: the year "2026" appears in both formatted dates.
      const dateCells = screen.getAllByText(/2026/)
      expect(dateCells.length).toBeGreaterThanOrEqual(2)

      // No error surface
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  // (C) Empty state
  describe('(C) empty — list() resolves with []', () => {
    it('renders the existing empty state and no error surface (AC-2.3)', async () => {
      vi.mocked(estimatesApi.list).mockResolvedValue([])

      render(<EstimatesPage />)

      // Wait for the empty state heading
      await waitFor(() => {
        expect(screen.getByText('Ready to estimate your first project?')).toBeDefined()
      })

      // No SkeletonListRows
      expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()

      // No error alert
      expect(screen.queryByRole('alert')).toBeNull()

      // The descriptive paragraph from the empty state must appear
      expect(screen.getByText(/EstimAI helps you size software projects/)).toBeDefined()
    })
  })

  // (D) Error state
  describe('(D) error — list() rejects', () => {
    it('renders an error surface and does not crash', async () => {
      vi.mocked(estimatesApi.list).mockRejectedValue(new Error('Network failure'))

      render(<EstimatesPage />)

      // Wait for the error surface to appear
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined()
      })

      // Error message must contain the human-readable copy
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toContain('Could not load your estimates.')

      // A retry button must be present
      const retryBtn = screen.getByRole('button', { name: /Retry/i })
      expect(retryBtn).toBeDefined()

      // No skeleton, no empty state
      expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
      expect(screen.queryByText('Ready to estimate your first project?')).toBeNull()
    })
  })

  // (E) Chrome dedup (specs/003-suite-shell, T14, AC-4.2)
  describe('(E) chrome dedup — suite-level controls are shell-owned, not duplicated here', () => {
    it('does not render its own logo image or UserMenu, but keeps Import JSON / + New estimate', async () => {
      vi.mocked(estimatesApi.list).mockResolvedValue([itemA, itemB])

      render(<EstimatesPage />)

      await waitFor(() => {
        expect(screen.getByText('Alpha Project')).toBeDefined()
      })

      // Suite-level controls (now shell-owned) must be GONE from this page.
      expect(screen.queryByAltText('EstimAI')).toBeNull()
      expect(screen.queryByRole('img')).toBeNull()
      // UserMenu renders its avatar as an aria-haspopup="menu" trigger — none
      // should be present since the page no longer mounts a UserMenu.
      expect(screen.queryByRole('button', { name: /account|sign out/i })).toBeNull()

      // Tool-scoped controls remain.
      expect(screen.getByRole('button', { name: /Import JSON/i })).toBeDefined()
      expect(screen.getByRole('button', { name: /\+ New estimate/i })).toBeDefined()
    })
  })

  // (F) Shared row — distinguishable by testid, badge + identity, no Delete
  // (specs/013-estimate-sharing, T23, AC-2.1 / AC-2.2 / AC-10.4)
  describe('(F) shared row — testid-distinguishable, AccessLevelBadge + owner identity, no Delete', () => {
    it('renders owned and shared rows with distinct testids, an AccessLevelBadge and formatIdentity owner text on the shared row, and Delete only on the owned row', async () => {
      const sharedItem: EstimateListItem = {
        id: 'est-shared',
        name: 'Shared Project',
        author: '',
        updatedAt: '2026-07-05T09:00:00.000Z',
        access: 'editor',
        owner: { status: 'active', name: 'Marco Rossi' },
      }
      vi.mocked(estimatesApi.list).mockResolvedValue([itemA, sharedItem])

      render(<EstimatesPage />)

      await waitFor(() => {
        expect(screen.getByText('Alpha Project')).toBeDefined()
      })
      expect(screen.getByText('Shared Project')).toBeDefined()

      // Distinguishable by testid (role/testid), never by CSS class alone —
      // a class-based assertion would still pass against an invisible change.
      const ownedRow = screen.getByTestId('estimate-row-owned')
      const sharedRow = screen.getByTestId('estimate-row-shared')

      // AccessLevelBadge — its presence IS the "shared" indicator (design.md S6) —
      // appears only on the shared row.
      const badge = within(sharedRow).getByTestId('access-level-badge')
      expect(badge.textContent).toContain(strings.sharing.dialog.levelEditor)
      expect(within(ownedRow).queryByTestId('access-level-badge')).toBeNull()

      // Owner identity via formatIdentity — not the free-text author field.
      expect(within(sharedRow).getByText(/Marco Rossi/)).toBeDefined()

      // Owner-only Delete "×" is present on the owned row, absent on the shared row.
      expect(within(ownedRow).getByRole('button', { name: /Delete/i })).toBeDefined()
      expect(within(sharedRow).queryByRole('button', { name: /Delete/i })).toBeNull()
    })
  })

  // (G) Orphaned / unresolved owner identity — never blank, never a raw id,
  // never an error (specs/013-estimate-sharing, T23, AC-10.4 / AC-10.5)
  describe('(G) orphaned / unresolved owner identity', () => {
    it('renders "Former wellD member" for a deleted owner and keeps Delete absent (orphaned row, AC-10.4)', async () => {
      const orphanedItem: EstimateListItem = {
        id: 'est-orphaned',
        name: 'Orphaned Project',
        author: '',
        updatedAt: '2026-07-06T09:00:00.000Z',
        access: 'viewer',
        owner: { status: 'deleted', name: null },
      }
      vi.mocked(estimatesApi.list).mockResolvedValue([orphanedItem])

      render(<EstimatesPage />)

      await waitFor(() => {
        expect(screen.getByText('Orphaned Project')).toBeDefined()
      })

      const row = screen.getByTestId('estimate-row-shared')
      expect(within(row).getByText(strings.sharing.identity.deleted)).toBeDefined()

      // Never the raw id/cuid standing in for a name.
      expect(within(row).queryByText('est-orphaned')).toBeNull()

      // Orphaning changes nothing about this row's controls — Delete was
      // already absent because it isn't the viewer's own estimate.
      expect(within(row).queryByRole('button', { name: /Delete/i })).toBeNull()
    })

    it('renders the neutral placeholder for an unknown owner — never blank, never a raw id, never an error', async () => {
      const unknownOwnerItem: EstimateListItem = {
        id: 'est-unknown-owner',
        name: 'Unknown Owner Project',
        author: '',
        updatedAt: '2026-07-07T09:00:00.000Z',
        access: 'viewer',
        owner: { status: 'unknown', name: null },
      }
      vi.mocked(estimatesApi.list).mockResolvedValue([unknownOwnerItem])

      render(<EstimatesPage />)

      await waitFor(() => {
        expect(screen.getByText('Unknown Owner Project')).toBeDefined()
      })

      const row = screen.getByTestId('estimate-row-shared')
      expect(within(row).getByText(strings.sharing.identity.unknown)).toBeDefined()
      expect(within(row).queryByText('est-unknown-owner')).toBeNull()
    })
  })

  // (H) Empty-state gating keys off the COMBINED owned+shared list length
  // (specs/013-estimate-sharing, T23, AC-2.3)
  describe('(H) empty-state gating — combined owned+shared length, not owned-only', () => {
    it('does NOT render the empty state when the user has only a shared estimate', async () => {
      const sharedOnlyItem: EstimateListItem = {
        id: 'est-shared-only',
        name: 'Shared Only Project',
        author: '',
        updatedAt: '2026-07-08T09:00:00.000Z',
        access: 'viewer',
        owner: { status: 'active', name: 'Giulia Bianchi' },
      }
      vi.mocked(estimatesApi.list).mockResolvedValue([sharedOnlyItem])

      render(<EstimatesPage />)

      await waitFor(() => {
        expect(screen.getByText('Shared Only Project')).toBeDefined()
      })

      expect(screen.queryByText('Ready to estimate your first project?')).toBeNull()
      expect(screen.queryByTestId('estimate-row-owned')).toBeNull()
      expect(screen.getByTestId('estimate-row-shared')).toBeDefined()
    })
  })
})
