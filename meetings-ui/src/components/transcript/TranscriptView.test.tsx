/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDuration } from '@operai/ui'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: () => 'http://meetings.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

import { apiFetch } from 'shell/session'
import { en, it as italian } from '../../strings'
import {
  CAN_NONE,
  fakeApi,
  participantMeeting,
  problem,
  readyMeeting,
  segment,
  threePartTranscript,
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
        { key: 'spk1', label: { kind: 'participant', participantId: 'p1' }, parts: [1], joined: false },
        { key: 'spk2', label: { kind: 'text', text: 'The client' }, parts: [1], joined: false },
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

  it('the edit control of the first passage is named "Edit passage 1", never 0 (ordinal is 0-based)', async () => {
    serveTranscript(
      transcript({
        segments: [segment({ ordinal: 0, startMs: null, endMs: null, speakerKey: null, text: 'First passage.' })],
        speakers: [],
      }),
    )
    view(readyMeeting({ source: 'text' }))
    expect(await screen.findByRole('button', { name: 'Edit passage 1' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /passage 0/i })).toBeNull()
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

describe('TranscriptView: transcript parts (AC-6.1, AC-6.2, AC-6.15)', () => {
  /** Part 2 opens at 1 h; its first segment is heard 10 s early, inside the overlap (plan H-1). */
  const overlapping = () => {
    const t = threePartTranscript()
    return {
      ...t,
      segments: [
        ...t.segments.slice(0, 1),
        segment({ id: 'a2', startMs: 3_590_000, endMs: 3_599_000, speakerKey: 'p1:1', part: 1, text: 'End of part one.' }),
        segment({ id: 'b1', startMs: 3_595_000, endMs: 3_620_000, speakerKey: 'p2:1', part: 2, text: 'Start of part two.' }),
        ...t.segments.slice(2),
      ].map((s, i) => ({ ...s, ordinal: i + 1 })),
    }
  }

  it('a later label that stayed separate: the info banner says so, and a divider opens each part after the first', async () => {
    serveTranscript(threePartTranscript())
    view()
    await screen.findByText('Start of part two.')
    expect(screen.getByText(en.transcript.parts.banner(3))).not.toBeNull()
    const dividers = screen.getAllByRole('separator')
    expect(dividers.map((d) => d.textContent)).toEqual([
      en.transcript.parts.divider(2, '01:00:00'),
      en.transcript.parts.divider(3, '02:00:00'),
    ])
    // The divider is not a list item: it sits right before the list that starts with its part.
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getAllByRole('list')).toHaveLength(3)
    expect(dividers[0]!.nextElementSibling).toBe(screen.getByTestId('meetings-segment-b1').parentElement)
    expect(dividers[1]!.nextElementSibling).toBe(screen.getByTestId('meetings-segment-c1').parentElement)
    expect(screen.getByTestId('meetings-segment-b1').previousElementSibling).toBeNull()
  })

  it('every later label joined (separateLabels false): the dividers stay, the banner does not (AC-6.15)', async () => {
    serveTranscript({ ...threePartTranscript(), separateLabels: false })
    view()
    await screen.findByText('Start of part two.')
    expect(screen.queryByTestId('meetings-transcript-parts-banner')).toBeNull()
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  it('the banner needs more than one part, even if the server flag were set', async () => {
    serveTranscript(transcript({ separateLabels: true }))
    view()
    await screen.findAllByRole('listitem')
    expect(screen.queryByTestId('meetings-transcript-parts-banner')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('a divider goes by segment.part, not by time: an early-heard segment of part 2 still opens part 2', async () => {
    serveTranscript(overlapping())
    view()
    await screen.findByText('Start of part two.')
    const dividers = screen.getAllByRole('separator')
    expect(dividers.map((d) => d.textContent)).toEqual([
      en.transcript.parts.divider(2, '01:00:00'),
      en.transcript.parts.divider(3, '02:00:00'),
    ])
    // a2 is part 1 although it is heard later than part 2 starts; b1 is the first segment of part 2.
    expect(dividers[0]!.nextElementSibling).toBe(screen.getByTestId('meetings-segment-b1').parentElement)
    expect(screen.getByTestId('meetings-segment-a2').parentElement).not.toBe(
      screen.getByTestId('meetings-segment-b1').parentElement,
    )
  })

  it('rows that carry no part (older rows) get no divider', async () => {
    const t = threePartTranscript()
    serveTranscript({ ...t, segments: t.segments.map((s) => ({ ...s, part: null })), separateLabels: false })
    view()
    await screen.findByText('Start of part two.')
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('one part: neither banner nor divider', async () => {
    serveTranscript(transcript())
    view()
    await screen.findAllByRole('listitem')
    expect(screen.queryByTestId('meetings-transcript-parts-banner')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('a text meeting (no parts) shows neither', async () => {
    serveTranscript(
      transcript({
        segments: [segment({ startMs: null, endMs: null, speakerKey: null, part: null, text: 'First passage.' })],
        speakers: [],
        parts: [],
      }),
    )
    view(participantMeeting({ source: 'text' }))
    await screen.findByRole('listitem')
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByTestId('meetings-transcript-parts-banner')).toBeNull()
  })

  it('renaming two labels to the same name reads as one speaker (AC-6.2)', async () => {
    const t = threePartTranscript()
    serveTranscript({
      ...t,
      speakers: t.speakers.map((s) =>
        s.key === 'p1:1' || s.key === 'p2:1' ? { ...s, label: { kind: 'text' as const, text: 'Ada' } } : s,
      ),
    })
    view()
    await screen.findByText('Start of part two.')
    expect(screen.getAllByText('Ada')).toHaveLength(2)
  })

  it('searching keeps the dividers (they are structure, not matches)', async () => {
    serveTranscript(threePartTranscript())
    view()
    await screen.findByText('Start of part two.')
    await userEvent.type(screen.getByRole('searchbox'), 'part two')
    expect(screen.getAllByRole('separator')).toHaveLength(2)
    expect(screen.getByText(en.transcript.matches(1))).not.toBeNull()
  })

  it('the banner never says "numbered separately" or "different people" (AC-6.15), in either language', () => {
    for (const catalog of [en, italian]) {
      const text = catalog.transcript.parts.banner(3).toLowerCase()
      expect(text).not.toMatch(/numbered separately|numerate separatamente|different people|persone diverse|persone differenti/)
    }
    expect(en.transcript.parts.banner(3)).toContain('transcribed in 3 parts')
    expect(en.transcript.parts.banner(3)).toContain('Rename them to the same name to merge them.')
    expect(italian.transcript.parts.banner(3)).not.toBe(en.transcript.parts.banner(3))
  })

  it('a multi-part transcript has no axe violation: the dividers are valid inside the segment list (AC-6.2, AC-13.3)', async () => {
    serveTranscript(threePartTranscript())
    const { container } = view()
    await screen.findByText('Start of part two.')
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
  })

  it('control: the same transcript with one part has no axe violation', async () => {
    serveTranscript(transcript())
    const { container } = view()
    await screen.findAllByRole('listitem')
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map((v) => v.id)).toEqual([])
  })
})

describe('TranscriptView: a transcript that may be incomplete (AC-6.12, AC-6.5)', () => {
  const GAP_1 = { startMs: 300_000, endMs: 420_000 } // 00:05:00 - 00:07:00
  const GAP_2 = { startMs: 1_200_000, endMs: 1_260_000 } // 00:20:00 - 00:21:00
  const gappy = (gaps = [GAP_1, GAP_2]) =>
    transcript({
      segments: [
        segment(),
        segment({ id: 'seg2', ordinal: 2, startMs: 20_000, endMs: 25_000, speakerKey: 'spk2', text: 'Before the first gap.' }),
        segment({ id: 'seg3', ordinal: 3, startMs: 430_000, endMs: 440_000, text: 'After the first gap.' }),
        segment({ id: 'seg4', ordinal: 4, startMs: 1_300_000, endMs: 1_310_000, speakerKey: 'spk2', text: 'After the second gap.' }),
      ],
      gaps,
    })
  const NOTICE = () =>
    en.transcript.incomplete.notice([
      { from: '00:05:00', to: '00:07:00' },
      { from: '00:20:00', to: '00:21:00' },
    ])
  const audioRoute = {
    'GET /meetings/:id/audio': () => ({
      status: 200,
      body: { url: 'https://audio.test/a1', expiresAt: '2026-11-03T09:45:00.000Z' },
    }),
  }

  it('no gaps: no notice and no marker', async () => {
    serveTranscript(gappy([]))
    view()
    await screen.findByText('After the second gap.')
    expect(screen.queryByTestId('meetings-transcript-incomplete')).toBeNull()
    expect(screen.queryAllByTestId('meetings-transcript-gap')).toHaveLength(0)
    expect(screen.queryByText(/may be incomplete/)).toBeNull()
  })

  it('two gaps: one notice naming both ranges, anchored for the answers link, with no dismiss', async () => {
    serveTranscript(gappy())
    view(participantMeeting({ audio: { state: 'deleted' } }))
    const notice = await screen.findByTestId('meetings-transcript-incomplete')
    expect(notice.id).toBe('meetings-transcript-incomplete')
    // Persistent, non-dismissible condition: not an assertive live region (design.md accessibility).
    expect(notice.getAttribute('role')).not.toBe('alert')
    expect(notice.hasAttribute('aria-live')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('note', { name: en.transcript.incomplete.label })).toBe(notice)
    expect(notice.textContent).toContain(NOTICE())
    expect(notice.textContent).toContain('cannot be recovered from it')
    expect(within(notice).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: en.common.dismiss })).toBeNull()
  })

  it('a marker sits between the two segments the gap falls between, outside the lists', async () => {
    serveTranscript(gappy())
    view(participantMeeting({ audio: { state: 'deleted' } }))
    const markers = await screen.findAllByTestId('meetings-transcript-gap')
    expect(markers.map((m) => m.textContent)).toEqual([
      en.transcript.incomplete.marker('00:05:00', '00:07:00'),
      en.transcript.incomplete.marker('00:20:00', '00:21:00'),
    ])
    const seg2List = screen.getByTestId('meetings-segment-seg2').parentElement
    const seg3List = screen.getByTestId('meetings-segment-seg3').parentElement
    const seg4List = screen.getByTestId('meetings-segment-seg4').parentElement
    expect(markers[0]!.previousElementSibling).toBe(seg2List)
    expect(markers[0]!.nextElementSibling).toBe(seg3List)
    expect(markers[1]!.previousElementSibling).toBe(seg3List)
    expect(markers[1]!.nextElementSibling).toBe(seg4List)
    expect(markers.every((m) => m.closest('li') === null)).toBe(true)
  })

  it('a gap before the first segment and one after the last are placed at the start and the end', async () => {
    serveTranscript(
      gappy([
        { startMs: 0, endMs: 10_000 },
        { startMs: 2_000_000, endMs: 2_100_000 },
      ]),
    )
    view(participantMeeting({ audio: { state: 'deleted' } }))
    const markers = await screen.findAllByTestId('meetings-transcript-gap')
    expect(markers).toHaveLength(2)
    expect(markers[0]!.nextElementSibling).toBe(screen.getByTestId('meetings-segment-seg1').parentElement)
    expect(markers[1]!.previousElementSibling).toBe(screen.getByTestId('meetings-segment-seg4').parentElement)
    expect(markers[1]!.nextElementSibling).toBeNull()
  })

  it('while the audio is kept, each range in the notice and each marker plays from the start of the gap', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: gappy() }), ...audioRoute })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    view(participantMeeting())
    const notice = await screen.findByTestId('meetings-transcript-incomplete')
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toBe('https://audio.test/a1'))
    const inNotice = within(notice).getAllByRole('button')
    expect(inNotice.map((b) => b.getAttribute('aria-label'))).toEqual([
      en.transcript.playFrom(formatDuration(300_000, { style: 'spoken' })),
      en.transcript.playFrom(formatDuration(1_200_000, { style: 'spoken' })),
    ])
    await userEvent.click(inNotice[1]!)
    expect(document.querySelector('audio')!.currentTime).toBe(1200)
    const marker = screen.getAllByTestId('meetings-transcript-gap')[0]!
    await userEvent.click(within(marker).getByRole('button'))
    expect(document.querySelector('audio')!.currentTime).toBe(300)
    expect(play).toHaveBeenCalledTimes(2)
    play.mockRestore()
  })

  it('after the audio is deleted the play controls are gone and the notice and markers stay', async () => {
    serveTranscript(gappy())
    view(participantMeeting({ audio: { state: 'deleted' } }))
    const notice = await screen.findByTestId('meetings-transcript-incomplete')
    expect(within(notice).queryByRole('button')).toBeNull()
    for (const marker of screen.getAllByTestId('meetings-transcript-gap')) {
      expect(within(marker).queryByRole('button')).toBeNull()
    }
    expect(screen.getAllByTestId('meetings-transcript-gap')).toHaveLength(2)
  })

  it('the notice is shown to a reader with no edit rights too', async () => {
    serveTranscript(gappy())
    view(readyMeeting({ role: 'participant', can: CAN_NONE, audio: { state: 'none' } }))
    expect((await screen.findByTestId('meetings-transcript-incomplete')).textContent).toContain(NOTICE())
  })

  it('a request to jump to the notice (from an answer) scrolls to it and focuses it', async () => {
    serveTranscript(gappy())
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    view(participantMeeting({ audio: { state: 'none' } }), { focusNotice: true })
    const notice = await screen.findByTestId('meetings-transcript-incomplete')
    await waitFor(() => expect(document.activeElement).toBe(notice))
    expect(scroll).toHaveBeenCalled()
    // Focus is what announces it (by its accessible name); it is not a live region.
    expect(screen.getByRole('note', { name: en.transcript.incomplete.label })).toBe(document.activeElement)
    expect(notice.getAttribute('role')).not.toBe('alert')
  })

  it('copy begins with the notice and a blank line, and carries each marker at its place', async () => {
    serveTranscript(gappy())
    const user = userEvent.setup()
    view(participantMeeting({ audio: { state: 'none' } }))
    await screen.findByTestId('meetings-transcript-incomplete')
    await user.click(screen.getByRole('button', { name: en.transcript.copy }))
    expect(await navigator.clipboard.readText()).toBe(
      [
        NOTICE(),
        '',
        '[00:00:12] Speaker 1: We agreed to ship on Friday.',
        '[00:00:20] Speaker 2: Before the first gap.',
        '[Possible gap 00:05:00–00:07:00]',
        '[00:07:10] Speaker 1: After the first gap.',
        '[Possible gap 00:20:00–00:21:00]',
        '[00:21:40] Speaker 2: After the second gap.',
      ].join('\n'),
    )
  })

  it('download carries the same text', async () => {
    serveTranscript(gappy())
    const create = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    view(participantMeeting({ audio: { state: 'none' } }))
    await screen.findByTestId('meetings-transcript-incomplete')
    await userEvent.click(screen.getByRole('button', { name: en.transcript.download }))
    const blob = (create.mock.calls[0] as unknown as [Blob])[0]
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blob)
    })
    expect(text.startsWith(`${NOTICE()}\n\n[00:00:12]`)).toBe(true)
    expect(text).toContain('[Possible gap 00:20:00–00:21:00]')
    click.mockRestore()
  })

  it('has Italian copy for the notice, the marker and the play control', () => {
    const ranges = [{ from: '00:05:00', to: '00:07:00' }]
    expect(italian.transcript.incomplete.notice(ranges)).not.toBe(en.transcript.incomplete.notice(ranges))
    expect(italian.transcript.incomplete.notice(ranges)).toContain('00:05:00 e 00:07:00')
    expect(italian.transcript.incomplete.marker('a', 'b')).not.toBe(en.transcript.incomplete.marker('a', 'b'))
    expect(italian.transcript.incomplete.play).not.toBe(en.transcript.incomplete.play)
  })

  it('has no axe violation with a notice and markers, audio kept or deleted (AC-13.3)', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: gappy() }), ...audioRoute })
    const { container, rerender } = view(participantMeeting())
    await screen.findByTestId('meetings-transcript-incomplete')
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toBe('https://audio.test/a1'))
    const run = () => axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
    rerender(
      <TranscriptView
        meeting={participantMeeting({ audio: { state: 'deleted' } })}
        focusSegmentId={null}
        onBackToAnswer={null}
      />,
    )
    expect((await run()).violations.map((v) => v.id)).toEqual([])
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
