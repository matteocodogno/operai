/**
 * @vitest-environment jsdom
 *
 * Component tests for RefundShell (T14, specs/007-refund-service/tasks.md).
 *
 * Uses a real, minimal TanStack Router harness (mirrors
 * admin-ui/src/components/SectionNav.test.tsx's technique exactly, same
 * rationale: "aria-current on the active section" only means something when
 * it comes from a real route via `<Link>`'s own active-match mechanism).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import RefundShell from './RefundShell'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

async function renderShellAt(path: string) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({ component: RefundShell })
  const requestsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests',
    component: () => <p>requests</p>,
  })
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: () => <p>review</p>,
  })
  const routeTree = rootRoute.addChildren([requestsRoute, reviewRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { name: /^refund$/i })
  return utils
}

describe('RefundShell structure', () => {
  it('renders the tool heading', async () => {
    await renderShellAt('/requests')

    expect(screen.getByRole('heading', { name: /^refund$/i })).not.toBeNull()
  })

  it('renders a real nav landmark labelled "Refund navigation"', async () => {
    await renderShellAt('/requests')

    expect(screen.getByRole('navigation', { name: 'Refund navigation' })).not.toBeNull()
  })

  it('renders exactly the two nav links, as real <a> elements (not buttons/divs)', async () => {
    await renderShellAt('/requests')

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My requests', 'Review queue'])
    links.forEach((link) => expect(link.tagName).toBe('A'))
  })

  it('renders the routed content via <Outlet/>', async () => {
    await renderShellAt('/requests')

    expect(screen.getByText('requests')).not.toBeNull()
  })
})

describe('RefundShell nav active state (aria-current)', () => {
  it('marks "My requests" active on /requests, "Review queue" not active', async () => {
    await renderShellAt('/requests')

    expect(screen.getByRole('link', { name: 'My requests' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Review queue' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks "Review queue" active on /review, "My requests" not active', async () => {
    await renderShellAt('/review')

    expect(screen.getByRole('link', { name: 'Review queue' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'My requests' }).getAttribute('aria-current')).toBeNull()
  })
})
