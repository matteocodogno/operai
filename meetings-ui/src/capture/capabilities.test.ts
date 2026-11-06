import { describe, expect, it } from 'vitest'
import { captureOptions, detectCapabilities, readEnvironment } from './capabilities'
import type { CaptureEnvironment } from './capabilities'

/** Real user-agent strings: the browser family is read from these, so they must be the real shapes. */
const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  operaMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
}

const WEBM = 'audio/webm;codecs=opus'
const MP4 = 'audio/mp4'

/** A browser with everything the recorder needs; each case removes what that browser lacks. */
const env = (overrides: Partial<CaptureEnvironment> = {}): CaptureEnvironment => ({
  userAgent: UA.chromeWindows,
  brands: [],
  isSecureContext: true,
  hasMediaRecorder: true,
  hasGetUserMedia: true,
  hasGetDisplayMedia: true,
  hasAudioContext: true,
  isTypeSupported: (mime) => mime === WEBM,
  ...overrides,
})

describe('the capability matrix (AC-2.4)', () => {
  it('Chrome: microphone and tab audio, WebM/Opus', () => {
    const capabilities = detectCapabilities(env())
    expect(capabilities).toMatchObject({
      supported: true,
      browser: 'chromium',
      microphone: true,
      tabAudio: true,
      mimeType: WEBM,
    })
    expect(captureOptions(capabilities, 'online')).toEqual({
      sources: ['microphone', 'microphone+tab'],
      defaultSource: 'microphone+tab',
      warnRemoteVoices: false,
      recommendUpload: false,
    })
  })

  it('Edge: the same as Chrome (it is Chromium, and its UA also says Chrome)', () => {
    const capabilities = detectCapabilities(env({ userAgent: UA.edgeWindows }))
    expect(capabilities.browser).toBe('chromium')
    expect(capabilities.tabAudio).toBe(true)
  })

  it('Opera: Chromium too', () => {
    expect(detectCapabilities(env({ userAgent: UA.operaMac })).browser).toBe('chromium')
  })

  it('Firefox: microphone only, with the remote-voices warning and the upload recommendation', () => {
    const capabilities = detectCapabilities(env({ userAgent: UA.firefoxWindows }))
    expect(capabilities).toMatchObject({ supported: true, browser: 'firefox', microphone: true, tabAudio: false })
    expect(captureOptions(capabilities, 'online')).toEqual({
      sources: ['microphone'],
      defaultSource: 'microphone',
      warnRemoteVoices: true,
      recommendUpload: true,
    })
  })

  it('Firefox has getDisplayMedia but cannot deliver tab audio: the function alone is not the test', () => {
    const capabilities = detectCapabilities(env({ userAgent: UA.firefoxWindows, hasGetDisplayMedia: true }))
    expect(capabilities.tabAudio).toBe(false)
  })

  it('Safari (macOS): microphone only, MP4 when WebM is not recorded', () => {
    const capabilities = detectCapabilities(env({ userAgent: UA.safariMac, isTypeSupported: (mime) => mime === MP4 }))
    expect(capabilities).toMatchObject({ supported: true, browser: 'safari', tabAudio: false, mimeType: MP4 })
    expect(captureOptions(capabilities, 'online')).toMatchObject({
      sources: ['microphone'],
      warnRemoteVoices: true,
      recommendUpload: true,
    })
  })

  it('Safari that records WebM/Opus prefers it (the plan lists WebM first)', () => {
    const capabilities = detectCapabilities(env({ userAgent: UA.safariMac, isTypeSupported: () => true }))
    expect(capabilities.mimeType).toBe(WEBM)
  })

  it.each([
    ['Safari on iPhone', UA.safariIphone],
    ['Chrome on iPhone (WebKit underneath: the CriOS token must not read as Chromium)', UA.chromeIphone],
  ])('%s is Safari-engine: microphone only', (_name, userAgent) => {
    const capabilities = detectCapabilities(
      env({ userAgent, hasGetDisplayMedia: false, isTypeSupported: (mime) => mime === MP4 }),
    )
    expect(capabilities.browser).toBe('safari')
    expect(capabilities.tabAudio).toBe(false)
  })

  it('Chrome on Android has no getDisplayMedia: microphone only even though it is Chromium', () => {
    const capabilities = detectCapabilities(env({ userAgent: UA.chromeAndroid, hasGetDisplayMedia: false }))
    expect(capabilities).toMatchObject({ supported: true, browser: 'chromium', tabAudio: false })
    expect(captureOptions(capabilities, 'online').recommendUpload).toBe(true)
  })

  it('reads the Chromium family from userAgentData brands before the user-agent string', () => {
    const capabilities = detectCapabilities(
      env({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101',
        brands: ['Not A;Brand', 'Chromium', 'Brave'],
      }),
    )
    expect(capabilities.browser).toBe('chromium')
    expect(capabilities.tabAudio).toBe(true)
  })

  it('an unknown browser is "other": microphone only', () => {
    const capabilities = detectCapabilities(env({ userAgent: 'SomethingNew/1.0' }))
    expect(capabilities).toMatchObject({ browser: 'other', tabAudio: false, supported: true })
  })
})

describe('in-person meetings (AC-2.4 asks only for online)', () => {
  it('offer the microphone only, with no tab radio, no warning and no upload nudge, even on Chrome', () => {
    expect(captureOptions(detectCapabilities(env()), 'in_person')).toEqual({
      sources: ['microphone'],
      defaultSource: 'microphone',
      warnRemoteVoices: false,
      recommendUpload: false,
    })
  })

  it('also on Firefox: nothing to warn about when everyone is in the room', () => {
    const options = captureOptions(detectCapabilities(env({ userAgent: UA.firefoxWindows })), 'in_person')
    expect(options.warnRemoteVoices).toBe(false)
    expect(options.recommendUpload).toBe(false)
  })
})

describe('a browser that cannot record at all', () => {
  it('an insecure context cannot ask for the microphone', () => {
    const capabilities = detectCapabilities(env({ isSecureContext: false }))
    expect(capabilities).toMatchObject({
      supported: false,
      unsupportedReason: 'insecure',
      microphone: false,
      tabAudio: false,
    })
  })

  it('no MediaRecorder', () => {
    expect(detectCapabilities(env({ hasMediaRecorder: false }))).toMatchObject({
      supported: false,
      unsupportedReason: 'no_recorder',
    })
  })

  it('no getUserMedia', () => {
    expect(detectCapabilities(env({ hasGetUserMedia: false }))).toMatchObject({
      supported: false,
      unsupportedReason: 'no_microphone',
    })
  })

  it('no AudioContext (the mixer needs it even for the microphone alone)', () => {
    expect(detectCapabilities(env({ hasAudioContext: false }))).toMatchObject({
      supported: false,
      unsupportedReason: 'no_audio_context',
    })
  })

  it('a recorder that supports neither WebM/Opus nor MP4', () => {
    expect(detectCapabilities(env({ isTypeSupported: () => false }))).toMatchObject({
      supported: false,
      unsupportedReason: 'no_format',
      mimeType: null,
    })
  })

  it('offers no source and recommends uploading, for an online and an in-person meeting alike', () => {
    const capabilities = detectCapabilities(env({ hasMediaRecorder: false }))
    for (const format of ['online', 'in_person'] as const) {
      expect(captureOptions(capabilities, format)).toEqual({
        sources: [],
        defaultSource: null,
        warnRemoteVoices: false,
        recommendUpload: true,
      })
    }
  })

  it('checks the context before anything else: a secure-context failure wins over a missing recorder', () => {
    expect(detectCapabilities(env({ isSecureContext: false, hasMediaRecorder: false })).unsupportedReason).toBe(
      'insecure',
    )
  })
})

describe('readEnvironment', () => {
  it('reads the facts from the browser globals it is given', () => {
    const scope = {
      isSecureContext: true,
      navigator: {
        userAgent: UA.firefoxWindows,
        mediaDevices: { getUserMedia: () => Promise.resolve(), getDisplayMedia: () => Promise.resolve() },
      },
      MediaRecorder: Object.assign(function MediaRecorder() {}, { isTypeSupported: (mime: string) => mime === MP4 }),
      AudioContext: function AudioContext() {},
    }
    const read = readEnvironment(scope as never)
    expect(read).toMatchObject({
      userAgent: UA.firefoxWindows,
      isSecureContext: true,
      hasMediaRecorder: true,
      hasGetUserMedia: true,
      hasGetDisplayMedia: true,
      hasAudioContext: true,
    })
    expect(read.isTypeSupported(MP4)).toBe(true)
    expect(read.isTypeSupported(WEBM)).toBe(false)
  })

  it('accepts the prefixed webkitAudioContext of older Safari', () => {
    const read = readEnvironment({
      isSecureContext: true,
      navigator: { userAgent: UA.safariMac },
      webkitAudioContext: function () {},
    } as never)
    expect(read.hasAudioContext).toBe(true)
  })

  it('reads userAgentData brands when the browser offers them', () => {
    const read = readEnvironment({
      isSecureContext: true,
      navigator: { userAgent: UA.chromeWindows, userAgentData: { brands: [{ brand: 'Chromium', version: '130' }] } },
    } as never)
    expect(read.brands).toEqual(['Chromium'])
  })

  it('an empty scope (a non-browser) is a browser that can do nothing, and never throws', () => {
    const read = readEnvironment({} as never)
    expect(detectCapabilities(read)).toMatchObject({ supported: false, unsupportedReason: 'insecure' })
    expect(read.isTypeSupported(WEBM)).toBe(false)
  })

  it('a missing mediaDevices (insecure pages hide it) reads as no getUserMedia, not as a throw', () => {
    const read = readEnvironment({ isSecureContext: true, navigator: { userAgent: UA.chromeWindows } } as never)
    expect(read.hasGetUserMedia).toBe(false)
    expect(read.hasGetDisplayMedia).toBe(false)
  })
})
