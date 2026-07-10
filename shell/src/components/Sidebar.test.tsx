/**
 * @vitest-environment jsdom
 *
 * Component tests for Sidebar (specs/003-suite-shell, T7, AC-3.1, AC-5.1).
 *
 * Uses a real, minimal TanStack Router harness (mirroring router.integration.test.tsx's
 * technique) rather than mocking `Link`/`useMatchRoute` — the whole point of AC-3.1 is
 * that the active state comes from the ACTUAL current route, and TanStack Router's own
 * fuzzy-match + `aria-current` mechanism is what this component leans on, so a fake
 * router would test nothing real.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import Sidebar from './Sidebar'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

/**
 * Builds a tiny router — a root layout rendering Sidebar + an Outlet, with an index
 * route and one splat route per tool (`/estimai/$`, `/refund/$`), mirroring the real
 * shell router's tool-route shape (router.tsx) closely enough that a deep link like
 * `/refund/anything` resolves and Sidebar's active-match behaves exactly as it does in
 * the real app — then navigates to `path` before the first render so the initial match
 * reflects that route on first paint.
 */
async function renderSidebarAt(path: string) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Sidebar />
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p data-testid="root-content">root</p>,
  })
  const estimaiRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/estimai/$',
    component: () => <p data-testid="estimai-content">estimai</p>,
  })
  const refundRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/refund/$',
    component: () => <p data-testid="refund-content">refund</p>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, estimaiRoute, refundRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByRole('link', { name: 'EstimAI' })
  return { router, ...utils }
}

describe('Sidebar entries', () => {
  it('renders both tool entries with correct labels and hrefs', async () => {
    await renderSidebarAt('/estimai')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund (Rimborsi)' })

    expect(estimaiLink.getAttribute('href')).toBe('/estimai')
    expect(refundLink.getAttribute('href')).toBe('/refund')
  })

  it('renders as a flat two-item list with no nested items', async () => {
    await renderSidebarAt('/estimai')

    expect(screen.getAllByRole('link')).toHaveLength(2)
  })
})

describe('Sidebar active state (AC-3.1)', () => {
  it('marks EstimAI active with aria-current="page" when on /estimai', async () => {
    await renderSidebarAt('/estimai')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund (Rimborsi)' })

    expect(estimaiLink.getAttribute('aria-current')).toBe('page')
    expect(refundLink.getAttribute('aria-current')).toBeNull()
  })

  it('marks Refund active with aria-current="page" on a deep-linked refund sub-path', async () => {
    await renderSidebarAt('/refund/whatever')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = await screen.findByRole('link', { name: 'Refund (Rimborsi)' })

    expect(refundLink.getAttribute('aria-current')).toBe('page')
    expect(estimaiLink.getAttribute('aria-current')).toBeNull()
  })
})

describe('Sidebar keyboard operation (roving tabindex + arrow keys)', () => {
  it('starts the roving tab stop on the active entry; only one entry is in the tab order', async () => {
    await renderSidebarAt('/refund')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund (Rimborsi)' })

    expect(refundLink.tabIndex).toBe(0)
    expect(estimaiLink.tabIndex).toBe(-1)
  })

  it('falls back to the first entry as the tab stop when no tool is active', async () => {
    await renderSidebarAt('/')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund (Rimborsi)' })

    expect(estimaiLink.tabIndex).toBe(0)
    expect(refundLink.tabIndex).toBe(-1)
  })

  it('ArrowDown moves focus and the roving tabindex to the next entry', async () => {
    const user = userEvent.setup()
    await renderSidebarAt('/estimai')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund (Rimborsi)' })

    estimaiLink.focus()
    expect(document.activeElement).toBe(estimaiLink)

    await user.keyboard('{ArrowDown}')

    expect(document.activeElement).toBe(refundLink)
    expect(refundLink.tabIndex).toBe(0)
    expect(estimaiLink.tabIndex).toBe(-1)
  })

  it('ArrowUp moves focus and the roving tabindex to the previous entry, wrapping around', async () => {
    const user = userEvent.setup()
    await renderSidebarAt('/estimai')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund (Rimborsi)' })

    estimaiLink.focus()
    await user.keyboard('{ArrowUp}')

    // Wraps from the first entry to the last.
    expect(document.activeElement).toBe(refundLink)
    expect(refundLink.tabIndex).toBe(0)
    expect(estimaiLink.tabIndex).toBe(-1)
  })
})
