/**
 * @vitest-environment jsdom
 *
 * The wizard page on the service path (specs/20261116-letterhead-service T32; design F12, F13, § Which path the UI takes;
 * AC-10.3, AC-10.4, AC-10.7, AC-10.8): the path is chosen once from `letterheadService`; the service's pages replace the
 * browser-drawn ones in the pane and in the Drawer; the unsaved draft is what is asked; a failure keeps the pages and
 * leaves the wizard usable. Real router, shell and wizard, fake API.
 */
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CrmShell from '../CrmShell'
import { resetManageableLegalEntities } from '../../hooks/useCanManageLegalEntity'
import { initialAnswers, sampleContext } from '../../lib/offerEngine/answers'
import { parseTemplate } from '../../lib/offerEngine/syntax'
import { createAppRouter } from '../../router'
import { strings } from '../../strings'
import {
  ADA,
  draftView,
  fakeApi,
  offerDraftServer,
  page,
  problemAnswer,
  type FakeAnswer,
  type FakeHandler,
} from '../../test-support/fakeApi'

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
vi.mock('../../lib/letterhead/renderLetterhead', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/letterhead/renderLetterhead')>()),
  renderLetterhead: async () => new Blob(['png'], { type: 'image/png' }),
}))

const t = strings.offerWizard

const SOURCE = `@@salutation Dear

## SCOPE
@@step scope
We deliver [OGGETTO].

@@field OGGETTO
label: Object
`
const AST = parseTemplate(SOURCE).ast
const START = initialAnswers(AST, sampleContext('it'))

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

const WIZARD_TEMPLATE = {
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
  pageCount: 2,
  missingPlaceholders: [],
  unprintableCharacters: 0,
  pages: [
    { n: 1, image: 'AAAA', text: 'Offerta 0001/2026\nGentile cliente' },
    { n: 2, image: 'BBBB', text: 'Condizioni' },
  ],
  missingFields: [],
}

const PREVIEW = 'POST /deals/d1/offer-draft/preview'
const calls = () => apiFetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)
const previewBodies = () =>
  apiFetch.mock.calls
    .filter(([url, init]) => init?.method === 'POST' && new URL(String(url)).pathname.endsWith('/offer-draft/preview'))
    .map(([, init]) => JSON.parse(String(init?.body)) as { templateVersion: number; target: unknown; answers: Record<string, unknown> })

async function mount({
  service,
  preview = () => ({ status: 200, body: PAGES }),
  search = '?step=client',
  manages = [],
}: {
  service: boolean | undefined
  preview?: FakeHandler
  search?: string
  /** The entities `auth` says the person may manage. */
  manages?: string[]
}) {
  const made = offerDraftServer(draftView({ answers: START }))
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: {
          deal: ['welld_ch'],
          canErase: false,
          financials: true,
          managesAll: false,
          ...(service === undefined ? {} : { letterheadService: service }),
        },
      }),
      'GET /deals/d1': () => ({ status: 200, body: DEAL }),
      'GET /pipeline': () => ({ status: 200, body: { probabilities: {}, year: 2026, stages: [] } }),
      'GET /activities': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/offer-wizard/context': () => ({ status: 200, body: CONTEXT }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [WIZARD_TEMPLATE] } }),
      'GET /offer-templates/t1': () => ({ status: 200, body: WIZARD_TEMPLATE }),
      'GET /legal-entities/manageable': () => ({ status: 200, body: { entities: manages } }),
      ...made.routes,
      [PREVIEW]: preview,
    }),
  )
  window.history.pushState(null, '', `/deals/d1/offer${search}`)
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  return made.server
}

function matchMedia(wide: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

const tab = (name: string) => screen.findByRole('tab', { name: new RegExp(name) })

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

describe('the path is chosen once, from letterheadService (design § Which path the UI takes)', () => {
  it('on: the service\'s pages are in the pane, asked for the unsaved draft, and the browser-drawn letterhead is not fetched', async () => {
    await mount({ service: true })
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))
    expect(within(region).getByRole('img', { name: 'Page 1 of 2' })).toBeTruthy()
    expect(region.querySelector('figcaption')!.textContent).toBe('Offerta 0001/2026\nGentile cliente')
    expect(region.querySelector('figcaption')!.getAttribute('lang')).toBe('it')

    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
    expect(screen.queryByTestId('crm-wizard-letterhead-band')).toBeNull()
    expect(calls().filter((call) => call.includes('letterhead'))).toEqual([])

    // the body is the draft PUT's: the answers as they are, never a saved copy, and no `If-Match` (nothing is stored)
    const [body] = previewBodies()
    expect(body).toMatchObject({ templateVersion: 1, target: { kind: 'new' }, answers: { ...START, lastStep: 'client' } })
    const [, init] = apiFetch.mock.calls.find(([, call]) => call?.method === 'POST' && String(call.body).includes('templateVersion'))!
    expect(Object.keys((init as RequestInit).headers as Record<string, string>)).toEqual(['Content-Type'])
  })

  it.each([
    ['false', false],
    ['absent (an older crm-api during a rolling deploy)', undefined],
  ])('%s: the browser-drawn preview, its letterhead attempt and no request for the service', async (_name, service) => {
    await mount({ service })
    expect(await screen.findByTestId('crm-wizard-preview')).toBeTruthy()
    expect(screen.queryByTestId('crm-wizard-service-preview')).toBeNull()
    await waitFor(() => expect(calls().some((call) => call.includes('letterhead'))).toBe(true))
    expect(calls()).not.toContain(PREVIEW)
  })

  it('shows no service pane before the capabilities are known: the shell waits for them', async () => {
    await mount({ service: true })
    // the old pane never mounted, not even for a frame, since the shell renders nothing until `GET /scope` answers
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
    await screen.findByTestId('crm-wizard-service-preview')
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
  })

  it('does not ask for a preview on the Template step, only from the next one', async () => {
    await mount({ service: true, search: '?step=template' })
    await tab(t.steps.template)
    expect(await screen.findByTestId('crm-wizard-service-preview')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(calls()).not.toContain(PREVIEW)
    fireEvent.click(await tab(t.steps.client))
    await waitFor(() => expect(calls()).toContain(PREVIEW))
  })

  it('does not ask again when only the step changes', async () => {
    await mount({ service: true })
    await waitFor(() => expect(previewBodies()).toHaveLength(1))
    fireEvent.click(await tab(t.steps.scope))
    fireEvent.click(await tab(t.steps.preview))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(previewBodies()).toHaveLength(1)
  })
})

describe('below xl the pages are in the Drawer (design F12.2)', () => {
  beforeEach(() => matchMedia(false))

  it('asks nothing until the Drawer first opens, keeps the answer when it closes, and opens on it at once', async () => {
    const user = userEvent.setup()
    await mount({ service: true })
    await tab(t.steps.client)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(calls()).not.toContain(PREVIEW)

    await user.click(screen.getByRole('button', { name: t.bar.preview }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getAllByRole('figure')).toHaveLength(2))
    expect(previewBodies()).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: strings.common.close }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByRole('button', { name: t.bar.preview }))
    // the last answer is there on the first paint of the reopened Drawer, and nothing was asked for nothing
    expect(within(await screen.findByRole('dialog')).getAllByRole('figure')).toHaveLength(2)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(previewBodies()).toHaveLength(1)
  })
})

describe('when the preview cannot be made (AC-10.7, AC-10.8)', () => {
  it('keeps the wizard usable: a polite notice, no dialog, Try again, and Next still works', async () => {
    const user = userEvent.setup()
    let fail = false
    await mount({
      service: true,
      preview: () => (fail ? problemAnswer(503, 'layout_service_unavailable') : { status: 200, body: PAGES }),
    })
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))

    fail = true
    fireEvent.click(await tab(t.steps.scope))
    await user.type(await screen.findByRole('textbox'), 'Website')
    const notice = await screen.findByTestId('crm-wizard-service-preview-failed')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain(t.servicePreview.failedBody)
    expect(within(region).getAllByRole('figure')).toHaveLength(2) // the last pages stay
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Website') // typing was never blocked

    fail = false
    await user.click(within(notice).getByRole('button', { name: t.servicePreview.retry }))
    await waitFor(() => expect(screen.queryByTestId('crm-wizard-service-preview-failed')).toBeNull())
    expect(within(region).getAllByRole('figure')).toHaveLength(2)
  })

  it('tells there is no letterhead, with the link only for a holder of access to Letterheads', async () => {
    session.apps = ['crm', 'letterheads']
    await mount({ service: true, preview: () => problemAnswer(409, 'letterhead_not_configured', { entity: 'welld_ch' }) })
    const notice = await screen.findByTestId('crm-wizard-letterhead-not-configured')
    expect(notice.textContent).toContain(t.letterhead.notConfigured.title('wellD CH'))
    expect(within(notice).getByRole('link', { name: t.letterhead.open }).getAttribute('href')).toBe(
      '/letterheads?entity=welld_ch',
    )
    expect(screen.getByTestId('page-preview-placeholder')).toBeTruthy()
  })

  it('shows no link to a person without access, and names the frame of an overflow', async () => {
    session.apps = ['crm']
    await mount({
      service: true,
      preview: (): FakeAnswer => problemAnswer(409, 'letterhead_overflow', { frame: 'footer', entity: 'welld_ch' }),
    })
    const notice = await screen.findByTestId('crm-wizard-letterhead-overflow')
    expect(notice.textContent).toContain(t.letterhead.overflow.title('wellD CH', t.letterhead.overflow.footer))
    expect(notice.textContent).toContain(t.letterhead.overflow.bodyAskAdmin)
    expect(within(notice).queryByRole('link')).toBeNull()
  })

  it('points a manager of the entity without Letterheads at Legal entities only, with the value-only body (FU-1)', async () => {
    session.apps = ['crm']
    await mount({
      service: true,
      manages: ['welld_ch'],
      preview: (): FakeAnswer => problemAnswer(409, 'letterhead_overflow', { frame: 'header', entity: 'welld_ch' }),
    })
    const notice = await screen.findByTestId('crm-wizard-letterhead-overflow')
    const link = await within(notice).findByRole('link', { name: t.legalEntity.openNamed('wellD CH') })
    expect(link.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    expect(within(notice).getAllByRole('link')).toHaveLength(1)
    expect(notice.textContent).toContain(t.letterhead.overflow.bodyValueOnly)
  })

  it('names the section that is too long (T50), keeps the last pages, shows no dialog and no retry, and follows the next change', async () => {
    const user = userEvent.setup()
    let tooLong = false
    await mount({
      service: true,
      preview: () =>
        tooLong
          ? problemAnswer(422, 'section_too_long', { sections: [{ name: 'section:SCOPE#0', label: 'SCOPE' }] })
          : { status: 200, body: PAGES },
    })
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))

    tooLong = true
    fireEvent.click(await tab(t.steps.scope))
    await user.type(await screen.findByRole('textbox'), 'Website')
    const notice = await screen.findByTestId('crm-wizard-service-preview-too-long')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toBe(t.servicePreview.sectionTooLong(['SCOPE']))
    expect(notice.textContent).toContain('“SCOPE”')
    expect(within(notice).queryByRole('button')).toBeNull()
    expect(within(region).getAllByRole('figure')).toHaveLength(2) // the last pages stay
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Website')

    tooLong = false
    await user.type(screen.getByRole('textbox'), '!')
    await waitFor(() => expect(screen.queryByTestId('crm-wizard-service-preview-too-long')).toBeNull())
  })

  it.each([
    ['legal_entity_incomplete', 409, 'crm-wizard-legal-entity-incomplete'],
    ['answers_invalid', 422, 'crm-wizard-service-preview-invalid'],
  ])('tells a %s politely, without a retry button', async (code, status, testId) => {
    await mount({
      service: true,
      preview: () => problemAnswer(status, code, code === 'legal_entity_incomplete' ? { entity: 'welld_ch', missing: ['iban'] } : {}),
    })
    const notice = await screen.findByTestId(testId)
    expect(notice.getAttribute('role')).toBe('status')
    expect(within(notice).queryByRole('button')).toBeNull()
  })
})
