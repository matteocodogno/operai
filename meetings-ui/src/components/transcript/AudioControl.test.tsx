/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: () => 'http://meetings.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

import { apiFetch } from 'shell/session'
import { en } from '../../strings'
import { fakeApi, problem, readyMeeting, type FakeHandler } from '../../test-support/fakeApi'
import DeleteRecordingDialog from '../meeting/DeleteRecordingDialog'
import { AudioControl, type AudioHandle } from './AudioControl'
import TranscriptView from './TranscriptView'
import { transcript } from '../../test-support/fakeApi'

const serve = (routes: Record<string, FakeHandler>) => {
  const api = fakeApi(routes)
  vi.mocked(apiFetch).mockImplementation(api as unknown as typeof apiFetch)
  return api
}

const audioRoute = (urls: string[] = ['https://audio.test/a1', 'https://audio.test/a2', 'https://audio.test/a3']) => {
  let n = 0
  return {
    'GET /meetings/:id/audio': () => ({
      status: 200,
      body: { url: urls[Math.min(n++, urls.length - 1)], expiresAt: '2026-11-03T09:45:00.000Z' },
    }),
  }
}

const audioEl = () => document.querySelector('audio')!

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
afterEach(cleanup)

describe('AudioControl (AC-4.4, AC-6.5)', () => {
  it('kept: a player with a minted URL and the formatted expiry date', async () => {
    serve(audioRoute())
    render(<AudioControl meeting={readyMeeting()} />)
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a1'))
    expect(audioEl().getAttribute('aria-label')).toBe(en.audio.label)
    expect(screen.getByText(en.audio.keptUntil('03.12.2026'))).not.toBeNull()
  })

  it('deleted: no player, no request, and the line says so', () => {
    const api = serve(audioRoute())
    render(<AudioControl meeting={readyMeeting({ audio: { state: 'deleted' } })} />)
    expect(document.querySelector('audio')).toBeNull()
    expect(screen.getByText(en.audio.deleted)).not.toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('no audio at all (a text meeting): renders nothing', () => {
    const api = serve(audioRoute())
    const { container } = render(<AudioControl meeting={readyMeeting({ audio: { state: 'none' } })} />)
    expect(container.textContent).toBe('')
    expect(api).not.toHaveBeenCalled()
  })

  it('a media error mints a new URL once and resumes from where it was', async () => {
    const api = serve(audioRoute())
    render(<AudioControl meeting={readyMeeting()} />)
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a1'))
    audioEl().currentTime = 42
    fireEvent.error(audioEl())
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a2'))
    expect(api.mock.calls.filter(([url]) => String(url).endsWith('/audio'))).toHaveLength(2)
    // The new source reports its length: playback resumes at 42 s.
    fireEvent.loadedMetadata(audioEl())
    expect(audioEl().currentTime).toBe(42)
  })

  it('a second error before the audio plays does not mint again: it says the audio cannot be played', async () => {
    const api = serve(audioRoute())
    render(<AudioControl meeting={readyMeeting()} />)
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a1'))
    fireEvent.error(audioEl())
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a2'))
    fireEvent.error(audioEl())
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.getByText(en.audio.playbackFailed)).not.toBeNull()
    expect(api.mock.calls.filter(([url]) => String(url).endsWith('/audio'))).toHaveLength(2)
  })

  it('once playback has worked, a later error mints again (the 15 minutes ran out)', async () => {
    const api = serve(audioRoute())
    render(<AudioControl meeting={readyMeeting()} />)
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a1'))
    fireEvent.error(audioEl())
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a2'))
    fireEvent.canPlay(audioEl())
    fireEvent.error(audioEl())
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a3'))
    expect(api.mock.calls.filter(([url]) => String(url).endsWith('/audio'))).toHaveLength(3)
  })

  it('a refusal to mint (the audio was deleted meanwhile) shows its message', async () => {
    serve({ 'GET /meetings/:id/audio': () => ({ status: 409, body: problem(409, 'audio_unavailable') }) })
    render(<AudioControl meeting={readyMeeting()} />)
    expect((await screen.findByRole('alert')).textContent).toContain(en.common.errors.audio_unavailable)
  })

  it('playFrom seeks and plays', async () => {
    serve(audioRoute())
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const handle = createRef<AudioHandle>()
    render(<AudioControl meeting={readyMeeting()} ref={handle} />)
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a1'))
    act(() => handle.current!.playFrom(12_000))
    expect(audioEl().currentTime).toBe(12)
    expect(play).toHaveBeenCalledTimes(1)
    play.mockRestore()
  })

  it('a segment time plays from there while audio is kept, and is plain text once it is deleted', async () => {
    serve({
      'GET /meetings/:id/transcript': () => ({ status: 200, body: transcript() }),
      ...audioRoute(),
    })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const { rerender } = render(<TranscriptView meeting={readyMeeting()} focusSegmentId={null} onBackToAnswer={null} />)
    await waitFor(() => expect(audioEl().getAttribute('src')).toBe('https://audio.test/a1'))
    await userEvent.click(await screen.findByRole('button', { name: en.transcript.playFrom('12 seconds') }))
    expect(audioEl().currentTime).toBe(12)
    expect(play).toHaveBeenCalled()
    rerender(
      <TranscriptView
        meeting={readyMeeting({ audio: { state: 'deleted' } })}
        focusSegmentId={null}
        onBackToAnswer={null}
      />,
    )
    expect(document.querySelector('audio')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Play from/ })).toBeNull()
    expect(screen.getByText('00:00:12')).not.toBeNull()
    play.mockRestore()
  })
})

describe('DeleteRecordingDialog (AC-4.5)', () => {
  const open = () => {
    const onChanged = vi.fn()
    const onClose = vi.fn()
    render(<DeleteRecordingDialog meeting={readyMeeting()} onChanged={onChanged} onClose={onClose} />)
    return { onChanged, onClose }
  }

  it('says what stays, and Cancel changes nothing', async () => {
    const api = serve({})
    const { onClose } = open()
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect(screen.getByText(en.audio.deleteRecording.body)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api).not.toHaveBeenCalled()
  })

  it('confirming calls DELETE …/audio, hands the updated meeting up and closes', async () => {
    const updated = readyMeeting({ audio: { state: 'deleted' } })
    const api = serve({ 'DELETE /meetings/:id/audio': () => ({ status: 200, body: updated }) })
    const { onChanged, onClose } = open()
    await userEvent.click(screen.getByRole('button', { name: en.audio.deleteRecording.confirm }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(
      api.mock.calls.some(([url, init]) => String(url).endsWith('/meetings/m1/audio') && init?.method === 'DELETE'),
    ).toBe(true)
  })

  it('a storage failure keeps the dialog open with "Nothing was deleted"', async () => {
    serve({ 'DELETE /meetings/:id/audio': () => ({ status: 503, body: problem(503, 'storage_unavailable') }) })
    const { onChanged, onClose } = open()
    await userEvent.click(screen.getByRole('button', { name: en.audio.deleteRecording.confirm }))
    expect(await screen.findByText(en.common.errors.storage_unavailable)).not.toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
