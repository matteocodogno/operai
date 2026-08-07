/**
 * @vitest-environment jsdom
 *
 * T18 (specs/013-estimate-sharing/tasks.md; design.md S4) — integration
 * wiring between EstimatorApp.tsx and the real ConflictBanner: proves
 * "Reload latest" triggers a route invalidate and "Save as a copy" posts
 * the local content, plus the exclusivity/Header-4th-state guarantees.
 *
 * ConflictBanner.test.tsx already covers the component in isolation
 * (copy variants, a11y, that clicking each button calls its prop callback).
 * This file is the other half: that EstimatorApp.tsx wires those callbacks
 * to the REAL `router.invalidate()` / `estimatesApi.create()` calls design.md
 * specifies, using the exact conflict-inducing recipe
 * EstimatorContext.test.tsx's "(F) T16" suite already established (a
 * ConflictError rejection from a mocked estimatesApi.update).
 *
 * Deliberately a separate file from the pre-existing `EstimatorApp.test.tsx`
 * (out of scope for T17/T18 per this task's caller) and from this task's own
 * `EstimatorApp.viewerGating.test.tsx` (T17's concern is readOnly gating,
 * not conflict wiring).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import type { Parameters, Release, Activity } from './types'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const navigateMock = vi.fn()
const invalidateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ invalidate: invalidateMock }),
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
    create: vi.fn(),
  }
})

import * as estimatesApi from './lib/estimatesApi'
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

function NameChangeTrigger() {
  const ctx = useEstimatorContext()
  return (
    <button data-testid="trigger-edit" onClick={() => ctx.setName('Edited Name')}>
      Edit Name
    </button>
  )
}

async function renderIntoConflict() {
  vi.mocked(estimatesApi.update).mockRejectedValueOnce(
    new estimatesApi.ConflictError({
      type: 'https://httpstatuses.com/409',
      title: 'Conflict',
      status: 409,
      code: 'estimate_version_conflict',
      currentVersion: 5,
      updatedAt: '2026-08-07T12:00:00.000Z',
      lastModifiedBy: { status: 'active', name: 'Jane Doe' },
    }),
  )

  render(
    <EstimatorProvider
      estimateId="est-conflict-wiring"
      initialName="Original Name"
      initialAuthor="Test Author"
      initialParams={fixtureParams}
      initialReleases={[fixtureRelease]}
      initialActs={fixtureActs}
      initialAccess="owner"
      initialVersion={3}
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
}

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

describe('EstimatorApp — ConflictBanner replaces the toast zone exclusively (T18, design.md S4)', () => {
  it('renders the ConflictBanner (role="alert") and no ordinary save toast after a 409', async () => {
    await renderIntoConflict()

    const banner = screen.getByTestId('conflict-banner')
    expect(banner).toBeDefined()
    expect(banner.getAttribute('role')).toBe('alert')
    expect(screen.queryByText(/changes stored/i)).toBeNull()
  })

  it("the Header's 4th save-status state renders whenever autosave is suspended", async () => {
    await renderIntoConflict()

    expect(screen.getByText(strings.conflict.savingSuspended)).toBeDefined()
    expect(screen.queryByText('✓ Saved')).toBeNull()
  })
})

describe('EstimatorApp — "Reload latest" triggers a route invalidate (T18)', () => {
  it('calls router.invalidate() when "Reload latest" is clicked', async () => {
    await renderIntoConflict()

    await act(async () => {
      screen.getByRole('button', { name: strings.conflict.reloadButton }).click()
    })

    expect(invalidateMock).toHaveBeenCalledTimes(1)
    // Reload latest never itself calls estimatesApi.create — that is
    // exclusively the "Save as a copy" path.
    expect(vi.mocked(estimatesApi.create)).not.toHaveBeenCalled()
  })
})

describe('EstimatorApp — "Save as a copy instead" posts the local content (T18)', () => {
  it('calls estimatesApi.create with the in-progress local content and navigates to the new estimate', async () => {
    await renderIntoConflict()

    vi.mocked(estimatesApi.create).mockResolvedValueOnce({
      id: 'est-copy-001',
      name: 'Edited Name',
      author: 'Test Author',
      content: { params: fixtureParams, releases: [fixtureRelease], acts: fixtureActs },
      createdAt: '2026-08-07T12:05:00.000Z',
      updatedAt: '2026-08-07T12:05:00.000Z',
      version: 1,
      access: 'owner',
      owner: null,
    })

    await act(async () => {
      screen.getByRole('button', { name: strings.conflict.saveAsCopyButton }).click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(vi.mocked(estimatesApi.create)).toHaveBeenCalledTimes(1)
    const [body] = vi.mocked(estimatesApi.create).mock.calls[0]
    // The IN-PROGRESS edit (from before the conflict fired) is what gets
    // posted — AC-4.2's "in-progress edits stay visible/available" carried
    // through to the copy, not the stale pre-edit content.
    expect(body.name).toBe('Edited Name')
    expect(body.author).toBe('Test Author')
    expect(body.content.acts).toHaveLength(1)
    expect(body.content.releases).toHaveLength(1)

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/estimates/$estimateId',
      params: { estimateId: 'est-copy-001' },
    })
    // Save as a copy never itself calls router.invalidate() — that is
    // exclusively the "Reload latest" path.
    expect(invalidateMock).not.toHaveBeenCalled()
  })
})
