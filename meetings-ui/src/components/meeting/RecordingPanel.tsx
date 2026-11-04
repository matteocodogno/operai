import {
  Badge,
  Banner,
  Button,
  Card,
  Icon,
  ProgressBar,
  RadioGroupField,
  StatePanel,
  VisuallyHidden,
  formatDuration,
  formatNumber,
} from '@operai/ui'
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import * as shellSession from 'shell/session'
import { captureOptions, detectCapabilities, readEnvironment } from '../../capture/capabilities'
import type { CaptureSource } from '../../capture/capabilities'
import { beginRecording, getRecordingSession } from '../../capture/session'
import type { RecordingSession, SessionFailure, SessionSnapshot } from '../../capture/session'
import { errorMessage, statusOf } from '../../lib/errors'
import { getMeeting, updateMeeting } from '../../lib/meetingsApi'
import type { Meeting, MeetingSource } from '../../lib/types'
import { strings } from '../../strings'

export type RecordingPanelProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

const t = strings.capture

const noop = () => undefined
const NO_SUBSCRIBE = () => noop
const NO_SNAPSHOT = (): SessionSnapshot | null => null

/** Audio is at stake: recording, paused, or still being saved (the queue is only emptied by `done`). */
const isBlocking = (snapshot: SessionSnapshot | null): boolean =>
  snapshot !== null && (snapshot.phase === 'recording' || snapshot.phase === 'paused' || snapshot.phase === 'saving')

type NavigationBlocker = (shouldBlock: () => boolean, message: string) => () => void

/**
 * The shell's navigation blocker (AC-2.10). A shell that predates `registerNavigationBlocker` has no such
 * export, and a federated module may throw on a missing one: either way the browser prompt still applies.
 */
function registerBlocker(shouldBlock: () => boolean, message: string): () => void {
  try {
    const register = (shellSession as unknown as { registerNavigationBlocker?: NavigationBlocker })
      .registerNavigationBlocker
    return typeof register === 'function' ? register(shouldBlock, message) : noop
  } catch {
    return noop
  }
}

/** What the live region says about the step from `previous` to `next`, or null (design.md § Accessibility › Recording). */
function announce(previous: SessionSnapshot | null, next: SessionSnapshot | null): string | null {
  if (!previous || !next) return null
  if (next.phase === 'done' && previous.phase !== 'done' && !next.empty) return t.announcements.saved
  if (next.reconnects > previous.reconnects) return t.restored
  if (previous.phase === 'requesting' && next.phase === 'recording') return t.announcements.started
  if (previous.phase === 'recording' && next.phase === 'paused') return t.announcements.paused
  if (previous.phase === 'paused' && next.phase === 'recording') return t.announcements.resumed
  if (next.phase === 'saving' && previous.phase !== 'saving') {
    return next.autoStopped ? t.autoStopped : t.announcements.stopped
  }
  if (next.phase === 'saving' && next.producedChunks > 0) {
    // "Saving audio: 3 of 5" at each 25 percent, not at every chunk.
    const quarter = (snapshot: SessionSnapshot) =>
      Math.floor((snapshot.savedChunks / Math.max(1, snapshot.producedChunks)) * 4)
    if (quarter(next) > quarter(previous) && next.savedChunks < next.producedChunks) {
      return t.save.progress(formatNumber(next.savedChunks), formatNumber(next.producedChunks))
    }
  }
  return null
}

export default function RecordingPanel({ meeting, onChanged }: RecordingPanelProps) {
  const [session, setSession] = useState<RecordingSession | undefined>(() => getRecordingSession(meeting.id))
  const [capabilities] = useState(() => detectCapabilities(readEnvironment()))
  const [startedHere, setStartedHere] = useState(false)
  const snapshot = useSyncExternalStore<SessionSnapshot | null>(
    session ? session.subscribe : NO_SUBSCRIBE,
    session ? session.getSnapshot : NO_SNAPSHOT,
  )

  // The latest callback without re-running effects when the page passes a new function each render.
  const onChangedRef = useRef(onChanged)
  useEffect(() => {
    onChangedRef.current = onChanged
  })

  // What the live region says: derived while rendering from the step between two snapshots.
  const [announcement, setAnnouncement] = useState('')
  const [previous, setPrevious] = useState(snapshot)
  if (snapshot !== previous) {
    setPrevious(snapshot)
    const message = announce(previous, snapshot)
    if (message) setAnnouncement(message)
  }

  // A panel that goes away while recording (a confirmed leave) stops and saves; a re-mount in the same tick keeps going.
  useEffect(() => {
    session?.attach()
    return () => session?.detach()
  }, [session])

  // Leaving the page while audio is at stake: the browser's prompt, and the shell's for in-app navigation.
  const blocking = isBlocking(snapshot)
  useEffect(() => {
    if (!session || !blocking) return
    const stillBlocking = () => isBlocking(session.getSnapshot())
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!stillBlocking()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    const release = registerBlocker(stillBlocking, t.leaveMessage)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      release()
    }
  }, [session, blocking])

  // The status flips to "recording" on the server once the session starts: bring the page's copy up to date.
  const started = snapshot?.started === true
  useEffect(() => {
    if (!started || !startedHere) return
    let current = true
    getMeeting(meeting.id).then((fresh) => {
      if (current) onChangedRef.current(fresh)
    }, noop)
    return () => {
      current = false
    }
  }, [started, startedHere, meeting.id])

  const result = snapshot?.result ?? null
  useEffect(() => {
    if (result) onChangedRef.current(result)
  }, [result])

  const refresh = () => {
    getMeeting(meeting.id).then((fresh) => onChangedRef.current(fresh), noop)
  }

  const onStart = (source: CaptureSource) => {
    setStartedHere(true)
    setSession(beginRecording({ meeting, source }))
  }

  const content = (() => {
    if (session && snapshot) {
      const { phase } = snapshot
      if (phase === 'recording' || phase === 'paused' || phase === 'saving' || (phase === 'done' && !snapshot.empty)) {
        return <LiveCard session={session} snapshot={snapshot} focusPause={startedHere} />
      }
      if (phase === 'failed' && snapshot.started) return <FailedCard failure={snapshot.failure} onRefresh={refresh} />
    }
    // Recorded by another tab or device: this one only watches (S3a).
    if (meeting.status === 'recording' && meeting.role === 'creator') {
      return (
        <Banner
          tone="info"
          onRetry={refresh}
          retryLabel={t.elsewhere.refresh}
          data-testid="meetings-recording-elsewhere"
        >
          {t.elsewhere.body}
        </Banner>
      )
    }
    // AC-2.1: no capture control, and no request to the browser, without the attestation.
    const canStart =
      meeting.status === 'draft' && meeting.source === 'recorded' && meeting.consent !== null && meeting.can.capture
    if (!canStart) return null
    return (
      <OptionsCard
        meeting={meeting}
        capabilities={capabilities}
        snapshot={snapshot}
        onStart={onStart}
        onChanged={(next) => onChangedRef.current(next)}
      />
    )
  })()

  if (content === null) return null
  return (
    <>
      {content}
      <VisuallyHidden live role="status" data-testid="meetings-recording-announcements">
        {announcement}
      </VisuallyHidden>
    </>
  )
}

// ─── Before recording: the options and Start ───────────────────────────────

type Notice = { tone: 'danger' | 'warning' | 'info'; title?: string; body: string; alternatives: boolean }

/** What a refused start says (AC-2.3): what to change, and whether upload and paste are offered. */
function noticeFor(snapshot: SessionSnapshot | null): Notice | null {
  if (!snapshot) return null
  if (snapshot.empty) return { tone: 'info', body: t.empty, alternatives: false }
  if (snapshot.phase !== 'failed' || !snapshot.failure) return null
  const failure: SessionFailure = snapshot.failure
  switch (failure.kind) {
    case 'denied':
      return { tone: 'danger', ...t.denied, alternatives: true }
    case 'no_device':
      return { tone: 'danger', ...t.noDevice, alternatives: true }
    case 'mic_unavailable':
      return { tone: 'danger', ...t.micUnavailable, alternatives: true }
    case 'tab_cancelled':
      return { tone: 'warning', ...t.tabCancelled, alternatives: false }
    case 'recorder':
      return { tone: 'danger', ...t.recorderFailed, alternatives: true }
    case 'api':
      return { tone: 'danger', body: errorMessage(failure.error), alternatives: false }
    default:
      return null
  }
}

type OptionsCardProps = {
  meeting: Meeting
  capabilities: ReturnType<typeof detectCapabilities>
  snapshot: SessionSnapshot | null
  onStart: (source: CaptureSource) => void
  onChanged: (meeting: Meeting) => void
}

function OptionsCard({ meeting, capabilities, snapshot, onStart, onChanged }: OptionsCardProps) {
  const options = captureOptions(capabilities, meeting.format)
  const [chosen, setChosen] = useState<CaptureSource | null>(options.defaultSource)
  const source = chosen ?? options.defaultSource
  const starting = snapshot?.phase === 'requesting'
  const notice = noticeFor(snapshot)
  const supported = capabilities.supported
  const alternatives = meeting.can.changeSource && (options.recommendUpload || notice?.alternatives === true)

  return (
    <Card title={t.options.title} data-testid="meetings-recording-options">
      {notice && (
        <Banner tone={notice.tone} title={notice.title} data-testid="meetings-recording-notice">
          {notice.body}
        </Banner>
      )}

      {!supported && (
        <Banner tone="warning" title={t.unsupported.title} data-testid="meetings-recording-unsupported">
          {capabilities.unsupportedReason === 'insecure' ? t.unsupported.insecure : t.unsupported.body}
        </Banner>
      )}

      {supported && meeting.format === 'online' && (
        <RadioGroupField label={t.options.sourceLabel} testId="meetings-recording-source">
          {options.sources.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`meetings-recording-source-${meeting.id}`}
                checked={source === value}
                disabled={starting}
                onChange={() => setChosen(value)}
              />
              {value === 'microphone' ? t.options.micOnly : t.options.micAndTab}
            </label>
          ))}
        </RadioGroupField>
      )}

      {supported && options.recommendUpload && (
        <Banner tone="warning" data-testid="meetings-recording-tab-unsupported">
          {t.options.unsupportedTab} {options.warnRemoteVoices && t.options.micOnlyWarning}
        </Banner>
      )}

      {supported && source === 'microphone+tab' && <p className="text-xs text-soft">{t.options.tabHint}</p>}

      {supported && source && (
        <div className="mt-3">
          <Button
            variant="primary"
            busy={starting}
            onClick={() => onStart(source)}
            data-testid="meetings-recording-start"
          >
            <Icon name="mic" /> {starting ? t.starting : t.start}
          </Button>
        </div>
      )}

      {(alternatives || (!supported && meeting.can.changeSource)) && (
        <Alternatives meeting={meeting} onChanged={onChanged} />
      )}
    </Card>
  )
}

/** Upload a recording or paste text instead (F7b): switches the source while the meeting is still a draft. */
function Alternatives({ meeting, onChanged }: { meeting: Meeting; onChanged: (meeting: Meeting) => void }) {
  const [busy, setBusy] = useState<MeetingSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  const switchTo = async (source: MeetingSource) => {
    setBusy(source)
    setError(null)
    try {
      onChanged(await updateMeeting(meeting.id, { source }))
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(null)
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2" data-testid="meetings-recording-alternatives">
      <div className="flex flex-wrap gap-2">
        <Button busy={busy === 'uploaded'} disabled={busy !== null} onClick={() => void switchTo('uploaded')}>
          <Icon name="upload" /> {t.alternatives.upload}
        </Button>
        <Button busy={busy === 'text'} disabled={busy !== null} onClick={() => void switchTo('text')}>
          <Icon name="edit" /> {t.alternatives.text}
        </Button>
      </div>
      <p className="text-xs text-soft">{t.alternatives.textNote}</p>
      {error && <Banner tone="danger">{error}</Banner>}
    </div>
  )
}

// ─── While recording and saving ─────────────────────────────────────────────

type LiveCardProps = { session: RecordingSession; snapshot: SessionSnapshot; focusPause: boolean }

function LiveCard({ session, snapshot, focusPause }: LiveCardProps) {
  const { phase } = snapshot
  const live = phase === 'recording' || phase === 'paused'
  const paused = phase === 'paused'
  const pauseRef = useRef<HTMLButtonElement>(null)
  const savingRef = useRef<HTMLDivElement>(null)

  // The timer re-renders once a second while time is passing; it is not a live region, so it is not read out.
  const [, tick] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [phase])

  // Start moves focus to Pause (the Start button is gone); Stop moves it to the saving status.
  useEffect(() => {
    if (focusPause) pauseRef.current?.focus()
  }, [focusPause])
  useEffect(() => {
    if (phase === 'saving') savingRef.current?.focus()
  }, [phase])

  const saveLine = snapshot.offline
    ? t.save.notSavedLine(formatNumber(Math.round(snapshot.queuedMs / 1_000)))
    : snapshot.queuedChunks > 0
      ? t.save.saving
      : t.save.allSaved

  const banners: ReactNode[] = []
  if (snapshot.tabAudioLost) {
    banners.push(
      <Banner key="tab" tone="warning" data-testid="meetings-recording-tab-ended">
        {t.tabEnded}
      </Banner>,
    )
  }
  if (snapshot.offline && live) {
    banners.push(
      <Banner key="offline" tone="warning" data-testid="meetings-recording-offline">
        {t.save.notSaved}
      </Banner>,
    )
  }
  if (snapshot.limitWarning && live) {
    banners.push(
      <Banner key="limit" tone="warning" data-testid="meetings-recording-limit">
        {t.limitWarning}
      </Banner>,
    )
  }
  if (snapshot.microphoneLost && paused) {
    banners.push(
      <Banner key="mic" tone="danger" title={t.micLost.title} data-testid="meetings-recording-mic-lost">
        {snapshot.resumeFailure
          ? snapshot.resumeFailure === 'denied'
            ? t.resumeFailed.denied
            : snapshot.resumeFailure === 'no_device'
              ? t.resumeFailed.no_device
              : t.resumeFailed.other
          : t.micLost.body}
      </Banner>,
    )
  }
  if (snapshot.stalled) {
    banners.push(
      <Banner key="stalled" tone="danger" data-testid="meetings-recording-stalled">
        {t.save.stalled}
      </Banner>,
    )
  }

  const total = Math.max(snapshot.producedChunks, snapshot.savedChunks)
  const progressText = t.save.progress(formatNumber(snapshot.savedChunks), formatNumber(total))

  return (
    <Card title={t.heading} data-testid="meetings-recording-panel">
      <div className="flex flex-wrap items-center gap-3">
        {live && (
          <Badge
            tone={paused ? 'neutral' : 'accent'}
            glyph={<Icon name={paused ? 'pause' : 'mic'} />}
            data-testid="meetings-recording-indicator"
          >
            {paused ? t.indicator.paused : t.indicator.recording}
          </Badge>
        )}
        <span
          role="timer"
          aria-label={t.elapsed}
          className="font-mono text-sm"
          data-testid="meetings-recording-elapsed"
        >
          {formatDuration(session.elapsedMs(), { style: 'clock' })}
        </span>
        {live && (
          <span className="text-xs text-soft" data-testid="meetings-recording-save-status">
            {saveLine}
          </span>
        )}
      </div>

      {banners.length > 0 && <div className="mt-3 flex flex-col gap-2">{banners}</div>}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          ref={pauseRef}
          variant={paused ? 'primary' : 'secondary'}
          disabled={!live}
          onClick={() => (paused ? void session.resume() : session.pause())}
          data-testid="meetings-recording-pause"
        >
          <Icon name={paused ? 'play' : 'pause'} /> {paused ? t.resume : t.pause}
        </Button>
        <Button
          variant={paused ? 'secondary' : 'primary'}
          disabled={!live}
          onClick={() => void session.stop()}
          data-testid="meetings-recording-stop"
        >
          <Icon name="stop" /> {t.stop}
        </Button>
      </div>

      {!live && (
        <div ref={savingRef} tabIndex={-1} className="mt-4" data-testid="meetings-recording-saving">
          <ProgressBar
            label={t.save.progressLabel}
            value={phase === 'done' ? total : snapshot.savedChunks}
            max={Math.max(1, total)}
            valueText={progressText}
          />
          {snapshot.offline && <p className="mt-2 text-xs text-soft">{t.save.notSaved}</p>}
        </div>
      )}
    </Card>
  )
}

// ─── The recording ended abnormally ─────────────────────────────────────────

function FailedCard({ failure, onRefresh }: { failure: SessionFailure | null; onRefresh: () => void }) {
  if (statusOf(failure?.error) === 404) {
    return (
      <StatePanel role="alert" title={t.gone.title} testId="meetings-recording-gone">
        {t.gone.body}
      </StatePanel>
    )
  }
  return (
    <Banner
      tone="danger"
      title={t.failed.title}
      onRetry={onRefresh}
      retryLabel={t.failed.refresh}
      data-testid="meetings-recording-failed"
    >
      {failure?.error ? `${errorMessage(failure.error)} ` : ''}
      {t.failed.body}
    </Banner>
  )
}
