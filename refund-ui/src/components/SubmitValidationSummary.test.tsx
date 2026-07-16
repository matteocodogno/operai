/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SubmitValidationSummary from './SubmitValidationSummary'

afterEach(() => {
  cleanup()
})

describe('SubmitValidationSummary', () => {
  it('renders nothing for an empty items array', () => {
    const { container } = render(<SubmitValidationSummary items={[]} onJump={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders role="alert" and one jump link per offending line', () => {
    render(
      <SubmitValidationSummary
        items={[
          { lineId: 'l1', label: '16 Jul 2026 · Client visit' },
          { lineId: 'l2', label: '17 Jul 2026 · (no description)' },
        ]}
        onJump={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).not.toBeNull()
    expect(screen.getByTestId('submit-validation-summary-jump-l1').tagName).toBe('BUTTON')
    expect(screen.getByTestId('submit-validation-summary-jump-l2').tagName).toBe('BUTTON')
  })

  it('calls onJump with the corresponding line id when a jump link is clicked', () => {
    const onJump = vi.fn()
    render(
      <SubmitValidationSummary items={[{ lineId: 'l1', label: '16 Jul 2026 · Client visit' }]} onJump={onJump} />,
    )

    fireEvent.click(screen.getByTestId('submit-validation-summary-jump-l1'))

    expect(onJump).toHaveBeenCalledWith('l1')
  })
})
