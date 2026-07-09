/**
 * @vitest-environment jsdom
 *
 * Integration tests for RemoteMount — the content-area remote boundary
 * (specs/003-suite-shell, T11, AC-6.1).
 *
 * Since a real `remoteEntry.js` can't be made to fail deterministically in a
 * unit test, these tests drive the boundary with an injected `loader` thunk
 * whose settlement is fully controlled (a "deferred" promise) — a rejecting
 * loader stands in for a network error / MF runtime error, a resolving one
 * for a normal remote load. Per T11's done-when, this proves:
 *
 *   (a) a forced remote-load FAILURE shows the in-place `role="alert"` error
 *       plus a Retry action, while a sibling "chrome" element outside
 *       RemoteMount stays fully interactive, and Retry actually re-invokes
 *       the loader (asserted via call count) and can recover into the loaded
 *       state;
 *   (b) a loading state (with a polite `aria-live` announcement) renders
 *       while the remote is resolving, before either outcome is known.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RemoteMount } from './RemoteMount'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function RemoteContent() {
  return <div data-testid="remote-content">Remote loaded</div>
}

// React logs caught errors to console.error (its own dev-mode warning, plus
// this component's own componentDidCatch log) — expected noise for the
// failure-path tests, suppressed so it doesn't clutter test output.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RemoteMount', () => {
  it('renders a scoped loading state with a polite aria-live announcement while the remote resolves', async () => {
    const deferred = createDeferred<{ default: ComponentType }>()
    const loader = vi.fn(() => deferred.promise)

    render(
      <div>
        <button data-testid="chrome-button">Switch tool</button>
        <RemoteMount loader={loader} moduleLabel="EstimAI" />
      </div>,
    )

    expect(screen.getByTestId('remote-mount-loading')).not.toBeNull()
    const announcement = screen.getByText('Loading EstimAI…')
    expect(announcement.getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByTestId('remote-content')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)

    deferred.resolve({ default: RemoteContent })
    expect(await screen.findByTestId('remote-content')).not.toBeNull()
    expect(screen.queryByTestId('remote-mount-loading')).toBeNull()
  })

  it('shows an in-place, role="alert" error with a working Retry on remote-load failure, leaving the surrounding chrome usable', async () => {
    const failure = createDeferred<{ default: ComponentType }>()
    const loader = vi.fn(() => failure.promise)
    let chromeClicks = 0

    render(
      <div>
        <button data-testid="chrome-button" onClick={() => chromeClicks++}>
          Switch tool
        </button>
        <RemoteMount loader={loader} moduleLabel="Refund" />
      </div>,
    )

    failure.reject(new Error('network error fetching remoteEntry.js'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Refund couldn't load/i)

    // The failure is confined to the content area: a sibling "chrome"
    // element stays mounted and fully interactive.
    const chromeButton = screen.getByTestId('chrome-button')
    fireEvent.click(chromeButton)
    expect(chromeClicks).toBe(1)

    // Retry must actually re-attempt the load, not just clear the error.
    const success = createDeferred<{ default: ComponentType }>()
    loader.mockImplementationOnce(() => success.promise)

    const retryButton = screen.getByRole('button', { name: /retry/i })
    fireEvent.click(retryButton)

    expect(loader).toHaveBeenCalledTimes(2)
    // Back to the loading state while the retried load is pending — the
    // error is gone, the boundary was reset by the retry.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('remote-mount-loading')).not.toBeNull()

    success.resolve({ default: RemoteContent })
    expect(await screen.findByTestId('remote-content')).not.toBeNull()

    // Chrome remained interactive throughout the whole failure→retry→success cycle.
    fireEvent.click(chromeButton)
    expect(chromeClicks).toBe(2)
  })

  it('forwards componentProps to the mounted remote once it resolves', async () => {
    function Greeter({ name }: { name: string }) {
      return <p data-testid="greeting">{`Hello, ${name}`}</p>
    }
    const loader = vi.fn(() => Promise.resolve({ default: Greeter }))

    render(<RemoteMount loader={loader} moduleLabel="EstimAI" componentProps={{ name: 'Ada' }} />)

    const greeting = await screen.findByTestId('greeting')
    expect(greeting.textContent).toBe('Hello, Ada')
  })
})
