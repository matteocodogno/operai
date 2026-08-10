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
  // T18 (specs/013-estimate-sharing/tasks.md) added a `useRouter()` call to
  // EstimatorApp.tsx (ConflictBanner's "Reload latest" → router.invalidate())
  // — required here so this pre-existing mock still satisfies every hook the
  // real component now calls. This file's own stale `EstimateFull` fixture
  // (missing version/access/owner, the last remaining `pnpm build` failure
  // on this branch) is fixed below by T22 (see `mockUpdateResponse`).
  useRouter: () => ({ invalidate: vi.fn() }),
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
import type { EstimateAccess, EstimateIdentity } from './lib/estimatesApi'
import { EstimatorProvider, useEstimatorContext } from './context/EstimatorContext'
import EstimatorApp from './EstimatorApp'
import { strings } from './strings'

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

// T22 (specs/013-estimate-sharing/tasks.md): this fixture was missing
// `version`/`access`/`owner` — all required on `EstimateFull` since T15
// widened that type (T16's fixture note flagged this file's stale literal
// as the last remaining `pnpm build` failure on the branch, deliberately
// left for T22 to fix). `collaboratorCount` stays absent — optional, and
// this fixture predates the toolbar's Collaborators button reading it.
const mockUpdateResponse = {
  id: 'est-toast-success-test',
  name: 'Original Name',
  author: 'Test Author',
  content: { params: fixtureParams, releases: [fixtureRelease], acts: fixtureActs },
  createdAt: '2026-07-03T10:00:00.000Z',
  updatedAt: '2026-07-03T10:00:00.000Z',
  version: 2,
  access: 'owner' as const,
  owner: null,
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

// ---------------------------------------------------------------------------
// Test: toolbar composition — "Collaborators"/chip is the ONLY sharing entry.
//
// Originally T22 (specs/013) asserted TWO entries side by side: the anonymous
// "Share link" and the account-based "Collaborators". The link mechanism was
// removed on 2026-08-09 (specs/013 US-8 amendment), so the assertions below
// are inverted: the toolbar must expose the Collaborators affordance and NO
// link-sharing affordance at all.
//
// NON-VACUOUS: these tests FAIL if the Collaborators button/chip goes missing
// from either access mode, if the count badge stops reflecting
// `collaboratorCount`, or if any share-a-link control is reintroduced into the
// toolbar (which would resurrect an account-free view of estimate data).
// ---------------------------------------------------------------------------

function renderToolbar(access: EstimateAccess, owner?: EstimateIdentity | null, collaboratorCount?: number) {
  return render(
    <EstimatorProvider
      estimateId="est-toolbar-test"
      initialName="Toolbar Test"
      initialAuthor="Test Author"
      initialParams={fixtureParams}
      initialReleases={[fixtureRelease]}
      initialActs={fixtureActs}
      initialAccess={access}
      initialVersion={1}
      initialOwner={owner}
      initialCollaboratorCount={collaboratorCount}
    >
      <EstimatorApp />
    </EstimatorProvider>,
  )
}

describe('EstimatorApp: toolbar composition — Collaborators is the only sharing entry', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('owner: "Collaborators" is present and no link-sharing control exists', () => {
    renderToolbar('owner', null, 3)

    const collabBtn = screen.getByTestId('collaborators-button')
    expect(collabBtn).toBeDefined()
    // The owner never sees the member-mode chip.
    expect(screen.queryByTestId('collaborators-chip')).toBeNull()

    // The removed anonymous share link must not come back in any guise.
    expect(screen.queryByRole('button', { name: /share link/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^share/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /qr/i })).toBeNull()
  })

  it('owner: the Collaborators count badge reflects collaboratorCount', () => {
    renderToolbar('owner', null, 3)

    const collabBtn = screen.getByTestId('collaborators-button')
    expect(collabBtn.textContent).toContain('3')
    expect(collabBtn.getAttribute('aria-label')).toBe(strings.sharing.toolbar.collaboratorsWithCount(3))
  })

  it('owner: no count badge when collaboratorCount is 0 or absent', () => {
    renderToolbar('owner', null, 0)

    const collabBtn = screen.getByTestId('collaborators-button')
    expect(collabBtn.getAttribute('aria-label')).toBeNull()
    expect(collabBtn.textContent).toBe(`👥 ${strings.sharing.toolbar.collaborators}`)
  })

  it('collaborator (viewer): the chip renders in place of the Collaborators button', () => {
    renderToolbar('viewer', { status: 'active', name: 'Marco R.' })

    expect(screen.queryByTestId('collaborators-button')).toBeNull()
    const chip = screen.getByTestId('collaborators-chip')
    expect(chip.textContent).toBe(strings.sharing.toolbar.sharedByChip('Marco R.', 'Viewer'))
    // A collaborator gets no link-sharing escape hatch either.
    expect(screen.queryByRole('button', { name: /share link/i })).toBeNull()
  })

  it('collaborator (editor): the chip names the Editor level', () => {
    renderToolbar('editor', { status: 'active', name: 'Marco R.' })

    const chip = screen.getByTestId('collaborators-chip')
    expect(chip.textContent).toBe(strings.sharing.toolbar.sharedByChip('Marco R.', 'Editor'))
  })

  it('no toolbar control writes an estimate payload to the clipboard', async () => {
    renderToolbar('owner', null, 0)

    // Click every toolbar button except the exports (which really do generate
    // files) and Collaborators (which opens a dialog). None of the rest may
    // copy anything: the old share handler wrote an lz-string estimate payload
    // straight to the clipboard.
    const skip = /client|pdf|excel|collaborators/i
    const buttons = screen.getAllByRole('button').filter((b) => !skip.test(b.textContent ?? ''))
    await act(async () => {
      for (const b of buttons) b.click()
    })

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })
})
