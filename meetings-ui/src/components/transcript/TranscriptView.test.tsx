/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: () => 'http://meetings.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

import { apiFetch } from 'shell/session'
import { en } from '../../strings'
import {
  CAN_NONE,
  fakeApi,
  participantMeeting,
  problem,
  readyMeeting,
  segment,
  transcript,
  type FakeHandler,
} from '../../test-support/fakeApi'
import TranscriptView from './TranscriptView'

const serve = (routes: Record<string, FakeHandler>) => {
  const api = fakeApi(routes)
  vi.mocked(apiFetch).mockImplementation(api as unknown as typeof apiFetch)
  return api
}

const serveTranscript = (body = transcript()) =>
  serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body }) })

const view = (meeting = participantMeeting(), extra: Partial<Parameters<typeof TranscriptView>[0]> = {}) =>
  render(<TranscriptView meeting={meeting} focusSegmentId={null} onBackToAnswer={null} {...extra} />)

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
afterEach(cleanup)

describe('TranscriptView: reading (AC-6.1)', () => {
  it('lists segments in order with time and speaker label', async () => {
    serveTranscript()
    view()
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('00:00:12')).not.toBeNull()
    expect(within(rows[0]!).getByText('Speaker 1')).not.toBeNull()
    expect(within(rows[0]!).getByText('We agreed to ship on Friday.')).not.toBeNull()
    expect(within(rows[1]!).getByText('Speaker 2')).not.toBeNull()
  })

  it('sorts by ordinal even if the server order differs', async () => {
    const t = transcript()
    serveTranscript({ ...t, segments: [...t.segments].reverse() })
    view()
    const rows = await screen.findAllByRole('listitem')
    expect(within(rows[0]!).getByText('00:00:12')).not.toBeNull()
  })

  it('a participant label shows the participant name; a free-text label shows the text', async () => {
    const t = transcript({
      speakers: [
        { key: 'spk1', label: { kind: 'participant', participantId: 'p1' } },
        { key: 'spk2', label: { kind: 'text', text: 'The client' } },
      ],
    })
    serveTranscript(t)
    view(
      participantMeeting({
        participants: [{ id: 'p1', kind: 'external', name: 'Barbara Liskov', organisation: null }],
      }),
    )
    expect(await screen.findByText('Barbara Liskov')).not.toBeNull()
    expect(screen.getByText('The client')).not.toBeNull()
  })

  it('a text meeting shows passages with no times and no speakers (AC-6.1)', async () => {
    serveTranscript(
      transcript({
        segments: [segment({ startMs: null, endMs: null, speakerKey: null, text: 'First passage.' })],
        speakers: [],
      }),
    )
    view(participantMeeting({ source: 'text' }))
    const row = await screen.findByRole('listitem')
    expect(within(row).getByText('First passage.')).not.toBeNull()
    expect(within(row).queryByText(/^\d\d:\d\d:\d\d$/)).toBeNull()
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('renders AI-free text as plain text: markup and Markdown appear literally (ADR-0067)', async () => {
    serveTranscript(
      transcript({
        segments: [segment({ text: '<img src=x onerror=alert(1)> [click](https://evil.test) **bold**' })],
      }),
    )
    const { container } = view()
    await screen.findByRole('listitem')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> [click](https://evil.test) **bold**')
  })

  it('no speech: shows the message and fetches nothing (AC-6.7)', () => {
    const api = serveTranscript()
    view(participantMeeting({ noSpeech: true }))
    expect(screen.getByText(en.transcript.noSpeech.heading)).not.toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('a failed load shows the error with Retry, which loads again', async () => {
    let calls = 0
    serve({
      'GET /meetings/:id/transcript': () =>
        ++calls === 1 ? { status: 500, body: problem(500) } : { status: 200, body: transcript() },
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.common.retry }))
    expect((await screen.findAllByRole('listitem')).length).toBe(2)
  })
})

describe('TranscriptView: search (AC-6.4)', () => {
  it('highlights matches ignoring case and accents and counts them live', async () => {
    serveTranscript()
    const { container } = view()
    await screen.findAllByRole('listitem')
    await userEvent.type(screen.getByRole('searchbox', { name: en.transcript.searchLabel }), 'CAFE')
    const marks = container.querySelectorAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.textContent).toBe('Café')
    expect(screen.getByRole('status').textContent).toBe('1 match')
  })

  it('counts every occurrence, not every segment', async () => {
    serveTranscript(transcript({ segments: [segment({ text: 'ship ship ship' })] }))
    view()
    await screen.findAllByRole('listitem')
    await userEvent.type(screen.getByRole('searchbox'), 'ship')
    expect(screen.getByRole('status').textContent).toBe('3 matches')
  })

  it('no hit reads 0 matches; clearing the search removes highlights and the count', async () => {
    serveTranscript()
    const { container } = view()
    await screen.findAllByRole('listitem')
    const box = screen.getByRole('searchbox')
    await userEvent.type(box, 'zzz')
    expect(screen.getByRole('status').textContent).toBe('0 matches')
    await userEvent.clear(box)
    await userEvent.type(box, 'friday')
    expect(container.querySelectorAll('mark')).toHaveLength(1)
    await userEvent.clear(box)
    expect(container.querySelectorAll('mark')).toHaveLength(0)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('TranscriptView: copy and download (AC-6.6)', () => {
  it('copies lines as [hh:mm:ss] Name: text', async () => {
    serveTranscript()
    const user = userEvent.setup()
    view()
    await screen.findAllByRole('listitem')
    await user.click(screen.getByRole('button', { name: en.transcript.copy }))
    expect(await navigator.clipboard.readText()).toBe(
      '[00:00:12] Speaker 1: We agreed to ship on Friday.\n[00:00:20] Speaker 2: Café review on Monday.',
    )
    expect(await screen.findByText(en.transcript.copied)).not.toBeNull()
  })

  it('a text meeting exports its passages without times', async () => {
    serveTranscript(
      transcript({
        segments: [
          segment({ startMs: null, endMs: null, speakerKey: null, text: 'One.' }),
          segment({ id: 'seg2', ordinal: 2, startMs: null, endMs: null, speakerKey: null, text: 'Two.' }),
        ],
        speakers: [],
      }),
    )
    const user = userEvent.setup()
    view(participantMeeting({ source: 'text' }))
    await screen.findAllByRole('listitem')
    await user.click(screen.getByRole('button', { name: en.transcript.copy }))
    expect(await navigator.clipboard.readText()).toBe('One.\nTwo.')
  })

  it('download hands a plain-text file named after the meeting to the browser', async () => {
    serveTranscript()
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    view(participantMeeting({ title: 'Kick-off: Acme/2026' }))
    await screen.findAllByRole('listitem')
    await userEvent.click(screen.getByRole('button', { name: en.transcript.download }))
    expect(create).toHaveBeenCalledTimes(1)
    const blob = (create.mock.calls[0] as unknown as [Blob])[0]
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('Kick-off- Acme-2026.txt')
    click.mockRestore()
  })
})

describe('TranscriptView: citation target (F12)', () => {
  it('marks, scrolls to and focuses the cited segment, and offers the way back', async () => {
    serveTranscript()
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const onBack = vi.fn()
    view(participantMeeting(), { focusSegmentId: 'seg2', onBackToAnswer: onBack })
    const rows = await screen.findAllByRole('listitem')
    expect(rows[1]!.getAttribute('aria-current')).toBe('true')
    expect(rows[0]!.getAttribute('aria-current')).toBeNull()
    expect(within(rows[1]!).getByText(en.transcript.citedPassage)).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(rows[1]))
    expect(scroll).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: en.transcript.backToAnswer }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('without a way back there is no back link', async () => {
    serveTranscript()
    view(participantMeeting(), { focusSegmentId: 'seg1' })
    await screen.findAllByRole('listitem')
    expect(screen.queryByRole('button', { name: en.transcript.backToAnswer })).toBeNull()
  })
})

describe('TranscriptView: read-only', () => {
  it('the reader has no edit controls', async () => {
    serveTranscript()
    view(readyMeeting({ role: 'participant', can: CAN_NONE }))
    await screen.findAllByRole('listitem')
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
  })
})
