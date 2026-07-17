/**
 * @vitest-environment jsdom
 *
 * Integration test for the saveError → <ToastBanner> render wiring in
 * EstimatorApp.tsx (Gap-1, specs/001-estimate-persistence, AC-1.3 render layer).
 *
 * The production path under test:
 *   EstimatorProvider sets saveError (on estimatesApi.update rejection)
 *   → EstimatorApp reads saveError from context via useEstimatorContext()
 *   → {saveError && <ToastBanner message={saveError} onDismiss={clearSaveError} />}
 *     renders role="alert" in the DOM
 *
 * Non-vacuousness guarantee:
 *   Removing the `{saveError && <ToastBanner …/>}` line from EstimatorApp.tsx
 *   causes screen.getByRole('alert') to throw → test FAILS.
 *   The assertion is on the real EstimatorApp render path, not on a stub.
 *
 * Mounting strategy:
 *   EstimatorApp only calls useEstimatorContext() and authClient.useSession().
 *   It does NOT call any TanStack Router hook directly — but Header.tsx does
 *   (useNavigate). We therefore mock:
 *     • @tanstack/react-router  — stub useNavigate (no RouterProvider needed)
 *     • ./lib/authClient        — stub useSession (no real auth service needed)
 *     • @vercel/analytics/react — no-op (CDN-only, would error in jsdom)
 *     • @vercel/speed-insights/react — no-op
 *     • ../lib/estimatesApi     — control update() rejection
 *
 *   EstimatorProvider + EstimatorApp are mounted directly (no router wrapper).
 *   A sibling helper component inside the provider triggers setName() to fire
 *   the debounced auto-save.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import type { Parameters, Release, Activity } from './types'

// ---------------------------------------------------------------------------
// Module mocks — hoisted by the vitest transformer.
// ---------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Outlet: () => null,
  createRootRoute: vi.fn(),
  createRoute: vi.fn(),
  createRouter: vi.fn(),
  redirect: vi.fn(),
  isRedirect: vi.fn(),
  getRouteApi: vi.fn(() => ({
    useParams: vi.fn(() => ({})),
    useLoaderData: vi.fn(() => ({})),
  })),
}))

vi.mock('./lib/authClient', () => ({
  authClient: {
    useSession: vi.fn(() => ({ data: null })),
    signOut: vi.fn(),
    getSession: vi.fn(),
  },
}))

vi.mock('@vercel/analytics/react', () => ({
  Analytics: () => null,
}))

vi.mock('@vercel/speed-insights/react', () => ({
  SpeedInsights: () => null,
}))

vi.mock('./lib/estimatesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lib/estimatesApi')>()
  return {
    ...original,
    update: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import * as estimatesApi from './lib/estimatesApi'
import { EstimatorProvider, useEstimatorContext } from './context/EstimatorContext'
import EstimatorApp from './EstimatorApp'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtureParams: Parameters = {
  parallelism: 0.7,
  sprintDays: 10,
  workingDaysMonth: 20,
  qaDeployDays: 0,
  qaTestDays: 0,
  pmDays: 0,
  aiCostCoef: 10,
  aiGain: 0.3,
}

const fixtureRelease: Release = { id: 'r1', name: 'v1.0', fte: 2 }

const fixtureActs: Activity[] = [
  {
    id: 'a1',
    num: '1',
    epic: 'Core',
    act: 'Setup',
    prof: 'Developer',
    o: 1,
    ml: 2,
    p: 4,
    risk: 0,
    notes: '',
    release: 'v1.0',
  },
]

// ---------------------------------------------------------------------------
// Helper: trigger a name edit from inside the provider tree
// ---------------------------------------------------------------------------

function NameChangeTrigger() {
  const ctx = useEstimatorContext()
  return (
    <button data-testid="trigger-edit" onClick={() => ctx.setName('Edited Name')}>
      Edit Name
    </button>
  )
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_API_URL', 'http://api.test')
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
})

// ---------------------------------------------------------------------------
// Test: saveError → <ToastBanner role="alert"> render wiring (AC-1.3)
//
// NON-VACUOUS: this test FAILS if the line
//   {saveError && <ToastBanner message={saveError} onDismiss={clearSaveError} />}
// is removed from EstimatorApp.tsx — because screen.getByRole('alert') will
// throw "Unable to find an accessible element with role 'alert'".
// ---------------------------------------------------------------------------

describe('EstimatorApp: saveError → ToastBanner render wiring (AC-1.3)', () => {
  it('renders role="alert" ToastBanner with the error message when estimatesApi.update rejects', async () => {
    const errorDetail = 'Unexpected server error. Your work is safe in this tab.'

    // Arrange: update always rejects with an ApiError whose detail matches what
    // the context will set as saveError.
    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/500',
        title: 'Internal Server Error',
        status: 500,
        detail: errorDetail,
      }),
    )

    // Mount: real EstimatorProvider wrapping the real EstimatorApp, plus a
    // sibling helper that can trigger a state mutation (→ auto-save → rejection).
    render(
      <EstimatorProvider
        estimateId="est-toast-test"
        initialName="Original Name"
        initialAuthor="Test Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <NameChangeTrigger />
        <EstimatorApp />
      </EstimatorProvider>,
    )

    // No alert yet — save has not been triggered
    expect(screen.queryByRole('alert')).toBeNull()

    // Act: trigger a name edit → starts the debounce timer inside the context
    await act(async () => {
      screen.getByTestId('trigger-edit').click()
    })

    // Flush debounce (1500 ms) and let the rejected promise settle
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Assert: the ToastBanner must be visible with role="alert" and the error text.
    // This assertion FAILS if EstimatorApp's `{saveError && <ToastBanner …/>}` is removed.
    const alert = screen.getByRole('alert')
    expect(alert).toBeDefined()
    expect(alert.textContent).toContain(errorDetail)
  })
})

// ---------------------------------------------------------------------------
// Test: showSavedToast → success <ToastBanner role="status"> render wiring
// (content-app auto-save "changes stored" feedback)
//
// NON-VACUOUS: this test FAILS if EstimatorApp's
//   {!saveError && showSavedToast && <ToastBanner tone="success" …/>}
// is removed — screen.getByRole('status') throws.
// ---------------------------------------------------------------------------

const mockUpdateResponse = {
  id: 'est-toast-success-test',
  name: 'Original Name',
  author: 'Test Author',
  content: { params: fixtureParams, releases: [fixtureRelease], acts: fixtureActs },
  createdAt: '2026-07-03T10:00:00.000Z',
  updatedAt: '2026-07-03T10:00:00.000Z',
}

// NOTE: react-dnd (used by ActivityTable, mounted inside EstimatorApp) injects
// its own unrelated `role="status"` "DndLiveRegion" element into the DOM, so
// these tests locate the toast by its copy text rather than `getByRole('status')`
// alone, then assert the role/aria-live on that specific element.

describe('EstimatorApp: showSavedToast → success ToastBanner render wiring', () => {
  it('shows a role="status" success toast after a successful auto-save', async () => {
    vi.mocked(estimatesApi.update).mockResolvedValue(mockUpdateResponse)

    render(
      <EstimatorProvider
        estimateId="est-toast-success-test"
        initialName="Original Name"
        initialAuthor="Test Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <NameChangeTrigger />
        <EstimatorApp />
      </EstimatorProvider>,
    )

    // No toast yet — save has not been triggered
    expect(screen.queryByText('Changes stored')).toBeNull()

    // Act: trigger a name edit → starts the debounce timer, then resolves
    await act(async () => {
      screen.getByTestId('trigger-edit').click()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500) // flush the 1500ms auto-save debounce
    })

    const toastText = screen.getByText('Changes stored')
    const toast = toastText.closest('[role]')
    expect(toast).not.toBeNull()
    expect(toast?.getAttribute('role')).toBe('status')
    expect(toast?.getAttribute('aria-live')).toBe('polite')

    // The success toast auto-dismisses ~2s later (ToastBanner's own timer).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.queryByText('Changes stored')).toBeNull()
  })

  it('never shows the success toast alongside the error toast', async () => {
    const errorDetail = 'Save failed (500). Your work is safe in this tab.'
    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/500',
        title: 'Internal Server Error',
        status: 500,
        detail: errorDetail,
      }),
    )

    render(
      <EstimatorProvider
        estimateId="est-toast-exclusive-test"
        initialName="Original Name"
        initialAuthor="Test Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <NameChangeTrigger />
        <EstimatorApp />
      </EstimatorProvider>,
    )

    await act(async () => {
      screen.getByTestId('trigger-edit').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.queryByText('Changes stored')).toBeNull()
  })
})
