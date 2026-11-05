/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  problem,
  readyMeeting,
  segment,
  threePartTranscript,
  transcript,
  type FakeHandler,
} from '../../test-support/fakeApi'
import type { Meeting } from '../../lib/types'
import TranscriptView from './TranscriptView'

const serve = (routes: Record<string, FakeHandler>) => {
  const api = fakeApi(routes)
  vi.mocked(apiFetch).mockImplementation(api as unknown as typeof apiFetch)
  return api
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body))

const view = (meeting: Meeting = readyMeeting({ audio: { state: 'none' } })) =>
  render(<TranscriptView meeting={meeting} focusSegmentId={null} onBackToAnswer={null} />)

const meetingWithPeople = () =>
  readyMeeting({
    audio: { state: 'none' },
    participants: [
      { id: 'p1', kind: 'external', name: 'Barbara Liskov', organisation: null },
      { id: 'p2', kind: 'operai', person: { id: 'u-grace', name: 'Grace Hopper', status: 'active' } },
    ],
  })

const sameSpeaker = () =>
  transcript({
    segments: [
      segment(),
      segment({ id: 'seg2', ordinal: 2, startMs: 20_000, endMs: 25_000, speakerKey: 'spk1', text: 'Second thing.' }),
      segment({ id: 'seg3', ordinal: 3, startMs: 30_000, endMs: 35_000, speakerKey: 'spk2', text: 'Reply.' }),
    ],
  })

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
afterEach(cleanup)

describe('segment edit (AC-6.3)', () => {
  it('saves the text with the segment version as If-Match, then marks the segment Edited', async () => {
    let seen: { ifMatch: string | null; body: unknown } | null = null
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: transcript() }),
      'PATCH /meetings/:id/transcript/segments/:sid': (_url, init) => {
        seen = { ifMatch: new Headers(init?.headers).get('If-Match'), body: bodyOf(init) }
        return { status: 200, body: segment({ text: 'We agreed to ship on Thursday.', edited: true, version: 2 }) }
      },
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.editSegment('00:00:12') }))
    const box = screen.getByRole('textbox', { name: en.transcript.segmentTextLabel })
    await userEvent.clear(box)
    await userEvent.type(box, 'We agreed to ship on Thursday.')
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(await screen.findByText('We agreed to ship on Thursday.')).not.toBeNull()
    expect(seen).toEqual({ ifMatch: '"1"', body: { text: 'We agreed to ship on Thursday.' } })
    expect(screen.queryByRole('textbox', { name: en.transcript.segmentTextLabel })).toBeNull()
    expect(screen.getByText(en.transcript.edited)).not.toBeNull()
  })

  it('Cancel closes the editor and sends nothing', async () => {
    const api = serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: transcript() }) })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.editSegment('00:00:12') }))
    await userEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('textbox', { name: en.transcript.segmentTextLabel })).toBeNull()
    expect(api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0)
  })

  it.each([
    ['409 version_conflict', 409, 'version_conflict'],
    ['428 precondition_required', 428, 'precondition_required'],
  ])('a stale write (%s) shows the reload banner, and Reload loads the transcript again', async (_n, status, code) => {
    let loads = 0
    serve({
      'GET /meetings/:id/transcript': () => {
        loads++
        return { status: 200, body: transcript() }
      },
      'PATCH /meetings/:id/transcript/segments/:sid': () => ({ status, body: problem(status, code) }),
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.editSegment('00:00:12') }))
    await userEvent.type(screen.getByRole('textbox', { name: en.transcript.segmentTextLabel }), '!')
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(await screen.findByText(en.common.staleWrite.title)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.common.reload }))
    await waitFor(() => expect(loads).toBe(2))
    await screen.findAllByRole('listitem')
    expect(screen.queryByText(en.common.staleWrite.title)).toBeNull()
  })

  it('another failure shows its message inline and keeps the typed text', async () => {
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: transcript() }),
      'PATCH /meetings/:id/transcript/segments/:sid': () => ({ status: 403, body: problem(403, 'frozen') }),
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.editSegment('00:00:12') }))
    await userEvent.type(screen.getByRole('textbox', { name: en.transcript.segmentTextLabel }), ' now')
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.common.errors.frozen)
    expect((screen.getByRole('textbox', { name: en.transcript.segmentTextLabel }) as HTMLTextAreaElement).value).toBe(
      'We agreed to ship on Friday. now',
    )
  })

  it('refuses an empty text and one over 10,000 characters without calling the server', async () => {
    const api = serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: transcript() }) })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.editSegment('00:00:12') }))
    const box = screen.getByRole('textbox', { name: en.transcript.segmentTextLabel })
    await userEvent.clear(box)
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(screen.getByText(en.transcript.textRequired)).not.toBeNull()
    await userEvent.click(box)
    await userEvent.paste('x'.repeat(10_001))
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(screen.getByText(en.transcript.textTooLong)).not.toBeNull()
    expect(api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0)
  })
})

describe('speaker rename (AC-6.2)', () => {
  const openRename = async (name: string) => {
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.rename(name) }))
    return screen.getByRole('dialog')
  }

  it('naming a participant updates every segment of that speaker', async () => {
    let seen: unknown = null
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: sameSpeaker() }),
      'PUT /meetings/:id/transcript/speakers/:key': (_url, init, params) => {
        seen = { key: params['key'], body: bodyOf(init) }
        return { status: 200, body: { key: 'spk1', label: { kind: 'participant', participantId: 'p1' } } }
      },
    })
    view(meetingWithPeople())
    const dialog = await openRename('Speaker 1')
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), 'Barbara Liskov')
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.renameSubmit }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(seen).toEqual({ key: 'spk1', body: { participantId: 'p1' } })
    const rows = within(screen.getByRole('list', { name: en.transcript.heading })).getAllByRole('listitem')
    expect(within(rows[0]!).getByText('Barbara Liskov')).not.toBeNull()
    expect(within(rows[1]!).getByText('Barbara Liskov')).not.toBeNull()
    expect(within(rows[2]!).getByText('Speaker 2')).not.toBeNull()
  })

  it('free text is sent trimmed and applied', async () => {
    let seen: unknown = null
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: sameSpeaker() }),
      'PUT /meetings/:id/transcript/speakers/:key': (_url, init) => {
        seen = bodyOf(init)
        return { status: 200, body: { key: 'spk2', label: { kind: 'text', text: 'The client' } } }
      },
    })
    view(meetingWithPeople())
    const dialog = await openRename('Speaker 2')
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), en.transcript.optionCustom)
    await userEvent.type(within(dialog).getByRole('textbox', { name: en.transcript.nameLabel }), '  The client ')
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.renameSubmit }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(seen).toEqual({ text: 'The client' })
    expect(within(screen.getByRole('list', { name: en.transcript.heading })).getByText('The client')).not.toBeNull()
  })

  it('refuses a blank or 101-character name inline', async () => {
    const api = serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: sameSpeaker() }) })
    view(meetingWithPeople())
    const dialog = await openRename('Speaker 1')
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), en.transcript.optionCustom)
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.renameSubmit }))
    expect(within(dialog).getByText(en.transcript.nameRequired)).not.toBeNull()
    await userEvent.click(within(dialog).getByRole('textbox', { name: en.transcript.nameLabel }))
    await userEvent.paste('n'.repeat(101))
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.renameSubmit }))
    expect(within(dialog).getByText(en.transcript.nameTooLong)).not.toBeNull()
    expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
  })

  it('"back to the default name" sends null', async () => {
    let seen: unknown = 'unset'
    const t = sameSpeaker()
    t.speakers[0] = { key: 'spk1', label: { kind: 'text', text: 'Boss' }, parts: [1], joined: false }
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: t }),
      'PUT /meetings/:id/transcript/speakers/:key': (_url, init) => {
        seen = bodyOf(init)
        return { status: 200, body: { key: 'spk1', label: { kind: 'default', index: 1 } } }
      },
    })
    view(meetingWithPeople())
    const dialog = await openRename('Boss')
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), en.transcript.optionDefault)
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.renameSubmit }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(seen).toBeNull()
    expect(screen.queryByText('Boss')).toBeNull()
  })

  it('a failure stays in the dialog with its message', async () => {
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: sameSpeaker() }),
      'PUT /meetings/:id/transcript/speakers/:key': () => ({ status: 403, body: problem(403, 'creator_only') }),
    })
    view(meetingWithPeople())
    const dialog = await openRename('Speaker 1')
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), 'Grace Hopper')
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.renameSubmit }))
    expect(await within(dialog).findByText(en.common.errors.creator_only)).not.toBeNull()
    expect(screen.getByRole('dialog')).not.toBeNull()
  })
})

describe('without can.editTranscript (AC-6.2, AC-6.3)', () => {
  it('shows neither the edit buttons nor the rename controls', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: sameSpeaker() }) })
    view(readyMeeting({ role: 'participant', can: CAN_NONE, audio: { state: 'none' } }))
    await screen.findAllByRole('listitem')
    expect(screen.queryByRole('button', { name: /^Edit segment/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull()
  })
})

describe('joined labels and "Separate by part" (AC-6.16)', () => {
  /** k1 was matched across all three parts; k4 is a later part's label that stayed separate. */
  const joined = () =>
    transcript({
      segments: [
        segment({ id: 'a1', ordinal: 1, startMs: 0, endMs: 5_000, speakerKey: 'k1', part: 1, text: 'Opening.' }),
        segment({ id: 'b1', ordinal: 2, startMs: 3_600_000, endMs: 3_610_000, speakerKey: 'k1', part: 2, text: 'Back again.' }),
        segment({ id: 'd1', ordinal: 3, startMs: 3_700_000, endMs: 3_710_000, speakerKey: 'k4', part: 2, text: 'A newcomer.' }),
        segment({ id: 'c1', ordinal: 4, startMs: 7_200_000, endMs: 7_210_000, speakerKey: 'k1', part: 3, text: 'Closing.' }),
      ],
      speakers: [
        { key: 'k1', label: { kind: 'default', index: 1 }, parts: [1, 2, 3], joined: true },
        { key: 'k4', label: { kind: 'default', index: 4 }, parts: [2], joined: false },
      ],
      parts: [
        { index: 1, startMs: 0, endMs: 3_660_000 },
        { index: 2, startMs: 3_600_000, endMs: 7_260_000 },
        { index: 3, startMs: 7_200_000, endMs: 10_800_000 },
      ],
      separateLabels: true,
    })

  /** What the server answers once k1 is separated: k1 keeps part 1, parts 2 and 3 get k5 and k6. */
  const separated = () =>
    transcript({
      ...joined(),
      segments: joined().segments.map((s) =>
        s.id === 'b1' ? { ...s, speakerKey: 'k5' } : s.id === 'c1' ? { ...s, speakerKey: 'k6' } : s,
      ),
      speakers: [
        { key: 'k1', label: { kind: 'default', index: 1 }, parts: [1], joined: false },
        { key: 'k4', label: { kind: 'default', index: 4 }, parts: [2], joined: false },
        { key: 'k5', label: { kind: 'default', index: 1 }, parts: [2], joined: false },
        { key: 'k6', label: { kind: 'default', index: 1 }, parts: [3], joined: false },
      ],
    })

  const separateButton = () => screen.findByRole('button', { name: en.transcript.joined.separateLabel('Speaker 1') })

  it('a reader sees which parts a joined label covers, with an icon and text, and no way to change it', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }) })
    view(readyMeeting({ role: 'participant', can: CAN_NONE, audio: { state: 'none' } }))
    const list = await screen.findByRole('list', { name: en.transcript.speakersHeading })
    expect(within(list).getByText(en.transcript.joined.note('1–3'))).not.toBeNull()
    expect(en.transcript.joined.note('1–3')).toBe('Matched automatically across parts 1–3')
    expect(within(list).queryByRole('button')).toBeNull()
  })

  it('the creator gets Rename and Separate by part on a joined label only, and each separate label shows its part', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }) })
    view()
    const list = await screen.findByRole('list', { name: en.transcript.speakersHeading })
    expect(await separateButton()).not.toBeNull()
    expect(within(list).getAllByRole('button', { name: new RegExp(`^${en.transcript.joined.separate}`) })).toHaveLength(1)
    expect(within(list).getAllByRole('button', { name: /^Rename/ })).toHaveLength(2)
    expect(within(list).getByText(`(${en.transcript.joined.part(2)})`)).not.toBeNull()
  })

  it('no Separate by part when the creator cannot edit the transcript (a frozen meeting, AC-5.11)', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }) })
    view(readyMeeting({ frozen: true, can: CAN_NONE, audio: { state: 'none' } }))
    await screen.findByText(en.transcript.joined.note('1–3'))
    expect(screen.queryByRole('button', { name: new RegExp(en.transcript.joined.separate) })).toBeNull()
  })

  it('a transcript with nothing joined has no speakers list for a reader and no Separate for the creator', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: threePartTranscript() }) })
    view(readyMeeting({ role: 'participant', can: CAN_NONE, audio: { state: 'none' } }))
    await screen.findByText('Start of part two.')
    expect(screen.queryByRole('list', { name: en.transcript.speakersHeading })).toBeNull()
  })

  it('Separate asks first and says what it does; Cancel sends nothing', async () => {
    const api = serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }) })
    view()
    await userEvent.click(await separateButton())
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(en.transcript.separate.body('Speaker 1'))).not.toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('confirming POSTs to the separate route with no body, then shows each part under its own label', async () => {
    let done = false
    const api = serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: done ? separated() : joined() }),
      'POST /meetings/:id/transcript/speakers/:key/separate': (_url, init, params) => {
        expect(params['key']).toBe('k1')
        expect(init?.body).toBeUndefined()
        done = true
        return { status: 200, body: { speakers: separated().speakers } }
      },
    })
    view()
    await userEvent.click(await separateButton())
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.transcript.separate.confirm }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(screen.queryByText(en.transcript.joined.note('1–3'))).toBeNull())
    expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    // The transcript was read again: the later parts' rows are under the new labels, each label shows its part.
    const list = screen.getByRole('list', { name: en.transcript.speakersHeading })
    expect(within(list).getAllByText(`(${en.transcript.joined.part(2)})`)).toHaveLength(2)
    expect(within(list).getByText(`(${en.transcript.joined.part(3)})`)).not.toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(en.transcript.joined.separate) })).toBeNull()
    expect(document.activeElement).toBe(list)
  })

  it('if the transcript cannot be read again, the new labels show and Reload is offered', async () => {
    let done = false
    serve({
      'GET /meetings/:id/transcript': () => (done ? { status: 500, body: problem(500) } : { status: 200, body: joined() }),
      'POST /meetings/:id/transcript/speakers/:key/separate': () => {
        done = true
        return { status: 200, body: { speakers: separated().speakers } }
      },
    })
    view()
    await userEvent.click(await separateButton())
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.transcript.separate.confirm }))
    expect(await screen.findByText(en.common.staleWrite.title)).not.toBeNull()
    expect(screen.queryByText(en.transcript.joined.note('1–3'))).toBeNull()
  })

  it.each([
    ['403 frozen', 403, 'frozen', en.common.errors.frozen],
    ['403 creator_only', 403, 'creator_only', en.common.errors.creator_only],
    ['503 identity_unavailable', 503, 'identity_unavailable', en.common.errors.identity_unavailable],
    ['404 not_found', 404, 'not_found', en.common.errors.not_found],
  ])('a failure (%s) stays in the dialog with its message and changes nothing', async (_name, status, code, message) => {
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }),
      'POST /meetings/:id/transcript/speakers/:key/separate': () => ({ status, body: problem(status, code) }),
    })
    view()
    await userEvent.click(await separateButton())
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.separate.confirm }))
    expect(await within(dialog).findByText(message)).not.toBeNull()
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect(screen.getByText(en.transcript.joined.note('1–3'))).not.toBeNull()
    // The dialog is usable again: Cancel closes it.
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a network failure is shown in the dialog', async () => {
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }),
      'POST /meetings/:id/transcript/speakers/:key/separate': () => {
        throw new TypeError('offline')
      },
    })
    view()
    await userEvent.click(await separateButton())
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.separate.confirm }))
    expect(await within(dialog).findByText(en.common.networkError)).not.toBeNull()
  })

  it('409 not_joined means the page is out of date: the dialog closes and the reload banner shows', async () => {
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }),
      'POST /meetings/:id/transcript/speakers/:key/separate': () => ({ status: 409, body: problem(409, 'not_joined') }),
    })
    view()
    await userEvent.click(await separateButton())
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.transcript.separate.confirm }))
    expect(await screen.findByText(en.common.staleWrite.title)).not.toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('renaming a joined label keeps it joined: the rename changes the name, not the parts', async () => {
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }),
      'PUT /meetings/:id/transcript/speakers/:key': () => ({
        status: 200,
        body: { key: 'k1', label: { kind: 'text', text: 'Boss' } },
      }),
    })
    view(meetingWithPeople())
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.rename('Speaker 1') }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(new RegExp(en.transcript.joined.note('1–3')))).not.toBeNull()
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), en.transcript.optionCustom)
    await userEvent.type(within(dialog).getByRole('textbox', { name: en.transcript.nameLabel }), 'Boss')
    await userEvent.click(within(dialog).getByRole('button', { name: en.transcript.renameSubmit }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getAllByText('Boss').length).toBeGreaterThan(0)
    expect(screen.getByText(en.transcript.joined.note('1–3'))).not.toBeNull()
  })

  it('has Italian copy for the joined note and the dialog', () => {
    expect(italian.transcript.joined.note('1–3')).not.toBe(en.transcript.joined.note('1–3'))
    expect(italian.transcript.joined.separate).not.toBe(en.transcript.joined.separate)
    expect(italian.transcript.separate.body('Voce 1')).not.toBe(en.transcript.separate.body('Voce 1'))
  })

  it('has no axe violation: the joined list, and with the Separate dialog open (AC-13.3)', async () => {
    serve({ 'GET /meetings/:id/transcript': () => ({ status: 200, body: joined() }) })
    const { container } = view()
    await userEvent.click(await separateButton())
    // `region` is a whole-page rule: the test renders a fragment, not a page with landmarks.
    const run = (node: Element) =>
      axe.run(node, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect((await run(document.body)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect((await run(container)).violations.map((v) => v.id)).toEqual([])
  })
})

describe('the incomplete notice survives editing (AC-6.12, AC-6.3)', () => {
  it('saving a correction keeps the notice and the markers', async () => {
    const withGap = () => transcript({ gaps: [{ startMs: 300_000, endMs: 420_000 }] })
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: withGap() }),
      'PATCH /meetings/:id/transcript/segments/:sid': () => ({
        status: 200,
        body: segment({ text: 'We agreed to ship on Thursday.', edited: true, version: 2 }),
      }),
    })
    view()
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.editSegment('00:00:12') }))
    const box = screen.getByRole('textbox', { name: en.transcript.segmentTextLabel })
    await userEvent.clear(box)
    await userEvent.type(box, 'We agreed to ship on Thursday.')
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(await screen.findByText('We agreed to ship on Thursday.')).not.toBeNull()
    expect(screen.getByTestId('meetings-transcript-incomplete')).not.toBeNull()
    expect(screen.getAllByTestId('meetings-transcript-gap')).toHaveLength(1)
  })
})
