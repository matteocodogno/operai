/**
 * @vitest-environment jsdom
 *
 * ProjectsShell (AC-4.4): the tool frame stays on screen while `GET /scope`
 * loads, fails (warning banner; the 503 auth-unavailable variant; 403
 * PermissionDenied) or succeeds (the routed page, with the scope handed down
 * through `useScope`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { useScope } from '../hooks/useScope'
import { fakeApi, problem, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

import ProjectsShell from './ProjectsShell'

function ScopeProbe() {
  const { canManage, canManageEntity, managesAll, bexio, canTake, canTakeEntity, oversees } = useScope()
  return (
    <p>
      {`manage ${canManage} ch ${canManageEntity('welld_ch')} it ${canManageEntity('welld_it')} all ${managesAll} bexio ${bexio} take ${canTake} takeIt ${canTakeEntity('welld_it')} oversees ${oversees}`}
    </p>
  )
}

const renderShell = async (handler: FakeHandler) => {
  apiFetch.mockImplementation(fakeApi({ 'GET /scope': handler }))
  window.history.pushState(null, '', '/')
  const rootRoute = createRootRoute({ component: ProjectsShell })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: ScopeProbe }),
    createRoute({ getParentRoute: () => rootRoute, path: '/queue', component: ScopeProbe }),
  ])
  render(<RouterProvider router={createRouter({ routeTree })} />)
  await screen.findByRole('heading', { level: 1, name: 'Projects' })
}

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProjectsShell', () => {
  it('hands the scope to the page once GET /scope answers', async () => {
    await renderShell(() => ({ status: 200, body: scope({ manage: ['welld_ch'], bexio: false }) }))
    expect(
      await screen.findByText(
        'manage true ch true it false all false bexio false take false takeIt false oversees false',
      ),
    ).not.toBeNull()
  })

  it('a caller who manages nothing can read but gets no manage capability (AC-4.3, AC-4.4)', async () => {
    await renderShell(() => ({ status: 200, body: scope() }))
    expect(
      await screen.findByText(
        'manage false ch false it false all false bexio false take false takeIt false oversees false',
      ),
    ).not.toBeNull()
  })

  it('carries the Bexio capability of accounting (AC-3.1)', async () => {
    await renderShell(() => ({ status: 200, body: scope({ bexio: true }) }))
    expect(
      await screen.findByText(
        'manage false ch false it false all false bexio true take false takeIt false oversees false',
      ),
    ).not.toBeNull()
  })

  it('an admin manages every entity', async () => {
    await renderShell(() => ({ status: 200, body: scope({ manage: ['welld_ch', 'welld_it'], managesAll: true }) }))
    expect(
      await screen.findByText(
        'manage true ch true it true all true bexio false take false takeIt false oversees false',
      ),
    ).not.toBeNull()
  })

  it('shows the loading state under the title while the scope loads', async () => {
    await renderShell(() => new Promise(() => undefined))
    expect(screen.getByRole('status').textContent).toBe('Loading projects…')
    expect(screen.queryByText(/^manage /)).toBeNull()
  })

  it('carries what the caller may take and whether they oversee every PO (specs/022 D37, D47)', async () => {
    await renderShell(() => ({ status: 200, body: scope({ take: ['welld_it'], oversees: true }) }))
    expect(
      await screen.findByText(
        'manage false ch false it false all false bexio false take true takeIt true oversees true',
      ),
    ).not.toBeNull()
  })

  it('offers the projects list to every reader, even one who may take nothing', async () => {
    await renderShell(() => ({ status: 200, body: scope() }))
    const nav = screen.getByRole('navigation', { name: 'Projects sections' })
    expect(within(nav).getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe('/')
  })

  it('offers "To start" only to a caller whose scope.take is non-empty (AC-1.9)', async () => {
    await renderShell(() => ({ status: 200, body: scope({ take: ['welld_ch'] }) }))
    const nav = screen.getByRole('navigation', { name: 'Projects sections' })
    expect(within(nav).getByRole('link', { name: 'To start' }).getAttribute('href')).toBe('/queue')
  })

  it.each<[string, Parameters<typeof scope>[0]]>([
    ['a project manager (manages, takes nothing)', { manage: ['welld_ch'] }],
    ['accounting (Bexio only)', { bexio: true }],
    ['a reader', {}],
  ])('shows no "To start" entry to %s (AC-1.9)', async (_name, overrides) => {
    await renderShell(() => ({ status: 200, body: scope(overrides) }))
    await screen.findByText(/^manage /)
    const nav = screen.getByRole('navigation', { name: 'Projects sections' })
    expect(within(nav).queryByRole('link', { name: 'To start' })).toBeNull()
  })

  it('keeps the Projects tab on screen while the scope loads and when it fails, and no "To start"', async () => {
    await renderShell(() => problem(503, 'authz_unavailable'))
    await screen.findByTestId('projects-load-error')
    const nav = screen.getByRole('navigation', { name: 'Projects sections' })
    expect(within(nav).getByRole('link', { name: 'Projects' })).not.toBeNull()
    expect(within(nav).queryByRole('link', { name: 'To start' })).toBeNull()
  })

  it('a 403 shows PermissionDenied under the title', async () => {
    await renderShell(() => problem(403, 'forbidden'))
    expect(await screen.findByTestId('projects-permission-denied')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).not.toBeNull()
  })

  it('a 503 says the authorization service is unavailable, never an empty scope (AC-4.2)', async () => {
    await renderShell(() => problem(503, 'authz_unavailable'))
    const banner = await screen.findByTestId('projects-load-error')
    expect(banner.textContent).toContain('Authorization service unavailable')
    expect(screen.queryByText(/^manage /)).toBeNull()
  })

  it('another failure shows the retry banner, and Retry loads the scope again', async () => {
    let calls = 0
    await renderShell(() => {
      calls += 1
      return calls === 1 ? problem(500, undefined, {}, 'boom') : { status: 200, body: scope({ manage: ['welld_it'] }) }
    })
    expect((await screen.findByTestId('projects-load-error')).textContent).toContain('boom')
    fireEvent.click(screen.getByTestId('projects-load-error-retry'))
    expect(
      await screen.findByText(
        'manage true ch false it true all false bexio false take false takeIt false oversees false',
      ),
    ).not.toBeNull()
  })
})
