/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { strings } from '../strings'
import SuccessBanner from './SuccessBanner'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SuccessBanner (INC-19: the confirmation of the person’s own action)', () => {
  it('renders nothing without a message', () => {
    const { container, rerender } = render(
      <SuccessBanner message={null} onDismiss={() => undefined} testId="hours-saved" />,
    )
    expect(container.innerHTML).toBe('')
    rerender(<SuccessBanner message="" onDismiss={() => undefined} testId="hours-saved" />)
    expect(container.innerHTML).toBe('')
  })

  it('is a polite status holding exactly the message', () => {
    render(<SuccessBanner message="Entry saved" onDismiss={() => undefined} testId="hours-saved" />)
    expect(screen.getByRole('status').textContent).toContain('Entry saved')
    expect(screen.getByTestId('hours-saved').textContent).toBe('Entry saved')
  })

  it('dismisses with its × (named from the catalog)', () => {
    const onDismiss = vi.fn()
    render(<SuccessBanner message="Entry saved" onDismiss={onDismiss} testId="hours-saved" />)
    fireEvent.click(screen.getByRole('button', { name: strings.common.dismiss }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('dismisses itself after about three seconds, not before', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<SuccessBanner message="Entry saved" onDismiss={onDismiss} testId="hours-saved" />)
    act(() => void vi.advanceTimersByTime(2900))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(200))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a warning caveat stays until the person dismisses it', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<SuccessBanner message="Saved, but…" tone="warning" onDismiss={onDismiss} testId="hours-saved" />)
    act(() => void vi.advanceTimersByTime(10_000))
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
