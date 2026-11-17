/**
 * @vitest-environment jsdom
 *
 * What a refused Generate says when the registry of the issuer's legal details refuses or cannot be read
 * (specs/20261117-legal-entities T31; design S10, F13; AC-5.5, AC-6.2, AC-6.3, AC-8.2): 409 `legal_entity_incomplete` is a
 * danger notice naming the entity and the missing details, with a link to the Legal entities page for a person who may
 * manage that entity and a sentence for everyone else; 503 `legal_entities_unavailable` is a notice with Retry (also when it
 * is the wizard's context that cannot be read). Nothing is created and Generate stays available. Real router, shell and
 * wizard, fake API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { sampleAnswers } from '../lib/offerEngine/answers'
import { parseTemplate } from '../lib/offerEngine/syntax'
import { resetManageableLegalEntities } from '../hooks/useCanManageLegalEntity'
import { strings } from '../strings'
import {
  ADA,
  draftView,
  fakeApi,
  offerDraftServer,
  page,
  problemAnswer,
  type FakeAnswer,
  type FakeDraftServer,
} from '../test-support/fakeApi'

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

async function mount({ manages = [] as string[], context = (): FakeAnswer => ({ status: 200, body: CONTEXT }) } = {}) {
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
      'GET /deals/d1/offer-wizard/context': context,
      'GET /legal-entities/manageable': () => ({ status: 200, body: { entities: manages } }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [TEMPLATE] } }),
      'GET /offer-templates/t1': () => ({ status: 200, body: TEMPLATE }),
      'POST /deals/d1/offer-draft/preview': () => ({ status: 200, body: PAGES }),
      ...made.routes,
    }),
  )
  window.history.pushState(null, '', '/deals/d1/offer?step=preview')
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
}

const generateButton = async () =>
  within(await screen.findByTestId('offer-wizard-action-bar')).findByRole('button', { name: t.bar.generate })

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
const incomplete = (extras: Record<string, unknown> = { entity: 'welld_ch', missing: ['vatNumber', 'address.en'] }) =>
  problemAnswer(409, 'legal_entity_incomplete', extras)
const unavailable = (): FakeAnswer => ({
  ...problemAnswer(503, 'legal_entities_unavailable'),
  headers: { 'Retry-After': '5' },
})

describe('a Generate for an entity whose legal details are incomplete (AC-6.3)', () => {
  it('names the entity and the missing details, says no offer was created, and links a manager to the entity’s tab', async () => {
    await mount({ manages: ['welld_ch'] })
    const generate = await generateButton()
    server.failNext('POST generate', incomplete())
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toContain(t.legalEntity.incomplete.title('wellD CH'))
    expect(notice.textContent).toContain(t.legalEntity.incomplete.noOffer)
    expect(notice.textContent).toContain(t.legalEntity.incomplete.missing('VAT number, Address (English)'))
    // in the person's language, never the server's own constant line
    expect(notice.textContent).not.toContain('detail of legal_entity_incomplete')
    const link = await within(notice).findByRole('link', { name: t.legalEntity.openNamed('wellD CH') })
    expect(link.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    // nothing was created: the page stays, Generate can be tried again
    expect(window.location.pathname).toBe('/deals/d1/offer')
    expect(generate.getAttribute('aria-disabled')).toBeNull()
  })

  it('tells everyone else to ask an administrator, with no link', async () => {
    await mount({ manages: ['welld_it'] })
    const generate = await generateButton()
    server.failNext('POST generate', incomplete())
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    expect(within(notice).queryByRole('link')).toBeNull()
    expect(notice.textContent).toContain(t.legalEntity.incomplete.askAdmin)
  })

  it('names the entity the refusal names, and the deal’s own for a body that names none we know', async () => {
    await mount({ manages: ['welld_it'] })
    const generate = await generateButton()
    server.failNext('POST generate', incomplete({ entity: 'welld_it', missing: ['legalName'] }))
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.textContent).toContain(t.legalEntity.incomplete.title('wellD IT'))
    expect((await within(notice).findByRole('link')).getAttribute('href')).toBe('/admin/legal-entities?entity=welld_it')
    server.failNext('POST generate', incomplete({ entity: 'welld_xx', missing: ['legalName'] }))
    fireEvent.click(generate)
    await waitFor(() =>
      expect(screen.getByTestId('crm-wizard-legal-entity-incomplete').textContent).toContain(
        t.legalEntity.incomplete.title('wellD CH'),
      ),
    )
  })

  it('goes away with the next Generate, which may now succeed once the details are filled in', async () => {
    await mount()
    const generate = await generateButton()
    server.failNext('POST generate', incomplete())
    fireEvent.click(generate)
    await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    fireEvent.click(generate)
    await waitFor(() => expect(window.location.pathname).toBe('/deals/d1'))
    expect(generating()).toHaveLength(2)
  })
})

describe('a Generate while the registry cannot be read (AC-5.5)', () => {
  it('says nothing was created and no number was used, and Retry asks again', async () => {
    await mount()
    const generate = await generateButton()
    server.failNext('POST generate', unavailable())
    fireEvent.click(generate)
    const notice = await screen.findByTestId('crm-wizard-legal-entity-unavailable')
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toContain(t.legalEntity.unavailable.title)
    expect(notice.textContent).toContain(t.legalEntity.unavailable.body)
    expect(notice.textContent).not.toContain('detail of legal_entities_unavailable')
    expect(window.location.pathname).toBe('/deals/d1/offer')
    fireEvent.click(within(notice).getByRole('button', { name: t.generate.fail.retryAction }))
    await waitFor(() => expect(generating()).toHaveLength(2))
    await waitFor(() => expect(window.location.pathname).toBe('/deals/d1'))
  })

  it('does not say the authorization service is unavailable when the wizard’s context cannot be read', async () => {
    let answers = 0
    await mount({ context: () => (++answers === 1 ? unavailable() : { status: 200, body: CONTEXT }) })
    const notice = await screen.findByTestId('crm-wizard-legal-entity-unavailable')
    expect(notice.textContent).toContain(t.legalEntity.unavailable.title)
    expect(screen.queryByTestId('crm-load-error')).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: t.generate.fail.retryAction }))
    expect(await generateButton()).toBeTruthy()
    expect(screen.queryByTestId('crm-wizard-legal-entity-unavailable')).toBeNull()
  })

  it('still says the authorization service is unavailable for a 503 that is not the registry’s', async () => {
    await mount({ context: () => problemAnswer(503, 'authorization_unavailable') })
    expect((await screen.findByTestId('crm-load-error')).textContent).toContain(strings.common.authUnavailable.heading)
  })
})
