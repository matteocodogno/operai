/**
 * @vitest-environment jsdom
 *
 * ProjectsShell (AC-4.4): the tool frame stays on screen while `GET /scope`
 * loads, fails (warning banner; the 503 auth-unavailable variant; 403
 * PermissionDenied) or succeeds (the routed page, with the scope handed down
 * through `useScope`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  const { canManage, canManageEntity, managesAll, bexio } = useScope()
  return (
    <p>
      {`manage ${canManage} ch ${canManageEntity('welld_ch')} it ${canManageEntity('welld_it')} all ${managesAll} bexio ${bexio}`}
    </p>
  )
}

const renderShell = async (handler: FakeHandler) => {
  apiFetch.mockImplementation(fakeApi({ 'GET /scope': handler }))
  window.history.pushState(null, '', '/')
  const rootRoute = createRootRoute({ component: ProjectsShell })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: ScopeProbe }),
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
    expect(await screen.findByText('manage true ch true it false all false bexio false')).not.toBeNull()
  })

  it('a caller who manages nothing can read but gets no manage capability (AC-4.3, AC-4.4)', async () => {
    await renderShell(() => ({ status: 200, body: scope() }))
    expect(await screen.findByText('manage false ch false it false all false bexio false')).not.toBeNull()
  })

  it('carries the Bexio capability of accounting (AC-3.1)', async () => {
    await renderShell(() => ({ status: 200, body: scope({ bexio: true }) }))
    expect(await screen.findByText('manage false ch false it false all false bexio true')).not.toBeNull()
  })

  it('an admin manages every entity', async () => {
    await renderShell(() => ({ status: 200, body: scope({ manage: ['welld_ch', 'welld_it'], managesAll: true }) }))
    expect(await screen.findByText('manage true ch true it true all true bexio false')).not.toBeNull()
  })

  it('shows the loading state under the title while the scope loads', async () => {
    await renderShell(() => new Promise(() => undefined))
    expect(screen.getByRole('status').textContent).toBe('Loading projects…')
    expect(screen.queryByText(/^manage /)).toBeNull()
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
    expect(await screen.findByText('manage true ch false it true all false bexio false')).not.toBeNull()
  })
})
