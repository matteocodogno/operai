/**
 * @vitest-environment jsdom
 *
 * Component tests for ShellLayout (specs/003-suite-shell, T5, AC-1.1).
 *
 * ShellLayout renders a real TanStack Router `<Outlet/>` (not a children
 * prop) because T9 mounts it as the root layout route's component, and the
 * content region must be the actual router outlet so `/estimai/*`/`/refund/*`
 * can mount there without ShellLayout being restructured later. `<Outlet/>`
 * needs a router context to render, so these tests build a minimal
 * throwaway router (a root route rendering ShellLayout + one child route
 * rendering known content) rather than mocking Outlet away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRootRoute, createRoute, createRouter, Link, RouterProvider } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { ShellLayout, SHELL_MAIN_CONTENT_ID } from './ShellLayout'
import Sidebar from './Sidebar'
import { registerNavigationBlocker, resetNavigationBlocker } from '../lib/navigationBlocker'

// jsdom doesn't implement scrollIntoView/scrollTo; TanStack Router's
// navigation and hash-scroll restoration call them (the latter when the URL
// carries a `#fragment`, as it will once the skip-link test below pushes
// `#shell-main-content` via `history.pushState`). Stub both so that
// behavior neither throws nor spams "Not implemented" to stderr in later
// tests — this is a jsdom gap, not something the component should work
// around.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.scrollTo = vi.fn() as typeof window.scrollTo
})

afterEach(() => {
  resetNavigationBlocker()
  cleanup()
  // Reset the URL between tests: the skip link mutates `window.history` via
  // `pushState`, and jsdom's `window`/`history` persist across tests within
  // this file, so leaving the hash in place would leak into later tests.
  window.history.pushState(null, '', '/')
  // The collapse toggle persists to localStorage — clear it so a collapse test
  // doesn't leak a `true` into a later test's initial rail width.
  localStorage.clear()
})

/**
 * Builds a tiny router: `/` renders `layout` with a known child route
 * mounted at the Outlet, and awaits the router's initial async route
 * resolution before handing control back — so every test starts from a
 * settled DOM instead of racing TanStack Router's first render.
 */
async function renderWithRouter(layout: () => ReactElement) {
  const rootRoute = createRootRoute({ component: layout })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p data-testid="outlet-content">Tool content</p>,
  })
  const routeTree = rootRoute.addChildren([indexRoute])
  const router = createRouter({ routeTree })
  const result = render(<RouterProvider router={router} />)
  await screen.findByTestId('outlet-content')
  return result
}

describe('ShellLayout', () => {
  it('renders the banner, nav, main, and contentinfo landmarks', async () => {
    await renderWithRouter(() => <ShellLayout />)

    expect(screen.getByRole('banner')).toBeDefined()
    expect(screen.getByRole('navigation', { name: /tool navigation/i })).toBeDefined()
    expect(screen.getByRole('main')).toBeDefined()
    expect(screen.getByRole('contentinfo')).toBeDefined()
  })

  it('renders the Outlet content region with the matched route content', async () => {
    await renderWithRouter(() => <ShellLayout />)

    expect(screen.getByTestId('outlet-content')).toBeDefined()
  })

  it('renders exactly one main landmark (single-main-landmark invariant)', async () => {
    await renderWithRouter(() => <ShellLayout />)

    expect(screen.getAllByRole('main')).toHaveLength(1)
  })

  it('renders a skip-to-content link as the first focusable element, targeting main', async () => {
    await renderWithRouter(() => <ShellLayout />)

    const skipLink = screen.getByRole('link', { name: /skip to content/i })
    expect(skipLink.getAttribute('href')).toBe(`#${SHELL_MAIN_CONTENT_ID}`)

    const focusable = document.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')
    expect(focusable[0]).toBe(skipLink)
  })

  it('moves focus to the main content region when the skip link is activated', async () => {
    await renderWithRouter(() => <ShellLayout />)

    const skipLink = screen.getByRole('link', { name: /skip to content/i })
    fireEvent.click(skipLink)

    expect(document.activeElement?.id).toBe(SHELL_MAIN_CONTENT_ID)
  })

  it('falls back to placeholder header/sidebar/footer when no chrome slots are given', async () => {
    await renderWithRouter(() => <ShellLayout />)

    expect(screen.getByText(/header placeholder/i)).toBeDefined()
    expect(screen.getByText(/sidebar placeholder/i)).toBeDefined()
    expect(screen.getByText(/footer placeholder/i)).toBeDefined()
  })

  it('sizes the nav rail from the shared collapse state driven by the Sidebar toggle', async () => {
    const user = userEvent.setup()
    const rootRoute = createRootRoute({ component: () => <ShellLayout sidebar={<Sidebar />} /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <p data-testid="outlet-content">Tool content</p>,
    })
    // Splat routes so the Sidebar's `/estimai` and `/refund` Links resolve.
    const estimaiRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/estimai/$',
      component: () => <p>estimai</p>,
    })
    const refundRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/refund/$',
      component: () => <p>refund</p>,
    })
    const routeTree = rootRoute.addChildren([indexRoute, estimaiRoute, refundRoute])
    const router = createRouter({ routeTree })
    render(<RouterProvider router={router} />)
    await screen.findByTestId('outlet-content')

    const nav = screen.getByRole('navigation', { name: /tool navigation/i })
    expect(nav.className).toContain('w-56') // expanded

    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }))
    expect(nav.className).toContain('w-16') // collapsed to icons-only rail

    await user.click(screen.getByRole('button', { name: /expand sidebar/i }))
    expect(nav.className).toContain('w-56') // back to expanded
  })

  it('renders provided header/sidebar/footer slots instead of the placeholders', async () => {
    await renderWithRouter(() => (
      <ShellLayout
        header={<span>Custom header</span>}
        sidebar={<span>Custom sidebar</span>}
        footer={<span>Custom footer</span>}
      />
    ))

    expect(screen.getByText('Custom header')).toBeDefined()
    expect(screen.getByText('Custom sidebar')).toBeDefined()
    expect(screen.getByText('Custom footer')).toBeDefined()
    expect(screen.queryByText(/header placeholder/i)).toBeNull()
    expect(screen.queryByText(/sidebar placeholder/i)).toBeNull()
    expect(screen.queryByText(/footer placeholder/i)).toBeNull()
  })
})

// specs/021-meetings, T50 (AC-2.10): the shell honours a navigation blocker a
// remote registered through shell/session — useBlocker + a ConfirmDialog.
describe('ShellLayout — navigation blocker (AC-2.10)', () => {
  async function renderWithBlockerRouter() {
    const rootRoute = createRootRoute({ component: () => <ShellLayout /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <>
          <p data-testid="home">Home</p>
          <Link to="/account">Go elsewhere</Link>
        </>
      ),
    })
    const otherRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/account',
      component: () => <p data-testid="other">Other</p>,
    })
    const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, otherRoute]) })
    render(<RouterProvider router={router} />)
    await screen.findByTestId('home')
    return router
  }

  it('lets navigation through when no blocker is registered', async () => {
    const user = userEvent.setup()
    const router = await renderWithBlockerRouter()

    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))

    expect(await screen.findByTestId('other')).toBeDefined()
    expect(router.state.location.pathname).toBe('/account')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks before leaving while a blocker says so: title, the remote\'s message, focus on Stay', async () => {
    const user = userEvent.setup()
    registerNavigationBlocker(() => true, 'A recording is in progress. If you leave, it will be stopped and saved.')
    const router = await renderWithBlockerRouter()

    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Leave this page?' })
    expect(dialog.textContent).toContain('A recording is in progress. If you leave, it will be stopped and saved.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stay' }))
    expect(router.state.location.pathname).toBe('/')
  })

  it('Stay cancels the navigation and closes the dialog', async () => {
    const user = userEvent.setup()
    registerNavigationBlocker(() => true, 'Unsaved.')
    const router = await renderWithBlockerRouter()
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))
    await screen.findByRole('alertdialog')

    await user.click(screen.getByRole('button', { name: 'Stay' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(router.state.location.pathname).toBe('/')
    expect(screen.getByTestId('home')).toBeDefined()
  })

  it('Escape is Stay: it cancels the navigation too', async () => {
    const user = userEvent.setup()
    registerNavigationBlocker(() => true, 'Unsaved.')
    const router = await renderWithBlockerRouter()
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))
    await screen.findByRole('alertdialog')

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(router.state.location.pathname).toBe('/')
  })

  it('Leave lets the navigation proceed', async () => {
    const user = userEvent.setup()
    registerNavigationBlocker(() => true, 'Unsaved.')
    const router = await renderWithBlockerRouter()
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))
    await screen.findByRole('alertdialog')

    await user.click(screen.getByRole('button', { name: 'Leave' }))

    expect(await screen.findByTestId('other')).toBeDefined()
    expect(router.state.location.pathname).toBe('/account')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('unregistering lets navigation through again', async () => {
    const user = userEvent.setup()
    const unregister = registerNavigationBlocker(() => true, 'Unsaved.')
    const router = await renderWithBlockerRouter()
    unregister()

    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))

    expect(await screen.findByTestId('other')).toBeDefined()
    expect(router.state.location.pathname).toBe('/account')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('does not ask when the blocker answers false at the moment of navigation', async () => {
    const user = userEvent.setup()
    registerNavigationBlocker(() => false, 'Unsaved.')
    const router = await renderWithBlockerRouter()

    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))

    expect(await screen.findByTestId('other')).toBeDefined()
    expect(router.state.location.pathname).toBe('/account')
  })

  it('never traps the person behind a blocker that throws', async () => {
    const user = userEvent.setup()
    registerNavigationBlocker(() => {
      throw new Error('remote bug')
    }, 'Unsaved.')
    const router = await renderWithBlockerRouter()

    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }))

    expect(await screen.findByTestId('other')).toBeDefined()
    expect(router.state.location.pathname).toBe('/account')
  })

  it('does not ask for a change that stays on the same page (a search-param update)', async () => {
    registerNavigationBlocker(() => true, 'Unsaved.')
    const router = await renderWithBlockerRouter()

    router.history.push('/?tab=notes')

    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'notes' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
