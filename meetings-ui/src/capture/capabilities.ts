/**
 * capabilities — what THIS browser can capture, as a pure function of facts about it
 * (specs/021-meetings plan § Browser capture, AC-2.4). The facts are read once from the
 * browser globals (`readEnvironment`), so the matrix is tested with stubbed environments for
 * Chrome, Edge, Firefox and Safari and the UI never sniffs a user agent itself.
 *
 *   Chromium (Chrome, Edge, Opera) with `getDisplayMedia` → microphone, and the audio of a shared tab
 *   Firefox, Safari (every iOS browser), Chromium without `getDisplayMedia` (Android) → microphone only
 *
 * Firefox and Safari expose `getDisplayMedia` but cannot deliver the shared tab's audio, so the
 * function's presence alone is not the test; the browser family is.
 *
 * Tab audio is only ever offered for an `online` meeting. Where it is not available the screen says
 * so, warns that remote voices are captured only if played through speakers, and recommends
 * uploading a recording instead; the microphone-only option stays selectable (AC-2.4).
 */
import type { MeetingFormat } from '../lib/types'

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other'

/** The facts the matrix is computed from. Plain data, so a test builds any browser by hand. */
export type CaptureEnvironment = {
  userAgent: string
  /** `navigator.userAgentData.brands`, brand names only (Chromium browsers; empty elsewhere). */
  brands: readonly string[]
  isSecureContext: boolean
  hasMediaRecorder: boolean
  hasGetUserMedia: boolean
  hasGetDisplayMedia: boolean
  hasAudioContext: boolean
  isTypeSupported: (mimeType: string) => boolean
}

/** Why a browser cannot record at all, most fundamental first; the UI recommends uploading. */
export type UnsupportedReason = 'insecure' | 'no_recorder' | 'no_microphone' | 'no_audio_context' | 'no_format'

export type CaptureCapabilities = {
  supported: boolean
  unsupportedReason: UnsupportedReason | null
  browser: BrowserFamily
  /** `audio/webm;codecs=opus` where recorded, else `audio/mp4` (Safari), else null. */
  mimeType: string | null
  microphone: boolean
  /** The audio of a shared browser tab can be mixed into the recording. */
  tabAudio: boolean
}

/** Formats the recorder tries, in the plan's order. */
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4'] as const

function browserFamily(userAgent: string, brands: readonly string[]): BrowserFamily {
  if (brands.includes('Chromium')) return 'chromium'
  // Every browser on iOS is WebKit underneath, whatever its token says (CriOS, FxiOS, EdgiOS).
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'safari'
  if (/Firefox\//.test(userAgent)) return 'firefox'
  // Edge, Opera and Chrome all carry "Chrome/" too, but name them anyway.
  if (/Edg\/|EdgA\/|OPR\/|Chrome\/|Chromium\//.test(userAgent)) return 'chromium'
  if (/Safari\//.test(userAgent)) return 'safari'
  return 'other'
}

export function detectCapabilities(env: CaptureEnvironment): CaptureCapabilities {
  const browser = browserFamily(env.userAgent, env.brands)
  const mimeType = PREFERRED_MIME_TYPES.find((candidate) => env.isTypeSupported(candidate)) ?? null

  const unsupportedReason: UnsupportedReason | null = !env.isSecureContext
    ? 'insecure'
    : !env.hasMediaRecorder
      ? 'no_recorder'
      : !env.hasGetUserMedia
        ? 'no_microphone'
        : !env.hasAudioContext
          ? 'no_audio_context'
          : mimeType === null
            ? 'no_format'
            : null

  const supported = unsupportedReason === null
  return {
    supported,
    unsupportedReason,
    browser,
    mimeType,
    microphone: supported,
    tabAudio: supported && browser === 'chromium' && env.hasGetDisplayMedia,
  }
}

export type CaptureSource = 'microphone' | 'microphone+tab'

export type CaptureOptions = {
  /** What the "What to record" choice lists, in order; empty when the browser cannot record. */
  sources: CaptureSource[]
  /** The pre-selected source, or null when there is none. */
  defaultSource: CaptureSource | null
  /** Microphone-only on an online meeting: "remote voices are captured only if played through speakers" (AC-2.4). */
  warnRemoteVoices: boolean
  /** The other participants' audio cannot be captured here, or nothing can: recommend uploading a recording. */
  recommendUpload: boolean
}

export function captureOptions(capabilities: CaptureCapabilities, format: MeetingFormat): CaptureOptions {
  if (!capabilities.supported) {
    return { sources: [], defaultSource: null, warnRemoteVoices: false, recommendUpload: true }
  }
  if (format === 'in_person') {
    return { sources: ['microphone'], defaultSource: 'microphone', warnRemoteVoices: false, recommendUpload: false }
  }
  if (capabilities.tabAudio) {
    return {
      sources: ['microphone', 'microphone+tab'],
      defaultSource: 'microphone+tab',
      warnRemoteVoices: false,
      recommendUpload: false,
    }
  }
  return { sources: ['microphone'], defaultSource: 'microphone', warnRemoteVoices: true, recommendUpload: true }
}

/** The browser globals `readEnvironment` looks at; every member optional so a non-browser reads as "can do nothing". */
type BrowserScope = {
  isSecureContext?: boolean
  navigator?: {
    userAgent?: string
    userAgentData?: { brands?: readonly { brand: string }[] }
    mediaDevices?: { getUserMedia?: unknown; getDisplayMedia?: unknown }
  }
  MediaRecorder?: unknown
  AudioContext?: unknown
  /** Older Safari. */
  webkitAudioContext?: unknown
}

/** Reads the facts from the real browser (or from a stub scope in tests). Never throws. */
export function readEnvironment(scope: BrowserScope = globalThis as unknown as BrowserScope): CaptureEnvironment {
  const navigator = scope.navigator
  const recorder = scope.MediaRecorder as { isTypeSupported?: (mimeType: string) => boolean } | undefined
  return {
    userAgent: navigator?.userAgent ?? '',
    brands: navigator?.userAgentData?.brands?.map((entry) => entry.brand) ?? [],
    isSecureContext: scope.isSecureContext === true,
    hasMediaRecorder: typeof scope.MediaRecorder === 'function',
    hasGetUserMedia: typeof navigator?.mediaDevices?.getUserMedia === 'function',
    hasGetDisplayMedia: typeof navigator?.mediaDevices?.getDisplayMedia === 'function',
    hasAudioContext: typeof scope.AudioContext === 'function' || typeof scope.webkitAudioContext === 'function',
    isTypeSupported: (mimeType) => {
      try {
        return typeof recorder?.isTypeSupported === 'function' && recorder.isTypeSupported(mimeType)
      } catch {
        return false
      }
    },
  }
}
