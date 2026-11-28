/**
 * @vitest-environment jsdom
 *
 * Record hours on the deal page (specs/20261116-record-hours-in-place AC-2.1, AC-2.2, AC-4.5; ADR
 * 20261116-record-hours-widget-through-the-host-extension-seam). The deal's owner and the technical contact of its estimate
 * get hours-ui's widget as the FIRST item of the page header's actions — also when they cannot manage the deal;
 * everyone else who can read the deal gets none. With the hours screens unavailable the page works and shows the
 * host's link to My hours where the button would be. Hours-api decides every save, so none of this is a permission.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { ADA, fakeApi, page } from '../test-support/fakeApi'

const { apiFetch, session, seam } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  session: { id: undefined as string | undefined },
  // 'widget': the seam answers with a panel; 'stub': the test-only `shell/extensions` stub, a shell with no remote behind it.
  seam: { mode: 'widget' as 'widget' | 'stub' },
}))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: session.id === undefined ? null : { user: { id: session.id } } }),
}))

type SeamCall = { name: string; props: unknown }
const calls: SeamCall[] = []
// Each extension the deal page embeds gets its own test id: Record hours (the header), the Meetings panel and the
// Hours card's panel (specs/20261112-project-hours).
const PANEL_TEST_IDS: Record<string, string> = {
  'hours.recordHours': 'host-record-hours',
  'hours.hostHours': 'host-hours-panel',
  'meetings.hostMeetings': 'host-meetings-panel',
}
vi.mock('shell/extensions', async (importOriginal) => {
  const stub = await importOriginal<typeof import('shell/extensions')>()
  return {
    HostExtension: (host: { name: string; props: unknown; fallback: ReactNode; loading?: ReactNode }) => {
      calls.push({ name: host.name, props: host.props })
      if (seam.mode === 'stub') return createElement(stub.HostExtension as never, host as never)
      return createElement('section', { 'data-testid': PANEL_TEST_IDS[host.name] ?? 'host-meetings-panel' })
    },
  }
})

const GRACE = { id: 'u-grace', name: 'Grace Hopper', status: 'active' as const }

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

const DEAL_WITH_ESTIMATE = {
  ...DEAL,
  estimateState: 'requested',
  estimate: {
    estimateId: 'e1',
    name: 'Platform rebuild estimate',
    technical: GRACE,
    state: 'requested',
    requestedBy: ADA,
    requestedAt: '2026-10-20T10:00:00.000Z',
    readyAt: null,
  },
}

const PIPELINE = {
  probabilities: { lead: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 },
  year: 2026,
  stages: [],
}

/** `me`: the session's user id; `scope`: the entities the caller manages deals for. */
const renderDeal = async ({
  me,
  scope,
  deal = DEAL,
}: {
  me: string | undefined
  scope: string[]
  deal?: Record<string, unknown>
}) => {
  session.id = me
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: { deal: scope, canErase: false, financials: true, managesAll: false },
      }),
      'GET /deals/d1': () => ({ status: 200, body: deal }),
      'GET /pipeline': () => ({ status: 200, body: PIPELINE }),
      'GET /activities': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [] } }),
    }),
  )
  window.history.pushState(null, '', '/deals/d1')
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  await screen.findByRole('heading', { level: 2, name: 'Platform rebuild' })
}

const hoursCalls = () => calls.filter((call) => call.name === 'hours.recordHours')

/** The deal page's other host extension settles through the same dynamic import: once it shows, the seam is loaded. */
const seamLoaded = () => screen.findByTestId('host-meetings-panel')

const pageActions = () => document.querySelector('.page-actions')

beforeEach(() => {
  window.scrollTo = () => undefined
  calls.length = 0
  seam.mode = 'widget'
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Record hours on the deal page', () => {
  it('offers the owner hours-ui’s widget with the deal’s id and title as the page’s action (AC-2.1)', async () => {
    await renderDeal({ me: ADA.id, scope: ['welld_ch'] })
    await screen.findByTestId('host-record-hours')

    expect(hoursCalls()).toEqual([
      {
        name: 'hours.recordHours',
        props: {
          on: 'deal',
          targetId: 'd1',
          targetName: 'Platform rebuild',
          activityId: '',
          activityName: '',
          placement: 'page',
        },
      },
    ])
  })

  it('puts it first in the header, ahead of Edit and Move to stage (design S1)', async () => {
    await renderDeal({ me: ADA.id, scope: ['welld_ch'] })
    const widget = await screen.findByTestId('host-record-hours')
    const actions = pageActions() as HTMLElement
    expect(actions.firstElementChild).toBe(widget)
    expect(within(actions).getByTestId('crm-deal-edit')).not.toBeNull()
    expect(within(actions).getByTestId('crm-deal-move')).not.toBeNull()
  })

  it('offers it to the owner who cannot manage the deal: the header holds only Record hours (AC-2.1)', async () => {
    await renderDeal({ me: ADA.id, scope: ['welld_it'] })
    const widget = await screen.findByTestId('host-record-hours')
    const actions = pageActions() as HTMLElement
    expect(actions.children).toHaveLength(1)
    expect(actions.firstElementChild).toBe(widget)
    expect(screen.queryByTestId('crm-deal-edit')).toBeNull()
    expect(screen.queryByTestId('crm-deal-move')).toBeNull()
  })

  it('offers it to the technical contact of the deal’s estimate (AC-2.1)', async () => {
    await renderDeal({ me: GRACE.id, scope: ['welld_it'], deal: DEAL_WITH_ESTIMATE })
    await screen.findByTestId('host-record-hours')
    expect(hoursCalls()).toHaveLength(1)
  })

  it('offers nothing to a reader who is neither owner nor technical contact, and leaves no empty header slot (AC-2.2)', async () => {
    await renderDeal({ me: 'u-reader', scope: ['welld_it'], deal: DEAL_WITH_ESTIMATE })
    await seamLoaded()
    expect(hoursCalls()).toEqual([])
    expect(screen.queryByTestId('host-record-hours')).toBeNull()
    expect(screen.queryByTestId('crm-record-hours-fallback')).toBeNull()
    expect(pageActions()).toBeNull()
  })

  it('offers nothing to a manager of the deal who is not its owner: managing is not recording (AC-2.2)', async () => {
    await renderDeal({ me: 'u-manager', scope: ['welld_ch'] })
    await seamLoaded()
    expect(hoursCalls()).toEqual([])
    expect(screen.getByTestId('crm-deal-edit')).not.toBeNull()
  })

  it('offers nothing to the person who requested the estimate but is neither owner nor technical contact (AC-2.2)', async () => {
    const requestedByOther = {
      ...DEAL_WITH_ESTIMATE,
      owner: GRACE,
      estimate: { ...DEAL_WITH_ESTIMATE.estimate, technical: { ...GRACE, id: 'u-tech' }, requestedBy: ADA },
    }
    await renderDeal({ me: ADA.id, scope: ['welld_it'], deal: requestedByOther })
    await seamLoaded()
    expect(hoursCalls()).toEqual([])
  })

  it('offers nothing before the session has given the person’s id', async () => {
    await renderDeal({ me: undefined, scope: ['welld_ch'] })
    await seamLoaded()
    expect(hoursCalls()).toEqual([])
  })

  it('with the hours screens unavailable the page works and shows the link to My hours where the button would be (AC-4.5)', async () => {
    seam.mode = 'stub'
    await renderDeal({ me: ADA.id, scope: ['welld_ch'] })

    const link = await screen.findByTestId('crm-record-hours-fallback')
    expect(link.textContent).toBe('Record hours in My hours')
    expect(link.getAttribute('href')).toBe('/hours')
    expect(pageActions()?.firstElementChild).toBe(link.closest('[data-testid="stub-host-extension"]'))

    // the page itself is untouched: the deal's facts, its Edit action, its timeline
    expect(screen.getByTestId('crm-deal-facts').textContent).toContain('CHF 100,000.00')
    expect(screen.getByTestId('crm-deal-edit')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'Activity' })).not.toBeNull()
  })

  it('shows no link to a reader even when the hours screens are unavailable (AC-4.5: only those who would have had the button)', async () => {
    seam.mode = 'stub'
    await renderDeal({ me: 'u-reader', scope: ['welld_it'] })
    await screen.findByText('Meetings are unavailable. Reload the page to try again.')
    expect(screen.queryByTestId('crm-record-hours-fallback')).toBeNull()
  })
})
