/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { strings } from '../strings'
import ErrorBanner from './ErrorBanner'

afterEach(() => cleanup())

describe('ErrorBanner', () => {
  it('is an alert with the message', () => {
    render(<ErrorBanner message="The server could not be reached." />)
    expect(screen.getByRole('alert').textContent).toContain('The server could not be reached.')
  })

  it('offers Retry only when there is something to retry, and calls it', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<ErrorBanner message="x" />)
    expect(screen.queryByRole('button', { name: strings.common.retry })).toBeNull()

    rerender(<ErrorBanner message="x" onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('names Retry as the screen asks (“Try again”)', () => {
    render(<ErrorBanner message="x" onRetry={() => undefined} retryLabel={strings.common.tryAgain} />)
    expect(screen.getByRole('button', { name: strings.common.tryAgain })).not.toBeNull()
  })

  it('shows a title when one is given (the authorization-unavailable heading)', () => {
    render(<ErrorBanner title={strings.common.authUnavailable.heading} message={strings.common.authUnavailable.body} />)
    expect(screen.getByRole('alert').textContent).toContain(strings.common.authUnavailable.heading)
    expect(screen.getByRole('alert').textContent).toContain(strings.common.authUnavailable.body)
  })

  it('dismisses with its × when it can be dismissed', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(<ErrorBanner message="x" />)
    expect(screen.queryByRole('button', { name: strings.common.dismiss })).toBeNull()

    rerender(<ErrorBanner message="x" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: strings.common.dismiss }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('is orange for a failed load and red for a failed save', () => {
    const { rerender } = render(<ErrorBanner message="x" testId="hours-banner" />)
    expect(screen.getByTestId('hours-banner').className).toContain('banner-warning')
    rerender(<ErrorBanner message="x" tone="danger" testId="hours-banner" />)
    expect(screen.getByTestId('hours-banner').className).toContain('banner-danger')
  })

  it('takes a test id for its own banner, its Retry and its ×', () => {
    render(<ErrorBanner message="x" onRetry={() => undefined} onDismiss={() => undefined} testId="hours-load-error" />)
    expect(screen.getByTestId('hours-load-error')).not.toBeNull()
    expect(screen.getByTestId('hours-load-error-retry')).not.toBeNull()
    expect(screen.getByTestId('hours-load-error-dismiss')).not.toBeNull()
  })
})
