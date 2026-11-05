/**
 * @vitest-environment jsdom
 *
 * The meeting page frame (specs/021-meetings T57; design.md S3, S3a, S3b, F9, F15, F16): the
 * header, the banners, the details card, the ONE status panel per derived status, the content
 * tabs and the card slots. The cards and panels other tasks own are replaced by stubs here: each
 * has its own tests; this file pins how the frame decides what to show.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDate } from '@operai/ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter, createMyMeetingsRouter } from '../router'
import { en, it as italian } from '../strings'
import {
  ADA,
  CAN_CREATOR_DRAFT,
  CAN_CREATOR_READY,
  CAN_NONE,
  GONE,
  crmDealHost,
  fakeApi,
  hostView,
  meeting,
  participantMeeting,
  problem,
  readyMeeting,
  turn,
} from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Meeting } from '../lib/types'

const session = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  navigateSuite: vi.fn(),
}))

// Whether THIS tab holds a live recording session (capture/session's registry); off unless a test turns it on.
const capture = vi.hoisted(() => ({ active: false }))
vi.mock('../capture/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../capture/session')>()),
  hasActiveRecordingSession: () => capture.active,
}))

vi.mock('shell/session', () => ({
  apiFetch: session.apiFetch,
  getMeetingsApiBaseUrl: () => 'http://meetings-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  navigateSuite: session.navigateSuite,
  registerNavigationBlocker: () => () => undefined,
  usePermissions: () => ({ epoch: 0, apps: ['meetings'], roles: [], departments: [], permissions: [] }),
}))

// The cards, panels, tabs and dialogs other tasks own: stubs that expose the props the frame passes.
vi.mock('../components/meeting/ConsentCard', () => ({ default: () => <div data-testid="stub-consent" /> }))
vi.mock('../components/meeting/RecordingPanel', () => ({ default: () => <div data-testid="stub-recording" /> }))
vi.mock('../components/meeting/UploadCard', () => ({ default: () => <div data-testid="stub-upload" /> }))
vi.mock('../components/meeting/TextCard', () => ({ default: () => <div data-testid="stub-text" /> }))
vi.mock('../components/meeting/InterruptedPanel', () => ({ default: () => <div data-testid="stub-interrupted" /> }))
vi.mock('../components/meeting/ParticipantsCard', () => ({ default: () => <div data-testid="stub-participants" /> }))
vi.mock('../components/meeting/HostNoticeBanner', () => ({
  default: (props: { meeting: Meeting; onChanged: (meeting: Meeting) => void }) => (
    <div data-testid="stub-host-notice">
      <button type="button" onClick={() => props.onChanged({ ...props.meeting, hostNotice: null })}>
        stub-notice-delivered
      </button>
      <button type="button" onClick={() => props.onChanged({ ...props.meeting })}>
        stub-notice-still-failed
      </button>
    </div>
  ),
}))
vi.mock('../components/summaries/SummariesPanel', () => ({ default: () => <div data-testid="stub-summaries" /> }))
vi.mock('../components/meeting/EditDetailsDialog', () => ({
  default: (props: { onClose: () => void; onChanged: (meeting: Meeting) => void; meeting: Meeting }) => (
    <div role="dialog" aria-label="stub-edit-details">
      <button
        type="button"
        onClick={() => {
          props.onChanged({ ...props.meeting, title: 'Renamed in dialog' })
          props.onClose()
        }}
      >
        stub-save
      </button>
      <button type="button" onClick={() => props.onChanged({ ...props.meeting, can: CAN_NONE })}>
        stub-reload
      </button>
      <button type="button" onClick={props.onClose}>
        stub-close
      </button>
    </div>
  ),
}))
vi.mock('../components/meeting/DeleteMeetingDialog', () => ({
  default: (props: { onClose: () => void; onDeleted: () => void }) => (
    <div role="alertdialog" aria-label="stub-delete-meeting">
      <button type="button" onClick={props.onDeleted}>
        stub-deleted
      </button>
      <button type="button" onClick={props.onClose}>
        stub-cancel-delete
      </button>
    </div>
  ),
}))
vi.mock('../components/meeting/DeleteRecordingDialog', () => ({
  default: () => <div role="alertdialog" aria-label="stub-delete-recording" />,
}))
vi.mock('../components/transcript/TranscriptView', () => ({
  default: (props: { focusSegmentId: string | null; onBackToAnswer: (() => void) | null }) => (
    <div data-testid="stub-transcript" data-focus={props.focusSegmentId ?? ''}>
      {props.onBackToAnswer && (
        <button type="button" onClick={props.onBackToAnswer}>
          stub-back-to-answer
        </button>
      )}
    </div>
  ),
}))
vi.mock('../components/ask/AskPanel', () => ({
  default: (props: { onOpenSource: (segmentId: string) => void }) => (
    <div data-testid="stub-ask">
      <button type="button" onClick={() => props.onOpenSource('seg2')}>
        stub-source
      </button>
    </div>
  ),
}))

beforeEach(() => {
  window.scrollTo = () => undefined
  session.navigateSuite.mockReset()
  capture.active = false
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Routes = Record<string, FakeHandler>

/** Serves `current` for GET /meetings/m1 (and `GET /hosts`, no turns) plus any extra routes. */
const serve = (initial: Meeting | (() => Meeting), extra: Routes = {}) => {
  const read = typeof initial === 'function' ? initial : () => initial
  const api = fakeApi({
    'GET /meetings/:id': () => ({ status: 200, body: read() }),
    'GET /hosts': () => ({ status: 200, body: { items: [crmDealHost] } }),
    'GET /meetings/:id/conversation': () => ({ status: 200, body: { turns: [] } }),
    ...extra,
  })
  session.apiFetch.mockImplementation(api)
  return api
}

const renderPage = async (url = '/meetings/m/m1', mine = false) => {
  const history = createMemoryHistory({ initialEntries: [url] })
  const router = mine
    ? createMyMeetingsRouter('/my-meetings', undefined, history)
    : createAppRouter('/meetings', undefined, history)
  render(<RouterProvider router={router} />)
  await router.load()
  return router
}

const loaded = async (url?: string, mine?: boolean) => {
  const router = await renderPage(url, mine)
  await screen.findByTestId('meetings-meeting-page')
  await vi.waitFor(() => expect(screen.queryByTestId('meetings-loading')).toBeNull())
  return router
}

describe('MeetingPage: header and states (S3, building-pages § 2)', () => {
  it('shows the title as the h2, the derived status badge, the format and date, and a back link to the list', async () => {
    serve(readyMeeting({ title: 'Kick-off with Acme', format: 'online' }))
    await loaded()

    const heading = screen.getByRole('heading', { level: 2, name: 'Kick-off with Acme' })
    await vi.waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByText(en.common.status.meeting.ready)).not.toBeNull()
    expect(screen.getByText(/Online · /)).not.toBeNull()
    const back = screen.getByRole('link', { name: en.meeting.back })
    expect(back.getAttribute('href')).toMatch(/^\/meetings\/?$/)
  })

  it('the My meetings entry links back to My meetings', async () => {
    serve(readyMeeting())
    await loaded('/my-meetings/m/m1', true)
    const back = screen.getByRole('link', { name: en.meeting.backMine })
    expect(back.getAttribute('href')).toMatch(/^\/my-meetings\/?$/)
  })

  it('shows a loading state, then the meeting', async () => {
    serve(readyMeeting())
    await renderPage()
    expect(screen.getByRole('link', { name: en.meeting.back })).not.toBeNull()
    expect(await screen.findByRole('heading', { level: 2, name: 'Kick-off with Acme' })).not.toBeNull()
  })

  it('404 is the not-found panel with the meeting words and the back link (AC-5.3)', async () => {
    serve(readyMeeting(), { 'GET /meetings/:id': () => ({ status: 404, body: problem(404, 'not_found') }) })
    await renderPage()
    expect(await screen.findByRole('heading', { name: en.meeting.notFound.title })).not.toBeNull()
    expect(screen.getByRole('link', { name: en.meeting.back })).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.common.retry })).toBeNull()
  })

  it('403 is the permission-denied panel', async () => {
    serve(readyMeeting(), { 'GET /meetings/:id': () => ({ status: 403, body: problem(403) }) })
    await renderPage()
    expect(await screen.findByRole('heading', { name: en.common.permissionDenied.heading })).not.toBeNull()
  })

  it('a failed load is a warning banner whose Retry loads again', async () => {
    let calls = 0
    serve(readyMeeting(), {
      'GET /meetings/:id': () => {
        calls += 1
        return calls === 1 ? { status: 500, body: problem(500) } : { status: 200, body: readyMeeting() }
      },
    })
    await renderPage()
    await userEvent.click(await screen.findByRole('button', { name: en.common.retry }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Kick-off with Acme' })).not.toBeNull()
  })
})

describe('MeetingPage: arrival and refusals', () => {
  it('confirms "Meeting created" when the new-meeting page sent the person here', async () => {
    serve(readyMeeting())
    const history = createMemoryHistory({ initialEntries: ['/meetings/m/m1'] })
    history.replace('/meetings/m/m1', { meetingCreated: true })
    const router = createAppRouter('/meetings', undefined, history)
    render(<RouterProvider router={router} />)
    await router.load()
    expect(await screen.findByText(en.meeting.saved.created)).not.toBeNull()
  })

  it('shows no confirmation on an ordinary visit', async () => {
    serve(readyMeeting())
    await loaded()
    expect(screen.queryByText(en.meeting.saved.created)).toBeNull()
  })

  it('a 403 that carries a refusal code is still the permission-denied panel, with no futile Retry', async () => {
    serve(readyMeeting(), {
      'GET /meetings/:id': () => ({ status: 403, body: problem(403, 'meetings_access_required') }),
    })
    await renderPage()
    expect(await screen.findByRole('heading', { name: en.common.permissionDenied.heading })).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.common.retry })).toBeNull()
  })
})

describe('MeetingPage: what each role sees (AC-10.4, AC-5.11)', () => {
  it('a read-only participant sees no create, summarise, ask or edit control', async () => {
    serve(participantMeeting())
    await loaded('/my-meetings/m/m1', true)

    expect(screen.queryByRole('button', { name: en.meeting.actions.editDetails })).toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.actions.deleteMeeting })).toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.recordingCard.deleteRecording })).toBeNull()
    expect(screen.queryByRole('tab', { name: en.meeting.tabs.ask })).toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.panels.failed.retry })).toBeNull()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.summaries })).not.toBeNull()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.transcript })).not.toBeNull()
  })

  it('a creator gets Edit details and Delete meeting in the header, and Delete recording in its card', async () => {
    serve(readyMeeting())
    await loaded()
    const edit = screen.getByRole('button', { name: en.meeting.actions.editDetails })
    expect(edit.getAttribute('aria-haspopup')).toBe('dialog')
    expect(screen.getByRole('button', { name: en.meeting.actions.deleteMeeting })).not.toBeNull()
    expect(screen.getByRole('button', { name: en.meeting.recordingCard.deleteRecording })).not.toBeNull()
    expect(screen.getByText(en.meeting.details.audio.keptUntil(formatDate('2026-12-03T09:30:00.000Z')))).not.toBeNull()
  })

  it('a creator who lost meetings:access (can.edit false, can.deleteMeeting true) sees only Delete meeting (A4)', async () => {
    serve(readyMeeting({ can: { ...CAN_NONE, deleteMeeting: true, deleteAudio: true } }))
    await loaded()
    expect(screen.queryByRole('button', { name: en.meeting.actions.editDetails })).toBeNull()
    expect(screen.getByRole('button', { name: en.meeting.actions.deleteMeeting })).not.toBeNull()
  })

  it('the Ask tab shows when can.ask, or when the caller already has turns (AC-9.5), and is absent otherwise', async () => {
    serve(readyMeeting())
    await loaded()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.ask })).not.toBeNull()
    cleanup()

    serve(participantMeeting(), {
      'GET /meetings/:id/conversation': () => ({ status: 200, body: { turns: [turn()] } }),
    })
    await loaded('/my-meetings/m/m1', true)
    expect(await screen.findByRole('tab', { name: en.meeting.tabs.ask })).not.toBeNull()
  })

  it('does not ask for the conversation when can.ask is true, and a failing lookup just leaves the tab out', async () => {
    const api = serve(readyMeeting())
    await loaded()
    expect(api.mock.calls.some(([url]) => String(url).endsWith('/conversation'))).toBe(false)
    cleanup()

    serve(participantMeeting(), {
      'GET /meetings/:id/conversation': () => ({ status: 500, body: problem(500) }),
    })
    await loaded('/my-meetings/m/m1', true)
    expect(screen.queryByRole('tab', { name: en.meeting.tabs.ask })).toBeNull()
  })
})

describe('MeetingPage: one status panel at a time (S3a)', () => {
  it('a draft recorded meeting with no consent offers the consent card only', async () => {
    serve(meeting({ status: 'draft', source: 'recorded', consent: null }))
    await loaded()
    expect(screen.getByTestId('stub-consent')).not.toBeNull()
    for (const id of ['stub-recording', 'stub-upload', 'stub-text', 'stub-interrupted'])
      expect(screen.queryByTestId(id)).toBeNull()
  })

  it('once attested, a recorded draft shows the recording panel after the consent line', async () => {
    serve(meeting({ status: 'draft', source: 'recorded', consent: readyMeeting().consent }))
    await loaded()
    expect(screen.getByTestId('stub-consent')).not.toBeNull()
    expect(screen.getByTestId('stub-recording')).not.toBeNull()
    expect(screen.queryByTestId('stub-upload')).toBeNull()
  })

  it('an uploaded draft shows the upload card once attested, and nothing to capture before', async () => {
    serve(meeting({ status: 'draft', source: 'uploaded', consent: readyMeeting().consent }))
    await loaded()
    expect(screen.getByTestId('stub-upload')).not.toBeNull()
    expect(screen.queryByTestId('stub-recording')).toBeNull()
    cleanup()

    serve(meeting({ status: 'draft', source: 'uploaded', consent: null }))
    await loaded()
    expect(screen.getByTestId('stub-consent')).not.toBeNull()
    expect(screen.queryByTestId('stub-upload')).toBeNull()
  })

  it('a text draft shows the text card and never the consent card (AC-3.4)', async () => {
    serve(meeting({ status: 'draft', source: 'text', consent: null }))
    await loaded()
    expect(screen.getByTestId('stub-text')).not.toBeNull()
    expect(screen.queryByTestId('stub-consent')).toBeNull()
  })

  it('a draft nobody can capture into reads "Nothing captured yet" and offers no capture control (AC-2.1)', async () => {
    serve(meeting({ status: 'draft', role: 'participant', can: CAN_NONE, consent: null }))
    await loaded('/my-meetings/m/m1', true)
    expect(screen.getByRole('heading', { name: en.meeting.panels.draftEmpty.title })).not.toBeNull()
    for (const id of ['stub-consent', 'stub-recording', 'stub-upload', 'stub-text'])
      expect(screen.queryByTestId(id)).toBeNull()
  })

  it('a recording is the recording panel for its creator and "Recording in progress" for everyone else', async () => {
    serve(
      meeting({
        status: 'recording',
        can: CAN_CREATOR_DRAFT,
        recording: { live: true, durationMs: 5000, lostMs: null },
      }),
    )
    await loaded()
    expect(screen.getByTestId('stub-recording')).not.toBeNull()
    cleanup()

    serve(meeting({ status: 'recording', role: 'participant', can: CAN_NONE }))
    await loaded('/my-meetings/m/m1', true)
    expect(screen.getByRole('heading', { name: en.meeting.panels.recordingInProgress.title })).not.toBeNull()
    expect(screen.queryByTestId('stub-recording')).toBeNull()
  })

  it('interrupted shows the interrupted panel to the creator and to everyone else', async () => {
    serve(meeting({ status: 'interrupted' }))
    await loaded()
    expect(screen.getByTestId('stub-interrupted')).not.toBeNull()
    cleanup()
    serve(meeting({ status: 'interrupted', role: 'participant', can: CAN_NONE }))
    await loaded('/my-meetings/m/m1', true)
    expect(screen.getByTestId('stub-interrupted')).not.toBeNull()
  })

  it.each(['interrupted', 'failed', 'processing'] as const)(
    'keeps the recording panel mounted while this tab records, even when the server derives %s (T57)',
    async (status) => {
      capture.active = true
      serve(meeting({ status, can: CAN_CREATOR_DRAFT }))
      await loaded()
      expect(screen.getByTestId('stub-recording')).not.toBeNull()
      expect(screen.queryByTestId('stub-interrupted')).toBeNull()
      expect(screen.queryByTestId('meetings-processing-panel')).toBeNull()
      expect(screen.queryByTestId('meetings-failed-panel')).toBeNull()
    },
  )

  it('shows the interrupted panel again once this tab no longer holds the session (T57)', async () => {
    capture.active = false
    serve(meeting({ status: 'interrupted', can: CAN_CREATOR_DRAFT }))
    await loaded()
    expect(screen.getByTestId('stub-interrupted')).not.toBeNull()
    expect(screen.queryByTestId('stub-recording')).toBeNull()
  })

  it.each([
    ['preparing', en.meeting.panels.processing.stages.preparing],
    ['transcribing', en.meeting.panels.processing.stages.transcribing],
    [null, en.meeting.panels.processing.stages.queued],
  ] as const)(
    'processing (stage %s) shows the stage, a spinner and the leave-the-page note, with no content tabs',
    async (stage, label) => {
      serve(meeting({ status: 'processing', stage, can: CAN_NONE }))
      await loaded()
      const panel = screen.getByTestId('meetings-processing-panel')
      expect(within(panel).getByText(label)).not.toBeNull()
      expect(within(panel).getByText(en.meeting.panels.processing.leaveNote)).not.toBeNull()
      expect(screen.queryByRole('tablist')).toBeNull()
    },
  )

  it('failed shows the plain-language reason, and Try again only while can.retryProcessing (AC-6.9)', async () => {
    serve(
      meeting({
        status: 'failed',
        failure: { code: 'provider_unavailable' },
        audio: { state: 'kept', until: '2026-12-03T09:30:00.000Z' },
        can: { ...CAN_NONE, retryProcessing: true },
      }),
    )
    await loaded()
    expect(screen.getByText(en.meeting.panels.failed.reasons.provider_unavailable)).not.toBeNull()
    expect(screen.getByRole('button', { name: en.meeting.panels.failed.retry })).not.toBeNull()
    cleanup()

    serve(meeting({ status: 'failed', failure: { code: 'provider_unavailable' }, can: CAN_NONE }))
    await loaded()
    expect(screen.getByText(en.meeting.panels.failed.reasons.provider_unavailable)).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.panels.failed.retry })).toBeNull()
  })

  it('speech_not_transcribed says speech was detected but not transcribed, never "No speech detected" (AC-6.7)', async () => {
    serve(
      meeting({
        status: 'failed',
        failure: { code: 'speech_not_transcribed' },
        audio: { state: 'kept', until: '2026-12-03T09:30:00.000Z' },
        can: { ...CAN_NONE, retryProcessing: true },
      }),
    )
    await loaded()
    expect(en.meeting.panels.failed.reasons.speech_not_transcribed).toBe(
      'Speech was detected in the recording but could not be transcribed.',
    )
    expect(screen.getByText(en.meeting.panels.failed.reasons.speech_not_transcribed)).not.toBeNull()
    expect(screen.queryByText(en.meeting.panels.failed.unknownReason)).toBeNull()
    expect(screen.queryByText(en.transcript.noSpeech.heading)).toBeNull()
    expect(italian.meeting.panels.failed.reasons.speech_not_transcribed).not.toBe(
      en.meeting.panels.failed.reasons.speech_not_transcribed,
    )
  })

  it('failed with an unknown code falls back to a generic reason, and with the audio deleted says why there is no retry', async () => {
    serve(meeting({ status: 'failed', failure: { code: 'something_new' }, audio: { state: 'deleted' }, can: CAN_NONE }))
    await loaded()
    expect(screen.getByText(en.meeting.panels.failed.unknownReason)).not.toBeNull()
    expect(screen.getByText(en.meeting.panels.failed.audioDeleted)).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.panels.failed.retry })).toBeNull()
  })

  it('Try again posts the retry and shows the processing panel; a refusal shows inline and keeps the panel', async () => {
    let refuse = true
    let current: Meeting = meeting({
      status: 'failed',
      failure: { code: 'audio_unreadable' },
      can: { ...CAN_NONE, retryProcessing: true },
    })
    serve(() => current, {
      'POST /meetings/:id/retry': () => {
        if (refuse) return { status: 409, body: problem(409, 'not_failed') }
        current = meeting({ status: 'processing', stage: 'preparing' })
        return { status: 202, body: current }
      },
    })
    await loaded()
    await userEvent.click(screen.getByRole('button', { name: en.meeting.panels.failed.retry }))
    expect(await screen.findByText(en.common.errors.not_failed)).not.toBeNull()
    expect(screen.queryByTestId('meetings-processing-panel')).toBeNull()

    refuse = false
    await userEvent.click(screen.getByRole('button', { name: en.meeting.panels.failed.retry }))
    expect(await screen.findByTestId('meetings-processing-panel')).not.toBeNull()
  })

  it('ready shows the tabs and no panel; a ready meeting with no speech still shows them (AC-6.7)', async () => {
    serve(readyMeeting({ noSpeech: true }))
    await loaded()
    expect(screen.getByRole('tablist', { name: en.meeting.tabs.label })).not.toBeNull()
    expect(screen.queryByTestId('meetings-processing-panel')).toBeNull()
  })
})

describe('MeetingPage: banners (S3, F16, AC-10.6)', () => {
  it('a frozen meeting says so to everyone, in the exact words of AC-5.11', async () => {
    serve(readyMeeting({ frozen: true, role: 'participant', can: CAN_NONE }))
    await loaded('/my-meetings/m/m1', true)
    expect(screen.getByText(en.meeting.banners.frozen)).not.toBeNull()
  })

  it('no banner when the meeting is not frozen', async () => {
    serve(readyMeeting())
    await loaded()
    expect(screen.queryByText(en.meeting.banners.frozen)).toBeNull()
    expect(screen.queryByText(en.meeting.banners.creatorUnknown)).toBeNull()
  })

  it('an unknown creator state (frozen: null) warns that editing is unavailable, and Retry reloads quietly', async () => {
    let frozen: boolean | null = null
    serve(() => readyMeeting({ frozen, can: frozen === null ? CAN_NONE : CAN_CREATOR_READY }))
    await loaded()
    expect(screen.getByText(en.meeting.banners.creatorUnknown)).not.toBeNull()

    frozen = false
    await userEvent.click(screen.getByRole('button', { name: en.common.retry }))
    await vi.waitFor(() => expect(screen.queryByText(en.meeting.banners.creatorUnknown)).toBeNull())
    // The page was not replaced by a loading state: the heading was never unmounted.
    expect(screen.getByRole('heading', { level: 2, name: 'Kick-off with Acme' })).not.toBeNull()
    expect(screen.getByRole('button', { name: en.meeting.actions.editDetails })).not.toBeNull()
  })

  it('capabilities unavailable shows the authorization banner while reading still works', async () => {
    serve(readyMeeting({ capabilities: 'unavailable', can: CAN_NONE }))
    await loaded()
    expect(screen.getByText(en.common.authUnavailable.heading)).not.toBeNull()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.transcript })).not.toBeNull()
  })

  it('the host-notice banner is mounted only for a failed notice', async () => {
    serve(readyMeeting({ hostNotice: { state: 'failed', event: 'linked' } }))
    await loaded()
    expect(screen.getByTestId('stub-host-notice')).not.toBeNull()
    cleanup()
    serve(readyMeeting({ hostNotice: null }))
    await loaded()
    expect(screen.queryByTestId('stub-host-notice')).toBeNull()
  })
})

describe('MeetingPage: host-notice retry feedback (F11)', () => {
  it('a delivered notice removes the banner and confirms with Saved; a notice that failed again confirms nothing', async () => {
    serve(readyMeeting({ hostNotice: { state: 'failed', event: 'linked' } }))
    await loaded()
    await userEvent.click(screen.getByRole('button', { name: 'stub-notice-still-failed' }))
    expect(screen.queryByText(en.meeting.hostNotice.saved)).toBeNull()
    expect(screen.getByTestId('stub-host-notice')).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'stub-notice-delivered' }))
    expect(screen.queryByTestId('stub-host-notice')).toBeNull()
    expect(screen.getByText(en.meeting.hostNotice.saved)).not.toBeNull()
  })
})

describe('MeetingPage: details card (AC-4.3, AC-4.4, AC-5.10)', () => {
  it('shows the attestation facts: who confirmed, when, and which notice version (AC-4.3)', async () => {
    serve(readyMeeting())
    await loaded()
    const line = en.meeting.details.consent.line('Ada Lovelace', formatDate('2026-11-03T09:29:00.000Z'), '2026-11-01')
    expect(screen.getByText(line)).not.toBeNull()
  })

  it('a text meeting carries no consent fact; a recorded one without attestation says so', async () => {
    serve(readyMeeting({ source: 'text', consent: null, audio: { state: 'none' } }))
    await loaded()
    expect(screen.queryByText(en.meeting.details.facts.consent)).toBeNull()
    cleanup()

    serve(meeting({ status: 'draft', source: 'recorded', consent: null }))
    await loaded()
    expect(screen.getByText(en.meeting.details.consent.none)).not.toBeNull()
  })

  it('audio: "kept until" a date, "deleted", or absent', async () => {
    serve(readyMeeting({ audio: { state: 'deleted' } }))
    await loaded()
    expect(screen.getByText(en.meeting.details.audio.deleted)).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.recordingCard.deleteRecording })).toBeNull()
    cleanup()

    serve(readyMeeting({ audio: { state: 'none' } }))
    await loaded()
    expect(screen.queryByText(en.meeting.details.facts.audio)).toBeNull()
  })

  it('shows a deleted creator as "Deleted user" (AC-5.10)', async () => {
    serve(readyMeeting({ creator: GONE, role: 'participant', can: CAN_NONE }))
    await loaded('/my-meetings/m/m1', true)
    expect(screen.getByText(en.meeting.details.deletedUser)).not.toBeNull()
  })

  it('names the creator, format, language, source and duration', async () => {
    serve(readyMeeting({ durationMs: 3_723_000, language: 'it', source: 'uploaded', format: 'in_person' }))
    await loaded()
    const facts = screen.getByTestId('meetings-details-card')
    expect(within(facts).getByText(ADA.name!)).not.toBeNull()
    expect(within(facts).getAllByText(en.meeting.details.access.creator).length).toBeGreaterThan(0)
    expect(within(facts).getByText(en.meeting.format.in_person)).not.toBeNull()
    expect(within(facts).getByText(en.meeting.language.it)).not.toBeNull()
    expect(within(facts).getByText(en.meeting.source.uploaded)).not.toBeNull()
    expect(within(facts).getByText('01:02:03')).not.toBeNull()
  })

  it('an open host is a link "Deal · title" opened through the suite; standalone says Standalone', async () => {
    serve(readyMeeting({ host: hostView() }))
    await loaded()
    const facts = screen.getByTestId('meetings-details-card')
    const link = await within(facts).findByRole('link', { name: 'Deal · Acme renewal' })
    expect(link.getAttribute('href')).toBe('/crm/deals/d1')
    await userEvent.click(link)
    expect(session.navigateSuite).toHaveBeenCalledWith('/crm/deals/d1')
    cleanup()

    serve(readyMeeting({ host: null }))
    await loaded()
    expect(screen.getByText(en.meeting.details.host.standalone)).not.toBeNull()
  })

  it('a host that is gone says so; a closed or unreachable one shows the plain "CRM · deal"', async () => {
    serve(readyMeeting({ host: hostView({ state: 'missing', title: null, href: null }) }))
    await loaded()
    expect(screen.getAllByText(en.meeting.details.host.noLongerAvailable).length).toBeGreaterThan(0)
    cleanup()

    serve(readyMeeting({ host: hostView({ state: 'unavailable', title: null, href: null }) }))
    await loaded()
    expect((await screen.findAllByText('CRM · deal')).length).toBeGreaterThan(0)
  })

  it('a host reader sees why they can open it: "Because you can open Deal · title"', async () => {
    serve(participantMeeting({ role: 'host_reader', host: hostView() }))
    await loaded('/my-meetings/m/m1', true)
    expect(await screen.findByText(en.meeting.details.access.viaHost('Deal · Acme renewal'))).not.toBeNull()
  })
})

describe('MeetingPage: tabs (S3b)', () => {
  it('opens on Summaries when the meeting has any, otherwise on Transcript', async () => {
    serve(readyMeeting({ summaryCount: 2 }))
    await loaded()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.summaries }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('stub-summaries')).not.toBeNull()
    cleanup()

    serve(readyMeeting({ summaryCount: 0 }))
    await loaded()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.transcript }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('stub-transcript')).not.toBeNull()
  })

  it('a text meeting calls its Transcript tab "Passages"', async () => {
    serve(readyMeeting({ source: 'text', consent: null, audio: { state: 'none' } }))
    await loaded()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.passages })).not.toBeNull()
    expect(screen.queryByRole('tab', { name: en.meeting.tabs.transcript })).toBeNull()
  })

  it('?tab= selects the tab, and clicking a tab writes it to the URL so back and shared links work', async () => {
    serve(readyMeeting({ summaryCount: 1 }))
    const router = await loaded('/meetings/m/m1?tab=transcript')
    expect(screen.getByRole('tab', { name: en.meeting.tabs.transcript }).getAttribute('aria-selected')).toBe('true')

    await userEvent.click(screen.getByRole('tab', { name: en.meeting.tabs.summaries }))
    expect(router.state.location.search).toEqual({ tab: 'summaries' })
    expect(screen.getByRole('tab', { name: en.meeting.tabs.summaries }).getAttribute('aria-selected')).toBe('true')
  })

  it('a ?tab= the caller cannot open (ask without can.ask) or nonsense falls back to the default tab', async () => {
    serve(participantMeeting({ summaryCount: 1 }))
    await loaded('/my-meetings/m/m1?tab=ask', true)
    expect(screen.getByRole('tab', { name: en.meeting.tabs.summaries }).getAttribute('aria-selected')).toBe('true')
    cleanup()

    serve(readyMeeting({ summaryCount: 1 }))
    await loaded('/meetings/m/m1?tab=bogus')
    expect(screen.getByRole('tab', { name: en.meeting.tabs.summaries }).getAttribute('aria-selected')).toBe('true')
  })

  it('only the active panel is mounted, and switching tabs reads the meeting again (summaryCount, stale flags)', async () => {
    const api = serve(readyMeeting({ summaryCount: 1 }))
    await loaded()
    const reads = () => api.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/meetings/m1').length
    expect(screen.getByTestId('stub-summaries')).not.toBeNull()
    expect(screen.queryByTestId('stub-transcript')).toBeNull()
    const before = reads()

    await userEvent.click(screen.getByRole('tab', { name: en.meeting.tabs.transcript }))
    expect(screen.getByTestId('stub-transcript')).not.toBeNull()
    expect(screen.queryByTestId('stub-summaries')).toBeNull()
    await vi.waitFor(() => expect(reads()).toBe(before + 1))
  })

  it('a source in the Ask tab opens the Transcript tab on that passage; Back to the answer returns to the Ask tab (focus is left to the Ask panel, F12)', async () => {
    serve(readyMeeting({ summaryCount: 1 }))
    await loaded('/meetings/m/m1?tab=ask')

    await userEvent.click(screen.getByRole('button', { name: 'stub-source' }))
    expect(screen.queryByTestId('stub-ask')).toBeNull()
    expect(screen.getByRole('tab', { name: en.meeting.tabs.transcript }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('stub-transcript').getAttribute('data-focus')).toBe('seg2')

    await userEvent.click(screen.getByRole('button', { name: 'stub-back-to-answer' }))
    expect(screen.getByRole('tab', { name: en.meeting.tabs.ask }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('stub-ask')).not.toBeNull()
  })

  it('without a jump, the transcript gets no focus target and no back link', async () => {
    serve(readyMeeting({ summaryCount: 0 }))
    await loaded()
    expect(screen.getByTestId('stub-transcript').getAttribute('data-focus')).toBe('')
    expect(screen.queryByRole('button', { name: 'stub-back-to-answer' })).toBeNull()
  })
})

describe('MeetingPage: dialogs and cards', () => {
  it('Edit details opens the dialog; a saved change replaces the meeting and confirms with Saved; close unmounts it', async () => {
    serve(readyMeeting())
    await loaded()
    await userEvent.click(screen.getByRole('button', { name: en.meeting.actions.editDetails }))
    expect(screen.getByRole('dialog', { name: 'stub-edit-details' })).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'stub-save' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Renamed in dialog' })).not.toBeNull()
    expect(screen.getByText(en.meeting.saved.details)).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: 'stub-edit-details' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: en.meeting.actions.editDetails }))
    await userEvent.click(screen.getByRole('button', { name: 'stub-close' }))
    expect(screen.queryByRole('dialog', { name: 'stub-edit-details' })).toBeNull()
  })

  it('a reload the dialog asks for (a lock that moved on) updates the page, keeps the dialog open and confirms nothing', async () => {
    serve(readyMeeting())
    await loaded()
    await userEvent.click(screen.getByRole('button', { name: en.meeting.actions.editDetails }))
    await userEvent.click(screen.getByRole('button', { name: 'stub-reload' }))
    expect(screen.getByRole('dialog', { name: 'stub-edit-details' })).not.toBeNull()
    expect(screen.queryByText(en.meeting.saved.details)).toBeNull()
    expect(screen.queryByRole('button', { name: en.meeting.actions.deleteMeeting })).toBeNull()
  })

  it('Delete meeting opens the dialog; once deleted the page leaves for the list', async () => {
    serve(readyMeeting(), {
      'GET /meetings': () => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 25 } }),
    })
    await loaded()
    await userEvent.click(screen.getByRole('button', { name: en.meeting.actions.deleteMeeting }))
    expect(screen.getByRole('alertdialog', { name: 'stub-delete-meeting' })).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'stub-deleted' }))
    expect(await screen.findByTestId('meetings-list-page')).not.toBeNull()
    // design.md F14: the list confirms the deletion.
    expect(await screen.findByText(en.list.deleted)).not.toBeNull()
  })

  it('shows the participants card slot, and fetches the host registration only for a linked meeting', async () => {
    const api = serve(readyMeeting({ host: null }))
    await loaded()
    expect(screen.getByTestId('stub-participants')).not.toBeNull()
    expect(api.mock.calls.some(([url]) => new URL(String(url)).pathname === '/hosts')).toBe(false)
    cleanup()

    const linked = serve(readyMeeting({ host: hostView() }))
    await loaded()
    await vi.waitFor(() =>
      expect(linked.mock.calls.some(([url]) => new URL(String(url)).pathname === '/hosts')).toBe(true),
    )
  })

  it('Delete recording opens its dialog', async () => {
    serve(readyMeeting())
    await loaded()
    await userEvent.click(screen.getByRole('button', { name: en.meeting.recordingCard.deleteRecording }))
    expect(screen.getByRole('alertdialog', { name: 'stub-delete-recording' })).not.toBeNull()
  })
})

describe('MeetingPage: polling a meeting that is still changing (F9)', () => {
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('re-reads a processing meeting until it is ready, then shows the tabs; ready is not polled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let current: Meeting = meeting({ status: 'processing', stage: 'preparing', can: CAN_NONE })
    const api = serve(() => current)
    await loaded()
    expect(screen.getByTestId('meetings-processing-panel')).not.toBeNull()

    current = readyMeeting({ summaryCount: 0, can: CAN_NONE })
    await advance(35_000)
    expect(screen.queryByTestId('meetings-processing-panel')).toBeNull()
    expect(screen.getByRole('tablist')).not.toBeNull()

    const reads = api.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/meetings/m1').length
    await advance(120_000)
    expect(api.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/meetings/m1').length).toBe(reads)
  })

  it('someone who is not capturing watches a recording until it moves on (their panel owns nothing to poll)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let current: Meeting = meeting({ status: 'recording', role: 'participant', can: CAN_NONE })
    serve(() => current)
    await loaded('/my-meetings/m/m1', true)
    expect(screen.getByRole('heading', { name: en.meeting.panels.recordingInProgress.title })).not.toBeNull()

    current = meeting({ status: 'processing', stage: 'transcribing', role: 'participant', can: CAN_NONE })
    await advance(10_000)
    expect(screen.getByTestId('meetings-processing-panel')).not.toBeNull()
  })

  it('the creator holding the recording controls is not polled (the recording panel owns its session)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = serve(meeting({ status: 'recording', can: CAN_CREATOR_DRAFT }))
    await loaded()
    const reads = () => api.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/meetings/m1').length
    const before = reads()
    await advance(120_000)
    expect(reads()).toBe(before)
  })

  it('a ready meeting is never polled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = serve(readyMeeting())
    await loaded()
    const reads = () => api.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/meetings/m1').length
    const before = reads()
    await advance(120_000)
    expect(reads()).toBe(before)
  })
})
