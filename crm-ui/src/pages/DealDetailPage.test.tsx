/**
 * @vitest-environment jsdom
 *
 * DealDetailPage (AC-3.1, 3.3, 3.5; D-7): a caller outside the deal's entity
 * scope reads the deal but gets no edit/move controls; a move refused as stale
 * (409 version_conflict) closes the dialog and shows the reload banner, whose
 * Reload fetches the deal again. The weighted amount uses the probability
 * `GET /pipeline` returns (D-8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { ADA, fakeApi, page } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const DEAL = {
  id: 'd1',
  title: 'Platform rebuild',
  company: { id: 'c1', name: 'Acme SA' },
  stage: 'proposal',
  amountCents: 10_000_000,
  currency: 'CHF',
  entity: 'welld_ch',
  expectedCloseDate: '2026-12-15',
  owner: ADA,
  closedAt: null,
  updatedAt: '2026-10-30T10:00:00.000Z',
  lostReason: null,
  notes: null,
  version: 4,
  createdAt: '2026-10-01T10:00:00.000Z',
  estimateState: null,
  estimateOverridden: false,
  estimate: null,
  estimateOverride: null,
}

const PIPELINE = {
  probabilities: { lead: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 },
  year: 2026,
  stages: [],
}

let dealGets = 0

const renderDeal = async (scope: string[], extra: Record<string, FakeHandler> = {}) => {
  dealGets = 0
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: { deal: scope, canErase: false, financials: true, managesAll: false },
      }),
      'GET /deals/d1': () => {
        dealGets += 1
        return { status: 200, body: DEAL }
      },
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

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DealDetailPage', () => {
  it('shows the amount and the weighted amount at the stage probability', async () => {
    await renderDeal(['welld_ch'])
    const facts = screen.getByTestId('crm-deal-facts')
    expect(facts.textContent).toContain('CHF 100,000.00')
    expect(facts.textContent).toContain('Weighted (50%)')
    expect(facts.textContent).toContain('CHF 50,000.00')
  })

  it('the stage dialog explains the chosen stage and its win probability', async () => {
    await renderDeal(['welld_ch'])
    fireEvent.click(screen.getByTestId('crm-deal-move'))
    const dialog = await screen.findByRole('dialog', { name: 'Move to stage' })
    expect(dialog.textContent).toContain(
      'The estimate is ready; the offer is being written or revised. Win probability 50%.',
    )
    fireEvent.change(within(dialog).getByLabelText('Stage'), { target: { value: 'negotiation' } })
    expect(dialog.textContent).toContain(
      'The client has the offer: waiting for an answer or agreeing changes. Win probability 75%.',
    )
  })

  it('outside the entity scope the deal is read-only (AC-3.5)', async () => {
    await renderDeal(['welld_it'])
    expect(screen.queryByTestId('crm-deal-move')).toBeNull()
    expect(screen.queryByTestId('crm-deal-edit')).toBeNull()
    expect(screen.getByText(/You can see this deal but not change it/)).not.toBeNull()
  })

  describe('Delivery card (specs/022 AC-3.4)', () => {
    const withDelivery = (extra: Record<string, unknown>): Record<string, FakeHandler> => ({
      'GET /deals/d1': () => ({ status: 200, body: { ...DEAL, stage: 'won', ...extra } }),
    })

    it('shows the project and the Bexio order id of a deal that feeds a project, read-only', async () => {
      await renderDeal(
        ['welld_ch'],
        withDelivery({
          delivery: { project: { id: 'p1', name: 'Platform rebuild — delivery' }, bexioOrderId: 'AB-2026-0042' },
          deliveryKnown: true,
        }),
      )
      const card = screen.getByTestId('crm-delivery-card')
      expect(card.textContent).toContain('Platform rebuild — delivery')
      expect(card.textContent).toContain('AB-2026-0042')
      expect(within(card).queryByRole('button')).toBeNull()
      expect(within(card).queryByRole('textbox')).toBeNull()
    })

    it('shows "—" for a contract without a Bexio order id', async () => {
      await renderDeal(
        ['welld_ch'],
        withDelivery({
          delivery: { project: { id: 'p1', name: 'Platform rebuild — delivery' }, bexioOrderId: null },
          deliveryKnown: true,
        }),
      )
      expect(screen.getByTestId('crm-delivery-facts').textContent).toContain('—')
    })

    it('has no card for a deal no project carries', async () => {
      await renderDeal(['welld_ch'], withDelivery({ delivery: null, deliveryKnown: true }))
      expect(screen.queryByTestId('crm-delivery-card')).toBeNull()
    })

    it('says the delivery side is unavailable when projects-api did not answer, and the deal still shows', async () => {
      await renderDeal(['welld_ch'], withDelivery({ delivery: null, deliveryKnown: false }))
      expect(screen.getByTestId('crm-delivery-unavailable').textContent).toMatch(/unavailable/i)
      expect(screen.getByTestId('crm-deal-facts')).not.toBeNull()
    })

    it('keeps the card after a write, whose answer carries no delivery', async () => {
      await renderDeal(['welld_ch'], {
        ...withDelivery({
          delivery: { project: { id: 'p1', name: 'Platform rebuild — delivery' }, bexioOrderId: 'AB-2026-0042' },
          deliveryKnown: true,
        }),
        'POST /deals/d1/stage': () => ({ status: 200, body: { ...DEAL, stage: 'negotiation', version: 5 } }),
      })
      fireEvent.click(screen.getByTestId('crm-deal-move'))
      const dialog = await screen.findByRole('dialog', { name: 'Move to stage' })
      fireEvent.change(within(dialog).getByLabelText('Stage'), { target: { value: 'negotiation' } })
      fireEvent.click(within(dialog).getByTestId('crm-stage-dialog-submit'))
      await screen.findByTestId('crm-saved')
      expect(screen.getByTestId('crm-delivery-card').textContent).toContain('AB-2026-0042')
    })
  })

  it('a stale move shows the reload banner, and Reload fetches the deal again', async () => {
    let ifMatch: string | null = null
    await renderDeal(['welld_ch'], {
      'POST /deals/d1/stage': (_url, init) => {
        ifMatch = (init?.headers as Record<string, string>)['If-Match'] ?? null
        return { status: 409, body: { status: 409, title: 'Conflict', code: 'version_conflict', currentVersion: 5 } }
      },
    })
    fireEvent.click(screen.getByTestId('crm-deal-move'))
    const dialog = await screen.findByRole('dialog', { name: 'Move to stage' })
    fireEvent.change(within(dialog).getByLabelText('Stage'), { target: { value: 'won' } })
    fireEvent.click(within(dialog).getByTestId('crm-stage-dialog-submit'))
    expect(await screen.findByTestId('crm-stale-write')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(ifMatch).toBe('"4"')
    fireEvent.click(screen.getByTestId('crm-stale-write-reload'))
    await screen.findByRole('heading', { level: 2, name: 'Platform rebuild' })
    expect(dealGets).toBe(2)
  })
})
