/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDateTime } from '@operai/ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: () => 'http://meetings.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

import { apiFetch } from 'shell/session'
import axe from 'axe-core'
import { en, it as italian } from '../../strings'
import type { ConversationTurn, Meeting } from '../../lib/types'
import { CAN_NONE, fakeApi, problem, readyMeeting, turn, type FakeHandler } from '../../test-support/fakeApi'
import AskPanel from './AskPanel'

const serve = (routes: Record<string, FakeHandler>) => {
  const api = fakeApi(routes)
  vi.mocked(apiFetch).mockImplementation(api as unknown as typeof apiFetch)
  return api
}

const conversation = (turns: ConversationTurn[]): Record<string, FakeHandler> => ({
  'GET /meetings/:id/conversation': () => ({ status: 200, body: { turns } }),
})

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body))

const view = (meeting: Meeting = readyMeeting(), onOpenSource = vi.fn(), onOpenNotice?: () => void) => {
  render(<AskPanel meeting={meeting} onOpenSource={onOpenSource} onOpenNotice={onOpenNotice} />)
  return { onOpenSource }
}

const box = () => screen.getByRole('textbox', { name: en.ask.composer.label }) as HTMLTextAreaElement

const posts = (api: ReturnType<typeof fakeApi>) => api.mock.calls.filter(([, init]) => init?.method === 'POST')

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
afterEach(cleanup)

describe('the conversation (AC-9.1, AC-9.3, AC-9.5)', () => {
  it('shows the privacy line and the turns oldest first: the question as "You", the answer as AI-generated', async () => {
    serve(
      conversation([
        turn(),
        turn({ id: 'q2', question: 'Who owns it?', answer: { text: 'Ada.', notInMeeting: false, citations: [] } }),
      ]),
    )
    view()
    const list = await screen.findByRole('list', { name: en.ask.conversationLabel })
    const turns = Array.from(list.children) as HTMLElement[]
    expect(turns).toHaveLength(2)
    expect(within(turns[0]!).getByText('When do we ship?')).not.toBeNull()
    expect(within(turns[0]!).getByText(en.ask.you)).not.toBeNull()
    expect(within(turns[0]!).getByText(en.ask.aiGenerated)).not.toBeNull()
    expect(within(turns[0]!).getByText('On Friday.')).not.toBeNull()
    expect(within(turns[1]!).getByText('Who owns it?')).not.toBeNull()
    expect(screen.getByText(en.ask.privacy)).not.toBeNull()
  })

  it('lists sources as time · speaker; selecting one opens it', async () => {
    serve(conversation([turn()]))
    const { onOpenSource } = view()
    await userEvent.click(await screen.findByRole('button', { name: '00:00:12 · Speaker 1' }))
    expect(onOpenSource).toHaveBeenCalledWith('seg1')
    expect(onOpenSource).toHaveBeenCalledTimes(1)
  })

  it('a text meeting cites the passage, not a time', async () => {
    serve(
      conversation([
        turn({
          answer: {
            text: 'Yes.',
            notInMeeting: false,
            citations: [
              { segmentId: 'seg0', ordinal: 0, startMs: null, speaker: null },
              { segmentId: 'seg3', ordinal: 3, startMs: null, speaker: null },
            ],
          },
        }),
      ]),
    )
    const { onOpenSource } = view(readyMeeting({ source: 'text' }))
    // The API ordinal is 0-based; the first passage is "Passage 1", never "Passage 0".
    expect(await screen.findByRole('button', { name: 'Passage 1' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Passage 0' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Passage 4' }))
    expect(onOpenSource).toHaveBeenCalledWith('seg3')
  })

  it('"not in the meeting" shows the sentence and no sources', async () => {
    serve(
      conversation([
        turn({
          answer: { text: 'The meeting does not contain this.', notInMeeting: true, citations: [] },
        }),
      ]),
    )
    view()
    expect(await screen.findByText('The meeting does not contain this.')).not.toBeNull()
    expect(screen.queryByText(en.ask.sources)).toBeNull()
    expect(screen.queryByRole('button', { name: /·/ })).toBeNull()
  })

  it('even if the server sent citations with a "not in the meeting" answer, none are shown', async () => {
    serve(
      conversation([
        turn({
          answer: {
            text: 'The meeting does not contain this.',
            notInMeeting: true,
            citations: [{ segmentId: 'seg1', ordinal: 1, startMs: 12_000, speaker: 'Speaker 1' }],
          },
        }),
      ]),
    )
    view()
    await screen.findByText('The meeting does not contain this.')
    expect(screen.queryByText(en.ask.sources)).toBeNull()
  })

  it('renders question and answer as plain text (ADR-0067)', async () => {
    const hostile = '<img src=x onerror=alert(1)> [click](https://evil.test) **bold**'
    serve(conversation([turn({ question: hostile, answer: { text: hostile, notInMeeting: false, citations: [] } })]))
    const { container } = render(<AskPanel meeting={readyMeeting()} onOpenSource={vi.fn()} />)
    await waitFor(() => expect(container.textContent).toContain(hostile))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelectorAll('strong,b')).toHaveLength(0)
  })

  it('a pending turn reads "Thinking…"', async () => {
    serve(conversation([turn({ status: 'pending', answer: null })]))
    view()
    expect(await screen.findByText(en.ask.thinking)).not.toBeNull()
  })

  it('empty: invites to ask, and the composer is there', async () => {
    serve(conversation([]))
    view()
    expect(await screen.findByText(en.ask.empty.heading)).not.toBeNull()
    expect(screen.getByText(en.ask.empty.body)).not.toBeNull()
    expect(box()).not.toBeNull()
  })

  it('a failed load offers Retry', async () => {
    let calls = 0
    serve({
      'GET /meetings/:id/conversation': () =>
        ++calls === 1 ? { status: 500, body: problem(500) } : { status: 200, body: { turns: [turn()] } },
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.common.retry }))
    expect(await screen.findByText('On Friday.')).not.toBeNull()
  })

  it('history stays readable without can.ask, but there is no composer (AC-9.5)', async () => {
    serve(conversation([turn()]))
    view(readyMeeting({ can: CAN_NONE }))
    expect(await screen.findByText('On Friday.')).not.toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('returns focus to the source that was opened when the panel comes back (F12)', async () => {
    serve(conversation([turn()]))
    const first = render(<AskPanel meeting={readyMeeting()} onOpenSource={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: '00:00:12 · Speaker 1' }))
    first.unmount()
    render(<AskPanel meeting={readyMeeting()} onOpenSource={vi.fn()} />)
    const again = await screen.findByRole('button', { name: '00:00:12 · Speaker 1' })
    await waitFor(() => expect(document.activeElement).toBe(again))
  })
})

describe('a failed turn (AC-9.6)', () => {
  it('stays in the conversation, marked failed, with Try again', async () => {
    const failed = turn({ status: 'failed', answer: null })
    let retried = false
    const api = serve({
      'GET /meetings/:id/conversation': () => ({ status: 200, body: { turns: [retried ? turn() : failed] } }),
      'POST /meetings/:id/conversation/questions/:tid/retry': () => {
        retried = true
        return { status: 200, body: turn() }
      },
    })
    view()
    expect(await screen.findByText('When do we ship?')).not.toBeNull()
    expect(screen.getByText(en.ask.failed)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.ask.tryAgain }))
    expect(await screen.findByText('On Friday.')).not.toBeNull()
    expect(screen.queryByText(en.ask.failed)).toBeNull()
    expect(String(posts(api)[0]![0])).toMatch(/\/conversation\/questions\/q1\/retry$/)
  })

  it('a rate-limited retry says when to try again', async () => {
    serve({
      ...conversation([turn({ status: 'failed', answer: null })]),
      'POST /meetings/:id/conversation/questions/:tid/retry': () => ({
        status: 429,
        body: problem(429, 'ai_rate_limited'),
        headers: { 'Retry-After': '300' },
      }),
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.ask.tryAgain }))
    expect(await screen.findByText(/limit of AI requests/)).not.toBeNull()
  })
})

describe('the composer (AC-9.1, AC-9.8)', () => {
  it('refuses an empty question and one of 1,001 characters, with no request', async () => {
    const api = serve(conversation([]))
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    expect(screen.getByText(en.ask.composer.required)).not.toBeNull()
    await userEvent.click(box())
    await userEvent.paste('x'.repeat(1001))
    expect(screen.getByText(en.ask.composer.counter(1001))).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    expect(screen.getByText(en.ask.composer.tooLong)).not.toBeNull()
    expect(posts(api)).toHaveLength(0)
  })

  it('accepts a question of exactly 1,000 characters and a single character', async () => {
    const api = serve({
      ...conversation([]),
      'POST /meetings/:id/conversation/questions': () => ({ status: 201, body: turn() }),
    })
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.click(box())
    await userEvent.paste('x'.repeat(1000))
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    await waitFor(() => expect(posts(api)).toHaveLength(1))
    await userEvent.type(box(), 'q')
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    await waitFor(() => expect(posts(api)).toHaveLength(2))
  })

  it('sends the question, shows the answer, and clears the box', async () => {
    let sent: unknown = null
    serve({
      ...conversation([]),
      'POST /meetings/:id/conversation/questions': (_url, init) => {
        sent = bodyOf(init)
        return { status: 201, body: turn() }
      },
    })
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.type(box(), 'When do we ship?')
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    expect(await screen.findByText('On Friday.')).not.toBeNull()
    expect(sent).toEqual({ question: 'When do we ship?' })
    expect(box().value).toBe('')
    expect(screen.queryByText(en.ask.empty.heading)).toBeNull()
  })

  it('Ctrl+Enter sends; Enter alone adds a new line', async () => {
    const api = serve({
      ...conversation([]),
      'POST /meetings/:id/conversation/questions': () => ({ status: 201, body: turn() }),
    })
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.type(box(), 'one{Enter}two')
    expect(box().value).toBe('one\ntwo')
    expect(posts(api)).toHaveLength(0)
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(posts(api)).toHaveLength(1))
  })

  it('while waiting it shows the question with "Thinking…" and keeps the text', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    serve({
      ...conversation([]),
      'POST /meetings/:id/conversation/questions': async () => {
        await gate
        return { status: 201, body: turn() }
      },
    })
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.type(box(), 'When do we ship?')
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    expect(await screen.findByText(en.ask.thinking)).not.toBeNull()
    expect(box().value).toBe('When do we ship?')
    release()
    expect(await screen.findByText('On Friday.')).not.toBeNull()
  })

  it('a rate limit names the time to retry and keeps the question (AC-9.8)', async () => {
    serve({
      ...conversation([]),
      'POST /meetings/:id/conversation/questions': () => ({
        status: 429,
        body: problem(429, 'ai_rate_limited'),
        headers: { 'Retry-After': '900' },
      }),
    })
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.type(box(), 'When?')
    const before = Date.now()
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    const alert = await screen.findByRole('alert')
    const accepted = [0, 1, 2].map((s) => en.ask.rateLimited(formatDateTime(new Date(before + 900_000 + s * 1000))))
    expect(accepted).toContain(alert.textContent)
    expect(box().value).toBe('When?')
  })

  it('a refusal (409 not_ready) shows its message and keeps the question', async () => {
    serve({
      ...conversation([]),
      'POST /meetings/:id/conversation/questions': () => ({ status: 409, body: problem(409, 'not_ready') }),
    })
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.type(box(), 'When?')
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.common.errors.not_ready)
    expect(box().value).toBe('When?')
  })

  it('a server-side failed turn is added to the conversation with Try again', async () => {
    serve({
      ...conversation([]),
      'POST /meetings/:id/conversation/questions': () => ({
        status: 201,
        body: turn({ status: 'failed', answer: null }),
      }),
    })
    view()
    await screen.findByText(en.ask.empty.heading)
    await userEvent.type(box(), 'When do we ship?')
    await userEvent.click(screen.getByRole('button', { name: en.ask.composer.ask }))
    expect(await screen.findByRole('button', { name: en.ask.tryAgain })).not.toBeNull()
  })

  it('with no speech the Ask button is aria-disabled with the reason, and sends nothing', async () => {
    const api = serve(conversation([]))
    view(readyMeeting({ noSpeech: true }))
    await screen.findByText(en.ask.empty.heading)
    const button = screen.getByRole('button', { name: en.ask.composer.ask })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(en.ask.composer.noSpeech)).not.toBeNull()
    await userEvent.type(box(), 'hello')
    await userEvent.click(button)
    expect(posts(api)).toHaveLength(0)
  })
})

describe('clear conversation (AC-9.5)', () => {
  it('is offered only when there are turns', async () => {
    serve(conversation([]))
    view()
    await screen.findByText(en.ask.empty.heading)
    expect(screen.queryByRole('button', { name: en.ask.clear.button })).toBeNull()
  })

  it('asks to confirm; Cancel clears nothing', async () => {
    const api = serve(conversation([turn()]))
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.ask.clear.button }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(en.ask.clear.body)).not.toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
    expect(screen.getByText('On Friday.')).not.toBeNull()
  })

  it('confirming deletes the conversation and shows the empty state', async () => {
    const api = serve({
      ...conversation([turn()]),
      'DELETE /meetings/:id/conversation': () => ({ status: 204 }),
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.ask.clear.button }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.ask.clear.confirm }))
    expect(await screen.findByText(en.ask.empty.heading)).not.toBeNull()
    expect(screen.queryByText('On Friday.')).toBeNull()
    expect(api.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
  })

  it('a failure keeps the dialog open with the message', async () => {
    serve({
      ...conversation([turn()]),
      'DELETE /meetings/:id/conversation': () => ({ status: 500, body: problem(500) }),
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.ask.clear.button }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.ask.clear.confirm }))
    expect(await within(screen.getByRole('alertdialog')).findByText(/Problem 500|Something went wrong/)).not.toBeNull()
    expect(screen.getByText('On Friday.')).not.toBeNull()
  })
})

describe('an answer built on a transcript that may be incomplete (AC-9.9)', () => {
  const flagged = (overrides: Partial<ConversationTurn> = {}) =>
    turn({
      answer: { text: 'On Friday.', notInMeeting: false, citations: [], possiblyIncomplete: true },
      ...overrides,
    })

  it('shows the label with a link to the transcript notice, beside "AI-generated"', async () => {
    serve(conversation([flagged()]))
    view()
    const link = await screen.findByRole('link', { name: en.ask.incompleteLabel })
    expect(en.ask.incompleteLabel).toBe('Based on a transcript that may be incomplete')
    expect(link.getAttribute('href')).toBe('#meetings-transcript-incomplete')
    expect(screen.getByText(en.ask.aiGenerated)).not.toBeNull()
  })

  it('following the link asks the page to show the notice instead of navigating', async () => {
    serve(conversation([flagged()]))
    const onOpenNotice = vi.fn()
    view(readyMeeting(), vi.fn(), onOpenNotice)
    const link = await screen.findByRole('link', { name: en.ask.incompleteLabel })
    const notPrevented = fireEvent.click(link)
    expect(onOpenNotice).toHaveBeenCalledTimes(1)
    expect(notPrevented).toBe(false)
  })

  it('an answer that says "not in the meeting" keeps the server text and gets the label too', async () => {
    const text =
      'The transcript does not contain an answer to this question. It may be incomplete, so the meeting itself may.'
    serve(conversation([flagged({ answer: { text, notInMeeting: true, citations: [], possiblyIncomplete: true } })]))
    view()
    expect(await screen.findByText(text)).not.toBeNull()
    expect(screen.getByRole('link', { name: en.ask.incompleteLabel })).not.toBeNull()
  })

  it.each([
    ['false', false],
    ['absent', undefined],
  ])('possiblyIncomplete %s: no label (older rows, meetings without gaps)', async (_name, value) => {
    serve(
      conversation([turn({ answer: { text: 'On Friday.', notInMeeting: false, citations: [], possiblyIncomplete: value } })]),
    )
    view()
    await screen.findByText('On Friday.')
    expect(screen.queryByRole('link', { name: en.ask.incompleteLabel })).toBeNull()
  })

  it('a failed turn has no label', async () => {
    serve(conversation([turn({ id: 'q2', status: 'failed', answer: null })]))
    view()
    await screen.findByText(en.ask.failed)
    expect(screen.queryByText(en.ask.incompleteLabel)).toBeNull()
  })

  it('has Italian copy', () => {
    expect(italian.ask.incompleteLabel).not.toBe(en.ask.incompleteLabel)
  })

  it('has no axe violation (AC-13.3)', async () => {
    serve(conversation([flagged()]))
    const { container } = render(<AskPanel meeting={readyMeeting()} onOpenSource={vi.fn()} />)
    await screen.findByRole('link', { name: en.ask.incompleteLabel })
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
  })
})
