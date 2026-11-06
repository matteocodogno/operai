/**
 * @vitest-environment jsdom
 *
 * The inner router (T11): every page route exists, resolved under the shell's
 * `/projects` basepath, plus the not-found fallback. A bare root stands in for
 * ProjectsShell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from './router'
import { fakeApi, projectDetail } from './test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const renderAt = async (path: string, basepath = '/projects') => {
  apiFetch.mockImplementation(
    fakeApi({ 'GET /projects/ck9x2': () => ({ status: 200, body: projectDetail({ id: 'ck9x2' }) }) }),
  )
  window.history.pushState(null, '', path)
  render(<RouterProvider router={createAppRouter(basepath)} />)
}

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => cleanup())

describe('createAppRouter', () => {
  it('serves the projects list at the tool root', async () => {
    await renderAt('/projects')
    expect(await screen.findByTestId('projects-page')).not.toBeNull()
  })

  it('serves a project at /projects/<id>, with the id from the path', async () => {
    await renderAt('/projects/ck9x2')
    const page = await screen.findByTestId('project-detail-page')
    expect(page.getAttribute('data-project-id')).toBe('ck9x2')
  })

  it('answers an unknown path with the not-found panel and a way back to the list', async () => {
    await renderAt('/projects/ck9x2/nope')
    expect(await screen.findByTestId('projects-not-found')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to projects' }).getAttribute('href')).toBe('/projects/')
  })
})
