/**
 * @vitest-environment jsdom
 *
 * Component tests for ToastBanner (ported from estimai-ui's tone-aware
 * version, content-app auto-save feature). Covers:
 *   - `'error'` tone (default): role="alert", no aria-live attribute,
 *     persistent (no auto-dismiss).
 *   - `'success'` tone: role="status", aria-live="polite", and calls
 *     onDismiss on its own ~2s after mount, without any user interaction.
 *   - the dismiss "×" button works for both tones.
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

describe('ToastBanner — error tone (default)', () => {
  it('renders role="alert" with no aria-live attribute and does not auto-dismiss', () => {
    const onDismiss = vi.fn()
    render(<ToastBanner message="Could not save this change." onDismiss={onDismiss} />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Could not save this change.')
    expect(alert.getAttribute('aria-live')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('clicking the dismiss button calls onDismiss', () => {
    const onDismiss = vi.fn()
    render(<ToastBanner message="Could not save this change." onDismiss={onDismiss} tone="error" />)
    fireEvent.click(screen.getByTestId('toast-banner-dismiss'))
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

  it('auto-dismisses ~2s after mount by calling onDismiss', () => {
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
    fireEvent.click(screen.getByTestId('toast-banner-dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
