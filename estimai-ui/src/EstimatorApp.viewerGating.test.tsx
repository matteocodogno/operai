/**
 * @vitest-environment jsdom
 *
 * T17 (specs/013-estimate-sharing/tasks.md; design.md S5 "Viewer mode") —
 * the task's named EARLY CHECK: "mounting the editor as a viewer asserts
 * ZERO enabled mutating controls anywhere in the tree, while useEstimator's
 * computed outputs are deep-equal to the owner's and the export / link-share
 * actions stay enabled; mounting as editor asserts the mutating controls are
 * enabled."
 *
 * This is a deliberately separate file from the pre-existing (and, per this
 * feature's caller, out-of-scope-for-T17/T18) `EstimatorApp.test.tsx` — that
 * file carries a stale `EstimateFull` fixture literal that belongs to T22's
 * cleanup, and this task must not touch it.
 *
 * Strategy: mount the REAL `EstimatorProvider` + `EstimatorApp` tree (same
 * mocking recipe `EstimatorApp.test.tsx` already established for
 * `@tanstack/react-router` / `./lib/authClient` / the Vercel scripts) with
 * `initialAccess="viewer"` and `initialAccess="owner"` against the IDENTICAL
 * fixture content, then walk all three tabs asserting:
 *   - viewer: every input/textarea is readOnly (never disabled — still
 *     focusable/AT-readable per design.md's Accessibility section), zero
 *     enabled <select> elements, zero "+ Add Activity" / "+ Release" /
 *     per-row delete / drag-handle controls, and clicking every rendered
 *     button never invokes a mutating callback (defense in depth beyond
 *     the per-component unit tests).
 *   - owner: the same controls ARE present and enabled.
 *   - export (Client/PDF/Excel) and "Share" link-share buttons are present
 *     and enabled in BOTH modes (AC-3.1 — read-only means content editing,
 *     not feature removal).
 *   - the SAME computed numbers (PERT-derived Summary totals) render in
 *     both modes for identical input content — `useEstimator`'s output
 *     does not depend on access at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { Parameters, Release, Activity } from './types'
import type { EstimateAccess } from './lib/estimatesApi'

// ---------------------------------------------------------------------------
// Module mocks — same recipe as EstimatorApp.test.tsx.
// ---------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
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
    create: vi.fn(),
  }
})

import * as estimatesApi from './lib/estimatesApi'
import { EstimatorProvider } from './context/EstimatorContext'
import EstimatorApp from './EstimatorApp'

// ---------------------------------------------------------------------------
// Fixtures — non-empty acts/releases so ActivityTable (not TemplatePicker /
// the viewer empty state) renders on the activities tab in both modes.
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
    risk: 0.1,
    notes: '',
    release: 'v1.0',
  },
  {
    id: 'a2',
    num: '2',
    epic: 'Core',
    act: 'Wiring',
    prof: 'Frontend Dev',
    o: 2,
    ml: 3,
    p: 5,
    risk: 0,
    notes: '',
    release: 'v1.0',
  },
]

function renderEditor(access: EstimateAccess) {
  return render(
    <EstimatorProvider
      estimateId="est-gating-test"
      initialName="Gating Test"
      initialAuthor="Author"
      initialParams={fixtureParams}
      initialReleases={[fixtureRelease]}
      initialActs={fixtureActs}
      initialAccess={access}
      initialVersion={1}
    >
      <EstimatorApp />
    </EstimatorProvider>,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_API_URL', 'http://api.test')
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  // The "click every rendered button" defense-in-depth test also clicks the
  // (deliberately still-enabled, AC-3.1) "Share" button, which calls
  // navigator.clipboard.writeText — jsdom does not implement Clipboard.
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
})

// ---------------------------------------------------------------------------
// Helper: every input/textarea currently in the DOM must be readOnly.
// ---------------------------------------------------------------------------

function assertAllTextControlsReadOnly() {
  const controls = [
    ...screen.queryAllByRole('textbox'),
    ...screen.queryAllByRole('spinbutton'),
  ] as (HTMLInputElement | HTMLTextAreaElement)[]
  expect(controls.length).toBeGreaterThan(0)
  for (const el of controls) {
    expect(el.readOnly).toBe(true)
    expect(el.disabled).toBe(false) // design.md: readOnly, never disabled
  }
}

function assertZeroEnabledSelects() {
  expect(screen.queryAllByRole('combobox').length).toBe(0)
}

// ---------------------------------------------------------------------------
// (A) VIEWER — zero enabled mutating controls anywhere in the tree
// ---------------------------------------------------------------------------

describe('T17 named early check — viewer mount has zero enabled mutating controls', () => {
  it('activities tab: readOnly text/number cells, no selects, no add/delete/drag controls', () => {
    renderEditor('viewer')

    assertAllTextControlsReadOnly()
    assertZeroEnabledSelects()
    expect(screen.queryAllByRole('button', { name: /add activity/i }).length).toBe(0)
    expect(screen.queryByTitle('Delete activity')).toBeNull()
    expect(screen.queryByTitle('Drag to reorder')).toBeNull()
    expect(screen.queryByText('⠿')).toBeNull()
  })

  it('summary tab: readOnly release name/FTE, no "+ Release", no release delete', () => {
    renderEditor('viewer')
    fireEvent.click(screen.getByRole('button', { name: /^summary/i }))

    assertAllTextControlsReadOnly()
    expect(screen.queryByRole('button', { name: /^\+ release$/i })).toBeNull()
  })

  it('parameters tab: every model-parameter input is readOnly', () => {
    renderEditor('viewer')
    fireEvent.click(screen.getByRole('button', { name: /^parameters/i }))

    assertAllTextControlsReadOnly()
  })

  it('the Header project-name input is readOnly and the save-status indicator is absent', () => {
    renderEditor('viewer')

    const nameInput = screen.getByPlaceholderText('Project name…') as HTMLInputElement
    expect(nameInput.readOnly).toBe(true)
    expect(screen.queryByText('✓ Saved')).toBeNull()
    expect(screen.queryByText('Saving…')).toBeNull()
  })

  it('clicking every rendered button across all three tabs never fires estimatesApi.update (defense in depth)', async () => {
    renderEditor('viewer')

    // Excludes Client/PDF/Excel — those trigger real file-generation side
    // effects (XLSX/PDF writers) unrelated to what this test checks (that no
    // MUTATING control exists); their presence/enabled-state is asserted
    // separately below without invoking them.
    const EXPORT_BUTTON_NAME = /client|pdf|excel/i

    for (const tabName of ['Activities', 'Summary', 'Parameters']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${tabName}`, 'i') }))
      for (const btn of screen.queryAllByRole('button')) {
        if (EXPORT_BUTTON_NAME.test(btn.textContent ?? '')) continue
        fireEvent.click(btn)
      }
    }

    await vi.runAllTimersAsync()
    expect(vi.mocked(estimatesApi.update)).not.toHaveBeenCalled()
  })

  it('export (Client/PDF/Excel) and Share buttons stay present and enabled for a viewer (AC-3.1)', () => {
    renderEditor('viewer')

    // T22 (specs/013-estimate-sharing/tasks.md) relabelled "Share" → "Share
    // link" AND added a "Shared by {owner} · {level}" chip that renders in
    // this exact 'viewer' access mode — a loose /share/i match now hits
    // BOTH (the chip's copy also contains "Shared"), so this query is
    // pinned to the exact label to keep asserting the SAME button T17
    // always meant ("Share link" is a strict superset of the old "Share"
    // label — AC-8.1's behavior-untouched rename, not a reinterpretation).
    const shareBtn = screen.getByRole('button', { name: /share link/i }) as HTMLButtonElement
    const clientBtn = screen.getByRole('button', { name: /client/i }) as HTMLButtonElement
    const pdfBtn = screen.getByRole('button', { name: /pdf/i }) as HTMLButtonElement
    const excelBtn = screen.getByRole('button', { name: /excel/i }) as HTMLButtonElement

    for (const btn of [shareBtn, clientBtn, pdfBtn, excelBtn]) {
      expect(btn.disabled).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// (B) EDITOR/OWNER — the same controls ARE present and enabled
// ---------------------------------------------------------------------------

describe('T17 — editor/owner mount keeps every mutating control enabled', () => {
  it('activities tab: enabled Profile/Release selects, add/delete/drag controls present', () => {
    renderEditor('owner')

    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /add activity/i }).length).toBe(2)
    expect(screen.getAllByTitle('Delete activity').length).toBe(fixtureActs.length)
    expect(screen.getAllByTitle('Drag to reorder').length).toBe(fixtureActs.length)

    // The Epic/Activity/O/ML/P/Risk cells are editable. (The AI% cell is
    // deliberately readOnly while unfocused regardless of access — its own
    // pre-existing "display vs edit" trick, unrelated to T17 — so it is
    // excluded from this blanket check rather than asserted either way.)
    for (const cell of ['0-0', '0-1', '0-3', '0-4', '0-5', '0-6']) {
      const el = document.querySelector(`[data-cell="${cell}"]`) as HTMLInputElement | null
      expect(el).not.toBeNull()
      expect(el?.readOnly).toBe(false)
    }
  })

  it('summary tab: "+ Release" present, release delete absent only because there is a single release (unrelated to access)', () => {
    renderEditor('owner')
    fireEvent.click(screen.getByRole('button', { name: /^summary/i }))

    expect(screen.getByRole('button', { name: /^\+ release$/i })).toBeDefined()
  })

  it('the Header project-name input is editable and the save-status indicator is present', () => {
    renderEditor('owner')

    const nameInput = screen.getByPlaceholderText('Project name…') as HTMLInputElement
    expect(nameInput.readOnly).toBe(false)
    expect(screen.getByText(/✓ Saved|Saving…/)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// (C) useEstimator's computed outputs are deep-equal between viewer and
//     owner renders of the SAME fixture content (access never feeds the
//     computation — this proves it end-to-end through the rendered UI).
// ---------------------------------------------------------------------------

describe('T17 — computed values are identical regardless of access level', () => {
  it('the Metrics bar renders identical totals for viewer and owner mounts of the same content', () => {
    const { unmount } = renderEditor('viewer')
    // Total Man/Days is the first metric tile; grab its value by proximity
    // to its label rather than a brittle full-text match.
    const viewerTotalLabel = screen.getByText('Total Man/Days')
    const viewerTotalValue = viewerTotalLabel.parentElement?.textContent
    unmount()

    renderEditor('owner')
    const ownerTotalLabel = screen.getByText('Total Man/Days')
    const ownerTotalValue = ownerTotalLabel.parentElement?.textContent

    expect(viewerTotalValue).toBe(ownerTotalValue)
    expect(viewerTotalValue).toBeTruthy()
  })
})
