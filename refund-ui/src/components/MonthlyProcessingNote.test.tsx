/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import MonthlyProcessingNote from './MonthlyProcessingNote'

afterEach(() => {
  cleanup()
})

describe('MonthlyProcessingNote', () => {
  it('renders fixed copy with no date or amount (AC-4.1)', () => {
    render(<MonthlyProcessingNote />)
    const note = screen.getByTestId('monthly-processing-note')
    expect(note.textContent).not.toMatch(
      /\d{1,2}(st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i,
    )
    expect(note.textContent).not.toMatch(/[€$£]\s?\d/)
    expect(note.textContent).not.toMatch(/CHF\s?\d/)
  })

  it('has no props that could inject a date/amount', () => {
    // Type-level guarantee: MonthlyProcessingNote takes no props at all.
    render(<MonthlyProcessingNote />)
    expect(screen.getByTestId('monthly-processing-note')).not.toBeNull()
  })

  // WEIGHT. This was a bordered, accent-tinted panel with an accent heading —
  // the loudest element on the page while being the least important thing on
  // it. AC-4.1 asks the UI to STATE the monthly cadence, not to shout it, so
  // these pin the quiet rendering: nothing here would fail if the copy stayed
  // right but the panel crept back.
  it('is muted body text, not an accent-tinted panel', () => {
    render(<MonthlyProcessingNote />)
    const note = screen.getByTestId('monthly-processing-note')

    expect(note.style.color).toContain('--soft')
    expect(note.style.color).not.toContain('--acc')
    expect(note.style.borderColor).toBe('')
    expect(note.style.backgroundColor).toBe('')
    expect(note.className).not.toContain('border')
  })

  it('carries no heading of its own — it is a footnote, not a section', () => {
    const { container } = render(<MonthlyProcessingNote />)
    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
    // The old accent heading line is gone, not merely restyled.
    expect(screen.queryByText('Monthly processing')).toBeNull()
  })

  // AC-4.1 still has to hold at the quieter weight — the copy is what carries
  // the requirement, and it is untouched.
  it('still states the monthly cadence (AC-4.1)', () => {
    render(<MonthlyProcessingNote />)
    expect(screen.getByTestId('monthly-processing-note').textContent).toMatch(/monthly cycle/i)
  })
})
