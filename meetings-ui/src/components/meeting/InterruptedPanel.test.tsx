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
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import type { Meeting } from '../../lib/types'
import { en } from '../../strings'
import { ADA, CAN_NONE, fakeApi, meeting, problem } from '../../test-support/fakeApi'
import type { FakeHandler } from '../../test-support/fakeApi'
import InterruptedPanel from './InterruptedPanel'

const t = en.capture.interrupted
const CONSENT: Meeting['consent'] = { by: ADA, at: '2026-11-03T09:29:00.000Z', noticeVersion: '2026-11-01' }

/** An interrupted recording as its creator sees it: 12 min 5 s were saved. */
const interrupted = (overrides: Partial<Meeting> = {}, lostMs: number | null = 0): Meeting =>
  meeting({
    status: 'interrupted',
    consent: CONSENT,
    durationMs: 725_000,
    audio: { state: 'kept', until: '2026-12-03T09:30:00.000Z' },
    recording: { live: false, durationMs: 725_000, lostMs },
    can: { ...CAN_NONE, capture: true, deleteAudio: true, deleteMeeting: true },
    ...overrides,
  })

const spoken = (ms: number) => formatDuration(ms, { style: 'spoken' })

let requests: string[]

const install = (routes: Record<string, FakeHandler> = {}) => {
  requests = []
  const note =
    (handler: FakeHandler): FakeHandler =>
    (url, init, params) => {
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return handler(url, init, params)
    }
  vi.mocked(apiFetch).mockImplementation(
    fakeApi({
      'POST /meetings/m1/recording/process': note(() => ({ status: 202, body: meeting({ status: 'processing' }) })),
      'POST /meetings/m1/recording/discard': note(() => ({ status: 200, body: meeting({ status: 'draft' }) })),
      ...Object.fromEntries(Object.entries(routes).map(([key, handler]) => [key, note(handler)])),
    }),
  )
}

const renderPanel = (m: Meeting = interrupted()) => {
  const onChanged = vi.fn()
  return { onChanged, ...render(<InterruptedPanel meeting={m} onChanged={onChanged} />) }
}

beforeEach(() => install())
afterEach(cleanup)

describe('what happened (AC-2.8, AC-2.9)', () => {
  it('says the recording was interrupted and how much audio was kept', () => {
    renderPanel()
    expect(screen.getByRole('alert').textContent).toContain(t.title(spoken(725_000)))
  })

  it('lostMs above zero: tells the creator how much was lost, as a lower bound ("at least")', () => {
    renderPanel(interrupted({}, 95_000))
    expect(screen.getByText(t.lostAtLeast(spoken(95_000)))).not.toBeNull()
    expect(screen.queryByText(t.lostUnknown)).toBeNull()
  })

  it('lostMs null (the server never learned how much was captured): the fallback sentence, no number', () => {
    renderPanel(interrupted({}, null))
    expect(screen.getByText(t.lostUnknown)).not.toBeNull()
    expect(screen.queryByText(/At least/)).toBeNull()
  })

  it('lostMs zero: nothing about a loss', () => {
    renderPanel(interrupted({}, 0))
    expect(screen.queryByText(t.lostUnknown)).toBeNull()
    expect(screen.queryByText(/At least/)).toBeNull()
  })

  it('the loss is the creator’s to read: a participant is told nothing about it, and gets no actions', () => {
    renderPanel(
      interrupted({
        role: 'participant',
        can: CAN_NONE,
        recording: { live: false, durationMs: 725_000, lostMs: null },
      }),
    )
    expect(screen.getByText(t.observer)).not.toBeNull()
    expect(screen.queryByText(t.lostUnknown)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a creator who may no longer capture (frozen, no access) gets no actions either', () => {
    renderPanel(interrupted({ can: CAN_NONE }))
    expect(screen.queryByRole('button', { name: t.process })).toBeNull()
    expect(screen.queryByRole('button', { name: t.discard })).toBeNull()
  })
})

describe('Process what was captured', () => {
  it('processes the saved audio and hands the page the meeting the server answered', async () => {
    const { onChanged } = renderPanel()
    await userEvent.setup().click(screen.getByRole('button', { name: t.process }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' })))
    expect(requests).toEqual(['POST /meetings/m1/recording/process'])
  })

  it('is the one primary action', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: t.process }).className).toContain('btn-primary')
    expect(screen.getByRole('button', { name: t.discard }).className).not.toContain('btn-primary')
  })

  it('is hidden once the audio is deleted: only Discard is left, and the reason is given', () => {
    renderPanel(interrupted({ audio: { state: 'deleted' } }))
    expect(screen.queryByRole('button', { name: t.process })).toBeNull()
    expect(screen.getByText(t.expired)).not.toBeNull()
    expect(screen.getByRole('button', { name: t.discard })).not.toBeNull()
  })

  it('is hidden when nothing was saved: only Discard, and the title says so', () => {
    renderPanel(
      interrupted({ durationMs: 0, audio: { state: 'none' }, recording: { live: false, durationMs: 0, lostMs: null } }),
    )
    expect(screen.queryByRole('button', { name: t.process })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(t.titleEmpty)
    expect(screen.getByRole('button', { name: t.discard })).not.toBeNull()
  })

  it('409 audio_deleted (the audio expired meanwhile) removes Process and says why, without leaving the panel', async () => {
    install({ 'POST /meetings/m1/recording/process': () => ({ status: 409, body: problem(409, 'audio_deleted') }) })
    const { onChanged } = renderPanel()
    await userEvent.setup().click(screen.getByRole('button', { name: t.process }))
    await screen.findByText(t.expired)
    expect(screen.queryByRole('button', { name: t.process })).toBeNull()
    expect(screen.getByRole('button', { name: t.discard })).not.toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('any other failure is shown and Process can be tried again', async () => {
    install({ 'POST /meetings/m1/recording/process': () => ({ status: 503, body: problem(503) }) })
    const { onChanged } = renderPanel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: t.process }))
    await screen.findByText(en.common.unknownError)
    expect(screen.getByRole('button', { name: t.process }).hasAttribute('disabled')).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('Discard', () => {
  it('asks first, in a dialog that says it cannot be undone, and does nothing on Cancel', async () => {
    const { onChanged } = renderPanel()
    const user = userEvent.setup()
    const opener = screen.getByRole('button', { name: t.discard })
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog')
    await user.click(opener)

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(t.discardBody)).not.toBeNull()
    await user.click(within(dialog).getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(requests).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('confirming discards the audio and hands the page the draft the server answered', async () => {
    const { onChanged } = renderPanel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: t.discard }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: t.discardConfirm }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' })))
    expect(requests).toEqual(['POST /meetings/m1/recording/discard'])
  })

  it('a failed discard keeps the dialog open with the reason', async () => {
    install({
      'POST /meetings/m1/recording/discard': () => ({ status: 503, body: problem(503, 'storage_unavailable') }),
    })
    const { onChanged } = renderPanel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: t.discard }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: t.discardConfirm }))
    await within(screen.getByRole('alertdialog')).findByText(en.common.errors.storage_unavailable)
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('accessibility', () => {
  it('has no axe violation, with the dialog closed and open', async () => {
    const { container } = renderPanel(interrupted({}, 30_000))
    const check = async (root: Element) =>
      (await axe.run(root, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      )
    expect(await check(container)).toEqual([])
    await userEvent.setup().click(screen.getByRole('button', { name: t.discard }))
    expect(await check(document.body)).toEqual([])
  })
})
