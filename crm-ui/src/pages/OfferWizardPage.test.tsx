/**
 * @vitest-environment jsdom
 *
 * The offer wizard's page (specs/20261115-crm-offer-wizard T50; AC-1.6, AC-3.5, AC-6.1, AC-6.3, AC-8.4; design S1,
 * S9, S10; plan DD-41): no draft until a template is chosen, the draft's step on reopening, the conflict, gone and
 * template-changed states, a refused Generate, and a context built from the server's answer and the template's
 * language — never the browser's clock or the UI language. Real router and shell, fake API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { initialAnswers, sampleAnswers, sampleContext, setField } from '../lib/offerEngine/answers'
import { parseTemplate } from '../lib/offerEngine/syntax'
import { strings } from '../strings'
import {
  ADA,
  draftView,
  fakeApi,
  offerDraftServer,
  page,
  problemAnswer,
  sampleAnswersFixture,
  type FakeDraftServer,
  type FakeHandler,
} from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))
vi.mock('shell/extensions', () => ({ HostExtension: () => null }))
// the PDF renderer is a double here (its contract has its own tests)
vi.mock('../lib/letterhead/renderLetterhead', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/letterhead/renderLetterhead')>()),
  renderLetterhead: async () => new Blob(['png'], { type: 'image/png' }),
}))

const t = strings.offerWizard

const V1 = `@@salutation Dear

## SCOPE
@@step scope
We deliver [OGGETTO].

## TERMS
@@step conditions
Payment: [PAGAMENTO].

@@field OGGETTO
label: Object

@@field PAGAMENTO
label: Payment
`
const V2 = V1.replace('Payment: [PAGAMENTO].', 'Payment: net 30.').replace('@@field PAGAMENTO\nlabel: Payment\n', '')
const AST = parseTemplate(V1).ast

const CONTEXT = {
  dealTitle: 'Platform rebuild',
  currency: 'CHF',
  dealAmountCents: 10_000_000,
  issuerLegalName: 'WellD Sagl',
  issuerAddressLines: ['Via Nassa 1', '6900 Lugano'],
  letterhead: false,
  placeOfIssue: 'Lugano',
  clientLines: { it: ['Acme SA', 'Svizzera'], en: ['Acme SA', 'Switzerland'] },
  contacts: [],
  attachments: [],
  estimate: {
    state: 'ready',
    manDays: 10,
    manDaysAi: 8,
    epics: [],
    phases: [],
    timeline: { it: '', en: '' },
    releases: [],
    annex: null,
  },
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

const template = (source: string, version: number, overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  entity: 'welld_ch',
  name: 'Progetto a corpo',
  language: 'it',
  format: 'wizard',
  description: 'Sviluppo a prezzo fisso',
  uses: ['Sviluppo'],
  source,
  seeded: false,
  showTotal: true,
  annex: false,
  version,
  archived: false,
  updatedBy: ADA,
  updatedAt: '2026-11-15T08:00:00.000Z',
  createdAt: '2026-11-15T08:00:00.000Z',
  ...overrides,
})

const START = initialAnswers(AST, sampleContext('it'))
const COMPLETE = sampleAnswers(AST, 'it')

type Options = {
  draft?: ReturnType<typeof draftView> | null
  template?: ReturnType<typeof template>
  context?: Record<string, unknown>
  routes?: Record<string, FakeHandler>
  templates?: ReturnType<typeof template>[]
  search?: string
}

let server: FakeDraftServer
const requests = () =>
  apiFetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)

async function mount(options: Options = {}) {
  const wizardTemplate = options.template ?? template(V1, 1)
  const made = offerDraftServer(options.draft === undefined ? null : options.draft)
  server = made.server
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: { deal: ['welld_ch'], canErase: false, financials: true, managesAll: false },
      }),
      'GET /deals/d1': () => ({ status: 200, body: DEAL }),
      'GET /pipeline': () => ({ status: 200, body: { probabilities: {}, year: 2026, stages: [] } }),
      'GET /activities': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [] } }),
      'GET /deals/d1/offer-wizard/context': () => ({ status: 200, body: { ...CONTEXT, ...options.context } }),
      'GET /offer-templates': () => ({ status: 200, body: { items: options.templates ?? [wizardTemplate] } }),
      'GET /offer-templates/t1': () => ({ status: 200, body: wizardTemplate }),
      ...made.routes,
      ...options.routes,
    }),
  )
  window.history.pushState(null, '', `/deals/d1/offer${options.search ?? ''}`)
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
}

const tab = (name: string) => screen.findByRole('tab', { name: new RegExp(name) })

function matchMedia(wide: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

beforeEach(() => {
  window.scrollTo = () => undefined
  matchMedia(false)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  apiFetch.mockReset()
})

describe('OfferWizardPage — starting (AC-1.1, AC-6.1)', () => {
  it('opens on the Template step with no tabs and issues no write while there is no draft', async () => {
    await mount()
    expect(await screen.findByRole('button', { name: t.template.useOf('Progetto a corpo') })).not.toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: t.page.titleNew })).not.toBeNull()
    expect(requests().filter((request) => !request.startsWith('GET '))).toEqual([])
  })

  it('creates the draft when a template is chosen and lands on the Client step', async () => {
    await mount()
    fireEvent.click(await screen.findByRole('button', { name: t.template.useOf('Progetto a corpo') }))
    expect(await tab(t.steps.client)).not.toBeNull()
    expect(requests()).toContain('POST /deals/d1/offer-draft')
    expect(server.draft?.template.id).toBe('t1')
    expect(window.location.search).toContain('step=client')
    expect((await screen.findByRole('tab', { name: new RegExp(t.steps.client) })).getAttribute('aria-selected')).toBe(
      'true',
    )
  })

  it('opens the draft someone else started when the create finds one (409 draft_exists)', async () => {
    await mount()
    const button = await screen.findByRole('button', { name: t.template.useOf('Progetto a corpo') })
    server.failNext(
      'POST',
      problemAnswer(409, 'draft_exists', { updatedBy: ADA, updatedAt: '2026-11-15T10:00:00.000Z' }),
    )
    server.draft = draftView({ templateVersion: 1 })
    fireEvent.click(button)
    expect(await tab(t.steps.client)).not.toBeNull()
    expect(screen.getByText(/Ada Lovelace.*started it/)).not.toBeNull()
  })
})

describe('OfferWizardPage — fills the content scroller at xl (owner D20)', () => {
  it('hands the wizard the page’s height: section, body and wizard are one flex column that may shrink', async () => {
    matchMedia(true)
    await mount({ draft: draftView({ answers: START }) })
    await tab(t.steps.client)
    expect(screen.getByTestId('crm-offer-wizard-page').className.split(' ')).toEqual(
      expect.arrayContaining(['xl:flex', 'xl:min-h-0', 'xl:flex-1', 'xl:flex-col']),
    )
    expect(screen.getByTestId('offer-wizard').className.split(' ')).toEqual(
      expect.arrayContaining(['min-h-0', 'flex-1']),
    )
    expect(screen.getByTestId('offer-wizard-form').className).toContain('overflow-y-auto')
    expect(screen.getByTestId('crm-wizard-preview').className).toContain('overflow-auto')
  })

  it('below xl the page scrolls as before: no filling, no inner scrolling', async () => {
    matchMedia(false)
    await mount({ draft: draftView({ answers: START }) })
    await tab(t.steps.client)
    expect(screen.getByTestId('offer-wizard').className).not.toContain('min-h-0')
    expect(screen.getByTestId('offer-wizard-form').className).not.toContain('overflow-y-auto')
  })

  it('the Template step with no draft keeps its natural height (it scrolls with the page area)', async () => {
    matchMedia(true)
    await mount()
    await screen.findByRole('button', { name: t.template.useOf('Progetto a corpo') })
    expect(screen.getByTestId('crm-offer-wizard-page').className).not.toContain('xl:min-h-0')
  })
})

describe('OfferWizardPage — resuming (AC-6.1, AC-1.6)', () => {
  it('reopens on the draft’s last step', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'conditions' } }) })
    expect((await tab(t.steps.conditions)).getAttribute('aria-selected')).toBe('true')
  })

  it('lets ?step= win over the draft’s last step', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'conditions' } }), search: '?step=scope' })
    expect((await tab(t.steps.scope)).getAttribute('aria-selected')).toBe('true')
  })

  it('moving between steps writes nothing', async () => {
    await mount({ draft: draftView({ answers: START }) })
    fireEvent.click(await tab(t.steps.scope))
    fireEvent.click(await tab(t.steps.preview))
    await waitFor(() => expect(window.location.search).toContain('step=preview'))
    expect(server.saves).toEqual([])
    expect(requests().filter((request) => request.startsWith('PUT '))).toEqual([])
  })
})

describe('OfferWizardPage — changing the template (AC-6.5)', () => {
  it('asks first, then switches the draft to the other template', async () => {
    const other = template(V1, 1, { id: 't2', name: 'Formazione', description: null, uses: [] })
    await mount({
      draft: draftView({ answers: START }),
      templates: [template(V1, 1), other],
      routes: { 'GET /offer-templates/t2': () => ({ status: 200, body: other }) },
    })
    fireEvent.click(await tab(t.steps.template))
    fireEvent.click(await screen.findByRole('button', { name: t.template.useOf('Formazione') }))
    const dialog = await screen.findByRole('alertdialog')
    expect(requests()).not.toContain('POST /deals/d1/offer-draft/template')
    fireEvent.click(within(dialog).getByRole('button', { name: t.template.switch.confirm }))
    await waitFor(() => expect(requests()).toContain('POST /deals/d1/offer-draft/template'))
    expect(await screen.findByText(t.template.switch.done('Formazione'))).not.toBeNull()
    expect(server.draft?.template.id).toBe('t2')
  })
})

describe('OfferWizardPage — the draft’s states (AC-6.3, AC-8.4; S9)', () => {
  it('a 409 on save stops the form and offers Reload draft', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'scope' } }) })
    const input = await screen.findByLabelText(/Object/)
    server.failNext('PUT', problemAnswer(409, 'version_conflict'))
    await userEvent.type(input, 'A shop')
    const banner = await screen.findByText(t.save.conflict.title, undefined, { timeout: 4000 })
    expect(banner).not.toBeNull()
    expect(screen.getByRole('button', { name: t.save.reload })).not.toBeNull()
    expect(screen.getByLabelText(/Object/).matches(':disabled')).toBe(true)
    // Tab and Back still work while read-only
    expect((await tab(t.steps.client)).getAttribute('aria-disabled')).not.toBe('true')
  }, 10_000)

  it('a refused character names the answer by its label, in our words, never the path or the server line (QE F2)', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'scope' } }) })
    const input = await screen.findByLabelText(/Object/)
    server.failNext('PUT', {
      status: 422,
      body: {
        status: 422,
        title: 'Unprocessable Entity',
        code: 'answers_invalid',
        detail: 'The answers are not valid at "fields.OGGETTO" (Not text: contains a NUL character)',
        path: 'fields.OGGETTO',
        reason: 'shape',
      },
    })
    await userEvent.type(input, 'A shop')
    const banner = await screen.findByTestId('crm-offer-wizard-rejected', undefined, { timeout: 4000 })
    expect(banner.textContent).toBe(t.save.rejected(t.save.answerNul('Object')))
    expect(banner.textContent).toBe(
      'This change could not be saved: The answer “Object” contains a character that cannot be saved.',
    )
    expect(banner.getAttribute('role')).toBe('alert')
    expect(document.body.textContent).not.toMatch(/OGGETTO|NUL|Not text|shape/)
  }, 10_000)

  it('any other refused answer keeps the generic line', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'scope' } }) })
    const input = await screen.findByLabelText(/Object/)
    server.failNext('PUT', problemAnswer(422, 'answers_invalid', { path: 'fields.OGGETTO', reason: 'shape' }))
    await userEvent.type(input, 'A shop')
    const banner = await screen.findByTestId('crm-offer-wizard-rejected', undefined, { timeout: 4000 })
    expect(banner.textContent).toBe(t.save.rejected(strings.offers.errors.answersInvalid))
  }, 10_000)

  it('Reload draft takes the server’s draft and makes the form editable again', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'scope' } }) })
    const input = await screen.findByLabelText(/Object/)
    server.failNext('PUT', problemAnswer(409, 'version_conflict'))
    await userEvent.type(input, 'A')
    fireEvent.click(await screen.findByRole('button', { name: t.save.reload }, { timeout: 4000 }))
    await waitFor(() => expect(screen.getByLabelText(/Object/).matches(':disabled')).toBe(false))
    expect(screen.queryByText(t.save.conflict.title)).toBeNull()
  }, 10_000)

  it('a draft discarded meanwhile (404) says so and links back to the deal', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'scope' } }) })
    const input = await screen.findByLabelText(/Object/)
    server.failNext('PUT', problemAnswer(404, 'draft_not_found'))
    await userEvent.type(input, 'A')
    expect(await screen.findByText(t.save.gone.title, undefined, { timeout: 4000 })).not.toBeNull()
    expect(screen.getAllByRole('link', { name: t.page.back }).length).toBeGreaterThan(0)
    expect(screen.getByLabelText(/Object/).matches(':disabled')).toBe(true)
  }, 10_000)

  it('a template edited since shows the notice with what was dropped, and saves the reconciled draft', async () => {
    const filled = setField(AST, setField(AST, START, 'OGGETTO', 'A shop'), 'PAGAMENTO', 'net 15')
    await mount({
      draft: draftView({ answers: filled, templateVersion: 1 }),
      template: template(V2, 2, {}),
      routes: {},
    })
    expect(await screen.findByText(t.changed.title)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t.changed.see }))
    const dialog = await screen.findByRole('dialog', { name: t.changed.dialog.title })
    expect(within(dialog).getByText('PAGAMENTO')).not.toBeNull()
    await waitFor(() => expect(server.saves.length).toBeGreaterThan(0), { timeout: 4000 })
    expect(server.saves[0]!.body.templateVersion).toBe(2)
  }, 10_000)

  it('an archived template says so, keeps the Template tab and blocks Generate', async () => {
    await mount({
      draft: draftView({ answers: COMPLETE, template: { ...draftView().template, archived: true } }),
      template: template(V1, 1, { archived: true }),
    })
    expect(await screen.findByText(t.archived.title)).not.toBeNull()
    fireEvent.click(await tab(t.steps.preview))
    // the action bar's Generate and the issues card's: one control, blocked in both places
    const buttons = screen.getAllByRole('button', { name: t.bar.generate })
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button.getAttribute('aria-disabled')).toBe('true')
  })

  it('without a ready estimate the draft says so and Generate stays blocked', async () => {
    await mount({
      draft: draftView({ answers: COMPLETE }),
      context: { estimate: { ...CONTEXT.estimate, state: 'missing' } },
    })
    expect(await screen.findByText(t.estimate.missing)).not.toBeNull()
    fireEvent.click(await tab(t.steps.preview))
    // the action bar's Generate and the issues card's: one control, blocked in both places
    const buttons = screen.getAllByRole('button', { name: t.bar.generate })
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button.getAttribute('aria-disabled')).toBe('true')
  })

  describe('a blank legal name in the profile (AC-12.7, DD-61, D-26)', () => {
    const blankReason = () => t.bar.blockedLegalName(strings.badges.entity.welld_ch)

    it('blocks both Generate controls with the reason, names the entity by its badge label and counts nothing', async () => {
      await mount({ draft: draftView({ answers: COMPLETE }), context: { issuerLegalName: '   ' } })
      fireEvent.click(await tab(t.steps.preview))
      const buttons = screen.getAllByRole('button', { name: t.bar.generate })
      expect(buttons).toHaveLength(2)
      for (const button of buttons) expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(screen.getAllByText(blankReason()).length).toBeGreaterThan(0)
      expect(blankReason()).toBe('The legal name of wellD CH is empty. It is kept on the Legal entities page.')
      expect(screen.queryByText(/\d+ missing/)).toBeNull()
    })

    it('does not run Generate when pressed', async () => {
      await mount({ draft: draftView({ answers: COMPLETE }), context: { issuerLegalName: '' } })
      fireEvent.click(await tab(t.steps.preview))
      for (const button of screen.getAllByRole('button', { name: t.bar.generate })) fireEvent.click(button)
      expect(requests().filter((request) => request.endsWith('/generate'))).toEqual([])
    })

    it('comes after the estimate and the archived template in the chain', async () => {
      await mount({
        draft: draftView({ answers: COMPLETE }),
        context: { issuerLegalName: ' ', estimate: { ...CONTEXT.estimate, state: 'missing' } },
      })
      fireEvent.click(await tab(t.steps.preview))
      expect(screen.getAllByText(t.estimate.missing).length).toBeGreaterThan(0)
      expect(screen.queryByText(blankReason())).toBeNull()
      cleanup()
      await mount({
        draft: draftView({ answers: COMPLETE, template: { ...draftView().template, archived: true } }),
        template: template(V1, 1, { archived: true }),
        context: { issuerLegalName: ' ' },
      })
      fireEvent.click(await tab(t.steps.preview))
      expect(screen.getAllByText(t.archived.title).length).toBeGreaterThan(0)
      expect(screen.queryByText(blankReason())).toBeNull()
    })

    it('a named profile does not block', async () => {
      await mount({ draft: draftView({ answers: COMPLETE }) })
      fireEvent.click(await tab(t.steps.preview))
      for (const button of screen.getAllByRole('button', { name: t.bar.generate }))
        expect(button.getAttribute('aria-disabled')).toBeNull()
    })
  })

  describe('the Preview card while Generate is blocked (G15)', () => {
    it('says "you can generate" with nothing in the way', async () => {
      await mount({ draft: draftView({ answers: COMPLETE }) })
      fireEvent.click(await tab(t.steps.preview))
      expect(screen.getByText(t.issues.none)).not.toBeNull()
    })

    it.each([
      ['the estimate', { estimate: { ...CONTEXT.estimate, state: 'missing' } }, t.estimate.missing],
      ['a blank legal name', { issuerLegalName: ' ' }, t.bar.blockedLegalName(strings.badges.entity.welld_ch)],
    ])(
      'does not say it when %s blocks it, and gives the reason in the card instead',
      async (_name, context, reason) => {
        await mount({ draft: draftView({ answers: COMPLETE }), context })
        fireEvent.click(await tab(t.steps.preview))
        await screen.findAllByRole('button', { name: t.bar.generate })
        expect(screen.queryByText(t.issues.none)).toBeNull()
        const card = screen.getByRole('region', { name: t.issues.title })
        expect(within(card).getAllByText(reason).length).toBeGreaterThan(0)
      },
    )

    it('does not say it when the template is archived', async () => {
      await mount({
        draft: draftView({ answers: COMPLETE, template: { ...draftView().template, archived: true } }),
        template: template(V1, 1, { archived: true }),
      })
      fireEvent.click(await tab(t.steps.preview))
      await screen.findAllByRole('button', { name: t.bar.generate })
      expect(screen.queryByText(t.issues.none)).toBeNull()
    })
  })
})

describe('OfferWizardPage — a hand edit is saved before its dialog closes (AC-5.1)', () => {
  const openEdit = async () => {
    fireEvent.click(await tab(t.steps.preview))
    const row = (await screen.findByRole('rowheader', { name: /SCOPE/ })).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: t.sections.edit('SCOPE') }))
    return screen.findByRole('dialog', { name: t.edit.title })
  }

  it('closes once the server has the edit', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    const dialog = await openEdit()
    fireEvent.click(within(dialog).getByRole('button', { name: t.edit.save }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t.edit.title })).toBeNull(), { timeout: 4000 })
    expect(server.saves.length).toBe(1)
    expect(Object.keys(server.saves[0]!.body.answers.handEdits)).toEqual(['SCOPE#0'])
  })

  it('stays open with the reason when the draft was changed by someone else', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    const dialog = await openEdit()
    server.failNext('PUT', problemAnswer(409, 'version_conflict'))
    fireEvent.click(within(dialog).getByRole('button', { name: t.edit.save }))
    await waitFor(
      () => expect(within(dialog).getByRole('alert').textContent).toContain(strings.offers.errors.versionConflict),
      { timeout: 4000 },
    )
    expect(screen.getByRole('dialog', { name: t.edit.title })).toBe(dialog)
  })
})

describe('OfferWizardPage — generating (AC-3.5, S10)', () => {
  const toPreview = async () => {
    fireEvent.click(await tab(t.steps.preview))
    // Generate is also in the issues card (design S7.1): these tests drive the action bar's, which is the same control
    return within(await screen.findByTestId('offer-wizard-action-bar')).findByRole('button', { name: t.bar.generate })
  }

  it('a successful Generate goes back to the deal', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    fireEvent.click(await toPreview())
    expect(await screen.findByRole('heading', { level: 2, name: 'Platform rebuild' })).not.toBeNull()
    expect(requests()).toContain('POST /deals/d1/offer-draft/generate')
    expect(window.location.pathname).toBe('/deals/d1')
    // the deal page confirms once, and asks about the proposal stage of a qualified deal
    expect(await screen.findByText(strings.offers.generated('0001/2026'))).not.toBeNull()
    expect(await screen.findByRole('alertdialog', { name: strings.offers.proposalDialog.title })).not.toBeNull()
    // …and not again on a reload: the history entry no longer carries it
    await waitFor(() => expect(window.history.state?.generated).toBeUndefined())
  })

  it('a 422 offer_incomplete replaces both lists, names the problem and moves focus to the list', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    const generate = await toPreview()
    server.failNext(
      'POST generate',
      problemAnswer(422, 'offer_incomplete', {
        missing: [{ name: 'OGGETTO', label: 'Object', step: 'scope' }],
        invalid: [{ name: 'PAGAMENTO', label: 'Payment', step: 'conditions', code: 'out_of_range' }],
      }),
    )
    fireEvent.click(generate)
    expect(await screen.findByText(t.generate.fail.incomplete)).not.toBeNull()
    expect(screen.getByRole('button', { name: new RegExp('Object') })).not.toBeNull()
    expect(screen.getByRole('button', { name: new RegExp('Payment') })).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: t.issues.title })))
  })

  it('a 409 template_changed offers Reload draft', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    const generate = await toPreview()
    server.failNext('POST generate', problemAnswer(409, 'template_changed'))
    fireEvent.click(generate)
    expect(await screen.findByText(t.generate.fail.templateChanged)).not.toBeNull()
    expect(screen.getByRole('button', { name: t.save.reload })).not.toBeNull()
  })

  it('a contact no longer in the company offers Go to Client', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    const generate = await toPreview()
    server.failNext('POST generate', problemAnswer(422, 'contact_not_in_company'))
    fireEvent.click(generate)
    expect(await screen.findByText(t.generate.fail.contact)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t.generate.fail.go(t.steps.client) }))
    expect((await tab(t.steps.client)).getAttribute('aria-selected')).toBe('true')
  })

  it('a 409 letterhead_unusable says to upload the letterhead again, names the issuer, creates nothing and stays on the page (AC-11.4, D-41)', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    const generate = await toPreview()
    server.failNext(
      'POST generate',
      problemAnswer(409, 'letterhead_unusable', { entity: 'welld_ch', reason: 'decoded_too_large' }),
    )
    fireEvent.click(generate)
    const banner = await screen.findByTestId('crm-offer-wizard-failure')
    expect(banner.textContent).toContain(strings.offers.errors.letterheadUnusable('WellD Sagl'))
    expect(banner.textContent).toContain(
      'The letterhead of WellD Sagl can no longer be used. Upload it again in CRM Settings.',
    )
    expect(banner.textContent).not.toContain('decoded_too_large')
    // the fix is outside the wizard: no action in the banner, and no error page
    expect(
      within(banner)
        .queryAllByRole('button')
        .filter((b) => !/dismiss/i.test(b.getAttribute('aria-label') ?? '')),
    ).toEqual([])
    expect(window.location.pathname).toBe('/deals/d1/offer')
    expect(screen.queryByTestId('crm-offer-wizard-not-found')).toBeNull()
    // Generate stays available, to try again after the upload
    expect(screen.getAllByRole('button', { name: t.bar.generate })[0]!.getAttribute('aria-disabled')).toBeNull()
  })

  it.each([
    [
      'pdf_check_busy',
      strings.common.pdfCheck.pdf_check_busy,
      'The check of uploaded PDFs is busy. Try again in a moment.',
    ],
    [
      'pdf_check_unavailable',
      strings.common.pdfCheck.pdf_check_unavailable,
      'The PDF could not be checked right now. Try again.',
    ],
  ])(
    'a 503 %s says the check could not run in our own words, never the server detail, and Retry generates again',
    async (code, copy, english) => {
      await mount({ draft: draftView({ answers: COMPLETE }) })
      const generate = await toPreview()
      server.failNext('POST generate', problemAnswer(503, code))
      fireEvent.click(generate)
      const banner = await screen.findByTestId('crm-offer-wizard-failure')
      expect(copy).toBe(english)
      expect(banner.textContent).toContain(copy)
      expect(banner.textContent).not.toContain(`detail of ${code}`)
      fireEvent.click(within(banner).getByRole('button', { name: t.generate.fail.retryAction }))
      expect(await screen.findByRole('heading', { level: 2, name: 'Platform rebuild' })).not.toBeNull()
    },
  )

  it('a network failure says nothing was created and retries on request', async () => {
    await mount({ draft: draftView({ answers: COMPLETE }) })
    const generate = await toPreview()
    server.failNext('POST generate', 'network')
    fireEvent.click(generate)
    expect(await screen.findByText(t.generate.fail.retry)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t.generate.fail.retryAction }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Platform rebuild' })).not.toBeNull()
  })
})

describe('OfferWizardPage — the engine’s context (DD-41)', () => {
  it('prints the template’s language in an English UI, and dates the offer by the server’s day, not the browser’s', async () => {
    matchMedia(true)
    // 2026-06-01 is 167 days before the server's 2026-11-15: outside the ±90-day window
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-01T10:00:00Z') })
    await mount({
      draft: draftView({
        answers: { ...COMPLETE, client: { ...COMPLETE.client, date: '2026-06-01' }, lastStep: 'preview' },
      }),
    })
    // the document's fixed words are Italian although the UI is English
    expect(await screen.findByText('Per accettazione')).not.toBeNull()
    // the date check ran against context.today of the response
    const issue = await screen.findByRole('button', { name: new RegExp(`${t.client.dateInput}.*`) })
    expect(issue).not.toBeNull()
    expect(issue.textContent).toContain(t.invalid.date_out_of_range)
  })
})

describe('OfferWizardPage — the preview on the letterhead (T65; AC-11.1 to AC-11.8, AC-12.12; D-32)', () => {
  // the browser's decoder and the PDF renderer are doubles (their contracts have their own tests)
  const LINK = 'https://bucket.test/letterheads/welld_ch/x.pdf?sig=abc'
  const withAddress = V1.replace('## SCOPE', '{{?SEDE::Sede: [SEDE].}}\n\n## SCOPE').concat(
    '\n@@field SEDE\nlabel: Sede\nsource: issuerAddress\n',
  )
  const letterheadCalls = () => requests().filter((request) => request === 'GET /entity-profiles/welld_ch/letterhead')
  let fetched: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetched = vi.fn(async () => new Response(new TextEncoder().encode('%PDF-1.7 x')))
    vi.stubGlobal('fetch', fetched)
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        decode = async () => {}
      },
    )
    URL.createObjectURL = vi.fn(() => 'blob:letterhead-page')
    URL.revokeObjectURL = vi.fn()
    matchMedia(true)
  })

  it('a profile without a letterhead says so, draws no box and asks for nothing', async () => {
    await mount({ draft: draftView({ answers: { ...START, lastStep: 'scope' } }) })
    const band = await screen.findByTestId('crm-wizard-letterhead-band')
    await waitFor(() => expect(band.getAttribute('data-state')).toBe('none'))
    expect(band.textContent).toContain(t.preview.letterheadNone('WellD Sagl'))
    expect(screen.queryByTestId('crm-wizard-letterhead')).toBeNull()
    expect(letterheadCalls()).toEqual([])
  })

  it('a letterhead is fetched once and drawn behind the paper', async () => {
    await mount({
      draft: draftView({ answers: { ...START, lastStep: 'scope' } }),
      context: { letterhead: true },
      routes: { 'GET /entity-profiles/welld_ch/letterhead': () => ({ status: 200, body: { url: LINK } }) },
    })
    const image = await screen.findByTestId('crm-wizard-letterhead')
    await waitFor(() => expect(screen.getByTestId('crm-wizard-letterhead').tagName).toBe('IMG'))
    expect(image).not.toBeNull()
    expect(screen.getByTestId('crm-wizard-letterhead-band').textContent).toBe(t.preview.letterheadShown)
    expect(letterheadCalls()).toHaveLength(1)
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(String(fetched.mock.calls[0]![0])).toBe(LINK)
    // the bucket never sees the Bearer token: the link is read with plain fetch, not apiFetch
    expect(apiFetch.mock.calls.some(([url]) => String(url).includes('bucket.test'))).toBe(false)
  })

  it('a failed link is soft: the band says so, no retry loop, the preview text is there', async () => {
    await mount({
      draft: draftView({ answers: { ...START, lastStep: 'scope' } }),
      context: { letterhead: true },
      routes: { 'GET /entity-profiles/welld_ch/letterhead': () => problemAnswer(503, 'storage_unavailable') },
    })
    await waitFor(() =>
      expect(screen.getByTestId('crm-wizard-letterhead-band').getAttribute('data-state')).toBe('failed'),
    )
    expect(screen.getByTestId('crm-wizard-letterhead-band').textContent).toContain(
      t.preview.letterheadFailed('WellD Sagl'),
    )
    // the pages keep their frame and carry no image
    expect(screen.getAllByTestId('crm-wizard-page').length).toBeGreaterThan(0)
    expect(screen.queryAllByTestId('crm-wizard-letterhead')).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('region', { name: t.preview.title }).textContent).toContain('We deliver')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(letterheadCalls()).toHaveLength(1)
  })

  describe('a stored letterhead the service refuses (security M-4, AC-11.4 "Unusable letterhead", DD-76)', () => {
    const unusableRoute = {
      'GET /entity-profiles/welld_ch/letterhead': () =>
        problemAnswer(409, 'letterhead_unusable', { entity: 'welld_ch', reason: 'image_too_large' }),
    }
    const reason = () => strings.offers.errors.letterheadUnusable('WellD Sagl')

    it('blocks both Generate controls with that text as the reason and runs nothing when pressed', async () => {
      await mount({
        draft: draftView({ answers: COMPLETE }),
        context: { letterhead: true },
        routes: unusableRoute,
      })
      fireEvent.click(await tab(t.steps.preview))
      await waitFor(() => expect(screen.getAllByText(reason()).length).toBeGreaterThan(0))
      const buttons = screen.getAllByRole('button', { name: t.bar.generate })
      expect(buttons).toHaveLength(2)
      for (const button of buttons) {
        expect(button.getAttribute('aria-disabled')).toBe('true')
        fireEvent.click(button)
      }
      expect(requests().filter((request) => request.endsWith('/generate'))).toEqual([])
      expect(screen.queryByText(t.issues.none)).toBeNull()
      // one attempt, no loop, no dialog or toast
      expect(letterheadCalls()).toHaveLength(1)
      expect(fetched).not.toHaveBeenCalled()
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('comes after the estimate, an archived template and a blank legal name in the chain', async () => {
      await mount({
        draft: draftView({ answers: COMPLETE }),
        context: { letterhead: true, estimate: { ...CONTEXT.estimate, state: 'missing' } },
        routes: unusableRoute,
      })
      fireEvent.click(await tab(t.steps.preview))
      await waitFor(() => expect(letterheadCalls()).toHaveLength(1))
      expect(screen.getAllByText(t.estimate.missing).length).toBeGreaterThan(0)
      expect(screen.queryByText(reason())).toBeNull()
    })

    it('a letterhead that is merely not shown here (a 503) does not block Generate', async () => {
      await mount({
        draft: draftView({ answers: COMPLETE }),
        context: { letterhead: true },
        routes: { 'GET /entity-profiles/welld_ch/letterhead': () => problemAnswer(503, 'storage_unavailable') },
      })
      fireEvent.click(await tab(t.steps.preview))
      await waitFor(() => expect(letterheadCalls()).toHaveLength(1))
      await screen.findAllByRole('button', { name: t.bar.generate })
      for (const button of screen.getAllByRole('button', { name: t.bar.generate }))
        expect(button.getAttribute('aria-disabled')).toBeNull()
    })
  })

  it('on a narrow screen nothing is fetched until the Drawer opens, and closing and opening it again fetches nothing more', async () => {
    matchMedia(false)
    await mount({
      draft: draftView({ answers: { ...START, lastStep: 'scope' } }),
      context: { letterhead: true },
      routes: { 'GET /entity-profiles/welld_ch/letterhead': () => ({ status: 200, body: { url: LINK } }) },
    })
    const open = await screen.findByRole('button', { name: t.bar.preview })
    expect(letterheadCalls()).toEqual([])
    fireEvent.click(open)
    const drawer = await screen.findByRole('dialog', { name: t.preview.drawerTitle })
    await waitFor(() => expect(within(drawer).getByTestId('crm-wizard-letterhead').tagName).toBe('IMG'))
    fireEvent.keyDown(drawer, { key: 'Escape' })
    fireEvent.click(await screen.findByRole('button', { name: t.bar.preview }))
    const again = await screen.findByRole('dialog', { name: t.preview.drawerTitle })
    expect(within(again).getByTestId('crm-wizard-letterhead').tagName).toBe('IMG')
    expect(letterheadCalls()).toHaveLength(1)
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it('maps the profile’s address lines: printed when set, the notice when the profile has none', async () => {
    const draft = draftView({ answers: { ...START, lastStep: 'scope' } })
    await mount({ draft, template: template(withAddress, 1) })
    expect((await screen.findByRole('region', { name: t.preview.title })).textContent).toContain(
      'Via Nassa 1, 6900 Lugano',
    )
    expect(screen.queryByTestId('crm-wizard-address-notice')).toBeNull()
    cleanup()
    apiFetch.mockReset()
    await mount({ draft, template: template(withAddress, 1), context: { issuerAddressLines: [] } })
    expect((await screen.findByTestId('crm-wizard-address-notice')).textContent).toBe(
      t.preview.addressNotice('WellD Sagl'),
    )
    // not a missing field, and Generate is not blocked by it
    expect(screen.queryByText(t.preview.missingBadge(1))).toBeNull()
  })
})

describe('OfferWizardPage — the issuer’s address in the offer’s language (specs/20261117-legal-entities AC-6.2, E4)', () => {
  const withAddress = V1.replace('## SCOPE', '{{?SEDE::Sede: [SEDE].}}\n\n## SCOPE').concat(
    '\n@@field SEDE\nlabel: Sede\nsource: issuerAddress\n',
  )
  const BOTH = { it: ['Via Nassa 1', '6900 Lugano'], en: ['Nassa Street 1', '6900 Lugano, Switzerland'] }
  const inLanguage = (language: 'it' | 'en') => ({
    draft: draftView({
      answers: { ...START, lastStep: 'scope' },
      template: { ...draftView().template, language },
    }),
    template: template(withAddress, 1, { language }),
  })
  const preview = async () => (await screen.findByRole('region', { name: t.preview.title })).textContent

  beforeEach(() => matchMedia(true))

  it('prints the English address for an English template and the Italian one for an Italian template', async () => {
    await mount({ ...inLanguage('en'), context: { issuerAddress: BOTH } })
    const english = await preview()
    expect(english).toContain('Nassa Street 1, 6900 Lugano, Switzerland')
    expect(english).not.toContain('Via Nassa 1')
    cleanup()
    apiFetch.mockReset()
    await mount({ ...inLanguage('it'), context: { issuerAddress: BOTH } })
    const italian = await preview()
    expect(italian).toContain('Via Nassa 1, 6900 Lugano')
    expect(italian).not.toContain('Nassa Street')
  })

  it('falls back to `issuerAddressLines` when an older crm-api sends no `issuerAddress`', async () => {
    await mount({ ...inLanguage('en'), context: { issuerAddressLines: ['Via Vecchia 3'] } })
    expect(await preview()).toContain('Via Vecchia 3')
  })

  it('says the address is not set when the template’s language has none, though the other one has', async () => {
    await mount({ ...inLanguage('en'), context: { issuerAddress: { it: BOTH.it, en: [] } } })
    expect((await screen.findByTestId('crm-wizard-address-notice')).textContent).toBe(
      t.preview.addressNotice('WellD Sagl'),
    )
  })
})

describe('OfferWizardPage — the deal (S1)', () => {
  it('a deal outside the caller’s entity scope is denied without calling the draft', async () => {
    await mount({
      routes: {
        'GET /scope': () => ({ status: 200, body: { deal: [], canErase: false, financials: true, managesAll: false } }),
      },
    })
    expect(await screen.findByTestId('crm-permission-denied')).not.toBeNull()
    expect(requests().some((request) => request.includes('offer-wizard/context'))).toBe(false)
  })

  it('an unknown deal says so with the back link', async () => {
    await mount({ routes: { 'GET /deals/d1': () => problemAnswer(404, 'not_found') } })
    expect(await screen.findByText(t.page.notFound.title, { selector: 'h3, h2' })).not.toBeNull()
    expect(screen.getAllByRole('link', { name: t.page.back }).length).toBeGreaterThan(0)
  })
})

// keep the fixtures referenced by every describe above honest
void sampleAnswersFixture
