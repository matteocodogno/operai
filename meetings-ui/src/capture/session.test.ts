/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import type { Meeting, PresignedPost } from '../lib/types'
import { ADA, fakeApi, meeting, problem } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { FakeMediaRecorder, installFakeBrowserCapture } from '../test-support/fakeCapture'
import type { FakeBrowser } from '../test-support/fakeCapture'
import {
  HEARTBEAT_MS,
  LIMIT_MS,
  LIMIT_WARNING_MS,
  beginRecording,
  browserCaptureDeps,
  createRecordingSession,
  getRecordingSession,
  hasActiveRecordingSession,
} from './session'
import type { CaptureDeps, RecordingSession } from './session'
import type { CaptureSource } from './capabilities'

const CONSENT: Meeting['consent'] = { by: ADA, at: '2026-11-03T09:29:00.000Z', noticeVersion: '2026-11-01' }

const policy = (name: string): PresignedPost => ({
  url: `https://bucket.test/${name}`,
  fields: { key: name },
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})

type Sent = { path: string; body: Record<string, unknown> | null }

const bodyOf = (init: RequestInit | undefined) => (typeof init?.body === 'string' ? JSON.parse(init.body) : null)

let browser: FakeBrowser
let sent: Sent[]
let post: ReturnType<typeof vi.fn<(policy: PresignedPost, blob: Blob) => Promise<void>>>

const record = (handler: FakeHandler): FakeHandler => {
  return (url, init, params) => {
    sent.push({ path: `${init?.method ?? 'GET'} ${url.pathname}`, body: bodyOf(init) })
    return handler(url, init, params)
  }
}

const defaultRoutes = (): Record<string, FakeHandler> => ({
  'POST /meetings/m1/recording/start': record(() => ({
    status: 201,
    body: { sessionId: 's1', chunkSeconds: 10, maxChunkBytes: 8_388_608, next: policy('seq-0') },
  })),
  'POST /meetings/m1/recording/chunks/:seq/confirm': record((_url, _init, params) => ({
    status: 200,
    body: { storedChunks: Number(params.seq) + 1, durationMs: 10_000, next: policy(`seq-${Number(params.seq) + 1}`) },
  })),
  'POST /meetings/m1/recording/chunks/:seq/upload-url': record((_url, _init, params) => ({
    status: 200,
    body: policy(`minted-${params.seq}`),
  })),
  'POST /meetings/m1/recording/heartbeat': record(() => ({ status: 204 })),
  'POST /meetings/m1/recording/stop': record(() => ({
    status: 202,
    body: meeting({ status: 'processing', consent: CONSENT }),
  })),
  'POST /meetings/m1/recording/discard': record(() => ({ status: 200, body: meeting({ consent: CONSENT }) })),
})

type Setup = {
  routes?: Record<string, FakeHandler>
  browser?: Parameters<typeof installFakeBrowserCapture>[0]
  consent?: Meeting['consent']
  source?: CaptureSource
  deps?: Partial<CaptureDeps>
}

function setup(options: Setup = {}) {
  browser = installFakeBrowserCapture(options.browser)
  sent = []
  vi.mocked(apiFetch).mockImplementation(fakeApi({ ...defaultRoutes(), ...options.routes }))
  post = vi.fn(async () => undefined)
  const deps: CaptureDeps = { ...browserCaptureDeps(), post, ...options.deps }
  const init = {
    meeting: { id: 'm1', consent: options.consent === undefined ? CONSENT : options.consent },
    source: options.source ?? ('microphone' as const),
  }
  const session = createRecordingSession(init, deps)
  return { session, deps, init }
}

const recorder = () => FakeMediaRecorder.instances.at(-1)!
const paths = (prefix: string) => sent.filter((entry) => entry.path.startsWith(prefix))
const confirms = () => paths('POST /meetings/m1/recording/chunks/').filter((entry) => entry.path.endsWith('/confirm'))
const seqOf = (entry: Sent) => Number(/chunks\/(\d+)\//.exec(entry.path)![1])
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  // Date and the timers only: the Response body readers of the fake API need the real microtask queue.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  browser?.restore()
})

describe('starting (AC-2.1, AC-2.2, AC-2.3)', () => {
  it('asks the browser for nothing and starts nothing before the consent attestation exists', async () => {
    const { session } = setup({ consent: null, source: 'microphone+tab' })
    await session.start()

    expect(browser.getUserMedia).not.toHaveBeenCalled()
    expect(browser.getDisplayMedia).not.toHaveBeenCalled()
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(sent).toEqual([])
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', failure: { kind: 'consent' }, started: false })
  })

  it('a browser that cannot record asks for nothing either', async () => {
    const { session } = setup({
      deps: { capabilities: { ...browserCaptureDeps().capabilities, supported: false, microphone: false } },
    })
    await session.start()
    expect(browser.getUserMedia).not.toHaveBeenCalled()
    expect(session.getSnapshot().failure).toMatchObject({ kind: 'unsupported' })
  })

  it('asks for the speech microphone, builds the recorder, then tells the server, then records in 10 s slices', async () => {
    const { session } = setup()
    await session.start()

    expect(browser.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    })
    expect(recorder().options).toMatchObject({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 })
    expect(recorder().timeslice).toBe(10_000)
    expect(recorder().state).toBe('recording')
    expect(paths('POST /meetings/m1/recording/start')).toHaveLength(1)
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', started: true, failure: null })
  })

  it.each([
    ['NotAllowedError', 'denied'],
    ['NotFoundError', 'no_device'],
    ['NotReadableError', 'mic_unavailable'],
  ])('%s from the microphone keeps the meeting a draft: the server is never told (%s)', async (name, kind) => {
    const { session } = setup({ browser: { mic: new DOMException('nope', name) } })
    await session.start()

    expect(sent).toEqual([])
    expect(recorder_instances()).toBe(0)
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', started: false, failure: { kind } })
  })

  it('a closed tab picker starts nothing and does not ask for the microphone', async () => {
    const { session } = setup({
      source: 'microphone+tab',
      browser: { tab: new DOMException('closed', 'NotAllowedError') },
    })
    await session.start()
    expect(browser.getUserMedia).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(session.getSnapshot().failure).toMatchObject({ kind: 'tab_cancelled' })
  })

  it('a refused microphone releases the shared tab again, so the browser stops showing the share', async () => {
    const { session } = setup({
      source: 'microphone+tab',
      browser: { mic: new DOMException('nope', 'NotAllowedError') },
    })
    await session.start()
    expect(browser.tabs[0]!.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
  })

  it.each([
    ['recording_elsewhere', 409],
    ['consent_required', 409],
  ])('a start the server refuses (%s) releases the microphone and records nothing', async (code, status) => {
    const { session } = setup({
      routes: { 'POST /meetings/m1/recording/start': () => ({ status, body: problem(status, code) }) },
    })
    await session.start()

    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', started: false, failure: { kind: 'api' } })
    expect(browser.microphones[0]!.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
    expect(recorder().state).toBe('inactive') // built, never started
  })
})

const recorder_instances = () => FakeMediaRecorder.instances.length

describe('chunks and the pre-minted policy (AC-2.1, AC-2.8)', () => {
  it('saves every 10 s slice as soon as it is emitted: one bucket POST, one confirm with the captured time', async () => {
    const { session } = setup()
    await session.start()
    await advance(10_000)
    await advance(10_000)

    expect(post.mock.calls.map(([p]) => p.url)).toEqual(['https://bucket.test/seq-0', 'https://bucket.test/seq-1'])
    expect(confirms().map((entry) => entry.body)).toEqual([
      { sessionId: 's1', durationMs: 10_000, capturedMs: 10_000 },
      { sessionId: 's1', durationMs: 10_000, capturedMs: 20_000 },
    ])
    expect(session.getSnapshot()).toMatchObject({ savedChunks: 2, producedChunks: 2, queuedChunks: 0, offline: false })
  })
})

describe('pause and resume (AC-2.6)', () => {
  it('flushes at the pause, then adds no chunk and no duration while paused, and resumes the same recorder', async () => {
    const { session } = setup()
    await session.start()
    await advance(15_000) // chunk 0 at 10 s
    session.pause()
    await advance(0)
    expect(session.getSnapshot().phase).toBe('paused')
    expect(recorder().state).toBe('paused')
    const elapsedAtPause = session.elapsedMs()
    expect(elapsedAtPause).toBe(15_000)
    const emittedAtPause = recorder().emitted

    await advance(5 * 60_000)
    expect(recorder().emitted).toBe(emittedAtPause)
    expect(session.elapsedMs()).toBe(15_000)

    await session.resume()
    expect(session.getSnapshot().phase).toBe('recording')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    await advance(10_000)

    const durations = confirms().map((entry) => entry.body!['durationMs'])
    expect(durations).toEqual([10_000, 5_000, 10_000]) // 10 s, the 5 s closed by the pause, 10 s after resuming
    expect(session.elapsedMs()).toBe(25_000)
    expect(confirms().at(-1)!.body!['capturedMs']).toBe(25_000)
  })

  it('tells the server it is paused, every 30 s, with the audio captured so far, so a long pause is not an interruption', async () => {
    const { session } = setup()
    await session.start()
    await advance(25_000) // chunk 0 at 10 s and 1 at 20 s
    session.pause()
    await advance(2 * 60_000 + 5_000)

    const beats = paths('POST /meetings/m1/recording/heartbeat')
    // One at the pause (25 s), then the interval's own at 30, 60, 90, 120 and 150 s.
    expect(beats.length).toBe(1 + 5)
    expect(beats.every((entry) => entry.body!['paused'] === true && entry.body!['sessionId'] === 's1')).toBe(true)
    expect(beats.at(-1)!.body!['capturedMs']).toBe(25_000)
  })
})

describe('offline (AC-2.9, AC-4.11)', () => {
  const goOffline = () => post.mockRejectedValue(new TypeError('Failed to fetch'))

  it('keeps recording, reports the audio as not yet saved, and heartbeats with capturedMs while chunks are waiting', async () => {
    const { session } = setup()
    await session.start()
    goOffline()
    await advance(35_000)

    expect(recorder().state).toBe('recording')
    expect(session.getSnapshot()).toMatchObject({ offline: true, queuedChunks: 3, queuedMs: 30_000, savedChunks: 0 })
    const beats = paths('POST /meetings/m1/recording/heartbeat')
    expect(beats).toHaveLength(1)
    expect(beats[0]!.body).toEqual({ sessionId: 's1', paused: false, capturedMs: 30_000 })
    expect(HEARTBEAT_MS).toBe(30_000)
  })

  it('sends the waiting chunks in order once the connection is back, and says so', async () => {
    const { session } = setup()
    await session.start()
    goOffline()
    await advance(35_000)
    post.mockReset()
    post.mockResolvedValue(undefined)

    window.dispatchEvent(new Event('online'))
    await advance(0)
    await advance(5_000)

    expect(confirms().map(seqOf)).toEqual([0, 1, 2, 3])
    expect(post.mock.calls.map(([p]) => p.url.split('/').at(-1))).toEqual(['seq-0', 'seq-1', 'seq-2', 'seq-3'])
    expect(session.getSnapshot()).toMatchObject({ offline: false, queuedChunks: 0, reconnects: 1 })
    // The server was told what was captured, including what had been waiting.
    expect(confirms()[0]!.body!['capturedMs']).toBeGreaterThanOrEqual(30_000)
  })

  it('retries by itself, without the online event, with a growing wait', async () => {
    const { session } = setup()
    await session.start()
    goOffline()
    await advance(12_000)
    post.mockReset()
    post.mockResolvedValue(undefined)
    await advance(30_000)
    expect(confirms().map(seqOf).slice(0, 2)).toEqual([0, 1])
    expect(session.getSnapshot().offline).toBe(false)
  })
})

describe('the limits (AC-2.11)', () => {
  it('warns 10 minutes before 3 hours and stops by itself at 3 hours, then saves and processes', async () => {
    const { session } = setup()
    await session.start()

    await advance(LIMIT_WARNING_MS - 20_000)
    expect(session.getSnapshot().limitWarning).toBe(false)
    await advance(30_000)
    expect(session.getSnapshot().limitWarning).toBe(true)
    expect(session.getSnapshot().phase).toBe('recording')

    await advance(LIMIT_MS - LIMIT_WARNING_MS - 10_000)
    expect(session.getSnapshot()).toMatchObject({ autoStopped: true })
    await advance(1_000)
    const snapshot = session.getSnapshot()
    expect(snapshot).toMatchObject({ phase: 'done', autoStopped: true })
    expect(snapshot.result?.status).toBe('processing')
    expect(paths('POST /meetings/m1/recording/stop')).toHaveLength(1)
    expect(recorder().state).toBe('inactive')
  }, 60_000)

  it('the paused hours do not count towards the 3 h', async () => {
    const { session } = setup()
    await session.start()
    await advance(60_000)
    session.pause()
    await advance(4 * 3_600_000)
    expect(session.getSnapshot()).toMatchObject({ phase: 'paused', limitWarning: false })
  })
})

describe('stop (AC-2.7)', () => {
  it('flushes the last chunk, saves everything queued, THEN calls stop with the last seq, and releases the microphone', async () => {
    const { session } = setup()
    await session.start()
    await advance(25_000)
    await session.stop()

    const order = sent
      .filter((entry) => /confirm$|\/stop$/.test(entry.path))
      .map((entry) => entry.path.split('/').slice(-2).join('/'))
    expect(order).toEqual(['0/confirm', '1/confirm', '2/confirm', 'recording/stop'])
    expect(paths('POST /meetings/m1/recording/stop')[0]!.body).toEqual({ sessionId: 's1', lastSeq: 2 })
    expect(session.getSnapshot()).toMatchObject({ phase: 'done', savedChunks: 3 })
    expect(session.getSnapshot().result?.status).toBe('processing')
    expect(browser.microphones[0]!.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
    expect(browser.contexts[0]!.close).toHaveBeenCalled()
  })

  it('waits for the connection: it does not call stop while chunks are unsaved, and shows the progress', async () => {
    const { session } = setup()
    await session.start()
    post.mockRejectedValue(new TypeError('offline'))
    await advance(10_000)
    const stopping = session.stop()
    await advance(20_000)
    expect(session.getSnapshot()).toMatchObject({ phase: 'saving', producedChunks: 2, savedChunks: 0 })
    expect(paths('POST /meetings/m1/recording/stop')).toHaveLength(0)

    post.mockResolvedValue(undefined)
    window.dispatchEvent(new Event('online'))
    await advance(5_000)
    await stopping
    expect(session.getSnapshot().phase).toBe('done')
    expect(confirms().map(seqOf)).toEqual([0, 1])
  })

  it('keeps sending heartbeats while it is saving offline, so the meeting does not read interrupted', async () => {
    const { session } = setup()
    await session.start()
    post.mockRejectedValue(new TypeError('offline'))
    await advance(10_000)
    void session.stop()
    await advance(2 * 60_000)
    expect(paths('POST /meetings/m1/recording/heartbeat').length).toBeGreaterThanOrEqual(3)
    post.mockResolvedValue(undefined)
    window.dispatchEvent(new Event('online'))
    await advance(5_000)
  })

  it('chunks_missing sends the missing chunk again from memory and stops once the server has them all', async () => {
    let attempts = 0
    const { session } = setup({
      routes: {
        'POST /meetings/m1/recording/stop': record(() => {
          attempts += 1
          return attempts === 1
            ? { status: 409, body: problem(409, 'chunks_missing', { missing: [1] }) }
            : { status: 202, body: meeting({ status: 'processing', consent: CONSENT }) }
        }),
      },
    })
    await session.start()
    await advance(25_000)
    const stopping = session.stop()
    await advance(5_000)
    await stopping

    expect(attempts).toBe(2)
    // Chunk 1 was sent again, with a freshly minted policy.
    expect(paths('POST /meetings/m1/recording/chunks/1/upload-url')).toHaveLength(1)
    expect(confirms().map(seqOf)).toEqual([0, 1, 2, 1])
    expect(session.getSnapshot().phase).toBe('done')
  })

  it('a network failure of the stop call itself is retried, not lost', async () => {
    let attempts = 0
    const { session } = setup({
      routes: {
        'POST /meetings/m1/recording/stop': () => {
          attempts += 1
          return attempts === 1
            ? { status: 503, body: problem(503) }
            : { status: 202, body: meeting({ status: 'processing', consent: CONSENT }) }
        },
      },
    })
    await session.start()
    await advance(10_000)
    const stopping = session.stop()
    await advance(5_000)
    await stopping
    expect(attempts).toBe(2)
    expect(session.getSnapshot().phase).toBe('done')
  })

  it('stopping at once, before anything was captured, discards instead of saving an empty recording', async () => {
    const { session } = setup()
    await session.start()
    recorder().emit = () => undefined // a recorder that produced no bytes
    await session.stop()

    expect(paths('POST /meetings/m1/recording/discard')).toHaveLength(1)
    expect(paths('POST /meetings/m1/recording/stop')).toHaveLength(0)
    expect(session.getSnapshot()).toMatchObject({ phase: 'done', empty: true })
  })

  it('stop twice does one stop', async () => {
    const { session } = setup()
    await session.start()
    await advance(10_000)
    await Promise.all([session.stop(), session.stop()])
    expect(paths('POST /meetings/m1/recording/stop')).toHaveLength(1)
  })
})

describe('the shared tab and the microphone (AC-2.5)', () => {
  it('mixes the tab in, and when the share ends reports it once while the microphone keeps recording', async () => {
    const { session } = setup({ source: 'microphone+tab' })
    await session.start()
    expect(browser.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true })
    expect(session.getSnapshot().tabAudioLost).toBeNull()

    ;(browser.tabs[0]!.getVideoTracks()[0] as unknown as { end: () => void }).end()
    expect(session.getSnapshot().tabAudioLost).toBe('ended')
    expect(session.getSnapshot().phase).toBe('recording')
    expect(recorder().state).toBe('recording')
    expect(browser.microphones[0]!.getTracks()[0]!.readyState).toBe('live')
    await advance(10_000)
    expect(confirms()).toHaveLength(1)
  })

  it('a share with no audio track is reported from the first moment', async () => {
    const { session } = setup({ source: 'microphone+tab', browser: { tab: 'no-audio' } })
    await session.start()
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', tabAudioLost: 'no_audio_track' })
  })

  it('a microphone that stops pauses the recording; Resume asks for a new one and records on', async () => {
    const { session } = setup()
    await session.start()
    await advance(10_000)
    ;(browser.microphones[0]!.getTracks()[0] as unknown as { end: () => void }).end()

    expect(session.getSnapshot()).toMatchObject({ phase: 'paused', microphoneLost: true })
    await session.resume()
    expect(browser.getUserMedia).toHaveBeenCalledTimes(2)
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', microphoneLost: false })
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    await advance(10_000)
    const seqs = confirms().map(seqOf)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // the sequence goes on, no restart at 0
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('Resume with the microphone still missing stays paused and says why', async () => {
    const { session } = setup()
    await session.start()
    ;(browser.microphones[0]!.getTracks()[0] as unknown as { end: () => void }).end()
    browser.getUserMedia.mockRejectedValueOnce(new DOMException('gone', 'NotFoundError'))
    await session.resume()
    expect(session.getSnapshot()).toMatchObject({ phase: 'paused', resumeFailure: 'no_device' })
  })
})

describe('the server ends the session', () => {
  it.each([
    ['a heartbeat answered 404 (the meeting was erased)', 'heartbeat', 404, 'not_found'],
    ['a heartbeat answered session_inactive', 'heartbeat', 409, 'session_inactive'],
  ])('%s: the recorder stops, the memory is dropped, and it is reported', async (_name, _what, status, code) => {
    const { session } = setup({
      routes: { 'POST /meetings/m1/recording/heartbeat': () => ({ status, body: problem(status, code) }) },
    })
    await session.start()
    session.pause()
    await advance(0)
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', failure: { kind: 'api' } })
    expect(recorder().state).toBe('inactive')
    expect(browser.microphones[0]!.getTracks()[0]!.readyState).toBe('ended')
  })

  it('a chunk confirm answered session_inactive fails the session', async () => {
    const { session } = setup({
      routes: {
        'POST /meetings/m1/recording/chunks/:seq/confirm': () => ({
          status: 409,
          body: problem(409, 'session_inactive'),
        }),
      },
    })
    await session.start()
    await advance(10_000)
    expect(session.getSnapshot().phase).toBe('failed')
  })
})

describe('leaving (AC-2.10)', () => {
  it('a panel that goes away stops and saves, like Stop, unless it comes straight back', async () => {
    const { session } = setup()
    await session.start()
    await advance(10_000)

    session.detach()
    session.attach() // React re-mounting in the same tick
    await advance(1)
    expect(session.getSnapshot().phase).toBe('recording')

    session.detach()
    await advance(1)
    await advance(5_000)
    expect(session.getSnapshot().phase).toBe('done')
    expect(paths('POST /meetings/m1/recording/stop')).toHaveLength(1)
  })

  it('a panel that goes away while the browser is still asking cancels the start and keeps no device', async () => {
    let release: (stream: MediaStream) => void = () => undefined
    const pending = new Promise<MediaStream>((resolve) => (release = resolve))
    const { session } = setup()
    browser.getUserMedia.mockReturnValueOnce(pending)
    const starting = session.start()
    session.detach()
    await advance(1)
    release((await import('../test-support/fakeCapture')).micStream())
    await starting
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', failure: { kind: 'cancelled' } })
    expect(paths('POST /meetings/m1/recording/start')).toHaveLength(0)
  })
})

describe('the registry', () => {
  it('knows the live session of a meeting until it ends', async () => {
    browser = installFakeBrowserCapture()
    sent = []
    vi.mocked(apiFetch).mockImplementation(fakeApi(defaultRoutes()))
    const deps: CaptureDeps = { ...browserCaptureDeps(), post: vi.fn(async () => undefined) }

    const session: RecordingSession = beginRecording(
      { meeting: { id: 'm1', consent: CONSENT }, source: 'microphone' },
      deps,
    )
    expect(getRecordingSession('m1')).toBe(session)
    expect(hasActiveRecordingSession('m1')).toBe(true)
    await advance(0)
    await advance(10_000)
    await session.stop()
    expect(hasActiveRecordingSession('m1')).toBe(false)
    expect(getRecordingSession('m1')).toBeUndefined()
  })
})
