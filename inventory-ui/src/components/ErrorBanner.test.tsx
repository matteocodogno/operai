/**
 * @vitest-environment jsdom
 *
 * Component tests for ErrorBanner (T25, specs/015-hardware-inventory; carried over from refund-ui, plus the 503 variant).
 *
 * Covers:
 *   (A) renders as role="alert" with the given message.
 *   (B) Retry button renders and fires onRetry only when onRetry is passed.
 *   (C) Dismiss button renders and fires onDismiss only when onDismiss is passed.
 *   (D) renders neither action when neither callback is passed (message-only banner).
 *   (E) the `authUnavailable` variant (503 fail-closed, design.md § Screens & states).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ErrorBanner from './ErrorBanner'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBanner', () => {
  it('renders as role="alert" with the given message', () => {
    render(<ErrorBanner message="Could not load assets." />)

    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('Could not load assets.')
  })

  it('renders a Retry button that calls onRetry when clicked', () => {
    const onRetry = vi.fn()
    render(<ErrorBanner message="Could not load assets." onRetry={onRetry} />)

    const retryBtn = screen.getByTestId('error-banner-retry')
    expect(retryBtn.textContent).toBe('Retry')

    fireEvent.click(retryBtn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('supports a custom retry label', () => {
    render(<ErrorBanner message="Stale queue." onRetry={vi.fn()} retryLabel="Reload queue" />)

    expect(screen.getByTestId('error-banner-retry').textContent).toBe('Reload queue')
  })

  it('omits the Retry button when onRetry is not passed', () => {
    render(<ErrorBanner message="Could not load assets." />)

    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
  })

  it('renders a Dismiss button that calls onDismiss when clicked', () => {
    const onDismiss = vi.fn()
    render(<ErrorBanner message="Heads up." onDismiss={onDismiss} />)

    const dismissBtn = screen.getByTestId('error-banner-dismiss')
    expect(dismissBtn.getAttribute('aria-label')).toBe('Dismiss')

    fireEvent.click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('omits the Dismiss button when onDismiss is not passed', () => {
    render(<ErrorBanner message="Could not load assets." />)

    expect(screen.queryByTestId('error-banner-dismiss')).toBeNull()
  })

  it('renders message-only (no actions) when neither callback is passed', () => {
    render(<ErrorBanner message="Could not load assets." />)

    expect(screen.queryByRole('button')).toBeNull()
  })

  describe('authUnavailable variant (503 fail-closed)', () => {
    it('shows its own heading and the "nothing was changed" body, as one alert', () => {
      render(<ErrorBanner variant="authUnavailable" />)

      const banner = screen.getByRole('alert')
      expect(banner.textContent).toContain('Authorization service unavailable')
      expect(banner.textContent).toContain('We cannot verify your access right now. Nothing was changed.')
    })

    it('keeps the Retry action, which is what recovers a 503', () => {
      const onRetry = vi.fn()
      render(<ErrorBanner variant="authUnavailable" onRetry={onRetry} />)

      fireEvent.click(screen.getByTestId('error-banner-retry'))
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('lets a caller override the body but not drop the heading', () => {
      render(<ErrorBanner variant="authUnavailable" message="Nothing was saved." />)

      const banner = screen.getByRole('alert')
      expect(banner.textContent).toContain('Authorization service unavailable')
      expect(banner.textContent).toContain('Nothing was saved.')
      expect(banner.textContent).not.toContain('We cannot verify')
    })

    it('the default variant has no heading', () => {
      render(<ErrorBanner message="Could not load assets." />)

      expect(screen.queryByTestId('error-banner-heading')).toBeNull()
    })
  })
})
