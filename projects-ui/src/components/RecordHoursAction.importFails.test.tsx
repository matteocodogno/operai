/**
 * @vitest-environment jsdom
 *
 * RecordHoursAction when `import('shell/extensions')` itself is rejected — the shell's remote entry cannot be
 * reached, or a build skew (specs/20261116-record-hours-in-place AC-4.5, ADR 20260803-suite-version-generated-file-federated-export's rule for every
 * shell↔remote seam: never block or throw). The page keeps its place and shows its own link to My hours.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import RecordHoursAction from './RecordHoursAction'

vi.mock('shell/extensions', () => {
  throw new Error('the shell’s remote entry could not be loaded')
})

afterEach(cleanup)

describe('RecordHoursAction with a rejected seam import', () => {
  it('shows the link to My hours and nothing throws (AC-4.5)', async () => {
    render(
      <div>
        <p>the rest of the page</p>
        <RecordHoursAction
          on="project"
          targetId="p-1"
          targetName="Intranet"
          activityId=""
          activityName=""
          placement="page"
        />
      </div>,
    )
    const link = await waitFor(() => screen.getByRole('link', { name: 'Record hours in My hours' }))
    expect(link.getAttribute('href')).toBe('/hours')
    expect(screen.getByText('the rest of the page')).not.toBeNull()
  })
})
