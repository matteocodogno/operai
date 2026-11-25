/**
 * @vitest-environment jsdom
 *
 * FromMeetingBadge — the one place the "From meeting" badge is drawn (specs/20261112-meeting-hours AC-2.3, AC-4.3; plan
 * amendment 2026-11-25, S3). `EntryRow` and `EntriesTable` decide whether and where to draw it (`showsFromMeetingMark` and their
 * own layouts); this pins what is drawn: its test id, its copy and its tone. The tone is the one property no caller's test
 * asserts (`badge-accent`), so a change of it would otherwise pass every other test unnoticed.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import FromMeetingBadge from './FromMeetingBadge'

afterEach(() => cleanup())

describe('FromMeetingBadge', () => {
  it('draws "From meeting" under the entry\'s test id, in the accent tone', () => {
    render(<FromMeetingBadge entryId="e1" />)

    const badge = screen.getByTestId('hours-entry-e1-from-meeting')
    expect(badge.textContent).toBe('From meeting')
    expect(badge.classList.contains('badge')).toBe(true)
    expect(badge.classList.contains('badge-accent')).toBe(true)
  })

  it('names its test id after the entry it is given, so two badges on a page stay apart', () => {
    render(
      <>
        <FromMeetingBadge entryId="e1" />
        <FromMeetingBadge entryId="e2" />
      </>,
    )

    expect(screen.getByTestId('hours-entry-e1-from-meeting')).not.toBe(
      screen.getByTestId('hours-entry-e2-from-meeting'),
    )
    expect(screen.queryByTestId('hours-entry-e3-from-meeting')).toBeNull()
  })

  it('is plain text: not a control, with no tab stop and no name of its own', () => {
    const { container } = render(<FromMeetingBadge entryId="e1" />)

    expect(container.querySelectorAll('button, a[href], input, select, textarea, [tabindex], [role]')).toHaveLength(0)
    const badge = screen.getByTestId('hours-entry-e1-from-meeting')
    expect(badge.hasAttribute('aria-label')).toBe(false)
    expect(badge.hasAttribute('title')).toBe(false)
  })
})
