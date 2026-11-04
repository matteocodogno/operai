/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({
  unregister: vi.fn(),
  registerNavigationBlocker: vi.fn(),
}))

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  registerNavigationBlocker: shell.registerNavigationBlocker,
}))

import { apiFetch } from 'shell/session'
import { getRecordingSession } from '../../capture/session'
import type { Meeting } from '../../lib/types'
import { en } from '../../strings'
import { ADA, fakeApi, meeting, problem } from '../../test-support/fakeApi'
import type { FakeHandler } from '../../test-support/fakeApi'
import { installFakeBrowserCapture } from '../../test-support/fakeCapture'
import type { FakeBrowser } from '../../test-support/fakeCapture'
import RecordingPanel from './RecordingPanel'

const t = en.capture
const CONSENT: Meeting['consent'] = { by: ADA, at: '2026-11-03T09:29:00.000Z', noticeVersion: '2026-11-01' }
const policy = (name: string) => ({
  url: `https://bucket.test/${name}`,
  fields: { key: name },
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})

let browser: FakeBrowser
let requests: string[]
let bucket: ReturnType<typeof vi.fn<typeof fetch>>

const routes = (overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => {
  const note =
    (handler: FakeHandler): FakeHandler =>
    (url, init, params) => {
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return handler(url, init, params)
    }
  return {
    'POST /meetings/m1/recording/start': note(() => ({
      status: 201,
      body: { sessionId: 's1', chunkSeconds: 10, maxChunkBytes: 8_388_608, next: policy('seq-0') },
    })),
    'POST /meetings/m1/recording/chunks/:seq/confirm': note((_u, _i, params) => ({
      status: 200,
      body: { storedChunks: Number(params.seq) + 1, durationMs: 10_000, next: policy(`seq-${Number(params.seq) + 1}`) },
    })),
    'POST /meetings/m1/recording/chunks/:seq/upload-url': note((_u, _i, params) => ({
      status: 200,
      body: policy(`minted-${params.seq}`),
    })),
    'POST /meetings/m1/recording/heartbeat': note(() => ({ status: 204 })),
    'POST /meetings/m1/recording/stop': note(() => ({
      status: 202,
      body: meeting({ status: 'processing', consent: CONSENT }),
    })),
    'GET /meetings/m1': note(() => ({ status: 200, body: meeting({ status: 'recording', consent: CONSENT }) })),
    'PATCH /meetings/m1': note((_u, init) => ({
      status: 200,
      body: meeting({ source: JSON.parse(String(init?.body)).source }),
    })),
    ...overrides,
  }
}

const draft = (overrides: Partial<Meeting> = {}) => meeting({ consent: CONSENT, ...overrides })

type Setup = { browser?: Parameters<typeof installFakeBrowserCapture>[0]; routes?: Record<string, FakeHandler> }

const setup = (options: Setup = {}) => {
  browser = installFakeBrowserCapture(options.browser)
  requests = []
  vi.mocked(apiFetch).mockImplementation(fakeApi(routes(options.routes)))
  bucket = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', bucket)
}

const user = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })

/** Lets the pending promises and timers run, inside act so React renders what they produced. */
const settle = async (ms = 50) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const renderPanel = (m: Meeting = draft(), onChanged = vi.fn()) => {
  const view = render(<RecordingPanel meeting={m} onChanged={onChanged} />)
  return { ...view, onChanged }
}

const press = async (name: string | RegExp, key: '{Enter}' | ' ' = '{Enter}') => {
  const button = screen.getByRole('button', { name })
  act(() => button.focus())
  await user().keyboard(key)
  await settle()
}

const liveText = () =>
  [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent ?? '').join(' | ')

/** Every distinct text the polite live region held, in order: a later announcement replaces the earlier one. */
const listenToAnnouncements = () => {
  const heard: string[] = []
  const observer = new MutationObserver(() => {
    const text = document.querySelector('[data-testid="meetings-recording-announcements"]')?.textContent
    if (text && heard.at(-1) !== text) heard.push(text)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return heard
}

const startRecording = async () => {
  await press(t.start)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  // Testing Library only advances fake timers when it sees Jest's; this tells it vitest's are in use.
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
  shell.unregister.mockReset()
  shell.registerNavigationBlocker.mockReset()
  shell.registerNavigationBlocker.mockImplementation(() => shell.unregister)
})

afterEach(async () => {
  cleanup()
  // A panel that unmounts mid-recording stops its session on the next tick: let it, before the next test.
  await vi.advanceTimersByTimeAsync(20_000).catch(() => undefined)
  vi.useRealTimers()
  browser?.restore()
})

describe('what is offered before recording (AC-2.1, AC-2.4)', () => {
  it('offers nothing, and asks the browser for nothing, without the consent attestation', () => {
    setup()
    const { container } = renderPanel(meeting({ consent: null }))
    expect(container.textContent).toBe('')
    expect(browser.getUserMedia).not.toHaveBeenCalled()
  })

  it('offers nothing to someone who may not capture', () => {
    setup()
    const { container } = renderPanel(draft({ can: { ...meeting().can, capture: false } }))
    expect(container.textContent).toBe('')
  })

  it('lists what Chrome can do for an online meeting: microphone only, or microphone plus a shared tab', async () => {
    setup()
    renderPanel(draft({ format: 'online' }))
    const group = screen.getByRole('radiogroup', { name: t.options.sourceLabel })
    const options = within(group).getAllByRole('radio')
    expect(options.map((radio) => radio.parentElement?.textContent)).toEqual([t.options.micOnly, t.options.micAndTab])
    // The tab is the default where it is possible, with the instruction for the picker.
    expect(within(group).getByRole('radio', { name: t.options.micAndTab })).toHaveProperty('checked', true)
    expect(screen.getByText(t.options.tabHint)).not.toBeNull()

    await user().click(within(group).getByRole('radio', { name: t.options.micOnly }))
    expect(screen.queryByText(t.options.tabHint)).toBeNull()
  })

  it('on a browser that cannot take tab audio says so, recommends uploading, and keeps microphone-only selectable', () => {
    setup({ browser: { chromium: false } })
    renderPanel(draft({ format: 'online' }))
    expect(screen.getByText(t.options.unsupportedTab, { exact: false })).not.toBeNull()
    expect(screen.getByText(t.options.micOnlyWarning, { exact: false })).not.toBeNull()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(1)
    expect(radios[0]).toHaveProperty('checked', true)
    expect(screen.getByRole('button', { name: t.start })).not.toBeNull()
    expect(screen.getByRole('button', { name: t.alternatives.upload })).not.toBeNull()
  })

  it('an in-person meeting records the microphone with no choice and no warning', () => {
    setup()
    renderPanel(draft({ format: 'in_person' }))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByText(t.options.micOnlyWarning, { exact: false })).toBeNull()
    expect(screen.getByRole('button', { name: t.start })).not.toBeNull()
  })

  it('a browser that cannot record offers no Start, only the alternatives', () => {
    // No stubs: jsdom has no MediaRecorder.
    requests = []
    vi.mocked(apiFetch).mockImplementation(fakeApi(routes()))
    renderPanel(draft())
    expect(screen.queryByRole('button', { name: t.start })).toBeNull()
    expect(screen.getByText(t.unsupported.title)).not.toBeNull()
    expect(screen.getByRole('button', { name: t.alternatives.upload })).not.toBeNull()
    expect(screen.getByRole('button', { name: t.alternatives.text })).not.toBeNull()
  })

  it('without the right to change the source, the alternatives are not offered as buttons', () => {
    setup()
    renderPanel(draft({ can: { ...meeting().can, capture: true, changeSource: false } }))
    expect(screen.queryByRole('button', { name: t.alternatives.upload })).toBeNull()
  })
})

describe('recording by keyboard (AC-2.2, AC-2.6, AC-2.7, AC-13.3)', () => {
  it('starts, pauses, resumes and stops with Enter and Space, announces each change, and moves focus as designed', async () => {
    setup()
    const { onChanged } = renderPanel()

    // Start. The browser is asked for the microphone, then the indicator and the timer appear.
    await startRecording()
    expect(browser.getUserMedia).toHaveBeenCalledTimes(1)
    const indicator = screen.getByTestId('meetings-recording-indicator')
    expect(indicator.textContent).toContain(t.indicator.recording)
    const timer = screen.getByRole('timer', { name: t.elapsed })
    expect(timer.textContent).toBe('00:00:00')
    expect(liveText()).toContain(t.announcements.started)
    // Focus moved from the Start button (now gone) to Pause.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t.pause }))
    // The meeting's status is refetched so the page shows "Recording".
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'recording' }))

    await settle(12_000)
    // One saved slice of 10 s plus the 2 s recorded since.
    expect(screen.getByRole('timer').textContent).toBe('00:00:12')

    // Pause: same element, new label; the indicator changes icon AND word.
    await press(t.pause, ' ')
    expect(indicator.textContent).toContain(t.indicator.paused)
    expect(indicator.textContent).not.toContain(t.indicator.recording)
    expect(liveText()).toContain(t.announcements.paused)
    const toggle = screen.getByRole('button', { name: t.resume })
    expect(document.activeElement).toBe(toggle)
    // One primary at a time: Resume is the primary now, Stop is not.
    expect(toggle.className).toContain('btn-primary')
    expect(screen.getByRole('button', { name: t.stop }).className).not.toContain('btn-primary')

    // The paused minutes do not tick the timer.
    await settle(60_000)
    expect(screen.getByRole('timer').textContent).toBe('00:00:12')

    await press(t.resume)
    expect(liveText()).toContain(t.announcements.resumed)
    expect(screen.getByRole('button', { name: t.pause })).toBe(toggle)

    // Stop: controls disabled, the saving status takes focus, and when the server says processing the page is told.
    await press(t.stop, ' ')
    expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'processing' }))
    expect(liveText()).toContain(t.announcements.saved)
    expect(requests.filter((r) => r.endsWith('/recording/stop'))).toHaveLength(1)
  })

  it('every control is a native button in DOM order Pause then Stop, and there is no global shortcut', async () => {
    setup()
    renderPanel()
    await startRecording()
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.tagName)).toEqual(['BUTTON', 'BUTTON'])
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([t.pause, t.stop])
  })

  it('shows the saving progress and puts focus on it while the audio is still being saved', async () => {
    setup()
    renderPanel()
    await startRecording()
    await settle(25_000)
    bucket.mockRejectedValue(new TypeError('offline'))
    await settle(10_000)

    await press(t.stop)
    const saving = screen.getByTestId('meetings-recording-saving')
    expect(document.activeElement).toBe(saving)
    const bar = within(saving).getByRole('progressbar', { name: t.save.progressLabel })
    expect(bar.getAttribute('aria-valuetext')).toMatch(/^Saving audio: \d+ of \d+$/)
    // Both controls are disabled meanwhile.
    expect(screen.getByRole('button', { name: t.pause }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: t.stop }).hasAttribute('disabled')).toBe(true)

    bucket.mockResolvedValue(new Response(null, { status: 204 }))
    window.dispatchEvent(new Event('online'))
    await settle(10_000)
  })
})

describe('when recording cannot start (AC-2.3)', () => {
  it.each([
    ['NotAllowedError', t.denied.title],
    ['NotFoundError', t.noDevice.title],
    ['NotReadableError', t.micUnavailable.title],
  ])('%s says what to change, keeps the meeting a draft and offers upload and paste', async (name, title) => {
    setup({ browser: { mic: new DOMException('refused', name) } })
    renderPanel()
    await startRecording()

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(title)
    expect(requests.filter((r) => r.includes('/recording/start'))).toEqual([])
    expect(screen.getByRole('button', { name: t.start })).not.toBeNull() // can try again
    expect(screen.getByRole('button', { name: t.alternatives.upload })).not.toBeNull()
    expect(screen.getByRole('button', { name: t.alternatives.text })).not.toBeNull()
    expect(screen.getByText(t.alternatives.textNote)).not.toBeNull()
  })

  it('the offered alternative switches the source and tells the page', async () => {
    setup({ browser: { mic: new DOMException('refused', 'NotAllowedError') } })
    const { onChanged } = renderPanel()
    await startRecording()
    await press(t.alternatives.upload)
    expect(requests).toContain('PATCH /meetings/m1')
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ source: 'uploaded' }))
  })

  it('a start another device already holds is refused with the server message, and nothing keeps recording', async () => {
    setup({
      routes: {
        'POST /meetings/m1/recording/start': () => ({ status: 409, body: problem(409, 'recording_elsewhere') }),
      },
    })
    renderPanel()
    await startRecording()
    expect(screen.getByRole('alert').textContent).toContain(en.common.errors.recording_elsewhere)
    expect(screen.queryByRole('timer')).toBeNull()
    expect(browser.microphones[0]!.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
  })
})

describe('while recording: banners (AC-2.5, AC-2.9, AC-2.11)', () => {
  it('tells the creator when the shared tab ends, and the microphone keeps recording', async () => {
    setup()
    renderPanel(draft({ format: 'online' }))
    await startRecording()
    expect(screen.queryByText(t.tabEnded)).toBeNull()
    act(() => (browser.tabs[0]!.getVideoTracks()[0] as unknown as { end: () => void }).end())
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(t.tabEnded)
    expect(screen.getByTestId('meetings-recording-indicator').textContent).toContain(t.indicator.recording)
  })

  it('offline: a banner and a status line say the audio is not saved and survives only while the tab is open; back online it says so', async () => {
    setup()
    renderPanel()
    await startRecording()
    bucket.mockRejectedValue(new TypeError('Failed to fetch'))
    await settle(10_000)

    expect(screen.getByRole('alert').textContent).toContain(t.save.notSaved)
    expect(screen.getByTestId('meetings-recording-save-status').textContent).toBe(t.save.notSavedLine('10'))
    // Recording goes on: the timer still counts and Pause/Stop are available.
    expect(screen.getByRole('button', { name: t.pause }).hasAttribute('disabled')).toBe(false)

    bucket.mockResolvedValue(new Response(null, { status: 204 }))
    window.dispatchEvent(new Event('online'))
    await settle(1_000)
    expect(screen.queryByText(t.save.notSaved)).toBeNull()
    expect(screen.getByTestId('meetings-recording-save-status').textContent).toBe(t.save.allSaved)
    expect(liveText()).toContain(t.restored)
  })

  it('warns 10 minutes before the 3 h limit, then announces the automatic stop', async () => {
    setup()
    renderPanel()
    const heard = listenToAnnouncements()
    await startRecording()
    await settle(10_200_000 + 5_000)
    expect(screen.getByRole('alert').textContent).toContain(t.limitWarning)

    await settle(600_000)
    expect(heard).toContain(t.autoStopped)
    expect(heard.at(-1)).toBe(t.announcements.saved)
    expect(requests.filter((r) => r.endsWith('/recording/stop'))).toHaveLength(1)
  }, 60_000)

  it('a microphone that stops pauses the recording and says how to carry on', async () => {
    setup()
    renderPanel()
    await startRecording()
    act(() => (browser.microphones[0]!.getTracks()[0] as unknown as { end: () => void }).end())
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(t.micLost.title)
    expect(screen.getByTestId('meetings-recording-indicator').textContent).toContain(t.indicator.paused)

    await press(t.resume)
    expect(browser.getUserMedia).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(t.micLost.title)).toBeNull()
    expect(screen.getByTestId('meetings-recording-indicator').textContent).toContain(t.indicator.recording)
  })

  it('when the meeting is erased mid-recording, the recorder stops and the panel says it is gone', async () => {
    setup({
      routes: { 'POST /meetings/m1/recording/heartbeat': () => ({ status: 404, body: problem(404, 'not_found') }) },
    })
    renderPanel()
    await startRecording()
    await press(t.pause) // the pause sends a heartbeat at once
    expect(screen.getByRole('heading', { name: t.gone.title })).not.toBeNull()
    expect(screen.queryByRole('timer')).toBeNull()
  })

  it('any other end of the session says the unsaved audio was lost and offers a refresh', async () => {
    setup({
      routes: {
        'POST /meetings/m1/recording/heartbeat': () => ({ status: 409, body: problem(409, 'session_inactive') }),
      },
    })
    const { onChanged } = renderPanel()
    await startRecording()
    onChanged.mockClear()
    await press(t.pause)
    expect(screen.getByRole('alert').textContent).toContain(t.failed.title)
    await press(t.failed.refresh)
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
  })
})

describe('leaving the page (AC-2.10)', () => {
  it('registers the browser prompt and the shell blocker while recording, and releases both after saving', async () => {
    setup()
    renderPanel()
    // Nothing is at stake before recording.
    expect(shell.registerNavigationBlocker).not.toHaveBeenCalled()
    const idle = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(idle)
    expect(idle.defaultPrevented).toBe(false)

    await startRecording()
    expect(shell.registerNavigationBlocker).toHaveBeenCalledTimes(1)
    const [shouldBlock, message] = shell.registerNavigationBlocker.mock.calls[0]!
    expect(message).toBe(t.leaveMessage)
    expect(shouldBlock()).toBe(true)
    const unloading = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unloading)
    expect(unloading.defaultPrevented).toBe(true)

    await press(t.stop)
    await settle(1_000)
    expect(shouldBlock()).toBe(false)
    expect(shell.unregister).toHaveBeenCalled()
    const afterwards = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterwards)
    expect(afterwards.defaultPrevented).toBe(false)
  })

  it('keeps the browser prompt while audio is unsaved even after Stop, until it is saved', async () => {
    setup()
    renderPanel()
    await startRecording()
    bucket.mockRejectedValue(new TypeError('offline'))
    await settle(10_000)
    await press(t.stop)
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    bucket.mockResolvedValue(new Response(null, { status: 204 }))
    window.dispatchEvent(new Event('online'))
    await settle(10_000)
  })

  it('a shell that predates the blocker still gets the browser prompt', async () => {
    setup()
    shell.registerNavigationBlocker.mockImplementation(() => {
      throw new Error('registerNavigationBlocker is not a function')
    })
    renderPanel()
    await startRecording()
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('unmounting the panel while recording (a confirmed leave) stops and saves, like Stop', async () => {
    setup()
    const { unmount } = renderPanel()
    await startRecording()
    await settle(15_000)
    unmount()
    await settle(1_000)
    expect(requests.filter((r) => r.endsWith('/recording/stop'))).toHaveLength(1)
    expect(shell.unregister).toHaveBeenCalled()
    expect(getRecordingSession('m1')).toBeUndefined()
  })
})

describe('a recording on another tab or device', () => {
  it('says so, with Refresh, and offers no Start', async () => {
    setup()
    const { onChanged } = renderPanel(draft({ status: 'recording' }))
    expect(screen.getByText(t.elsewhere.body)).not.toBeNull()
    expect(screen.queryByRole('button', { name: t.start })).toBeNull()
    await press(t.elsewhere.refresh)
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'recording' }))
  })
})

describe('accessibility (AC-13.3)', () => {
  const AXE = { rules: { 'color-contrast': { enabled: false } } }
  const violations = async (root: Element) =>
    (await axe.run(root, AXE)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)

  // axe schedules its work with timers: run it with the real ones.
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('the capture options have no axe violation', async () => {
    setup()
    const { container } = renderPanel(draft({ format: 'online' }))
    expect(await violations(container)).toEqual([])
  })

  it('the options with a refusal banner and the alternatives have none', async () => {
    setup({ browser: { mic: new DOMException('refused', 'NotAllowedError') } })
    const { container } = renderPanel()
    await userEvent.setup().click(screen.getByRole('button', { name: t.start }))
    await screen.findByText(t.denied.title)
    expect(await violations(container)).toEqual([])
  })

  it('the running panel, paused with banners, has none', async () => {
    setup()
    const { container } = renderPanel(draft({ format: 'online' }))
    await userEvent.setup().click(screen.getByRole('button', { name: t.start }))
    await screen.findByRole('timer')
    await userEvent.setup().click(screen.getByRole('button', { name: t.pause }))
    act(() => (browser.tabs[0]!.getVideoTracks()[0] as unknown as { end: () => void }).end())
    await screen.findByText(t.tabEnded)
    expect(await violations(container)).toEqual([])
    // Leave nothing running for the next test.
    await userEvent.setup().click(screen.getByRole('button', { name: t.stop }))
    await screen.findByText(t.announcements.saved, {}, { timeout: 3000 })
  })
})
