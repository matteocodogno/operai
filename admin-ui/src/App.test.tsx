/**
 * @vitest-environment jsdom
 *
 * Component tests for App.tsx — admin-ui's exposed `./App` (T14,
 * specs/20260713-auth-roles-permissions/tasks.md).
 *
 * T13's placeholder tests (heading + coming-soon copy + shared-session
 * demonstration) are superseded: T14 replaces that static placeholder with
 * admin-ui's own inner TanStack Router (src/router.tsx), rebased to
 * basepath `/admin` (src/App.tsx's `createAppRouter('/admin')`). This file
 * proves the EXACT exposed component — with its hardcoded `/admin`
 * basepath, not the bare `createAppRouter()` factory — mounts and resolves
 * under that prefix; src/router.test.tsx separately covers the router's
 * structure and per-section navigation in more depth using the basepath-less
 * factory (mirrors estimai-ui/src/router.test.tsx's split between router
 * structure and the exposed remote's own basepath wiring).
 *
 * `shell/tokens.css` is a side-effect-only import — vitest.config.ts's
 * `resolve.alias` points the bare specifier at a real (empty) local stub so
 * Vite's import-analysis is satisfied; nothing to assert on for it here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

// The module is only ever mounted for a person the shell let in (`apps` carries "admin"); what they hold
// decides the sections (T35, specs/20261117-legal-entities). Overridden per test.
vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})
vi.mock('./lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lib/legalEntitiesApi')>()
  return { ...original, getManageable: vi.fn() }
})

const { default: App } = await import('./App')
const { usePermissions } = await import('shell/session')
const { getManageable } = await import('./lib/legalEntitiesApi')

const signInWith = (...permissions: { resource: string; action: string }[]) =>
  vi.mocked(usePermissions).mockReturnValue({ epoch: 1, apps: ['admin'], roles: [], departments: [], permissions })

beforeEach(() => {
  signInWith({ resource: 'admin', action: 'access' })
  vi.mocked(getManageable).mockReset()
  vi.mocked(getManageable).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('App (admin-ui, mounted under /admin)', () => {
  it('landing on /admin redirects to /admin/roles and renders the section nav + Roles content', async () => {
    window.history.pushState(null, '', '/admin')

    render(<App />)

    expect(await screen.findByTestId('admin-roles-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/admin/roles')

    const nav = screen.getByRole('navigation', { name: 'Admin sections' })
    expect(nav).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Roles' }).getAttribute('aria-current')).toBe('page')
  })

  it('section links carry the /admin basepath in their href', async () => {
    window.history.pushState(null, '', '/admin')

    render(<App />)
    await screen.findByTestId('admin-roles-page')

    expect(screen.getByRole('link', { name: 'Departments' }).getAttribute('href')).toBe('/admin/departments')
    expect(screen.getByRole('link', { name: 'Users' }).getAttribute('href')).toBe('/admin/users')
    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('href')).toBe('/admin/audit')
  })

  it('deep-linking to a section (e.g. /admin/audit) renders that section directly, not the redirect target', async () => {
    window.history.pushState(null, '', '/admin/audit')

    render(<App />)

    expect(await screen.findByTestId('admin-audit-page')).not.toBeNull()
    expect(screen.queryByTestId('admin-roles-page')).toBeNull()
  })

  it('a manager-only person landing on /admin ends on /admin/legal-entities, its link carrying the basepath', async () => {
    signInWith({ resource: 'legal-entity', action: 'manage' })
    vi.mocked(getManageable).mockResolvedValue(['welld_ch'])
    window.history.pushState(null, '', '/admin')

    render(<App />)

    expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/admin/legal-entities')
    expect(screen.getByRole('link', { name: 'Legal entities' }).getAttribute('href')).toBe('/admin/legal-entities')
    expect(screen.queryByRole('link', { name: 'Roles' })).toBeNull()
  })

  it('a bad search on /admin/legal-entities is replaced by the defaults under the basepath, and never rendered', async () => {
    vi.mocked(getManageable).mockResolvedValue(['welld_it', 'welld_ch'])
    window.history.pushState(null, '', '/admin/legal-entities?entity=welld_de&view=x&version=abc')

    render(<App />)

    expect(await screen.findByTestId('admin-legal-entities-page')).not.toBeNull()
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(window.location.pathname).toBe('/admin/legal-entities')
    expect(document.body.textContent).not.toContain('welld_de')
  })
})
