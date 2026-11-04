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
  problem,
  readyMeeting,
  segment,
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

const view = (meeting: Meeting = readyMeeting()) =>
  render(<TranscriptView meeting={meeting} focusSegmentId={null} onBackToAnswer={null} />)

const meetingWithPeople = () =>
  readyMeeting({
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
    t.speakers[0] = { key: 'spk1', label: { kind: 'text', text: 'Boss' } }
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
    view(readyMeeting({ role: 'participant', can: CAN_NONE }))
    await screen.findAllByRole('listitem')
    expect(screen.queryByRole('button', { name: /^Edit segment/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull()
  })
})
