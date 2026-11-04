/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import { ADA, CAN_CREATOR_DRAFT, fakeApi, meeting, problem } from '../../test-support/fakeApi'
import type { FakeHandler } from '../../test-support/fakeApi'
import UploadCard from './UploadCard'

const t = en.upload
const MIB = 1024 * 1024
const CONSENT: Meeting['consent'] = { by: ADA, at: '2026-11-03T09:29:00.000Z', noticeVersion: '2026-11-01' }
const POLICY = {
  url: 'https://bucket.test/',
  fields: { key: 'meetings/m1/upload/abc', 'Content-Type': 'audio/mp4' },
  expiresAt: '2026-11-05T12:30:00.000Z',
}

const draft = (overrides: Partial<Meeting> = {}) => meeting({ source: 'uploaded', consent: CONSENT, ...overrides })

// ─── A fake XMLHttpRequest the test drives by hand ──────────────────────────

class FakeXHR extends EventTarget {
  static instances: FakeXHR[] = []
  upload = new EventTarget()
  method = ''
  url = ''
  body: FormData | null = null
  status = 0
  aborted = false
  constructor() {
    super()
    FakeXHR.instances.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  send(body: FormData) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.dispatchEvent(new Event('abort'))
  }
  progress(loaded: number, total: number) {
    const event = Object.assign(new Event('progress'), { lengthComputable: true, loaded, total })
    this.upload.dispatchEvent(event)
  }
  respond(status: number) {
    this.status = status
    this.dispatchEvent(new Event('load'))
  }
  fail() {
    this.dispatchEvent(new Event('error'))
  }
}

const lastXhr = () => FakeXHR.instances.at(-1)!

// ─── A media element that reports the duration the test chooses ─────────────

let mediaDuration: number | 'unreadable' | 'never'
/** Durations by object URL (`blob:<file name>`), for a test that needs two files to differ. */
let durations: Record<string, number>
/** Files whose name contains "slow" report their metadata only when the test lets them. */
let held: Array<() => void>

const stubMedia = () => {
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    get: () => '',
    set(this: HTMLMediaElement, value: string) {
      const duration = (durations[value] ?? mediaDuration) as typeof mediaDuration
      Object.defineProperty(this, 'duration', { configurable: true, value: typeof duration === 'number' ? duration : Number.NaN })
      const fire = () => {
        if (duration === 'never') return
        this.dispatchEvent(new Event(duration === 'unreadable' ? 'error' : 'loadedmetadata'))
      }
      if (value.includes('slow')) held.push(fire)
      else queueMicrotask(fire)
    },
  })
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`)
  URL.revokeObjectURL = vi.fn()
}

const audioFile = (name = 'standup.m4a', type = 'audio/mp4', bytes = 3 * MIB) => {
  const file = new File([new Uint8Array(16)], name, { type })
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

// ─── The API ────────────────────────────────────────────────────────────────

let requests: Array<{ line: string; body: unknown }>

const install = (routes: Record<string, FakeHandler> = {}) => {
  requests = []
  const note =
    (handler: FakeHandler): FakeHandler =>
    (url, init, params) => {
      requests.push({
        line: `${init?.method ?? 'GET'} ${url.pathname}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return handler(url, init, params)
    }
  vi.mocked(apiFetch).mockImplementation(
    fakeApi({
      'POST /meetings/m1/upload': note(() => ({ status: 200, body: POLICY })),
      'POST /meetings/m1/upload/confirm': note(() => ({ status: 202, body: meeting({ status: 'processing' }) })),
      ...Object.fromEntries(Object.entries(routes).map(([key, handler]) => [key, note(handler)])),
    }),
  )
}

const renderCard = (m: Meeting = draft()) => {
  const onChanged = vi.fn()
  return { onChanged, ...render(<UploadCard meeting={m} onChanged={onChanged} />) }
}

const input = () => screen.getByTestId('meetings-upload-input') as HTMLInputElement

/** Chooses a file the way a person does, past the dialog's own `accept` filter (the app checks the file). */
const choose = async (file: File) => {
  await userEvent.setup({ applyAccept: false }).upload(input(), file)
}

const submit = () => screen.getByRole('button', { name: t.submit })

beforeEach(() => {
  FakeXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  mediaDuration = 600
  durations = {}
  held = []
  stubMedia()
  install()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('what is shown (AC-3.1)', () => {
  it('offers nothing without the consent attestation, or to someone who may not capture', () => {
    const { container, rerender, onChanged } = renderCard(meeting({ source: 'uploaded', consent: null }))
    expect(container.textContent).toBe('')
    rerender(<UploadCard meeting={draft({ can: { ...CAN_CREATOR_DRAFT, capture: false } })} onChanged={onChanged} />)
    expect(container.textContent).toBe('')
  })

  it('states the limits and that only the audio is used, with a picker that shows the size in MiB', async () => {
    renderCard()
    expect(screen.getByRole('heading', { name: t.title })).not.toBeNull()
    expect(screen.getByText(t.hint)).not.toBeNull()
    expect(screen.getByText(t.empty)).not.toBeNull()
    await choose(audioFile('standup.m4a', 'audio/mp4', 3 * MIB))
    expect(screen.getByText('standup.m4a')).not.toBeNull()
    expect(screen.getByText(t.size.mib('3'))).not.toBeNull()
  })
})

describe('the client pre-check refuses before anything is uploaded (AC-3.2)', () => {
  it('a file over 500 MiB', async () => {
    renderCard()
    await choose(audioFile('long.mp4', 'video/mp4', 500 * MIB + 1))
    await screen.findByText(t.problems.too_large)
    expect(submit().hasAttribute('disabled')).toBe(true)
    expect(requests).toEqual([])
    expect(FakeXHR.instances).toHaveLength(0)
  })

  it('exactly 500 MiB is fine', async () => {
    renderCard()
    await choose(audioFile('edge.mp4', 'video/mp4', 500 * MIB))
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    expect(screen.queryByText(t.problems.too_large)).toBeNull()
  })

  it('a type that is not audio or video', async () => {
    renderCard()
    await choose(audioFile('notes.pdf', 'application/pdf', MIB))
    await screen.findByText(t.problems.unsupported_type)
    expect(requests).toEqual([])
  })

  it('a file with no type, by its extension: a .m4a is fine, a .txt is not', async () => {
    renderCard()
    await choose(audioFile('memo.m4a', '', MIB))
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await choose(audioFile('notes.txt', '', MIB))
    await screen.findByText(t.problems.unsupported_type)
  })

  it('an empty file', async () => {
    renderCard()
    await choose(audioFile('silence.m4a', 'audio/mp4', 0))
    await screen.findByText(t.problems.empty)
  })

  it('a recording longer than 3 hours, read from the file’s metadata', async () => {
    mediaDuration = 3 * 3600 + 1
    renderCard()
    await choose(audioFile())
    await screen.findByText(t.problems.too_long)
    expect(submit().hasAttribute('disabled')).toBe(true)
    expect(requests).toEqual([])
  })

  it('exactly 3 hours is fine', async () => {
    mediaDuration = 3 * 3600
    renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
  })

  it.each(['unreadable', 'never'] as const)(
    'a duration the browser cannot read (%s) is not a verdict: the server checks the length',
    async (state) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mediaDuration = state
      renderCard()
      fireEvent.change(input(), { target: { files: [audioFile()] } })
      expect(screen.getByText(t.checking)).not.toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(screen.queryByText(t.checking)).toBeNull()
      expect(submit().hasAttribute('disabled')).toBe(false)
    },
  )

  it('a slow check of an earlier file cannot overrule the file chosen after it', async () => {
    durations['blob:slow.mp4'] = 4 * 3600
    renderCard()
    await choose(audioFile('slow.mp4', 'video/mp4'))
    await choose(audioFile('quick.m4a', 'audio/mp4'))
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))

    await act(async () => {
      for (const release of held) release()
    })
    expect(screen.queryByText(t.problems.too_long)).toBeNull()
    expect(screen.getByText('quick.m4a')).not.toBeNull()
    expect(submit().hasAttribute('disabled')).toBe(false)
  })

  it('choosing another file clears the previous complaint', async () => {
    renderCard()
    await choose(audioFile('notes.pdf', 'application/pdf', MIB))
    await screen.findByText(t.problems.unsupported_type)
    await choose(audioFile())
    await waitFor(() => expect(screen.queryByText(t.problems.unsupported_type)).toBeNull())
  })
})

describe('uploading (AC-3.1)', () => {
  it('asks for a policy with the type and size, posts the file to the bucket with progress, confirms, and hands the page the processing meeting', async () => {
    const { onChanged } = renderCard()
    await choose(audioFile('standup.m4a', 'audio/mp4', 3 * MIB))
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())

    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(requests[0]).toEqual({
      line: 'POST /meetings/m1/upload',
      body: { contentType: 'audio/mp4', sizeBytes: 3 * MIB },
    })
    const xhr = lastXhr()
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe(POLICY.url)
    // The policy's fields first and the file last, as a presigned POST requires.
    expect([...xhr.body!.keys()]).toEqual(['key', 'Content-Type', 'file'])

    // While it runs: the picker is locked, progress is shown with a name and a percentage, and Cancel is there.
    act(() => xhr.progress(40, 100))
    const bar = screen.getByRole('progressbar', { name: t.progressLabel })
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(bar.getAttribute('aria-valuetext')).toBe(t.progress('40%'))
    expect(screen.getByRole('button', { name: t.cancel })).not.toBeNull()
    expect(screen.queryByRole('button', { name: t.submit })).toBeNull()
    expect((screen.getByTestId('meetings-upload-choose') as HTMLButtonElement).disabled).toBe(true)

    act(() => xhr.progress(100, 100))
    act(() => xhr.respond(204))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' })))
    expect(requests.map((r) => r.line)).toEqual(['POST /meetings/m1/upload', 'POST /meetings/m1/upload/confirm'])
  })

  it('says upload and processing steps in a polite live region, at quarters, not at every byte', async () => {
    renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    const region = () => screen.getByTestId('meetings-upload-announcements').textContent
    expect(region()).toBe(t.announcements.started)
    act(() => lastXhr().progress(10, 100))
    expect(region()).toBe(t.announcements.started)
    act(() => lastXhr().progress(30, 100))
    expect(region()).toBe(t.progress('25%'))
    act(() => lastXhr().progress(60, 100))
    expect(region()).toBe(t.progress('50%'))
  })
})

describe('failures (AC-3.3)', () => {
  it('a network failure part-way: the failure is shown, nothing is confirmed, and Try again uploads it again', async () => {
    const { onChanged } = renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    const user = userEvent.setup()
    await user.click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    act(() => lastXhr().progress(30, 100))
    act(() => lastXhr().fail())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t.failed)
    expect(requests.map((r) => r.line)).toEqual(['POST /meetings/m1/upload'])
    expect(onChanged).not.toHaveBeenCalled()
    // The file is still chosen, so the retry needs nothing from the person.
    expect(screen.getByText('standup.m4a')).not.toBeNull()

    await user.click(within(alert).getByRole('button', { name: t.retry }))
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2))
    act(() => lastXhr().respond(204))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' })))
    expect(screen.queryByText(t.failed)).toBeNull()
  })

  it('Cancel upload aborts the request and offers to try again, without confirming', async () => {
    const { onChanged } = renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    const user = userEvent.setup()
    await user.click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    act(() => lastXhr().progress(50, 100))

    await user.click(screen.getByRole('button', { name: t.cancel }))
    expect(lastXhr().aborted).toBe(true)
    const banner = await screen.findByText(t.cancelled)
    expect(banner).not.toBeNull()
    expect(screen.queryByText(t.failed)).toBeNull()
    expect(screen.getByRole('button', { name: t.retry })).not.toBeNull()
    expect(requests.map((r) => r.line)).toEqual(['POST /meetings/m1/upload'])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('Cancel before the policy has arrived uploads nothing at all', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    install({
      'POST /meetings/m1/upload': async () => {
        await gate
        return { status: 200, body: POLICY }
      },
    })
    const { onChanged } = renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    const user = userEvent.setup()
    await user.click(submit())
    await user.click(screen.getByRole('button', { name: t.cancel }))
    release()

    await screen.findByText(t.cancelled)
    expect(FakeXHR.instances).toHaveLength(0)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('an abort the person did not ask for is a failure', async () => {
    renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    act(() => lastXhr().dispatchEvent(new Event('abort')))
    expect((await screen.findByRole('alert')).textContent).toContain(t.failed)
  })

  it('the bucket refusing the file (a 403, the policy ran out) is a failure, and Try again asks for a fresh policy', async () => {
    renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    const user = userEvent.setup()
    await user.click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    act(() => lastXhr().respond(403))
    await user.click(await screen.findByRole('button', { name: t.retry }))
    await waitFor(() => expect(requests.filter((r) => r.line === 'POST /meetings/m1/upload')).toHaveLength(2))
  })

  it('upload_incomplete (the object is not all there) is a failure with Try again, the meeting still a draft', async () => {
    install({ 'POST /meetings/m1/upload/confirm': () => ({ status: 409, body: problem(409, 'upload_incomplete') }) })
    const { onChanged } = renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    act(() => lastXhr().respond(204))
    expect((await screen.findByRole('alert')).textContent).toContain(t.failed)
    expect(screen.getByRole('button', { name: t.retry })).not.toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a refusal to start (the consent is missing) says so, without a bucket request', async () => {
    install({ 'POST /meetings/m1/upload': () => ({ status: 409, body: problem(409, 'consent_required') }) })
    renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())
    expect((await screen.findByRole('alert')).textContent).toContain(en.common.errors.consent_required)
    expect(FakeXHR.instances).toHaveLength(0)
  })
})

describe('the server refuses the file (AC-3.2)', () => {
  it.each([
    ['unsupported_type', t.problems.unsupported_type],
    ['too_large', t.problems.too_large],
    ['too_long', t.problems.too_long],
    ['no_audio', t.problems.no_audio],
  ] as const)(
    'upload_rejected %s names itself on the field, clears the file, and the meeting stays a draft',
    async (reason, message) => {
      install({
        'POST /meetings/m1/upload/confirm': () => ({ status: 422, body: problem(422, 'upload_rejected', { reason }) }),
      })
      const { onChanged } = renderCard()
      await choose(audioFile())
      await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
      await userEvent.setup().click(submit())
      await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
      act(() => lastXhr().respond(204))

      await screen.findByText(message)
      expect(screen.getByText(t.empty)).not.toBeNull() // the file is cleared
      expect(screen.queryByText('standup.m4a')).toBeNull()
      expect(screen.queryByText(t.failed)).toBeNull()
      expect(onChanged).not.toHaveBeenCalled()
      // The message sits on the file field.
      expect(screen.getByText(message).className).toContain('field-error')
    },
  )

  it('a reason this version does not know falls back to a general sentence', async () => {
    install({
      'POST /meetings/m1/upload/confirm': () => ({
        status: 422,
        body: problem(422, 'upload_rejected', { reason: 'drm' }),
      }),
    })
    renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    act(() => lastXhr().respond(204))
    await screen.findByText(t.rejectedUnknown)
  })

  it.each([
    ['unsupported_type', t.problems.unsupported_type],
    ['too_large', t.problems.too_large],
  ] as const)('the policy request answering %s names it on the field too', async (code, message) => {
    install({ 'POST /meetings/m1/upload': () => ({ status: 422, body: problem(422, code) }) })
    renderCard()
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())
    await screen.findByText(message)
    expect(FakeXHR.instances).toHaveLength(0)
  })
})

describe('accessibility', () => {
  it('has no axe violation: empty, with a problem, and while uploading', async () => {
    const { container } = renderCard()
    const check = async () =>
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      )
    expect(await check()).toEqual([])
    await choose(audioFile('notes.pdf', 'application/pdf', MIB))
    await screen.findByText(t.problems.unsupported_type)
    expect(await check()).toEqual([])
    await choose(audioFile())
    await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(submit())
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    act(() => lastXhr().progress(40, 100))
    expect(await check()).toEqual([])
  })
})
