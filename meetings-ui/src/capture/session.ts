/**
 * session — the RecordingSession controller (specs/021-meetings plan § Browser capture, D-4; AC-2.1,
 * AC-2.2, AC-2.6 to AC-2.9, AC-2.11, AC-4.11).
 *
 * It is a module-level controller, NOT a component: it owns the microphone, the Web Audio graph, the
 * `MediaRecorder` and the chunk queue, and it outlives the panel that started it. A panel that unmounts
 * (a confirmed in-app leave, AC-2.10) therefore does not lose the audio: the session stops, flushes what
 * is queued and calls `recording/stop`, exactly as Stop does. The panel only subscribes to a snapshot and
 * calls pause / resume / stop.
 *
 *   consent? ─no─▶ refuse, ask the browser for nothing                           (AC-2.1)
 *      │yes
 *      ▼
 *   [tab picker] ─▶ microphone ─▶ mixer ─▶ MediaRecorder (built, not yet started)
 *      │ any refusal: nothing was started on the server, the meeting stays a draft  (AC-2.3)
 *      ▼
 *   POST recording/start ─▶ recorder.start(10 s) ─▶ every chunk ─▶ uploader (in memory, in order)
 *      ▼
 *   pause: flush, pause (no chunk, no duration while paused) · heartbeat every 30 s while paused or
 *   unsaved · warning at 2 h 50 · stop by itself at 3 h
 *      ▼
 *   stop: recorder.stop() flushes the last chunk ─▶ uploader drains ─▶ POST recording/stop { lastSeq }
 *
 * Nothing is persisted on the device (AC-4.11): the queue is a JavaScript array. The cost is that audio
 * captured while offline lives only as long as the tab does; `noStorage.test.ts` scans this folder for
 * any use of the browser's storage APIs.
 *
 * The clock counts RECORDED time only. A chunk's length is the recorded time since the previous chunk
 * (clamped to the server's 15 s), so a paused span, or a laptop that slept, never inflates `capturedMs`
 * or the 3 h limit; `capturedMs` is the sum of the chunks flushed so far, saved or not.
 */
import { detectCapabilities, readEnvironment } from './capabilities'
import type { CaptureCapabilities, CaptureSource } from './capabilities'
import { createMixer, MIC_CONSTRAINTS, TAB_CONSTRAINTS } from './mixer'
import type { AudioContextLike, AudioMixer, TabAudioLostReason } from './mixer'
import { UPLOAD_BACKOFF, MAX_CAPTURED_MS, createUploader, isFatalUploadError } from './uploader'
import type { Uploader, UploaderApi } from './uploader'
import { ApiError } from '../lib/api'
import { nextDelay } from '../lib/backoff'
import * as meetingsApi from '../lib/meetingsApi'
import type { Meeting, PresignedPost, RecordingStart } from '../lib/types'

export const CHUNK_MS = 10_000
/** The server refuses a chunk longer than this. */
export const MAX_CHUNK_MS = 15_000
export const HEARTBEAT_MS = 30_000
/** "This recording stops by itself in 10 minutes": 2 h 50. */
export const LIMIT_WARNING_MS = 10_200_000
/** The recording stops itself at 3 h (AC-2.11). */
export const LIMIT_MS = 10_800_000
/** 32 kbit/s mono: 3 h is about 43 MB. */
const AUDIO_BITS_PER_SECOND = 32_000
/** How long to wait for the recorder's `stop` event before carrying on. */
const RECORDER_STOP_TIMEOUT_MS = 5_000

export type SessionApi = UploaderApi & {
  startRecording: (meetingId: string) => Promise<RecordingStart>
  sendHeartbeat: (meetingId: string, body: { sessionId: string; paused: boolean; capturedMs: number }) => Promise<void>
  stopRecording: (meetingId: string, body: { sessionId: string; lastSeq: number }) => Promise<Meeting>
  discardRecording: (meetingId: string) => Promise<Meeting>
}

/** The parts of `MediaRecorder` the session uses, so a test supplies a fake. */
export type RecorderLike = EventTarget & {
  readonly state: RecordingState
  start: (timeslice?: number) => void
  stop: () => void
  pause: () => void
  resume: () => void
  requestData: () => void
}

/** Everything the session needs from the browser and from meetings-api; the defaults are the real ones. */
export type CaptureDeps = {
  api: SessionApi
  capabilities: CaptureCapabilities
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>
  createAudioContext: () => AudioContextLike
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => RecorderLike
  /** The bucket POST of one chunk (`postToBucket` by default). */
  post?: (policy: PresignedPost, blob: Blob) => Promise<void>
  now: () => number
}

type AudioContextCtor = new () => AudioContextLike

export function browserCaptureDeps(): CaptureDeps {
  return {
    api: meetingsApi,
    capabilities: detectCapabilities(readEnvironment()),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
    createAudioContext: () => {
      const scope = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
      const Context = scope.AudioContext ?? scope.webkitAudioContext
      if (!Context) throw new Error('This browser has no Web Audio')
      return new Context()
    },
    createRecorder: (stream, options) => new MediaRecorder(stream, options),
    now: () => Date.now(),
  }
}

export type SessionPhase = 'requesting' | 'recording' | 'paused' | 'saving' | 'done' | 'failed'

export type SessionFailure = {
  kind:
    | 'consent'
    | 'unsupported'
    /** The person (or the browser's policy) refused the microphone. */
    | 'denied'
    /** There is no input device. */
    | 'no_device'
    /** The device exists but cannot be opened (another app holds it). */
    | 'mic_unavailable'
    /** The tab picker was closed without choosing. */
    | 'tab_cancelled'
    /** meetings-api refused, or went away mid-recording: `error` is the ApiError. */
    | 'api'
    /** The recorder itself failed. */
    | 'recorder'
    /** The panel went away before the browser answered. */
    | 'cancelled'
  error?: unknown
}

export type SessionSnapshot = {
  phase: SessionPhase
  failure: SessionFailure | null
  /** `recording/start` succeeded: a session exists on the server. */
  started: boolean
  /** The shared tab's audio is no longer captured (AC-2.5); the microphone carries on. */
  tabAudioLost: TabAudioLostReason | null
  /** The microphone stopped (unplugged, revoked): the recorder is paused until Resume re-acquires it. */
  microphoneLost: boolean
  /** Resume could not re-acquire the microphone. */
  resumeFailure: SessionFailure['kind'] | null
  /** Saving is failing right now: the audio is NOT yet saved (AC-2.9). */
  offline: boolean
  queuedChunks: number
  queuedMs: number
  savedChunks: number
  producedChunks: number
  /** How many times saving came back after a failure: the panel announces each. */
  reconnects: number
  limitWarning: boolean
  /** The 3 h limit stopped it. */
  autoStopped: boolean
  /** `recording/stop` keeps answering `chunks_missing`. */
  stalled: boolean
  /** Nothing was captured at all: the meeting went back to draft. */
  empty: boolean
  /** The meeting as the server answered Stop (`processing`), or Discard when `empty`. */
  result: Meeting | null
}

const INITIAL: SessionSnapshot = {
  phase: 'requesting',
  failure: null,
  started: false,
  tabAudioLost: null,
  microphoneLost: false,
  resumeFailure: null,
  offline: false,
  queuedChunks: 0,
  queuedMs: 0,
  savedChunks: 0,
  producedChunks: 0,
  reconnects: 0,
  limitWarning: false,
  autoStopped: false,
  stalled: false,
  empty: false,
  result: null,
}

export type RecordingSession = {
  readonly meetingId: string
  getSnapshot: () => SessionSnapshot
  subscribe: (listener: () => void) => () => void
  /** Recorded time so far, paused spans excluded. */
  elapsedMs: () => number
  /** Asks for the devices and starts. Resolves once recording (or failed). */
  start: () => Promise<void>
  pause: () => void
  resume: () => Promise<void>
  /** Stops, saves everything and calls `recording/stop`. Resolves when done or failed. */
  stop: () => Promise<void>
  /** A panel is showing this session: cancels a pending leave. */
  attach: () => void
  /** The panel went away: unless it comes back at once (React re-mounting), the session stops and saves. */
  detach: () => void
}

export type SessionInit = {
  meeting: Pick<Meeting, 'id' | 'consent'>
  source: CaptureSource
}

type Pipeline = {
  mixer: AudioMixer
  recorder: RecorderLike
  teardown: () => void
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const errorName = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''

/** Sorts a `getUserMedia` failure into what the person has to do about it. */
export function classifyMicrophoneError(error: unknown): SessionFailure['kind'] {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'denied'
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'no_device'
    default:
      return 'mic_unavailable'
  }
}

const stopTracks = (stream: MediaStream | null | undefined) => {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

export function createRecordingSession(
  init: SessionInit,
  deps: CaptureDeps,
  hooks: { onEnd?: () => void } = {},
): RecordingSession {
  const meetingId = init.meeting.id
  let snap: SessionSnapshot = INITIAL
  const listeners = new Set<() => void>()

  const patch = (change: Partial<SessionSnapshot>) => {
    snap = { ...snap, ...change }
    for (const listener of [...listeners]) listener()
  }

  // ─── The clock: recorded time only ────────────────────────────────────────
  let activeBefore = 0
  let runningSince: number | null = null
  let boundaryActive = 0
  let producedMs = 0
  let nextSeq = 0

  const activeNow = () => activeBefore + (runningSince === null ? 0 : deps.now() - runningSince)
  const freeze = () => {
    if (runningSince !== null) {
      activeBefore += deps.now() - runningSince
      runningSince = null
    }
  }
  const unfreeze = () => {
    if (runningSince === null) runningSince = deps.now()
  }
  const elapsedMs = () => producedMs + clamp(activeNow() - boundaryActive, 0, MAX_CHUNK_MS)

  // ─── State ────────────────────────────────────────────────────────────────
  let sessionId = ''
  let uploader: Uploader | null = null
  let pipeline: Pipeline | null = null
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let stopping: Promise<void> | null = null
  let starting: Promise<void> | null = null
  let beating = false
  let terminal = false
  let cancelled = false
  let stopFailing = false
  let offlineSeen = false
  let removeOnline: (() => void) | undefined

  // ─── Wiring the uploader into the snapshot ────────────────────────────────
  const syncFromUploader = () => {
    if (!uploader) return
    const state = uploader.snapshot()
    const offline = state.offline || stopFailing
    if (offlineSeen && !offline) patch({ reconnects: snap.reconnects + 1 })
    offlineSeen = offline
    patch({ offline, queuedChunks: state.queued, queuedMs: state.queuedMs, savedChunks: state.saved })
  }

  // ─── Ending ───────────────────────────────────────────────────────────────
  const clearTimers = () => {
    clearInterval(tickTimer)
    clearInterval(heartbeatTimer)
    tickTimer = undefined
    heartbeatTimer = undefined
    removeOnline?.()
    removeOnline = undefined
  }

  const releasePipeline = async () => {
    const current = pipeline
    pipeline = null
    if (!current) return
    current.teardown()
    try {
      if (current.recorder.state !== 'inactive') current.recorder.stop()
    } catch {
      // A recorder that is already gone has nothing to stop.
    }
    await current.mixer.close().catch(() => undefined)
  }

  const end = (change: Partial<SessionSnapshot>) => {
    terminal = true
    clearTimers()
    clearTimeout(leaveTimer)
    uploader?.dispose()
    patch(change)
    hooks.onEnd?.()
  }

  /** Gives up: the in-memory audio is dropped (the server keeps what it already stored). */
  const fail = (failure: SessionFailure) => {
    if (terminal) return
    end({ phase: 'failed', failure, offline: false })
    void releasePipeline()
  }

  const failFromApi = (error: unknown) => fail({ kind: 'api', error })

  // ─── Chunks ───────────────────────────────────────────────────────────────
  const checkLimits = () => {
    if (terminal) return
    const elapsed = elapsedMs()
    if (!snap.limitWarning && elapsed >= LIMIT_WARNING_MS) patch({ limitWarning: true })
    if (elapsed >= LIMIT_MS && snap.phase === 'recording') void stop('limit')
  }

  const onData = (event: Event) => {
    const blob = (event as Event & { data?: Blob }).data
    if (terminal || !uploader || !blob || blob.size === 0) return
    const now = activeNow()
    // At least 1 ms: the trailing bytes of a stream are still a chunk, and the server wants a length.
    const durationMs = Math.max(1, clamp(now - boundaryActive, 0, MAX_CHUNK_MS))
    boundaryActive = now
    producedMs += durationMs
    uploader.enqueue({ seq: nextSeq, blob, durationMs })
    nextSeq += 1
    patch({ producedChunks: nextSeq })
    checkLimits()
  }

  const beat = async () => {
    if (beating || terminal || !snap.started) return
    beating = true
    try {
      await deps.api.sendHeartbeat(meetingId, {
        sessionId,
        paused: snap.phase === 'paused',
        capturedMs: clamp(Math.round(producedMs), 0, MAX_CAPTURED_MS),
      })
    } catch (error) {
      if (isFatalUploadError(error)) failFromApi(error)
    } finally {
      beating = false
    }
  }

  // ─── The pipeline: microphone (+ tab) → mixer → recorder ─────────────────
  const buildPipeline = async (microphone: MediaStream, tab: MediaStream | null): Promise<Pipeline> => {
    const mixer = await createMixer({ context: deps.createAudioContext(), microphone, tab })
    const recorder = deps.createRecorder(mixer.output, {
      ...(deps.capabilities.mimeType ? { mimeType: deps.capabilities.mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    })
    const onError = () => fail({ kind: 'recorder' })
    recorder.addEventListener('dataavailable', onData)
    recorder.addEventListener('error', onError)
    const offs = [
      mixer.on('tabAudioLost', (reason) => patch({ tabAudioLost: reason })),
      mixer.on('microphoneLost', () => {
        if (pipeline?.mixer !== mixer || terminal) return
        if (snap.phase === 'recording') pause()
        patch({ microphoneLost: true })
      }),
    ]
    return {
      mixer,
      recorder,
      teardown: () => {
        for (const off of offs) off()
        recorder.removeEventListener('dataavailable', onData)
        recorder.removeEventListener('error', onError)
      },
    }
  }

  // ─── Start ────────────────────────────────────────────────────────────────
  const run = async () => {
    // AC-2.1: nothing is requested from the browser, and no recording starts, without the attestation.
    if (init.meeting.consent === null) return fail({ kind: 'consent' })
    if (!deps.capabilities.supported) return fail({ kind: 'unsupported' })

    let tab: MediaStream | null = null
    let microphone: MediaStream | null = null
    const abandon = () => {
      stopTracks(tab)
      stopTracks(microphone)
    }

    // The picker first: it needs the click's user activation, which a microphone prompt may use up.
    if (init.source === 'microphone+tab') {
      try {
        tab = await deps.getDisplayMedia(TAB_CONSTRAINTS)
      } catch {
        return fail({ kind: 'tab_cancelled' })
      }
    }
    try {
      microphone = await deps.getUserMedia(MIC_CONSTRAINTS)
    } catch (error) {
      abandon()
      return fail({ kind: classifyMicrophoneError(error), error })
    }
    if (cancelled) {
      abandon()
      return fail({ kind: 'cancelled' })
    }

    let built: Pipeline
    try {
      built = await buildPipeline(microphone, tab)
    } catch (error) {
      abandon()
      return fail({ kind: 'recorder', error })
    }
    pipeline = built

    // Only now does the server hear about it: a refusal above leaves the meeting a plain draft (AC-2.3).
    let started: RecordingStart
    try {
      started = await deps.api.startRecording(meetingId)
    } catch (error) {
      return fail({ kind: 'api', error })
    }
    if (cancelled) {
      // The panel went away while the browser was asking. The server session exists with no audio: it
      // reads `interrupted` after 2 minutes and the creator can discard it.
      return fail({ kind: 'cancelled' })
    }

    sessionId = started.sessionId
    uploader = createUploader({
      meetingId,
      sessionId,
      firstPolicy: started.next,
      api: deps.api,
      ...(deps.post ? { post: deps.post } : {}),
      capturedMs: () => producedMs,
      backoff: UPLOAD_BACKOFF,
    })
    uploader.subscribe(syncFromUploader)
    uploader.onFatal(failFromApi)

    built.recorder.start((started.chunkSeconds || CHUNK_MS / 1000) * 1000)
    unfreeze()
    patch({ phase: 'recording', started: true })

    tickTimer = setInterval(checkLimits, 1_000)
    heartbeatTimer = setInterval(() => {
      if (snap.phase === 'paused' || snap.phase === 'saving' || (uploader?.snapshot().queued ?? 0) > 0) void beat()
    }, HEARTBEAT_MS)
    const onOnline = () => uploader?.retryNow()
    const target = globalThis as unknown as Partial<Pick<Window, 'addEventListener' | 'removeEventListener'>>
    target.addEventListener?.('online', onOnline)
    removeOnline = () => target.removeEventListener?.('online', onOnline)
  }

  // ─── Pause and resume (AC-2.6) ────────────────────────────────────────────
  function pause() {
    if (snap.phase !== 'recording' || !pipeline) return
    // Freeze the clock first, then flush: the chunk that closes the span ends at this instant.
    freeze()
    pipeline.recorder.requestData()
    pipeline.recorder.pause()
    patch({ phase: 'paused' })
    void beat()
  }

  /** The microphone was lost: a fresh one needs a fresh graph, and with it a fresh recorder. */
  const replaceMicrophone = async () => {
    const microphone = await deps.getUserMedia(MIC_CONSTRAINTS)
    let next: Pipeline
    try {
      next = await buildPipeline(microphone, null)
    } catch (error) {
      stopTracks(microphone)
      throw error
    }
    const previous = pipeline
    pipeline = next
    if (previous) {
      // Its closing flush still counts: the listener is detached only afterwards.
      try {
        if (previous.recorder.state !== 'inactive') previous.recorder.stop()
      } catch {
        // already stopped
      }
      previous.teardown()
      // Closing the old graph stops the shared tab's tracks too: the share ends with it.
      await previous.mixer.close().catch(() => undefined)
      if (previous.mixer.tabAudio === 'active') patch({ tabAudioLost: 'ended' })
    }
    next.recorder.start(CHUNK_MS)
  }

  const resume = async () => {
    if (snap.phase !== 'paused' || !pipeline) return
    try {
      if (snap.microphoneLost) await replaceMicrophone()
      else pipeline.recorder.resume()
    } catch (error) {
      patch({ resumeFailure: classifyMicrophoneError(error) })
      return
    }
    if (snap.phase !== 'paused') return
    unfreeze()
    patch({ phase: 'recording', microphoneLost: false, resumeFailure: null })
  }

  // ─── Stop (AC-2.7, AC-2.11) ───────────────────────────────────────────────
  const waitForRecorderStop = (recorder: RecorderLike) =>
    new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') return resolve()
      const done = () => {
        clearTimeout(timer)
        recorder.removeEventListener('stop', done)
        resolve()
      }
      const timer = setTimeout(done, RECORDER_STOP_TIMEOUT_MS)
      recorder.addEventListener('stop', done)
      recorder.stop()
    })

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  /** `recording/stop`, retried while the network is down; `chunks_missing` sends the missing chunks again. */
  const finishOnServer = async (lastSeq: number): Promise<Meeting> => {
    let delay = UPLOAD_BACKOFF.baseMs
    let missingAnswers = 0
    for (;;) {
      try {
        const meeting = await deps.api.stopRecording(meetingId, { sessionId, lastSeq })
        stopFailing = false
        return meeting
      } catch (error) {
        if (terminal) throw error
        if (error instanceof ApiError && error.status === 409 && error.code === 'chunks_missing') {
          const missing = Array.isArray(error.extras['missing']) ? (error.extras['missing'] as number[]) : []
          missingAnswers += 1
          if (missingAnswers >= 3) patch({ stalled: true })
          if (!uploader?.requeue(missing)) throw error
          await uploader.idle()
        } else if (isFatalUploadError(error)) {
          throw error
        } else {
          stopFailing = true
          syncFromUploader()
        }
        await sleep(delay)
        delay = nextDelay(delay, UPLOAD_BACKOFF)
      }
    }
  }

  async function stop(reason: 'user' | 'limit' | 'leave' = 'user'): Promise<void> {
    if (stopping) return stopping
    if (snap.phase === 'requesting') {
      cancelled = true
      return starting ?? Promise.resolve()
    }
    if (snap.phase !== 'recording' && snap.phase !== 'paused') return
    stopping = (async () => {
      patch({ phase: 'saving', autoStopped: reason === 'limit' })
      freeze()
      clearInterval(tickTimer)
      tickTimer = undefined
      try {
        const current = pipeline
        if (current) {
          await waitForRecorderStop(current.recorder)
          current.teardown()
          await current.mixer.close().catch(() => undefined)
          pipeline = null
        }
        if (nextSeq === 0) {
          // Nothing was captured: there is nothing to save, and the meeting goes back to a draft.
          const meeting = await deps.api.discardRecording(meetingId)
          return end({ phase: 'done', empty: true, result: meeting })
        }
        await uploader?.idle()
        const meeting = await finishOnServer(nextSeq - 1)
        end({ phase: 'done', result: meeting, offline: false })
      } catch (error) {
        failFromApi(error)
      }
    })()
    return stopping
  }

  return {
    meetingId,
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    elapsedMs,
    start() {
      starting ??= run().catch((error: unknown) => fail({ kind: 'recorder', error }))
      return starting
    },
    pause,
    resume,
    stop: () => stop('user'),
    attach() {
      clearTimeout(leaveTimer)
      leaveTimer = undefined
    },
    detach() {
      clearTimeout(leaveTimer)
      // Deferred, so a re-mount in the same tick (React's development double-invoke, a parent
      // re-keying) keeps recording. A real leave stops and saves, like Stop.
      leaveTimer = setTimeout(() => {
        leaveTimer = undefined
        if (snap.phase === 'requesting') void stop('leave')
        else if (snap.phase === 'recording' || snap.phase === 'paused') void stop('leave')
      }, 0)
    },
  }
}

// ─── The registry: one live session per meeting, for the whole tab ──────────

const sessions = new Map<string, RecordingSession>()

/** Starts recording `meeting`, replacing any finished session for it. */
export function beginRecording(init: SessionInit, deps: CaptureDeps = browserCaptureDeps()): RecordingSession {
  const session: RecordingSession = createRecordingSession(init, deps, {
    onEnd: () => {
      if (sessions.get(init.meeting.id) === session) sessions.delete(init.meeting.id)
    },
  })
  sessions.set(init.meeting.id, session)
  void session.start()
  return session
}

/** The session recording (or saving) this meeting in THIS tab, if any. */
export function getRecordingSession(meetingId: string): RecordingSession | undefined {
  return sessions.get(meetingId)
}

/** True while this tab is capturing or still saving the meeting: the page keeps the recording panel up. */
export function hasActiveRecordingSession(meetingId: string): boolean {
  return sessions.has(meetingId)
}
