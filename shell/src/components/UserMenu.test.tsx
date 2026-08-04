/**
 * @vitest-environment jsdom
 *
 * Component tests for UserMenu.
 *
 * Ported from estimai-ui/src/components/UserMenu.test.tsx (T6, specs/003-suite-shell,
 * AC-1.4; originally T8, specs/002) — unchanged. The user menu is an avatar button that
 * opens a dropdown. The avatar is always visible; the full name/email, "My profile", and
 * the sign-out control live inside the menu.
 *
 * Asserts:
 *   (a) the avatar (image or initial fallback) renders without opening the menu.
 *   (b) clicking the avatar opens a menu showing the user's name (and email).
 *   (c) the name is NOT visible until the menu is opened.
 *   (d) the sign-out item inside the menu calls onSignOut.
 *   (e) the menu closes on Escape.
 *   (f) "My profile" (T15, specs/012-employee-address, US-6 AC-6.1, ADR-0034) is a real
 *       link to /account and closes the menu when activated.
 *
 * `renderUserMenu` wraps every render in a real, minimal TanStack Router harness
 * (mirroring Sidebar.test.tsx / Bell.test.tsx's technique) because UserMenu (T15) now
 * renders a genuine `<Link to="/account">` inside the open menu — `useLinkProps` throws
 * outside a `<RouterProvider>` (`Cannot read properties of null (reading 'isServer')`), so
 * a bare `render(<UserMenu .../>)` no longer works once the menu is opened. A mocked
 * `Link` would also test nothing real about the "My profile" navigation.
 *
 * Every test below passes an explicit `onSignOut`, so the component's default
 * (wired to shell/session's `signOut`, see UserMenu.tsx) is not exercised here — that
 * default is a static wiring guarantee (source-verified: `onSignOut = defaultOnSignOut`
 * imports `signOut` from ../lib/session), not independently re-tested at this layer to
 * avoid duplicating session.test.ts's coverage of signOut's own behavior.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import UserMenu from './UserMenu'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

type UserMenuProps = Parameters<typeof UserMenu>[0]

/**
 * Builds a tiny router — a root layout rendering UserMenu + an Outlet, an index route,
 * and an `/account` route with recognizable content — then renders it, mirroring
 * Sidebar.test.tsx's `renderSidebarAt` / Bell.test.tsx's `renderBellAt` harness. Awaits
 * the avatar button before returning — the initial route match resolves asynchronously,
 * so a synchronous `render()` alone leaves the DOM empty for the first tick (same reason
 * Sidebar.test.tsx's harness awaits its own always-rendered element).
 */
async function renderUserMenu(props: UserMenuProps) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <UserMenu {...props} />
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' })
  const accountRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/account',
    component: () => <p data-testid="account-content">account</p>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, accountRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  const displayName = props.user.name || props.user.email || 'Account'
  await screen.findByRole('button', { name: displayName })
  return { router, ...utils }
}

const openMenu = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('UserMenu', () => {
  describe('(a) avatar renders without opening the menu', () => {
    it('renders the avatar image when an image URL is provided', async () => {
      await renderUserMenu({
        user: { name: 'Alice Welld', email: null, image: 'https://example.com/avatar.png' },
        onSignOut: () => {},
      })
      const img = screen.getByRole('img', { name: 'Alice Welld' }) as HTMLImageElement
      expect(img.src).toBe('https://example.com/avatar.png')
    })

    it('shows an initial-letter fallback when no image is provided', async () => {
      await renderUserMenu({ user: { name: 'Bob Builder', email: null, image: null }, onSignOut: () => {} })
      const fallback = screen.getByLabelText('Bob Builder')
      expect(fallback.tagName.toLowerCase()).toBe('span')
      expect(fallback.textContent).toBe('B')
    })
  })

  describe('(b) opening the menu reveals the name/email', () => {
    it('shows the name after the avatar is clicked', async () => {
      await renderUserMenu({
        user: { name: 'Alice Welld', email: 'alice@welld.ch', image: null },
        onSignOut: () => {},
      })
      openMenu('Alice Welld')
      const menu = screen.getByRole('menu')
      expect(menu.textContent).toContain('Alice Welld')
      expect(menu.textContent).toContain('alice@welld.ch')
    })

    it('falls back to email as the name when user.name is null', async () => {
      await renderUserMenu({ user: { name: null, email: 'alice@welld.ch', image: null }, onSignOut: () => {} })
      openMenu('alice@welld.ch')
      expect(screen.getByRole('menu').textContent).toContain('alice@welld.ch')
    })

    it('falls back to "Account" when both name and email are null', async () => {
      await renderUserMenu({ user: { name: null, email: null, image: null }, onSignOut: () => {} })
      openMenu('Account')
      expect(screen.getByRole('menu').textContent).toContain('Account')
    })
  })

  describe('(c) the menu is closed by default', () => {
    it('does not render a menu until the avatar is clicked', async () => {
      await renderUserMenu({
        user: { name: 'Alice Welld', email: 'alice@welld.ch', image: null },
        onSignOut: () => {},
      })
      expect(screen.queryByRole('menu')).toBeNull()
      // The name is not present anywhere until opened.
      expect(screen.queryByText('alice@welld.ch')).toBeNull()
    })
  })

  describe('(d) sign-out lives inside the menu and calls onSignOut', () => {
    it('invokes onSignOut exactly once when the sign-out item is clicked', async () => {
      const onSignOut = vi.fn()
      await renderUserMenu({ user: { name: 'Alice Welld', email: null, image: null }, onSignOut })
      // Not present before opening.
      expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull()

      openMenu('Alice Welld')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
      expect(onSignOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('(e) the menu closes on Escape', () => {
    it('hides the menu when Escape is pressed', async () => {
      await renderUserMenu({ user: { name: 'Alice Welld', email: null, image: null }, onSignOut: () => {} })
      openMenu('Alice Welld')
      expect(screen.getByRole('menu')).toBeDefined()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  describe('(f) "My profile" links to /account (T15, AC-6.1)', () => {
    it('is not present before the menu is opened', async () => {
      await renderUserMenu({ user: { name: 'Alice Welld', email: null, image: null }, onSignOut: () => {} })
      expect(screen.queryByRole('menuitem', { name: 'My profile' })).toBeNull()
    })

    it('renders a menuitem linking to /account, between the identity block and Sign out', async () => {
      await renderUserMenu({ user: { name: 'Alice Welld', email: null, image: null }, onSignOut: () => {} })
      openMenu('Alice Welld')

      const menu = screen.getByRole('menu')
      const items = menu.querySelectorAll('[role="menuitem"]')
      expect(items).toHaveLength(2)
      expect(items[0].textContent).toBe('My profile')
      expect(items[0].getAttribute('href')).toBe('/account')
      expect(items[1].textContent).toBe('Sign out')
    })

    it('navigates to /account and closes the menu when clicked', async () => {
      const { router } = await renderUserMenu({
        user: { name: 'Alice Welld', email: null, image: null },
        onSignOut: () => {},
      })
      openMenu('Alice Welld')

      fireEvent.click(screen.getByRole('menuitem', { name: 'My profile' }))

      expect(await screen.findByTestId('account-content')).not.toBeNull()
      expect(router.state.location.pathname).toBe('/account')
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
})
