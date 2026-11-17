/**
 * @vitest-environment jsdom
 *
 * "Try the wizard" on the letterhead service path (specs/20261116-letterhead-service T33; design F15, plan amendment G1;
 * AC-10.14, AC-10.7, AC-10.8): with `letterheadService` on, the preview pane is the service's pages, asked of
 * `POST /offer-templates/{id}/try-preview` with the text as typed (saved or not), the sample answers, the entity and the
 * language, and no deal. It follows the answers, keeps the previous pages, and reports a failure and a missing letterhead
 * politely. A template that was never saved asks `POST /offer-templates/try-preview`, and a person who can only read the
 * template asks the id route like anyone else (T53): there is no approximate preview left on this path. Real router, shell and
 * wizard, fake API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../CrmShell'
import { createAppRouter } from '../../router'
import { ADA, fakeApi, problemAnswer, type FakeAnswer, type FakeHandler } from '../../test-support/fakeApi'
import { strings } from '../../strings'

const { apiFetch, session } = vi.hoisted(() => ({ apiFetch: vi.fn(), session: { apps: [] as string[] } }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
  usePermissions: () => ({ epoch: 0, apps: session.apps, roles: [], departments: [], permissions: [] }),
}))
vi.mock('shell/extensions', () => ({ HostExtension: () => null }))
vi.mock('../../lib/letterhead/renderLetterhead', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/letterhead/renderLetterhead')>()),
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
  uses: ['Sviluppo'],
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

const PROFILE = {
  entity: 'welld_ch',
  offerTermsEn: null,
  offerTermsIt: null,
  placeOfIssue: null,
  letterhead: null,
  updatedAt: '2026-11-01T09:00:00.000Z',
}

const PAGES = {
  letterheadVersion: 3,
  pageCount: 2,
  missingPlaceholders: [],
  unprintableCharacters: 0,
  pages: [
    { n: 1, image: 'AAAA', text: 'Spett.le\nRealizziamo il sito' },
    { n: 2, image: 'BBBB', text: 'Corrispettivo' },
  ],
  missingFields: [],
}

const MANAGER = { deal: ['welld_ch'], financials: true, managesAll: false, canErase: false }
const TRY = 'POST /offer-templates/w1/try-preview'
const TRY_UNSAVED = 'POST /offer-templates/try-preview'

type Tried = {
  content: { name: string; language: string; description: string; uses: string[]; source: string }
  answers: { fields: Record<string, unknown>; lastStep: string }
  entity: string
  language: string
}
const tries = () =>
  apiFetch.mock.calls
    .filter(([url, init]) => init?.method === 'POST' && new URL(String(url)).pathname.endsWith('/try-preview'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Tried)
/** The paths the try-previews were asked at, in order. */
const tryPaths = () =>
  apiFetch.mock.calls
    .filter(([url, init]) => init?.method === 'POST' && new URL(String(url)).pathname.endsWith('/try-preview'))
    .map(([url]) => new URL(String(url)).pathname)
const requests = () =>
  apiFetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)

async function open({
  service = true,
  scope = MANAGER,
  path = '/settings/templates/w1',
  preview = () => ({ status: 200, body: PAGES }),
  previewUnsaved = () => ({ status: 200, body: PAGES }),
}: {
  /** `null`: the member is absent from `GET /scope` (an older crm-api). */
  service?: boolean | null
  scope?: Record<string, unknown>
  path?: string
  preview?: FakeHandler
  previewUnsaved?: FakeHandler
} = {}) {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: { ...scope, ...(service === null ? {} : { letterheadService: service }) },
      }),
      'GET /entity-profiles': () => ({ status: 200, body: { items: [PROFILE] } }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [WIZARD] } }),
      'GET /offer-templates/w1': () => ({ status: 200, body: WIZARD }),
      [TRY]: preview,
      [TRY_UNSAVED]: previewUnsaved,
    }),
  )
  window.history.pushState(null, '', path)
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  await screen.findByRole('textbox', { name: w.text })
}

const textArea = () => screen.getByRole('textbox', { name: w.text }) as HTMLTextAreaElement
const tryTab = () => screen.getByRole('tab', { name: w.tryLabel })
const goTry = async () => {
  fireEvent.click(tryTab())
  await screen.findByRole('tablist', { name: wizard.steps.label })
}
const stepTab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) })

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
  matchMedia(true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  apiFetch.mockReset()
  session.apps = []
})

describe('the pages come from the service (AC-10.14)', () => {
  it('shows the service\'s pages in the pane, in the text\'s language, and not the browser-drawn ones', async () => {
    await open()
    await goTry()
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))
    expect(within(region).getByRole('img', { name: 'Page 1 of 2' })).toBeTruthy()
    expect(region.querySelector('figcaption')!.textContent).toBe('Spett.le\nRealizziamo il sito')
    expect(region.querySelector('figcaption')!.getAttribute('lang')).toBe('it')
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
    expect(screen.queryByTestId('crm-wizard-letterhead-band')).toBeNull()
  })

  it('asks for the text as typed and unsaved, the sample answers, the entity and the language, with no deal and no If-Match', async () => {
    await open()
    fireEvent.change(textArea(), { target: { value: `${SOURCE}\n## NUOVA\n@@step conditions\nClausola nuova.\n` } })
    fireEvent.click(tryTab())
    await screen.findByRole('tablist', { name: wizard.steps.label })
    await waitFor(() => expect(tries()).toHaveLength(1))

    const [body] = tries()
    expect(body!.content.source).toContain('Clausola nuova.')
    expect(body!.language).toBe('it')
    expect(body!.entity).toBe('welld_ch')
    // the details are the saved ones, valid whatever is half typed; a null description is the empty one the route wants
    expect(body!.content).toMatchObject({ name: 'Progetto a corpo', language: 'it', description: '', uses: ['Sviluppo'] })
    expect(body!.answers.fields['PROGETTO']).toBeTruthy() // the sample answer
    expect(body!.answers.lastStep).toBe('client')

    const [, init] = apiFetch.mock.calls.find(([url]) => String(url).endsWith('/try-preview'))!
    expect(Object.keys((init as RequestInit).headers as Record<string, string>)).toEqual(['Content-Type'])
    expect(requests().filter((request) => /offer-draft|offer-wizard|\/deals\/|letterhead/.test(request))).toEqual([])
  })

  it('asks in the language the editor has now, not the saved one', async () => {
    await open()
    fireEvent.change(screen.getByLabelText(t.editor.fields.language), { target: { value: 'en' } })
    await goTry()
    await waitFor(() => expect(tries()).toHaveLength(1))
    expect(tries()[0]).toMatchObject({ language: 'en', content: { language: 'en' } })
  })

  it('follows a changed sample answer: asks again after the debounce, the previous pages staying meanwhile', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    let calls = 0
    await open({
      preview: () => {
        calls += 1
        if (calls === 1) return { status: 200, body: PAGES }
        return new Promise<FakeAnswer>((resolve) => {
          release = () => resolve({ status: 200, body: { ...PAGES, pages: [{ n: 1, image: 'CCCC', text: 'Nuovo' }], pageCount: 1 } })
        })
      },
    })
    await goTry()
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))

    fireEvent.click(stepTab(wizard.steps.scope))
    const field = await screen.findByRole('textbox', { name: /Progetto/ })
    await user.clear(field)
    await user.type(field, 'Sito')
    await waitFor(() => expect(tries().length).toBeGreaterThan(1))
    // an older request is never the last word: the one asked last carries the last answer
    expect(tries().at(-1)!.answers.fields['PROGETTO']).toBe('Sito')
    expect(within(region).getAllByRole('figure')).toHaveLength(2) // still the previous pages while the next is made
    release?.()
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(1))
  })
})

describe('when the preview cannot be made (AC-10.7, AC-10.8)', () => {
  it('keeps the wizard usable: a polite notice with Try again, the pages stay, no dialog', async () => {
    const user = userEvent.setup()
    let fail = false
    await open({ preview: () => (fail ? problemAnswer(503, 'layout_service_unavailable') : { status: 200, body: PAGES }) })
    await goTry()
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))

    fail = true
    fireEvent.click(stepTab(wizard.steps.scope))
    await user.type(await screen.findByRole('textbox', { name: /Progetto/ }), 'x')
    const notice = await screen.findByTestId('crm-wizard-service-preview-failed')
    expect(notice.getAttribute('role')).toBe('status')
    expect(within(region).getAllByRole('figure')).toHaveLength(2)
    expect(screen.queryByRole('dialog')).toBeNull()

    fail = false
    await user.click(within(notice).getByRole('button', { name: wizard.servicePreview.retry }))
    await waitFor(() => expect(screen.queryByTestId('crm-wizard-service-preview-failed')).toBeNull())
  })

  it('says there is no letterhead, with the link to Letterheads only for a holder of access', async () => {
    session.apps = ['crm', 'letterheads']
    await open({ preview: () => problemAnswer(409, 'letterhead_not_configured', { entity: 'welld_ch' }) })
    await goTry()
    const notice = await screen.findByTestId('crm-wizard-letterhead-not-configured')
    expect(within(notice).getByRole('link', { name: wizard.letterhead.open }).getAttribute('href')).toBe(
      '/letterheads?entity=welld_ch',
    )
  })

  it('shows no link to a person without access', async () => {
    session.apps = ['crm']
    await open({ preview: () => problemAnswer(409, 'letterhead_not_configured', { entity: 'welld_ch' }) })
    await goTry()
    const notice = await screen.findByTestId('crm-wizard-letterhead-not-configured')
    expect(within(notice).queryByRole('link')).toBeNull()
    expect(notice.textContent).toContain(wizard.letterhead.askAdmin)
  })

  it('tells incomplete legal details (409 legal_entity_incomplete) politely, naming them, without a retry (AC-6.3)', async () => {
    await open({
      preview: () => problemAnswer(409, 'legal_entity_incomplete', { entity: 'welld_ch', missing: ['vatNumber', 'address.en'] }),
    })
    await goTry()
    const notice = await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    expect(within(notice).queryByRole('button')).toBeNull()
    expect(notice.textContent).toContain(wizard.legalEntity.incomplete.title('wellD CH'))
    expect(notice.textContent).toContain('VAT number, Address (English)')
    expect(notice.textContent).not.toContain(wizard.legalEntity.incomplete.noOffer)
    // not a manager of the entity (the question is unanswered here): the sentence, never the link
    expect(within(notice).queryByRole('link')).toBeNull()
    expect(notice.textContent).toContain(wizard.legalEntity.incomplete.askAdmin)
  })

  it('does not make the view fall back to the approximate preview when the service fails', async () => {
    await open({ preview: () => problemAnswer(409, 'template_format_mismatch', { templateId: 'w1' }) })
    await goTry()
    await screen.findByTestId('crm-wizard-service-preview-failed')
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
  })
})

describe('a template that was never saved, and a person who can only read, get the service\'s pages too (T53; AC-10.14)', () => {
  it('a new template asks the route without an id, with the text as typed, and shows the pages with no note', async () => {
    await open({ path: '/settings/templates/new/welld_ch' })
    fireEvent.change(textArea(), { target: { value: SOURCE } })
    await goTry()
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))
    expect(tryPaths()).toEqual(['/offer-templates/try-preview'])
    const [body] = tries()
    expect(body!.content.source).toBe(SOURCE)
    expect(body!.entity).toBe('welld_ch')
    expect(body!.language).toBe('it')
    expect(body!.answers.fields['PROGETTO']).toBeTruthy()
    // the details are fixed, valid ones: nothing typed in the header can make the request invalid, and nothing is shown of them
    expect(body!.content).toMatchObject({ language: 'it', description: '', uses: [] })
    expect(body!.content.name.trim()).not.toBe('')
    // no approximate preview, no note about one, no browser-drawn letterhead
    expect(screen.queryByTestId('crm-template-try-preview-note')).toBeNull()
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
    expect(screen.queryByTestId('crm-wizard-letterhead-band')).toBeNull()
    expect(requests().filter((request) => /letterhead/.test(request))).toEqual([])
    // the saved-template route is not asked: there is none
    expect(requests().filter((request) => request.startsWith('POST /offer-templates/') && request !== `POST ${TRY_UNSAVED.slice(5)}`)).toEqual([])
  })

  it('a new template follows the typed text: another text asks again at the same route', async () => {
    await open({ path: '/settings/templates/new/welld_ch' })
    fireEvent.change(textArea(), { target: { value: SOURCE } })
    await goTry()
    await waitFor(() => expect(tries()).toHaveLength(1))
    fireEvent.click(within(screen.getByRole('tablist', { name: w.views })).getByRole('tab', { name: w.edit }))
    fireEvent.change(textArea(), { target: { value: `${SOURCE}\n## NUOVA\n@@step conditions\nClausola nuova.\n` } })
    await goTry()
    await waitFor(() => expect(tries()).toHaveLength(2))
    expect(tries()[1]!.content.source).toContain('Clausola nuova.')
    expect(tryPaths()).toEqual(['/offer-templates/try-preview', '/offer-templates/try-preview'])
  })

  it('a new template whose letterhead is missing gets the notice with the link, not an approximate preview', async () => {
    session.apps = ['crm', 'letterheads']
    await open({
      path: '/settings/templates/new/welld_ch',
      previewUnsaved: () => problemAnswer(409, 'letterhead_not_configured', { entity: 'welld_ch' }),
    })
    fireEvent.change(textArea(), { target: { value: SOURCE } })
    await goTry()
    const notice = await screen.findByTestId('crm-wizard-letterhead-not-configured')
    expect(within(notice).getByRole('link', { name: wizard.letterhead.open }).getAttribute('href')).toBe('/letterheads?entity=welld_ch')
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
  })

  it('a person who cannot change the template asks the saved route and gets its pages, with no note', async () => {
    await open({ scope: { ...MANAGER, deal: [] } })
    await goTry()
    const region = await screen.findByTestId('crm-wizard-service-preview')
    await waitFor(() => expect(within(region).getAllByRole('figure')).toHaveLength(2))
    expect(tryPaths()).toEqual(['/offer-templates/w1/try-preview'])
    expect(screen.queryByTestId('crm-template-try-preview-note')).toBeNull()
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
    expect(screen.queryByTestId('crm-wizard-letterhead-band')).toBeNull()
  })

  it('a person without deal:financials, whom the read guard refuses (403, no code), gets the failure notice, not the approximate preview', async () => {
    // the route has no entity scope any more: the only 403 it answers is the guard's (crm:access / deal:financials), which names no code
    const guard403 = (): FakeAnswer => ({
      status: 403,
      body: { title: 'Forbidden', status: 403, detail: 'You do not have permission to perform this action' },
    })
    await open({ scope: { ...MANAGER, deal: [], financials: false }, preview: guard403 })
    await goTry()
    await screen.findByTestId('crm-wizard-service-preview-failed')
    expect(tryPaths()).toEqual(['/offer-templates/w1/try-preview'])
    expect(screen.queryByTestId('crm-wizard-preview')).toBeNull()
    expect(screen.queryAllByRole('figure')).toHaveLength(0)
  })
})

describe('with the switch off or absent, the view is as it was', () => {
  it.each([
    ['off', false],
    ['absent (an older crm-api)', null],
  ])('%s: the browser-drawn preview, no request for the service, no note', async (_name, service) => {
    await open({ service })
    await goTry()
    expect(await screen.findByTestId('crm-wizard-preview')).toBeTruthy()
    expect(screen.queryByTestId('crm-wizard-service-preview')).toBeNull()
    expect(screen.queryByTestId('crm-template-try-preview-note')).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(requests().filter((request) => /try-preview/.test(request))).toEqual([])
  })
})
