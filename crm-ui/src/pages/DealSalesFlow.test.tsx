/**
 * @vitest-environment jsdom
 *
 * The deal page of specs/20261101-crm-sales-flow (CRM sales flow), through the real router and the
 * real request code: money hidden without deal:financials (US-1), the estimate
 * card (request, hand-over, visibility of each action; US-3), the offer dialog
 * and the proposal question (US-4, AC-4.5), the attachment upload (AC-4.3) and
 * the Settings screen (letterhead).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { ADA, fakeApi, nulRefusalAnswer, page } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const TESS = { id: 'u-tess', name: 'Tess Technical', status: 'active' as const }

const ESTIMATE = {
  estimateId: 'est-1',
  name: 'Acme SA — Platform rebuild',
  technical: TESS,
  state: 'requested',
  requestedBy: ADA,
  requestedAt: '2026-10-30T10:00:00.000Z',
  readyAt: null,
}

const dealFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  title: 'Platform rebuild',
  company: { id: 'c1', name: 'Acme SA' },
  stage: 'lead',
  amountCents: 10_000_000,
  currency: 'CHF',
  entity: 'welld_ch',
  expectedCloseDate: null,
  owner: ADA,
  closedAt: null,
  updatedAt: '2026-10-30T10:00:00.000Z',
  lostReason: null,
  notes: 'Budget around 100k',
  version: 4,
  createdAt: '2026-10-01T10:00:00.000Z',
  estimateState: null,
  estimateOverridden: false,
  estimate: null,
  estimateOverride: null,
  ...overrides,
})

type Scope = { deal: string[]; financials: boolean; managesAll: boolean }
const MANAGER: Scope = { deal: ['welld_ch'], financials: true, managesAll: false }

const PIPELINE = {
  probabilities: { lead: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 },
  year: 2026,
  stages: [],
}

const renderDeal = async (deal: Record<string, unknown>, scope: Scope, extra: Record<string, FakeHandler> = {}) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({ status: 200, body: { ...scope, canErase: false } }),
      'GET /deals/d1': () => ({ status: 200, body: deal }),
      'GET /pipeline': () => ({ status: 200, body: PIPELINE }),
      'GET /activities': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [] } }),
      ...extra,
    }),
  )
  window.history.pushState(null, '', '/deals/d1')
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  await screen.findByRole('heading', { level: 2, name: 'Platform rebuild' })
}

const companySummaryFixture = {
  id: 'c1',
  name: 'Acme SA',
  status: 'customer',
  statusLapsed: false,
  entity: 'welld_ch',
  industry: null,
  city: null,
  country: null,
  owner: ADA,
  archived: false,
  contactCount: 0,
  openDealCount: 0,
  updatedAt: '2026-10-30T10:00:00.000Z',
  website: null,
  legalName: null,
  street: null,
  postalCode: null,
  notes: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const body = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Record<string, unknown>

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('money visibility (US-1)', () => {
  it('a caller with deal:financials sees the amount, the weighted value, the notes and the Offers card', async () => {
    await renderDeal(dealFixture(), MANAGER)
    const facts = screen.getByTestId('crm-deal-facts').textContent
    expect(facts).toContain('CHF 100,000.00')
    expect(facts).toContain('Weighted (10%)')
    expect(screen.getByText('Budget around 100k')).not.toBeNull()
    expect(await screen.findByTestId('crm-offers-card')).not.toBeNull()
  })

  it('without deal:financials the page shows no amount, weighted value, notes or offers, and asks for none', async () => {
    // Even if a server wrongly sent the figures, the page would not draw them.
    await renderDeal(dealFixture(), { deal: [], financials: false, managesAll: false })
    const page = screen.getByTestId('crm-deal-page')
    expect(page.textContent).not.toMatch(/CHF|EUR/)
    expect(page.textContent).not.toContain('Weighted')
    expect(page.textContent).not.toContain('Amount')
    expect(page.textContent).not.toContain('Budget around 100k')
    expect(screen.queryByTestId('crm-offers-card')).toBeNull()
    const offerCalls = apiFetch.mock.calls.filter(([url]) => String(url).includes('/offers'))
    expect(offerCalls).toEqual([])
    // Attachments stay open to every crm:access holder.
    expect(screen.getByTestId('crm-attachments-card')).not.toBeNull()
  })
})

describe('Estimate card (US-3)', () => {
  it('requests an estimate: the technician comes from the estimai directory, and the deal is replaced by the answer', async () => {
    let directoryQuery = ''
    let posted: Record<string, unknown> | null = null
    await renderDeal(dealFixture(), MANAGER, {
      'GET /authz/users/directory': (url) => {
        directoryQuery = url.search
        return {
          status: 200,
          body: { users: [{ id: 'u-tess', name: 'Tess Technical', email: 'tess@welld.ch', entity: 'welld_ch' }] },
        }
      },
      'POST /deals/d1/estimate': (_url, init) => {
        posted = body(init)
        return { status: 201, body: dealFixture({ estimate: ESTIMATE, estimateState: 'requested', version: 5 }) }
      },
    })
    expect(screen.getByTestId('crm-estimate-none')).not.toBeNull()
    fireEvent.click(screen.getByTestId('crm-estimate-request'))
    const dialog = await screen.findByRole('dialog', { name: 'Request a technical estimate' })
    const input = within(dialog).getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.click(await within(dialog).findByRole('option', { name: /Tess Technical/ }))
    fireEvent.click(within(dialog).getByTestId('crm-estimate-request-submit'))
    await waitFor(() => expect(posted).toEqual({ technicalUserId: 'u-tess' }))
    expect(directoryQuery).toBe('?appId=estimai')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const facts = screen.getByTestId('crm-estimate-facts')
    expect(facts.textContent).toContain('Tess Technical')
    expect(facts.textContent).toContain('Requested')
    expect(screen.getByTestId('crm-estimate-open').getAttribute('href')).toBe('/estimai/estimates/est-1')
    expect(screen.queryByTestId('crm-estimate-request')).toBeNull()
    // The request created a task: the timeline reads the activities again.
    const activityReads = () => apiFetch.mock.calls.filter(([url]) => String(url).includes('/activities')).length
    await waitFor(() => expect(activityReads()).toBe(2))
  })

  it('needs a chosen technician before it asks the server', async () => {
    await renderDeal(dealFixture(), MANAGER, {
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [] } }),
    })
    fireEvent.click(screen.getByTestId('crm-estimate-request'))
    const dialog = await screen.findByRole('dialog', { name: 'Request a technical estimate' })
    fireEvent.click(within(dialog).getByTestId('crm-estimate-request-submit'))
    expect(await within(dialog).findByText('Choose a person from the list.')).not.toBeNull()
    expect(apiFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  const requestWith = async (answer: { status: number; body: unknown }) => {
    await renderDeal(dealFixture(), MANAGER, {
      'GET /authz/users/directory': () => ({
        status: 200,
        body: { users: [{ id: 'u-tess', name: 'Tess Technical', email: 'tess@welld.ch', entity: 'welld_ch' }] },
      }),
      'POST /deals/d1/estimate': () => answer,
    })
    fireEvent.click(screen.getByTestId('crm-estimate-request'))
    const dialog = await screen.findByRole('dialog', { name: 'Request a technical estimate' })
    fireEvent.focus(within(dialog).getByRole('combobox'))
    fireEvent.click(await within(dialog).findByRole('option', { name: /Tess Technical/ }))
    fireEvent.click(within(dialog).getByTestId('crm-estimate-request-submit'))
    return dialog
  }

  it('maps technician_not_estimai_user to the technician field and keeps the dialog open', async () => {
    const dialog = await requestWith({
      status: 422,
      body: { status: 422, title: 'Unprocessable', code: 'technician_not_estimai_user', field: 'technicalUserId' },
    })
    expect(await within(dialog).findByText(/cannot use EstimAI/)).not.toBeNull()
    expect(within(dialog).getByRole('combobox').getAttribute('aria-invalid')).toBe('true')
  })

  it('maps owner_not_crm_user to the technician field', async () => {
    const dialog = await requestWith({
      status: 422,
      body: { status: 422, title: 'Unprocessable', code: 'owner_not_crm_user', field: 'technicalUserId' },
    })
    expect(await within(dialog).findByText(/does not have access to the CRM/)).not.toBeNull()
  })

  it('shows estimai_access_required as the dialog error', async () => {
    const dialog = await requestWith({
      status: 403,
      body: { status: 403, title: 'Forbidden', code: 'estimai_access_required', detail: 'x' },
    })
    expect((await within(dialog).findByTestId('crm-estimate-request-error')).textContent).toContain(
      'You need access to EstimAI',
    )
  })

  it('shows estimai_unavailable as the dialog error', async () => {
    const dialog = await requestWith({
      status: 503,
      body: { status: 503, title: 'Unavailable', code: 'estimai_unavailable', detail: 'x' },
    })
    expect((await within(dialog).findByTestId('crm-estimate-request-error')).textContent).toContain('not reachable')
  })

  describe('Unlink, Override: who sees what', () => {
    const requested = (technical: typeof TESS | typeof ADA) =>
      dealFixture({ estimate: { ...ESTIMATE, technical }, estimateState: 'requested' })
    const ready = (technical: typeof TESS | typeof ADA, requestedBy = ADA) =>
      dealFixture({
        estimate: { ...ESTIMATE, technical, requestedBy, state: 'ready', readyAt: '2026-10-31T10:00:00.000Z' },
        estimateState: 'ready',
      })

    it('nobody marks it ready or reopens it in the CRM: that happens in EstimAI (AC-3.3)', async () => {
      await renderDeal(requested(ADA), { deal: ['welld_ch', 'welld_it'], financials: true, managesAll: true })
      expect(screen.queryByTestId('crm-estimate-ready')).toBeNull()
      expect(screen.getByTestId('crm-estimate-card').textContent).toContain('when they close it in EstimAI')
      cleanup()
      await renderDeal(ready(TESS, ADA), MANAGER)
      expect(screen.queryByTestId('crm-estimate-reopen')).toBeNull()
      expect(screen.getByTestId('crm-estimate-card').textContent).toContain('reopen it in EstimAI')
    })

    it('Unlink asks for confirmation and needs deal:manage in scope', async () => {
      let unlinked = false
      await renderDeal(requested(TESS), MANAGER, {
        'DELETE /deals/d1/estimate': () => {
          unlinked = true
          return { status: 200, body: dealFixture() }
        },
      })
      fireEvent.click(screen.getByTestId('crm-estimate-unlink'))
      const dialog = await screen.findByRole('alertdialog', { name: 'Unlink the estimate?' })
      expect(unlinked).toBe(false)
      fireEvent.click(within(dialog).getByTestId('crm-estimate-unlink-dialog-confirm'))
      await waitFor(() => expect(screen.getByTestId('crm-estimate-none')).not.toBeNull())
      expect(unlinked).toBe(true)
    })

    it('without deal:manage over the deal there is no Unlink and no Request', async () => {
      await renderDeal(requested(TESS), { deal: ['welld_it'], financials: true, managesAll: false })
      expect(screen.queryByTestId('crm-estimate-unlink')).toBeNull()
      expect(screen.queryByTestId('crm-estimate-request')).toBeNull()
    })

    it('Proceed without estimate is for whoever manages the deal, explained by a tooltip, needs a reason, and shows who did it', async () => {
      // A salesperson of the deal's entity sees it; one of another entity does not (amended 2026-11-13).
      await renderDeal(dealFixture(), MANAGER)
      expect(screen.getByTestId('crm-estimate-override-open')).not.toBeNull()
      cleanup()
      await renderDeal(dealFixture(), { deal: ['welld_it'], financials: true, managesAll: false })
      expect(screen.queryByTestId('crm-estimate-override-open')).toBeNull()
      cleanup()

      let posted: Record<string, unknown> | null = null
      await renderDeal(
        dealFixture(),
        { deal: ['welld_ch', 'welld_it'], financials: true, managesAll: true },
        {
          'POST /deals/d1/estimate/override': (_url, init) => {
            posted = body(init)
            return {
              status: 200,
              body: dealFixture({
                estimateOverridden: true,
                estimateOverride: { by: ADA, reason: 'Framework contract', at: '2026-11-01T09:00:00.000Z' },
              }),
            }
          },
        },
      )
      const overrideButton = screen.getByTestId('crm-estimate-override-open')
      expect(overrideButton.textContent).toBe('Proceed without estimate')
      const tooltip = document.getElementById(overrideButton.getAttribute('aria-describedby') ?? '')
      expect(tooltip?.getAttribute('role')).toBe('tooltip')
      expect(tooltip?.textContent).toContain('without a ready estimate')
      fireEvent.click(overrideButton)
      const dialog = await screen.findByRole('dialog', { name: 'Proceed without a ready estimate' })
      fireEvent.click(within(dialog).getByTestId('crm-estimate-override-dialog-submit'))
      expect(await within(dialog).findByText('This field is required.')).not.toBeNull()
      expect(posted).toBeNull()
      fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Framework contract' } })
      fireEvent.click(within(dialog).getByTestId('crm-estimate-override-dialog-submit'))
      await waitFor(() => expect(posted).toEqual({ reason: 'Framework contract' }))
      const shown = await screen.findByTestId('crm-estimate-override')
      expect(shown.textContent).toContain('Framework contract')
      expect(shown.textContent).toContain('Ada Lovelace')
    })
  })
})

describe('gate message in the stage dialog (AC-3.4)', () => {
  it('shows the server’s explanation in the dialog, not the reload banner', async () => {
    await renderDeal(dealFixture({ stage: 'qualified' }), MANAGER, {
      'POST /deals/d1/stage': () => ({
        status: 409,
        body: {
          status: 409,
          title: 'Conflict',
          code: 'estimate_not_ready',
          detail: 'The technical estimate is not ready yet; the technical contact marks it ready in the CRM',
        },
      }),
    })
    fireEvent.click(screen.getByTestId('crm-deal-move'))
    const dialog = await screen.findByRole('dialog', { name: 'Move to stage' })
    fireEvent.change(within(dialog).getByLabelText('Stage'), { target: { value: 'proposal' } })
    fireEvent.click(within(dialog).getByTestId('crm-stage-dialog-submit'))
    expect((await within(dialog).findByTestId('crm-stage-dialog-error')).textContent).toContain(
      'The technical estimate is not ready yet',
    )
    expect(screen.queryByTestId('crm-stale-write')).toBeNull()
  })
})

describe('amount not known yet (specs/20261101-crm AC-3.2)', () => {
  it('shows “Not set yet” and no weighted value', async () => {
    await renderDeal(dealFixture({ amountCents: null }), MANAGER)
    const facts = screen.getByTestId('crm-deal-facts').textContent
    expect(facts).toContain('Not set yet')
    expect(facts).not.toContain('Weighted')
  })

  it('emptying the amount saves null; a non-number is still refused', async () => {
    let sent: Record<string, unknown> | null = null
    await renderDeal(dealFixture(), MANAGER, {
      'PATCH /deals/d1': (_url, init) => {
        sent = body(init)
        return { status: 200, body: dealFixture({ amountCents: null, version: 5 }) }
      },
    })
    fireEvent.click(screen.getByTestId('crm-deal-edit'))
    const dialog = await screen.findByRole('dialog', { name: /Edit deal/ })
    const amount = within(dialog).getByLabelText(/^Amount/)
    fireEvent.change(amount, { target: { value: 'abc' } })
    fireEvent.click(within(dialog).getByTestId('crm-deal-form-submit'))
    await waitFor(() => expect(amount.getAttribute('aria-invalid')).toBe('true'))
    expect(sent).toBeNull()
    fireEvent.change(amount, { target: { value: '' } })
    fireEvent.click(within(dialog).getByTestId('crm-deal-form-submit'))
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent!.amountCents).toBeNull()
  })
})

describe('where the lead came from (specs/20261101-crm US-7)', () => {
  it('shows the source with its detail, and the detail field follows the source', async () => {
    let sent: Record<string, unknown> | null = null
    await renderDeal(dealFixture({ source: 'referral', sourceDetail: 'Mario Rossi' }), MANAGER, {
      'PATCH /deals/d1': (_url, init) => {
        sent = body(init)
        return { status: 200, body: dealFixture({ source: 'inbound', sourceDetail: null, version: 5 }) }
      },
    })
    expect(screen.getByTestId('crm-deal-facts').textContent).toContain('Referral · Mario Rossi')
    fireEvent.click(screen.getByTestId('crm-deal-edit'))
    const dialog = await screen.findByRole('dialog', { name: /Edit deal/ })
    expect((within(dialog).getByLabelText(/^Referred by/) as HTMLInputElement).value).toBe('Mario Rossi')
    fireEvent.change(within(dialog).getByLabelText(/^Source/), { target: { value: 'event' } })
    expect(within(dialog).getByLabelText(/^Which event/)).not.toBeNull()
    fireEvent.change(within(dialog).getByLabelText(/^Source/), { target: { value: 'inbound' } })
    expect(within(dialog).queryByLabelText(/^Which event/)).toBeNull()
    fireEvent.click(within(dialog).getByTestId('crm-deal-form-submit'))
    await waitFor(() => expect(sent).not.toBeNull())
    // a detail never travels without a source that takes one
    expect(sent).toMatchObject({ source: 'inbound', sourceDetail: null })
  })

  it('a new deal starts from its company’s source', async () => {
    let posted: Record<string, unknown> | null = null
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: { ...MANAGER, canErase: false } }),
        'GET /companies/c1': () => ({
          status: 200,
          body: {
            ...companySummaryFixture,
            source: 'event',
            sourceDetail: 'Swiss Digital Day 2026',
          },
        }),
        'GET /contacts': () => ({ status: 200, body: page([]) }),
        'GET /deals': () => ({ status: 200, body: page([]) }),
        'GET /activities': () => ({ status: 200, body: page([]) }),
        'POST /deals': (_url, init) => {
          posted = body(init)
          return { status: 201, body: dealFixture() }
        },
      }),
    )
    window.history.pushState(null, '', '/companies/c1')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
    fireEvent.click(await screen.findByTestId('crm-company-new-deal'))
    const dialog = await screen.findByRole('dialog', { name: 'New deal' })
    expect((within(dialog).getByLabelText(/^Source/) as HTMLSelectElement).value).toBe('event')
    expect((within(dialog).getByLabelText(/^Which event/) as HTMLInputElement).value).toBe('Swiss Digital Day 2026')
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'Data platform' } })
    fireEvent.click(within(dialog).getByTestId('crm-deal-form-submit'))
    await waitFor(() => expect(posted).not.toBeNull())
    expect(posted).toMatchObject({ source: 'event', sourceDetail: 'Swiss Digital Day 2026' })
  })

  it('suggests the details already written for the source, matched while typing', async () => {
    let asked: string | null = null
    let sent: Record<string, unknown> | null = null
    await renderDeal(dealFixture({ source: 'inbound', sourceDetail: null }), MANAGER, {
      'GET /source-details': (url) => {
        asked = url.searchParams.get('source')
        return {
          status: 200,
          body: {
            items: [
              { value: 'Swiss Digital Day 2026', count: 3 },
              { value: 'Café Tech', count: 1 },
            ],
          },
        }
      },
      'PATCH /deals/d1': (_url, init) => {
        sent = body(init)
        return { status: 200, body: dealFixture({ version: 5 }) }
      },
    })
    fireEvent.click(screen.getByTestId('crm-deal-edit'))
    const dialog = await screen.findByRole('dialog', { name: /Edit deal/ })
    fireEvent.change(within(dialog).getByLabelText(/^Source/), { target: { value: 'event' } })
    const input = within(dialog).getByLabelText(/^Which event/)
    fireEvent.focus(input)
    await waitFor(() => expect(asked).toBe('event'))
    // case and accents do not matter
    fireEvent.change(input, { target: { value: 'cafe' } })
    const listbox = await within(dialog).findByRole('listbox')
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Café Tech'])
    fireEvent.click(within(listbox).getByRole('option'))
    expect((input as HTMLInputElement).value).toBe('Café Tech')
    // the chosen value is complete: no popup left behind
    expect(within(dialog).queryByRole('listbox')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('crm-deal-form-submit'))
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toMatchObject({ source: 'event', sourceDetail: 'Café Tech' })
  })
})

describe('new deal stages (AC-3.4)', () => {
  it('offers only lead and qualified for a new deal', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: { ...MANAGER, canErase: false } }),
        'GET /pipeline': () => ({ status: 200, body: { ...PIPELINE, stages: [] } }),
        'GET /deals': () => ({ status: 200, body: page([]) }),
      }),
    )
    window.history.pushState(null, '', '/pipeline')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
    fireEvent.click(await screen.findByTestId('crm-pipeline-new'))
    const dialog = await screen.findByRole('dialog', { name: 'New deal' })
    const options = Array.from(within(dialog).getByLabelText('Stage').querySelectorAll('option')).map(
      (o) => o.textContent,
    )
    expect(options).toEqual(['Lead', 'Qualified'])
  })
})

describe('Offers card (US-4)', () => {
  const OFFER = {
    id: 'o2',
    number: 2,
    reference: 'OF-2026-ABC123-2',
    language: 'it',
    priceCents: 9_000_000,
    currency: 'CHF',
    validityDays: 30,
    validUntil: '2026-12-01',
    aiAssisted: true,
    manDaysTenths: 125,
    sizeBytes: 1000,
    createdBy: ADA,
    createdAt: '2026-11-01T09:00:00.000Z',
    deleted: false,
  }
  const readyEstimate = { ...ESTIMATE, state: 'ready', readyAt: '2026-10-31T10:00:00.000Z' }

  it('lists versions with price, man-days to one decimal and the AI marker; a deleted one is greyed with no actions', async () => {
    await renderDeal(dealFixture({ stage: 'proposal', estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /deals/d1/offers': () => ({
        status: 200,
        body: { items: [OFFER, { ...OFFER, id: 'o1', number: 1, reference: 'OF-2026-ABC123-1', deleted: true }] },
      }),
    })
    const table = await screen.findByTestId('crm-offers-table')
    const rows = within(table).getAllByRole('row')
    expect(rows[1]!.textContent).toContain('OF-2026-ABC123-2')
    expect(rows[1]!.textContent).toContain('CHF 90,000.00')
    expect(rows[1]!.textContent).toContain('12.5')
    expect(rows[1]!.textContent).toContain('AI-assisted')
    expect(within(rows[1]!).getByRole('button', { name: 'Download OF-2026-ABC123-2' })).not.toBeNull()
    expect(rows[2]!.textContent).toContain('Deleted')
    expect(within(rows[2]!).queryByRole('button')).toBeNull()
  })

  it('Generate offer is disabled until the estimate is ready', async () => {
    await renderDeal(dealFixture({ stage: 'qualified', estimate: ESTIMATE, estimateState: 'requested' }), MANAGER)
    expect(((await screen.findByTestId('crm-offer-generate')) as HTMLButtonElement).disabled).toBe(true)
  })

  const TEMPLATE_IT = {
    id: 't-it',
    entity: 'welld_ch',
    name: 'Standard IT',
    language: 'it',
    archived: false,
    version: 1,
  }
  const TEMPLATE_EN = { ...TEMPLATE_IT, id: 't-en', name: 'Standard EN', language: 'en' }
  const draftFor = (overrides: Record<string, unknown> = {}) => ({
    templateId: 't-en',
    templateName: 'Standard EN',
    language: 'en',
    currency: 'CHF',
    salutation: 'Dear Sir or Madam,',
    clientLines: ['Acme SA', 'Via Nassa 1'],
    opening: 'Following our meeting on {deal}.',
    sections: [
      { heading: 'Object', body: 'Rebuild.', costs: false },
      { heading: 'Costs', body: '', costs: true },
    ],
    costColumns: { position: true, unit: true },
    showTotal: true,
    costLines: [
      { description: 'Development', kind: 'one_off', unitCents: 1_000_000, percentBp: null, quantity: 10 },
      { description: 'Hosting', kind: 'yearly', unitCents: 120_000, percentBp: null, quantity: 1 },
      { description: 'Launch discount', kind: 'discount', unitCents: null, percentBp: 1000, quantity: 1 },
    ],
    acceptanceLabel: null,
    annex: true,
    validityDays: 30,
    aiAssisted: false,
    manDays: 12.5,
    ...overrides,
  })
  const CONTACT = {
    id: 'k1',
    firstName: 'Carla',
    lastName: 'Rossi',
    email: null,
    phone: null,
    jobTitle: null,
    company: { id: 'c1', name: 'Acme SA' },
    archived: false,
    updatedAt: '2026-10-01T10:00:00.000Z',
  }
  const PDF = {
    id: 'a1',
    fileName: 'scope.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    canDownload: true,
    uploadedBy: ADA,
    createdAt: '2026-10-02T10:00:00.000Z',
  }
  const DOCX = {
    ...PDF,
    id: 'a2',
    fileName: 'notes.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }

  const openDialog = async (extra: Record<string, FakeHandler> = {}, stage = 'qualified') => {
    await renderDeal(dealFixture({ stage, estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /offer-templates': () => ({ status: 200, body: { items: [TEMPLATE_IT, TEMPLATE_EN] } }),
      'GET /contacts': () => ({ status: 200, body: page([CONTACT]) }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [PDF, DOCX] } }),
      'GET /deals/d1/offers/draft': () => ({ status: 200, body: draftFor() }),
      ...extra,
    })
    fireEvent.click(await screen.findByTestId('crm-offer-generate'))
    const dialog = await screen.findByRole('dialog', { name: 'Generate an offer' })
    await within(dialog).findByRole('option', { name: 'Standard EN (English)' })
    return dialog
  }
  const pickTemplate = async (dialog: HTMLElement, id = 't-en') => {
    fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: id } })
    await within(dialog).findByTestId('crm-offer-form')
  }

  it('a deal an admin let go without an estimate can have an offer, with no AI or annex choice (specs/20261101-crm-sales-flow AC-3.7)', async () => {
    await renderDeal(dealFixture({ stage: 'proposal', estimateOverridden: true }), MANAGER, {
      'GET /offer-templates': () => ({ status: 200, body: { items: [TEMPLATE_EN] } }),
      'GET /contacts': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/offers/draft': () => ({ status: 200, body: draftFor({ annex: false, manDays: 0 }) }),
    })
    const generate = (await screen.findByTestId('crm-offer-generate')) as HTMLButtonElement
    expect(generate.disabled).toBe(false)
    fireEvent.click(generate)
    const dialog = await screen.findByRole('dialog', { name: 'Generate an offer' })
    expect(within(dialog).getByTestId('crm-offer-no-estimate')).not.toBeNull()
    expect(within(dialog).queryByTestId('crm-offer-ai')).toBeNull()
    await within(dialog).findByRole('option', { name: 'Standard EN (English)' })
    await pickTemplate(dialog)
    expect(within(dialog).queryByTestId('crm-offer-annex')).toBeNull()
    expect(dialog.textContent).toContain('Language: English.')
    expect(dialog.textContent).not.toContain('Estimate: 0 man-days')
  })

  it('lists the active templates of the deal’s entity, the person’s language first, and archived ones not at all', async () => {
    let listed = ''
    await renderDeal(dealFixture({ stage: 'qualified', estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /offer-templates': (url) => {
        listed = url.search
        return {
          status: 200,
          body: {
            items: [TEMPLATE_IT, { ...TEMPLATE_EN, archived: true }, { ...TEMPLATE_EN, id: 't-en2', name: 'AAA EN' }],
          },
        }
      },
    })
    fireEvent.click(await screen.findByTestId('crm-offer-generate'))
    const dialog = await screen.findByRole('dialog', { name: 'Generate an offer' })
    await within(dialog).findByRole('option', { name: 'AAA EN (English)' })
    expect(listed).toContain('entity=welld_ch')
    const select = within(dialog).getByLabelText('Template') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Choose a template…',
      'AAA EN (English)',
      'Standard IT (Italian)',
    ])
  })

  it('loads the draft of the chosen template and fills the form, with totals computed by the server’s rules', async () => {
    let draftQuery = ''
    const dialog = await openDialog({
      'GET /deals/d1/offers/draft': (url) => {
        draftQuery = url.search
        return { status: 200, body: draftFor() }
      },
    })
    expect(within(dialog).queryByTestId('crm-offer-form')).toBeNull()
    await pickTemplate(dialog)
    expect(draftQuery).toBe('?templateId=t-en&aiAssisted=false')
    expect((within(dialog).getByLabelText(/^Salutation/) as HTMLInputElement).value).toBe('Dear Sir or Madam,')
    expect((within(dialog).getByLabelText('Client line 1') as HTMLInputElement).value).toBe('Acme SA')
    expect((within(dialog).getByLabelText(/^Heading \(2\)/) as HTMLInputElement).value).toBe('Costs')
    expect((within(dialog).getByLabelText('Amount (CHF) (1)') as HTMLInputElement).value).toBe('10000')
    expect((within(dialog).getByLabelText('Quantity (1)') as HTMLInputElement).value).toBe('10')
    expect((within(dialog).getByLabelText('Percentage (3)') as HTMLInputElement).value).toBe('10')
    // 10 × 10 000 = 100 000; 10% discount = 10 000 → 90 000; yearly 1 200.
    expect(within(dialog).getByTestId('crm-offer-total-oneoff').textContent).toBe('CHF 90,000.00')
    expect(within(dialog).getByTestId('crm-offer-total-yearly').textContent).toBe('CHF 1,200.00')
    expect(within(dialog).getByText(/Estimate: 12\.5 man-days/)).not.toBeNull()
  })

  it('changing the template asks before replacing what is on screen; Keep leaves the edits', async () => {
    const queries: string[] = []
    const dialog = await openDialog({
      'GET /deals/d1/offers/draft': (url) => {
        queries.push(url.search)
        return {
          status: 200,
          body: draftFor(
            url.searchParams.get('templateId') === 't-it' ? { templateId: 't-it', salutation: 'Gentile Cliente,' } : {},
          ),
        }
      },
    })
    await pickTemplate(dialog)
    fireEvent.change(within(dialog).getByLabelText(/^Salutation/), { target: { value: 'Hello' } })
    fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: 't-it' } })
    const ask = await screen.findByRole('alertdialog', { name: 'Replace what is on screen?' })
    expect(queries).toHaveLength(1)
    fireEvent.click(within(ask).getByTestId('crm-offer-replace-cancel'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect((within(dialog).getByLabelText(/^Salutation/) as HTMLInputElement).value).toBe('Hello')
    expect((within(dialog).getByLabelText('Template') as HTMLSelectElement).value).toBe('t-en')
    // Now confirm.
    fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: 't-it' } })
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('crm-offer-replace-confirm'))
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^Salutation/) as HTMLInputElement).value).toBe('Gentile Cliente,'),
    )
    expect(queries).toEqual(['?templateId=t-en&aiAssisted=false', '?templateId=t-it&aiAssisted=false'])
  })

  it('AI-assisted re-requests the draft with aiAssisted=true after the same confirmation', async () => {
    const queries: string[] = []
    const dialog = await openDialog({
      'GET /deals/d1/offers/draft': (url) => {
        queries.push(url.search)
        return { status: 200, body: draftFor({ aiAssisted: url.searchParams.get('aiAssisted') === 'true' }) }
      },
    })
    await pickTemplate(dialog)
    fireEvent.click(within(dialog).getByTestId('crm-offer-ai'))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('crm-offer-replace-confirm'))
    await waitFor(() => expect(queries).toHaveLength(2))
    expect(queries[1]).toBe('?templateId=t-en&aiAssisted=true')
  })

  it('posts the exact body: cents from decimal amounts, percentBp for a percentage discount, contacts, PDFs and validity', async () => {
    let generated: Record<string, unknown> | null = null
    let stageCall: { body: Record<string, unknown>; ifMatch: string | null } | null = null
    const dialog = await openDialog({
      'POST /deals/d1/offers': (_url, init) => {
        generated = body(init)
        return { status: 201, body: OFFER }
      },
      'POST /deals/d1/stage': (_url, init) => {
        stageCall = { body: body(init), ifMatch: (init?.headers as Record<string, string>)['If-Match'] ?? null }
        return { status: 200, body: dealFixture({ stage: 'proposal', version: 5 }) }
      },
    })
    await pickTemplate(dialog)
    fireEvent.click(await within(dialog).findByLabelText('Carla Rossi'))
    // Only PDFs are offered to append.
    expect(within(dialog).queryByLabelText(/notes\.docx/)).toBeNull()
    fireEvent.click(within(dialog).getByLabelText('scope.pdf (2 KB)'))
    fireEvent.change(within(dialog).getByLabelText('Amount (CHF) (1)'), { target: { value: '9500.50' } })
    fireEvent.change(within(dialog).getByLabelText('Percentage (3)'), { target: { value: '12.5' } })
    fireEvent.change(within(dialog).getByLabelText(/^Validity \(days\)/), { target: { value: '45' } })
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    await waitFor(() => expect(generated).not.toBeNull())
    expect(generated).toEqual({
      templateId: 't-en',
      salutation: 'Dear Sir or Madam,',
      clientLines: ['Acme SA', 'Via Nassa 1'],
      contactIds: ['k1'],
      opening: 'Following our meeting on {deal}.',
      sections: [
        { heading: 'Object', body: 'Rebuild.', costs: false },
        { heading: 'Costs', body: '', costs: true },
      ],
      costColumns: { position: true, unit: true },
      showTotal: true,
      costLines: [
        { description: 'Development', kind: 'one_off', unitCents: 950_050, quantity: 10 },
        { description: 'Hosting', kind: 'yearly', unitCents: 120_000, quantity: 1 },
        { description: 'Launch discount', kind: 'discount', percentBp: 1250, quantity: 1 },
      ],
      acceptanceLabel: null,
      annex: true,
      attachmentIds: ['a1'],
      validityDays: 45,
      aiAssisted: false,
    })
    // After success: the proposal question, using the deal's version.
    const ask = await screen.findByRole('alertdialog', { name: 'Move the deal to offer in preparation?' })
    expect(stageCall).toBeNull()
    fireEvent.click(within(ask).getByTestId('crm-offer-proposal-confirm'))
    await waitFor(() => expect(stageCall).toEqual({ body: { stage: 'proposal' }, ifMatch: '"4"' }))
  })

  it('refuses discounts above the one-off lines, live, and sends nothing', async () => {
    let posted = false
    const dialog = await openDialog({
      'POST /deals/d1/offers': () => {
        posted = true
        return { status: 201, body: OFFER }
      },
    })
    await pickTemplate(dialog)
    fireEvent.change(within(dialog).getByLabelText('Amount (CHF) (1)'), { target: { value: '100' } })
    fireEvent.change(within(dialog).getByLabelText('Quantity (1)'), { target: { value: '1' } })
    fireEvent.change(within(dialog).getByLabelText('Kind (3)'), { target: { value: 'discount' } })
    fireEvent.change(within(dialog).getByLabelText('Amount type (3)'), { target: { value: 'fixed' } })
    fireEvent.change(within(dialog).getByLabelText('Amount (CHF) (3)'), { target: { value: '250' } })
    expect((await within(dialog).findByTestId('crm-offer-discounts-exceed')).textContent).toContain('discounts exceed')
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    expect((await within(dialog).findByTestId('crm-offer-dialog-error')).textContent).toContain(
      'Some fields need attention',
    )
    expect(posted).toBe(false)
  })

  it('without the unit columns every quantity is 1 and the quantity fields are gone', async () => {
    let generated: Record<string, unknown> | null = null
    const dialog = await openDialog({
      'POST /deals/d1/offers': (_url, init) => {
        generated = body(init)
        return { status: 201, body: OFFER }
      },
    })
    await pickTemplate(dialog)
    fireEvent.click(within(dialog).getByTestId('crm-offer-cost-unit'))
    expect(within(dialog).queryByLabelText('Quantity (1)')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    await waitFor(() => expect(generated).not.toBeNull())
    const lines = (generated as unknown as { costLines: { quantity: number }[]; costColumns: unknown }).costLines
    expect(lines.map((line) => line.quantity)).toEqual([1, 1, 1])
    expect((generated as unknown as { costColumns: unknown }).costColumns).toEqual({ position: true, unit: false })
  })

  it('validates sections like a template: a heading is required, and the costs section is exactly one', async () => {
    let posted = false
    const dialog = await openDialog({
      'POST /deals/d1/offers': () => {
        posted = true
        return { status: 201, body: OFFER }
      },
    })
    await pickTemplate(dialog)
    fireEvent.click(within(dialog).getByTestId('crm-offer-section-add'))
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    expect(await within(dialog).findByText('The heading is required.')).not.toBeNull()
    expect(posted).toBe(false)
    // One radio group: choosing the new section's takes the table away from the other.
    fireEvent.click(within(dialog).getByTestId('crm-offer-section-2-costs'))
    expect((within(dialog).getByTestId('crm-offer-section-1-costs') as HTMLInputElement).checked).toBe(false)
    expect((within(dialog).getByTestId('crm-offer-section-2-costs') as HTMLInputElement).checked).toBe(true)
  })

  it('maps the generate refusals to readable lines and keeps the dialog', async () => {
    const dialog = await openDialog({
      'POST /deals/d1/offers': () => ({
        status: 422,
        body: {
          status: 422,
          title: 'Unprocessable',
          code: 'attachment_unreadable',
          fileName: 'scope.pdf',
          detail: 'x',
        },
      }),
    })
    await pickTemplate(dialog)
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    expect((await within(dialog).findByTestId('crm-offer-dialog-error')).textContent).toContain(
      'scope.pdf cannot be read',
    )
  })

  it('maps entity_profile_missing to a readable error and keeps the dialog', async () => {
    const dialog = await openDialog({
      'POST /deals/d1/offers': () => ({
        status: 409,
        body: { status: 409, title: 'Conflict', code: 'entity_profile_missing', detail: 'x' },
      }),
    })
    await pickTemplate(dialog)
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    expect((await within(dialog).findByTestId('crm-offer-dialog-error')).textContent).toContain('letterhead')
  })

  it('maps storage_unconfigured on generate to a readable error', async () => {
    const dialog = await openDialog({
      'POST /deals/d1/offers': () => ({
        status: 503,
        body: { status: 503, title: 'Unavailable', code: 'storage_unconfigured', detail: 'x' },
      }),
    })
    await pickTemplate(dialog)
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    expect((await within(dialog).findByTestId('crm-offer-dialog-error')).textContent).toContain(
      'File storage is not set up',
    )
  })

  it.each([
    ['pdf_check_busy', 'The check of uploaded PDFs is busy. Try again in a moment.'],
    ['pdf_check_unavailable', 'The PDF could not be checked right now. Try again.'],
  ])('says a 503 %s in our own words, never the server detail, and keeps the dialog', async (code, line) => {
    const dialog = await openDialog({
      'POST /deals/d1/offers': () => ({
        status: 503,
        body: { status: 503, title: 'Unavailable', code, detail: 'Too many files are being checked right now.' },
      }),
    })
    await pickTemplate(dialog)
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    const error = await within(dialog).findByTestId('crm-offer-dialog-error')
    expect(error.textContent).toContain(line)
    expect(error.textContent).not.toContain('Too many files')
  })

  it('the list shows the yearly figure and the template name', async () => {
    await renderDeal(dealFixture({ stage: 'proposal', estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /deals/d1/offers': () => ({
        status: 200,
        body: {
          items: [
            { ...OFFER, yearlyCents: 120_000, templateName: 'Standard EN' },
            { ...OFFER, id: 'o1', number: 1, yearlyCents: 0 },
          ],
        },
      }),
    })
    await screen.findByTestId('crm-offers-table')
    expect(screen.getByTestId('crm-offer-yearly-o2').textContent).toBe('+ CHF 1,200.00 per year')
    expect(screen.queryByTestId('crm-offer-yearly-o1')).toBeNull()
    expect(screen.getByTestId('crm-offer-template-o2').textContent).toBe('Template: Standard EN')
  })

  // specs/20261102-crm-offer-document US-7: an offer from a template, not sent yet.
  const DOC = { ...OFFER, reference: '0001/2026', templateName: 'Standard EN', sent: null, version: 3 }
  const SENT_DOC = { ...DOC, sent: { at: '2026-11-03T10:00:00.000Z', by: ADA }, version: 4 }

  it('Mark as sent is on the newest unsent offer only; it freezes it and reloads the deal (US-7)', async () => {
    let posted = false
    await renderDeal(dealFixture({ stage: 'proposal', estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /deals/d1/offers': () => ({
        status: 200,
        body: { items: [DOC, { ...DOC, id: 'o1', number: 1, reference: 'OF-2026-ABC123-1', templateName: null }] },
      }),
      'POST /deals/d1/offers/o2/sent': () => {
        posted = true
        return { status: 200, body: SENT_DOC }
      },
    })
    fireEvent.click(await screen.findByTestId('crm-offer-sent-o2'))
    // an unsent offer is edited, so the header offers no new generation
    expect(screen.queryByTestId('crm-offer-generate')).toBeNull()
    expect(screen.queryByTestId('crm-offer-sent-o1')).toBeNull()
    const ask = await screen.findByRole('alertdialog', { name: 'Mark the offer as sent?' })
    expect(ask.textContent).toContain('It can no longer be edited')
    expect(ask.textContent).toContain('The deal moves to offer sent')
    fireEvent.click(within(ask).getByTestId('crm-offer-sent-dialog-confirm'))
    await waitFor(() => expect(posted).toBe(true))
  })

  it('a sent offer shows when it went out, has no Edit, and the header offers a new revision from it (US-7)', async () => {
    let formAsked = ''
    await renderDeal(dealFixture({ stage: 'negotiation', estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [SENT_DOC] } }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [TEMPLATE_IT, TEMPLATE_EN] } }),
      'GET /contacts': () => ({ status: 200, body: page([CONTACT]) }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [PDF, DOCX] } }),
      'GET /deals/d1/offers/o2/form': (url) => {
        formAsked = url.pathname
        return {
          status: 200,
          body: { ...draftFor({ opening: 'As sent.' }), contactIds: [], attachmentIds: [], version: 4, sent: true },
        }
      },
    })
    expect((await screen.findByTestId('crm-offer-sent-badge-o2')).textContent).toBe('Sent 03.11.2026')
    expect(screen.queryByTestId('crm-offer-edit-o2')).toBeNull()
    expect(screen.queryByTestId('crm-offer-sent-o2')).toBeNull()
    const revise = await screen.findByTestId('crm-offer-generate')
    expect(revise.textContent).toBe('New revision')
    fireEvent.click(revise)
    const dialog = await screen.findByRole('dialog', { name: 'New revision of 0001/2026' })
    await within(dialog).findByTestId('crm-offer-form')
    expect(formAsked).toBe('/deals/d1/offers/o2/form')
    expect((within(dialog).getByLabelText(/^Opening/) as HTMLTextAreaElement).value).toBe('As sent.')
  })

  it('Edit opens the offer’s own content and saves it in place with its version (US-7)', async () => {
    let saved: { body: Record<string, unknown>; ifMatch: string | null } | null = null
    await renderDeal(dealFixture({ stage: 'proposal', estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [DOC] } }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [TEMPLATE_IT, TEMPLATE_EN] } }),
      'GET /contacts': () => ({ status: 200, body: page([CONTACT]) }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [PDF, DOCX] } }),
      'GET /deals/d1/offers/o2/form': () => ({
        status: 200,
        body: { ...draftFor(), contactIds: [CONTACT.id], attachmentIds: [PDF.id], version: 3, sent: false },
      }),
      'PUT /deals/d1/offers/o2': (_url, init) => {
        saved = { body: body(init), ifMatch: (init?.headers as Record<string, string>)['If-Match'] ?? null }
        return { status: 200, body: { ...DOC, version: 4 } }
      },
    })
    fireEvent.click(await screen.findByTestId('crm-offer-edit-o2'))
    const dialog = await screen.findByRole('dialog', { name: 'Edit offer 0001/2026' })
    await within(dialog).findByTestId('crm-offer-form')
    // the contacts and PDFs it was generated with come back chosen
    expect((within(dialog).getByTestId(`crm-offer-contact-${CONTACT.id}`) as HTMLInputElement).checked).toBe(true)
    expect((within(dialog).getByTestId(`crm-offer-attachment-${PDF.id}`) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/^Opening/), { target: { value: 'Corrected opening.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and regenerate' }))
    await waitFor(() => expect(saved).not.toBeNull())
    expect(saved!.ifMatch).toBe('"3"')
    expect(saved!.body).toMatchObject({
      templateId: 't-en',
      opening: 'Corrected opening.',
      contactIds: [CONTACT.id],
      attachmentIds: [PDF.id],
    })
  })

  it('Download opens the returned link in a new tab', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await renderDeal(dealFixture({ stage: 'proposal', estimate: readyEstimate, estimateState: 'ready' }), MANAGER, {
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [OFFER] } }),
      'GET /deals/d1/offers/o2/download': () => ({ status: 200, body: { url: 'https://bucket.test/o2.pdf' } }),
    })
    fireEvent.click(await screen.findByTestId('crm-offer-download-o2'))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://bucket.test/o2.pdf', '_blank', 'noopener'))
  })
})

describe('Attachments card (AC-4.3, AC-4.4)', () => {
  const FILE = {
    id: 'a9',
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    uploadedBy: TESS,
    createdAt: '2026-11-01T09:00:00.000Z',
    canDownload: false,
  }

  it('uploads in three calls: the API issues the form, the bucket gets the file WITHOUT a token, the API confirms', async () => {
    const order: string[] = []
    let started: Record<string, unknown> | null = null
    const bucket = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      order.push('bucket')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toBeUndefined()
      expect((init?.body as FormData).get('key')).toBe('deals/d1/a1')
      expect((init?.body as FormData).get('file')).toBeInstanceOf(Blob)
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', bucket)
    await renderDeal(dealFixture(), MANAGER, {
      'POST /deals/d1/attachments': (_url, init) => {
        order.push('start')
        started = body(init)
        return {
          status: 201,
          body: { attachmentId: 'a1', upload: { url: 'https://bucket.test/up', fields: { key: 'deals/d1/a1' } } },
        }
      },
      'POST /deals/d1/attachments/a1/confirm': () => {
        order.push('confirm')
        return { status: 200, body: { ...FILE, id: 'a1', fileName: 'scope.pdf', canDownload: true } }
      },
    })
    const file = new File(['%PDF'], 'scope.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByTestId('crm-attachment-input'), { target: { files: [file] } })
    await waitFor(() => expect(order).toEqual(['start', 'bucket', 'confirm']))
    expect(started).toEqual({ fileName: 'scope.pdf', contentType: 'application/pdf', sizeBytes: 4 })
    expect(bucket).toHaveBeenCalledTimes(1)
    expect(String(bucket.mock.calls[0]![0])).toBe('https://bucket.test/up')
    // The bucket is not an API origin: the shell's apiFetch (which adds the token) never saw it.
    expect(apiFetch.mock.calls.some(([url]) => String(url).includes('bucket.test'))).toBe(false)
    expect(await screen.findByText('scope.pdf uploaded.')).not.toBeNull()
  })

  it('refuses a type or a size the server would refuse, before any request', async () => {
    await renderDeal(dealFixture(), MANAGER)
    const calls = apiFetch.mock.calls.length
    fireEvent.change(screen.getByTestId('crm-attachment-input'), {
      target: { files: [new File(['x'], 'run.exe', { type: 'application/x-msdownload' })] },
    })
    expect((await screen.findByTestId('crm-attachments-error')).textContent).toContain('This file type is not allowed')
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByTestId('crm-attachment-input'), { target: { files: [big] } })
    expect(await screen.findByText('A file is at most 20 MB.')).not.toBeNull()
    expect(apiFetch.mock.calls.length).toBe(calls)
  })

  it('shows a calm "storage is not set up" panel on a 503 storage_unconfigured', async () => {
    await renderDeal(dealFixture(), MANAGER, {
      'POST /deals/d1/attachments': () => ({
        status: 503,
        body: { status: 503, title: 'Unavailable', code: 'storage_unconfigured', detail: 'x' },
      }),
    })
    fireEvent.change(screen.getByTestId('crm-attachment-input'), {
      target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
    })
    expect((await screen.findByTestId('crm-attachments-storage-missing')).textContent).toContain(
      'File storage is not set up yet',
    )
  })

  it.each([
    ['pdf_check_busy', 'The check of uploaded PDFs is busy. Try again in a moment.'],
    ['pdf_check_unavailable', 'The PDF could not be checked right now. Try again.'],
  ])('says a 503 %s at the confirm of a PDF in our own words, never the server detail', async (code, line) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    await renderDeal(dealFixture(), MANAGER, {
      'POST /deals/d1/attachments': () => ({
        status: 201,
        body: { attachmentId: 'a1', upload: { url: 'https://bucket.test/up', fields: { key: 'deals/d1/a1' } } },
      }),
      'POST /deals/d1/attachments/a1/confirm': () => ({
        status: 503,
        body: {
          status: 503,
          title: 'Unavailable',
          code,
          detail: 'The file could not be checked. Try again in a moment.',
        },
      }),
    })
    fireEvent.change(screen.getByTestId('crm-attachment-input'), {
      target: { files: [new File(['%PDF'], 'scope.pdf', { type: 'application/pdf' })] },
    })
    const error = await screen.findByTestId('crm-attachments-error')
    expect(error.textContent).toContain(line)
    expect(error.textContent).not.toContain('could not be checked. Try again in a moment')
    expect(screen.queryByTestId('crm-attachments-storage-missing')).toBeNull()
  })

  it('offers Download only where canDownload, and Delete to the uploader or an admin', async () => {
    await renderDeal(dealFixture(), MANAGER, {
      'GET /deals/d1/attachments': () => ({
        status: 200,
        body: { items: [FILE, { ...FILE, id: 'a8', fileName: 'mine.pdf', uploadedBy: ADA, canDownload: true }] },
      }),
    })
    const table = await screen.findByTestId('crm-attachments-table')
    expect(within(table).queryByTestId('crm-attachment-download-a9')).toBeNull()
    expect(within(table).getByTestId('crm-attachment-download-a8')).not.toBeNull()
    expect(within(table).queryByTestId('crm-attachment-delete-a9')).toBeNull()
    expect(within(table).getByTestId('crm-attachment-delete-a8')).not.toBeNull()
    expect(table.textContent).toContain('2 KB')
  })
})

describe('a text the server refuses for a character that cannot be saved, in the CRM forms (QE F2)', () => {
  const SENTENCE = 'This text contains a character that cannot be saved.'
  const RAW = /NUL|Not text|title:|firstName:/
  const openCompany = (extra: Record<string, FakeHandler>) => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: { ...MANAGER, canErase: false } }),
        'GET /companies/c1': () => ({ status: 200, body: companySummaryFixture }),
        'GET /contacts': () => ({ status: 200, body: page([]) }),
        'GET /deals': () => ({ status: 200, body: page([]) }),
        'GET /activities': () => ({ status: 200, body: page([]) }),
        ...extra,
      }),
    )
    window.history.pushState(null, '', '/companies/c1')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  }

  it('a deal title: our sentence at the Title field, focus there, no server line', async () => {
    openCompany({ 'POST /deals': () => nulRefusalAnswer('title') })
    fireEvent.click(await screen.findByTestId('crm-company-new-deal'))
    const dialog = await screen.findByRole('dialog', { name: 'New deal' })
    const title = within(dialog).getByLabelText(/^Title/)
    fireEvent.change(title, { target: { value: 'Data platform' } })
    fireEvent.click(within(dialog).getByTestId('crm-deal-form-submit'))
    expect(await within(dialog).findByText(SENTENCE)).not.toBeNull()
    expect(title.getAttribute('aria-invalid')).toBe('true')
    expect(dialog.textContent).not.toMatch(RAW)
  })

  it('a deal field the form does not map: a banner in our words, not the server line', async () => {
    openCompany({ 'POST /deals': () => nulRefusalAnswer('somethingElse') })
    fireEvent.click(await screen.findByTestId('crm-company-new-deal'))
    const dialog = await screen.findByRole('dialog', { name: 'New deal' })
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'Data platform' } })
    fireEvent.click(within(dialog).getByTestId('crm-deal-form-submit'))
    expect(await within(dialog).findByText(SENTENCE)).not.toBeNull()
    expect(dialog.textContent).not.toMatch(/NUL|Not text|somethingElse/)
  })

  it('a contact name: our sentence at the First name field, no server line', async () => {
    openCompany({ 'POST /contacts': () => nulRefusalAnswer('firstName') })
    fireEvent.click(await screen.findByTestId('crm-company-add-contact'))
    const dialog = await screen.findByRole('dialog')
    const first = within(dialog).getByLabelText(/^First name/)
    fireEvent.change(first, { target: { value: 'Ada' } })
    fireEvent.change(within(dialog).getByLabelText(/^Last name/), { target: { value: 'Lovelace' } })
    fireEvent.click(within(dialog).getByTestId('crm-contact-form-submit'))
    expect(await within(dialog).findByText(SENTENCE)).not.toBeNull()
    expect(first.getAttribute('aria-invalid')).toBe('true')
    expect(dialog.textContent).not.toMatch(RAW)
  })
})

describe('Settings screen', () => {
  const render_ = async (scope: Scope, extra: Record<string, FakeHandler> = {}) => {
    apiFetch.mockImplementation(
      fakeApi({ 'GET /scope': () => ({ status: 200, body: { ...scope, canErase: false } }), ...extra }),
    )
    window.history.pushState(null, '', '/settings')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  }

  it('saves the CRM’s own values only: the terms and the place of issue (AC-6.1)', async () => {
    let put: Record<string, unknown> | null = null
    await render_(MANAGER, {
      'GET /entity-profiles': () => ({ status: 200, body: { items: [] } }),
      'PUT /entity-profiles/welld_ch': (_url, init) => {
        put = body(init)
        return {
          status: 200,
          body: {
            entity: 'welld_ch',
            offerTermsEn: null,
            offerTermsIt: null,
            placeOfIssue: null,
            ...put,
            updatedAt: '2026-11-01T09:00:00.000Z',
          },
        }
      },
    })
    const form = await screen.findByTestId('crm-settings-welld_ch')
    expect(within(form).queryByLabelText(/Legal name|Address|VAT number|IBAN/)).toBeNull()
    fireEvent.change(within(form).getByLabelText('Place of issue'), { target: { value: ' Zurich ' } })
    fireEvent.click(within(form).getByTestId('crm-settings-welld_ch-save'))
    await waitFor(() => expect(put).toEqual({ offerTermsEn: null, offerTermsIt: null, placeOfIssue: 'Zurich' }))
    expect(await screen.findByText('wellD CH profile saved.')).not.toBeNull()
  })

  describe('a text the server refuses for a character that cannot be saved (QE F2)', () => {
    const RAW = /NUL|placeOfIssue|offerTermsEn|Not text|foo/
    const refuse = async (field: string) => {
      await render_(MANAGER, {
        'GET /entity-profiles': () => ({ status: 200, body: { items: [] } }),
        'PUT /entity-profiles/welld_ch': () => nulRefusalAnswer(field),
      })
      const form = await screen.findByTestId('crm-settings-welld_ch')
      fireEvent.change(within(form).getByLabelText('Place of issue'), { target: { value: 'Lugano' } })
      fireEvent.click(within(form).getByTestId('crm-settings-welld_ch-save'))
      return form
    }

    it('puts the localized sentence at the place-of-issue field and moves focus there, from the Save button', async () => {
      const form = await refuse('placeOfIssue')
      const place = within(form).getByLabelText('Place of issue')
      await waitFor(() => expect(document.activeElement).toBe(place))
      expect(place.getAttribute('aria-invalid')).toBe('true')
      expect(within(form).getByText('This text contains a character that cannot be saved.')).not.toBeNull()
      expect(within(form).queryByTestId('crm-settings-welld_ch-error')).toBeNull()
      expect(form.textContent).not.toMatch(RAW)
    })

    it('names the standard-terms field for a refused text of the terms', async () => {
      const form = await refuse('offerTermsEn')
      const terms = within(form).getByLabelText('Standard terms (English)')
      await waitFor(() => expect(document.activeElement).toBe(terms))
      expect(terms.getAttribute('aria-invalid')).toBe('true')
      expect(form.textContent).not.toMatch(RAW)
    })

    it('shows an announced, focused banner with our sentence when the server names a field the form lacks', async () => {
      const form = await refuse('foo')
      const banner = await within(form).findByTestId('crm-settings-welld_ch-error')
      expect(banner.getAttribute('role')).toBe('alert')
      expect(banner.textContent).toBe('This text contains a character that cannot be saved.')
      await waitFor(() => expect(document.activeElement).toBe(banner))
      expect(form.textContent).not.toMatch(RAW)
    })
  })

  it('shows one form per entity in the caller’s deal scope only', async () => {
    await render_(
      { deal: ['welld_ch', 'welld_it'], financials: true, managesAll: true },
      {
        'GET /entity-profiles': () => ({ status: 200, body: { items: [] } }),
      },
    )
    await screen.findByTestId('crm-settings-welld_ch')
    expect(screen.getByTestId('crm-settings-welld_it')).not.toBeNull()
  })

  it('sets where the offer numbers continue from, and refuses a number an offer already uses (specs/20261102-crm-offer-document US-8)', async () => {
    let put: Record<string, unknown> | null = null
    await render_(MANAGER, {
      'GET /entity-profiles': () => ({ status: 200, body: { items: [] } }),
      'GET /offer-sequences/welld_ch': () => ({
        status: 200,
        body: { entity: 'welld_ch', year: 2026, next: 4, lowestAllowed: 4 },
      }),
      'PUT /offer-sequences/welld_ch': (_url, init) => {
        put = body(init)
        return { status: 200, body: { entity: 'welld_ch', year: 2026, next: 19, lowestAllowed: 4 } }
      },
    })
    const card = await screen.findByTestId('crm-settings-welld_ch-numbering')
    const next = (await within(card).findByLabelText(/Next offer number/)) as HTMLInputElement
    expect(next.value).toBe('4')
    expect(card.textContent).toContain('0004/2026')
    // below a number already used: refused before the server is asked
    fireEvent.change(next, { target: { value: '2' } })
    fireEvent.click(within(card).getByTestId('crm-settings-welld_ch-numbering-save'))
    expect(await within(card).findByText('An offer already uses that number. Use 4 or more.')).not.toBeNull()
    expect(put).toBeNull()
    // A typed number is not the saved one: the hint keeps the saved number and a
    // warning says the change is not applied until saved.
    fireEvent.change(next, { target: { value: '19' } })
    expect(card.textContent).toContain('The next new offer is numbered 0004/2026.')
    expect(within(card).getByTestId('crm-settings-welld_ch-numbering-unsaved').textContent).toBe(
      'Not saved yet. Until you save, the next new offer is still 0004/2026; after saving it will be 0019/2026.',
    )
    fireEvent.click(within(card).getByTestId('crm-settings-welld_ch-numbering-save'))
    await waitFor(() => expect(put).toEqual({ year: 2026, next: 19 }))
    expect(await within(card).findByText('wellD CH: the next new offer is 0019/2026.')).not.toBeNull()
    expect(card.textContent).toContain('The next new offer is numbered 0019/2026.')
    expect(within(card).queryByTestId('crm-settings-welld_ch-numbering-unsaved')).toBeNull()
  })
})
