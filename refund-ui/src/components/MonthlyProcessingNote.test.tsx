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
})
