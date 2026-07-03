/**
 * @vitest-environment jsdom
 *
 * Tests for T9 (specs/001-estimate-persistence):
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

// A successful mock response shape
const mockSuccessResponse = {
  id: 'est-001',
  name: 'Test Estimate',
  author: 'Consultant',
  content: { params: fixtureParams, releases: [fixtureRelease], acts: fixtureActs },
  createdAt: '2026-07-03T10:00:00.000Z',
  updatedAt: '2026-07-03T10:00:00.000Z',
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
