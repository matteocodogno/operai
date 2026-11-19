/**
 * @vitest-environment jsdom
 *
 * The copied frame pieces (T26): `Loading`, the failure ladder `LoadFailure`, `PermissionDenied`, `NotFoundPage` and
 * `Saved`, each under axe (design § Accessibility, the rule that makes the helper count). The frame that composes them,
 * `AccountingShell`, is T28's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Outlet, RouterProvider } from '@tanstack/react-router'
import { LoadFailure, Loading } from './components/LoadState'
import PermissionDenied from './components/PermissionDenied'
import { Saved } from './components/Saved'
import { ApiError } from './lib/api'
import { createAppRouter } from './router'
import { expectNoAxeViolations } from './test-support/axe'

vi.mock('shell/session', () => ({ apiFetch: vi.fn(), getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

afterEach(cleanup)

const problem = (status: number, detail?: string) => new ApiError({ status, title: 'Problem', detail })

describe('Loading', () => {
  it('announces once, politely, and shows skeleton rows', async () => {
    const { container } = render(<Loading label="Loading Accounting…" />)
    expect(screen.getByRole('status').textContent).toBe('Loading Accounting…')
    await expectNoAxeViolations(container)
  })
})

describe('LoadFailure — the one failure ladder (UX-15)', () => {
  it('403: PermissionDenied, an alert with no retry', async () => {
    const onRetry = vi.fn()
    const { container } = render(<LoadFailure error={problem(403)} onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toContain('No access to Accounting')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('503: the authorization-unavailable banner, with Retry that retries', async () => {
    const onRetry = vi.fn()
    const { container } = render(
      <LoadFailure error={problem(503, 'Auth is down at https://internal')} onRetry={onRetry} />,
    )
    expect(screen.getByText('Authorization service unavailable')).not.toBeNull()
    expect(screen.getByText('We cannot verify your access right now. Nothing was changed.')).not.toBeNull()
    // The Problem detail of a 503 is never shown: the ladder's sentence is.
    expect(container.textContent).not.toContain('internal')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    await expectNoAxeViolations(container)
  })

  it('any other failure: a warning banner with the card’s own sentence, else the Problem detail, else a generic line', async () => {
    const own = render(
      <LoadFailure
        error={problem(500, 'Server said no')}
        onRetry={() => undefined}
        message="Could not load the ledger accounts."
      />,
    )
    expect(screen.getByText('Could not load the ledger accounts.')).not.toBeNull()
    expect(screen.queryByText('Server said no')).toBeNull()
    await expectNoAxeViolations(own.container)
    own.unmount()

    const detail = render(<LoadFailure error={problem(500, 'Server said no')} onRetry={() => undefined} />)
    expect(screen.getByText('Server said no')).not.toBeNull()
    detail.unmount()

    const network = render(<LoadFailure error={new TypeError('Failed to fetch')} onRetry={() => undefined} />)
    expect(screen.getByText('The server could not be reached. Check your connection and try again.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
    await expectNoAxeViolations(network.container)
  })
})

describe('PermissionDenied', () => {
  it('is an alert whose heading takes focus', async () => {
    const { container } = render(<PermissionDenied />)
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-denied-heading'))
    await expectNoAxeViolations(container)
  })
})

describe('Saved', () => {
  it('shows the confirmation compactly and can be dismissed', async () => {
    const onDismiss = vi.fn()
    const { container } = render(<Saved message="Account 5905 added" onDismiss={onDismiss} />)
    expect(screen.getByText('Account 5905 added')).not.toBeNull()
    await expectNoAxeViolations(container)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})

describe('NotFoundPage (as the router fallback)', () => {
  it('is an alert with a way back, and no axe violation', async () => {
    window.history.pushState(null, '', '/accounting/nope')
    const { container } = render(<RouterProvider router={createAppRouter('/accounting', Outlet)} />)
    expect(await screen.findByTestId('accounting-not-found')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-not-found-heading'))
    await expectNoAxeViolations(container)
  })
})
