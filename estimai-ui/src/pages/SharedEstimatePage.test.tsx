/**
 * @vitest-environment jsdom
 *
 * Component tests for SharedEstimatePage (specs/003-suite-shell, T14, AC-4.2;
 * specs/013-estimate-sharing, T24 — see the bottom describe block).
 *
 * The page used to render its own small static logo mark (`<img>`) next to
 * "Powered by EstimAI" in its header — that's removed now, to avoid double
 * branding next to the shell's own logo. Everything else in the header
 * (read-only badge, estimate name/author, "Save to My Estimates", "My
 * Estimates" nav) is unchanged and stays.
 *
 * Strategy:
 *   • ../lib/shareUrl is mocked so getHashData/decodeEstimate return a
 *     controlled ProjectData fixture without needing a real compressed hash.
 *   • useNavigate from @tanstack/react-router is mocked to a vi.fn().
 *   • ../lib/api (T24 addition) is mocked so its `apiFetch` export can be
 *     spied on — SharedEstimatePage.tsx does not import it directly, but
 *     this is how every other estimai-ui test proves "no apiFetch call was
 *     made" (see EstimatorApp.test.tsx's own `estimatesApi` mock recipe):
 *     if a future change to this page — or anything it renders — ever
 *     reaches for `apiFetch`, this spy is what would catch it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import SharedEstimatePage from './SharedEstimatePage'
import type { ProjectData } from '../lib/projects'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('../lib/shareUrl', () => ({
  getHashData: vi.fn(() => 'encoded'),
  decodeEstimate: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
  clearJwtCache: vi.fn(),
}))

import { decodeEstimate } from '../lib/shareUrl'
import { apiFetch } from '../lib/api'

const fixture: ProjectData = {
  id: 'shared-1',
  name: 'Shared Project',
  author: 'Jane Consultant',
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
  releases: [{ id: 'r1', name: 'v1.0', fte: 2 }],
  acts: [
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
  ],
}

beforeEach(() => {
  vi.mocked(decodeEstimate).mockReturnValue(fixture)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SharedEstimatePage', () => {
  it('does not render its own logo image', () => {
    render(<SharedEstimatePage />)

    // The old header rendered <img src="/estimai.svg" alt="EstimAI" ... /> —
    // no image of any kind should be present anymore.
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByAltText('EstimAI')).toBeNull()
  })

  it('keeps the read-only badge, estimate name/author, save-to-mine, and My Estimates nav', () => {
    render(<SharedEstimatePage />)

    expect(screen.getByText('read-only')).toBeDefined()
    expect(screen.getByText('Shared Project')).toBeDefined()
    expect(screen.getByText('Jane Consultant')).toBeDefined()
    expect(screen.getByRole('button', { name: /Save to My Estimates/i })).toBeDefined()
    expect(screen.getByRole('button', { name: '☰ My Estimates' })).toBeDefined()
    // The "Powered by EstimAI" text itself is tool-scoped copy, not the logo
    // mark, and is unaffected by the chrome-dedup pass.
    expect(screen.getByText('Powered by EstimAI')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// T24 (specs/013-estimate-sharing/tasks.md) — link-share regression guard.
//
// SharedEstimatePage.tsx and shareUrl.ts are BOTH untouched by specs/013
// (the "estimate sharing"/collaborator-grant feature) — they remain the
// separate, pre-existing, account-free link-share mechanism (AC-8.1). This
// guards that AC-8.1/AC-8.2 stay true from the OTHER direction T22's own
// toolbar tests can't reach: the unauthenticated `/share#data=...` path
// makes no backend call at all, and never shows anything shaped like
// collaborator UI, no matter what a `#data=` payload contains.
//
// NON-VACUOUS: the first test FAILS if SharedEstimatePage (or anything it
// renders) is ever changed to call `apiFetch` — a real regression, since
// this is deliberately the unauthenticated path. The second FAILS if any
// collaboration-shaped UI (an `AccessLevelBadge`, `CollaboratorsDialog`, or
// the toolbar's "Collaborators" button/chip from T22, or literal "Shared
// with you" / "collaborator" copy) is ever added to this page.
// ---------------------------------------------------------------------------

describe('SharedEstimatePage — link-share regression guard (T24, AC-8.1/AC-8.2)', () => {
  it('performs no apiFetch call at all — the unauthenticated read-only path never touches the network', () => {
    render(<SharedEstimatePage />)

    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('rendering a #data= payload shows no collaborator list, no access-level chip, and no "Shared with you" text', () => {
    // getHashData/decodeEstimate are mocked (see this file's header) to
    // return a controlled ProjectData without needing a real lz-string-
    // compressed hash — decodeEstimate is the only consumer of the `#data=`
    // hash, and it is fed a real, valid ProjectData exactly as it would be
    // from a genuine `/share#data=...` URL, so this exercises the same
    // render path a real payload would.
    render(<SharedEstimatePage />)

    // No collaborator-related UI of any kind — only the existing plain-text
    // `author` field (already asserted in the describe block above).
    expect(screen.queryByTestId('access-level-badge')).toBeNull()
    expect(screen.queryByTestId('collaborators-dialog')).toBeNull()
    expect(screen.queryByTestId('collaborators-chip')).toBeNull()
    expect(screen.queryByTestId('collaborators-button')).toBeNull()
    expect(screen.queryByText(/shared with you/i)).toBeNull()
    expect(screen.queryByText(/collaborator/i)).toBeNull()
  })
})
