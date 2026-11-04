/**
 * Test support for the recording code (specs/021-meetings T63, T64): fake media tracks and streams,
 * a fake `AudioContext`, a fake `MediaRecorder` that emits one chunk per `timeslice` of RECORDED time
 * (so fake timers drive it, and a paused recorder emits nothing), and `installFakeBrowserCapture`,
 * which puts them where `capture/capabilities.ts` and `capture/session.ts` look for the real ones.
 *
 * jsdom has none of these APIs, so a component test that records installs them with
 * `installFakeBrowserCapture()` and removes them with the returned function.
 */
import { vi } from 'vitest'
import type { AudioContextLike } from '../capture/mixer'

export class FakeTrack extends EventTarget {
  readonly kind: 'audio' | 'video'
  readyState: 'live' | 'ended' = 'live'
  constructor(kind: 'audio' | 'video' = 'audio') {
    super()
    this.kind = kind
  }
  stop() {
    this.readyState = 'ended'
  }
  /** The browser ending the track by itself: the device is unplugged, "Stop sharing" is clicked. */
  end() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

export class FakeStream {
  readonly tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}

export const micStream = () => new FakeStream([new FakeTrack('audio')]) as unknown as MediaStream
/** The stream `getDisplayMedia` returns: video always, audio only when the person ticked "Share tab audio". */
export const tabStream = (withAudio = true) =>
  new FakeStream([new FakeTrack('video'), ...(withAudio ? [new FakeTrack('audio')] : [])]) as unknown as MediaStream

export function fakeAudioContext(): AudioContextLike & { destination: FakeStream | null } {
  const context = {
    state: 'running' as AudioContextState,
    destination: null as FakeStream | null,
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => {
      context.destination = new FakeStream([new FakeTrack('audio')])
      return { stream: context.destination }
    }),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      context.state = 'closed'
    }),
  }
  return context as unknown as AudioContextLike & { destination: FakeStream | null }
}

/** Bytes in every emitted chunk: small, never zero. */
export const FAKE_CHUNK_BYTES = 1_000

export class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = vi.fn((mimeType: string) => mimeType === 'audio/webm;codecs=opus')
  static reset() {
    FakeMediaRecorder.instances = []
    FakeMediaRecorder.isTypeSupported.mockClear()
  }

  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  readonly stream: MediaStream
  readonly options: MediaRecorderOptions | undefined
  timeslice: number | undefined
  /** Chunks emitted so far. */
  emitted = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    super()
    this.stream = stream
    this.options = options
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice?: number) {
    this.timeslice = timeslice
    this.state = 'recording'
    this.arm()
  }

  requestData() {
    if (this.state !== 'inactive') this.emit()
  }

  pause() {
    this.state = 'paused'
    this.disarm()
  }

  resume() {
    this.state = 'recording'
    this.arm()
  }

  stop() {
    if (this.state === 'inactive') return
    this.disarm()
    this.emit()
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }

  /** Emits one chunk now, as the real recorder does every `timeslice`. */
  emit(bytes = FAKE_CHUNK_BYTES) {
    this.emitted += 1
    const event = new Event('dataavailable') as Event & { data: Blob }
    event.data = new Blob([new Uint8Array(bytes)])
    this.dispatchEvent(event)
  }

  private arm() {
    this.disarm()
    if (this.timeslice) this.timer = setInterval(() => this.emit(), this.timeslice)
  }

  private disarm() {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}

export type FakeBrowser = {
  getUserMedia: ReturnType<typeof vi.fn>
  getDisplayMedia: ReturnType<typeof vi.fn>
  contexts: Array<ReturnType<typeof fakeAudioContext>>
  /** The microphone streams handed out, newest last. */
  microphones: MediaStream[]
  tabs: MediaStream[]
  /** Removes every stub. */
  restore: () => void
}

/**
 * Chrome on a secure page with a microphone, a tab picker and a recorder for `audio/webm;codecs=opus`.
 * `getUserMedia` can be made to refuse with `mic: new DOMException('…', 'NotAllowedError')`.
 */
export function installFakeBrowserCapture(
  options: { mic?: 'ok' | DOMException; tab?: 'ok' | DOMException | 'no-audio'; chromium?: boolean } = {},
): FakeBrowser {
  FakeMediaRecorder.reset()
  const microphones: MediaStream[] = []
  const tabs: MediaStream[] = []
  const contexts: FakeBrowser['contexts'] = []

  const getUserMedia = vi.fn(async () => {
    if (options.mic instanceof DOMException) throw options.mic
    const stream = micStream()
    microphones.push(stream)
    return stream
  })
  const getDisplayMedia = vi.fn(async () => {
    if (options.tab instanceof DOMException) throw options.tab
    const stream = tabStream(options.tab !== 'no-audio')
    tabs.push(stream)
    return stream
  })

  class FakeAudioContext {
    constructor() {
      const context = fakeAudioContext()
      contexts.push(context)
      return context as unknown as FakeAudioContext
    }
  }

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('isSecureContext', true)
  const mediaDevices = { getUserMedia, getDisplayMedia }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
  // Chromium names itself in `userAgentData`; Firefox and Safari do not, so they get microphone only.
  if (options.chromium !== false) {
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { brands: [{ brand: 'Chromium' }] } })
  }

  return {
    getUserMedia,
    getDisplayMedia,
    contexts,
    microphones,
    tabs,
    restore: () => {
      vi.unstubAllGlobals()
      Reflect.deleteProperty(navigator, 'mediaDevices')
      Reflect.deleteProperty(navigator, 'userAgentData')
      FakeMediaRecorder.reset()
    },
  }
}
