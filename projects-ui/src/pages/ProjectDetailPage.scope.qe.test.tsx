/**
 * @vitest-environment jsdom
 *
 * QE additions for specs/024-projects (T19, QE-light). The page tests prove the project-level
 * controls vanish for a caller who manages the other entity (AC-4.4), but the contract cards,
 * "Add contract" and the Bexio field were only exercised for a caller who manages NOTHING. These
 * drive the whole project page, through the app's real router against a fake projects-api, for
 * each way a caller can be a reader of a project they may not change:
 *
 *   - manages only the OTHER entity (either direction)      -> reads everything, no control anywhere
 *   - accounting: Bexio capability, manages nothing (AC-4.5) -> the Bexio field, and no other control
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from '../router'
import { fakeApi, projectDetail, scope } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { Contract, Entity, Project, Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const CONTRACT = {
  id: 'k1',
  type: 'saas' as const,
  company: { id: 'c1', name: 'Acme SA' },
  origin: 'manual' as const,
  bexioOrderId: 'AB-100',
  startDate: '2026-02-01',
  endDate: null,
}

const fullContract: Contract = {
  ...CONTRACT,
  projectId: 'p1',
  dealId: null,
  terms: { sla: null, hourPackage: null },
  version: 4,
}

/** An open SaaS project of `entity` with one open-ended contract: every control the page can offer is on screen for a manager. */
const projectOf = (entity: Entity): Project =>
  projectDetail({
    type: 'saas',
    company: null,
    state: 'active',
    entity,
    contracts: [fullContract],
    startDate: '2026-02-01',
    endDate: null,
  })

const render_ = async (project: Project, callerScope: Scope) => {
  apiFetch.mockImplementation(
    fakeApi({
      [`GET /projects/${project.id}`]: () => ({ status: 200, body: project }),
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [] } }),
    }),
  )
  window.history.pushState(null, '', `/${project.id}`)
  render(<RouterProvider router={createAppRouter(undefined, scopeRoot(callerScope))} />)
  await screen.findByTestId('project-detail-page')
  // The contract card renders the terms the project carries: wait for it, so "no Edit button" is not a not-yet-rendered one.
  await screen.findByTestId('contract-terms')
}

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

const MANAGE_CONTROLS = ['Add contract', 'Edit', 'End contract', 'Edit team', 'Edit details', 'Make SaaS']

describe('a manager sees the controls this page can offer (the check below is not vacuous)', () => {
  it('manages the project’s entity: Add contract, Edit, End contract, Edit team and Edit details are all there', async () => {
    await render_(projectOf('welld_ch'), scope({ manage: ['welld_ch'] }))
    for (const name of MANAGE_CONTROLS.filter((control) => control !== 'Make SaaS')) {
      expect(screen.queryByRole('button', { name }), name).not.toBeNull()
    }
  })
})

describe('a project of an entity the caller does not manage is read-only all the way down (AC-4.4)', () => {
  it.each<[string, Entity, Scope]>([
    ['a welld_it manager on a welld_ch project', 'welld_ch', scope({ manage: ['welld_it'] })],
    ['a welld_ch manager on a welld_it project', 'welld_it', scope({ manage: ['welld_ch'] })],
  ])('%s: reads the project and its contract, and gets no control', async (_name, entity, callerScope) => {
    await render_(projectOf(entity), callerScope)
    for (const name of MANAGE_CONTROLS) expect(screen.queryByRole('button', { name }), name).toBeNull()
    expect(screen.getByText('You can read this project but not change it.')).not.toBeNull()
    // It still reads the contract, including its Bexio order id as plain text.
    expect(within(screen.getByTestId('project-contracts')).getAllByText('AB-100').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Bexio order')).toBeNull()
  })
})

describe('accounting: the Bexio capability and nothing else (AC-3.1, AC-4.5)', () => {
  it('gets the Bexio field on a contract of either entity, and none of the manage controls', async () => {
    for (const entity of ['welld_ch', 'welld_it'] as const) {
      await render_(projectOf(entity), scope({ bexio: true }))
      expect((screen.getByLabelText('Bexio order') as HTMLInputElement).value).toBe('AB-100')
      for (const name of MANAGE_CONTROLS) expect(screen.queryByRole('button', { name }), name).toBeNull()
      cleanup()
    }
  })
})
