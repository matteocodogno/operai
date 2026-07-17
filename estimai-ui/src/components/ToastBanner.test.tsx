/**
 * @vitest-environment jsdom
 *
 * Component tests for ToastBanner's tone support (auto-save "changes stored"
 * feedback, specs/NNN-content-app-autosave). Covers:
 *   - default/`'error'` tone is unchanged byte-for-byte: role="alert", no
 *     aria-live attribute, persistent (no auto-dismiss).
 *   - `'success'` tone: role="status", aria-live="polite", and calls
 *     onDismiss on its own after ~2s without any user interaction.
 *   - the dismiss "×" button still works for both tones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ToastBanner from './ToastBanner'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('ToastBanner — error tone (default, unchanged)', () => {
  it('renders role="alert" with no aria-live attribute and does not auto-dismiss', () => {
    const onDismiss = vi.fn()
    render(<ToastBanner message="Save failed" onDismiss={onDismiss} />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Save failed')
    expect(alert.getAttribute('aria-live')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('the same behavior holds when tone="error" is passed explicitly', () => {
    const onDismiss = vi.fn()
    render(<ToastBanner message="Save failed" onDismiss={onDismiss} tone="error" />)
    expect(screen.getByRole('alert')).not.toBeNull()
  })

  it('clicking the dismiss button calls onDismiss', () => {
    const onDismiss = vi.fn()
    render(<ToastBanner message="Save failed" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('ToastBanner — success tone', () => {
  it('renders role="status" with aria-live="polite"', () => {
    render(<ToastBanner message="Changes stored" onDismiss={vi.fn()} tone="success" />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Changes stored')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('auto-dismisses ~2s after mount by calling onDismiss, without any user interaction', () => {
    const onDismiss = vi.fn()
    render(<ToastBanner message="Changes stored" onDismiss={onDismiss} tone="success" />)

    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('clicking the dismiss button still works before the auto-dismiss timer fires', () => {
    const onDismiss = vi.fn()
    render(<ToastBanner message="Changes stored" onDismiss={onDismiss} tone="success" />)
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not restart the auto-dismiss clock when the parent re-renders with a fresh onDismiss reference', () => {
    const onDismiss1 = vi.fn()
    const { rerender } = render(<ToastBanner message="Changes stored" onDismiss={onDismiss1} tone="success" />)

    act(() => {
      vi.advanceTimersByTime(1500)
    })

    // Simulate a parent re-render passing a brand-new inline callback (common
    // in JSX like `onDismiss={() => setShow(false)}`) — the timer must not reset.
    const onDismiss2 = vi.fn()
    rerender(<ToastBanner message="Changes stored" onDismiss={onDismiss2} tone="success" />)

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(onDismiss2).toHaveBeenCalledTimes(1)
  })
})
