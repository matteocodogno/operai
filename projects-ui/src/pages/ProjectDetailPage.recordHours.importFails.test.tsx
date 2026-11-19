/**
 * @vitest-environment jsdom
 *
 * ProjectDetailPage when `import('shell/extensions')` is rejected (specs/20261116-record-hours-in-place AC-4.5):
 * the page still renders — its wrapper's own boundary, not the shell's, holds — and shows the link to My hours in
 * the place of Record hours for someone who would have had it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from '../router'
import { ADA, fakeApi, projectDetail, scope } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))
vi.mock('shell/extensions', () => {
  throw new Error('the shell’s remote entry could not be loaded')
})

beforeEach(() => {
  window.scrollTo = () => undefined
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the project page with a rejected shell/extensions import (AC-4.5)', () => {
  it('still renders, with the link to My hours where Record hours would be', async () => {
    const project = projectDetail({ name: 'Intranet', projectManager: ADA })
    apiFetch.mockImplementation(
      fakeApi({
        [`GET /projects/${project.id}`]: () => ({ status: 200, body: project }),
        'GET /tasks': () => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 25 } }),
        'GET /authz/users/directory': () => ({ status: 200, body: { users: [] } }),
      }),
    )
    window.history.pushState(null, '', `/${project.id}`)
    render(<RouterProvider router={createAppRouter(undefined, scopeRoot(scope({ manage: ['welld_ch'] })))} />)
    await screen.findByTestId('project-detail-page')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(screen.getByRole('heading', { name: 'Intranet' })).not.toBeNull()
    expect(screen.getByTestId('project-actions')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Record hours in My hours' }).getAttribute('href')).toBe('/hours')
  })
})
