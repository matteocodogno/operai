/**
 * @vitest-environment jsdom
 *
 * Component tests for App.tsx — admin-ui's exposed `./App` (T14,
 * specs/004-auth-roles-permissions/tasks.md).
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
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const { default: App } = await import('./App')

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
})
