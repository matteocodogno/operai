/**
 * @vitest-environment jsdom
 *
 * Component tests for SharedEstimatePage (specs/003-suite-shell, T14, AC-4.2).
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

import { decodeEstimate } from '../lib/shareUrl'

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
