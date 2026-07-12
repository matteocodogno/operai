/**
 * @vitest-environment jsdom
 *
 * Component tests for ErrorBanner (T15, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) renders as role="alert" with the given message.
 *   (B) Retry button renders and fires onRetry only when onRetry is passed.
 *   (C) Dismiss button renders and fires onDismiss only when onDismiss is passed.
 *   (D) renders neither action when neither callback is passed (message-only banner).
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
    render(<ErrorBanner message="Could not load your roles." />)

    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('Could not load your roles.')
  })

  it('renders a Retry button that calls onRetry when clicked', () => {
    const onRetry = vi.fn()
    render(<ErrorBanner message="Could not load your roles." onRetry={onRetry} />)

    const retryBtn = screen.getByTestId('error-banner-retry')
    expect(retryBtn.textContent).toBe('Retry')

    fireEvent.click(retryBtn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('supports a custom retry label', () => {
    render(<ErrorBanner message="Stale catalog." onRetry={vi.fn()} retryLabel="Reload catalog" />)

    expect(screen.getByTestId('error-banner-retry').textContent).toBe('Reload catalog')
  })

  it('omits the Retry button when onRetry is not passed', () => {
    render(<ErrorBanner message="Could not load your roles." />)

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
    render(<ErrorBanner message="Could not load your roles." />)

    expect(screen.queryByTestId('error-banner-dismiss')).toBeNull()
  })

  it('renders message-only (no actions) when neither callback is passed', () => {
    render(<ErrorBanner message="Could not load your roles." />)

    expect(screen.queryByRole('button')).toBeNull()
  })
})
