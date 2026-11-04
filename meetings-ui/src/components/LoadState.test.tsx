/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import { en } from '../strings'
import { LoadFailure, Loading, StaleWriteBanner } from './LoadState'

afterEach(cleanup)

const problem = (status: number, code?: string, detail?: string) =>
  new ApiError({ status, title: 'Problem', code, detail })

describe('LoadFailure (building-pages § 2)', () => {
  it('403 replaces the page with the permission-denied panel and offers no retry', () => {
    render(<LoadFailure error={problem(403)} onRetry={vi.fn()} />)
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(screen.getByRole('heading', { name: en.common.permissionDenied.heading })).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.common.retry })).toBeNull()
  })

  it("404 is the not-found panel with the page's own words, and no retry (AC-5.3)", () => {
    render(
      <LoadFailure
        error={problem(404, 'not_found')}
        onRetry={vi.fn()}
        notFound={{ title: 'Meeting not found', body: 'It may have been deleted, or you may not have access to it.' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Meeting not found' })).not.toBeNull()
    expect(screen.getByText('It may have been deleted, or you may not have access to it.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.common.retry })).toBeNull()
  })

  it('404 without page copy falls back to the generic not-found words', () => {
    render(<LoadFailure error={problem(404)} onRetry={vi.fn()} />)
    expect(screen.getByRole('heading', { name: en.common.notFound.heading })).not.toBeNull()
  })

  it('503 from auth is the authorization-unavailable banner with Retry (AC-10.6)', async () => {
    const onRetry = vi.fn()
    render(<LoadFailure error={problem(503)} onRetry={onRetry} />)
    expect(screen.getByText(en.common.authUnavailable.heading)).not.toBeNull()
    expect(screen.getByText(en.common.authUnavailable.body)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.common.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('a 503 storage_unavailable is NOT the authorization banner: it shows its own message', () => {
    render(<LoadFailure error={problem(503, 'storage_unavailable')} onRetry={vi.fn()} />)
    expect(screen.queryByText(en.common.authUnavailable.heading)).toBeNull()
    expect(screen.getByText(en.common.errors.storage_unavailable)).not.toBeNull()
  })

  it('a 403 frozen is an inline warning with its message, not a replaced page (AC-5.8)', () => {
    render(<LoadFailure error={problem(403, 'frozen')} onRetry={vi.fn()} />)
    expect(screen.queryByRole('heading', { name: en.common.permissionDenied.heading })).toBeNull()
    expect(screen.getByText(en.common.errors.frozen)).not.toBeNull()
  })

  it('any other failure shows the message and Retry', async () => {
    const onRetry = vi.fn()
    render(<LoadFailure error={problem(500, undefined, 'The server fell over')} onRetry={onRetry} />)
    expect(screen.getByText('The server fell over')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.common.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('a network failure (not an ApiError) shows the network line', () => {
    render(<LoadFailure error={new TypeError('Failed to fetch')} onRetry={vi.fn()} />)
    expect(screen.getByText(en.common.networkError)).not.toBeNull()
  })
})

describe('Loading', () => {
  it('announces the label politely', () => {
    render(<Loading label="Loading meetings…" />)
    expect(screen.getByRole('status').textContent).toBe('Loading meetings…')
  })
})

describe('StaleWriteBanner', () => {
  it('offers Reload', async () => {
    const onReload = vi.fn()
    render(<StaleWriteBanner onReload={onReload} />)
    await userEvent.click(screen.getByRole('button', { name: en.common.reload }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
