/**
 * @vitest-environment jsdom
 *
 * Component tests for Sidebar (specs/20260709-suite-shell, T7, AC-3.1, AC-5.1;
 * app-access filtering added in specs/20260713-auth-roles-permissions, T24,
 * AC-7.1, AC-7.2).
 *
 * Uses a real, minimal TanStack Router harness (mirroring router.integration.test.tsx's
 * technique) rather than mocking `Link`/`useMatchRoute` — the whole point of AC-3.1 is
 * that the active state comes from the ACTUAL current route, and TanStack Router's own
 * fuzzy-match + `aria-current` mechanism is what this component leans on, so a fake
 * router would test nothing real.
 *
 * `usePermissions` (shell/session, T23) IS mocked here, deliberately: it is the one
 * dependency this task adds, and controlling its return value directly is how each test
 * pins down exactly which apps the signed-in user has, without standing up a fake
 * `/authz/me` fetch. The default (`beforeEach`) grants `estimai` + `refund` — but not
 * `admin` — so every pre-existing test in this file keeps observing the same two-item
 * list it always has; the new "app-access filtering" describe block below overrides the
 * mock per test to exercise the filtering itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import type { PermissionsResult } from '../lib/session'

const { usePermissions } = vi.hoisted(() => ({ usePermissions: vi.fn() }))
vi.mock('../lib/session', () => ({ usePermissions }))

import Sidebar from './Sidebar'
import { SidebarCollapsedProvider } from '../hooks/SidebarCollapsedProvider'

/** Builds a full PermissionsResult from just the `apps` the test cares about. */
const permissionsWith = (apps: string[]): PermissionsResult => ({
  epoch: 0,
  apps,
  roles: [],
  departments: [],
  permissions: [],
})

beforeEach(() => {
  // Default: both non-admin tools granted, admin not — matches every
  // pre-existing test's expectation of a two-item EstimAI/Refund list.
  usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund']))
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
  vi.clearAllMocks()
  // The collapse toggle persists to localStorage; clear it so a collapse test
  // doesn't leak a `true` into a later test's initial state.
  localStorage.clear()
})

/**
 * Builds a tiny router — a root layout rendering Sidebar + an Outlet, with an index
 * route and one splat route per tool (`/estimai/$`, `/refund/$`, `/admin/$`), mirroring
 * the real shell router's tool-route shape (router.tsx) closely enough that a deep link
 * like `/refund/anything` resolves and Sidebar's active-match behaves exactly as it does
 * in the real app — then navigates to `path` before the first render so the initial
 * match reflects that route on first paint.
 *
 * Waits on the always-rendered collapse toggle (not a tool link) so this helper works
 * even when a test's mocked `usePermissions()` grants zero apps — there would be no tool
 * link to wait for in that case.
 */
async function renderSidebarAt(path: string) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({
    component: () => (
      <SidebarCollapsedProvider>
        <Sidebar />
        <Outlet />
      </SidebarCollapsedProvider>
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
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/$',
    component: () => <p data-testid="admin-content">admin</p>,
  })
  const letterheadsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/letterheads/$',
    component: () => <p data-testid="letterheads-content">letterheads</p>,
  })
  const projectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$',
    component: () => <p data-testid="projects-content">projects</p>,
  })
  const accountingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounting/$',
    component: () => <p data-testid="accounting-content">accounting</p>,
  })
  const routeTree = rootRoute.addChildren([
    indexRoute,
    estimaiRoute,
    refundRoute,
    adminRoute,
    letterheadsRoute,
    projectsRoute,
    accountingRoute,
  ])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByRole('button', { name: /collapse sidebar|expand sidebar/i })
  return { router, ...utils }
}

describe('Sidebar entries', () => {
  it('renders both tool entries with correct labels and hrefs', async () => {
    await renderSidebarAt('/estimai')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund' })

    expect(estimaiLink.getAttribute('href')).toBe('/estimai')
    expect(refundLink.getAttribute('href')).toBe('/refund')
  })

  it('renders as a flat two-item list with no nested items', async () => {
    await renderSidebarAt('/estimai')

    expect(screen.getAllByRole('link')).toHaveLength(2)
  })
})

describe('Sidebar app-access filtering (T24, AC-7.1, AC-7.2)', () => {
  it('renders only the tools present in usePermissions().apps', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai']))
    await renderSidebarAt('/estimai')

    expect(screen.getByRole('link', { name: 'EstimAI' })).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Refund' })).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('does not show the Admin entry when apps does not include "admin"', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund']))
    await renderSidebarAt('/estimai')

    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull()
  })

  it('shows the Admin entry, with the correct href, when apps includes "admin"', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin']))
    await renderSidebarAt('/estimai')

    const adminLink = screen.getByRole('link', { name: 'Admin' })
    expect(adminLink.getAttribute('href')).toBe('/admin')
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })

  it('pins the Admin entry to the bottom section (with the collapse toggle), not the scrollable tool list', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin']))
    await renderSidebarAt('/estimai')

    const adminLink = screen.getByRole('link', { name: 'Admin' })
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i })
    // Admin is NOT inside the scrollable <ul> of workflow tools…
    expect(adminLink.closest('ul')).toBeNull()
    // …and it shares the pinned bottom container with the collapse toggle.
    expect(adminLink.parentElement).toBe(toggle.parentElement)
    // The workflow tools ARE still in the <ul>.
    expect(screen.getByRole('link', { name: 'EstimAI' }).closest('ul')).not.toBeNull()
  })

  it('renders no tool entries while permissions are unresolved (apps: []), never flashing the full tool list', async () => {
    usePermissions.mockReturnValue(permissionsWith([]))
    await renderSidebarAt('/estimai')

    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryByText('EstimAI')).toBeNull()
    expect(screen.queryByText('Refund')).toBeNull()
    expect(screen.queryByText('Admin')).toBeNull()
    // The rest of the chrome (collapse toggle) still renders — only the tool
    // list itself is empty, not the whole component.
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeDefined()
  })

  it('keeps exactly one valid roving tab stop when the permitted list has a single tool', async () => {
    usePermissions.mockReturnValue(permissionsWith(['refund']))
    await renderSidebarAt('/refund')

    const refundLink = screen.getByRole('link', { name: 'Refund' })
    expect(refundLink.tabIndex).toBe(0)
  })
})

describe('Sidebar active state (AC-3.1)', () => {
  it('marks EstimAI active with aria-current="page" when on /estimai', async () => {
    await renderSidebarAt('/estimai')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund' })

    expect(estimaiLink.getAttribute('aria-current')).toBe('page')
    expect(refundLink.getAttribute('aria-current')).toBeNull()
  })

  it('marks Refund active with aria-current="page" on a deep-linked refund sub-path', async () => {
    await renderSidebarAt('/refund/whatever')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = await screen.findByRole('link', { name: 'Refund' })

    expect(refundLink.getAttribute('aria-current')).toBe('page')
    expect(estimaiLink.getAttribute('aria-current')).toBeNull()
  })
})

describe('Sidebar keyboard operation (roving tabindex + arrow keys)', () => {
  it('starts the roving tab stop on the active entry; only one entry is in the tab order', async () => {
    await renderSidebarAt('/refund')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund' })

    expect(refundLink.tabIndex).toBe(0)
    expect(estimaiLink.tabIndex).toBe(-1)
  })

  it('falls back to the first entry as the tab stop when no tool is active', async () => {
    await renderSidebarAt('/')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund' })

    expect(estimaiLink.tabIndex).toBe(0)
    expect(refundLink.tabIndex).toBe(-1)
  })

  it('ArrowDown moves focus and the roving tabindex to the next entry', async () => {
    const user = userEvent.setup()
    await renderSidebarAt('/estimai')

    const estimaiLink = screen.getByRole('link', { name: 'EstimAI' })
    const refundLink = screen.getByRole('link', { name: 'Refund' })

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
    const refundLink = screen.getByRole('link', { name: 'Refund' })

    estimaiLink.focus()
    await user.keyboard('{ArrowUp}')

    // Wraps from the first entry to the last.
    expect(document.activeElement).toBe(refundLink)
    expect(refundLink.tabIndex).toBe(0)
    expect(estimaiLink.tabIndex).toBe(-1)
  })
})

describe('Sidebar collapse toggle', () => {
  it('starts expanded: labels visible, toggle offers to collapse', async () => {
    await renderSidebarAt('/estimai')

    const toggle = screen.getByRole('button', { name: /collapse sidebar/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // The label text is present and NOT visually hidden while expanded.
    expect(screen.getByText('EstimAI').classList.contains('sr-only')).toBe(false)
  })

  it('collapsing hides the labels (sr-only) and flips the toggle to Expand; links keep their accessible name', async () => {
    const user = userEvent.setup()
    await renderSidebarAt('/estimai')

    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }))

    // Toggle now offers to expand.
    const toggle = screen.getByRole('button', { name: /expand sidebar/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Label text is still in the DOM but visually hidden…
    expect(screen.getByText('EstimAI').classList.contains('sr-only')).toBe(true)
    // …so the link's accessible name (icon is aria-hidden) is unchanged.
    expect(screen.getByRole('link', { name: 'EstimAI' })).toBeDefined()
    // Persisted for the next reload.
    expect(localStorage.getItem('operai_sidebar_collapsed')).toBe('true')
  })

  it('starts collapsed when localStorage says so', async () => {
    localStorage.setItem('operai_sidebar_collapsed', 'true')
    await renderSidebarAt('/estimai')

    expect(screen.getByRole('button', { name: /expand sidebar/i }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('EstimAI').classList.contains('sr-only')).toBe(true)
  })
})

describe('Sidebar Settings group (rarely used tools pinned above Admin)', () => {
  const withSettings = () => usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin', 'letterheads']))
  const settingsButton = () => screen.getByRole('button', { name: 'Settings' })

  it('moves Letterheads out of the scrollable list into a closed Settings group, between the list and Admin', async () => {
    withSettings()
    await renderSidebarAt('/estimai')

    const button = settingsButton()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    // Closed: the entry is not shown (hidden list), so it is not a link to anyone.
    expect(screen.queryByRole('link', { name: 'Letterheads' })).toBeNull()
    // Not in the scrollable list of workflow tools.
    const toolList = screen.getByRole('link', { name: 'EstimAI' }).closest('ul')!
    expect(toolList.contains(button)).toBe(false)
    // Order: the tool list, then Settings, then Admin.
    const admin = screen.getByRole('link', { name: 'Admin' })
    expect(toolList.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(button.compareDocumentPosition(admin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens on click, shows Letterheads linking to /letterheads, and remembers it', async () => {
    const user = userEvent.setup()
    withSettings()
    await renderSidebarAt('/estimai')

    await user.click(settingsButton())

    expect(settingsButton().getAttribute('aria-expanded')).toBe('true')
    const list = document.getElementById(settingsButton().getAttribute('aria-controls')!)!
    const link = screen.getByRole('link', { name: 'Letterheads' })
    expect(list.contains(link)).toBe(true)
    expect(link.getAttribute('href')).toBe('/letterheads')
    expect(localStorage.getItem('operai_sidebar_settings_open')).toBe('true')

    await user.click(settingsButton())
    expect(settingsButton().getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('operai_sidebar_settings_open')).toBe('false')
  })

  it('starts open when localStorage says so', async () => {
    localStorage.setItem('operai_sidebar_settings_open', 'true')
    withSettings()
    await renderSidebarAt('/estimai')

    expect(settingsButton().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('link', { name: 'Letterheads' })).toBeDefined()
  })

  it('is open, with Letterheads marked current, on a Letterheads route', async () => {
    withSettings()
    await renderSidebarAt('/letterheads/versions')

    expect(settingsButton().getAttribute('aria-expanded')).toBe('true')
    expect((await screen.findByRole('link', { name: 'Letterheads' })).getAttribute('aria-current')).toBe('page')
  })

  it('is absent when the person has no settings tool', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin']))
    await renderSidebarAt('/estimai')

    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('collapsed to icons: shows the Settings icon, not its tools; a click expands the rail with the group open', async () => {
    const user = userEvent.setup()
    localStorage.setItem('operai_sidebar_collapsed', 'true')
    withSettings()
    await renderSidebarAt('/estimai')

    expect(screen.queryByRole('link', { name: 'Letterheads' })).toBeNull()
    const button = screen.getByRole('button', { name: 'Settings' })
    expect(button.getAttribute('title')).toBe('Settings')

    await user.click(button)

    expect(screen.getByRole('button', { name: /collapse sidebar/i }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('link', { name: 'Letterheads' }).getAttribute('href')).toBe('/letterheads')
  })

  it('collapsed on a Letterheads route: the Settings icon is highlighted', async () => {
    localStorage.setItem('operai_sidebar_collapsed', 'true')
    withSettings()
    await renderSidebarAt('/letterheads/versions')

    expect(screen.getByRole('button', { name: 'Settings' }).className).toContain('text-acc')
  })

  it('keeps Letterheads out of the arrow-key group of the tool list', async () => {
    const user = userEvent.setup()
    withSettings()
    await renderSidebarAt('/estimai')

    const estimai = screen.getByRole('link', { name: 'EstimAI' })
    estimai.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    // EstimAI → Refund → wraps to EstimAI: only the two list tools take part.
    expect(document.activeElement).toBe(estimai)
  })
})

// specs/20261119-accounting (AC-8.1, design UX-14, G1): Accounting is an ordinary gated tool, last in the main list, shown
// only with `apps ∋ accounting` (which `/authz/me` derives from `accounting:read` or `accounting:manage`).
describe('Sidebar — Accounting (AC-8.1)', () => {
  it('shows Accounting to a caller whose apps include it, after Projects, linking to /accounting', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'projects', 'accounting']))
    await renderSidebarAt('/estimai')

    const link = screen.getByRole('link', { name: 'Accounting' })
    expect(link.getAttribute('href')).toBe('/accounting')
    const names = screen.getAllByRole('link').map((item) => item.textContent)
    expect(names).toEqual(['EstimAI', 'Projects', 'Accounting'])
    // An icon is drawn (every tool has one; the label span carries the accessible name).
    expect(link.querySelector('svg')).not.toBeNull()
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('does not show Accounting to a caller without it, whatever else they hold', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin', 'projects', 'letterheads']))
    await renderSidebarAt('/estimai')

    expect(screen.queryByRole('link', { name: 'Accounting' })).toBeNull()
  })

  it('keeps it in the main list (the arrow-key group), not in the Settings group, after Projects and before Admin', async () => {
    const user = userEvent.setup()
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'projects', 'accounting', 'admin', 'letterheads']))
    await renderSidebarAt('/estimai')

    const accounting = screen.getByRole('link', { name: 'Accounting' })
    const toolList = screen.getByRole('link', { name: 'EstimAI' }).closest('ul')!
    expect(toolList.contains(accounting)).toBe(true)
    const projects = screen.getByRole('link', { name: 'Projects' })
    expect(projects.compareDocumentPosition(accounting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      accounting.compareDocumentPosition(screen.getByRole('link', { name: 'Admin' })) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    screen.getByRole('link', { name: 'EstimAI' }).focus()
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(accounting)
  })

  it('marks Accounting current on any /accounting route', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'accounting']))
    await renderSidebarAt('/accounting/vat-codes?entity=welld_it')

    expect((await screen.findByRole('link', { name: 'Accounting' })).getAttribute('aria-current')).toBe('page')
  })
})
