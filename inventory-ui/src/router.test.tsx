/**
 * @vitest-environment jsdom
 *
 * Router structure + navigation tests for inventory-ui's inner router (T24,
 * specs/015-hardware-inventory — "the router test resolves all six routes and
 * the not-found route"). Mirrors refund-ui/src/router.test.tsx: structural
 * assertions on the route tree plus behavioural RouterProvider renders on the
 * basepath-less `createAppRouter()` factory. Every page is a placeholder in
 * T24, so a route "resolves" when its page's test id is in the DOM.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Outlet, RouterProvider } from '@tanstack/react-router'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  usePermissions: vi.fn(() => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] })),
}))

interface RouteTreeNode {
  id: string
  fullPath?: string
}

/** Imports the router module fresh (cache-busted) so each test builds its own route tree/instance. */
let importCount = 0
const importRouter = () => import('./router?t=' + Date.now() + '-' + importCount++)

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

const mountAt = async (path: string) => {
  window.history.pushState(null, '', path)
  const { createAppRouter } = await importRouter()
  const router = createAppRouter()
  render(<RouterProvider router={router} />)
  return router
}

describe('router structure', () => {
  it('mounts the index redirect plus the six tool routes as direct children of root', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childPaths = (routeTree.children ?? [])
      .map((child) => child.fullPath)
      .filter((path): path is string => path !== undefined)
      .sort()

    expect(childPaths).toEqual(
      ['/', '/assets', '/assets/new', '/assets/$id', '/rules', '/years', '/years/$entity/$year'].sort(),
    )
  })

  it('has no `_authed` (or other guard) layout route in the tree — ADR-0006: a remote owns no auth guard', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    expect((routeTree.children ?? []).map((child) => child.id)).not.toContain('_authed')
  })

  it('does not route the devices view: /devices is the shell-owned ungated entry (ADR-0045), not part of this tree', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    expect((routeTree.children ?? []).map((child) => child.fullPath)).not.toContain('/devices')
  })
})

describe('the six routes and the not-found route render client-side', () => {
  it.each([
    ['/assets', 'inventory-assets-page'],
    ['/assets/new', 'inventory-register-asset-page'],
    ['/assets/a-1', 'inventory-asset-detail-page'],
    ['/rules', 'inventory-rules-page'],
    ['/years', 'inventory-fiscal-years-page'],
    ['/years/welld_ch/2025', 'inventory-fiscal-year-detail-page'],
    ['/no/such/path', 'inventory-not-found-page'],
  ])('visiting %s renders %s', async (path, testId) => {
    await mountAt(path)

    expect(await screen.findByTestId(testId)).not.toBeNull()
  })

  it('/assets/new is the register route, not the detail route with id "new"', async () => {
    await mountAt('/assets/new')

    await screen.findByTestId('inventory-register-asset-page')
    expect(screen.queryByTestId('inventory-asset-detail-page')).toBeNull()
  })

  it('resolves the $id param on the asset detail route', async () => {
    const router = await mountAt('/assets/asset-42')

    await screen.findByTestId('inventory-asset-detail-page')
    expect(router.state.matches.at(-1)?.params).toEqual({ id: 'asset-42' })
  })

  it('resolves the $entity and $year params on the fiscal year detail route', async () => {
    const router = await mountAt('/years/welld_it/2024')

    await screen.findByTestId('inventory-fiscal-year-detail-page')
    expect(router.state.matches.at(-1)?.params).toEqual({ entity: 'welld_it', year: '2024' })
  })

  it('the index route redirects to /assets', async () => {
    await mountAt('/')

    expect(await screen.findByTestId('inventory-assets-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/assets')
  })

  it('moves focus to the not-found heading so a keyboard user lands on the message', async () => {
    await mountAt('/nowhere')

    const page = await screen.findByTestId('inventory-not-found-page')
    const heading = page.querySelector('h2')
    expect(heading).not.toBeNull()
    expect(document.activeElement).toBe(heading)
  })
})

describe('root layout seam', () => {
  it('renders a root component passed to createAppRouter around every route (T28 injects InventoryShell here without editing router.tsx)', async () => {
    window.history.pushState(null, '', '/assets')
    const { createAppRouter } = await importRouter()
    const Root = () => (
      <div data-testid="custom-root">
        <Outlet />
      </div>
    )
    render(<RouterProvider router={createAppRouter(undefined, Root)} />)

    const root = await screen.findByTestId('custom-root')
    expect(root.querySelector('[data-testid="inventory-assets-page"]')).not.toBeNull()
  })

  it('honours a basepath: /inventory/assets resolves the assets route', async () => {
    window.history.pushState(null, '', '/inventory/assets')
    const { createAppRouter } = await importRouter()

    render(<RouterProvider router={createAppRouter('/inventory')} />)

    expect(await screen.findByTestId('inventory-assets-page')).not.toBeNull()
  })
})
