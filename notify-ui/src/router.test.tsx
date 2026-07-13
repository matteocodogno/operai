/**
 * @vitest-environment jsdom
 *
 * Router structure + navigation tests for notify-ui's inner router (T14,
 * specs/005-notification-center/tasks.md). Mirrors
 * admin-ui/src/router.test.tsx's technique (structural assertions on the
 * route tree + behavioral RouterProvider renders), using the basepath-less
 * `createAppRouter()` factory; App.test.tsx separately covers the exposed
 * remote's own hardcoded `/notify` basepath.
 *
 * T15 (specs/005-notification-center/tasks.md) mocks `./lib/notificationsApi`
 * — see App.test.tsx's identical doc-comment note: `NotificationCenterPage`
 * now fetches on mount, and these tests only assert on the heading/not-found
 * fallback (rendered before any fetch settles), so a never-resolving pending
 * promise keeps a real, unmocked network call from escaping into the test
 * run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

vi.mock('./lib/notificationsApi', () => ({
  listNotifications: vi.fn(() => new Promise(() => {})),
  markAllRead: vi.fn(() => new Promise(() => {})),
}))

interface RouteTreeNode {
  id: string
  fullPath?: string
}

/** Imports the router module fresh (cache-busted) so each test builds its own route tree/instance. */
const importRouter = () => import('./router?t=' + Date.now())

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

describe('router structure', () => {
  it('mounts exactly one route — the index — as a direct child of root (single flat screen, no sections)', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childPaths = (routeTree.children ?? [])
      .map((child) => child.fullPath)
      .filter((path): path is string => path !== undefined)

    expect(childPaths).toEqual(['/'])
    expect(routeTree.children).toHaveLength(1)
  })

  it('has no `_authed` (or other guard) layout route in the tree — mirrors estimai-ui/admin-ui, AC-2.3', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childIds = (routeTree.children ?? []).map((child) => child.id)

    expect(childIds).not.toContain('_authed')
  })
})

describe('the notification center renders client-side', () => {
  it('visiting "/" renders the notification center page', async () => {
    window.history.pushState(null, '', '/')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('notify-center-heading')).not.toBeNull()
  })

  it('an unmatched path renders the not-found fallback', async () => {
    window.history.pushState(null, '', '/nonexistent')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('notify-not-found-page')).not.toBeNull()
  })
})
