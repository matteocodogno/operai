import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ProgressBar } from './ProgressBar'

afterEach(cleanup)

describe('ProgressBar', () => {
  it('is a progressbar with a name and the aria values of a determinate bar', () => {
    render(<ProgressBar label="Uploading the recording" value={40} />)
    const bar = screen.getByRole('progressbar', { name: 'Uploading the recording' })
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-valuenow', '40')
  })

  it('has no aria-valuenow when indeterminate (no value)', () => {
    render(<ProgressBar label="Processing" />)
    const bar = screen.getByRole('progressbar', { name: 'Processing' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveClass('progress-indeterminate')
  })

  it('treats a non-finite value as indeterminate rather than showing NaN', () => {
    render(<ProgressBar label="Processing" value={Number.NaN} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })

  it('uses max for the scale and clamps the value into it', () => {
    const { rerender } = render(<ProgressBar label="Saving audio" value={3} max={5} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuemax', '5')
    expect(bar).toHaveAttribute('aria-valuenow', '3')
    expect(bar.firstElementChild).toHaveStyle({ width: '60%' })
    rerender(<ProgressBar label="Saving audio" value={9} max={5} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5')
    rerender(<ProgressBar label="Saving audio" value={-2} max={5} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('falls back to a scale of 100 when max is not a positive number', () => {
    render(<ProgressBar label="Saving" value={50} max={0} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '100')
  })

  it('gives the text alternative as aria-valuetext and shows it once (not announced twice)', () => {
    render(<ProgressBar label="Saving audio" value={3} max={5} valueText="3 of 5" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '3 of 5')
    expect(screen.getByText('3 of 5')).toHaveAttribute('aria-hidden', 'true')
  })

  it('can carry text beside an indeterminate bar', () => {
    render(<ProgressBar label="Processing" valueText="Transcribing…" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Transcribing…')
  })
})
