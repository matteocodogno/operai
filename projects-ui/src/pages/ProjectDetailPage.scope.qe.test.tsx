/**
 * @vitest-environment jsdom
 *
 * QE additions for specs/021-projects (T19, QE-light), reworked for specs/022 (T30). The page tests prove the
 * project-level controls vanish for a caller who manages the other entity (AC-4.4), but the terms controls and
 * the Bexio field were only exercised for a caller who manages NOTHING. These drive the whole project page,
 * through the app's real router against a fake projects-api, for each way a caller can be a reader of a project
 * they may not change — for a project made from a deal (Purchase order card) and for a hand-made one (Terms card):
 *
 *   - manages only the OTHER entity (either direction)      -> reads everything, no control anywhere
 *   - accounting: Bexio capability, manages nothing (AC-4.5) -> the Bexio field, and no other control
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from '../router'
import { fakeApi, projectDetail, purchaseOrderOf, scope, termsOf } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { Entity, Project, Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const SAAS_TERMS = termsOf('saas', { sla: null, hourPackage: null })

/** An open SaaS project of `entity` made from a deal, with open-ended terms: every control the page can offer is on screen for a manager. */
const fromDeal = (entity: Entity): Project =>
  projectDetail({
    type: 'saas',
    state: 'active',
    entity,
    purchaseOrder: purchaseOrderOf({ bexioOrderId: 'AB-100' }),
    terms: SAAS_TERMS,
    startDate: '2026-02-01',
    endDate: null,
  })

/** The same, hand-made: no purchase order, and its terms. */
const handMade = (entity: Entity): Project =>
  projectDetail({
    type: 'saas',
    state: 'active',
    entity,
    terms: SAAS_TERMS,
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
  await screen.findByTestId('terms-details')
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

const MANAGE_CONTROLS = ['Edit', 'Set end date', 'Edit team', 'Edit details']

describe('a manager sees the controls this page can offer (the check below is not vacuous)', () => {
  it.each([
    ['a project made from a deal', fromDeal],
    ['a hand-made project', handMade],
  ])('manages the entity of %s: Edit, Set end date, Edit team and Edit details are all there', async (_name, make) => {
    await render_(make('welld_ch'), scope({ manage: ['welld_ch'] }))
    for (const name of MANAGE_CONTROLS) expect(screen.queryByRole('button', { name }), name).not.toBeNull()
  })
})

describe('a project of an entity the caller does not manage is read-only all the way down (AC-4.4)', () => {
  it.each<[string, Entity, Scope]>([
    ['a welld_it manager on a welld_ch project', 'welld_ch', scope({ manage: ['welld_it'] })],
    ['a welld_ch manager on a welld_it project', 'welld_it', scope({ manage: ['welld_ch'] })],
  ])('%s: reads the project and its purchase order, and gets no control', async (_name, entity, callerScope) => {
    await render_(fromDeal(entity), callerScope)
    for (const name of [...MANAGE_CONTROLS, 'Add terms'])
      expect(screen.queryByRole('button', { name }), name).toBeNull()
    expect(screen.getByText('You can read this project but not change it.')).not.toBeNull()
    // It still reads the terms and the purchase order, including its Bexio order id as plain text.
    expect(within(screen.getByTestId('project-purchase-order')).getAllByText('AB-100').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Bexio order')).toBeNull()
  })

  it.each<[string, Entity, Scope]>([
    ['a welld_it manager on a welld_ch project', 'welld_ch', scope({ manage: ['welld_it'] })],
    ['a welld_ch manager on a welld_it project', 'welld_it', scope({ manage: ['welld_ch'] })],
  ])('%s, hand-made: reads its terms, and gets no control', async (_name, entity, callerScope) => {
    await render_(handMade(entity), callerScope)
    for (const name of [...MANAGE_CONTROLS, 'Add terms'])
      expect(screen.queryByRole('button', { name }), name).toBeNull()
    expect(within(screen.getByTestId('project-terms')).queryByRole('button')).toBeNull()
  })
})

describe('accounting: the Bexio capability and nothing else (AC-3.1, AC-4.5)', () => {
  it('gets the Bexio field on the purchase order of either entity, and none of the manage controls', async () => {
    for (const entity of ['welld_ch', 'welld_it'] as const) {
      await render_(fromDeal(entity), scope({ bexio: true }))
      expect((screen.getByLabelText('Bexio order') as HTMLInputElement).value).toBe('AB-100')
      for (const name of MANAGE_CONTROLS) expect(screen.queryByRole('button', { name }), name).toBeNull()
      cleanup()
    }
  })

  it('has no Bexio field on a hand-made project: there is no purchase order to carry one (AC-5.2)', async () => {
    await render_(handMade('welld_ch'), scope({ bexio: true }))
    expect(screen.queryByLabelText('Bexio order')).toBeNull()
  })
})
