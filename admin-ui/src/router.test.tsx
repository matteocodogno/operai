/**
 * @vitest-environment jsdom
 *
 * Router structure + navigation tests for admin-ui's inner router (T14,
 * specs/20260713-auth-roles-permissions/tasks.md — "give admin-ui its inner
 * TanStack Router … done when: the four sections route client-side under
 * `/admin`"). Mirrors estimai-ui/src/router.test.tsx's technique (structural
 * assertions on the route tree + behavioral RouterProvider renders), using
 * the basepath-less `createAppRouter()` factory for these tests; App.test.tsx
 * separately covers the exposed remote's own hardcoded `/admin` basepath.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import { getManageable } from './lib/legalEntitiesApi'
import type { LegalEntityId } from './lib/legalEntityModel'

// Pages read capabilities from shell/session's usePermissions() (INC-32); the
// stub defaults to no grants.
vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

// AdminShell reads which legal entities the person may manage (T35, plan E2): no network here.
vi.mock('./lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lib/legalEntitiesApi')>()
  return { ...original, getManageable: vi.fn() }
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a TanStack Router route object needed for these assertions. */
interface RouteTreeNode {
  id: string
  fullPath?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Imports the router module fresh (cache-busted) so each test builds its own route tree/instance. */
const importRouter = () => import('./router?t=' + Date.now())

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

type Grant = { resource: string; action: string }
const ADMIN_ACCESS: Grant = { resource: 'admin', action: 'access' }
const ENTITY_MANAGE: Grant = { resource: 'legal-entity', action: 'manage' }

/** The caller as `/authz/me` resolves them: `apps` carries "admin" for both an administrator and a manager. */
const signInWith = async (...permissions: Grant[]) => {
  const session = await import('shell/session')
  vi.mocked(session.usePermissions).mockReturnValue({
    epoch: 1,
    apps: ['admin'],
    roles: [],
    departments: [],
    permissions,
  })
}

/** A `manageable` answer the test settles by hand. */
const pendingManageable = () => {
  let resolve!: (entities: LegalEntityId[]) => void
  let reject!: (error: Error) => void
  vi.mocked(getManageable).mockReturnValueOnce(
    new Promise<LegalEntityId[]>((res, rej) => {
      resolve = res
      reject = rej
    }),
  )
  return { resolve, reject }
}

const renderAppAt = async (path: string) => {
  window.history.pushState(null, '', path)
  const { createAppRouter } = await importRouter()
  const router = createAppRouter()
  render(<RouterProvider router={router} />)
  return router
}

const sectionLinks = () =>
  within(screen.getByRole('navigation', { name: 'Admin sections' }))
    .getAllByRole('link')
    .map((link) => link.textContent)

beforeEach(async () => {
  // An administrator without the legal-entity grant: the default of every test below that says otherwise.
  await signInWith(ADMIN_ACCESS)
  vi.mocked(getManageable).mockReset()
  vi.mocked(getManageable).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('router structure', () => {
  it('mounts the index, the section routes (Legal entities among them), and the detail routes (role editor, department detail, user detail) as direct children of root', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childPaths = (routeTree.children ?? [])
      .map((child) => child.fullPath)
      .filter((path): path is string => path !== undefined)
      .sort()

    // Each detail screen ('/roles/$id' A2, '/departments/$id' B2, '/users/$id'
    // C2) is a sibling of its list route under the same root, not nested —
    // exactly like estimai-ui's '/estimates' + '/estimates/$estimateId' pair.
    // Combined centrally as T18/T19/T20 each added their own detail route.
    // '/time-lists' (T31, specs/029-time-tracking) is the same flat shape — a
    // section route, sibling of the others.
    expect(childPaths).toEqual(
      [
        '/',
        '/audit',
        '/departments',
        '/departments/$id',
        '/legal-entities',
        '/roles',
        '/roles/$id',
        '/time-lists',
        '/users',
        '/users/$id',
        '/users/access-requests',
        '/users/invitations',
      ].sort(),
    )
    expect(routeTree.children).toHaveLength(11)
  })

  it('has no `_authed` (or other guard) layout route in the tree — mirrors estimai-ui/T13, AC-2.3', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childIds = (routeTree.children ?? []).map((child) => child.id)

    expect(childIds).not.toContain('_authed')
  })
})

// ---------------------------------------------------------------------------
// Navigation — the four sections route client-side (this task's done-when)
// ---------------------------------------------------------------------------

describe('the four sections route client-side', () => {
  it.each([
    ['/roles', 'admin-roles-page', 'Roles'],
    ['/departments', 'admin-departments-page', 'Departments'],
    ['/users', 'admin-users-page', 'Users'],
    ['/audit', 'admin-audit-page', 'Audit'],
  ] as const)('visiting %s renders its section (%s) and marks its nav link active', async (path, testId, label) => {
    window.history.pushState(null, '', path)
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId(testId)).not.toBeNull()

    // Scoped to the "Admin sections" landmark specifically — the Users
    // section (T10, specs/20260713-user-invitations) additionally renders its own
    // UsersSubNav ("Active users"/"Invitations") landmark, which must not be
    // confused with SectionNav's four top-level links here.
    const sectionNav = screen.getByRole('navigation', { name: 'Admin sections' })
    const activeLink = within(sectionNav).getByRole('link', { name: label })
    expect(activeLink.getAttribute('aria-current')).toBe('page')

    // The other three sections' links are present but not active.
    const allLinks = within(sectionNav).getAllByRole('link')
    const inactiveLinks = allLinks.filter((link) => link !== activeLink)
    expect(inactiveLinks).toHaveLength(3)
    inactiveLinks.forEach((link) => expect(link.getAttribute('aria-current')).toBeNull())
  })

  it('visiting /users/invitations renders Screen U2 (InvitationsPage), not the /users/$id detail route (static-vs-dynamic-segment precedence, design.md Screen U2)', async () => {
    window.history.pushState(null, '', '/users/invitations')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('admin-invitations-page')).not.toBeNull()
    expect(screen.queryByTestId('admin-user-detail-page')).toBeNull()
  })

  it('visiting /users/access-requests renders the Access requests page, not the /users/$id detail route (specs/20261105-signup-gate, AC-3.1)', async () => {
    window.history.pushState(null, '', '/users/access-requests')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('admin-access-requests-page')).not.toBeNull()
    expect(screen.queryByTestId('admin-user-detail-page')).toBeNull()
  })

  it('root ("/") redirects to /roles', async () => {
    window.history.pushState(null, '', '/')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    await screen.findByTestId('admin-roles-page')
    expect(window.location.pathname).toBe('/roles')
  })

  it('an unmatched path renders the not-found fallback, with the section nav still mounted', async () => {
    window.history.pushState(null, '', '/nonexistent')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('admin-not-found-page')).not.toBeNull()
    // Chrome (nav) is not replaced by the not-found fallback.
    expect(screen.getByRole('navigation', { name: 'Admin sections' })).not.toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// Sections by capability (T35, specs/20261117-legal-entities, AC-4.3, plan decision 5 and E7)
// ---------------------------------------------------------------------------

describe('sections by capability', () => {
  it('an administrator without the grant sees Roles, Departments, Users and Audit, and no Legal entities', async () => {
    await renderAppAt('/roles')

    await screen.findByTestId('admin-roles-page')
    await waitFor(() => expect(getManageable).toHaveBeenCalled())
    expect(sectionLinks()).toEqual(['Roles', 'Departments', 'Users', 'Audit'])
  })

  it('an administrator without the grant is sent from /legal-entities to the first section they may use', async () => {
    await renderAppAt('/legal-entities')

    expect(await screen.findByTestId('admin-roles-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/roles')
    expect(screen.queryByTestId('admin-legal-entities-page')).toBeNull()
  })

  it('an administrator with the grant sees Legal entities between Users and the far-right Audit', async () => {
    vi.mocked(getManageable).mockResolvedValue(['welld_it', 'welld_ch'])
    await renderAppAt('/roles')

    await waitFor(() => expect(sectionLinks()).toEqual(['Roles', 'Departments', 'Users', 'Legal entities', 'Audit']))
    expect(screen.getByTestId('admin-roles-page')).not.toBeNull()
  })

  it('an administrator is not held back while manageable resolves: sections show at once, a skeleton tab holds the place', async () => {
    const manageable = pendingManageable()
    await renderAppAt('/roles')

    expect(await screen.findByTestId('admin-roles-page')).not.toBeNull()
    expect(sectionLinks()).toEqual(['Roles', 'Departments', 'Users', 'Audit'])
    expect(screen.queryByText('Loading…')).toBeNull() // the nav skeleton is silent; Roles has its own state
    manageable.resolve(['welld_ch'])
    await waitFor(() => expect(sectionLinks()).toContain('Legal entities'))
  })

  it.each(['/', '/roles', '/audit', '/users/invitations'])(
    'a manager-only person is redirected from %s to Legal entities after manageable resolves, and never sees a hidden section',
    async (path) => {
      await signInWith(ENTITY_MANAGE)
      const manageable = pendingManageable()
      await renderAppAt(path)

      // Resolving: skeleton + hidden live text, no redirect yet, nothing of the hidden section.
      expect(await screen.findByText('Loading…')).not.toBeNull()
      expect(window.location.pathname).toBe(path)
      expect(screen.queryByTestId('admin-roles-page')).toBeNull()
      expect(screen.queryByTestId('admin-audit-page')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Roles' })).toBeNull()

      manageable.resolve(['welld_ch'])

      expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
      expect(window.location.pathname).toBe('/legal-entities')
      expect(sectionLinks()).toEqual(['Legal entities'])
      expect(screen.queryByTestId('admin-roles-page')).toBeNull()
      expect(screen.queryByTestId('admin-audit-page')).toBeNull()
      expect(
        within(screen.getByRole('navigation', { name: 'Admin sections' }))
          .getByRole('link', { name: 'Legal entities' })
          .getAttribute('aria-current'),
      ).toBe('page')
    },
  )

  it('keeps an entity link as it is for a manager-only person (the CRM links to ?entity=)', async () => {
    await signInWith(ENTITY_MANAGE)
    vi.mocked(getManageable).mockResolvedValue(['welld_ch'])
    await renderAppAt('/legal-entities?entity=welld_ch&view=history&version=3')

    expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
    expect(window.location.search).toBe('?entity=welld_ch&view=history&version=3')
  })

  it('manageable failing: a Banner with Retry, no redirect, and Retry settles it', async () => {
    await signInWith(ENTITY_MANAGE)
    const first = pendingManageable()
    await renderAppAt('/roles')
    const second = pendingManageable()

    first.reject(new Error('503'))
    const banner = await screen.findByTestId('error-banner')
    expect(banner.textContent).toContain('The sections could not be loaded')
    expect(window.location.pathname).toBe('/roles')
    expect(screen.queryByTestId('admin-roles-page')).toBeNull()
    expect(screen.queryByTestId('admin-legal-entities-page')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Admin sections' })).toBeNull()

    await userEvent.click(screen.getByTestId('error-banner-retry'))
    expect(await screen.findByText('Loading…')).not.toBeNull()
    second.resolve(['welld_it'])

    expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/legal-entities')
  })

  it('manageable failing for an administrator: the Legal entities page shows the Banner, every other section still works', async () => {
    vi.mocked(getManageable).mockRejectedValue(new Error('network'))
    await renderAppAt('/roles')

    expect(await screen.findByTestId('admin-roles-page')).not.toBeNull()
    await waitFor(() => expect(getManageable).toHaveBeenCalled())
    expect(sectionLinks()).toEqual(['Roles', 'Departments', 'Users', 'Audit'])

    cleanup()
    await renderAppAt('/legal-entities')
    expect(await screen.findByTestId('error-banner')).not.toBeNull()
    expect(window.location.pathname).toBe('/legal-entities')
    expect(screen.queryByTestId('admin-roles-page')).toBeNull()
  })

  it('an administrator opening /legal-entities waits for manageable, then sees the page (grant) without a flash of another section', async () => {
    const manageable = pendingManageable()
    await renderAppAt('/legal-entities?entity=welld_ch')

    expect(await screen.findByText('Loading…')).not.toBeNull()
    expect(screen.queryByTestId('admin-legal-entities-page')).toBeNull()
    expect(screen.queryByTestId('admin-roles-page')).toBeNull()

    manageable.resolve(['welld_ch'])
    expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
    expect(window.location.search).toBe('?entity=welld_ch')
    expect(screen.queryByTestId('admin-roles-page')).toBeNull()
  })

  it('a manager-only person on an unmatched path gets the not-found page, with Legal entities in the nav', async () => {
    await signInWith(ENTITY_MANAGE)
    vi.mocked(getManageable).mockResolvedValue(['welld_it'])
    await renderAppAt('/nonexistent')

    expect(await screen.findByTestId('admin-not-found-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/nonexistent')
    expect(sectionLinks()).toEqual(['Legal entities'])
  })

  it('a person with neither capability gets the permission-denied state, not a redirect loop', async () => {
    await signInWith(ENTITY_MANAGE)
    vi.mocked(getManageable).mockResolvedValue([])
    await renderAppAt('/')

    expect(await screen.findByTestId('permission-denied')).not.toBeNull()
    expect(window.location.pathname).toBe('/')
  })

  it('does not decide anything before the permissions have resolved (an administrator is not sent away by the empty first value)', async () => {
    const session = await import('shell/session')
    vi.mocked(session.usePermissions).mockReturnValue({
      epoch: 0,
      apps: [],
      roles: [],
      departments: [],
      permissions: [],
    })
    vi.mocked(getManageable).mockResolvedValue(['welld_it'])
    await renderAppAt('/roles')

    expect(await screen.findByText('Loading…')).not.toBeNull()
    expect(window.location.pathname).toBe('/roles')
    expect(screen.queryByTestId('admin-roles-page')).toBeNull()
  })

  it('the section nav wraps', async () => {
    await renderAppAt('/roles')
    await screen.findByTestId('admin-roles-page')

    const list = within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('list')
    expect(list.className).toContain('tab-list-wrap')
  })
})

// ---------------------------------------------------------------------------
// /legal-entities search params (plan E7): bad values are replaced by defaults, never echoed
// ---------------------------------------------------------------------------

describe('/legal-entities search', () => {
  beforeEach(() => {
    vi.mocked(getManageable).mockResolvedValue(['welld_it', 'welld_ch'])
  })

  it.each([
    ['?entity=welld_de', '', 'welld_de'],
    ['?view=x', '', null],
    ['?version=abc', '', 'abc'],
    ['?entity=welld_de&view=x&version=abc', '', 'welld_de'],
    ['?view=history&version=0', '?view=history', null],
    ['?view=history&version=-2', '?view=history', null],
    ['?view=history&version=1.5', '?view=history', null],
    ['?view=history&version=007', '?view=history', '007'],
    ['?view=details&version=3', '?view=details', null],
    ['?version=3', '', null],
    ['?entity=%3Cb%3Ex%3C%2Fb%3E&other=1', '', 'other'],
  ])('%s is replaced by the defaults in the address (%j) and is not rendered', async (query, expected, echoed) => {
    const historyLength = window.history.length
    await renderAppAt(`/legal-entities${query}`)

    expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
    await waitFor(() => expect(window.location.search).toBe(expected))
    expect(window.location.pathname).toBe('/legal-entities')
    if (echoed !== null) expect(document.body.textContent).not.toContain(echoed)
    // A replace, not a push: Back does not return to the bad address (the test's own pushState is the one entry).
    expect(window.history.length).toBe(historyLength + 1)
  })

  it('drops every bad value and keeps the good ones', async () => {
    await renderAppAt('/legal-entities?entity=welld_ch&view=bogus&version=abc')

    await screen.findByTestId('admin-legal-entities-page')
    await waitFor(() => expect(window.location.search).toBe('?entity=welld_ch'))
  })

  it('keeps a valid deep link as it is', async () => {
    await renderAppAt('/legal-entities?entity=welld_it&view=history&version=2')

    await screen.findByTestId('admin-legal-entities-page')
    expect(window.location.search).toBe('?entity=welld_it&view=history&version=2')
  })

  it('an unknown entity is not a 404 page', async () => {
    await renderAppAt('/legal-entities?entity=welld_de')

    expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
    expect(screen.queryByTestId('admin-not-found-page')).toBeNull()
  })
})

describe('validateLegalEntitiesSearch', () => {
  it('keeps only members of the closed sets', async () => {
    const { validateLegalEntitiesSearch } = await importRouter()

    expect(validateLegalEntitiesSearch({})).toEqual({})
    expect(validateLegalEntitiesSearch({ entity: 'welld_it', view: 'details' })).toEqual({
      entity: 'welld_it',
      view: 'details',
    })
    expect(validateLegalEntitiesSearch({ entity: 'welld_ch', view: 'history', version: 12 })).toEqual({
      entity: 'welld_ch',
      view: 'history',
      version: 12,
    })
    expect(validateLegalEntitiesSearch({ entity: 'welld_de', view: 'x', version: 'abc' })).toEqual({})
    expect(validateLegalEntitiesSearch({ entity: 7, view: 7, version: '3' })).toEqual({})
    expect(validateLegalEntitiesSearch({ view: 'history', version: Number.MAX_SAFE_INTEGER + 2 })).toEqual({
      view: 'history',
    })
    expect(validateLegalEntitiesSearch({ view: 'history', version: null })).toEqual({ view: 'history' })
  })
})
