/**
 * @vitest-environment jsdom
 *
 * QueuePage — taking a deal (AC-1.2, AC-1.6, AC-1.9, AC-1.10): "New project" shows only on the deals of
 * an entity the caller may take AND manage (sales, admins), opens the dialog for that deal, lands the
 * user on the project on success, and reloads the queue behind a dialog whose deal was taken
 * meanwhile. There is no "Attach to project" (D39). The dialog's own fields and refusals are covered
 * by TakeDealDialog.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from '../router'
import { fakeApi, problem, projectDetail, purchaseOrderOf, scope, termsOf } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { QueueItem, Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const CH: QueueItem = {
  dealId: 'd1',
  title: 'Website relaunch',
  entity: 'welld_ch',
  company: { id: 'c1', name: 'Acme SA' },
  wonAt: '2026-10-20T12:00:00.000Z',
  estimate: { id: 'est-1', name: 'Relaunch estimate' },
}
const IT: QueueItem = { ...CH, dealId: 'd2', title: 'Portale clienti', entity: 'welld_it', estimate: null }

const queue = (items: QueueItem[]) => ({ status: 200, body: { items, truncated: false } })

const renderQueue = async (routes: Record<string, FakeHandler>, callerScope: Scope) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /queue/d1/ops-managers': () => ({
        status: 200,
        body: { items: [{ id: 'u-ops', name: 'Olga Ops', admin: false }], prefillId: 'u-ops' },
      }),
      // Synthetic contacts only (T18 L2).
      'GET /queue/d1/contacts': () => ({
        status: 200,
        body: { items: [{ id: 'k1', name: 'Jane Roe', jobTitle: 'CTO' }] },
      }),
      ...routes,
    }),
  )
  window.history.pushState(null, '', '/queue')
  render(<RouterProvider router={createAppRouter(undefined, scopeRoot(callerScope))} />)
  await screen.findByTestId('queue-table')
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

const queueReads = () => apiFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/queue').length
const rowOf = (title: string) =>
  within(screen.getByTestId('queue-table')).getByRole('rowheader', { name: title }).closest('tr')!

/** The ops-manager candidates arrive after the dialog opens: wait for the prefill, so a submit is not a not-yet-loaded one. */
const ready = (dialog: HTMLElement) =>
  waitFor(() => expect((within(dialog).getByLabelText(/^Ops manager/) as HTMLSelectElement).value).toBe('u-ops'))

const fillFixedPrice = (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'fixed_price' } })
  fireEvent.change(within(dialog).getByLabelText(/^Start date/), { target: { value: '2026-11-01' } })
  fireEvent.change(within(dialog).getByLabelText(/^Deadline/), { target: { value: '2026-12-01' } })
  fireEvent.change(within(dialog).getByLabelText(/^Max effort/), { target: { value: '40' } })
}

const SALES_CH = scope({ manage: ['welld_ch'], take: ['welld_ch'] })

describe('who sees the action (AC-1.2, S3)', () => {
  it('no action for a taker who manages no entity', async () => {
    await renderQueue({ 'GET /queue': () => queue([CH, IT]) }, scope({ take: ['welld_ch', 'welld_it'] }))
    expect(screen.queryByRole('button', { name: /New project/ })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull()
  })

  it('"New project" on the deals of an entity the caller takes and manages, and none on the others', async () => {
    await renderQueue({ 'GET /queue': () => queue([CH, IT]) }, SALES_CH)
    expect(
      within(rowOf('Website relaunch')).getByRole('button', { name: 'New project: Website relaunch' }),
    ).not.toBeNull()
    expect(within(rowOf('Portale clienti')).queryByRole('button')).toBeNull()
  })

  it('no action on a deal of an entity the caller takes but does not manage (the server needs both)', async () => {
    await renderQueue(
      { 'GET /queue': () => queue([CH]) },
      scope({ manage: ['welld_it'], take: ['welld_ch', 'welld_it'] }),
    )
    expect(within(rowOf('Website relaunch')).queryByRole('button')).toBeNull()
  })

  it('on every deal for an admin', async () => {
    await renderQueue(
      { 'GET /queue': () => queue([CH, IT]) },
      scope({ manage: ['welld_ch', 'welld_it'], managesAll: true, take: ['welld_ch', 'welld_it'], oversees: true }),
    )
    expect(screen.getAllByRole('button', { name: /^New project: / })).toHaveLength(2)
  })

  it('there is no way to attach a deal to an existing project (AC-1.10, D39)', async () => {
    await renderQueue({ 'GET /queue': () => queue([CH, IT]) }, SALES_CH)
    expect(screen.queryByRole('button', { name: /attach|collega/i })).toBeNull()
  })
})

describe('the dialogs', () => {
  it('"New project" opens the dialog for that deal, prefilled with its title', async () => {
    await renderQueue({ 'GET /queue': () => queue([CH, IT]) }, SALES_CH)
    fireEvent.click(screen.getByRole('button', { name: 'New project: Website relaunch' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project from a deal' })
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Website relaunch')
  })

  it('Cancel closes the dialog and leaves the queue as it was', async () => {
    await renderQueue({ 'GET /queue': () => queue([CH]) }, SALES_CH)
    fireEvent.click(screen.getByRole('button', { name: 'New project: Website relaunch' }))
    fireEvent.click(await screen.findByTestId('take-deal-cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(queueReads()).toBe(1)
  })
})

describe('after the take', () => {
  const awaitingProject = projectDetail({
    id: 'pNew',
    type: 'fixed_price',
    state: 'planned',
    projectManager: null,
    awaitingProjectManager: true,
    purchaseOrder: purchaseOrderOf(),
    terms: termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 }),
    startDate: '2026-11-01',
  })

  it('a new project lands the user on the project page, awaiting its project manager (AC-1.2, AC-1.3)', async () => {
    await renderQueue(
      {
        'GET /queue': () => queue([CH]),
        'POST /queue/d1/project': () => ({ status: 201, body: awaitingProject }),
        'GET /projects/pNew': () => ({ status: 200, body: awaitingProject }),
      },
      SALES_CH,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New project: Website relaunch' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project from a deal' })
    await ready(dialog)
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    const projectPage = await screen.findByTestId('project-detail-page')
    expect(projectPage.getAttribute('data-project-id')).toBe('pNew')
    expect(screen.queryByTestId('queue-page')).toBeNull()
    expect(screen.getByTestId('project-facts').textContent).toContain('Awaiting project manager')
    expect(screen.getByTestId('project-purchase-order')).not.toBeNull()
  })

  it('takes the deal with the chosen ops manager and referent, and nothing else of the contact (AC-3.6, AC-4.1)', async () => {
    await renderQueue(
      {
        'GET /queue': () => queue([CH]),
        'POST /queue/d1/project': () => ({ status: 201, body: awaitingProject }),
        'GET /projects/pNew': () => ({ status: 200, body: awaitingProject }),
      },
      SALES_CH,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New project: Website relaunch' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project from a deal' })
    await ready(dialog)
    const referent = within(dialog).getByLabelText(/^Referent/) as HTMLSelectElement
    await waitFor(() => expect(referent.options.length).toBe(2))
    fillFixedPrice(dialog)
    fireEvent.change(referent, { target: { value: 'k1' } })
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await screen.findByTestId('project-detail-page')
    const call = apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      name: 'Website relaunch',
      type: 'fixed_price',
      terms: { startDate: '2026-11-01', terms: { deadline: '2026-12-01', maxEffortManDays: 40 } },
      opsManagerId: 'u-ops',
      referentContactId: 'k1',
    })
  })

  it('a deal taken meanwhile leaves the list behind the dialog, which keeps saying why (AC-1.6)', async () => {
    let taken = false
    await renderQueue(
      {
        'GET /queue': () => queue(taken ? [] : [CH]),
        'POST /queue/d1/project': () => {
          taken = true
          return problem(409, 'deal_taken')
        },
      },
      SALES_CH,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New project: Website relaunch' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project from a deal' })
    await ready(dialog)
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect((await within(dialog).findByTestId('take-deal-error')).textContent).toContain(
      'A project has just taken this deal.',
    )
    await waitFor(() => expect(queueReads()).toBe(2))
    fireEvent.click(within(dialog).getByTestId('take-deal-cancel'))
    expect(await screen.findByText('Nothing waiting to start')).not.toBeNull()
  })
})
