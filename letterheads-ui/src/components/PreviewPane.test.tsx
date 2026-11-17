/**
 * @vitest-environment jsdom
 *
 * The live preview in the configurator (task T22; design F3, F4, S7; AC-8.4, 8.5, 8.6, 5.8): an edit asks for one
 * debounced request; an in-flight request is never aborted by an edit (the service kills its worker) and a stale
 * answer is discarded; a failure keeps the pages and leaves the form usable; the language switch asks again;
 * every page has its alt and its text. Mounted through `App`, so the requests are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LatestResultBusyError } from '@operai/ui'
import { catalogFixture } from '../lib/formStateFixtures'
import { axeViolations } from '../lib/formStateAxe'
import { fakeApi, letterheadList, previewAnswer } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getLetterheadsApiBaseUrl: () => 'http://letterhead-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

import App from '../App'
import { resetManageableLegalEntities } from '../hooks/useCanManageLegalEntity'
import { describePreview, PreviewRefusedError, requestPreview } from './PreviewPaneRequest'
import type { PreviewInput } from './PreviewPaneRequest'
import { defaultConfigFixture } from '../lib/formStateFixtures'

type Sent = {
  url: string
  body: { config: { margins: { top: number | string } }; language: string; layoutVersion?: number }
  signal: AbortSignal | undefined
}
type Reply = Response | Promise<Response>

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const problemBody = (status: number, code: string, extras: Record<string, unknown> = {}) => ({
  type: 'about:blank',
  title: 'Problem',
  status,
  code,
  ...extras,
})
const answer = (count: number, tag = 'a') => json(200, previewAnswer(count, tag))

function deferred() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => (resolve = done))
  return { promise, resolve }
}

/** `previews[i]` answers the i-th preview request (the last one answers every later one). */
async function renderPage({
  previews,
  manageable = [],
  manageableRoute,
  list = letterheadList({
    welld_it: { activeVersion: null, canManage: true },
    welld_ch: { activeVersion: null, canManage: true },
  }),
}: {
  previews: Array<(sent: Sent) => Reply>
  /** The entities `GET /legal-entities/manageable` lists (a person who manages none by default). */
  manageable?: string[]
  /** Replaces the answer of `manageable` (a pending or failing one). */
  manageableRoute?: FakeHandler
  list?: ReturnType<typeof letterheadList>
}) {
  const sent: Sent[] = []
  const base = fakeApi({
    'GET /v1/catalog': () => ({ status: 200, body: catalogFixture() }),
    'GET /v1/letterheads': () => ({ status: 200, body: list }),
    'GET /legal-entities/manageable': manageableRoute ?? (() => ({ status: 200, body: { entities: manageable } })),
  })
  apiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.endsWith('/preview')) return base(input, init)
    const entry: Sent = { url, body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined }
    sent.push(entry)
    return previews[Math.min(sent.length, previews.length) - 1](entry)
  })
  window.history.pushState(null, '', '/letterheads')
  const view = render(<App />)
  await screen.findByTestId('letterheads-form')
  return { sent, ...view }
}

const region = () => screen.getByRole('region', { name: 'Preview of the sample document' })
const pageImages = () => within(region()).queryAllByRole('img') as HTMLImageElement[]
const top = () => screen.getByRole('textbox', { name: 'Top' }) as HTMLInputElement
const edit = (value: string) => fireEvent.change(top(), { target: { value } })
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms))

beforeEach(() => {
  resetManageableLegalEntities()
  window.scrollTo = () => undefined
  document.documentElement.removeAttribute('lang')
  if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
    Object.assign(globalThis, { CSS: { escape: (value: string) => value } })
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.documentElement.removeAttribute('lang')
})

describe('the first preview (F3.1, F3.6; AC-8.5, 8.6)', () => {
  it('asks at once for the sample on the form as it is, says where the details come from, and shows each page with its alt and text', async () => {
    const { sent } = await renderPage({ previews: [() => answer(2)] })
    expect(region().getAttribute('aria-busy')).toBe('true')
    expect(within(region()).getByText('Preparing the preview…')).not.toBeNull()
    await waitFor(() => expect(pageImages()).toHaveLength(2))

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('http://letterhead-api.test/v1/letterheads/welld_it/preview')
    expect(sent[0].body).toEqual({ config: catalogFixture().defaultConfig, language: 'en' })
    expect(sent[0].body).not.toHaveProperty('layoutVersion')

    expect(screen.getByTestId('letterheads-preview-source').textContent).toBe(
      'The company details (name, address, VAT number, IBAN, contacts) are the real ones from Legal entities, in the preview language. The body of the page is sample text. An administrator keeps them in Legal entities.',
    )
    expect(region().getAttribute('aria-busy')).toBe('false')
    expect(within(region()).getByText('2 pages')).not.toBeNull()
    const [first, second] = pageImages()
    expect(first.getAttribute('alt')).toBe('Page 1 of 2')
    expect(second.getAttribute('alt')).toBe('Page 2 of 2')
    const figure = first.closest('figure') as HTMLElement
    const caption = figure.querySelector('figcaption') as HTMLElement
    expect(caption.textContent).toBe('Text a of page 1')
    expect(caption.getAttribute('lang')).toBe('en')
    // No other call: the details are the service's own (AC-8.5); the one extra is the UX gate of the link (E2).
    const others = apiFetch.mock.calls.map(([url]) => String(url)).filter((url) => !url.endsWith('/preview'))
    expect(others).toHaveLength(3)
    expect(others).toEqual(
      expect.arrayContaining([
        'http://letterhead-api.test/v1/catalog',
        'http://letterhead-api.test/v1/letterheads',
        'http://auth.test/legal-entities/manageable',
      ]),
    )
  })

  it('makes the sample in the person’s language at first (F3.6)', async () => {
    document.documentElement.setAttribute('lang', 'it')
    const { sent } = await renderPage({ previews: [() => answer(1)] })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    expect(sent[0].body.language).toBe('it')
    // The catalogs are chosen once at load (English here); the preview's own language is the person's.
    expect(screen.getByRole('radio', { name: 'Italian' })).toHaveProperty('checked', true)
    expect((pageImages()[0].closest('figure') as HTMLElement).querySelector('figcaption')?.getAttribute('lang')).toBe(
      'it',
    )
  })
})

describe('edits (F3.1, F3.2, F3.3; AC-8.6)', () => {
  it('asks once, 300 ms after the last of several quick edits, with the unsaved form', async () => {
    const { sent } = await renderPage({ previews: [() => answer(1)] })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    edit('27')
    edit('28')
    expect(sent).toHaveLength(1)
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1].body.config.margins.top).toBe(28)
    await settle(500)
    expect(sent).toHaveLength(2)
  })

  it('keeps the previous pages, with a busy region and the status, while the next are made', async () => {
    const next = deferred()
    const { sent } = await renderPage({ previews: [() => answer(1, 'old'), () => next.promise] })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(region().getAttribute('aria-busy')).toBe('true')
    expect(within(region()).getByText('Updating the preview…')).not.toBeNull()
    expect(pageImages()).toHaveLength(1)
    expect(region().querySelector('figcaption')?.textContent).toBe('Text old of page 1')
    next.resolve(answer(3, 'new'))
    await waitFor(() => expect(pageImages()).toHaveLength(3))
    expect(region().getAttribute('aria-busy')).toBe('false')
    expect(region().querySelector('figcaption')?.textContent).toBe('Text new of page 1')
  })

  it('never aborts a request in flight on an edit (the service kills its worker); only leaving does', async () => {
    const second = deferred()
    const third = deferred()
    const { sent, unmount } = await renderPage({
      previews: [() => answer(1), () => second.promise, () => third.promise],
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    await waitFor(() => expect(sent).toHaveLength(2))
    edit('27')
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[1].signal).toBeDefined()
    expect(sent[1].signal?.aborted).toBe(false)
    expect(sent[2].signal?.aborted).toBe(false)
    unmount()
    expect(sent[1].signal?.aborted).toBe(true)
    expect(sent[2].signal?.aborted).toBe(true)
    second.resolve(answer(1))
    third.resolve(answer(1))
  })

  it('discards the answer of an older request that arrives after a newer one', async () => {
    const second = deferred()
    const third = deferred()
    const { sent } = await renderPage({
      previews: [() => answer(1, 'first'), () => second.promise, () => third.promise],
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    await waitFor(() => expect(sent).toHaveLength(2))
    edit('27')
    await waitFor(() => expect(sent).toHaveLength(3))

    third.resolve(answer(1, 'third'))
    await waitFor(() => expect(region().querySelector('figcaption')?.textContent).toBe('Text third of page 1'))
    second.resolve(answer(4, 'second'))
    await settle(100)
    expect(region().querySelector('figcaption')?.textContent).toBe('Text third of page 1')
    expect(pageImages()).toHaveLength(1)
    expect(region().getAttribute('aria-busy')).toBe('false')
  })

  it('discards an older answer that arrives while the newest is still awaited, and keeps the pages shown', async () => {
    const second = deferred()
    const third = deferred()
    const { sent } = await renderPage({
      previews: [() => answer(1, 'first'), () => second.promise, () => third.promise],
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    await waitFor(() => expect(sent).toHaveLength(2))
    edit('27')
    await waitFor(() => expect(sent).toHaveLength(3))
    second.resolve(answer(4, 'second'))
    await settle(100)
    expect(region().querySelector('figcaption')?.textContent).toBe('Text first of page 1')
    expect(region().getAttribute('aria-busy')).toBe('true')
    third.resolve(answer(1, 'third'))
    await waitFor(() => expect(region().querySelector('figcaption')?.textContent).toBe('Text third of page 1'))
  })
})

describe('a failure (F3.5; AC-8.6)', () => {
  it('keeps the pages, says so politely with Try again, leaves the form usable, and Try again asks at once', async () => {
    const { sent } = await renderPage({
      previews: [() => answer(1, 'old'), () => json(500, problemBody(500, 'internal')), () => answer(2, 'again')],
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    const notice = await screen.findByTestId('letterheads-preview-failed')
    expect(notice.getAttribute('role')).toBe('status')
    expect(within(notice).getByText('The preview could not be updated')).not.toBeNull()
    expect(notice.textContent).toContain('Your changes are kept and you can still save.')
    expect(within(region()).getByText('Could not update')).not.toBeNull()
    expect(region().getAttribute('aria-busy')).toBe('false')
    expect(pageImages()).toHaveLength(1)
    expect(region().querySelector('figcaption')?.textContent).toBe('Text old of page 1')
    expect(screen.queryAllByRole('alert')).toHaveLength(0)

    // The form is usable: typing goes on and the value is kept.
    await userEvent.type(top(), '7')
    expect(top().value).toBe('267')
    expect(top().disabled).toBe(false)

    // Not retried by itself (only `busy` is): the next request is the person's.
    const before = sent.length
    await userEvent.click(within(notice).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(pageImages()).toHaveLength(2))
    expect(sent.length).toBeGreaterThan(before)
    expect(screen.queryByTestId('letterheads-preview-failed')).toBeNull()
  })

  it('says there is no preview yet when the first one fails, and never leaves the region empty', async () => {
    await renderPage({ previews: [() => json(503, problemBody(503, 'service_unavailable'))] })
    const notice = await screen.findByTestId('letterheads-preview-failed')
    expect(notice.textContent).toContain('There is no preview yet.')
    expect(screen.getByTestId('page-preview-placeholder')).not.toBeNull()
  })

  it('treats a network failure and an answer that is not the contract’s as a failure', async () => {
    await renderPage({
      previews: [
        () => answer(1),
        () => Promise.reject(new TypeError('Failed to fetch')),
        () => json(200, { pages: [{ n: 1 }] }),
      ],
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    await screen.findByTestId('letterheads-preview-failed')
    edit('27')
    await waitFor(() => expect(screen.queryByTestId('letterheads-preview-failed')).not.toBeNull())
    expect(pageImages()).toHaveLength(1)
  })

  it('retries `busy` once after Retry-After, by itself, without a notice', async () => {
    const { sent } = await renderPage({
      previews: [() => json(429, problemBody(429, 'busy'), { 'Retry-After': '0' }), () => answer(1, 'later')],
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    expect(sent).toHaveLength(2)
    expect(screen.queryByTestId('letterheads-preview-failed')).toBeNull()
  })

  it('counts a second `busy` as a failure', async () => {
    const { sent } = await renderPage({
      previews: [() => json(429, problemBody(429, 'busy'), { 'Retry-After': '0' })],
    })
    await screen.findByTestId('letterheads-preview-failed')
    expect(sent).toHaveLength(2)
  })
})

describe('refused values (F3.4; AC-8.3)', () => {
  const refusal = () =>
    json(422, problemBody(422, 'invalid_letterhead', { problems: [{ path: '/margins/top', reason: 'out_of_range' }] }))

  it('keeps the pages, shows the info notice with no summary, marks the control, and clears it when the form is valid', async () => {
    const { sent } = await renderPage({ previews: [() => answer(1, 'ok'), refusal, () => answer(1, 'fixed')] })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('500')
    const notice = await screen.findByTestId('letterheads-preview-refused')
    expect(notice.getAttribute('role')).toBe('note')
    expect(within(notice).getByText('The preview shows the last valid form')).not.toBeNull()
    expect(notice.textContent).toContain('Go to each one:')
    // One link per refused value, in words; it moves focus to the control (the header can be far above).
    const link = within(notice).getByTestId('letterheads-preview-refused-item')
    expect(link.textContent).toBe('Top margin: use a number between 5 and 100 mm.')
    expect(screen.queryByTestId('letterheads-preview-failed')).toBeNull()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(region().getAttribute('aria-busy')).toBe('false')
    expect(within(region()).queryByText('Could not update')).toBeNull()
    expect(region().querySelector('figcaption')?.textContent).toBe('Text ok of page 1')

    // Marked next to the control (a render after the notice's), without moving focus, and announced politely with its count.
    await waitFor(() => expect(top().getAttribute('aria-invalid')).toBe('true'))
    expect(document.activeElement).not.toBe(top())
    expect(screen.getByTestId('letterheads-announcer').textContent?.trim()).toBe('1 value is refused')
    fireEvent.click(
      within(screen.getByTestId('letterheads-preview-refused')).getByTestId('letterheads-preview-refused-item'),
    )
    expect(document.activeElement).toBe(top())

    edit('30')
    await waitFor(() => expect(screen.queryByTestId('letterheads-preview-refused')).toBeNull())
    expect(sent).toHaveLength(3)
    expect(top().getAttribute('aria-invalid')).toBeNull()
    expect(region().querySelector('figcaption')?.textContent).toBe('Text fixed of page 1')
  })

  it('shows the placeholder, not a blank, when the very first preview is refused, and does not call it a failure', async () => {
    await renderPage({ previews: [refusal] })
    await screen.findByTestId('letterheads-preview-refused')
    expect(screen.getByTestId('page-preview-placeholder')).not.toBeNull()
    expect(screen.queryByTestId('letterheads-preview-failed')).toBeNull()
  })

  it('ignores a refusal with no readable problems without crashing', async () => {
    await renderPage({ previews: [() => json(422, problemBody(422, 'invalid_letterhead', { problems: 'nope' }))] })
    await screen.findByTestId('letterheads-preview-refused')
  })
})

describe('the preview language (F4; AC-5.8)', () => {
  it('asks again with the other language, leaves the form as it is, and labels the new pages in it', async () => {
    const { sent } = await renderPage({ previews: [() => answer(1, 'en'), () => answer(2, 'it')] })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    edit('26')
    await waitFor(() => expect(sent).toHaveLength(2))
    await userEvent.click(screen.getByRole('radio', { name: 'Italian' }))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2].body.language).toBe('it')
    expect(sent[2].body.config).toEqual(sent[1].body.config)
    expect(top().value).toBe('26')
    await waitFor(() => expect(pageImages()).toHaveLength(2))
    expect(region().querySelector('figcaption')?.getAttribute('lang')).toBe('it')
    // The text inputs are not filtered by it: Italian and English are both there.
    expect(screen.getAllByRole('textbox', { name: 'Text, English' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('textbox', { name: 'Text, Italian' }).length).toBeGreaterThan(0)
  })
})

describe('the source of the company details (AC-5.4, 8.1, 8.2; plan E2, E3, E7)', () => {
  it('drops the old sample-data sentence and shows the legend of the missing look', async () => {
    await renderPage({ previews: [() => answer(1)] })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    expect(document.body.textContent).not.toMatch(/sample company data|Nothing here is read from the CRM/)
    const legend = screen.getByTestId('letterheads-preview-legend')
    expect(legend.textContent).toBe('⟦Label⟧A detail that is not filled in yet.')
    expect(within(legend).getByText('⟦Label⟧').className).toContain('bg-paper-mark')
  })

  it('links a person who may manage the entity to its Legal entities tab, and follows the entity', async () => {
    await renderPage({ previews: [() => answer(1)], manageable: ['welld_it'] })
    const link = (await screen.findByRole('link', { name: 'Edit them in Legal entities' })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_it')
    expect(screen.getByTestId('letterheads-preview-source').textContent).not.toContain('An administrator keeps')
    // The other entity: the person manages only welld_it, so the sentence, no link.
    await userEvent.click(screen.getByRole('tab', { name: /welld ch|WellD CH/i }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Edit them in Legal entities' })).toBeNull())
    expect(screen.getByTestId('letterheads-preview-source').textContent).toContain('An administrator keeps them')
  })

  it('shows the sentence, never the link, while the answer is pending (fails closed)', async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))
    await renderPage({
      previews: [() => answer(1)],
      manageableRoute: async () => {
        await gate
        return { status: 200, body: { entities: ['welld_it'] } }
      },
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    expect(screen.queryByRole('link', { name: 'Edit them in Legal entities' })).toBeNull()
    expect(screen.getByTestId('letterheads-preview-source').textContent).toContain('An administrator keeps them')
    release()
    expect(await screen.findByRole('link', { name: 'Edit them in Legal entities' })).not.toBeNull()
  })

  it('shows the sentence, never the link, when the answer fails (fails closed)', async () => {
    await renderPage({
      previews: [() => answer(1)],
      manageableRoute: () => ({ status: 503, body: { status: 503, title: 'Down' } }),
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    await waitFor(() =>
      expect(apiFetch.mock.calls.some(([url]) => String(url).endsWith('/legal-entities/manageable'))).toBe(true),
    )
    await settle(0)
    expect(screen.queryByRole('link', { name: 'Edit them in Legal entities' })).toBeNull()
    expect(screen.getByTestId('letterheads-preview-source').textContent).toContain('An administrator keeps them')
  })

  it('has no accessibility violations with the link and the legend', async () => {
    const { container } = await renderPage({ previews: [() => answer(1)], manageable: ['welld_it'] })
    await screen.findByRole('link', { name: 'Edit them in Legal entities' })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('the registry could not be read (issuerDetails "unavailable")', () => {
  const unavailable = () =>
    json(200, { ...previewAnswer(1, 'u'), issuerDetails: 'unavailable', legalEntityVersion: null })

  it('keeps the pages and shows a warning with Try again in the preview slot; the form and Save are unaffected', async () => {
    const { sent } = await renderPage({ previews: [unavailable, () => answer(1, 'b')] })
    const notice = await screen.findByTestId('letterheads-preview-unavailable')
    expect(within(region()).getByTestId('letterheads-preview-unavailable')).toBe(notice)
    expect(notice.textContent).toContain('The company details could not be read')
    expect(notice.textContent).toContain('Every company detail is shown as missing.')
    expect(pageImages()).toHaveLength(1)
    expect(screen.queryByTestId('letterheads-preview-failed')).toBeNull()
    // The form stays editable and Save is not disabled by it.
    expect(top().matches(':disabled')).toBe(false)
    expect(screen.getByRole('button', { name: /^Save/ }).hasAttribute('disabled')).toBe(false)

    await userEvent.click(within(notice).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    await waitFor(() => expect(screen.queryByTestId('letterheads-preview-unavailable')).toBeNull())
    expect(pageImages()).toHaveLength(1)
  })

  it('has no accessibility violations with the notice', async () => {
    const { container } = await renderPage({ previews: [unavailable] })
    await screen.findByTestId('letterheads-preview-unavailable')
    expect(await axeViolations(container)).toEqual([])
  })

  it('is not shown for a current answer, nor for an answer that does not name the member', async () => {
    await renderPage({
      previews: [() => json(200, { ...previewAnswer(1), issuerDetails: 'current', legalEntityVersion: 4 })],
    })
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    expect(screen.queryByTestId('letterheads-preview-unavailable')).toBeNull()
  })
})

describe('below xl: the Drawer (S1)', () => {
  it('opens the same preview from the bar’s Preview button without asking again, and closing loses nothing', async () => {
    const { sent } = await renderPage({ previews: [() => answer(2)] })
    await waitFor(() => expect(pageImages()).toHaveLength(2))
    const open = screen.getByRole('button', { name: 'Preview' })
    expect(open.getAttribute('aria-haspopup')).toBe('dialog')
    await userEvent.click(open)
    const drawer = await screen.findByRole('dialog', { name: 'Preview' })
    expect(within(drawer).getAllByRole('img')).toHaveLength(2)
    expect(within(drawer).getByRole('region', { name: 'Preview of the sample document' })).not.toBeNull()
    expect(within(drawer).getByText(/are the real ones from Legal entities/)).not.toBeNull()
    expect(sent).toHaveLength(1)
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close the preview' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pageImages()).toHaveLength(2)
    expect(sent).toHaveLength(1)
  })
})

describe('a person who may not change the letterhead (AC-8.2)', () => {
  it('still sees the preview of the entity', async () => {
    const list = letterheadList({
      welld_it: { activeVersion: 3, canManage: false },
      welld_ch: { activeVersion: null, canManage: false },
    })
    const version = { version: 3, layoutVersion: 1, config: catalogFixture().defaultConfig }
    const base = fakeApi({
      'GET /v1/catalog': () => ({ status: 200, body: catalogFixture() }),
      'GET /v1/letterheads': () => ({ status: 200, body: list }),
      'GET /v1/letterheads/welld_it/versions/3': () => ({ status: 200, body: version }),
    })
    apiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/preview') ? answer(1) : base(input, init),
    )
    window.history.pushState(null, '', '/letterheads?entity=welld_it')
    render(<App />)
    await waitFor(() => expect(pageImages()).toHaveLength(1))
    expect(top().matches(':disabled')).toBe(true)
  })
})

describe('requestPreview and describePreview', () => {
  const input: PreviewInput = { entity: 'welld_ch', config: defaultConfigFixture(), language: 'it', layoutVersion: 2 }

  it('posts the config, the language and the layout of a stored version (G6)', async () => {
    apiFetch.mockResolvedValue(answer(1))
    const result = await requestPreview(input)
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://letterhead-api.test/v1/letterheads/welld_ch/preview')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ config: input.config, language: 'it', layoutVersion: 2 })
    expect(result.language).toBe('it')
    expect(result.pages).toHaveLength(1)
    expect(result).toMatchObject({ issuerDetails: 'current', legalEntityVersion: null })
  })

  it('reads issuerDetails and legalEntityVersion of the answer', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { ...previewAnswer(1), issuerDetails: 'current', legalEntityVersion: 7 }))
    await expect(requestPreview(input)).resolves.toMatchObject({ issuerDetails: 'current', legalEntityVersion: 7 })
    apiFetch.mockResolvedValueOnce(
      json(200, { ...previewAnswer(1), issuerDetails: 'unavailable', legalEntityVersion: null }),
    )
    await expect(requestPreview(input)).resolves.toMatchObject({
      issuerDetails: 'unavailable',
      legalEntityVersion: null,
    })
  })

  it('maps 422 invalid_letterhead to the refused problems, keeping only well-formed entries', async () => {
    apiFetch.mockResolvedValue(
      json(
        422,
        problemBody(422, 'invalid_letterhead', {
          problems: [
            { path: '/margins/top', reason: 'out_of_range' },
            { path: 3 },
            { path: '/a', reason: 'empty_text', name: 'x', language: 'it' },
          ],
        }),
      ),
    )
    const error = await requestPreview(input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PreviewRefusedError)
    expect((error as PreviewRefusedError).problems).toEqual([
      { path: '/margins/top', reason: 'out_of_range' },
      { path: '/a', reason: 'empty_text', name: 'x', language: 'it' },
    ])
  })

  it('maps 429 busy to the library’s busy error with the service’s Retry-After (2 s when it names none)', async () => {
    apiFetch.mockResolvedValueOnce(json(429, problemBody(429, 'busy'), { 'Retry-After': '3' }))
    await expect(requestPreview(input)).rejects.toMatchObject({ retryAfterMs: 3000 })
    apiFetch.mockResolvedValueOnce(json(429, problemBody(429, 'busy')))
    const error = await requestPreview(input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LatestResultBusyError)
    expect((error as LatestResultBusyError).retryAfterMs).toBe(2000)
  })

  it('leaves a 503 and a 422 of another code as the failures they are', async () => {
    apiFetch.mockResolvedValueOnce(json(503, problemBody(503, 'service_unavailable'), { 'Retry-After': '2' }))
    await expect(requestPreview(input)).rejects.toMatchObject({ status: 503 })
    apiFetch.mockResolvedValueOnce(json(422, problemBody(422, 'unsupported_language')))
    await expect(requestPreview(input)).rejects.toMatchObject({ status: 422, code: 'unsupported_language' })
  })

  it('describes each state of the request (S7): never an empty region, previous pages kept', () => {
    const pages = [{ image: 'aW1n', text: 't' }]
    const result = { language: 'en' as const, pages, issuerDetails: 'current' as const, legalEntityVersion: 3 }
    const entity = 'welld_it' as const
    const refusal = new PreviewRefusedError([])
    expect(
      describePreview({ status: 'pending', result: undefined, error: undefined, lastRefusal: null, entity }),
    ).toMatchObject({
      state: 'loading',
      pages: [],
    })
    expect(describePreview({ status: 'pending', result, error: undefined, lastRefusal: null, entity })).toMatchObject({
      state: 'updating',
      pages,
    })
    expect(describePreview({ status: 'ready', result, error: undefined, lastRefusal: null, entity })).toMatchObject({
      state: 'ready',
      refused: null,
      failed: false,
      issuerUnavailable: false,
      entity: 'welld_it',
    })
    expect(
      describePreview({
        status: 'ready',
        result: { ...result, issuerDetails: 'unavailable', legalEntityVersion: null },
        error: undefined,
        lastRefusal: null,
        entity,
      }),
    ).toMatchObject({ state: 'ready', issuerUnavailable: true })
    expect(
      describePreview({ status: 'failed', result, error: new Error('x'), lastRefusal: null, entity }),
    ).toMatchObject({
      state: 'failed',
      failed: true,
      pages,
    })
    expect(describePreview({ status: 'failed', result, error: refusal, lastRefusal: refusal, entity })).toMatchObject({
      state: 'ready',
      refused: 0,
      failed: false,
      pages,
    })
  })
})
