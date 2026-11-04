/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDateTime } from '@operai/ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: () => 'http://meetings.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

import { apiFetch } from 'shell/session'
import { en } from '../../strings'
import type { Meeting, Summary, Template } from '../../lib/types'
import {
  CAN_NONE,
  crmDealHost,
  fakeApi,
  problem,
  readyMeeting,
  summary,
  template,
  type FakeHandler,
} from '../../test-support/fakeApi'
import SummariesPanel from './SummariesPanel'

const serve = (routes: Record<string, FakeHandler>) => {
  const api = fakeApi(routes)
  vi.mocked(apiFetch).mockImplementation(api as unknown as typeof apiFetch)
  return api
}

const list = (items: Summary[]): Record<string, FakeHandler> => ({
  'GET /meetings/:id/summaries': () => ({ status: 200, body: { items } }),
})

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body))

const panel = (meeting: Meeting = readyMeeting(), hostInfo = null as typeof crmDealHost | null) => {
  const onChanged = vi.fn()
  render(<SummariesPanel meeting={meeting} hostInfo={hostInfo} onChanged={onChanged} />)
  return { onChanged }
}

const callsTo = (api: ReturnType<typeof fakeApi>, method: string, suffix: string) =>
  api.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && String(url).endsWith(suffix))

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('summary cards (AC-7.2, AC-7.11)', () => {
  it('shows the sections in order, the server text for "not discussed", and the AI-generated facts', async () => {
    serve(list([summary()]))
    panel()
    const card = await screen.findByRole('region', { name: 'Sales discovery' })
    const headings = within(card).getAllByRole('heading', { level: 4 })
    expect(headings.map((h) => h.textContent)).toEqual(['Decisions', 'Risks'])
    expect(within(card).getByText('Ship on Friday.')).not.toBeNull()
    expect(within(card).getByText('Not discussed.').className).toContain('text-soft')
    expect(within(card).getByText(en.summaries.aiGenerated)).not.toBeNull()
    expect(within(card).getByText(en.summaries.languages.en)).not.toBeNull()
    expect(within(card).getByText(/Ada Lovelace/)).not.toBeNull()
    expect(within(card).getByText(new RegExp(formatDateTime('2026-11-03T11:00:00.000Z')))).not.toBeNull()
    expect(within(card).queryByText(en.summaries.stale)).toBeNull()
  })

  it('labels a summary made before the transcript changed (AC-6.8)', async () => {
    serve(list([summary({ stale: true, edited: true })]))
    panel()
    expect(await screen.findByText(en.summaries.stale)).not.toBeNull()
    expect(screen.getByText(en.summaries.edited)).not.toBeNull()
  })

  it('renders AI output as plain text: markup and Markdown links appear literally (ADR-0067)', async () => {
    const hostile = '<img src=x onerror=alert(1)> [click](https://evil.test) <script>alert(2)</script> **bold**'
    serve(list([summary({ sections: [{ heading: '<b>Decisions</b>', body: hostile }] })]))
    const { container } = render(
      <SummariesPanel meeting={readyMeeting()} hostInfo={null} onChanged={() => undefined} />,
    )
    await screen.findByText(hostile)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('<b>Decisions</b>')
  })

  it('copies the summary as text (AC-7.11)', async () => {
    serve(list([summary()]))
    const user = userEvent.setup()
    panel()
    await user.click(await screen.findByRole('button', { name: en.summaries.copyAsText }))
    expect(await navigator.clipboard.readText()).toBe(
      'Sales discovery\n\nDecisions\nShip on Friday.\n\nRisks\nNot discussed.',
    )
    expect(await screen.findByText(en.summaries.copied)).not.toBeNull()
  })

  it('a reader who cannot summarise sees no Generate and no Regenerate, but can still copy', async () => {
    serve(list([summary({ can: { edit: false, delete: false, retry: false } })]))
    panel(readyMeeting({ role: 'participant', can: CAN_NONE }))
    await screen.findByRole('region', { name: 'Sales discovery' })
    expect(screen.queryByRole('button', { name: en.summaries.generate })).toBeNull()
    expect(screen.queryByRole('button', { name: en.summaries.regenerate })).toBeNull()
    expect(screen.getByRole('button', { name: en.summaries.copyAsText })).not.toBeNull()
  })
})

describe('summaries list states', () => {
  it('empty: invites to generate; a reader only learns there are none', async () => {
    serve(list([]))
    const { unmount } = render(<SummariesPanel meeting={readyMeeting()} hostInfo={null} onChanged={vi.fn()} />)
    expect(await screen.findByText(en.summaries.empty.heading)).not.toBeNull()
    expect(screen.getByText(en.summaries.empty.body)).not.toBeNull()
    unmount()
    render(<SummariesPanel meeting={readyMeeting({ can: CAN_NONE })} hostInfo={null} onChanged={vi.fn()} />)
    expect(await screen.findByText(en.summaries.empty.heading)).not.toBeNull()
    expect(screen.queryByText(en.summaries.empty.body)).toBeNull()
  })

  it('a failed load offers Retry', async () => {
    let calls = 0
    serve({
      'GET /meetings/:id/summaries': () =>
        ++calls === 1 ? { status: 500, body: problem(500) } : { status: 200, body: { items: [summary()] } },
    })
    panel()
    await userEvent.click(await screen.findByRole('button', { name: en.common.retry }))
    expect(await screen.findByRole('region', { name: 'Sales discovery' })).not.toBeNull()
  })

  it('a generating summary turns ready by polling, with no reload', async () => {
    let calls = 0
    serve({
      'GET /meetings/:id/summaries': () => ({
        status: 200,
        body: {
          items: [
            ++calls === 1
              ? summary({ status: 'generating', sections: undefined, can: { edit: false, delete: true, retry: false } })
              : summary(),
          ],
        },
      }),
    })
    panel()
    expect(await screen.findByText(en.summaries.generating)).not.toBeNull()
    expect(screen.queryByText('Ship on Friday.')).toBeNull()
    expect(await screen.findByText('Ship on Friday.', {}, { timeout: 4000 })).not.toBeNull()
    expect(screen.queryByText(en.summaries.generating)).toBeNull()
  })

  it('a failed summary shows Try again only when its own can.retry says so; Try again restarts it', async () => {
    const failed = summary({ status: 'failed', sections: undefined, can: { edit: false, delete: true, retry: true } })
    let retried = false
    const api = serve({
      'GET /meetings/:id/summaries': () => ({
        status: 200,
        body: { items: [retried ? { ...failed, status: 'generating' } : failed] },
      }),
      'POST /meetings/:id/summaries/:sid/retry': () => {
        retried = true
        return { status: 202, body: { ...failed, status: 'generating' } }
      },
    })
    panel()
    await userEvent.click(await screen.findByRole('button', { name: en.summaries.tryAgain }))
    expect(await screen.findByText(en.summaries.generating)).not.toBeNull()
    expect(callsTo(api, 'POST', '/summaries/s1/retry')).toHaveLength(1)
  })

  it('a failed summary without can.retry has no Try again', async () => {
    serve(list([summary({ status: 'failed', sections: undefined, can: { edit: false, delete: true, retry: false } })]))
    panel()
    expect(await screen.findByText(en.summaries.failed)).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.summaries.tryAgain })).toBeNull()
  })

  it('Regenerate adds a new card on top and keeps the old one', async () => {
    const fresh = summary({ id: 's2', status: 'generating', sections: undefined })
    let regenerated = false
    const api = serve({
      'GET /meetings/:id/summaries': () => ({
        status: 200,
        body: { items: regenerated ? [fresh, summary()] : [summary()] },
      }),
      'POST /meetings/:id/summaries/:sid/regenerate': () => {
        regenerated = true
        return { status: 202, body: fresh }
      },
    })
    panel()
    await userEvent.click(await screen.findByRole('button', { name: en.summaries.regenerate }))
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Sales discovery' })).toHaveLength(2))
    expect(callsTo(api, 'POST', '/summaries/s1/regenerate')).toHaveLength(1)
    expect(screen.getAllByRole('region', { name: 'Sales discovery' })[0]!.textContent).toContain(
      en.summaries.generating,
    )
  })
})

describe('Generate summary dialog (AC-7.1, AC-8.5)', () => {
  const templates: Template[] = [
    template({ id: 'b1', source: 'builtin', name: 'Sales discovery', recommended: true }),
    template({ id: 'p1', source: 'personal', name: 'Weekly sync' }),
    template({ id: 'sh1', source: 'shared', name: 'Team minutes' }),
    template({ id: 'b2', source: 'builtin', name: 'Minutes' }),
    template({ id: 'b3', source: 'builtin', name: 'Action list' }),
  ]
  const withTemplates = (extra: Record<string, FakeHandler> = {}) =>
    serve({
      ...list([]),
      'GET /templates': () => ({ status: 200, body: { items: templates } }),
      ...extra,
    })

  const openDialog = async (hostInfo: typeof crmDealHost | null = crmDealHost) => {
    panel(readyMeeting(), hostInfo)
    await userEvent.click(await screen.findByRole('button', { name: en.summaries.generate }))
    return screen.findByRole('dialog')
  }

  it('lists recommended, personal, shared, then built-in templates, with the recommended group named after the host', async () => {
    const api = withTemplates()
    const dialog = await openDialog()
    const select = await within(dialog).findByRole('combobox', { name: en.summaries.dialog.template })
    const groups = Array.from(select.querySelectorAll('optgroup')).map((group) => ({
      label: group.label,
      options: Array.from(group.querySelectorAll('option')).map((o) => o.textContent),
    }))
    expect(groups).toEqual([
      { label: en.summaries.dialog.groupRecommended('Deal'), options: ['Sales discovery'] },
      { label: en.summaries.dialog.groupPersonal, options: ['Weekly sync'] },
      { label: en.summaries.dialog.groupShared, options: ['Team minutes'] },
      { label: en.summaries.dialog.groupBuiltin, options: ['Minutes', 'Action list'] },
    ])
    expect(String(api.mock.calls.find(([url]) => String(url).includes('/templates'))![0])).toContain('meetingId=m1')
  })

  it('previews the sections of the chosen template', async () => {
    withTemplates()
    const dialog = await openDialog(null)
    const select = await within(dialog).findByRole('combobox', { name: en.summaries.dialog.template })
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Decisions', 'Actions'])
    await userEvent.selectOptions(select, 'Weekly sync')
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Decisions', 'Actions'])
  })

  it('output language defaults to the UI language; submitting sends template and language, then shows the new card first', async () => {
    const fresh = summary({ id: 's9', status: 'generating', sections: undefined })
    let created = false
    let sent: unknown = null
    withTemplates({
      'GET /meetings/:id/summaries': () => ({ status: 200, body: { items: created ? [fresh] : [] } }),
      'POST /meetings/:id/summaries': (_url, init) => {
        created = true
        sent = bodyOf(init)
        return { status: 202, body: fresh }
      },
    })
    const dialog = await openDialog()
    expect((within(dialog).getByRole('radio', { name: en.summaries.languages.en }) as HTMLInputElement).checked).toBe(
      true,
    )
    await userEvent.selectOptions(await within(dialog).findByRole('combobox'), 'Weekly sync')
    await userEvent.click(within(dialog).getByRole('radio', { name: en.summaries.languages.it }))
    await userEvent.click(within(dialog).getByRole('button', { name: en.summaries.dialog.submit }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent).toEqual({ templateId: 'p1', language: 'it' })
    expect(await screen.findByText(en.summaries.generating)).not.toBeNull()
  })

  it.each([
    ['summary_limit', 409],
    ['no_speech', 409],
    ['not_ready', 409],
  ])('a %s refusal shows its message in the dialog, which stays open', async (code, status) => {
    withTemplates({ 'POST /meetings/:id/summaries': () => ({ status, body: problem(status, code) }) })
    const dialog = await openDialog()
    await within(dialog).findByRole('combobox')
    await userEvent.click(within(dialog).getByRole('button', { name: en.summaries.dialog.submit }))
    expect(await within(dialog).findByText(en.common.errors[code as keyof typeof en.common.errors])).not.toBeNull()
    expect(screen.getByRole('dialog')).not.toBeNull()
  })

  it('a 429 names the time to retry (AC-13.4)', async () => {
    withTemplates({
      'POST /meetings/:id/summaries': () => ({
        status: 429,
        body: problem(429, 'ai_rate_limited'),
        headers: { 'Retry-After': '600' },
      }),
    })
    const dialog = await openDialog()
    await within(dialog).findByRole('combobox')
    const before = Date.now()
    await userEvent.click(within(dialog).getByRole('button', { name: en.summaries.dialog.submit }))
    const alert = await within(dialog).findByText(/limit of AI requests/)
    const candidates = [0, 1, 2].map((s) =>
      en.summaries.rateLimited(formatDateTime(new Date(before + 600_000 + s * 1000))),
    )
    expect(candidates).toContain(alert.textContent)
  })

  it('a 503 from authorization says permissions cannot be checked, and nothing is claimed as sent', async () => {
    withTemplates({ 'POST /meetings/:id/summaries': () => ({ status: 503, body: problem(503) }) })
    const dialog = await openDialog()
    await within(dialog).findByRole('combobox')
    await userEvent.click(within(dialog).getByRole('button', { name: en.summaries.dialog.submit }))
    expect(await within(dialog).findByText(en.common.authUnavailable.body)).not.toBeNull()
  })

  it('failing to load the templates offers Retry inside the dialog', async () => {
    let calls = 0
    serve({
      ...list([]),
      'GET /templates': () =>
        ++calls === 1 ? { status: 500, body: problem(500) } : { status: 200, body: { items: templates } },
    })
    const dialog = await openDialog()
    await userEvent.click(await within(dialog).findByRole('button', { name: en.common.retry }))
    expect(await within(dialog).findByRole('combobox')).not.toBeNull()
  })
})

describe('the Generate control (AC-7.3, AC-6.7)', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => summary({ id: `s${i}` }))

  it('at 20 summaries it is aria-disabled with the reason, and clicking asks nothing', async () => {
    const api = serve(list(twenty))
    panel()
    const button = await screen.findByRole('button', { name: en.summaries.generate })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getAllByText(new RegExp(en.summaries.limitReached)).length).toBeGreaterThan(0)
    expect(screen.getByText(en.summaries.count(20))).not.toBeNull()
    await userEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(callsTo(api, 'GET', '/templates')).toHaveLength(0)
  })

  it('Regenerate is also held back at 20', async () => {
    serve(list(twenty))
    panel()
    await screen.findByRole('button', { name: en.summaries.generate })
    const buttons = screen.getAllByRole('button', { name: en.summaries.regenerate })
    expect(buttons.every((b) => b.getAttribute('aria-disabled') === 'true')).toBe(true)
  })

  it('with no speech it is aria-disabled and says why', async () => {
    serve(list([]))
    panel(readyMeeting({ noSpeech: true }))
    const button = await screen.findByRole('button', { name: en.summaries.generate })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(en.summaries.noSpeechReason)).not.toBeNull()
  })
})
