/**
 * @vitest-environment jsdom
 *
 * Component tests for Bell (T11, specs/005-notification-center, design.md "Bell (shell
 * header chrome)").
 *
 * Uses a real, minimal TanStack Router harness (mirroring Sidebar.test.tsx's technique)
 * because Bell renders a genuine `<Link to="/notify">` — the whole point of AC-2.1 is
 * that clicking it performs a REAL navigation, so a mocked `Link`/`navigate` would test
 * nothing real. The harness registers its own tiny `/notify` route locally; the shell's
 * real router (router.tsx) only gets that route wired in T13 — see Bell.tsx's file doc
 * for why that's fine (the `to` prop is widened to `string`, not the literal, so it
 * type-checks against ANY router, including this test's smaller one and the real one
 * once T13 lands).
 *
 * `useUnreadCount` (shell/src/lib/notifications.ts, T10) IS mocked here, deliberately:
 * it is the one live dependency this task adds, and controlling its return value
 * directly is how each test pins down an exact unread count without standing up a real
 * SSE connection/REST seed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

const { useUnreadCount } = vi.hoisted(() => ({ useUnreadCount: vi.fn() }))
vi.mock('../lib/notifications', () => ({ useUnreadCount }))

import Bell from './Bell'

beforeEach(() => {
  useUnreadCount.mockReturnValue(0)
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
  vi.clearAllMocks()
})

/**
 * Builds a tiny router — a root layout rendering Bell + an Outlet, an index route, and a
 * `/notify` route with recognizable content — then navigates to `path` before the first
 * render, mirroring Sidebar.test.tsx's `renderSidebarAt` helper.
 */
async function renderBellAt(path: string) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Bell />
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p data-testid="root-content">root</p>,
  })
  const notifyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notify',
    component: () => <p data-testid="notify-content">notify</p>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, notifyRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByRole('link', { name: 'Notifications' })
  return { router, ...utils }
}

describe('Bell — accessible name (design.md Accessibility)', () => {
  it('has a static "Notifications" accessible name regardless of unread count', async () => {
    useUnreadCount.mockReturnValue(7)
    await renderBellAt('/')

    // Exactly one link named "Notifications" — never "Notifications (7)".
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeDefined()
  })

  it('renders on every route (mounted regardless of the current path)', async () => {
    await renderBellAt('/notify')

    expect(screen.getByRole('link', { name: 'Notifications' })).toBeDefined()
    expect(screen.getByTestId('notify-content')).toBeDefined()
  })
})

describe('Bell — unread badge (AC-1.2, AC-1.3, AC-1.6)', () => {
  it('renders no badge element at all when unread count is 0', async () => {
    useUnreadCount.mockReturnValue(0)
    await renderBellAt('/')

    expect(screen.queryByText('0')).toBeNull()
    expect(screen.queryByText('9+')).toBeNull()
  })

  it('renders the exact digit "1" for a count of 1', async () => {
    useUnreadCount.mockReturnValue(1)
    await renderBellAt('/')

    expect(screen.getByText('1', { exact: true })).toBeDefined()
  })

  it('renders the exact digit "9" for a count of 9', async () => {
    useUnreadCount.mockReturnValue(9)
    await renderBellAt('/')

    expect(screen.getByText('9', { exact: true })).toBeDefined()
  })

  it('renders "9+" for a count of 10 (the 9/10 boundary, AC-1.6)', async () => {
    useUnreadCount.mockReturnValue(10)
    await renderBellAt('/')

    expect(screen.getByText('9+', { exact: true })).toBeDefined()
    expect(screen.queryByText('10', { exact: true })).toBeNull()
  })

  it('renders "9+" for a count of 99', async () => {
    useUnreadCount.mockReturnValue(99)
    await renderBellAt('/')

    expect(screen.getByText('9+', { exact: true })).toBeDefined()
    expect(screen.queryByText('99', { exact: true })).toBeNull()
  })

  it('badge digit content is aria-hidden (decorative — the live region carries the announcement)', async () => {
    useUnreadCount.mockReturnValue(3)
    await renderBellAt('/')

    const badge = screen.getByText('3', { exact: true })
    expect(badge.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('Bell — separate aria-live announcement (design.md Accessibility)', () => {
  it('announces the unread count in a polite live region, separate from the link', async () => {
    useUnreadCount.mockReturnValue(3)
    const { container } = await renderBellAt('/')

    const liveRegion = container.querySelector('[aria-live="polite"]')
    expect(liveRegion).not.toBeNull()
    expect(liveRegion?.textContent).toBe('3 unread notifications')
    // Not inside the link itself.
    expect(screen.getByRole('link', { name: 'Notifications' }).contains(liveRegion)).toBe(false)
  })

  it('uses the singular form for exactly 1 unread notification', async () => {
    useUnreadCount.mockReturnValue(1)
    const { container } = await renderBellAt('/')

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('1 unread notification')
  })

  it('clears the live-region text (removed entirely) at 0 unread', async () => {
    useUnreadCount.mockReturnValue(0)
    const { container } = await renderBellAt('/')

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('')
  })
})

describe('Bell — navigation (AC-2.1)', () => {
  it('navigates to /notify on click', async () => {
    const user = userEvent.setup()
    await renderBellAt('/')

    expect(screen.queryByTestId('notify-content')).toBeNull()

    await user.click(screen.getByRole('link', { name: 'Notifications' }))

    expect(await screen.findByTestId('notify-content')).toBeDefined()
  })

  it('is a real anchor with an href, reachable and activatable via the keyboard', async () => {
    const user = userEvent.setup()
    await renderBellAt('/')

    const link = screen.getByRole('link', { name: 'Notifications' })
    expect(link.getAttribute('href')).toBe('/notify')

    link.focus()
    expect(document.activeElement).toBe(link)

    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('notify-content')).toBeDefined()
  })
})
