/**
 * @vitest-environment jsdom
 *
 * What a refused Generate says on the letterhead service path (specs/20261116-letterhead-service T33; design F13, § Copy
 * keys; AC-10.6, AC-10.8, AC-10.13): 503 `layout_service_unavailable` and 409 `letterhead_not_configured` (and
 * `letterhead_overflow`) each have their words, in the Preview step's danger banner; the link to Letterheads is only for
 * a holder of access; nothing is created and Generate stays available. Real router, shell and wizard, fake API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { resetManageableLegalEntities } from '../hooks/useCanManageLegalEntity'
import { sampleAnswers } from '../lib/offerEngine/answers'
import { parseTemplate } from '../lib/offerEngine/syntax'
import { en, it as italian, strings } from '../strings'
import { ADA, draftView, fakeApi, offerDraftServer, page, problemAnswer, type FakeDraftServer } from '../test-support/fakeApi'

const { apiFetch, session } = vi.hoisted(() => ({ apiFetch: vi.fn(), session: { apps: [] as string[] } }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
  usePermissions: () => ({ epoch: 0, apps: session.apps, roles: [], departments: [], permissions: [] }),
}))
vi.mock('shell/extensions', () => ({ HostExtension: () => null }))

const t = strings.offerWizard

const SOURCE = `@@salutation Dear

## SCOPE
@@step scope
We deliver [OGGETTO].

@@field OGGETTO
label: Object
`
const COMPLETE = sampleAnswers(parseTemplate(SOURCE).ast, 'it')

const CONTEXT = {
  dealTitle: 'Platform rebuild',
  currency: 'CHF',
  dealAmountCents: 10_000_000,
  issuerLegalName: 'WellD Sagl',
  issuerAddressLines: ['Via Nassa 1'],
  letterhead: true,
  placeOfIssue: 'Lugano',
  clientLines: { it: ['Acme SA'], en: ['Acme SA'] },
  contacts: [],
  attachments: [],
  estimate: { state: 'ready', manDays: 10, manDaysAi: 8, epics: [], phases: [], timeline: { it: '', en: '' }, releases: [], annex: null },
  latestOffer: null,
  today: '2026-11-15',
}

const DEAL = {
  id: 'd1',
  title: 'Platform rebuild',
  company: { id: 'c1', name: 'Acme SA' },
  stage: 'qualified',
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

const TEMPLATE = {
  id: 't1',
  entity: 'welld_ch',
  name: 'Progetto a corpo',
  language: 'it',
  format: 'wizard',
  description: '',
  uses: [],
  source: SOURCE,
  seeded: false,
  showTotal: true,
  annex: false,
  version: 1,
  archived: false,
  updatedBy: ADA,
  updatedAt: '2026-11-15T08:00:00.000Z',
  createdAt: '2026-11-15T08:00:00.000Z',
}

const PAGES = {
  letterheadVersion: 3,
  pageCount: 1,
  missingPlaceholders: [],
  unprintableCharacters: 0,
  pages: [{ n: 1, image: 'AAAA', text: 'Offerta' }],
  missingFields: [],
}

let server: FakeDraftServer
const requests = () =>
  apiFetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)

async function mount(manages: string[] = []) {
  const made = offerDraftServer(draftView({ answers: COMPLETE }))
  server = made.server
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: { deal: ['welld_ch'], canErase: false, financials: true, managesAll: false, letterheadService: true },
      }),
      'GET /deals/d1': () => ({ status: 200, body: DEAL }),
      'GET /pipeline': () => ({ status: 200, body: { probabilities: {}, year: 2026, stages: [] } }),
      'GET /activities': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/offer-wizard/context': () => ({ status: 200, body: CONTEXT }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [TEMPLATE] } }),
      'GET /offer-templates/t1': () => ({ status: 200, body: TEMPLATE }),
      'GET /legal-entities/manageable': () => ({ status: 200, body: { entities: manages } }),
      'POST /deals/d1/offer-draft/preview': () => ({ status: 200, body: PAGES }),
      ...made.routes,
    }),
  )
  window.history.pushState(null, '', '/deals/d1/offer?step=preview')
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  return within(await screen.findByTestId('offer-wizard-action-bar')).findByRole('button', { name: t.bar.generate })
}

function matchMedia(wide: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

beforeEach(() => {
  resetManageableLegalEntities()
  window.scrollTo = () => undefined
  matchMedia(true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  apiFetch.mockReset()
  session.apps = []
})

const generating = (): string[] => requests().filter((request) => request.endsWith('/generate'))

describe('a Generate the layout service could not make (AC-10.6)', () => {
  it('says the service is not available, that nothing was created, and offers Retry', async () => {
    const generate = await mount()
    server.failNext('POST generate', problemAnswer(503, 'layout_service_unavailable'))
    fireEvent.click(generate)

    const banner = await screen.findByTestId('crm-offer-wizard-failure')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain(t.generate.layoutUnavailable.title)
    expect(banner.textContent).toContain(t.generate.layoutUnavailable.body)
    // in the person's language, never the server's own constant line
    expect(banner.textContent).not.toContain('detail of layout_service_unavailable')
    expect(window.location.pathname).toBe('/deals/d1/offer')

    // Retry asks again and the second answer is the offer
    fireEvent.click(within(banner).getByRole('button', { name: t.generate.fail.retryAction }))
    await waitFor(() => expect(generating()).toHaveLength(2))
    await waitFor(() => expect(window.location.pathname).toBe('/deals/d1'))
  })

  it('keeps Generate available and the draft as it was', async () => {
    const generate = await mount()
    const before = JSON.stringify(server.draft)
    server.failNext('POST generate', problemAnswer(503, 'layout_service_unavailable', { reason: 'busy' }))
    fireEvent.click(generate)
    await screen.findByTestId('crm-offer-wizard-failure')
    expect(generate.getAttribute('aria-disabled')).toBeNull()
    expect(JSON.stringify(server.draft)).toBe(before)
  })
})

describe('a Generate for an entity with no letterhead (AC-10.8)', () => {
  const refuse = () => server.failNext('POST generate', problemAnswer(409, 'letterhead_not_configured', { entity: 'welld_ch' }))

  it('names the entity, says no offer was created, and points a holder of access to Letterheads', async () => {
    session.apps = ['crm', 'letterheads']
    const generate = await mount()
    refuse()
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-letterhead-not-configured')
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toContain(t.letterhead.notConfigured.title('wellD CH'))
    expect(notice.textContent).toContain(t.letterhead.notConfigured.generate)
    expect(within(notice).getByRole('link', { name: t.letterhead.open }).getAttribute('href')).toBe(
      '/letterheads?entity=welld_ch',
    )
    // no PDF with a plain header is ever offered: the page stays and Generate can be tried again
    expect(window.location.pathname).toBe('/deals/d1/offer')
    expect(generate.getAttribute('aria-disabled')).toBeNull()
  })

  it('shows no link to a person without access, and tells them whom to ask', async () => {
    session.apps = ['crm']
    const generate = await mount()
    refuse()
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-letterhead-not-configured')
    expect(within(notice).queryByRole('link')).toBeNull()
    expect(notice.textContent).toContain(t.letterhead.askAdmin)
  })

  it('goes away with the next Generate, which may now succeed', async () => {
    const generate = await mount()
    refuse()
    fireEvent.click(generate)
    await screen.findByTestId('crm-wizard-letterhead-not-configured')
    fireEvent.click(generate)
    await waitFor(() => expect(window.location.pathname).toBe('/deals/d1'))
  })

  it('names the frame of a value that does not fit the letterhead', async () => {
    session.apps = ['crm']
    const generate = await mount()
    server.failNext('POST generate', problemAnswer(409, 'letterhead_overflow', { frame: 'footer', entity: 'welld_ch' }))
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-letterhead-overflow')
    expect(notice.textContent).toContain(t.letterhead.overflow.title('wellD CH', t.letterhead.overflow.footer))
    expect(notice.textContent).toContain(t.letterhead.overflow.bodyAskAdmin)
    expect(within(notice).queryByRole('link')).toBeNull()
  })

  it('points a manager of the entity at Legal entities, and a holder of Letterheads at both (FU-1)', async () => {
    session.apps = ['crm', 'letterheads']
    const generate = await mount(['welld_ch'])
    server.failNext('POST generate', problemAnswer(409, 'letterhead_overflow', { frame: 'header', entity: 'welld_ch' }))
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-letterhead-overflow')
    const legal = await within(notice).findByRole('link', { name: t.legalEntity.openNamed('wellD CH') })
    expect(legal.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    expect(notice.textContent).toContain(t.letterhead.overflow.body)
    expect(within(notice).getByRole('link', { name: t.letterhead.open }).getAttribute('href')).toBe(
      '/letterheads?entity=welld_ch',
    )
  })
})

describe('the same words in English and in Italian (AC-10.13)', () => {
  it('has the layout-unavailable and letterhead keys in both catalogs, translated', () => {
    for (const key of ['title', 'body'] as const) {
      expect(en.offerWizard.generate.layoutUnavailable[key]).not.toBe('')
      expect(italian.offerWizard.generate.layoutUnavailable[key]).not.toBe('')
      expect(italian.offerWizard.generate.layoutUnavailable[key]).not.toBe(en.offerWizard.generate.layoutUnavailable[key])
    }
    expect(italian.offerWizard.letterhead.notConfigured.generate).not.toBe(en.offerWizard.letterhead.notConfigured.generate)
  })
})
