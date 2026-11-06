/**
 * @vitest-environment jsdom
 *
 * The host-notice failure banner (specs/021-meetings T59; design.md F11; AC-11.9, AC-14.8,
 * AC-14.10): creator-only, never blocking, the host's own sentence from its registration (plan
 * G7), Try again while `can.retryHostNotice`.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostInfo, Meeting } from '../../lib/types'
import { en } from '../../strings'
import {
  CAN_CREATOR_READY,
  CAN_NONE,
  crmDealHost,
  fakeApi,
  meeting as meetingFixture,
  problem,
  readyMeeting,
} from '../../test-support/fakeApi'
import HostNoticeBanner from './HostNoticeBanner'

const session = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  apiFetch: session.apiFetch,
  getMeetingsApiBaseUrl: () => 'http://meetings-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

beforeEach(() => {
  document.documentElement.removeAttribute('lang')
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
})

const failed = (overrides: Partial<Meeting> = {}): Meeting =>
  readyMeeting({
    hostNotice: { state: 'failed', event: 'linked' },
    can: { ...CAN_CREATOR_READY, retryHostNotice: true },
    ...overrides,
  })

/** Holds the meeting like the page does: `onChanged` replaces it. */
function Harness({ initial, hostInfo = crmDealHost }: { initial: Meeting; hostInfo?: HostInfo | null }) {
  const [current, setCurrent] = useState(initial)
  return <HostNoticeBanner meeting={current} hostInfo={hostInfo} onChanged={setCurrent} />
}

describe('HostNoticeBanner', () => {
  it("shows the host's own sentence, whole, for a failed `linked` notice (AC-14.8)", () => {
    render(<Harness initial={failed()} />)
    expect(screen.getByText("The deal's activity could not be added")).not.toBeNull()
  })

  it('uses the sentence in the UI language: Italian reads the registry Italian', () => {
    document.documentElement.setAttribute('lang', 'it')
    render(<Harness initial={failed()} />)
    expect(screen.getByText("Non è stato possibile aggiungere l'attività all'opportunità")).not.toBeNull()
    expect(screen.queryByText("The deal's activity could not be added")).toBeNull()
  })

  it('a failed `changed` notice reads the generic meetings sentence, not the host one', () => {
    render(<Harness initial={failed({ hostNotice: { state: 'failed', event: 'changed' } })} />)
    expect(screen.getByText(en.meeting.hostNotice.changedFailed)).not.toBeNull()
    expect(screen.queryByText("The deal's activity could not be added")).toBeNull()
  })

  it('without the host registration (the lookup failed) it still says something, with the generic sentence', () => {
    render(<Harness initial={failed()} hostInfo={null} />)
    expect(screen.getByText(en.meeting.hostNotice.changedFailed)).not.toBeNull()
  })

  it('is a non-blocking warning: announced, not dismissible, no dialog', () => {
    render(<Harness initial={failed()} />)
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain("The deal's activity could not be added")
    expect(screen.queryByRole('button', { name: en.common.dismiss })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Try again posts the retry, shows it busy, and the banner is gone once the notice is delivered', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const api = fakeApi({
      'POST /meetings/:id/host-notice/retry': async () => {
        await gate
        return { status: 200, body: failed({ hostNotice: null }) }
      },
    })
    session.apiFetch.mockImplementation(api)
    render(<Harness initial={failed()} />)

    await userEvent.click(screen.getByRole('button', { name: en.meeting.hostNotice.retry }))
    expect(screen.getByRole('button', { name: en.meeting.hostNotice.retry }).getAttribute('aria-busy')).toBe('true')
    const [url, init] = api.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/meetings/m1/host-notice/retry')
    expect(init?.method).toBe('POST')

    release()
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('a retry that fails again keeps the banner and shows why, then lets the creator try once more', async () => {
    let fail = true
    session.apiFetch.mockImplementation(
      fakeApi({
        'POST /meetings/:id/host-notice/retry': () =>
          fail
            ? { status: 503, body: problem(503, 'host_unavailable') }
            : { status: 200, body: failed({ hostNotice: null }) },
      }),
    )
    render(<Harness initial={failed()} />)

    await userEvent.click(screen.getByRole('button', { name: en.meeting.hostNotice.retry }))
    expect(await screen.findByText(en.common.errors.host_unavailable)).not.toBeNull()
    expect(screen.getByText("The deal's activity could not be added")).not.toBeNull()

    fail = false
    await userEvent.click(screen.getByRole('button', { name: en.meeting.hostNotice.retry }))
    await vi.waitFor(() => expect(screen.queryByText("The deal's activity could not be added")).toBeNull())
  })

  it('a retry the host still refuses (answer keeps the failed notice) keeps the banner', async () => {
    session.apiFetch.mockImplementation(
      fakeApi({ 'POST /meetings/:id/host-notice/retry': () => ({ status: 200, body: failed() }) }),
    )
    render(<Harness initial={failed()} />)
    await userEvent.click(screen.getByRole('button', { name: en.meeting.hostNotice.retry }))
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: en.meeting.hostNotice.retry }).getAttribute('aria-busy')).not.toBe(
        'true',
      ),
    )
    expect(screen.getByText("The deal's activity could not be added")).not.toBeNull()
  })

  it('offers no Try again on a frozen meeting (can.retryHostNotice false, AC-14.10), but still says it failed', () => {
    render(<Harness initial={failed({ frozen: true, can: CAN_NONE })} />)
    expect(screen.getByText("The deal's activity could not be added")).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.hostNotice.retry })).toBeNull()
  })

  it('renders nothing when no notice failed', () => {
    const { container } = render(<Harness initial={failed({ hostNotice: null })} />)
    expect(container.textContent).toBe('')
  })

  it('a refused retry that says the meeting is frozen is shown inline', async () => {
    session.apiFetch.mockImplementation(
      fakeApi({ 'POST /meetings/:id/host-notice/retry': () => ({ status: 403, body: problem(403, 'frozen') }) }),
    )
    render(
      <Harness
        initial={failed({
          ...meetingFixture(),
          hostNotice: { state: 'failed', event: 'linked' },
          can: { ...CAN_NONE, retryHostNotice: true },
        })}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: en.meeting.hostNotice.retry }))
    expect(await screen.findByText(en.common.errors.frozen)).not.toBeNull()
  })
})
