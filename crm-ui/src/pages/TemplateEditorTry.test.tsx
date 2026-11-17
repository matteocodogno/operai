/**
 * @vitest-environment jsdom
 *
 * "Try the wizard" in the template editor (specs/20261115-crm-offer-wizard T53; AC-8.5; design S13): the wizard in
 * `sample` mode on the text as typed — saved or not — with sample answers and the editor's language, no deal and no
 * draft, and not one write to the API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { ADA, fakeApi, type FakeHandler } from '../test-support/fakeApi'
import { strings } from '../strings'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

vi.mock('../lib/letterhead/renderLetterhead', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/letterhead/renderLetterhead')>()),
  renderLetterhead: async () => new Blob(['png'], { type: 'image/png' }),
}))

const t = strings.templates
const w = t.wizardEditor
const wizard = strings.offerWizard

const SOURCE = `@@salutation Spett.le

## OGGETTO
@@step scope
Realizziamo [PROGETTO].

## CORRISPETTIVO
@@step costs
@@costs position unit
@@line main one_off | Sviluppo | unit=? | qty=1
@@total **TOTALE**
@@end

@@field PROGETTO
label: Progetto
`

const WIZARD = {
  id: 'w1',
  entity: 'welld_ch',
  name: 'Progetto a corpo',
  language: 'it',
  format: 'wizard',
  description: null,
  uses: [],
  source: SOURCE,
  seeded: false,
  showTotal: false,
  annex: false,
  version: 3,
  archived: false,
  updatedBy: ADA,
  updatedAt: '2026-10-30T10:00:00.000Z',
  createdAt: '2026-10-01T10:00:00.000Z',
}

const MANAGER = { deal: ['welld_ch'], financials: true, managesAll: false, canErase: false }

function matchMedia(wide: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

const open = async () => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({ status: 200, body: MANAGER }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [WIZARD] } }),
      'GET /offer-templates/w1': () => ({ status: 200, body: WIZARD }),
    }),
  )
  window.history.pushState(null, '', '/settings/templates/w1')
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  await screen.findByRole('textbox', { name: w.text })
}

const textArea = () => screen.getByRole('textbox', { name: w.text }) as HTMLTextAreaElement
const setText = (value: string) => fireEvent.change(textArea(), { target: { value } })
const viewTab = (name: string) => screen.getByRole('tab', { name })
const requests = () =>
  apiFetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)
/** The wizard's own step tabs (the Try view's tablist is the one named "Offer steps"). */
const steps = () =>
  within(screen.getByRole('tablist', { name: wizard.steps.label }))
    .getAllByRole('tab')
    .map((tab) => tab.textContent ?? '')

beforeEach(() => {
  window.scrollTo = () => undefined
  matchMedia(false)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  apiFetch.mockReset()
})

describe('the editor’s views (AC-8.5)', () => {
  it('offers Edit and Try the wizard, on Edit at first', async () => {
    await open()
    expect(viewTab(w.edit).getAttribute('aria-selected')).toBe('true')
    expect(viewTab(w.tryLabel).getAttribute('aria-selected')).toBe('false')
    expect(screen.queryByRole('tablist', { name: wizard.steps.label })).toBeNull()
  })

  it('Try shows the wizard of the template as saved, with no Template step', async () => {
    await open()
    fireEvent.click(viewTab(w.tryLabel))
    expect(await screen.findByRole('tablist', { name: wizard.steps.label })).not.toBeNull()
    expect(steps().map((name) => name.replace(/\d+$/, ''))).toEqual([
      wizard.steps.client,
      wizard.steps.scope,
      wizard.steps.costs,
      wizard.steps.annexes,
      wizard.steps.preview,
    ])
    expect(screen.getByText(w.try.banner)).not.toBeNull()
  })

  it('shows an edit that is not saved yet in the steps and in the preview', async () => {
    matchMedia(true)
    await open()
    setText(
      SOURCE.replace(
        '@@field PROGETTO',
        '## CONDIZIONI\n@@step conditions\nPagamento [PAGAMENTO], clausola nuova.\n\n@@field PAGAMENTO\nlabel: Pagamento\n\n@@field PROGETTO',
      ).replace('label: Progetto', 'label: Progetto cambiato'),
    )
    fireEvent.click(viewTab(w.tryLabel))
    await screen.findByRole('tablist', { name: wizard.steps.label })
    expect(steps().some((name) => name.startsWith(wizard.steps.conditions))).toBe(true)
    // the preview is the document of the typed text, in the editor's language
    expect(await screen.findByText(/clausola nuova/)).not.toBeNull()
    expect(screen.getByText('Per accettazione')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.scope) }))
    expect(await screen.findByRole('textbox', { name: /Progetto cambiato/ })).not.toBeNull()
  })

  it('uses the language the editor has now, not the saved one', async () => {
    matchMedia(true)
    await open()
    fireEvent.change(screen.getByLabelText(t.editor.fields.language), { target: { value: 'en' } })
    fireEvent.click(viewTab(w.tryLabel))
    expect(await screen.findByText('Acceptance')).not.toBeNull()
  })

  it('keeps the typed text when the views are switched', async () => {
    await open()
    setText(`${SOURCE}\nsomething typed\n`)
    fireEvent.click(viewTab(w.tryLabel))
    await screen.findByRole('tablist', { name: wizard.steps.label })
    fireEvent.click(viewTab(w.edit))
    expect(textArea().value).toBe(`${SOURCE}\nsomething typed\n`)
  })

  it('does not try a text that has errors: it says how many and leads back to the problems', async () => {
    await open()
    setText(`${SOURCE}\n{{open::never closed\n`)
    fireEvent.click(viewTab(w.tryLabel))
    const message = await screen.findByText(/Fix the \d+ errors? to try the wizard/)
    expect(message).not.toBeNull()
    expect(screen.queryByRole('tablist', { name: wizard.steps.label })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: w.try.goProblems }))
    expect(viewTab(w.edit).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('textbox', { name: w.text })).not.toBeNull()
  })

  it('answers with the sample answers, restarts them on request and never offers to generate', async () => {
    await open()
    fireEvent.click(viewTab(w.tryLabel))
    await screen.findByRole('tablist', { name: wizard.steps.label })
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.scope) }))
    const field = (await screen.findByRole('textbox', { name: /Progetto/ })) as HTMLInputElement
    const sample = field.value
    expect(sample).not.toBe('')
    fireEvent.change(field, { target: { value: 'Altro' } })
    expect((screen.getByRole('textbox', { name: /Progetto/ }) as HTMLInputElement).value).toBe('Altro')
    fireEvent.click(screen.getByRole('button', { name: w.try.reset }))
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: /Progetto/ }) as HTMLInputElement).value).toBe(sample),
    )
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.preview) }))
    expect(screen.queryByRole('button', { name: wizard.bar.generate })).toBeNull()
    expect(screen.getByText(w.try.noGenerate)).not.toBeNull()
  })

  it('makes no request but the editor’s own reads: no draft, no context, no write', async () => {
    await open()
    setText(`${SOURCE}\nmore\n`)
    fireEvent.click(viewTab(w.tryLabel))
    await screen.findByRole('tablist', { name: wizard.steps.label })
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.scope) }))
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.preview) }))
    fireEvent.click(viewTab(w.edit))
    const seen = requests()
    expect(seen.filter((request) => !request.startsWith('GET '))).toEqual([])
    expect(seen.filter((request) => /offer-draft|offer-wizard|\/deals\//.test(request))).toEqual([])
  })
})

// ─── The issuer in the Try view (T66; AC-8.5, AC-11.9, AC-12.8, AC-12.13; DD-62, D-28) ──────────────────────

describe('the issuer’s name, address and letterhead (DD-62)', () => {
  const ISSUER_SOURCE = `@@salutation Spett.le

## OGGETTO
@@step scope
Fornitore: [EMITTENTE]. Sede: [SEDE]. Oggetto: [PROGETTO].

## CORRISPETTIVO
@@step costs
@@costs position unit
@@line main one_off | Sviluppo | unit=? | qty=1
@@total **TOTALE**
@@end

@@field EMITTENTE
label: Emittente
source: issuer

@@field SEDE
label: Sede
source: issuerAddress

@@field PROGETTO
label: Progetto
`
  const issuerTemplate = { ...WIZARD, source: ISSUER_SOURCE }
  const PROFILE = {
    entity: 'welld_ch',
    offerTermsEn: null,
    offerTermsIt: null,
    placeOfIssue: null,
    letterhead: null,
    updatedAt: '2026-11-01T09:00:00.000Z',
  }
  const SAMPLE_NAME = 'Fornitore di esempio SA'
  const SAMPLE_ADDRESS = 'Via Esempio 2, 6900 Lugano'
  const LINK = 'https://bucket.test/letterheads/welld_ch/x.pdf?sig=abc'
  const entityLabel = strings.badges.entity.welld_ch
  const profileCalls = () => requests().filter((request) => request === 'GET /entity-profiles')
  const band = () => screen.findByTestId('crm-wizard-letterhead-band')

  const openTry = async (
    profiles: FakeHandler | null,
    source = ISSUER_SOURCE,
    extra: Record<string, FakeHandler> = {},
  ) => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: MANAGER }),
        'GET /offer-templates': () => ({ status: 200, body: { items: [{ ...issuerTemplate, source }] } }),
        'GET /offer-templates/w1': () => ({ status: 200, body: { ...issuerTemplate, source } }),
        ...(profiles ? { 'GET /entity-profiles': profiles } : {}),
        ...extra,
      }),
    )
    window.history.pushState(null, '', '/settings/templates/w1')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
    await screen.findByRole('textbox', { name: w.text })
    fireEvent.click(viewTab(w.tryLabel))
    await screen.findByRole('tablist', { name: wizard.steps.label })
  }
  const readable =
    (overrides: Record<string, unknown> = {}): FakeHandler =>
    () => ({
      status: 200,
      body: { items: [{ ...PROFILE, ...overrides }] },
    })
  const paper = () => screen.findByTestId('crm-wizard-preview')

  let fetched: ReturnType<typeof vi.fn>
  beforeEach(() => {
    matchMedia(true)
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
  })

  it('prints the sample supplier and says so at once: the profile no longer holds the legal details (AC-6.1)', async () => {
    await openTry(readable())
    expect((await paper()).textContent).toContain(`Fornitore: ${SAMPLE_NAME}.`)
    expect((await paper()).textContent).toContain(`Sede: ${SAMPLE_ADDRESS}.`)
    expect(screen.getByText(w.try.issuerSample(entityLabel))).not.toBeNull()
    expect(profileCalls()).toHaveLength(1)
  })

  it('reads the profiles once per mount: a keystroke, a step and a reset do not read them again', async () => {
    await openTry(readable())
    await waitFor(async () => expect((await band()).getAttribute('data-state')).toBe('none'))
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.costs) }))
    fireEvent.click(screen.getByRole('button', { name: w.try.reset }))
    fireEvent.click(viewTab(w.edit))
    setText(`${ISSUER_SOURCE}\nmore\n`)
    fireEvent.click(viewTab(w.tryLabel))
    await screen.findByRole('tablist', { name: wizard.steps.label })
    // leaving the Try view and coming back is a new mount: one read each, no more
    expect(profileCalls()).toHaveLength(2)
  })

  it('renders at once on the sample values while the profile is being read, and the letterhead waits (D-28)', async () => {
    let release: (answer: { status: number; body: unknown }) => void = () => undefined
    const gate = new Promise<{ status: number; body: unknown }>((resolve) => (release = resolve))
    await openTry(() => gate)
    expect((await paper()).textContent).toContain(`Fornitore: ${SAMPLE_NAME}.`)
    // the letterhead waits for the answer: pending, not failed
    expect((await band()).getAttribute('data-state')).toBe('pending')
    release({ status: 200, body: { items: [PROFILE] } })
    await waitFor(async () => expect((await band()).getAttribute('data-state')).toBe('none'))
    expect((await paper()).textContent).toContain(`Fornitore: ${SAMPLE_NAME}.`)
  })

  it.each([
    ['cannot be read (403, no deal:financials)', () => ({ status: 403, body: { status: 403, title: 'Forbidden' } })],
    ['cannot be read (503)', () => ({ status: 503, body: { status: 503, title: 'Unavailable' } })],
    ['has no row for the entity', () => ({ status: 200, body: { items: [{ ...PROFILE, entity: 'welld_it' }] } })],
  ])('when the profile %s, the sample supplier and the note are the same', async (_name, handler) => {
    await openTry(handler as FakeHandler)
    expect(await screen.findByText(w.try.issuerSample(entityLabel))).not.toBeNull()
    const text = (await paper()).textContent
    expect(text).toContain(`Fornitore: ${SAMPLE_NAME}.`)
    expect(text).toContain(`Sede: ${SAMPLE_ADDRESS}.`)
    expect(text).not.toContain('Profilo Reale')
    // the view still works: the other sample answers are there and the steps open
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.preview) }))
    expect(screen.getByText(w.try.noGenerate)).not.toBeNull()
  })

  it('the sample note is a compact info banner that does not announce itself', async () => {
    await openTry(() => ({ status: 403, body: { status: 403, title: 'Forbidden' } }))
    const note = await screen.findByText(w.try.issuerSample(entityLabel))
    expect(note.closest('[role="alert"]')).toBeNull()
    expect(note.closest('[aria-live="assertive"]')).toBeNull()
  })

  it('shows the profile’s letterhead through the one attempt, and reads nothing else from the CRM (AC-8.5)', async () => {
    await openTry(
      readable({ letterhead: { uploadedBy: ADA, uploadedAt: '2026-11-01T09:00:00.000Z' } }),
      ISSUER_SOURCE,
      {
        'GET /entity-profiles/welld_ch/letterhead': () => ({ status: 200, body: { url: LINK } }),
      },
    )
    await waitFor(async () => expect((await band()).getAttribute('data-state')).toBe('shown'))
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.costs) }))
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(wizard.steps.preview) }))
    expect(requests().filter((request) => request === 'GET /entity-profiles/welld_ch/letterhead')).toHaveLength(1)
    expect(fetched).toHaveBeenCalledTimes(1)
    const seen = requests()
    expect(seen.filter((request) => !request.startsWith('GET '))).toEqual([])
    expect(seen.filter((request) => /offer-draft|offer-wizard|\/deals\//.test(request))).toEqual([])
  })

  it('a profile without a letterhead says so and asks for nothing', async () => {
    await openTry(readable())
    await waitFor(async () => expect((await band()).getAttribute('data-state')).toBe('none'))
    expect(requests().filter((request) => request.includes('/letterhead'))).toEqual([])
  })

  it('a person who cannot read the profile gets the failure band, never an error, and no letterhead request', async () => {
    await openTry(() => ({ status: 403, body: { status: 403, title: 'Forbidden' } }))
    await waitFor(async () => expect((await band()).getAttribute('data-state')).toBe('failed'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(requests().filter((request) => request.includes('/letterhead'))).toEqual([])
    expect(fetched).not.toHaveBeenCalled()
  })
})
