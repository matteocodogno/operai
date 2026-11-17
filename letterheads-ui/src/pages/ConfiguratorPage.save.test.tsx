/**
 * @vitest-environment jsdom
 *
 * ConfiguratorPage, the save (task T24; design F7, F9, S2, S3, S4; AC-4.1, AC-4.8, AC-8.2, AC-8.3, AC-8.8): Save as
 * version n+1 with `baseVersion`, a refused save (summary, sentence next to each control, focus on the first),
 * an unknown reason in words, a conflict that disables Save, a 403 that turns the page read-only, the failures of
 * a save, and the three guards on leaving. Mounted through `App`, so the requests are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { comparePointers } from '../lib/fieldPath'
import { axeViolations } from '../lib/formStateAxe'
import { catalogFixture, defaultConfigFixture, fullConfigFixture } from '../lib/formStateFixtures'
import type { FormConfig } from '../lib/formStateTypes'
import type { LetterheadList } from '../lib/types'
import { fakeApi, letterheadList, previewAnswer, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'

const { apiFetch, registerNavigationBlocker, unregister } = vi.hoisted(() => {
  const unregister = vi.fn()
  return { apiFetch: vi.fn(), unregister, registerNavigationBlocker: vi.fn(() => unregister) }
})
vi.mock('shell/session', () => ({
  apiFetch,
  registerNavigationBlocker,
  getLetterheadsApiBaseUrl: () => 'http://letterhead-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

import App from '../App'

const VERSIONS = '/v1/letterheads/welld_it/versions'
const savedList = letterheadList({
  welld_it: { activeVersion: 3, canManage: true },
  welld_ch: { activeVersion: 2, canManage: true },
})

const configWith = (top: number): FormConfig => {
  const config = defaultConfigFixture()
  config.margins.top = top
  return config
}

const versionRoute = (entity: string, n: number, config: FormConfig): Record<string, FakeHandler> => ({
  [`GET /v1/letterheads/${entity}/versions/${n}`]: () => ({
    status: 200,
    body: { version: n, layoutVersion: 1, config },
  }),
})

interface Options {
  list?: LetterheadList
  /** What `GET /v1/letterheads` answers from the second time on (after a write). */
  refreshed?: LetterheadList
  routes?: Record<string, FakeHandler>
  path?: string
}

async function renderPage({ list = savedList, refreshed, routes = {}, path = '/letterheads' }: Options = {}) {
  let listCalls = 0
  apiFetch.mockImplementation(
    fakeApi({
      'GET /v1/catalog': () => ({ status: 200, body: catalogFixture() }),
      'GET /v1/letterheads': () => ({ status: 200, body: ++listCalls > 1 && refreshed ? refreshed : list }),
      'POST /v1/letterheads/welld_it/preview': () => ({ status: 200, body: previewAnswer(1) }),
      'POST /v1/letterheads/welld_ch/preview': () => ({ status: 200, body: previewAnswer(1) }),
      ...versionRoute('welld_it', 3, configWith(25)),
      ...versionRoute('welld_ch', 2, configWith(40)),
      ...routes,
    }),
  )
  window.history.pushState(null, '', path)
  render(<App />)
  await screen.findByTestId('letterheads-page')
  await screen.findByTestId('letterheads-form')
}

const calls = (method: string, pathname: string) =>
  apiFetch.mock.calls.filter(
    ([url, init]) =>
      new URL(String(url)).pathname === pathname && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  )
const sentBodies = () => calls('POST', VERSIONS).map(([, init]) => JSON.parse((init as RequestInit).body as string))

const input = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement
const status = () => screen.getByTestId('letterheads-status').textContent
const save = () => screen.getByTestId('letterheads-save')
const heading = () => screen.getByTestId('letterheads-entity-heading')
const byPointer = (path: string) => document.querySelector<HTMLElement>(`[data-pointer="${path}"]`)!

async function edit(name: string | RegExp, value: string) {
  await userEvent.clear(input(name))
  await userEvent.type(input(name), value)
}

/** A deferred answer: the request is held until `release` is called. */
function held(answer: FakeAnswer): { handler: FakeHandler; release: () => void } {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  return {
    handler: async () => {
      await gate
      return answer
    },
    release,
  }
}

const refusal = (...problems: { path: string; reason: string; name?: string; language?: string }[]) =>
  problem(422, 'invalid_letterhead', { problems })
const created = (version: number): FakeAnswer => ({ status: 201, body: { version } })

beforeEach(() => {
  window.scrollTo = () => undefined
  if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
    Object.assign(globalThis, { CSS: { escape: (value: string) => value } })
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Save as version n+1 (F7.1, F7.2; AC-4.1)', () => {
  it('posts the form with the version it was loaded from, says so, and moves its baseline without rebuilding the form', async () => {
    await renderPage({
      refreshed: letterheadList({ welld_it: { activeVersion: 4, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: { [`POST ${VERSIONS}`]: () => created(4) },
    })
    expect(save().textContent).toBe('Save as version 4')
    expect(save().getAttribute('aria-disabled')).toBe('true')
    const formBefore = screen.getByTestId('letterheads-form')
    const topBefore = input('Top')

    await edit('Top', '30')
    expect(status()).toBe('Unsaved changes')
    expect(save().getAttribute('aria-disabled')).toBeNull()
    save().focus()
    await userEvent.click(save())

    const banner = await screen.findByTestId('letterheads-saved')
    expect(banner.textContent).toBe('Version 4 saved')
    expect(banner.getAttribute('role')).toBe('status')
    const [body, ...more] = sentBodies()
    expect(more).toEqual([])
    expect(body.baseVersion).toBe(3)
    expect(body.config.margins.top).toBe(30)
    expect(body.config).toEqual({ ...configWith(30) })

    expect(status()).toBe('No unsaved changes')
    expect(save().getAttribute('aria-disabled')).toBe('true')
    // Focus stays on the Save button; the form and its controls are the same elements (no remount, no reload).
    expect(document.activeElement).toBe(save())
    expect(screen.getByTestId('letterheads-form')).toBe(formBefore)
    expect(input('Top')).toBe(topBefore)
    expect(input('Top').value).toBe('30')
    expect(calls('GET', '/v1/letterheads/welld_it/versions/4')).toHaveLength(0)
    // The shell's list is refreshed, and the header shows the new active version.
    await waitFor(() => expect(calls('GET', '/v1/letterheads')).toHaveLength(2))
    expect(screen.getByText('Active version 4')).not.toBeNull()
    expect(save().textContent).toBe('Save as version 5')
  })

  it('shows the new version in the header at once, even when the refreshed list cannot be read', async () => {
    await renderPage({ routes: { [`POST ${VERSIONS}`]: () => created(4) } })
    // The second answer of the list is a failure: the header still says what the person just did.
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/letterheads': () => problem(503, 'service_unavailable'),
        [`POST ${VERSIONS}`]: () => created(4),
        'POST /v1/letterheads/welld_it/preview': () => ({ status: 200, body: previewAnswer(1) }),
      }),
    )
    await edit('Top', '31')
    await userEvent.click(save())
    await screen.findByTestId('letterheads-saved')
    await waitFor(() => expect(screen.getByText('Active version 4')).not.toBeNull())
  })

  it('sends baseVersion 0 for an entity with no version, and turns the empty state into version 1', async () => {
    await renderPage({
      list: letterheadList({ welld_it: { activeVersion: null, canManage: true }, welld_ch: savedList.welld_ch }),
      refreshed: letterheadList({ welld_it: { activeVersion: 1, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: { [`POST ${VERSIONS}`]: () => created(1) },
    })
    expect(save().textContent).toBe('Save as version 1')
    expect(screen.getByTestId('letterheads-empty-banner')).not.toBeNull()
    // The starting values are a form like any other: saving them as they are is a change from nothing (AC-4.1).
    await edit('Top', '26')
    await userEvent.click(save())
    expect((await screen.findByTestId('letterheads-saved')).textContent).toBe('Version 1 saved')
    expect(sentBodies()[0].baseVersion).toBe(0)
    expect(screen.queryByTestId('letterheads-empty-banner')).toBeNull()
    expect(save().textContent).toBe('Save as version 2')
    expect(screen.getByText('Active version 1')).not.toBeNull()
    expect(calls('GET', '/v1/letterheads/welld_it/versions/1')).toHaveLength(0)
    // The next save is on version 1.
    await edit('Top', '27')
    await userEvent.click(save())
    await waitFor(() => expect(sentBodies()).toHaveLength(2))
    expect(sentBodies()[1].baseVersion).toBe(1)
  })

  it('asks for nothing while there is nothing to save, and a second click while it runs is one request', async () => {
    const gate = held(created(4))
    await renderPage({ routes: { [`POST ${VERSIONS}`]: gate.handler } })
    await userEvent.click(save())
    expect(sentBodies()).toHaveLength(0)
    await edit('Top', '30')
    await userEvent.click(save())
    expect(save().getAttribute('aria-busy')).toBe('true')
    expect(status()).toBe('Saving…')
    await userEvent.click(save())
    await userEvent.click(save())
    gate.release()
    await screen.findByTestId('letterheads-saved')
    expect(sentBodies()).toHaveLength(1)
  })

  it('keeps what was typed while the save ran as unsaved changes', async () => {
    const gate = held(created(4))
    await renderPage({ routes: { [`POST ${VERSIONS}`]: gate.handler } })
    await edit('Top', '30')
    await userEvent.click(save())
    // The form is not locked: the person goes on typing in another field while the request runs.
    await edit('Bottom', '31')
    gate.release()
    await screen.findByTestId('letterheads-saved')
    expect(sentBodies()[0].config.margins).toMatchObject({ top: 30, bottom: 25 })
    expect(status()).toBe('Unsaved changes')
    expect(input('Bottom').value).toBe('31')
    expect(save().getAttribute('aria-disabled')).toBeNull()
  })
})

describe('a refused save (F7.3, S4; AC-8.3)', () => {
  // In the order the service found them, which is not the order of the page.
  const problems = [
    { path: '/variants/default/footer/left/0/text/en', reason: 'language_missing', language: 'en' },
    { path: '/variants/default/footer', reason: 'footer_overflow' },
    { path: '/margins/top', reason: 'out_of_range' },
  ]

  async function refused() {
    await renderPage({ routes: { [`POST ${VERSIONS}`]: () => refusal(...problems) } })
    await edit('Top', '3')
    await userEvent.click(save())
    return screen.findByTestId('letterheads-summary')
  }

  it('shows the summary as an alert, in page order, one button per refused value', async () => {
    const summary = await refused()
    expect(summary.getAttribute('role')).toBe('alert')
    expect(within(summary).getByText('Nothing was saved: 3 values were refused')).not.toBeNull()
    expect(
      within(summary)
        .getAllByTestId('letterheads-summary-item')
        .map((item) => item.textContent),
    ).toEqual([
      'Top margin: use a number between 5 and 100 mm.',
      expect.stringContaining(
        'Default page, footer: it does not fit the bottom margin, checked with every placeholder replaced by 40 characters.',
      ),
      'Default page, footer, left zone, line 1, English text: filled in one language but empty in English. Fill in both.',
    ])
    // Nothing was saved, so the form is as it was and the person can save again.
    expect(status()).toBe('Unsaved changes')
    expect(screen.queryByTestId('letterheads-saved')).toBeNull()
  })

  it('puts the sentence next to each control, and focus on the first refused control in page order', async () => {
    await refused()
    const top = input('Top')
    await waitFor(() => expect(document.activeElement).toBe(top))
    expect(top.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(top.getAttribute('aria-describedby')!.split(' ').at(-1)!)?.textContent).toContain(
      'Top margin: use a number between 5 and 100 mm.',
    )
    const english = byPointer('/variants/default/footer/left/0/text/en') as HTMLInputElement
    expect(english.getAttribute('aria-invalid')).toBe('true')
    expect(english.labels?.[0].textContent).toContain('Text, English')
    const described = english
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
    expect(described.join(' ')).toContain('filled in one language but empty in English')
    // A frame-level refusal sits under its heading and describes the frame's first control.
    const frame = document.querySelector('[data-frame="/variants/default/footer"]') as HTMLElement
    const error = frame.querySelector('p.field-error') as HTMLElement
    expect(error.textContent).toContain('it does not fit the bottom margin')
    expect(byPointer('/variants/default/footer/valign').getAttribute('aria-describedby')).toBe(error.id)
    // The summary is the announcement; the sentences next to the controls are not alerts of their own.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('goes to a control from the summary: the frame’s first control for a refusal of the frame', async () => {
    const summary = await refused()
    await userEvent.click(within(summary).getAllByTestId('letterheads-summary-item')[1])
    expect(document.activeElement).toBe(byPointer('/variants/default/footer/valign'))
    await userEvent.click(within(summary).getAllByTestId('letterheads-summary-item')[2])
    expect(document.activeElement).toBe(byPointer('/variants/default/footer/left/0/text/en'))
  })

  it('clears a control’s error when it is edited, keeps the others through a valid preview, and drops the summary when none is left', async () => {
    await refused()
    // Another control changes and the preview answers: a valid preview does not clear a refusal of the save.
    await edit('Right', '26')
    await waitFor(() => expect(calls('POST', '/v1/letterheads/welld_it/preview').length).toBeGreaterThan(1))
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(input('Top').getAttribute('aria-invalid')).toBe('true')
    expect(byPointer('/variants/default/footer/left/0/text/en').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByTestId('letterheads-summary')).not.toBeNull()
    // The control that is edited loses its error at once.
    await edit('Top', '30')
    expect(input('Top').getAttribute('aria-invalid')).toBeNull()
    expect(byPointer('/variants/default/footer/left/0/text/en').getAttribute('aria-invalid')).toBe('true')
    // Fixing the rest empties the summary.
    await userEvent.type(byPointer('/variants/default/footer/left/0/text/en'), 'x')
    await waitFor(() => expect(screen.queryByTestId('letterheads-summary')).toBeNull())
  })

  it('a second refusal replaces the first: a new summary, and focus on the first control again', async () => {
    let attempt = 0
    await renderPage({
      routes: {
        [`POST ${VERSIONS}`]: () =>
          ++attempt === 1
            ? refusal({ path: '/margins/bottom', reason: 'out_of_range' })
            : refusal({ path: '/margins/left', reason: 'not_a_number' }),
      },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    expect((await screen.findByTestId('letterheads-summary')).textContent).toContain('Bottom margin')
    await waitFor(() => expect(document.activeElement).toBe(input('Bottom')))
    await userEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('letterheads-summary').textContent).toContain('Left margin: enter a number.'),
    )
    expect(screen.getByTestId('letterheads-summary').textContent).not.toContain('Bottom margin')
    await waitFor(() => expect(document.activeElement).toBe(input('Left')))
  })

  it('falls back to words for a reason it does not know and for the three shape reasons, never a code', async () => {
    await renderPage({
      routes: {
        [`POST ${VERSIONS}`]: () =>
          refusal(
            { path: '/margins/top', reason: 'wrong_type' },
            { path: '/margins/bottom', reason: 'missing_member' },
            { path: '/margins/left', reason: 'unknown_member' },
            { path: '/margins/right', reason: 'reason_from_a_newer_service' },
          ),
      },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    const summary = await screen.findByTestId('letterheads-summary')
    const sentences = within(summary)
      .getAllByTestId('letterheads-summary-item')
      .map((item) => item.textContent)
    expect(sentences).toEqual([
      'Top margin: this value was refused.',
      'Bottom margin: this value was refused.',
      'Left margin: this value was refused.',
      'Right margin: this value was refused.',
    ])
    expect(document.body.textContent).not.toMatch(/wrong_type|missing_member|unknown_member|newer_service/)
    expect(input('Right').getAttribute('aria-invalid')).toBe('true')
  })

  it('has a sentence of its own for a square bracket that has no partner', async () => {
    await renderPage({
      routes: {
        [`POST ${VERSIONS}`]: () =>
          refusal({ path: '/variants/default/footer/right/0/text/it', reason: 'unbalanced_bracket', name: '[' }),
      },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    const summary = await screen.findByTestId('letterheads-summary')
    expect(summary.textContent).toContain('a square bracket has no partner. Write [[ or ]] to print a square bracket.')
    expect(summary.textContent).not.toContain('brace')
  })

  it('lists a refusal that has no control (the whole configuration) without a place to go, and still focuses the others', async () => {
    await renderPage({
      routes: {
        [`POST ${VERSIONS}`]: () =>
          refusal({ path: '', reason: 'asset_unknown' }, { path: '/margins/top', reason: 'out_of_range' }),
      },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    const summary = await screen.findByTestId('letterheads-summary')
    const items = within(summary).getAllByTestId('letterheads-summary-item')
    expect(items[0].textContent).toBe('This image is no longer available. Upload it again.')
    await waitFor(() => expect(document.activeElement).toBe(input('Top')))
    // Going to a value that has no control moves nothing and breaks nothing.
    await userEvent.click(items[0])
    expect(document.activeElement).toBe(items[0])
  })

  it('refuses the same way for a refusal at an upload’s asset, next to its file field', async () => {
    const config = fullConfigFixture()
    await renderPage({
      list: letterheadList({ welld_it: { activeVersion: 5, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: {
        ...versionRoute('welld_it', 5, config),
        [`POST ${VERSIONS}`]: () => refusal({ path: '/variants/first/logo/asset', reason: 'asset_unknown' }),
        'GET /v1/assets/3f2b8a52-9a5e-4e43-8b1d-0c5d1f2f7a10': () => ({ status: 404 }),
      },
    })
    await userEvent.clear(input('Top'))
    await userEvent.type(input('Top'), '31')
    await userEvent.click(save())
    await screen.findByTestId('letterheads-summary')
    await waitFor(() => expect(document.activeElement).toBe(byPointer('/variants/first/logo/asset')))
    const described = byPointer('/variants/first/logo/asset')
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
    expect(described.join(' ')).toContain('First page, logo, file: this image is no longer available. Upload it again.')
  })

  it('names the logo for a header that does not fit, and shows it under the logo’s height too', async () => {
    const config = fullConfigFixture()
    await renderPage({
      list: letterheadList({ welld_it: { activeVersion: 5, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: {
        ...versionRoute('welld_it', 5, config),
        [`POST ${VERSIONS}`]: () => refusal({ path: '/variants/default/header', reason: 'header_overflow' }),
      },
    })
    await userEvent.clear(input('Top'))
    await userEvent.type(input('Top'), '31')
    await userEvent.click(save())
    const summary = await screen.findByTestId('letterheads-summary')
    const sentence =
      'Default page, header: the logo (12.7 mm high) and the header lines do not fit the top margin. Raise the top margin, lower the logo or use fewer lines.'
    expect(within(summary).getByTestId('letterheads-summary-item').textContent).toBe(sentence)
    const height = byPointer('/variants/default/logo/heightMm')
    expect(height.getAttribute('aria-invalid')).toBe('true')
    const described = height
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
    expect(described.join(' ')).toContain(sentence)
    // Only the variant whose header was refused.
    expect(byPointer('/variants/first/logo/heightMm').getAttribute('aria-invalid')).toBeNull()
  })

  it('has no accessibility violations with the summary and the errors shown', async () => {
    await refused()
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('a newer version exists (F7.4, S3; AC-4.8)', () => {
  const conflict = (currentVersion?: number) =>
    problem(409, 'version_conflict', currentVersion ? { currentVersion } : {})

  async function conflicted(options: Options = {}) {
    await renderPage({ routes: { [`POST ${VERSIONS}`]: () => conflict(5) }, ...options })
    await edit('Top', '30')
    await userEvent.click(save())
    return screen.findByTestId('letterheads-conflict')
  }

  it('shows the banner first, keeps the form editable and readable, and disables Save until the reload', async () => {
    const banner = await conflicted()
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('A newer version was saved')
    expect(banner.textContent).toContain('Your changes are still in this form but were not saved.')
    expect(within(banner).getByRole('button', { name: 'Reload and discard my changes' })).not.toBeNull()
    // The banner is the first thing in the form.
    expect(screen.getByTestId('letterheads-form').firstElementChild?.firstElementChild).toBe(banner)
    expect(save().getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(save().getAttribute('aria-describedby')!)?.textContent).toBe('Reload first.')
    expect(input('Top').value).toBe('30')
    expect(input('Top').matches(':disabled')).toBe(false)
    // Edits go on, and Save sends nothing.
    await edit('Bottom', '31')
    await userEvent.click(save())
    expect(sentBodies()).toHaveLength(1)
    expect(status()).toBe('Unsaved changes')
    expect(screen.queryByTestId('letterheads-saved')).toBeNull()
  })

  it('reloads the newest version into the form: edits and errors gone, focus on the page heading, next save on that version', async () => {
    const banner = await conflicted({
      refreshed: letterheadList({ welld_it: { activeVersion: 5, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: {
        [`POST ${VERSIONS}`]: (() => {
          let attempt = 0
          return () => (++attempt === 1 ? conflict(5) : created(6))
        })(),
        ...versionRoute('welld_it', 5, configWith(44)),
      },
    })
    await userEvent.click(within(banner).getByTestId('letterheads-conflict-reload'))
    await waitFor(() => expect(screen.queryByTestId('letterheads-conflict')).toBeNull())
    expect(calls('GET', '/v1/letterheads/welld_it/versions/5')).toHaveLength(1)
    expect(input('Top').value).toBe('44')
    expect(status()).toBe('No unsaved changes')
    expect(save().textContent).toBe('Save as version 6')
    expect(save().getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(heading())
    expect(screen.getByText('Active version 5')).not.toBeNull()
    await edit('Top', '45')
    await userEvent.click(save())
    await screen.findByTestId('letterheads-saved')
    expect(sentBodies().at(-1).baseVersion).toBe(5)
  })

  it('finds the newest version in the list when the answer does not say which it is', async () => {
    await renderPage({
      refreshed: letterheadList({ welld_it: { activeVersion: 7, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: { [`POST ${VERSIONS}`]: () => conflict(), ...versionRoute('welld_it', 7, configWith(52)) },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    await userEvent.click(await screen.findByTestId('letterheads-conflict-reload'))
    await waitFor(() => expect(input('Top').value).toBe('52'))
    expect(screen.queryByTestId('letterheads-conflict')).toBeNull()
  })

  it('keeps the form, the banner and the edits when the newer version cannot be loaded, and says so', async () => {
    const banner = await conflicted({
      routes: {
        [`POST ${VERSIONS}`]: () => conflict(5),
        'GET /v1/letterheads/welld_it/versions/5': () => problem(500),
      },
    })
    await userEvent.click(within(banner).getByTestId('letterheads-conflict-reload'))
    const failed = await screen.findByTestId('letterheads-conflict-failed')
    expect(failed.getAttribute('role')).toBe('alert')
    expect(failed.textContent).toContain('The newer version could not be loaded.')
    expect(input('Top').value).toBe('30')
    expect(save().getAttribute('aria-disabled')).toBe('true')
    // And the person can try again.
    expect(
      within(screen.getByTestId('letterheads-conflict'))
        .getByTestId('letterheads-conflict-reload')
        .getAttribute('aria-busy'),
    ).toBeNull()
  })

  it('has no accessibility violations with the conflict banner shown', async () => {
    await conflicted()
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the person may no longer change the letterhead (F7.5, F10, F11)', () => {
  it.each(['forbidden', 'out_of_scope'])(
    'a 403 %s on save turns the page read-only and keeps the edits visible',
    async (code) => {
      await renderPage({ routes: { [`POST ${VERSIONS}`]: () => problem(403, code) } })
      await edit('Top', '30')
      await userEvent.click(save())
      const banner = await screen.findByTestId('letterheads-lost')
      expect(banner.textContent).toContain('You can no longer change this letterhead')
      expect(banner.textContent).toContain('Your changes are still visible here but were not saved.')
      expect(input('Top').value).toBe('30')
      expect(input('Top').matches(':disabled')).toBe(true)
      expect(screen.queryByTestId('letterheads-save')).toBeNull()
      expect(screen.queryByTestId('letterheads-status')).toBeNull()
      expect(screen.getByTestId('letterheads-preview-open')).not.toBeNull()
      // One banner says it, not two.
      expect(screen.queryByTestId('letterheads-readonly-banner')).toBeNull()
      // The list is refreshed, so the other entity's mode is right too, and leaving still asks: the edits are not saved.
      await waitFor(() => expect(calls('GET', '/v1/letterheads')).toHaveLength(2))
      expect(registerNavigationBlocker.mock.calls.length).toBeGreaterThan(0)
    },
  )

  it('a 403 on an upload does the same, not only the sentence of the field', async () => {
    await renderPage({ routes: { 'POST /v1/letterheads/welld_it/assets': () => problem(403, 'forbidden') } })
    const file = new File([new Uint8Array(16)], 'logo.png', { type: 'image/png' })
    await userEvent.upload(screen.getByTestId('asset-variants-default-background-input'), file)
    const banner = await screen.findByTestId('letterheads-lost')
    expect(banner).not.toBeNull()
    expect(input('Top').matches(':disabled')).toBe(true)
    expect(screen.queryByTestId('letterheads-save')).toBeNull()
    expect(screen.getByText('You can no longer change this letterhead, so the file was not uploaded.')).not.toBeNull()
  })

  it('an entity with none saved keeps its form on screen after a 403 (the list is not refreshed under it)', async () => {
    await renderPage({
      list: letterheadList({ welld_it: { activeVersion: null, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: { [`POST ${VERSIONS}`]: () => problem(403, 'forbidden') },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    await screen.findByTestId('letterheads-lost')
    expect(input('Top').value).toBe('30')
    expect(calls('GET', '/v1/letterheads')).toHaveLength(1)
  })

  it('has no Save, no status and no sticky bar for someone who cannot change the letterhead, only Preview', async () => {
    await renderPage({
      path: '/letterheads?entity=welld_it',
      list: letterheadList({ welld_it: { activeVersion: 3, canManage: false }, welld_ch: savedList.welld_ch }),
    })
    expect(screen.queryByTestId('letterheads-save')).toBeNull()
    expect(screen.queryByTestId('letterheads-status')).toBeNull()
    expect(screen.getByTestId('letterheads-preview-open')).not.toBeNull()
    expect(screen.getByTestId('letterheads-bar').className).toContain('xl:hidden')
  })
})

describe('a save that fails (F7.6)', () => {
  it('says nothing was saved, keeps the changes, and tries again on request', async () => {
    let attempt = 0
    await renderPage({
      routes: {
        [`POST ${VERSIONS}`]: () => (++attempt === 1 ? problem(503, 'service_unavailable') : created(4)),
      },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    const banner = await screen.findByTestId('letterheads-save-failed')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('The letterhead was not saved')
    expect(banner.textContent).toContain('Your changes are still here. Try again.')
    expect(input('Top').value).toBe('30')
    expect(status()).toBe('Unsaved changes')
    expect(save().getAttribute('aria-disabled')).toBeNull()
    await userEvent.click(within(banner).getByTestId('letterheads-save-retry'))
    await screen.findByTestId('letterheads-saved')
    expect(screen.queryByTestId('letterheads-save-failed')).toBeNull()
    expect(sentBodies()).toHaveLength(2)
  })

  it('treats a network failure the same way', async () => {
    await renderPage()
    apiFetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/preview')) return new Response(JSON.stringify(previewAnswer(1)), { status: 200 })
      throw new TypeError('Failed to fetch')
    })
    await edit('Top', '30')
    await userEvent.click(save())
    const banner = await screen.findByTestId('letterheads-save-failed')
    expect(banner.textContent).toContain('Your changes are still here. Try again.')
    expect(within(banner).getByTestId('letterheads-save-retry')).not.toBeNull()
  })

  it.each([
    ['422 invalid_request', problem(422, 'invalid_request'), 'The service did not accept this request.'],
    ['400 bad_request', problem(400, 'bad_request'), 'The service did not accept this request.'],
    [
      '422 unknown_layout',
      problem(422, 'unknown_layout'),
      'The page layout this form was made for is no longer available.',
    ],
    ['413 request_too_large', problem(413, 'request_too_large'), 'The letterhead is too large to save.'],
    ['422 invalid_letterhead with nothing to point at', refusal(), 'The service did not accept this request.'],
  ])('%s has its own sentence, and offers no retry that cannot work', async (_name, answer, sentence) => {
    await renderPage({ routes: { [`POST ${VERSIONS}`]: () => answer } })
    await edit('Top', '30')
    await userEvent.click(save())
    const banner = await screen.findByTestId('letterheads-save-failed')
    expect(banner.textContent).toContain(sentence)
    expect(screen.queryByTestId('letterheads-save-retry')).toBeNull()
    expect(screen.queryByTestId('letterheads-summary')).toBeNull()
  })

  it('a busy service is a retry, with its own sentence; a 5xx is the generic one', async () => {
    await renderPage({ routes: { [`POST ${VERSIONS}`]: () => problem(429, 'busy') } })
    await edit('Top', '30')
    await userEvent.click(save())
    const banner = await screen.findByTestId('letterheads-save-failed')
    expect(banner.textContent).toContain('The service is busy.')
    expect(within(banner).getByTestId('letterheads-save-retry')).not.toBeNull()
  })

  it('can be dismissed, and is gone when the next save starts', async () => {
    let attempt = 0
    await renderPage({
      routes: { [`POST ${VERSIONS}`]: () => (++attempt === 1 ? problem(500, 'internal_error') : created(4)) },
    })
    await edit('Top', '30')
    await userEvent.click(save())
    await userEvent.click(
      within(await screen.findByTestId('letterheads-save-failed')).getByRole('button', { name: 'Dismiss' }),
    )
    expect(screen.queryByTestId('letterheads-save-failed')).toBeNull()
    await userEvent.click(save())
    await screen.findByTestId('letterheads-saved')
  })
})

describe('leaving with unsaved changes (F9; AC-8.8)', () => {
  const blocker = () => registerNavigationBlocker.mock.calls.at(-1) as unknown as [() => boolean, string]

  it('asks before switching entity when the form holds changes: keep editing stays, switch and discard goes', async () => {
    await renderPage()
    await edit('Top', '30')
    await userEvent.click(screen.getByRole('tab', { name: 'wellD CH' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Leave without saving?')).not.toBeNull()
    expect(dialog.textContent).toContain(
      'You have unsaved changes to the letterhead of wellD IT. If you continue, they are lost.',
    )
    // Keep editing is the default, and it leaves everything as it was.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('tab', { name: 'wellD IT' }).getAttribute('aria-selected')).toBe('true')
    expect(input('Top').value).toBe('30')
    expect(window.location.search).not.toContain('welld_ch')
    // Now the other way.
    await userEvent.click(screen.getByRole('tab', { name: 'wellD CH' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Switch and discard' }))
    await waitFor(() => expect(input('Top').value).toBe('40'))
    expect(screen.getByRole('tab', { name: 'wellD CH' }).getAttribute('aria-selected')).toBe('true')
    expect(window.location.search).toContain('entity=welld_ch')
    expect(status()).toBe('No unsaved changes')
    expect(screen.getByTestId('letterheads-announcer').textContent).toContain('Showing wellD CH')
  })

  it('does not ask when there is nothing to lose, nor after the changes were saved', async () => {
    await renderPage({ routes: { [`POST ${VERSIONS}`]: () => created(4) } })
    await edit('Top', '30')
    await userEvent.click(save())
    await screen.findByTestId('letterheads-saved')
    await userEvent.click(screen.getByRole('tab', { name: 'wellD CH' }))
    await waitFor(() => expect(input('Top').value).toBe('40'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('does not ask for a form that was typed back to its saved value', async () => {
    await renderPage()
    await edit('Top', '30')
    await edit('Top', '25')
    expect(status()).toBe('No unsaved changes')
    await userEvent.click(screen.getByRole('tab', { name: 'wellD CH' }))
    await waitFor(() => expect(input('Top').value).toBe('40'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('registers the shell’s navigation blocker with the page’s message: blocking only while there are changes', async () => {
    await renderPage({ routes: { [`POST ${VERSIONS}`]: () => created(4) } })
    expect(registerNavigationBlocker).toHaveBeenCalled()
    const [shouldBlock, message] = blocker()
    expect(message).toBe('You have unsaved changes to the letterhead of wellD IT. If you continue, they are lost.')
    expect(shouldBlock()).toBe(false)
    await edit('Top', '30')
    expect(shouldBlock()).toBe(true)
    await userEvent.click(save())
    await screen.findByTestId('letterheads-saved')
    expect(shouldBlock()).toBe(false)
    await edit('Top', '31')
    expect(shouldBlock()).toBe(true)
  })

  it('registers it for the entity on screen, and takes it back when the page goes', async () => {
    await renderPage()
    expect(blocker()[1]).toContain('wellD IT')
    await userEvent.click(screen.getByRole('tab', { name: 'wellD CH' }))
    await waitFor(() => expect(blocker()[1]).toContain('wellD CH'))
    cleanup()
    expect(unregister).toHaveBeenCalled()
  })

  it('counts an upload that has not answered as a change', async () => {
    const gate = held({
      status: 201,
      body: { id: '7b1c9d20-6f41-4d0a-9d3e-5a2f8c4e1b66', kind: 'background', format: 'png', width: 10, height: 10 },
    })
    await renderPage({ routes: { 'POST /v1/letterheads/welld_it/assets': gate.handler } })
    const [shouldBlock] = blocker()
    expect(shouldBlock()).toBe(false)
    await userEvent.upload(
      screen.getByTestId('asset-variants-default-background-input'),
      new File([new Uint8Array(16)], 'bg.png', { type: 'image/png' }),
    )
    expect(shouldBlock()).toBe(true)
    await userEvent.click(screen.getByRole('tab', { name: 'wellD CH' }))
    expect(await screen.findByRole('alertdialog')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    gate.release()
    // The file is in the form now: still a change, until it is saved.
    await waitFor(() => expect(status()).toBe('Unsaved changes'))
    expect(shouldBlock()).toBe(true)
  })

  it('warns when the tab is closed or reloaded, only while there are changes', async () => {
    await renderPage()
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    await edit('Top', '30')
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    cleanup()
    const gone = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(gone)
    expect(gone.defaultPrevented).toBe(false)
  })

  it('still works in a shell that has no navigation blocker (the browser prompt remains)', async () => {
    registerNavigationBlocker.mockImplementationOnce(() => {
      throw new Error('registerNavigationBlocker is not defined')
    })
    await renderPage()
    await edit('Top', '30')
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
  })
})

describe('the Preview button sits in the save bar (T22 seam)', () => {
  it('opens the preview in the drawer from the bar', async () => {
    await renderPage()
    const bar = screen.getByTestId('letterheads-bar')
    await userEvent.click(within(bar).getByTestId('letterheads-preview-open'))
    expect(await screen.findByRole('dialog')).not.toBeNull()
    expect(
      within(screen.getByRole('dialog')).getByRole('region', { name: 'Preview of the sample document' }),
    ).not.toBeNull()
  })
})

describe('the page order of the controls', () => {
  it('is the order comparePointers gives, for every control of a form that uses everything', async () => {
    await renderPage({
      list: letterheadList({ welld_it: { activeVersion: 5, canManage: true }, welld_ch: savedList.welld_ch }),
      routes: versionRoute('welld_it', 5, fullConfigFixture()),
    })
    const inDocument = Array.from(
      new Set(Array.from(document.querySelectorAll('[data-pointer]')).map((el) => el.getAttribute('data-pointer')!)),
    )
    expect(inDocument.length).toBeGreaterThan(100)
    expect(inDocument).toEqual([...inDocument].sort(comparePointers))
    // A group's pointer is ahead of the controls inside it, wherever the page shows its error.
    for (const frame of Array.from(document.querySelectorAll<HTMLElement>('[data-frame]'))) {
      const first = frame.querySelector('[data-pointer]')!.getAttribute('data-pointer')!
      expect(comparePointers(frame.getAttribute('data-frame')!, first)).toBeLessThan(0)
    }
  })
})

describe('the save controls under the form’s other states', () => {
  it('has no accessibility violations on a clean and a dirty form', async () => {
    await renderPage()
    expect(await axeViolations(document.body)).toEqual([])
    await edit('Top', '30')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
