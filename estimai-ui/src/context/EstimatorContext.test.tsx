/**
 * @vitest-environment jsdom
 *
 * Tests for T9 + T11 (specs/001-estimate-persistence):
 *
 *   (A) Load — EstimatorProvider initialised from API content: the editor
 *       renders the loaded name/author and computed values (PERT/Expected/
 *       Elapsed) match the estimation model for the fixture content (AC-2.2).
 *
 *   (B) Save — an edit (name change) triggers a debounced estimatesApi.update
 *       call with the correct id and body (AC-1.1 / AC-1.2 client side).
 *       Uses fake timers to control the debounce.
 *
 *   (C) Save-failure — when estimatesApi.update rejects, the error state is
 *       surfaced AND the in-memory estimate state (name, author, acts, params)
 *       is unchanged (AC-1.3 — nothing lost / overwritten).
 *       This test is designed to FAIL if the failure path clears/overwrites
 *       state.
 *
 *   (D) 413 size-limit rejection — T11 (AC-1.4 client side): a 413 ApiError
 *       produces a SPECIFIC, size-limit message (distinct from generic errors),
 *       the server's Problem `detail` is surfaced when available, in-memory
 *       state (name/acts/releases) is unchanged, and a subsequent successful
 *       save clears the error.
 *
 * Strategy:
 *   • estimatesApi is mocked at the module level via vi.mock.
 *   • A minimal wrapper component reads from EstimatorContext so the test can
 *     assert the exposed values.
 *   • Fake timers (vi.useFakeTimers) are used for the debounce; the test
 *     advances time with vi.runAllTimersAsync() to flush the debounce and
 *     awaits the rejection settlement in a single act() block.
 *   • waitFor is avoided in fake-timer tests; instead we flush timers and
 *     promises together with act(async () => { await vi.runAllTimersAsync() }).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { EstimatorProvider, useEstimatorContext } from './EstimatorContext'
import { computeRelease, pertCalc } from '../hooks/useEstimator'
import type { Activity, Parameters, Release } from '../types'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted.
// ---------------------------------------------------------------------------

vi.mock('../lib/estimatesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/estimatesApi')>()
  return {
    ...original,
    update: vi.fn(),
  }
})

import * as estimatesApi from '../lib/estimatesApi'

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
    epic: 'Auth',
    act: 'Login page',
    prof: 'Frontend Dev',
    o: 1,
    ml: 2,
    p: 4,
    risk: 0.1,
    notes: '',
    release: 'v1.0',
  },
  {
    id: 'a2',
    num: '2',
    epic: 'Auth',
    act: 'Registration page',
    prof: 'Frontend Dev',
    o: 2,
    ml: 3,
    p: 5,
    risk: 0.2,
    notes: '',
    release: 'v1.0',
  },
]

// A successful mock response shape.
//
// T15 (specs/013-estimate-sharing/tasks.md) widened `EstimateFull` with
// `version`/`access`/`owner` (T16's fixture note: "the tree does not
// typecheck until they are fixed"). `version: 1` matches every fixture
// provider render below, none of which pass `initialVersion` — so the
// EstimatorProvider default (also 1, see EstimatorContext.tsx) and this
// mock's starting version agree; `access: 'owner'` matches the (also
// defaulted) `initialAccess` so tests (A)-(E), predating T16, keep their
// original full-edit behaviour unchanged.
const mockSuccessResponse = {
  id: 'est-001',
  name: 'Test Estimate',
  author: 'Consultant',
  content: { params: fixtureParams, releases: [fixtureRelease], acts: fixtureActs },
  createdAt: '2026-07-03T10:00:00.000Z',
  updatedAt: '2026-07-03T10:00:00.000Z',
  version: 1,
  access: 'owner' as const,
  owner: null,
}

// ---------------------------------------------------------------------------
// Helper: a minimal consumer component that exposes context values via
// data-testid attributes so tests can read them without a full UI render.
// ---------------------------------------------------------------------------

function ContextConsumer() {
  const ctx = useEstimatorContext()
  const rel = ctx.releases[0]
  const releaseResult = rel
    ? computeRelease(
        ctx.acts.filter(a => a.release === rel.name),
        rel,
        ctx.params,
      )
    : null

  // Compute expected PERT for each activity
  const pertValues = ctx.acts.map(a => pertCalc(a.o, a.ml, a.p))
  const expectedValues = ctx.acts.map((a, i) => pertValues[i] + (Number(a.risk) || 0))

  return (
    <div>
      <span data-testid="ctx-name">{ctx.name}</span>
      <span data-testid="ctx-author">{ctx.author}</span>
      <span data-testid="ctx-acts-count">{ctx.acts.length}</span>
      <span data-testid="ctx-releases-count">{ctx.releases.length}</span>
      <span data-testid="ctx-save-status">{ctx.saveStatus}</span>
      <span data-testid="ctx-save-error">{ctx.saveError ?? ''}</span>
      {releaseResult && (
        <>
          <span data-testid="ctx-elapsed">{releaseResult.el}</span>
          <span data-testid="ctx-total-md">{releaseResult.tm}</span>
        </>
      )}
      {expectedValues.map((ev, i) => (
        <span key={i} data-testid={`ctx-expected-${i}`}>
          {ev.toFixed(2)}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_API_URL', 'http://api.test')
  // Default: update succeeds
  vi.mocked(estimatesApi.update).mockResolvedValue(mockSuccessResponse)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
})

// ---------------------------------------------------------------------------
// (A) LOAD — content from initialProps is reflected in context and model
// ---------------------------------------------------------------------------

describe('(A) Load: EstimatorProvider initialised from API content', () => {
  it('renders the loaded name and author from the fixture', () => {
    render(
      <EstimatorProvider
        estimateId="est-001"
        initialName="Test Estimate"
        initialAuthor="Consultant"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <ContextConsumer />
      </EstimatorProvider>,
    )

    expect(screen.getByTestId('ctx-name').textContent).toBe('Test Estimate')
    expect(screen.getByTestId('ctx-author').textContent).toBe('Consultant')
  })

  it('exposes all loaded activities and releases', () => {
    render(
      <EstimatorProvider
        estimateId="est-001"
        initialName="Test Estimate"
        initialAuthor="Consultant"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <ContextConsumer />
      </EstimatorProvider>,
    )

    expect(screen.getByTestId('ctx-acts-count').textContent).toBe('2')
    expect(screen.getByTestId('ctx-releases-count').textContent).toBe('1')
  })

  it('computes PERT correctly for each loaded activity (AC-2.2)', () => {
    render(
      <EstimatorProvider
        estimateId="est-001"
        initialName="Test Estimate"
        initialAuthor="Consultant"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <ContextConsumer />
      </EstimatorProvider>,
    )

    // Activity 0: o=1, ml=2, p=4 → PERT = (1 + 8 + 4)/6 = 2.1667; expected = PERT + risk(0.1)
    const expectedA0 = pertCalc(1, 2, 4) + 0.1
    expect(screen.getByTestId('ctx-expected-0').textContent).toBe(expectedA0.toFixed(2))

    // Activity 1: o=2, ml=3, p=5 → PERT = (2 + 12 + 5)/6 = 3.1667; expected = PERT + risk(0.2)
    const expectedA1 = pertCalc(2, 3, 5) + 0.2
    expect(screen.getByTestId('ctx-expected-1').textContent).toBe(expectedA1.toFixed(2))
  })

  it('computes Elapsed and Total Man-Days matching the model (AC-2.2)', () => {
    render(
      <EstimatorProvider
        estimateId="est-001"
        initialName="Test Estimate"
        initialAuthor="Consultant"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <ContextConsumer />
      </EstimatorProvider>,
    )

    const modelResult = computeRelease(fixtureActs, fixtureRelease, fixtureParams)
    expect(modelResult).not.toBeNull()

    expect(screen.getByTestId('ctx-elapsed').textContent).toBe(String(modelResult!.el))
    expect(screen.getByTestId('ctx-total-md').textContent).toBe(String(modelResult!.tm))
  })
})

// ---------------------------------------------------------------------------
// (B) SAVE — debounced PUT call with the correct id and body
// ---------------------------------------------------------------------------

describe('(B) Save: edit triggers debounced estimatesApi.update', () => {
  it('does NOT call estimatesApi.update on initial mount (no spurious save)', async () => {
    render(
      <EstimatorProvider
        estimateId="est-001"
        initialName="Test Estimate"
        initialAuthor="Consultant"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <ContextConsumer />
      </EstimatorProvider>,
    )

    // Flush all timers — no save should have been triggered on first render
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(vi.mocked(estimatesApi.update)).not.toHaveBeenCalled()
  })

  it('calls estimatesApi.update with the correct id after a state change (AC-1.1/1.2)', async () => {
    function NameChanger() {
      const ctx = useEstimatorContext()
      return <button onClick={() => ctx.setName('Updated Name')}>Change Name</button>
    }

    render(
      <EstimatorProvider
        estimateId="est-001"
        initialName="Test Estimate"
        initialAuthor="Consultant"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <ContextConsumer />
        <NameChanger />
      </EstimatorProvider>,
    )

    // Trigger the name change (simulates the user editing the project name)
    await act(async () => {
      screen.getByRole('button', { name: 'Change Name' }).click()
    })

    // Advance fake timers to flush the debounce + resolve the mock promise
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(vi.mocked(estimatesApi.update)).toHaveBeenCalledTimes(1)
    const [calledId, calledBody] = vi.mocked(estimatesApi.update).mock.calls[0]
    expect(calledId).toBe('est-001')
    // Body must include the updated name
    expect(calledBody.name).toBe('Updated Name')
    // Body must include author and content
    expect(calledBody.author).toBe('Consultant')
    expect(calledBody.content).toBeDefined()
    expect(calledBody.content.releases).toHaveLength(1)
    expect(calledBody.content.acts).toHaveLength(2)
  })

  it('debounces: multiple rapid changes result in a single API call', async () => {
    function MultiChanger() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button data-testid="ch1" onClick={() => ctx.setName('Name A')}>
            A
          </button>
          <button data-testid="ch2" onClick={() => ctx.setName('Name B')}>
            B
          </button>
          <button data-testid="ch3" onClick={() => ctx.setName('Name C')}>
            C
          </button>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-002"
        initialName="Initial"
        initialAuthor="Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <MultiChanger />
      </EstimatorProvider>,
    )

    // Rapidly trigger three changes
    await act(async () => {
      screen.getByTestId('ch1').click()
      screen.getByTestId('ch2').click()
      screen.getByTestId('ch3').click()
    })

    // Flush debounce
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Only one API call should have been made (the last state)
    expect(vi.mocked(estimatesApi.update)).toHaveBeenCalledTimes(1)
    const [, body] = vi.mocked(estimatesApi.update).mock.calls[0]
    expect(body.name).toBe('Name C')
  })
})

// ---------------------------------------------------------------------------
// (C) SAVE-FAILURE — error surfaced; in-memory state UNCHANGED (AC-1.3)
//
// This is the KEY test: it will FAIL if the failure handler clears or
// overwrites the in-memory estimate state (name / author / acts).
// ---------------------------------------------------------------------------

describe('(C) Save-failure: error shown, in-memory state preserved (AC-1.3)', () => {
  it('sets saveStatus to "error" when estimatesApi.update rejects', async () => {
    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/500',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Unexpected server error',
      }),
    )

    function FailureTrigger() {
      const ctx = useEstimatorContext()
      return <button onClick={() => ctx.setName('Will Fail')}>Trigger Failure</button>
    }

    render(
      <EstimatorProvider
        estimateId="est-003"
        initialName="Original Name"
        initialAuthor="Original Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <ContextConsumer />
        <FailureTrigger />
      </EstimatorProvider>,
    )

    // Trigger state change → will fire the debounced update (which rejects)
    await act(async () => {
      screen.getByRole('button', { name: 'Trigger Failure' }).click()
    })

    // Flush debounce + settle the rejected promise in one act
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // The save status must be 'error'
    expect(screen.getByTestId('ctx-save-status').textContent).toBe('error')
    // The error message must be non-empty
    expect(screen.getByTestId('ctx-save-error').textContent).not.toBe('')
  })

  it('PRESERVES in-memory name, author, acts, and releases after a save failure (AC-1.3)', async () => {
    // KEY: this test FAILS if the failure path clears or overwrites any state.
    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/503',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Cannot connect to server',
      }),
    )

    function EditAndCheck() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button onClick={() => ctx.setName('Edited Name')}>Edit Name</button>
          <span data-testid="check-name">{ctx.name}</span>
          <span data-testid="check-author">{ctx.author}</span>
          <span data-testid="check-acts">{ctx.acts.length}</span>
          <span data-testid="check-releases">{ctx.releases.length}</span>
          <span data-testid="check-status">{ctx.saveStatus}</span>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-004"
        initialName="Preserved Name"
        initialAuthor="Preserved Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <EditAndCheck />
      </EstimatorProvider>,
    )

    // Trigger the edit
    await act(async () => {
      screen.getByRole('button', { name: 'Edit Name' }).click()
    })

    // After the edit but BEFORE the debounce fires, the name already reflects the edit
    expect(screen.getByTestId('check-name').textContent).toBe('Edited Name')

    // Flush debounce + settle rejected promise
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Save status must be error
    expect(screen.getByTestId('check-status').textContent).toBe('error')

    // ── KEY ASSERTIONS: in-memory state must be unchanged / not overwritten ──
    // The edited name must still be present (failure does not revert the edit)
    expect(screen.getByTestId('check-name').textContent).toBe('Edited Name')
    // Author must be intact
    expect(screen.getByTestId('check-author').textContent).toBe('Preserved Author')
    // Acts must be intact (2 fixture activities, not 0)
    expect(screen.getByTestId('check-acts').textContent).toBe('2')
    // Releases must be intact
    expect(screen.getByTestId('check-releases').textContent).toBe('1')
  })

  it('clears the save error after a subsequent successful save', async () => {
    // First call fails, second call succeeds
    vi.mocked(estimatesApi.update)
      .mockRejectedValueOnce(
        new estimatesApi.ApiError({
          type: 'https://httpstatuses.com/503',
          title: 'Service Unavailable',
          status: 503,
        }),
      )
      .mockResolvedValueOnce({
        ...mockSuccessResponse,
        name: 'Change 2',
        updatedAt: '2026-07-03T11:00:00.000Z',
      })

    function EditHelper() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button data-testid="edit1" onClick={() => ctx.setName('Change 1')}>
            Change 1
          </button>
          <button data-testid="edit2" onClick={() => ctx.setName('Change 2')}>
            Change 2
          </button>
          <span data-testid="err">{ctx.saveError ?? ''}</span>
          <span data-testid="status">{ctx.saveStatus}</span>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-005"
        initialName="Original"
        initialAuthor="Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <EditHelper />
      </EstimatorProvider>,
    )

    // First edit → fails
    await act(async () => {
      screen.getByTestId('edit1').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Error must be set after first (failing) save
    expect(screen.getByTestId('status').textContent).toBe('error')
    expect(screen.getByTestId('err').textContent).not.toBe('')

    // Second edit → succeeds
    await act(async () => {
      screen.getByTestId('edit2').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Error should be cleared after successful save
    expect(screen.getByTestId('err').textContent).toBe('')
  })
})

// ---------------------------------------------------------------------------
// (D) 413 SIZE-LIMIT REJECTION — T11 (AC-1.4 client side)
//
// Key assertions:
//   1. A 413 ApiError with a Problem `detail` surfaces THAT detail string as
//      the saveError (not a generic "Save failed (413)..." message) — this
//      test FAILS if 413 falls through to the generic branch.
//   2. The saveError message contains size/too-large phrasing (non-vacuous:
//      would fail if the handler produced a generic error like "Save failed").
//   3. In-memory state (name, acts, releases) is UNCHANGED after the 413 —
//      fails if state were wiped or reverted.
//   4. A non-413 ApiError (e.g. 503) produces the generic message (regression
//      of T9 — the 503 path must NOT gain size-limit phrasing).
//   5. A successful save after a 413 clears the error.
// ---------------------------------------------------------------------------

describe('(D) 413 size-limit rejection: specific message + state preserved (T11 / AC-1.4)', () => {
  it('surfaces the server Problem detail as saveError on a 413 (not a generic message)', async () => {
    // The server's Problem detail for a 413 — matches the plan.md shape:
    // "Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved."
    const serverDetail = 'Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.'

    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/413',
        title: 'Payload Too Large',
        status: 413,
        detail: serverDetail,
      }),
    )

    function Trigger() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button onClick={() => ctx.setName('Big Estimate')}>Trigger</button>
          <span data-testid="d-save-error">{ctx.saveError ?? ''}</span>
          <span data-testid="d-save-status">{ctx.saveStatus}</span>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-413-a"
        initialName="Original"
        initialAuthor="Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <Trigger />
      </EstimatorProvider>,
    )

    await act(async () => {
      screen.getByRole('button', { name: 'Trigger' }).click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByTestId('d-save-status').textContent).toBe('error')

    // The saveError MUST be the server's detail string — not a generic message.
    // This assertion FAILS if 413 fell through to the generic branch which would
    // produce "Save failed (413). Your work is safe in this tab." instead.
    const saveError = screen.getByTestId('d-save-error').textContent
    expect(saveError).toBe(serverDetail)

    // Non-vacuous: the message must reference size/payload/MB — proving it is
    // specifically a size-limit message, not any arbitrary non-empty string.
    expect(saveError).toMatch(/MB|too large|maximum|size|payload/i)
  })

  it('uses a clear size-limit fallback message when the 413 has no detail', async () => {
    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/413',
        title: 'Payload Too Large',
        status: 413,
        // no detail property
      }),
    )

    function Trigger() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button onClick={() => ctx.setName('Big Estimate No Detail')}>Trigger</button>
          <span data-testid="d-save-error-fallback">{ctx.saveError ?? ''}</span>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-413-b"
        initialName="Original"
        initialAuthor="Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <Trigger />
      </EstimatorProvider>,
    )

    await act(async () => {
      screen.getByRole('button', { name: 'Trigger' }).click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const saveError = screen.getByTestId('d-save-error-fallback').textContent
    // The fallback must not be empty and must contain size-limit phrasing
    expect(saveError).not.toBe('')
    expect(saveError).toMatch(/too large|maximum|size/i)
    // Must NOT be the generic non-413 message
    expect(saveError).not.toMatch(/Check your connection/i)
  })

  it('PRESERVES in-memory name, acts, and releases after a 413 (nothing lost)', async () => {
    // KEY: this test FAILS if the 413 handler clears or overwrites any estimate state.
    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/413',
        title: 'Payload Too Large',
        status: 413,
        detail: 'Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.',
      }),
    )

    function EditAndCheck() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button onClick={() => ctx.setName('Edited While Too Large')}>Edit</button>
          <span data-testid="d-name">{ctx.name}</span>
          <span data-testid="d-author">{ctx.author}</span>
          <span data-testid="d-acts">{ctx.acts.length}</span>
          <span data-testid="d-releases">{ctx.releases.length}</span>
          <span data-testid="d-status">{ctx.saveStatus}</span>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-413-c"
        initialName="Big Project"
        initialAuthor="Preserved Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <EditAndCheck />
      </EstimatorProvider>,
    )

    await act(async () => {
      screen.getByRole('button', { name: 'Edit' }).click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Save status must be 'error'
    expect(screen.getByTestId('d-status').textContent).toBe('error')

    // ── KEY ASSERTIONS: in-memory state must be unchanged ──
    // The edited name must still be present (failure does not revert the edit)
    expect(screen.getByTestId('d-name').textContent).toBe('Edited While Too Large')
    // Author intact (AC-1.3 / AC-1.4 — nothing lost)
    expect(screen.getByTestId('d-author').textContent).toBe('Preserved Author')
    // Acts intact (2 fixture activities, not 0)
    expect(screen.getByTestId('d-acts').textContent).toBe('2')
    // Releases intact
    expect(screen.getByTestId('d-releases').textContent).toBe('1')
  })

  it('non-413 failure (503) does NOT produce size-limit phrasing (T9 regression guard)', async () => {
    // This test FAILS if a 503 accidentally gains size-limit phrasing.
    // The 503 has no detail — so the fallback "Save failed (503)…" fires.
    vi.mocked(estimatesApi.update).mockRejectedValue(
      new estimatesApi.ApiError({
        type: 'https://httpstatuses.com/503',
        title: 'Service Unavailable',
        status: 503,
        // no detail — ensures the status-code fallback path fires
      }),
    )

    function Trigger() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button onClick={() => ctx.setName('Any Change')}>Trigger</button>
          <span data-testid="d-generic-error">{ctx.saveError ?? ''}</span>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-503"
        initialName="Original"
        initialAuthor="Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <Trigger />
      </EstimatorProvider>,
    )

    await act(async () => {
      screen.getByRole('button', { name: 'Trigger' }).click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const saveError = screen.getByTestId('d-generic-error').textContent
    // Must be a non-empty error message
    expect(saveError).not.toBe('')
    // Must contain the status code (non-413 fallback) — NOT size-limit phrasing
    expect(saveError).toContain('503')
    expect(saveError).not.toMatch(/too large|maximum|MB|size/i)
  })

  it('clears the 413 error after a subsequent successful save', async () => {
    // First call → 413; second call → success
    vi.mocked(estimatesApi.update)
      .mockRejectedValueOnce(
        new estimatesApi.ApiError({
          type: 'https://httpstatuses.com/413',
          title: 'Payload Too Large',
          status: 413,
          detail: 'Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.',
        }),
      )
      .mockResolvedValueOnce({
        ...mockSuccessResponse,
        name: 'Trimmed Estimate',
        updatedAt: '2026-07-03T12:00:00.000Z',
      })

    function EditHelper() {
      const ctx = useEstimatorContext()
      return (
        <>
          <button data-testid="too-large" onClick={() => ctx.setName('Too Large')}>
            Too Large
          </button>
          <button data-testid="trimmed" onClick={() => ctx.setName('Trimmed Estimate')}>
            Trimmed
          </button>
          <span data-testid="d-err-after-clear">{ctx.saveError ?? ''}</span>
          <span data-testid="d-status-after-clear">{ctx.saveStatus}</span>
        </>
      )
    }

    render(
      <EstimatorProvider
        estimateId="est-413-d"
        initialName="Original"
        initialAuthor="Author"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <EditHelper />
      </EstimatorProvider>,
    )

    // First edit → 413
    await act(async () => {
      screen.getByTestId('too-large').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByTestId('d-status-after-clear').textContent).toBe('error')
    expect(screen.getByTestId('d-err-after-clear').textContent).not.toBe('')

    // Second edit → success (simulates user removing activities and re-saving)
    await act(async () => {
      screen.getByTestId('trimmed').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Error must be cleared after successful save
    expect(screen.getByTestId('d-err-after-clear').textContent).toBe('')
    // Status cycles back through 'saved' then 'idle'; at minimum it is not 'error'
    expect(screen.getByTestId('d-status-after-clear').textContent).not.toBe('error')
  })
})

// ---------------------------------------------------------------------------
// (E) Rename cascade — renaming a release re-points its linked activities so
//     they are not orphaned (activities link to a release by name).
// ---------------------------------------------------------------------------

// Consumer that exposes updRel and the count of activities linked to r1 by name.
function RenameConsumer() {
  const ctx = useEstimatorContext()
  const linked = ctx.acts.filter(a => a.release === ctx.releases[0]?.name).length
  return (
    <div>
      <span data-testid="e-release-name">{ctx.releases[0]?.name}</span>
      <span data-testid="e-linked-count">{linked}</span>
      <button data-testid="e-rename" onClick={() => ctx.updRel('r1', 'name', 'v2.0')} />
    </div>
  )
}

describe('(E) Rename cascade: renaming a release keeps its activities linked', () => {
  it('re-points every activity that referenced the old release name', () => {
    render(
      <EstimatorProvider
        estimateId="est-001"
        initialName="Test Estimate"
        initialAuthor="Consultant"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
      >
        <RenameConsumer />
      </EstimatorProvider>,
    )

    // Both fixture activities are linked to 'v1.0' before the rename.
    expect(screen.getByTestId('e-release-name').textContent).toBe('v1.0')
    expect(screen.getByTestId('e-linked-count').textContent).toBe('2')

    act(() => {
      screen.getByTestId('e-rename').click()
    })

    // After the rename the release is 'v2.0' and BOTH activities still link to it.
    expect(screen.getByTestId('e-release-name').textContent).toBe('v2.0')
    expect(screen.getByTestId('e-linked-count').textContent).toBe('2')
  })
})

// ---------------------------------------------------------------------------
// (F) T16 (specs/013-estimate-sharing/tasks.md) — access-derived `canEdit`
//     gating and 409/428 conflict suppression:
//
//   (a) a viewer fires ZERO PUTs, even after a state change (AC-3.1/AC-3.3
//       — defense in depth, independent of T17's UI-level gating: the
//       context itself must refuse, not just hide the controls)
//   (b) an editor/owner save sends `If-Match` with the currently-known
//       version and adopts the server's returned version for the next
//       save (AC-3.2, ADR-0038)
//   (c) a ConflictError (409 or 428) enters `conflict`, and SUSPENDS every
//       future autosave attempt — advancing timers by 10× the debounce
//       after the conflict fires NO further PUT (plan.md "Test strategy":
//       "the autosave-suppression test")
//   (d) name/author/params/releases/acts are left untouched by a conflict
//       (AC-4.2) — the user's in-progress edits stay visible
// ---------------------------------------------------------------------------

// Mirrors EstimatorContext.tsx's private AUTOSAVE_DEBOUNCE_MS (not exported —
// the debounce interval is an internal implementation detail, not part of
// the public context contract) so this file's "10× the debounce" assertion
// stays self-documenting rather than a bare magic number.
const AUTOSAVE_DEBOUNCE_MS = 1500

function ConflictConsumer() {
  const ctx = useEstimatorContext()
  return (
    <div>
      <span data-testid="f-access">{ctx.access}</span>
      <span data-testid="f-can-edit">{String(ctx.canEdit)}</span>
      <span data-testid="f-version">{ctx.version}</span>
      <span data-testid="f-conflict-status">{ctx.conflict ? ctx.conflict.status : ''}</span>
      <span data-testid="f-save-status">{ctx.saveStatus}</span>
      <span data-testid="f-name">{ctx.name}</span>
      <span data-testid="f-acts">{ctx.acts.length}</span>
      <span data-testid="f-releases">{ctx.releases.length}</span>
      <button data-testid="f-edit-1" onClick={() => ctx.setName('Edit 1')}>
        Edit 1
      </button>
      <button data-testid="f-edit-2" onClick={() => ctx.setName('Edit 2')}>
        Edit 2
      </button>
    </div>
  )
}

describe('(F) T16: canEdit gating + conflict suppression', () => {
  it('a viewer fires zero PUTs, even after a state change (AC-3.1/AC-3.3)', async () => {
    render(
      <EstimatorProvider
        estimateId="est-viewer"
        initialName="Viewer Estimate"
        initialAuthor="Owner"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
        initialAccess="viewer"
        initialVersion={3}
      >
        <ConflictConsumer />
      </EstimatorProvider>,
    )

    expect(screen.getByTestId('f-access').textContent).toBe('viewer')
    expect(screen.getByTestId('f-can-edit').textContent).toBe('false')

    // Nothing in the real UI would let a viewer call setName (T17 gates
    // every mutating control on canEdit), but the context-level effect
    // itself must independently refuse to schedule a save if state ever
    // changes under it regardless — the strongest guarantee, and the one
    // this test proves directly.
    await act(async () => {
      screen.getByTestId('f-edit-1').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(vi.mocked(estimatesApi.update)).not.toHaveBeenCalled()
  })

  it('an editor save sends If-Match with the known version and adopts the returned version (AC-3.2)', async () => {
    vi.mocked(estimatesApi.update).mockResolvedValueOnce({
      ...mockSuccessResponse,
      name: 'Edit 1',
      access: 'editor',
      version: 4,
    })

    render(
      <EstimatorProvider
        estimateId="est-editor"
        initialName="Editor Estimate"
        initialAuthor="Owner"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
        initialAccess="editor"
        initialVersion={3}
      >
        <ConflictConsumer />
      </EstimatorProvider>,
    )

    expect(screen.getByTestId('f-can-edit').textContent).toBe('true')
    expect(screen.getByTestId('f-version').textContent).toBe('3')

    await act(async () => {
      screen.getByTestId('f-edit-1').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(vi.mocked(estimatesApi.update)).toHaveBeenCalledTimes(1)
    const [, , sentVersion] = vi.mocked(estimatesApi.update).mock.calls[0]
    expect(sentVersion).toBe(3)

    // The returned version (4) is adopted — the *next* save would use it.
    expect(screen.getByTestId('f-version').textContent).toBe('4')
  })

  it('a 409 ConflictError enters conflict, leaves state untouched, and suspends further autosaves (AC-4.1/AC-4.2)', async () => {
    vi.mocked(estimatesApi.update).mockRejectedValueOnce(
      new estimatesApi.ConflictError({
        type: 'https://httpstatuses.com/409',
        title: 'Conflict',
        status: 409,
        code: 'estimate_version_conflict',
        currentVersion: 5,
        updatedAt: '2026-07-03T12:00:00.000Z',
        lastModifiedBy: { status: 'active', name: 'Jane Doe' },
      }),
    )

    render(
      <EstimatorProvider
        estimateId="est-conflict"
        initialName="Original"
        initialAuthor="Owner"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
        initialAccess="owner"
        initialVersion={3}
      >
        <ConflictConsumer />
      </EstimatorProvider>,
    )

    await act(async () => {
      screen.getByTestId('f-edit-1').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Exactly one PUT fired, and it was refused.
    expect(vi.mocked(estimatesApi.update)).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('f-conflict-status').textContent).toBe('409')
    expect(screen.getByTestId('f-save-status').textContent).toBe('conflict')

    // AC-4.2: the user's in-progress edit is still present — never reverted
    // or discarded by conflict detection.
    expect(screen.getByTestId('f-name').textContent).toBe('Edit 1')
    expect(screen.getByTestId('f-acts').textContent).toBe('2')
    expect(screen.getByTestId('f-releases').textContent).toBe('1')

    // THE autosave-suppression test (plan.md "Test strategy"): a further
    // edit, then advancing timers by 10× the debounce, must fire NO
    // additional PUT — otherwise the debounce becomes a retry storm
    // against a server that will keep 409-ing.
    await act(async () => {
      screen.getByTestId('f-edit-2').click()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 10)
    })

    expect(vi.mocked(estimatesApi.update)).toHaveBeenCalledTimes(1)
    // The second edit is still reflected locally — only autosave is
    // suspended, never the user's ability to keep typing.
    expect(screen.getByTestId('f-name').textContent).toBe('Edit 2')
  })

  it('a 428 ConflictError (stale client, no version yet) also enters conflict and suspends autosave', async () => {
    vi.mocked(estimatesApi.update).mockRejectedValueOnce(
      new estimatesApi.ConflictError({
        type: 'https://httpstatuses.com/428',
        title: 'Precondition Required',
        status: 428,
        code: 'precondition_required',
        // No currentVersion/updatedAt/lastModifiedBy on 428 — there is
        // nothing yet to compare against (ConflictError's own contract).
      }),
    )

    render(
      <EstimatorProvider
        estimateId="est-428"
        initialName="Original"
        initialAuthor="Owner"
        initialParams={fixtureParams}
        initialReleases={[fixtureRelease]}
        initialActs={fixtureActs}
        initialAccess="owner"
        initialVersion={1}
      >
        <ConflictConsumer />
      </EstimatorProvider>,
    )

    await act(async () => {
      screen.getByTestId('f-edit-1').click()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByTestId('f-conflict-status').textContent).toBe('428')
    expect(screen.getByTestId('f-save-status').textContent).toBe('conflict')

    await act(async () => {
      screen.getByTestId('f-edit-2').click()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 10)
    })

    expect(vi.mocked(estimatesApi.update)).toHaveBeenCalledTimes(1)
  })
})
